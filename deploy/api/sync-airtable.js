// GET /api/sync-airtable → copies Friends from Airtable (the team's editing sheet) into Supabase.
// Runs every 15 minutes via Vercel Cron, or open it manually with ?key=CRON_SECRET.
// Airtable photo attachments are copied once into Supabase Storage (bucket "friends").
import { sb } from '../lib/supabase.js';

const list = (v) => (Array.isArray(v) ? v : (v || '').split(/[,、]/)).map((s) => String(s).trim()).filter(Boolean);
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export default async function handler(req, res) {
  const auth = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query.key === process.env.CRON_SECRET;
  if (!auth) return res.status(401).end();
  const base = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_FRIENDS_TABLE || 'Friends')}`;
  const H = { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` };
  let records = [], offset;
  do {
    const r = await fetch(base + (offset ? `?offset=${offset}` : ''), { headers: H });
    if (!r.ok) return res.status(502).send(await r.text());
    const j = await r.json(); records = records.concat(j.records); offset = j.offset;
  } while (offset);

  let n = 0, imgs = 0;
  for (const rec of records) {
    const f = rec.fields; // Column names below match the Airtable sheet — rename here if the sheet changes.
    const name_en = f['Name'] || f['Name (EN)']; if (!name_en) continue;
    const slug = f['Slug'] || slugify(name_en);
    const row = {
      airtable_id: rec.id, slug, no: f['No'] || f['Feature #'] || null, name_en, name_ja: f['Japanese name'] || f['Name (JP)'] || null,
      maker: f['Maker'] || null, prefecture: slugify(f['Prefecture'] || ''), city: f['City'] || f['Location'] || null,
      latitude: f['Latitude'] ?? null, longitude: f['Longitude'] ?? null, category: f['Category'] || 'Producer', since: f['Since'] || null,
      makes: f['Makes'] || f['Craft'] || null, specialties: list(f['Specialties']), ingredients: list(f['Ingredients']),
      methods: list(f['Methods']), tags: list(f['Tags']), description: f['Description'] || null, story: f['Story'] || null,
      relationship_to_cabi: f['Why Cabi'] || null, website: f['Website'] || null, instagram: f['Instagram'] || null,
      published: !!f['Published'], updated_at: new Date().toISOString(),
    };
    const { data: saved, error } = await sb.from('friends').upsert(row, { onConflict: 'airtable_id' }).select('id').single();
    if (error) { console.error(slug, error); continue; }
    n++;
    for (const [i, a] of (f['Photos'] || []).entries()) {
      const path = `${slug}/${a.id}-${(a.filename || 'photo.jpg').replace(/[^\w.-]+/g, '_')}`;
      const { data: have } = await sb.from('friend_images').select('id').eq('path', path).maybeSingle();
      if (have) { await sb.from('friend_images').update({ position: i }).eq('id', have.id); continue; }
      const blob = await (await fetch(a.url)).arrayBuffer();
      const { error: upErr } = await sb.storage.from('friends').upload(path, Buffer.from(blob), { contentType: a.type || 'image/jpeg', upsert: true });
      if (!upErr) { await sb.from('friend_images').insert({ friend_id: saved.id, path, caption: null, position: i }); imgs++; }
    }
  }
  res.status(200).json({ friends: n, new_images: imgs });
}
