// GET /api/data → JavaScript that sets window.FRIENDS and window.PREFS for the page.
// Reads only published Friends; private fields never leave the server.
import { sb, publicUrl } from '../lib/supabase.js';

export default async function handler(req, res) {
  try {
    const [{ data: friends, error: e1 }, { data: prefs, error: e2 }] = await Promise.all([
      sb.from('friends').select('*, friend_images(path, caption, position)').eq('published', true).order('no'),
      sb.from('prefectures').select('*').order('id'),
    ]);
    if (e1 || e2) throw e1 || e2;
    const FRIENDS = friends.map((f) => ({
      id: f.no, slug: f.slug, name_en: f.name_en, name_ja: f.name_ja || '', maker: f.maker || '',
      prefecture: f.prefecture, city: f.city || '', latitude: f.latitude, longitude: f.longitude,
      category: f.category, since: f.since, makes: f.makes || '',
      specialties: f.specialties || [], ingredients: f.ingredients || [], methods: f.methods || [], tags: f.tags || [],
      description: f.description || '', story: f.story || '', relationship_to_cabi: f.relationship_to_cabi || '',
      website: f.website || '', instagram: f.instagram || '',
      images: (f.friend_images || []).sort((a, b) => a.position - b.position).map((i) => ({ src: publicUrl(i.path), caption: i.caption || f.name_en })),
    }));
    const PREFS = prefs.map((p) => ({ slug: p.slug, name_en: p.name_en, name_ja: p.name_ja, region: p.region, description: p.description, specialties: p.specialties || [], seasonal_foods: p.seasonal_foods || [] }));
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.status(200).send('window.FRIENDS=' + JSON.stringify(FRIENDS) + ';window.PREFS=' + JSON.stringify(PREFS) + ';');
  } catch (err) {
    console.error(err);
    // Empty response → the page falls back to the bundled /data.js
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.status(200).send('/* api unavailable */');
  }
}
