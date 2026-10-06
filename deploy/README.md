# Cabi & Friends

Directory of the people, producers and places Cabi works with across Japan. Intended home: friends.cabifoods.com

## How it fits together
- **GitHub** stores this code. Every push to `main` redeploys.
- **Vercel** hosts the site (`index.html` + static files) and the API in `/api`.
- **Supabase** is the database (Friends, prefectures, submissions) and stores photos (Storage buckets `friends` and `submissions`).
- **Airtable** stays the team's editing sheet. `/api/sync-airtable` copies it into Supabase every 15 minutes, including photo attachments.

The page loads live data from `/api/data`. If that fails it falls back to the bundled `data.js`, so the site never shows empty.

## Setup (one time)
1. **Supabase**: create a project → SQL editor → run `supabase/schema.sql`, then `supabase/seed.sql`.
2. **Vercel**: Add New → Project → import `erzzz3123/cabifriends`. Framework preset: *Other*. No build command.
3. In Vercel → Settings → Environment Variables, add everything from `.env.example`.
4. Redeploy. Check `/api/data` returns `window.FRIENDS=…`.
5. Domain: Vercel → Settings → Domains → add `friends.cabifoods.com`, then add the CNAME record it shows wherever cabifoods.com DNS is managed.

## Airtable columns the sync reads
Name, Japanese name, Slug (optional), No, Maker, Prefecture, City, Latitude, Longitude, Category, Since, Makes,
Specialties, Ingredients, Methods, Tags (comma-separated or multi-select), Description, Story, Why Cabi, Website,
Instagram, Photos (attachments), **Published** (checkbox — only ticked rows appear on the site).
Rename the keys in `api/sync-airtable.js` if your sheet uses different headings.

Submissions also need a **Submissions** table in Airtable with: Name, Business, Japanese name, Category, City,
Prefecture, Makes, Story, Website, Instagram, Email, Submitted by, Supabase ID, Photos (number).

## Security
- The Supabase service-role key and Airtable token live only in Vercel environment variables. Never commit `.env`.
- All tables have row-level security on with no public policies; only the API can read or write.
- Submitted photos go to a private bucket.
