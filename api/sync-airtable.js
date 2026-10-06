// GET /api/sync-airtable → copies producers from Airtable (the source of truth) into the site's database.
// Runs hourly from Supabase Cron (supabase/dropbox.sql) with `Authorization: Bearer CRON_SECRET`, or on demand from /admin.
// Off unless AIRTABLE_TOKEN and AIRTABLE_BASE_ID are set.
//
// Reads fields by ID, so renaming Airtable columns is safe. Private columns (Email, Contact status…) are never requested.
// Airtable owns: names, maker, prefecture, craft → makes/tags, website/Instagram, Feature # and Image URLs
// (filled by the Dropbox sync). Everything else (descriptions, coordinates, published) is left as set in /admin,
// unless AIRTABLE_PUBLISHED_FIELD points at a checkbox. Rows with names in brackets, e.g. "(Placeholder) …", are skipped.
import { sbAdmin, adminFrom, slugify } from '../lib/supabase.js';

const F = {
  table: process.env.AIRTABLE_PRODUCERS_TABLE || 'tblG7x02MvbxqYPwF',
  name: 'fld1OjTacZYCu6UM7',      // Place / 工房名
  maker: 'fldWELsxWsdiJqDUu',     // Craftsperson / つくり手
  craft: 'fldfHceYiE9GLNIR5',     // Craft / 分野
  prefecture: 'fldkM8UspFXXSmTqK', // Prefecture / 都道府県
  website: 'fld6B4C5eGyl3zVjG',   // Website
  feature: 'fldkJODLUgUUmhFnT',   // Feature #
  images: 'fldkPzHHAzwcXGHdu',    // Image URLs (one per line, written by the Dropbox sync)
  published: process.env.AIRTABLE_PUBLISHED_FIELD || '',
};
const CRAFT_EN = { 調味料: 'Seasonings', 酒: 'Drinks' };
const JP = /[぀-ヿ㐀-鿿]/;

// "Akita Konno Shoten (秋田今野商店)" → en "Akita Konno Shoten", ja "秋田今野商店".
// "飯尾醸造 (りょうくん知り合い）" → en "飯尾醸造" (bracketed note after a Japanese name is dropped).
function parseName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s || /^[（(]/.test(s)) return null;
  const outside = s.replace(/\s*[（(].*?[)）]\s*/g, ' ').trim();
  const inside = (s.match(/[（(](.*?)[)）]/) || [])[1]?.trim();
  const latin = !JP.test(outside);
  return { en: outside, ja: latin && inside && JP.test(inside) ? inside : null };
}

export default async function handler(req, res) {
  const cron = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron && !(await adminFrom(req))) return res.status(401).end();
  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID } = process.env;
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) return res.status(200).json({ skipped: 'Airtable sync is not configured' });

  const fields = [F.name, F.maker, F.craft, F.prefecture, F.website, F.feature, F.images, F.published].filter(Boolean);
  let records = [], offset = '';
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    fields.forEach((f) => q.append('fields[]', f));
    if (offset) q.set('offset', offset);
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${F.table}?${q}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!r.ok) return res.status(502).send(await r.text());
    const j = await r.json(); records = records.concat(j.records); offset = j.offset || '';
  } while (offset);

  const sb = sbAdmin();
  const { data: prefs } = await sb.from('prefectures').select('slug, name_ja');
  const prefBy = new Map();
  for (const p of prefs || []) { prefBy.set(p.slug, p.slug); prefBy.set(p.name_ja, p.slug); prefBy.set(p.name_ja.replace(/[都府県]$/, ''), p.slug); }

  const { data: existing, error: exErr } = await sb.from('friends').select('id, slug, name_en, airtable_id, source');
  if (exErr) return res.status(500).json({ error: exErr.message });
  let n = 0, imgs = 0; const errors = [], seen = [];
  for (const rec of records) {
    const f = rec.fields;
    const name = parseName(f[F.name]);
    if (!name) continue;
    const prefText = String(f[F.prefecture] || '').trim();
    const prefecture = prefBy.get(slugify(prefText)) || prefBy.get(prefText) || null;
    const site = String(f[F.website] || '').trim();
    const insta = /instagram\.com\//i.test(site) ? '@' + site.replace(/^.*instagram\.com\//i, '').replace(/[/?].*$/, '') : null;
    const crafts = (f[F.craft] || []).map((c) => (typeof c === 'string' ? c : c.name));
    const no = parseInt(f[F.feature], 10);
    const row = {
      airtable_id: rec.id, name_en: name.en, name_ja: name.ja, maker: String(f[F.maker] || '').trim() || null,
      website: insta ? null : site || null, instagram: insta,
      makes: crafts.map((c) => CRAFT_EN[c] || c).join(' · ') || null, tags: crafts.map((c) => CRAFT_EN[c] || c),
      source: 'airtable',
    };
    if (prefecture) row.prefecture = prefecture;
    if (no > 0) row.no = no;
    if (F.published) row.published = !!f[F.published];

    // Match by Airtable id; otherwise adopt an unowned seeded row with the same slug or name.
    const slug = slugify(name.en);
    const mine = existing.find((r) => r.airtable_id === rec.id)
      || existing.find((r) => !r.airtable_id && r.source !== 'submission' && ((slug && r.slug === slug) || r.name_en === name.en));
    if (!mine && !prefecture) { errors.push(`${name.en}: no recognisable prefecture ("${prefText}")`); continue; }
    const ins = mine ? null : { ...row, slug: slug && !existing.some((r) => r.slug === slug) ? slug : `p-${rec.id.slice(3).toLowerCase()}`, published: F.published ? row.published : false };
    const { data: saved, error } = await (mine ? sb.from('friends').update(row).eq('id', mine.id) : sb.from('friends').insert(ins)).select('id, slug').single();
    if (error) { errors.push(`${name.en}: ${error.message}`); continue; }
    if (mine) mine.airtable_id = rec.id; else existing.push({ ...saved, name_en: name.en, airtable_id: rec.id, source: 'airtable' });
    n++; seen.push(rec.id);

    // Images: the Dropbox sync's URLs replace whatever the producer had. No URLs yet → keep existing (bundled) photos.
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
  res.status(200).json({ friends: n, new_images: imgs, hidden, errors });
}
