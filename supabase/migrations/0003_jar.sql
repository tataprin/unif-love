-- The virtual memory jar: little notes either of us writes and drops in,
-- kept forever with the date they were sent.

create table if not exists public.jar (
  id uuid primary key default gen_random_uuid(),
  author text not null check (author in ('unif','tata')),
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.jar enable row level security;

drop policy if exists "authenticated full access" on public.jar;
create policy "authenticated full access" on public.jar
  for all
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

alter publication supabase_realtime add table public.jar;
