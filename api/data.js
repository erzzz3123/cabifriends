// GET /api/data → JavaScript that sets window.FRIENDS and window.PREFS for the page.
// Reads with the anon key, so row-level security guarantees only published Friends leave the database.
import { sbPublic, publicUrl } from '../lib/supabase.js';

const paras = (s) => (s || '').split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
const site = (u) => (u || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
const insta = (s) => { s = (s || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?].*$/, '').replace(/^@/, ''); return s ? '@' + s : ''; };

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  try {
    const sb = sbPublic();
    const [{ data: friends, error: e1 }, { data: prefs, error: e2 }] = await Promise.all([
      sb.from('friends').select('*, friend_images(path, caption, position)').eq('published', true).order('no', { nullsFirst: false }).order('id'),
      sb.from('prefectures').select('*').order('id'),
    ]);
    if (e1 || e2) throw e1 || e2;
    if (prefs.length !== 47) throw new Error(`expected 47 prefectures, got ${prefs.length} — run supabase/seed.sql`);
    const known = new Set(prefs.map((p) => p.slug));
    const FRIENDS = friends.filter((f) => known.has(f.prefecture)).map((f) => ({
      id: f.no ?? f.id, slug: f.slug, name_en: f.name_en, name_ja: f.name_ja || '', maker: f.maker || '',
      prefecture: f.prefecture, city: f.city || '', latitude: f.latitude, longitude: f.longitude,
      category: f.category || 'Producer', since: f.since || '', makes: f.makes || '',
      specialties: f.specialties || [], ingredients: f.ingredients || [], methods: f.methods || [], tags: f.tags || [],
      description: f.description || '', description_ja: f.description_ja || '',
      story: paras(f.story), story_ja: paras(f.story_ja), relationship_to_cabi: f.relationship_to_cabi || '',
      website: site(f.website), instagram: insta(f.instagram), works_with: [],
      images: (f.friend_images || []).sort((a, b) => a.position - b.position).map((i) => ({ src: publicUrl(i.path), caption: i.caption || f.name_en })),
    }));
    const PREFS = prefs.map((p) => ({ slug: p.slug, name_en: p.name_en, name_ja: p.name_ja, region: p.region, description: p.description, specialties: p.specialties || [], seasonal_foods: p.seasonal_foods || [] }));
    // Short CDN cache so approvals show up within a minute; stale copies are served while it refreshes.
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    res.status(200).send('window.FRIENDS=' + JSON.stringify(FRIENDS) + ';window.PREFS=' + JSON.stringify(PREFS) + ';');
  } catch (err) {
    console.error(err);
    // Empty response → the page falls back to the bundled /data.js
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send('/* api unavailable */');
  }
}
