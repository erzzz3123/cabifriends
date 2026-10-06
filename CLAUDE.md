# Cabi & Friends — notes for Claude Code

Read `HANDOFF.md` first (design spec), then `README.md` (infra setup).

## What this is
Editorial directory of people, producers and food culture across Japan. Static site + Vercel serverless API + Supabase. **Airtable is the source of truth** for producer info (synced hourly into Supabase by `api/sync-airtable.js`). Photos live in Dropbox folders; the `dropbox-sync` Edge Function copies them to Storage `producer_images` and writes URLs to Airtable "Image URLs". Public submissions are reviewed at `/admin`.

## Layout
- `index.html` — the whole front end (vanilla JS, hash router, inline CSS). Views: Directory (list/grid), Map, Friend profile, About, Submit a Producer.
- `data.js` — bundled fallback data (`window.FRIENDS`, `window.PREFS`, `REGIONS`, `FAMILIES`). Live data comes from `/api/data`, same shape.
- `i18n.js` — Japanese strings (`JA_TERMS`, `JA_DESC`). UI copy uses inline `T(en, ja)`.
- `admin.html` — staff review/approval screen (`/admin`, Supabase magic-link sign-in).
- `api/data.js` (public, anon key + RLS) · `api/submit.js` · `api/admin.js` · `api/config.js` · `api/sync-airtable.js` — Vercel functions. `lib/supabase.js` — `sbPublic()` / `sbAdmin()` clients + `adminFrom(req)`.
- `supabase/schema.sql`, `supabase/seed.sql` — DB. `supabase/dropbox.sql` — image-sync tables + Supabase Cron jobs.
- `supabase/functions/dropbox-sync/index.ts` — Deno Edge Function. Airtable is addressed by **field IDs** (table `tblG7x02MvbxqYPwF`); never request the Email/Contact status fields.
- `assets/` — logos, d3, topojson, `japan-topo.js` (47 prefectures), Friend photos. `fonts/`, `_ds/` — Ginto Light + design tokens.

## Rules
- Keep the visual system exactly as specified in HANDOFF.md (Ginto Light all-caps, white ground, Cabi Black `#432F29` ink, 1px rules, no shadows).
- Every user-facing string must exist in EN and JA.
- Never commit `.env`. Service keys live only in Vercel env vars. Public reads go through the anon key so RLS stays the guard; use `sbAdmin()` only where staff/server writes need it.
- `schema.sql` must stay re-runnable (idempotent).
- No build step today. If you migrate to a framework (e.g. Next.js), preserve routes (`#/directory`, `#/map/:pref`, `#/friend/:slug`, `#/about`, `#/submit`) or redirect them.

## Run locally
`npx vercel dev` (needs env vars from `.env.example`). Or open `index.html` via any static server — it falls back to `data.js` when `/api/data` is unavailable.
