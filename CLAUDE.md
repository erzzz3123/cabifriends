# Cabi & Friends — notes for Claude Code

Read `HANDOFF.md` first (design spec), then `README.md` (infra setup).

## What this is
Editorial directory of people, producers and food culture across Japan. Static site + Vercel serverless API + Supabase. **Airtable is the source of truth** for producer info (synced into Supabase every 15 min by the `airtable-sync` Edge Function). Photos live in a Dropbox **App folder** app (one folder only); the `dropbox-sync` Edge Function copies them to Storage `producer_images` and writes URLs to Airtable "Image URLs". Public submissions are reviewed at `/admin`.

## Layout
- `app.html` — the whole front end (vanilla JS, history router with real URLs, inline CSS). Views: Directory (list/grid), Map, Friend profile, Prefecture guide, About, Get in touch. Served through `api/page.js`, never directly.
- `api/page.js` + `lib/seo.js` — every page URL (`/`, `/map`, `/friend/:slug`, `/pref/:slug`, `/about`, `/submit`) is rewritten here (vercel.json). It injects that page's title/description, canonical + hreflang (English, `?lang=ja` Japanese), Open Graph, JSON-LD, Google Analytics (env `GA_MEASUREMENT_ID`) and readable text into app.html. `/sitemap.xml` → `api/sitemap.js`. Env `SITE_URL` sets the canonical domain.
- `lib/data.js` — loads published Friends + prefectures (used by `/api/data` and `/api/page`).
- `data.js` — bundled fallback data (`window.FRIENDS`, `window.PREFS`, `REGIONS`, `FAMILIES`). Live data comes from `/api/data`, same shape.
- `i18n.js` — Japanese strings (`JA_TERMS`, `JA_DESC`). UI copy uses inline `T(en, ja)`.
- `admin.html` — staff review/approval screen (`/admin`, Supabase magic-link sign-in).
- `api/data.js` (public, anon key + RLS) · `api/submit.js` · `api/admin.js` · `api/config.js` — Vercel functions. `lib/supabase.js` — `sbPublic()` / `sbAdmin()` clients + `adminFrom(req)`.
- `supabase/schema.sql`, `supabase/seed.sql` — DB. `supabase/dropbox.sql` — image-sync tables + Supabase Cron jobs.
- `supabase/functions/dropbox-sync/index.ts` — Deno Edge Function. Airtable is addressed by **field IDs** (table `tblG7x02MvbxqYPwF`); never request the Email/Contact status fields.
- `assets/` — logos, d3, topojson, `japan-topo.js` (47 prefectures), Friend photos. `fonts/`, `_ds/` — Ginto Light + design tokens.

## Rules
- Keep the visual system exactly as specified in HANDOFF.md (Ginto Light all-caps, white ground, Cabi Black `#432F29` ink, 1px rules, no shadows).
- Every user-facing string must exist in EN and JA.
- Never commit `.env`. Service keys live only in Vercel env vars. Public reads go through the anon key so RLS stays the guard; use `sbAdmin()` only where staff/server writes need it.
- `schema.sql` must stay re-runnable (idempotent).
- No build step today. Routes are real paths: `/`, `/map`, `/map/:pref`, `/friend/:slug`, `/pref/:slug`, `/about`, `/submit` (old `#/…` links are redirected in the browser). Add any new route to vercel.json rewrites, `lib/seo.js` and the app router. If you migrate to a framework, keep these URLs.

## Run locally
`npx vercel dev` (needs env vars from `.env.example`); it runs the rewrites and `api/page.js`. A plain static server can serve `app.html` for quick UI checks (it falls back to `data.js` when `/api/data` is unavailable), but path URLs need the rewrites.
