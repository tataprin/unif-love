-- Schema for the Unif love site: two collections of memories (the book, the wall),
-- gated behind a single shared login (see auth setup done separately via the admin API).

create extension if not exists pgcrypto;

create table if not exists public.book (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'image' check (kind in ('image','video')),
  storage_path text not null,
  content_type text,
  caption text not null default '',
  fit text not null default 'cover' check (fit in ('cover','contain')),
  scale numeric not null default 1,
  pos_x numeric not null default 50,
  pos_y numeric not null default 50,
  created_at timestamptz not null default now()
);

create table if not exists public.board (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'image' check (kind in ('image','video')),
  storage_path text not null,
  content_type text,
  caption text not null default '',
  x numeric not null default 0,
  y numeric not null default 0,
  w numeric not null default 200,
  rot numeric not null default 0,
  z integer not null default 1,
  created_at timestamptz not null default now()
);

alter table public.book enable row level security;
alter table public.board enable row level security;

drop policy if exists "authenticated full access" on public.book;
create policy "authenticated full access" on public.book
  for all
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

drop policy if exists "authenticated full access" on public.board;
create policy "authenticated full access" on public.board
  for all
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

alter publication supabase_realtime add table public.book;
alter publication supabase_realtime add table public.board;

-- private bucket for the actual photo/video files
insert into storage.buckets (id, name, public)
values ('memories', 'memories', false)
on conflict (id) do nothing;

drop policy if exists "memories: authenticated read" on storage.objects;
create policy "memories: authenticated read" on storage.objects
  for select
  using (bucket_id = 'memories' and (select auth.uid()) is not null);

drop policy if exists "memories: authenticated write" on storage.objects;
create policy "memories: authenticated write" on storage.objects
  for insert
  with check (bucket_id = 'memories' and (select auth.uid()) is not null);

drop policy if exists "memories: authenticated update" on storage.objects;
create policy "memories: authenticated update" on storage.objects
  for update
  using (bucket_id = 'memories' and (select auth.uid()) is not null);

drop policy if exists "memories: authenticated delete" on storage.objects;
create policy "memories: authenticated delete" on storage.objects
  for delete
  using (bucket_id = 'memories' and (select auth.uid()) is not null);
