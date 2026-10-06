# Cabi & Friends

Directory of the people, producers and places Cabi works with across Japan. Intended home: friends.cabifoods.com

## How it fits together
- **GitHub** stores this code. Every push to `main` redeploys on Vercel; pull requests get preview URLs.
- **Vercel** hosts the static site (`index.html`, `admin.html`) and the serverless API in `/api`. No build step.
- **Airtable** is the source of truth for producer information. It's copied into Supabase every hour.
- **Dropbox** holds the producer photo folders. An hourly Supabase Edge Function copies them into Supabase Storage
  and writes their public URLs back to Airtable ("Image URLs").
- **Supabase** is the website's database (a copy of Airtable + prefectures, submissions, admins), photo storage,
  staff sign-in and the hourly scheduler (Supabase Cron).

```
Dropbox folders ──(:05 hourly, Edge Function dropbox-sync)──▶ Storage `producer_images` ──URLs──▶ Airtable "Image URLs"
Airtable ──(:20 hourly, /api/sync-airtable)──▶ Supabase `friends` + `friend_images`
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
| `api/sync-airtable.js` | Hourly import Airtable → site database (names, prefectures, Image URLs…) |
| `supabase/functions/dropbox-sync/` | Edge Function: Dropbox folders → Storage `producer_images` → Airtable Image URLs |
| `supabase/dropbox.sql` | Bucket, sync bookkeeping tables, both hourly Cron jobs |
| `scripts/dropbox-auth.sh` | One-time Dropbox authorisation (gets the refresh token) |
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

## Dropbox image sync

### How producers and folders are matched
1. **Preferred:** paste the folder's Dropbox share link into the producer's **Image Dropbox folder** field in Airtable
   (Dropbox → folder → Share → Copy link). Links to folders in your own Dropbox (`dropbox.com/home/…`) work too.
2. **Fallback:** keep one subfolder per producer under a single parent folder, set as `DROPBOX_ROOT_PATH`
   (e.g. `/Cabi & Friends/Producers`). A subfolder matches when its name equals the producer's name, its Japanese
   name in brackets, or contains the Airtable record ID (`recXXXXXXXXXXXXXX`). Ambiguous or unmatched folders are
   listed in the run report, never guessed.

Inside a folder: images in subfolders are included, ordered by file name (`01.jpg`, `02.jpg`, … — the first is the
cover). Anything whose name starts with `_` (e.g. a `_rejects` folder) is ignored. iPhone HEIC photos are converted.
Images are stored as 2048 px JPEGs at `producer_images/<Airtable record ID>/…` — the record ID never changes, so
renaming a producer doesn't re-upload anything. (`IMAGE_MODE=original` stores the original files instead.)

### What a sync does
- **New or edited photos** are copied. Unchanged ones (same Dropbox content hash) are skipped, so an hourly run
  usually downloads nothing. An edited photo gets a new URL, so no browser shows the old one.
- **Deleted photos** disappear from the site at the next run but stay in storage for 7 days (`DELETE_AFTER_DAYS`).
  Put the file back within that time and it's restored without re-uploading.
- **Safety:** if a folder can't be read (link revoked, folder moved, Dropbox down), that producer is skipped and
  nothing is hidden. If a folder that had photos suddenly reads as empty, its photos are kept and it's reported.
- Only the **Image URLs** field in Airtable is written, and only when the list changed.
- Each run stops starting new downloads before the Edge Function time limit; the next run continues. The first
  sync of many large folders may take a few runs.
- Every run is logged: `select * from dropbox_sync_runs order by id desc limit 5;` (`issues` lists anything to fix).

### Setup — step by step
Where each credential goes (none of them ever go in this repo or in browser code):

| Credential | Where you enter it |
|---|---|
| Dropbox app key, app secret, refresh token | Supabase → **Edge Functions → Secrets** (the script does it) |
| Airtable token for the image sync (read + write) | Supabase → **Edge Functions → Secrets** |
| `DROPBOX_SYNC_SECRET` | Supabase → Edge Functions → Secrets **and** Supabase → Vault (as `dropbox_sync_secret`) |
| Airtable token for the website (read only) | Vercel → Settings → **Environment Variables** |
| `CRON_SECRET` | Vercel env vars **and** Supabase → Vault (as `cron_secret`) |

**1. Create the Dropbox app** (5 min)
1. Go to <https://www.dropbox.com/developers/apps> → **Create app** → *Scoped access* → *Full Dropbox*
   (needed to read your folders; the app gets read-only permissions below) → name it e.g. `cabi-friends-image-sync`.
2. **Permissions** tab → tick `files.metadata.read`, `files.content.read`, `sharing.read` → **Submit**.
   Do this *before* step 2 — permissions are fixed into the token when you authorise.
3. **Settings** tab → note the **App key**; click *Show* for the **App secret**. No redirect URI is needed.
   Leave the app in *Development* status — that's fine for your own account.

**2. Install the Supabase CLI and link the project** (once, on your Mac)
```bash
brew install supabase/tap/supabase
```
```bash
supabase login && supabase link --project-ref YOUR-PROJECT-REF
```
(The project ref is the `xxxx` in `https://xxxx.supabase.co`.)

**3. Authorise Dropbox** — the script asks for the key and secret (hidden input), opens Dropbox's *Allow* page, then
stores the key, secret and a long-lived **refresh token** as Supabase secrets. Nothing is saved to disk.
```bash
bash scripts/dropbox-auth.sh
```
The function swaps the refresh token for a short-lived access token on every run. It keeps working until someone
disconnects the app in Dropbox → Settings → Connected apps (then just run the script again).

**4. Create an Airtable token for the sync** — <https://airtable.com/create/tokens> → *Create token* → name
`dropbox-image-sync`, scopes `data.records:read` + `data.records:write`, access: **only** the Cabi & Friends base.
Make a second token for the website with `data.records:read` only. Two tokens = each can be revoked on its own.

**5. Store the remaining function secrets** — in Supabase → Edge Functions → Secrets → *Add new secret*:
- `AIRTABLE_TOKEN` = the sync token from step 4
- `AIRTABLE_BASE_ID` = `appdjYvUXMIWAs9go`
- `DROPBOX_SYNC_SECRET` = a long random string (e.g. from `openssl rand -hex 32`)
- optional: `DROPBOX_ROOT_PATH` (fallback parent folder), `DELETE_AFTER_DAYS`, `IMAGE_MODE`,
  `DROPBOX_TEAM_ROOT_NAMESPACE` (only for Dropbox Business team folders)

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions automatically.)

**6. Deploy the function**
```bash
supabase functions deploy dropbox-sync
```
`supabase/config.toml` turns off JWT checking for this function because it checks `DROPBOX_SYNC_SECRET` instead.

**7. Create the bucket, tables and hourly schedule** — first add four secrets in Supabase →
**Integrations → Vault → Add new secret** (the UI, so they don't end up in SQL editor history):
`project_url` = `https://YOUR-PROJECT-REF.supabase.co`, `dropbox_sync_secret` = same as step 5,
`site_url` = `https://friends.cabifoods.com`, `cron_secret` = same as `CRON_SECRET` in Vercel.
Then run `supabase/dropbox.sql` in the SQL editor.

**8. Dry run, then a real run** — dry run lists folders and reports what *would* change, writing nothing:
```bash
read -rs -p "DROPBOX_SYNC_SECRET: " S; echo; curl -sS -X POST "https://YOUR-PROJECT-REF.supabase.co/functions/v1/dropbox-sync" -H "Authorization: Bearer $S" -H "Content-Type: application/json" -d '{"dry_run":true}'; unset S
```
Check the report with `select status, stats, issues from dropbox_sync_runs order by id desc limit 1;`.
Run again without `"dry_run":true` (or wait for :05), then check Airtable's **Image URLs** column.
After :20 (or *Sync from Airtable* in /admin → Producers) the photos are on the website.

**9. Vercel** — add `AIRTABLE_TOKEN` (the read-only one), `AIRTABLE_BASE_ID` and `CRON_SECRET`, then redeploy.

### Airtable → website
`/api/sync-airtable` copies these fields (by field ID, so renaming columns is safe): Place / 工房名 →
names (`Name (日本語)` is split into EN + JA), Craftsperson → maker, Craft / 分野 → makes + tags, Prefecture,
Website (Instagram links go to Instagram), Feature # → number, Image URLs → photos. Email and Contact status are
never read. Rows whose name starts with a bracket — `(Placeholder) …` — are treated as notes and skipped.
New producers arrive as drafts; publish them in /admin → Producers (or set `AIRTABLE_PUBLISHED_FIELD` to a
checkbox's field ID to control it from Airtable). Descriptions and map coordinates are set in /admin for now
because the Airtable table has no columns for them. Producers removed from Airtable are unpublished, not deleted.
