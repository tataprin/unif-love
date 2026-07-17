-- Simple key/value store for small shared bits of site config, starting with
-- the editable message on the surprise-tab card.

create table if not exists public.settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.settings enable row level security;

drop policy if exists "authenticated full access" on public.settings;
create policy "authenticated full access" on public.settings
  for all
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

alter publication supabase_realtime add table public.settings;

insert into public.settings (key, value)
values ('card_message', 'I have something I want to ask you...')
on conflict (key) do nothing;
