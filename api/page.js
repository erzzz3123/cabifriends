// Every public page (/, /map, /friend/:slug, /pref/:slug, /about, /submit) is served from here (see vercel.json rewrites).
// It sends app.html with that page's own title, description, canonical + hreflang (en / ?lang=ja), Open Graph,
// JSON-LD and readable text in <main>, so search engines and link previews see real content before any JavaScript runs.
// If anything fails, the plain app shell is sent and the page still works in the browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteDataOrSnapshot as loadSiteData } from '../lib/data.js';
import { renderPage } from '../lib/seo.js';

const SITE = (process.env.SITE_URL || 'https://cabifriends.vercel.app').replace(/\/$/, '');
const GA_ID = process.env.GA_MEASUREMENT_ID || '';
let shell, ja;
function load() {
  shell ||= readFileSync(join(process.cwd(), 'app.html'), 'utf8');
  if (!ja) { const w = {}; new Function('window', readFileSync(join(process.cwd(), 'i18n.js'), 'utf8'))(w); ja = w; }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    load();
    const pathname = String(req.query.__p || '/');
    const search = new URLSearchParams(req.query.lang ? { lang: String(req.query.lang) } : {}).toString();
    const data = await loadSiteData();
    const { status, html: page } = renderPage({ pathname, search, data, ja, shell, site: SITE, gaId: GA_ID, production: process.env.VERCEL_ENV === 'production' });
    // A few minutes at the edge; Airtable/approval changes appear within ~5 minutes, stale copies serve while refreshing.
    res.setHeader('Cache-Control', status === 200 ? 'public, s-maxage=300, stale-while-revalidate=86400' : 'public, s-maxage=60');
    // The page's data goes inline, so the browser doesn't wait on a separate /api/data request before drawing
    const j = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
    const inline = `<script>window.FRIENDS=${j(data.FRIENDS)};window.PREFS=${j(data.PREFS)};window.FOOD_DROPBOX=${j(data.FOOD_DROPBOX || {})};</script>`;
    const html = page.replace('<script src="/api/data"></script>', inline);
    res.status(status).send(html);
  } catch (err) {
    console.error(err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(shell || readFileSync(join(process.cwd(), 'app.html'), 'utf8'));
  }
}
