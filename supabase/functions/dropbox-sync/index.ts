// Dropbox → Supabase Storage (`producer_images`) → Airtable "Image URLs".
//
// Runs hourly from Supabase Cron (see supabase/dropbox.sql). For every producer in Airtable it finds the Dropbox
// folder — the record's "Image Dropbox folder" link, or else a subfolder of DROPBOX_ROOT_PATH whose name matches
// the producer — copies new or changed images into `producer_images/<airtable record id>/`, and writes the public
// URLs back to the record. Airtable stays the source of truth; this function only ever writes the Image URLs field.
//
// Safety:
//   • Unchanged files (same Dropbox content hash) are never downloaded or uploaded again.
//   • A folder that can't be read is skipped entirely — nothing is hidden or deleted because of an error.
//   • A folder that suddenly reads as empty is treated as a mistake and its images are kept.
//   • A deleted file is hidden from the site at once but stays in storage for DELETE_AFTER_DAYS (default 7);
//     if it reappears in Dropbox in that time it's restored without re-uploading.
//   • Runs never overlap, and each run stops starting new downloads before the Edge Function time limit;
//     the next run carries on where it left off.
//
// Auth: `Authorization: Bearer <DROPBOX_SYNC_SECRET>`. Body (all optional):
//   { "dry_run": true }        → list folders and report what would change; writes nothing
//   { "record": "recXXXX" }    → sync just one producer

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const env = (k: string, d?: string): string => {
  const v = Deno.env.get(k) ?? d;
  if (v === undefined || v === '') throw new Error(`Missing secret ${k}`);
  return v;
};

// Airtable field IDs (not names) so renaming a column in Airtable doesn't break the sync. Override with secrets if needed.
const CFG = {
  bucket: 'producer_images',
  table: Deno.env.get('AIRTABLE_PRODUCERS_TABLE') ?? 'tblG7x02MvbxqYPwF',
  nameField: Deno.env.get('AIRTABLE_NAME_FIELD') ?? 'fld1OjTacZYCu6UM7',      // Place / 工房名
  folderField: Deno.env.get('AIRTABLE_FOLDER_FIELD') ?? 'fldSuLlPVdhXCnixB',  // Image Dropbox folder
  featureField: Deno.env.get('AIRTABLE_FEATURE_FIELD') ?? 'fldkJODLUgUUmhFnT', // Feature #
  urlsField: Deno.env.get('AIRTABLE_IMAGE_URLS_FIELD') ?? 'fldkPzHHAzwcXGHdu', // Image URLs
  rootPath: (Deno.env.get('DROPBOX_ROOT_PATH') ?? '').replace(/\/+$/, ''),     // e.g. "/Cabi & Friends/Producers"
  deleteAfterDays: Number(Deno.env.get('DELETE_AFTER_DAYS') ?? 7),
  imageMode: Deno.env.get('IMAGE_MODE') ?? 'web',                              // web = 2048px JPEG · original = as uploaded
  budgetMs: Number(Deno.env.get('TIME_BUDGET_MS') ?? 110_000),
};
const IMAGE = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp)$/i;
const WEB = /\.(jpe?g|png|webp|gif|avif)$/i;
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const MAX_ORIGINAL = 45 * 1024 * 1024;

type Ref = { kind: 'link'; url: string } | { kind: 'path'; path: string };
type DbxFile = { id: string; rel: string; name: string; version: string; size: number };
type Row = { id: number; airtable_record_id: string; dropbox_file_id: string; dropbox_path: string; version: string; storage_path: string; missing_since: string | null };
type Producer = { id: string; name: string; feature: string; folderUrl: string; urls: string };
type Issue = { record?: string; producer?: string; folder?: string; problem: string };

// ---------------------------------------------------------------- entry point

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  if (!authorized(req)) return new Response('Unauthorized', { status: 401 });
  const body = await req.json().catch(() => ({}));
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  // Never run two syncs at once (a run older than 15 minutes is assumed dead).
  const { data: running } = await sb.from('dropbox_sync_runs').select('id').is('finished_at', null)
    .gte('started_at', new Date(Date.now() - 15 * 60e3).toISOString()).limit(1);
  if (running?.length) return json({ skipped: 'another sync is running', run: running[0].id }, 409);

  const { data: run, error } = await sb.from('dropbox_sync_runs').insert({ dry_run: !!body.dry_run }).select('id').single();
  if (error) return json({ error: error.message }, 500);

  // Respond straight away (the cron caller only waits a few seconds) and keep working in the background.
  const work = sync(sb, run.id, { dryRun: !!body.dry_run, only: typeof body.record === 'string' ? body.record : null });
  // @ts-ignore EdgeRuntime is provided by Supabase
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work); else await work;
  return json({ started: true, run: run.id, dry_run: !!body.dry_run }, 202);
});

function authorized(req: Request): boolean {
  const want = `Bearer ${env('DROPBOX_SYNC_SECRET')}`;
  const got = req.headers.get('authorization') ?? '';
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

// ---------------------------------------------------------------- the sync

async function sync(sb: SupabaseClient, runId: number, opts: { dryRun: boolean; only: string | null }) {
  const started = Date.now();
  const timeUp = () => Date.now() - started > CFG.budgetMs;
  const stats = { producers: 0, folders: 0, listed: 0, uploaded: 0, unchanged: 0, hidden: 0, restored: 0, deleted: 0, airtable_updates: 0, deferred: 0 };
  const issues: Issue[] = [];
  let status = 'ok';
  try {
    await dropboxLogin();
    let producers = (await airtableProducers()).filter((p) => !opts.only || p.id === opts.only);
    stats.producers = producers.length;
    const refs = await matchFolders(producers, issues);

    // Least recently synced first, so a run that hits the time limit doesn't starve anyone.
    const { data: folderRows } = await sb.from('dropbox_folders').select('airtable_record_id, last_synced_at');
    const last = new Map((folderRows ?? []).map((r) => [r.airtable_record_id, r.last_synced_at ?? '']));
    producers = producers.filter((p) => refs.has(p.id)).sort((a, b) => (last.get(a.id) ?? '').localeCompare(last.get(b.id) ?? ''));
    stats.folders = producers.length;

    const airtableUpdates: { id: string; fields: Record<string, string> }[] = [];
    for (const p of producers) {
      if (timeUp()) { stats.deferred++; status = 'partial'; continue; }
      const ref = refs.get(p.id)!;
      const folder = ref.kind === 'link' ? ref.url : ref.path;
      try {
        const urls = await syncProducer(sb, p, ref, { ...opts, timeUp, stats, issues });
        if (urls === 'kept') { status = 'partial'; continue; }
        if (urls === null) { stats.deferred++; status = 'partial'; continue; }
        const text = urls.join('\n');
        if (text !== p.urls.trim()) airtableUpdates.push({ id: p.id, fields: { [CFG.urlsField]: text } });
        if (!opts.dryRun) await sb.from('dropbox_folders').upsert({ airtable_record_id: p.id, producer_name: p.name, folder, last_synced_at: new Date().toISOString(), last_error: null, image_count: urls.length });
      } catch (e) {
        // Couldn't read this folder: report it and leave everything about this producer exactly as it was.
        const problem = `folder could not be read: ${msg(e)}`;
        issues.push({ record: p.id, producer: p.name, folder, problem });
        if (!opts.dryRun) await sb.from('dropbox_folders').upsert({ airtable_record_id: p.id, producer_name: p.name, folder, last_error: problem });
        status = 'partial';
      }
    }
    stats.airtable_updates = airtableUpdates.length;
    if (!opts.dryRun) await airtableUpdate(airtableUpdates);
  } catch (e) {
    status = 'failed';
    issues.push({ problem: msg(e) });
    console.error(e);
  }
  await sb.from('dropbox_sync_runs').update({ finished_at: new Date().toISOString(), status, stats, issues: issues.slice(0, 500) }).eq('id', runId);
  console.log(JSON.stringify({ run: runId, status, stats, issues: issues.length }));
}

// Syncs one producer's folder. Returns the ordered public URLs, null if it ran out of time part-way,
// or 'kept' if the folder looked suspiciously empty and nothing was changed.
async function syncProducer(sb: SupabaseClient, p: Producer, ref: Ref, o: {
  dryRun: boolean; timeUp: () => boolean; stats: Record<string, number>; issues: Issue[];
}): Promise<string[] | null | 'kept'> {
  const files = await listImages(ref);
  o.stats.listed += files.length;
  const { data: rowsData, error } = await sb.from('dropbox_images').select('*').eq('airtable_record_id', p.id);
  if (error) throw error;
  const rows = (rowsData ?? []) as Row[];
  const byFile = new Map(rows.map((r) => [r.dropbox_file_id, r]));
  const seen = new Set<string>();
  let complete = true;

  for (const f of files) {
    seen.add(f.id);
    const row = byFile.get(f.id);
    if (row && row.version === f.version) {
      o.stats.unchanged++;
      if (row.missing_since) o.stats.restored++;
      if (!o.dryRun && (row.missing_since || row.dropbox_path !== f.rel)) {
        await sb.from('dropbox_images').update({ missing_since: null, dropbox_path: f.rel }).eq('id', row.id);
      }
      row.missing_since = null; row.dropbox_path = f.rel;
      continue;
    }
    if (o.timeUp()) { complete = false; break; }
    o.stats.uploaded++;
    if (o.dryRun) continue;
    let img;
    try { img = await fetchImage(ref, f); } catch (e) {
      o.issues.push({ record: p.id, producer: p.name, folder: f.rel, problem: `skipped image: ${msg(e)}` });
      o.stats.uploaded--;
      continue;
    }
    const path = `${p.id}/${slug(f.name.replace(/\.[^.]+$/, '')) || 'image'}-${await shortHash(f.id + ':' + f.version)}.${img.ext}`;
    const { error: upErr } = await sb.storage.from(CFG.bucket).upload(path, img.bytes, { contentType: img.type, upsert: true, cacheControl: '31536000' });
    if (upErr) throw new Error(`upload ${path}: ${upErr.message}`);
    const saved = { airtable_record_id: p.id, dropbox_file_id: f.id, dropbox_path: f.rel, version: f.version, storage_path: path, bytes: img.bytes.byteLength, synced_at: new Date().toISOString(), missing_since: null };
    const { error: dbErr } = await sb.from('dropbox_images').upsert(saved, { onConflict: 'airtable_record_id,dropbox_file_id' });
    if (dbErr) throw dbErr;
    // A changed photo replaces its old copy (this is an update, not a deletion, so no grace period).
    if (row && row.storage_path !== path) await sb.storage.from(CFG.bucket).remove([row.storage_path]);
    if (row) Object.assign(row, saved); else rows.push({ id: 0, ...saved });
  }

  // Deletions — only when the whole folder was listed and processed.
  if (complete) {
    const gone = rows.filter((r) => r.id && !seen.has(r.dropbox_file_id));
    const live = rows.filter((r) => r.id && !r.missing_since).length;
    if (files.length === 0 && live > 0) {
      o.issues.push({ record: p.id, producer: p.name, problem: `Dropbox folder reads as empty; kept its ${live} images to be safe. Remove them in Supabase if this was intended.` });
      return 'kept'; // leave Airtable as it is
    }
    const cutoff = Date.now() - CFG.deleteAfterDays * 86400e3;
    for (const r of gone) {
      if (!r.missing_since) {
        o.stats.hidden++;
        r.missing_since = new Date().toISOString();
        if (!o.dryRun) await sb.from('dropbox_images').update({ missing_since: r.missing_since }).eq('id', r.id);
      } else if (Date.parse(r.missing_since) < cutoff) {
        o.stats.deleted++;
        if (!o.dryRun) {
          await sb.storage.from(CFG.bucket).remove([r.storage_path]);
          await sb.from('dropbox_images').delete().eq('id', r.id);
        }
      }
    }
  }
  if (!complete) return null;

  const base = `${env('SUPABASE_URL')}/storage/v1/object/public/${CFG.bucket}/`;
  return rows.filter((r) => !r.missing_since && seen.has(r.dropbox_file_id))
    .sort((a, b) => a.dropbox_path.localeCompare(b.dropbox_path, 'en', { numeric: true, sensitivity: 'base' }))
    .map((r) => base + r.storage_path.split('/').map(encodeURIComponent).join('/'));
}

// ---------------------------------------------------------------- matching producers ↔ folders

async function matchFolders(producers: Producer[], issues: Issue[]): Promise<Map<string, Ref>> {
  const refs = new Map<string, Ref>();
  for (const p of producers) {
    const ref = parseFolderUrl(p.folderUrl);
    if (ref) refs.set(p.id, ref);
    else if (p.folderUrl) issues.push({ record: p.id, producer: p.name, folder: p.folderUrl, problem: 'not a Dropbox folder link' });
  }
  if (!CFG.rootPath) return refs;

  // Fallback: one subfolder per producer under DROPBOX_ROOT_PATH, matched by name, Japanese name, Feature # or record ID.
  const keys = new Map<string, string[]>();
  for (const p of producers) {
    if (refs.has(p.id)) continue;
    for (const k of nameKeys(p)) keys.set(k, [...(keys.get(k) ?? []), p.id]);
  }
  const claimed = new Set([...refs.values()].map((r) => (r.kind === 'path' ? r.path.toLowerCase() : '')));
  for (const sub of await listSubfolders(CFG.rootPath)) {
    if (claimed.has(sub.path.toLowerCase())) continue;
    const ids = [...new Set([...(sub.name.match(/rec[A-Za-z0-9]{14}/g) ?? []), ...(keys.get(norm(sub.name)) ?? [])])];
    if (ids.length === 1 && !refs.has(ids[0])) refs.set(ids[0], { kind: 'path', path: sub.path });
    else issues.push({ folder: sub.path, problem:
      ids.length > 1 ? `matches several producers (${ids.join(', ')}) — rename the folder or add its link in Airtable`
      : ids.length ? `${ids[0]} already has a folder — only one folder per producer is synced; merge them or move this one under "_"`
      : 'no matching producer in Airtable — rename the folder or add its link in Airtable' });
  }
  return refs;
}

function parseFolderUrl(raw: string): Ref | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('/')) return { kind: 'path', path: s.replace(/\/+$/, '') };
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)dropbox\.com$/.test(u.hostname)) return null;
  // Browser address of a folder in your own Dropbox: https://www.dropbox.com/home/Some/Folder
  if (u.pathname.startsWith('/home/')) return { kind: 'path', path: decodeURIComponent(u.pathname.slice(5)).replace(/\/+$/, '') };
  // Shared link (/scl/fo/…, /sh/…). Keep rlkey; drop dl/st, which only affect the web preview.
  u.searchParams.delete('dl'); u.searchParams.delete('st');
  return { kind: 'link', url: u.toString() };
}

// "Akita Konno Shoten (秋田今野商店)" → ["akitakonnoshoten(秋田今野商店)", "akitakonnoshoten", "秋田今野商店", …]
function nameKeys(p: Producer): string[] {
  const n = p.name;
  const out = [n, n.replace(/[（(].*?[)）]/g, ''), ...[...n.matchAll(/[（(](.*?)[)）]/g)].map((m) => m[1]), p.feature, p.id];
  return [...new Set(out.map(norm).filter((k) => k.length >= 2))];
}
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// ---------------------------------------------------------------- Dropbox API

let dbxToken = '';
async function dropboxLogin() {
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${env('DROPBOX_APP_KEY')}:${env('DROPBOX_APP_SECRET')}`) },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env('DROPBOX_REFRESH_TOKEN') }),
  });
  if (!r.ok) throw new Error(`Dropbox sign-in failed (${r.status}). The refresh token may have been revoked — redo the authorisation step. ${await r.text()}`);
  dbxToken = (await r.json()).access_token;
}

// Dropbox-API-Arg must be ASCII, so Japanese file names are \u-escaped.
const headerJson = (o: unknown) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const pathRoot = Deno.env.get('DROPBOX_TEAM_ROOT_NAMESPACE') ? { 'Dropbox-API-Path-Root': headerJson({ '.tag': 'root', root: Deno.env.get('DROPBOX_TEAM_ROOT_NAMESPACE') }) } : {};

async function dbx(kind: 'rpc' | 'content', endpoint: string, args: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = kind === 'rpc'
      ? await fetch(`https://api.dropboxapi.com/2/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${dbxToken}`, 'Content-Type': 'application/json', ...pathRoot }, body: JSON.stringify(args) })
      : await fetch(`https://content.dropboxapi.com/2/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${dbxToken}`, 'Dropbox-API-Arg': headerJson(args), ...pathRoot } });
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1000 * (Number(r.headers.get('retry-after')) || 2 ** attempt)));
      continue;
    }
    if (r.status === 401 && attempt === 0) { await dropboxLogin(); continue; }
    if (!r.ok) throw new Error(`Dropbox ${endpoint} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r;
  }
}

// Lists image files in a producer folder (and its subfolders, 3 levels deep). Names starting with "_" or "."
// are ignored, so a "_unused" subfolder is a handy place for photos that shouldn't go on the site.
async function listImages(ref: Ref, rel = '', depth = 0): Promise<DbxFile[]> {
  const args = ref.kind === 'link' ? { path: rel, shared_link: { url: ref.url } } : { path: ref.path + rel };
  let page = await (await dbx('rpc', 'files/list_folder', { ...args, limit: 2000 })).json();
  const entries = [...page.entries];
  while (page.has_more) {
    page = await (await dbx('rpc', 'files/list_folder/continue', { cursor: page.cursor })).json();
    entries.push(...page.entries);
  }
  const out: DbxFile[] = [];
  for (const e of entries) {
    if (/^[_.]/.test(e.name)) continue;
    const childRel = `${rel}/${e.name}`;
    if (e['.tag'] === 'folder' && depth < 3) out.push(...await listImages(ref, childRel, depth + 1));
    else if (e['.tag'] === 'file' && IMAGE.test(e.name)) {
      out.push({ id: e.id || childRel.toLowerCase(), rel: childRel, name: e.name, size: e.size ?? 0, version: e.content_hash || e.rev || `${e.server_modified}:${e.size}` });
    }
  }
  return out;
}

async function listSubfolders(path: string): Promise<{ name: string; path: string }[]> {
  let page = await (await dbx('rpc', 'files/list_folder', { path, limit: 2000 })).json();
  const entries = [...page.entries];
  while (page.has_more) { page = await (await dbx('rpc', 'files/list_folder/continue', { cursor: page.cursor })).json(); entries.push(...page.entries); }
  return entries.filter((e: { '.tag': string; name: string }) => e['.tag'] === 'folder' && !/^[_.]/.test(e.name))
    .map((e: { name: string; path_display: string }) => ({ name: e.name, path: e.path_display }));
}

// web mode: Dropbox renders a 2048px JPEG (fast pages, and it converts iPhone HEIC photos). Falls back to the original.
async function fetchImage(ref: Ref, f: DbxFile): Promise<{ bytes: Uint8Array; type: string; ext: string }> {
  const resource = ref.kind === 'link' ? { '.tag': 'link', url: ref.url, path: f.rel } : { '.tag': 'path', path: ref.path + f.rel };
  if (CFG.imageMode === 'web' && f.size <= 20 * 1024 * 1024) {
    try {
      const r = await dbx('content', 'files/get_thumbnail_v2', { resource, format: { '.tag': 'jpeg' }, size: { '.tag': 'w2048h1536' }, mode: { '.tag': 'fitone_bestfit' } });
      return { bytes: new Uint8Array(await r.arrayBuffer()), type: 'image/jpeg', ext: 'jpg' };
    } catch (e) { console.warn(`thumbnail failed for ${f.rel}, using original: ${msg(e)}`); }
  }
  if (!WEB.test(f.name)) throw new Error(`${f.name}: format browsers can't show and Dropbox couldn't convert`);
  if (f.size > MAX_ORIGINAL) throw new Error(`${f.name}: larger than ${MAX_ORIGINAL / 1048576} MB`);
  const r = ref.kind === 'link'
    ? await dbx('content', 'sharing/get_shared_link_file', { url: ref.url, path: f.rel })
    : await dbx('content', 'files/download', { path: ref.path + f.rel });
  const ext = f.name.split('.').pop()!.toLowerCase().replace('jpeg', 'jpg');
  return { bytes: new Uint8Array(await r.arrayBuffer()), type: MIME[ext], ext };
}

// ---------------------------------------------------------------- Airtable API

async function airtable(path: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://api.airtable.com/v0/${env('AIRTABLE_BASE_ID')}/${path}`, {
      ...init, headers: { Authorization: `Bearer ${env('AIRTABLE_TOKEN')}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (r.status === 429 && attempt < 3) { await new Promise((res) => setTimeout(res, 30_000)); continue; } // Airtable asks for 30 s
    if (!r.ok) throw new Error(`Airtable ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
}

async function airtableProducers(): Promise<Producer[]> {
  const out: Producer[] = [];
  let offset = '';
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    for (const f of [CFG.nameField, CFG.folderField, CFG.featureField, CFG.urlsField]) q.append('fields[]', f);
    if (offset) q.set('offset', offset);
    const page = await airtable(`${CFG.table}?${q}`);
    for (const r of page.records) {
      const f = r.fields;
      out.push({ id: r.id, name: String(f[CFG.nameField] ?? '').trim(), feature: String(f[CFG.featureField] ?? '').trim(), folderUrl: String(f[CFG.folderField] ?? '').trim(), urls: String(f[CFG.urlsField] ?? '') });
    }
    offset = page.offset ?? '';
  } while (offset);
  return out;
}

// Only records whose URL list actually changed are written, 10 per request (Airtable's limit), ≤ 5 requests/second.
async function airtableUpdate(records: { id: string; fields: Record<string, string> }[]) {
  for (let i = 0; i < records.length; i += 10) {
    await airtable(CFG.table, { method: 'PATCH', body: JSON.stringify({ records: records.slice(i, i + 10) }) });
    await new Promise((res) => setTimeout(res, 250));
  }
}

// ---------------------------------------------------------------- helpers

const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
async function shortHash(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d.slice(0, 5)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
