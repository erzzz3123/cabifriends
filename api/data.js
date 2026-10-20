// GET /api/data → JavaScript that sets window.FRIENDS and window.PREFS for the page.
// Reads with the anon key, so row-level security guarantees only published Friends leave the database.
import { loadSiteData } from '../lib/data.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  try {
    const { FRIENDS, PREFS, FOOD_DROPBOX } = await loadSiteData();
    // Short CDN cache so approvals show up within a minute; stale copies are served while it refreshes.
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    res.status(200).send('window.FRIENDS=' + JSON.stringify(FRIENDS) + ';window.PREFS=' + JSON.stringify(PREFS) + ';window.FOOD_DROPBOX=' + JSON.stringify(FOOD_DROPBOX) + ';');
  } catch (err) {
    console.error(err);
    // Empty response → the page falls back to the bundled /data.js
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send('/* api unavailable */');
  }
}
