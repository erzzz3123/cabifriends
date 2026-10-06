// POST /api/submit (multipart form) → saves to Supabase, uploads photos to Storage, copies the entry to Airtable.
import { sb } from '../lib/supabase.js';
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const form = await new Request('http://x', { method: 'POST', headers: req.headers, body: req, duplex: 'half' }).formData();
    const g = (k) => (form.get(k) || '').toString().trim().slice(0, 4000);
    if (!g('email') || !g('business')) return res.status(400).json({ error: 'missing fields' });

    const row = { name: g('name'), business: g('business'), name_ja: g('name_ja'), category: g('category'), city: g('city'),
      prefecture: g('pref'), makes: g('makes'), story: g('story'), website: g('website'), instagram: g('instagram'),
      email: g('email'), who: g('who'), lang: g('lang'), status: 'new' };
    const { data: sub, error } = await sb.from('submissions').insert(row).select('id').single();
    if (error) throw error;

    const photos = form.getAll('photos').filter((f) => f && f.size && f.type.startsWith('image/')).slice(0, 6);
    const paths = [];
    for (const [i, f] of photos.entries()) {
      if (f.size > 15 * 1024 * 1024) continue;
      const path = `submissions/${sub.id}/${i + 1}-${f.name.replace(/[^\w.-]+/g, '_')}`;
      const { error: upErr } = await sb.storage.from('submissions').upload(path, Buffer.from(await f.arrayBuffer()), { contentType: f.type });
      if (!upErr) paths.push(path);
    }
    if (paths.length) await sb.from('submissions').update({ photo_paths: paths }).eq('id', sub.id);

    if (process.env.AIRTABLE_TOKEN) {
      await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_SUBMISSIONS_TABLE || 'Submissions')}`, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ typecast: true, records: [{ fields: { Name: row.name, Business: row.business, 'Japanese name': row.name_ja, Category: row.category,
          City: row.city, Prefecture: row.prefecture, Makes: row.makes, Story: row.story, Website: row.website, Instagram: row.instagram,
          Email: row.email, 'Submitted by': row.who, 'Supabase ID': String(sub.id), Photos: paths.length } }] }),
      }).catch((e) => console.error('airtable', e));
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not save' });
  }
}
