// Airtable (source of truth) → the website's database (`friends`, `friend_images`).
//
// Runs every 15 minutes from Supabase Cron, right after each Dropbox image sync that changed something, and on demand
// from /admin → Producers → "Sync from Airtable". The website reads the database through /api/data (60 s cache),
// so an Airtable edit is live within ~15 minutes without redeploying anything.
//
// Reads fields by ID, so renaming Airtable columns is safe. Private columns (Email, Contact status…) are never requested.
// Airtable owns: names, maker, prefecture, craft → makes/tags, website/Instagram, Feature #, Description (EN/JA) and Image URLs
// (filled by dropbox-sync). Coordinates and published are left as set in /admin unless
// AIRTABLE_PUBLISHED_FIELD names a checkbox field. Rows whose name starts with a bracket — "(Placeholder) …" — are skipped.
//
// Auth: `Authorization: Bearer <SYNC_SECRET>` (cron, dropbox-sync) or a signed-in user listed in `admins`.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing secret ${k}`);
  return v;
};
const F = {
  table: Deno.env.get('AIRTABLE_PRODUCERS_TABLE') ?? 'tblG7x02MvbxqYPwF',
  name: 'fld1OjTacZYCu6UM7',       // Place / 工房名
  maker: 'fldWELsxWsdiJqDUu',      // Craftsperson / つくり手
  craft: 'fldfHceYiE9GLNIR5',      // Craft / 分野
  prefecture: 'fldkM8UspFXXSmTqK', // Prefecture / 都道府県
  website: 'fld6B4C5eGyl3zVjG',    // Website
  feature: 'fldkJODLUgUUmhFnT',    // Feature #
  images: 'fldkPzHHAzwcXGHdu',     // Image URLs (one per line, written by dropbox-sync)
  description: 'fldQv2LMvbe58illX',   // Description (one or two sentences, Cabi's voice)
  descriptionJa: 'fldoMOX8OHpd9ANKN', // Description (JA)
  published: Deno.env.get('AIRTABLE_PUBLISHED_FIELD') ?? '',
};
const CRAFT_EN: Record<string, string> = { 調味料: 'Seasonings', 酒: 'Drinks' };
const JP = /[぀-ヿ㐀-鿿]/;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const slugify = (s: string) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// "Akita Konno Shoten (秋田今野商店)" → en "Akita Konno Shoten", ja "秋田今野商店".
// "飯尾醸造 (りょうくん知り合い）" → en "飯尾醸造" (a bracketed note after a Japanese name is dropped).
export function parseName(raw: unknown): { en: string; ja: string | null } | null {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s || /^[（(]/.test(s)) return null;
  const outside = s.replace(/\s*[（(].*?[)）]\s*/g, ' ').trim();
  const inside = (s.match(/[（(](.*?)[)）]/) || [])[1]?.trim();
  return { en: outside, ja: !JP.test(outside) && inside && JP.test(inside) ? inside : null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  if (!(await authorized(req, sb))) return json({ error: 'unauthorized' }, 401);
  try {
    return json(await sync(sb));
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

async function authorized(req: Request, sb: ReturnType<typeof createClient>): Promise<boolean> {
  const got = req.headers.get('authorization') ?? '';
  const want = `Bearer ${env('SYNC_SECRET')}`;
  if (got.length === want.length) {
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
    if (diff === 0) return true;
  }
  const token = got.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const { data } = await sb.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: row } = await sb.from('admins').select('email').eq('email', email).maybeSingle();
  return !!row;
}

async function sync(sb: ReturnType<typeof createClient>) {
  const fields = [F.name, F.maker, F.craft, F.prefecture, F.website, F.feature, F.images, F.description, F.descriptionJa, F.published].filter(Boolean);
  // deno-lint-ignore no-explicit-any
  let records: any[] = [], offset = '';
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    fields.forEach((f) => q.append('fields[]', f));
    if (offset) q.set('offset', offset);
    const r = await fetch(`https://api.airtable.com/v0/${env('AIRTABLE_BASE_ID')}/${F.table}?${q}`, { headers: { Authorization: `Bearer ${env('AIRTABLE_TOKEN')}` } });
    if (!r.ok) throw new Error(`Airtable ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json(); records = records.concat(j.records); offset = j.offset || '';
  } while (offset);

  const { data: prefs } = await sb.from('prefectures').select('slug, name_ja');
  const prefBy = new Map<string, string>();
  for (const p of prefs || []) { prefBy.set(p.slug, p.slug); prefBy.set(p.name_ja, p.slug); prefBy.set(p.name_ja.replace(/[都府県]$/, ''), p.slug); }

  const { data: existing, error: exErr } = await sb.from('friends').select('id, slug, name_en, airtable_id, source');
  if (exErr) throw exErr;
  let n = 0, imgs = 0; const errors: string[] = [], seen: string[] = [];
  for (const rec of records) {
    const f = rec.fields;
    const name = parseName(f[F.name]);
    if (!name) continue;
    const prefText = String(f[F.prefecture] || '').trim();
    const prefecture = prefBy.get(slugify(prefText)) || prefBy.get(prefText) || null;
    const site = String(f[F.website] || '').trim();
    const insta = /instagram\.com\//i.test(site) ? '@' + site.replace(/^.*instagram\.com\//i, '').replace(/[/?].*$/, '') : null;
    const crafts: string[] = (f[F.craft] || []).map((c: string | { name: string }) => (typeof c === 'string' ? c : c.name));
    const no = parseInt(f[F.feature], 10);
    // deno-lint-ignore no-explicit-any
    const row: Record<string, any> = {
      airtable_id: rec.id, name_en: name.en, name_ja: name.ja, maker: String(f[F.maker] || '').trim() || null,
      website: insta ? null : site || null, instagram: insta,
      makes: crafts.map((c) => CRAFT_EN[c] || c).join(' · ') || null, tags: crafts.map((c) => CRAFT_EN[c] || c),
      description: String(f[F.description] || '').trim() || null,
      description_ja: String(f[F.descriptionJa] || '').trim() || null,
      source: 'airtable',
    };
    if (prefecture) row.prefecture = prefecture;
    if (no > 0) row.no = no;
    if (F.published) row.published = !!f[F.published];

    // Match by Airtable id; otherwise adopt an unowned seeded row with the same slug or name.
    const slug = slugify(name.en);
    const mine = existing.find((r) => r.airtable_id === rec.id)
      || existing.find((r) => !r.airtable_id && r.source !== 'submission' && ((slug && r.slug === slug) || r.name_en === name.en));
    if (!mine && !prefecture) { errors.push(`${name.en}: no recognisable prefecture ("${prefText}") — add one in Airtable`); continue; }
    const ins = mine ? null : { ...row, slug: slug && !existing.some((r) => r.slug === slug) ? slug : `p-${rec.id.slice(3).toLowerCase()}`, published: F.published ? row.published : false };
    const { data: saved, error } = await (mine ? sb.from('friends').update(row).eq('id', mine.id) : sb.from('friends').insert(ins)).select('id, slug').single();
    if (error) { errors.push(`${name.en}: ${error.message}`); continue; }
    if (mine) mine.airtable_id = rec.id; else existing.push({ ...saved, name_en: name.en, airtable_id: rec.id, source: 'airtable' });
    n++; seen.push(rec.id);

    // Images: Dropbox's URLs replace whatever the producer had. No URLs yet → keep existing (bundled) photos.
    const urls = String(f[F.images] || '').split('\n').map((s) => s.trim()).filter((s) => /^https:\/\//.test(s));
    if (urls.length) {
      const { data: cur } = await sb.from('friend_images').select('id, path').eq('friend_id', saved.id);
      const stale = (cur || []).filter((c) => !urls.includes(c.path)).map((c) => c.id);
      if (stale.length) await sb.from('friend_images').delete().in('id', stale);
      const { error: imErr } = await sb.from('friend_images').upsert(urls.map((path, position) => ({ friend_id: saved.id, path, position, caption: null })), { onConflict: 'path' });
      if (imErr) errors.push(`${name.en} images: ${imErr.message}`);
      imgs += urls.length - (cur || []).filter((c) => urls.includes(c.path)).length;
    }
  }
  // Producers deleted from Airtable are hidden (not deleted) so nothing is lost by accident.
  let hidden = 0;
  if (seen.length) {
    const { data } = await sb.from('friends').update({ published: false }).eq('source', 'airtable').eq('published', true)
      .not('airtable_id', 'is', null).not('airtable_id', 'in', `(${seen.join(',')})`).select('id');
    hidden = data?.length || 0;
  }
  const result = { friends: n, new_images: imgs, hidden, errors };
  console.log(JSON.stringify(result));
  return result;
}
