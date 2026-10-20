// GET /sitemap.xml → every page in English and Japanese (?lang=ja), with hreflang pairs.
import { loadSiteData } from '../lib/data.js';

const SITE = (process.env.SITE_URL || 'https://cabifriends.vercel.app').replace(/\/$/, '');
const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export default async function handler(req, res) {
  try {
    const { FRIENDS, PREFS } = await loadSiteData();
    const paths = ['/', '/map', '/about', '/submit', ...FRIENDS.map((f) => '/friend/' + f.slug), ...PREFS.map((p) => '/pref/' + p.slug)];
    const url = (p, ja) => SITE + p + (ja ? '?lang=ja' : '');
    const entry = (p, ja) => `<url><loc>${x(url(p, ja))}</loc><xhtml:link rel="alternate" hreflang="en" href="${x(url(p))}"/><xhtml:link rel="alternate" hreflang="ja" href="${x(url(p, true))}"/><xhtml:link rel="alternate" hreflang="x-default" href="${x(url(p))}"/></url>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${paths.flatMap((p) => [entry(p), entry(p, true)]).join('\n')}\n</urlset>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('sitemap unavailable');
  }
}
