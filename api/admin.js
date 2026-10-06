// /api/admin — approval workflow behind /admin. Every call needs a Supabase access token for a user in the `admins` table.
//   GET  ?view=submissions&status=new|approved|rejected → submissions with short-lived links to their private photos
//   GET  ?view=friends                                   → all producers, published or not
//   POST { action: 'approve', id, friend: {…}, photos: [paths], publish } → creates the producer, copies chosen photos
//   POST { action: 'reject', id, note } · { action: 'reopen', id }
//   POST { action: 'save', friend: {id, …} }             → edits an existing producer
//   POST { action: 'publish', friend_id, published }     → shows / hides a producer on the site
import { sbAdmin, adminFrom, publicUrl, slugify } from '../lib/supabase.js';

const TYPES = ['Producer', 'Farmer', 'Restaurant', 'Shop', 'Craft'];
const CAT_FROM_FORM = { 'Craft / Maker': 'Craft', Other: 'Producer' };
const WEB_IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const email = await adminFrom(req);
    if (!email) return res.status(403).json({ error: 'not_admin' });
    if (req.method === 'GET') return await read(req, res, email);
    if (req.method !== 'POST') return res.status(405).end();
    const b = req.body || {};
    const act = { approve, reject, reopen, save, publish }[b.action];
    if (!act) return res.status(400).json({ error: 'unknown_action' });
    return await act(b, res, email);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'failed' });
  }
}

async function read(req, res, email) {
  const sb = sbAdmin();
  if (req.query.view === 'friends') {
    const { data, error } = await sb.from('friends').select('*, friend_images(path, position)').order('no', { nullsFirst: false });
    if (error) throw error;
    return res.json({ email, friends: data.map((f) => ({ ...f, images: (f.friend_images || []).sort((a, b) => a.position - b.position).map((i) => publicUrl(i.path)), friend_images: undefined })) });
  }
  const status = ['new', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'new';
  const { data, error } = await sb.from('submissions').select('*, friend:friends!submissions_friend_id_fkey(slug, published)')
    .eq('status', status).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  for (const s of data) {
    s.photos = [];
    if (s.photo_paths?.length) {
      const { data: signed } = await sb.storage.from('submissions').createSignedUrls(s.photo_paths, 3600);
      s.photos = (signed || []).map((x, i) => ({ path: s.photo_paths[i], url: x.signedUrl }));
    }
    delete s.ip_hash;
  }
  res.json({ email, submissions: data });
}

// Cleans the editable producer fields coming from the admin form.
function clean(f) {
  const t = (v, max = 4000) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,、]/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
  const category = CAT_FROM_FORM[f.category] || f.category;
  return {
    slug: slugify(f.slug || f.name_en), name_en: t(f.name_en, 200), name_ja: t(f.name_ja, 200), maker: t(f.maker, 200),
    prefecture: t(f.prefecture, 40), city: t(f.city, 200), latitude: num(f.latitude), longitude: num(f.longitude),
    category: TYPES.includes(category) ? category : 'Producer', since: num(f.since), makes: t(f.makes, 300),
    tags: list(f.tags), specialties: list(f.specialties), ingredients: list(f.ingredients), methods: list(f.methods),
    description: t(f.description), description_ja: t(f.description_ja), story: t(f.story, 8000), story_ja: t(f.story_ja, 8000),
    relationship_to_cabi: t(f.relationship_to_cabi), website: t(f.website, 300), instagram: t(f.instagram, 100),
  };
}
const invalid = (row) => (!row.name_en ? 'Name is required' : !row.slug ? 'Slug is required' : !row.prefecture ? 'Prefecture is required' : null);
const conflict = (error) => (error?.code === '23505' ? 'That slug is already used by another producer' : error?.code === '23503' ? 'Unknown prefecture' : error?.code === '23514' ? 'Check the coordinates and category' : null);

async function approve(b, res, email) {
  const sb = sbAdmin();
  const { data: sub } = await sb.from('submissions').select('*').eq('id', b.id).maybeSingle();
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (sub.status === 'approved') return res.status(409).json({ error: 'Already approved' });

  const row = clean(b.friend || {});
  const bad = invalid(row); if (bad) return res.status(400).json({ error: bad });
  const { data: last } = await sb.from('friends').select('no').order('no', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  Object.assign(row, { no: (last?.no || 0) + 1, source: 'submission', submission_id: sub.id, published: !!b.publish });

  const { data: friend, error } = await sb.from('friends').insert(row).select('id, slug, published').single();
  if (error) return res.status(400).json({ error: conflict(error) || error.message });

  // Copy the chosen photos from the private bucket to the public one. Formats browsers can't show (HEIC) are skipped.
  const chosen = (Array.isArray(b.photos) ? b.photos : []).filter((p) => (sub.photo_paths || []).includes(p) && WEB_IMAGE.test(p));
  let copied = 0;
  for (const [i, p] of chosen.entries()) {
    const { data: blob, error: dErr } = await sb.storage.from('submissions').download(p);
    if (dErr) { console.error(p, dErr); continue; }
    const dest = `${friend.slug}/${p.split('/').pop()}`;
    const { error: uErr } = await sb.storage.from('friends').upload(dest, Buffer.from(await blob.arrayBuffer()), { contentType: blob.type || 'image/jpeg', upsert: true });
    if (uErr) { console.error(dest, uErr); continue; }
    await sb.from('friend_images').insert({ friend_id: friend.id, path: dest, caption: null, position: i });
    copied++;
  }
  await sb.from('submissions').update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: email, review_note: b.note || null, friend_id: friend.id }).eq('id', sub.id);
  res.json({ ok: true, friend, photos: copied });
}

async function reject(b, res, email) {
  const { error } = await sbAdmin().from('submissions').update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: email, review_note: b.note ? String(b.note).slice(0, 2000) : null })
    .eq('id', b.id).neq('status', 'approved');
  if (error) throw error;
  res.json({ ok: true });
}

async function reopen(b, res) {
  const { error } = await sbAdmin().from('submissions').update({ status: 'new', reviewed_at: null, reviewed_by: null }).eq('id', b.id).eq('status', 'rejected');
  if (error) throw error;
  res.json({ ok: true });
}

async function save(b, res) {
  const id = b.friend?.id;
  if (!id) return res.status(400).json({ error: 'Missing producer id' });
  const row = clean(b.friend);
  const bad = invalid(row); if (bad) return res.status(400).json({ error: bad });
  // Only touch the fields the form sent, so columns it doesn't show (e.g. methods) keep their values.
  for (const k of Object.keys(row)) if (!(k in b.friend) && k !== 'slug') delete row[k];
  const { data, error } = await sbAdmin().from('friends').update(row).eq('id', id).select('id, slug, published').single();
  if (error) return res.status(400).json({ error: conflict(error) || error.message });
  res.json({ ok: true, friend: data });
}

async function publish(b, res) {
  const { data, error } = await sbAdmin().from('friends').update({ published: !!b.published }).eq('id', b.friend_id).select('id, slug, published').single();
  if (error) throw error;
  res.json({ ok: true, friend: data });
}
