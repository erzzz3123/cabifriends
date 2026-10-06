-- Cabi & Friends — database schema, row-level security and storage.
-- Paste into Supabase → SQL editor → Run. Safe to re-run (every statement is idempotent).

-- ---------- tables ----------

create table if not exists prefectures (
  id int primary key, slug text unique not null, name_en text not null, name_ja text not null, region text not null,
  description text, specialties text[] default '{}', seasonal_foods text[] default '{}'
);

-- Producers ("Friends" in the UI).
create table if not exists friends (
  id bigint generated always as identity primary key,
  airtable_id text unique, slug text unique not null, no int,
  name_en text not null, name_ja text, maker text,
  prefecture text references prefectures(slug), city text, latitude double precision, longitude double precision,
  category text, since int, makes text,
  specialties text[] default '{}', ingredients text[] default '{}', methods text[] default '{}', tags text[] default '{}',
  description text, story text, relationship_to_cabi text, website text, instagram text,
  published boolean default false, updated_at timestamptz default now()
);
alter table friends
  add column if not exists description_ja text,
  add column if not exists story_ja text,
  add column if not exists source text not null default 'manual',   -- manual | submission | airtable
  add column if not exists submission_id bigint,
  add column if not exists created_at timestamptz not null default now();

create table if not exists friend_images (
  id bigint generated always as identity primary key,
  friend_id bigint references friends(id) on delete cascade, path text unique not null, caption text, position int default 0
);

-- Submit a Producer form. Never readable by the public.
create table if not exists submissions (
  id bigint generated always as identity primary key, created_at timestamptz default now(),
  name text, business text, name_ja text, category text, city text, prefecture text, makes text, story text,
  website text, instagram text, email text, who text, lang text, photo_paths text[] default '{}', status text default 'new'
);
alter table submissions
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text,
  add column if not exists review_note text,
  add column if not exists friend_id bigint references friends(id) on delete set null,
  add column if not exists ip_hash text,
  add column if not exists airtable_id text;

-- Staff who can review submissions in /admin. Add people with: insert into admins (email) values ('name@cabifoods.com');
create table if not exists admins (
  email text primary key check (email = lower(email)),
  created_at timestamptz default now()
);

-- ---------- constraints ----------

alter table friends drop constraint if exists friends_slug_format;
alter table friends add constraint friends_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
alter table friends drop constraint if exists friends_category_check;
alter table friends add constraint friends_category_check check (category is null or category in ('Producer','Farmer','Restaurant','Shop','Craft'));
alter table friends drop constraint if exists friends_source_check;
alter table friends add constraint friends_source_check check (source in ('manual','submission','airtable'));
alter table friends drop constraint if exists friends_coords_check;
alter table friends add constraint friends_coords_check check (
  (latitude is null or latitude between 20 and 46) and (longitude is null or longitude between 122 and 154));
alter table friends drop constraint if exists friends_submission_fk;
alter table friends add constraint friends_submission_fk foreign key (submission_id) references submissions(id) on delete set null;

alter table submissions drop constraint if exists submissions_status_check;
alter table submissions add constraint submissions_status_check check (status in ('new','approved','rejected'));
alter table submissions drop constraint if exists submissions_email_check;
alter table submissions add constraint submissions_email_check check (email is null or (char_length(email) <= 320 and email like '%_@_%'));

create index if not exists friends_published_idx on friends (published, no);
create index if not exists friends_prefecture_idx on friends (prefecture);
create index if not exists friend_images_friend_idx on friend_images (friend_id, position);
create index if not exists submissions_status_idx on submissions (status, created_at desc);
create index if not exists submissions_ip_idx on submissions (ip_hash, created_at desc);

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists friends_updated_at on friends;
create trigger friends_updated_at before update on friends for each row execute function set_updated_at();

-- ---------- row-level security ----------
-- Visitors (anon key) can read prefectures and *published* producers only.
-- Signed-in staff listed in `admins` can manage everything. The service-role key (server only) bypasses RLS.

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke execute on function is_admin() from public, anon;
grant execute on function is_admin() to authenticated;

alter table prefectures enable row level security;
alter table friends enable row level security;
alter table friend_images enable row level security;
alter table submissions enable row level security;
alter table admins enable row level security;

drop policy if exists "Public can read prefectures" on prefectures;
create policy "Public can read prefectures" on prefectures for select to anon, authenticated using (true);
drop policy if exists "Admins manage prefectures" on prefectures;
create policy "Admins manage prefectures" on prefectures for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists "Public can read published friends" on friends;
create policy "Public can read published friends" on friends for select to anon, authenticated using (published);
drop policy if exists "Admins manage friends" on friends;
create policy "Admins manage friends" on friends for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists "Public can read images of published friends" on friend_images;
create policy "Public can read images of published friends" on friend_images for select to anon, authenticated
  using (exists (select 1 from friends f where f.id = friend_images.friend_id and f.published));
drop policy if exists "Admins manage friend images" on friend_images;
create policy "Admins manage friend images" on friend_images for all to authenticated using (is_admin()) with check (is_admin());

-- No insert policy: the public form posts to /api/submit, which validates, rate-limits and writes with the service key.
drop policy if exists "Admins read submissions" on submissions;
create policy "Admins read submissions" on submissions for select to authenticated using (is_admin());
drop policy if exists "Admins update submissions" on submissions;
create policy "Admins update submissions" on submissions for update to authenticated using (is_admin()) with check (is_admin());

drop policy if exists "Users can see their own admin row" on admins;
create policy "Users can see their own admin row" on admins for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Belt and braces: the public role can never write, and never touch submissions or admins at all.
revoke insert, update, delete, truncate on prefectures, friends, friend_images from anon;
revoke all on submissions, admins from anon;

-- ---------- storage ----------
-- `friends`: public bucket for published photos. `submissions`: private bucket for photos sent with the form.
-- No storage policies are defined, so only the server (service key / signed URLs it issues) can write to either.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('friends', 'friends', true, 15728640, array['image/jpeg','image/png','image/webp','image/gif','image/avif']),
  ('submissions', 'submissions', false, 10485760, array['image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
