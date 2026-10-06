-- Paste into Supabase → SQL editor → Run.

create table if not exists prefectures (
  id int primary key, slug text unique not null, name_en text not null, name_ja text not null, region text not null,
  description text, specialties text[] default '{}', seasonal_foods text[] default '{}'
);

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

create table if not exists friend_images (
  id bigint generated always as identity primary key,
  friend_id bigint references friends(id) on delete cascade, path text unique not null, caption text, position int default 0
);

create table if not exists submissions (
  id bigint generated always as identity primary key, created_at timestamptz default now(),
  name text, business text, name_ja text, category text, city text, prefecture text, makes text, story text,
  website text, instagram text, email text, who text, lang text, photo_paths text[] default '{}', status text default 'new'
);

-- Lock everything down: only the server (service role key) can read/write.
alter table prefectures enable row level security;
alter table friends enable row level security;
alter table friend_images enable row level security;
alter table submissions enable row level security;

-- Storage: public bucket for published photos, private bucket for submitted photos.
insert into storage.buckets (id, name, public) values ('friends', 'friends', true) on conflict do nothing;
insert into storage.buckets (id, name, public) values ('submissions', 'submissions', false) on conflict do nothing;
