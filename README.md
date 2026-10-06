# Cabi & Friends

Directory of the people, producers and places Cabi works with across Japan. Intended home: friends.cabifoods.com

## How it fits together
- **GitHub** stores this code. Every push to `main` redeploys on Vercel; pull requests get preview URLs.
- **Vercel** hosts the static site (`index.html`, `admin.html`) and the serverless API in `/api`. No build step.
- **Supabase** is the database (producers, prefectures, submissions, admins), the photo storage, and staff sign-in.

```
visitor ──▶ index.html ──▶ /api/data ──(anon key, RLS: published only)──▶ Supabase
visitor ──▶ Submit form ──▶ /api/submit ──(service key)──▶ submissions table
                     └──── photos PUT straight to the private `submissions` bucket (signed URLs)
staff  ──▶ /admin (magic-link sign-in) ──▶ /api/admin ──▶ approve → producer row + photos copied to public `friends` bucket
```

The page loads live data from `/api/data`. If that fails it falls back to the bundled `data.js`, so the site never shows empty.

| Path | What it is |
|---|---|
| `index.html` | The whole public site (Directory, Map, Profile, About, Submit) |
| `admin.html` | Staff review screen at `/admin` |
| `api/data.js` | Published producers + prefectures as `window.FRIENDS` / `window.PREFS` (60 s CDN cache) |
| `api/submit.js` | Submit a Producer: validation, rate limit, signed photo uploads |
| `api/admin.js` | Approve / decline submissions, edit and publish producers |
| `api/config.js` | Public Supabase URL + anon key for the admin sign-in |
| `api/sync-airtable.js` | Optional one-way import from Airtable |
| `supabase/schema.sql` | Tables, constraints, row-level security, storage buckets (re-runnable) |
| `supabase/seed.sql` | 47 prefectures + the current 27 producers and their bundled photos |

## Setup (one time)

### 1. GitHub
Create an empty repo (e.g. `cabifoods/cabifriends`), then from this folder:
```bash
git remote add origin git@github.com:YOUR-ORG/cabifriends.git && git push -u origin main
```

### 2. Supabase
1. Create a project (region: Tokyo `ap-northeast-1`).
2. SQL editor → run `supabase/schema.sql`, then `supabase/seed.sql`.
3. Authentication → Sign In / Providers → **turn off "Allow new users to sign up"** (staff are invited, nobody signs up).
4. Authentication → URL Configuration → Site URL `https://friends.cabifoods.com`, and add redirect URLs
   `https://friends.cabifoods.com/admin`, `https://*.vercel.app/admin` and `http://localhost:3000/admin`.
5. For each staff member: Authentication → Users → **Invite user**, then in the SQL editor
   `insert into admins (email) values ('name@cabifoods.com');`
6. Project Settings → API: copy the URL, the `anon` public key and the `service_role` secret key.

### 3. Vercel
1. Add New → Project → import the GitHub repo. Framework preset: **Other**. No build command, no output directory.
2. Settings → Environment Variables: add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   (and optionally `SUBMIT_SECRET`) for Production and Preview. See `.env.example`.
3. Redeploy. Check that `/api/data` starts with `window.FRIENDS=[{` (not `/* api unavailable */`).
4. Domains → add `friends.cabifoods.com`, then add the CNAME it shows wherever cabifoods.com DNS is managed.

### Run locally
```bash
npm i -g vercel && npm install && vercel link && vercel env pull .env.local && vercel dev
```
Or serve the folder with any static server: everything works from `data.js` except submitting and `/admin`.

## Approval workflow
1. Someone fills in **Submit a Producer**. The submission is saved as `new`; photos go to the private bucket.
2. Staff open **/admin**, sign in with the emailed link, and pick a submission. The listing form is pre-filled
   from the submission: check names, prefecture, description (EN/JA), tags, and tick which photos to publish.
3. **Approve & publish** creates the producer and copies the ticked photos to the public bucket. It appears on the
   Directory and Map within a minute. **Approve as draft** saves it hidden; publish it later from the *Producers* tab.
   **Decline** keeps the submission under *Rejected* (it can be moved back).
4. The *Producers* tab lists everyone (published or not) for edits and publish / unpublish.

Producers without coordinates are placed at the centre of their prefecture on the map. Photo uploads and
deletions for existing producers are done in Supabase → Storage (`friends` bucket) + the `friend_images` table.

## Security
- **Row-level security is on for every table.** With the public anon key you can only *read* prefectures,
  published producers and their images. Submissions and the admin list are invisible to it, and it can't write anything.
- Staff access = a Supabase Auth user whose email is in the `admins` table (`is_admin()` in the policies, checked again in `/api/admin`).
- The service-role key lives only in Vercel env vars and is used only inside `/api`. Never commit `.env*`
  (`.gitignore` blocks it and the GitHub check fails if a key-shaped string is committed).
- Submissions: honeypot field, 5 per hour per visitor (IP hashed, never stored raw), server-side validation,
  photos limited to 6 images × 10 MB by the bucket itself, private until a staff member approves them.
- `/admin` is `noindex` and never cached.

## Optional: Airtable
The current Airtable base (`appdjYvUXMIWAs9go`) is an outreach tracker and isn't shaped for import, so the sync is
**off** by default and Supabase is the source of truth. To use Airtable as the editing sheet, create a table with
the columns below, set the `AIRTABLE_*` env vars, and press *Sync from Airtable* in /admin → Producers.
To run it automatically, add to `vercel.json` (Hobby plans allow one run per day; Pro allows e.g. `*/15 * * * *`):
```json
"crons": [{ "path": "/api/sync-airtable", "schedule": "0 3 * * *" }]
```
and set `CRON_SECRET`. Columns read: Name, Japanese name, Slug (optional), No, Maker, Prefecture, City, Latitude,
Longitude, Category, Since, Makes, Specialties, Ingredients, Methods, Tags, Description, Story, Why Cabi, Website,
Instagram, Photos (attachments), **Published** (checkbox). The sync only ever changes rows it created; producers
approved in /admin are never touched. Rows removed from Airtable are unpublished, not deleted.
Setting `AIRTABLE_SUBMISSIONS_TABLE` also copies each new submission into that table.
