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
Dropbox app folder ──(:05 hourly, Edge Function dropbox-sync)──▶ Storage `producer_images` ──URLs──▶ Airtable "Image URLs"
Airtable ──(every 15 min, Edge Function airtable-sync)──▶ Supabase `friends` + `friend_images`
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
| `supabase/functions/dropbox-sync/` | Edge Function: Dropbox app folder → Storage `producer_images` → Airtable Image URLs |
| `supabase/functions/airtable-sync/` | Edge Function: Airtable → site database (every 15 min, and from /admin) |
| `supabase/functions/dropbox-connect/` | Edge Function: one-click Dropbox authorisation (token goes straight to Vault) |
| `supabase/dropbox.sql` | Bucket, sync bookkeeping tables, both hourly Cron jobs |
| `scripts/dropbox-connect-link.sh` | Prints a 30-minute Dropbox connect link |
| `scripts/set-secret.sh` | Sets one Edge Function secret with hidden input |
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

### Access is limited to one folder
The Dropbox app is an **App folder** app: Dropbox only lets it see `Dropbox › Apps › <app name>`, nothing else in the
account, and only with read permissions (`files.metadata.read`, `files.content.read`). The connection's refresh token is
stored encrypted in Supabase Vault (`dropbox_refresh_token`) and is only used inside the Edge Function.

### Folders and photos
- One subfolder per producer inside the app folder, named after the producer (`Yamada Seiyu`), its Japanese name in
  brackets (`秋田今野商店`) or containing its Airtable record ID (`recXXXXXXXXXXXXXX`). Unmatched or ambiguous folders
  are listed in the run report, never guessed. Airtable's "Image Dropbox folder" links are ignored in this mode.
- Photos are ordered by file name (`01.jpg`, `02.jpg`, …); the first is the cover. Subfolders inside a producer folder
  are included; anything starting with `_` (e.g. `_rejects`) is ignored. iPhone HEIC photos are converted.
- Stored as 2048 px JPEGs at `producer_images/<Airtable record ID>/…`, so renaming a producer never re-uploads anything.
- **Videos** (`.mp4`, `.m4v`, `.webm`, `.mov`) are copied exactly as they are — no compression — up to 50 MB each
  (larger ones are skipped and listed in the run report; export a smaller MP4). They share the photo list and order:
  name one `01-….mp4` to make it the cover. On the site they play muted and looping in the large views (directory
  panel, profile) and show their first frame in thumbnails, cards and previews.

### What a sync does
- **New or edited photos** are copied; unchanged ones (same Dropbox content hash) are skipped. An edited photo gets a
  new URL, so no browser shows the old one.
- **Deleted photos** disappear from the site at the next run but stay in storage for 7 days (`DELETE_AFTER_DAYS`);
  put one back in that time and it's restored without re-uploading.
- **Safety:** a folder that can't be read is skipped (nothing hidden); a folder that suddenly reads as empty keeps its
  photos and is reported.
- Only Airtable's **Image URLs** field is written, and only when the list changed. Then `airtable-sync` runs straight
  away so the site updates within a minute.
- Every run is logged: `select status, stats, issues from dropbox_sync_runs order by id desc limit 5;`

### Secrets (Supabase → Edge Functions → Secrets — none of these are in Vercel or the repo)
| Secret | What it is |
|---|---|
| `AIRTABLE_TOKEN` | Airtable personal access token, `data.records:read` + `data.records:write`, CABI & FRIENDS base only |
| `AIRTABLE_BASE_ID` | `appdjYvUXMIWAs9go` |
| `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` | From the Dropbox app's Settings tab |
| `DROPBOX_ROOT_PATH` | `/` — the app folder itself |
| `SYNC_SECRET` | Random; authorises Cron → functions. A copy lives in Vault as `sync_secret` |

Vault also holds `project_url` (used by the Cron jobs) and `dropbox_refresh_token` (written by the connect flow).
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions automatically.

### Setting it up from scratch
1. Run `supabase/schema.sql`, `supabase/seed.sql`, then `supabase/dropbox.sql` (SQL editor, or
   `supabase db query --linked -f <file>`).
2. Create the Vault secrets `project_url` and `sync_secret`, and the Edge Function secrets above
   (`bash scripts/set-secret.sh NAME` prompts with hidden input).
3. `supabase functions deploy --use-api` (deploys `dropbox-sync`, `airtable-sync`, `dropbox-connect`).
4. Dropbox: <https://www.dropbox.com/developers/apps> → Create app → *Scoped access* → **App folder**.
   Permissions: `files.metadata.read`, `files.content.read` → Submit. Settings → OAuth 2 → Redirect URIs →
   `https://<project-ref>.supabase.co/functions/v1/dropbox-connect` → Add. Put the App key/secret in Supabase.
5. `bash scripts/dropbox-connect-link.sh` → open the link signed in to the right Dropbox account → Allow.
   **Changing the app key/secret afterwards breaks the connection** — reconnect with a new link if you do.
6. Dry run: call `dropbox-sync` with body `{"dry_run":true}` and `Authorization: Bearer <SYNC_SECRET>`, then check
   `dropbox_sync_runs`. Body `{"disconnect":true}` revokes the Dropbox connection and deletes the token.

### Airtable → website
`airtable-sync` copies these fields (by field ID, so renaming columns is safe): Place / 工房名 → names
(`Name (日本語)` is split into EN + JA), Craftsperson → maker, Craft / 分野 → makes + tags, Prefecture,
Website (Instagram links go to Instagram), Feature # → number, Image URLs → photos. Email and Contact status are
never read. Rows whose name starts with a bracket — `(Placeholder) …` — are treated as notes and skipped, as are rows
without a recognisable prefecture (they're listed in the function's response). New producers arrive as drafts;
publish them in /admin → Producers (or set `AIRTABLE_PUBLISHED_FIELD` to a checkbox's field ID). Descriptions and
map coordinates are set in /admin because the Airtable table has no columns for them. Producers removed from
Airtable are unpublished, not deleted. Content edits reach the live site within ~15 minutes — no redeploy.

## Food pill images
Hovering a food pill (map drawer "Known for", filters, profiles) shows a small photo by the cursor.
Images live in `assets/foods/` and are listed in `assets/foods/foods.js` (`"Matcha": "matcha.jpg"`, keyed by the English
name used in `data.js`; Japanese labels are matched automatically). The current set is 129 public-domain / CC0
placeholder photos from Wikimedia Commons — sources in `assets/foods/CREDITS.md`. 51 foods have no image yet and simply
show nothing. To add or replace one: put a 240px JPEG (or a transparent PNG, shown uncropped) in `assets/foods/`
and add/update its line in `foods.js`.
