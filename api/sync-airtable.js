// GET /api/sync-airtable → OPTIONAL: copies Friends from an Airtable table into Supabase.
// Off unless AIRTABLE_TOKEN, AIRTABLE_BASE_ID and AIRTABLE_FRIENDS_TABLE are set. Trigger it with
// `Authorization: Bearer CRON_SECRET` (Vercel Cron does this) or as a signed-in admin.
// Only rows it created (source = 'airtable') are ever changed; producers approved in /admin are left alone.
// Airtable photo attachments are copied once into Supabase Storage (bucket "friends").
import { sbAdmin, adminFrom, slugify } from '../lib/supabase.js';

const list = (v) => (Array.isArray(v) ? v : (v || '').split(/[,、]/)).map((s) => String(s).trim()).filter(Boolean);
const TYPES = ['Producer', 'Farmer', 'Restaurant', 'Shop', 'Craft'];

export default async function handler(req, res) {
  const cron = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron && !(await adminFrom(req))) return res.status(401).end();
  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_FRIENDS_TABLE } = process.env;
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_FRIENDS_TABLE) return res.status(200).json({ skipped: 'Airtable sync is not configured' });

  const base = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_FRIENDS_TABLE)}`;
  const H = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };
  let records = [], offset;
  do {
    const r = await fetch(base + (offset ? `?offset=${offset}` : ''), { headers: H });
    if (!r.ok) return res.status(502).send(await r.text());
    const j = await r.json(); records = records.concat(j.records); offset = j.offset;
  } while (offset);

  const sb = sbAdmin();
  let n = 0, imgs = 0; const errors = [], seen = [];
  for (const rec of records) {
    const f = rec.fields; // Column names below match the Airtable sheet — rename here if the sheet changes.
    const name_en = f['Name'] || f['Name (EN)']; if (!name_en) continue;
    const no = parseInt(f['No'] || f['Feature #'], 10) || null;
    const slug = slugify(f['Slug'] || name_en) || `friend-${no || rec.id.toLowerCase()}`;
    const row = {
      airtable_id: rec.id, slug, no, name_en, name_ja: f['Japanese name'] || f['Name (JP)'] || null,
      maker: f['Maker'] || null, prefecture: slugify(f['Prefecture'] || ''), city: f['City'] || f['Location'] || null,
      latitude: f['Latitude'] ?? null, longitude: f['Longitude'] ?? null,
      category: TYPES.includes(f['Category']) ? f['Category'] : 'Producer', since: parseInt(f['Since'], 10) || null,
      makes: f['Makes'] || f['Craft'] || null, specialties: list(f['Specialties']), ingredients: list(f['Ingredients']),
      methods: list(f['Methods']), tags: list(f['Tags']), description: f['Description'] || null, story: f['Story'] || null,
      relationship_to_cabi: f['Why Cabi'] || null, website: f['Website'] || null, instagram: f['Instagram'] || null,
      published: !!f['Published'], source: 'airtable',
    };
    // Match by Airtable id first; otherwise adopt a seeded row with the same slug that no other source owns.
    const { data: existing } = await sb.from('friends').select('id, airtable_id, source').or(`airtable_id.eq.${rec.id},slug.eq.${slug}`);
    const mine = existing?.find((r) => r.airtable_id === rec.id) || existing?.find((r) => !r.airtable_id && r.source !== 'submission');
    if (!mine && existing?.length) { errors.push(`${slug}: slug already used by another producer`); continue; }
    const q = mine ? sb.from('friends').update(row).eq('id', mine.id) : sb.from('friends').insert(row);
    const { data: saved, error } = await q.select('id').single();
    if (error) { errors.push(`${slug}: ${error.message}`); continue; }
    n++; seen.push(rec.id);
    for (const [i, a] of (f['Photos'] || []).entries()) {
      const path = `${slug}/${a.id}-${(a.filename || 'photo.jpg').replace(/[^\w.-]+/g, '_')}`;
      const { data: have } = await sb.from('friend_images').select('id').eq('path', path).maybeSingle();
      if (have) { await sb.from('friend_images').update({ position: i }).eq('id', have.id); continue; }
      const blob = await (await fetch(a.url)).arrayBuffer();
      const { error: upErr } = await sb.storage.from('friends').upload(path, Buffer.from(blob), { contentType: a.type || 'image/jpeg', upsert: true });
      if (!upErr) { await sb.from('friend_images').insert({ friend_id: saved.id, path, caption: null, position: i }); imgs++; }
    }
  }
  // Rows deleted from Airtable are hidden (not deleted) so nothing is lost by accident.
  let hidden = 0;
  if (seen.length) {
    const { data } = await sb.from('friends').update({ published: false }).eq('source', 'airtable').eq('published', true)
      .not('airtable_id', 'is', null).not('airtable_id', 'in', `(${seen.join(',')})`).select('id');
    hidden = data?.length || 0;
  }
  res.status(200).json({ friends: n, new_images: imgs, hidden, errors });
}
