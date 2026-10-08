-- Dropbox → Supabase Storage image sync: storage bucket, bookkeeping tables, hourly schedule.
-- Run in Supabase → SQL editor AFTER schema.sql. Safe to re-run.
-- Before the schedule at the bottom will work, store two secrets in Vault (see the schedule section).

-- ---------- bucket ----------
-- Public: the website shows these photos and videos (≤ 50 MB each). Only the Edge Function (service role) can write.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('producer_images', 'producer_images', true, 52428800, array['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------- bookkeeping ----------
-- One row per image file copied from Dropbox. `version` is Dropbox's content hash (or rev), so unchanged
-- files are never downloaded again. Paths in storage include a short hash of the version, so a changed
-- photo gets a new URL and no browser or CDN keeps showing the old one.
create table if not exists dropbox_images (
  id bigint generated always as identity primary key,
  airtable_record_id text not null,
  dropbox_file_id text not null,          -- stable across renames and moves
  dropbox_path text not null,             -- path inside the producer's folder, used for ordering
  version text not null,
  storage_path text not null unique,
  bytes int,
  synced_at timestamptz not null default now(),
  missing_since timestamptz,              -- set when the file disappears from Dropbox (hidden from the site, kept in storage)
  unique (airtable_record_id, dropbox_file_id)
);
create index if not exists dropbox_images_record_idx on dropbox_images (airtable_record_id);

-- One row per Airtable producer that has (or had) a folder. Producers synced least recently go first.
create table if not exists dropbox_folders (
  airtable_record_id text primary key,
  producer_name text,
  folder text,
  last_synced_at timestamptz,
  last_error text,
  image_count int default 0
);

-- A log of every run, with counts and anything that needs a human (unmatched folders, skipped files, errors).
create table if not exists dropbox_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',  -- running | ok | partial | failed
  dry_run boolean not null default false,
  stats jsonb default '{}',
  issues jsonb default '[]'
);

-- Server-only: RLS on with no policies, so neither the anon key nor signed-in users can read or write these.
alter table dropbox_images enable row level security;
alter table dropbox_folders enable row level security;
alter table dropbox_sync_runs enable row level security;
revoke all on dropbox_images, dropbox_folders, dropbox_sync_runs from anon, authenticated;

-- ---------- food hover images ----------
-- Filled by dropbox-sync from the FOODS_DROPBOX_LINK folder: one row per image, named after its file ("Sumo citrus").
-- The website matches food names (English, Japanese or old romaji) against these. Public read, server-only write.
create table if not exists food_images (
  name text primary key,
  url text not null,
  updated_at timestamptz not null default now()
);
alter table food_images enable row level security;
drop policy if exists "Public can read food images" on food_images;
create policy "Public can read food images" on food_images for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on food_images from anon, authenticated;

-- ---------- Vault helpers (server only) ----------
-- Lets Edge Functions store/read one Vault secret (the Dropbox refresh token) with the service-role key.
-- Nobody else can execute them: not the public anon key, not signed-in users.
create or replace function private_set_secret(p_name text, p_value text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then perform vault.create_secret(p_value, p_name); else perform vault.update_secret(v_id, p_value); end if;
end $$;
create or replace function private_get_secret(p_name text) returns text
language sql stable security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name and p_name in ('dropbox_refresh_token');
$$;
create or replace function private_delete_secret(p_name text) returns void
language sql security definer set search_path = public, vault as $$
  delete from vault.secrets where name = p_name and p_name in ('dropbox_refresh_token');
$$;
revoke execute on function private_set_secret(text, text) from public, anon, authenticated;
revoke execute on function private_delete_secret(text) from public, anon, authenticated;
grant execute on function private_delete_secret(text) to service_role;
revoke execute on function private_get_secret(text) from public, anon, authenticated;
grant execute on function private_set_secret(text, text) to service_role;
grant execute on function private_get_secret(text) to service_role;

-- ---------- schedule (Supabase Cron) ----------
-- Needs two Vault secrets: `project_url` (https://<ref>.supabase.co) and `sync_secret` (same value as the SYNC_SECRET
-- Edge Function secret).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Every hour at :05 → Dropbox sync (copies images, writes Image URLs to Airtable, then refreshes the site).
select cron.unschedule('dropbox-image-sync') where exists (select 1 from cron.job where jobname = 'dropbox-image-sync');
select cron.schedule('dropbox-image-sync', '5 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/dropbox-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 10000)
$$);

-- Every 15 minutes → Airtable content (names, prefectures, Image URLs…) into the website's database.
select cron.unschedule('airtable-site-sync') where exists (select 1 from cron.job where jobname = 'airtable-site-sync');
select cron.schedule('airtable-site-sync', '*/15 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/airtable-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);

-- Useful checks:
--   select * from dropbox_sync_runs order by id desc limit 5;
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select status_code, content from net._http_response order by id desc limit 5;
