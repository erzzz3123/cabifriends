// POST /api/submit — the Submit a Producer form. JSON, in two steps so photos never pass through Vercel
// (whose request bodies are capped at 4.5 MB):
//   1. { name, business, …, photos: [{ type, size }] } → validates, saves a `new` submission,
//      returns one signed upload URL per photo (private `submissions` bucket) and a receipt key.
//   2. { done: id, key } once the browser has uploaded → records which photos arrived, optionally copies to Airtable.
import crypto from 'node:crypto';
import { sbAdmin } from '../lib/supabase.js';

const CATEGORIES = ['Producer', 'Farmer', 'Craft / Maker', 'Restaurant', 'Shop', 'Other'];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif' };
const MAX_PHOTOS = 6, MAX_BYTES = 10 * 1024 * 1024, PER_HOUR = 5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const secret = () => process.env.SUBMIT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
const receipt = (id) => crypto.createHmac('sha256', secret()).update('submission:' + id).digest('hex');

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    return body.done ? await finish(body, res) : await start(req, body, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could_not_save' });
  }
}

async function start(req, body, res) {
  const s = (k, max = 300) => String(body[k] ?? '').trim().slice(0, max);
  // Honeypot: a field people can't see. Bots that fill it get a normal-looking reply and nothing is saved.
  if (s('company')) return res.status(200).json({ id: 0, key: '', uploads: [] });

  const row = {
    name: s('name', 200), business: s('business', 200), name_ja: s('name_ja', 200),
    category: CATEGORIES.includes(s('category')) ? s('category') : 'Other',
    city: s('city', 200), prefecture: s('pref', 40), makes: s('makes', 500), story: s('story', 6000),
    website: s('website', 300), instagram: s('instagram', 100), email: s('email', 320).toLowerCase(),
    who: s('who') === 'other' ? 'other' : 'self', lang: s('lang') === 'ja' ? 'ja' : 'en', status: 'new',
  };
  if (!row.name || !row.business || !EMAIL.test(row.email) || !row.prefecture) return res.status(400).json({ error: 'missing_fields' });

  const sb = sbAdmin();
  const { data: pref } = await sb.from('prefectures').select('slug').eq('slug', row.prefecture).maybeSingle();
  if (!pref) return res.status(400).json({ error: 'missing_fields' });

  // Simple rate limit per visitor (IP is hashed, never stored raw).
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  row.ip_hash = crypto.createHmac('sha256', secret()).update(ip).digest('hex').slice(0, 32);
  const since = new Date(Date.now() - 3600e3).toISOString();
  const { count } = await sb.from('submissions').select('id', { count: 'exact', head: true }).eq('ip_hash', row.ip_hash).gte('created_at', since);
  if (count >= PER_HOUR) return res.status(429).json({ error: 'too_many' });

  const { data: sub, error } = await sb.from('submissions').insert(row).select('id').single();
  if (error) throw error;

  const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, MAX_PHOTOS);
  const uploads = [];
  for (const [i, p] of photos.entries()) {
    const ext = EXT[p?.type];
    if (!ext || !(p.size > 0 && p.size <= MAX_BYTES)) { uploads.push(null); continue; }
    const path = `${sub.id}/${i + 1}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const { data, error: upErr } = await sb.storage.from('submissions').createSignedUploadUrl(path);
    uploads.push(upErr ? null : { url: data.signedUrl });
  }
  res.status(200).json({ id: sub.id, key: receipt(sub.id), uploads });
}

async function finish(body, res) {
  const id = parseInt(body.done, 10), key = String(body.key || '');
  const want = receipt(id);
  if (!id || key.length !== want.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want))) return res.status(403).json({ error: 'bad_key' });

  const sb = sbAdmin();
  const { data: files } = await sb.storage.from('submissions').list(String(id), { sortBy: { column: 'name', order: 'asc' } });
  const paths = (files || []).filter((f) => f.id).map((f) => `${id}/${f.name}`);
  const { data: sub, error } = await sb.from('submissions').update({ photo_paths: paths }).eq('id', id).select('*').single();
  if (error) throw error;

  // Optional: copy to an Airtable "Submissions" table if the team wants new entries to show up there too.
  if (process.env.AIRTABLE_TOKEN && process.env.AIRTABLE_SUBMISSIONS_TABLE && !sub.airtable_id) {
    try {
      const r = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_SUBMISSIONS_TABLE)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ typecast: true, records: [{ fields: { Name: sub.name, Business: sub.business, 'Japanese name': sub.name_ja, Category: sub.category,
          City: sub.city, Prefecture: sub.prefecture, Makes: sub.makes, Story: sub.story, Website: sub.website, Instagram: sub.instagram,
          Email: sub.email, 'Submitted by': sub.who, 'Supabase ID': String(sub.id), Photos: paths.length } }] }),
      });
      const j = await r.json();
      if (r.ok && j.records?.[0]) await sb.from('submissions').update({ airtable_id: j.records[0].id }).eq('id', id);
      else console.error('airtable', j);
    } catch (e) { console.error('airtable', e); }
  }
  res.status(200).json({ ok: true, photos: paths.length });
}
