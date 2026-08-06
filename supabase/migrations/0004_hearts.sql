-- The monthly "Love Battle": each of us taps to fill our own heart jar. One row
-- per calendar month holds both scores and that month's secret Memory-Jar password.
-- When the calendar month rolls over the client just starts writing to a new
-- month key, so the jars reset by themselves — no scheduled job needed. Old rows
-- stay behind as the history of who won each month.

create table if not exists public.heart_months (
  month text primary key,                 -- 'YYYY-MM' (the client's local month)
  password text not null,                 -- this month's random Memory-Jar password
  unif_hearts integer not null default 0,
  tata_hearts integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.heart_months enable row level security;

drop policy if exists "authenticated full access" on public.heart_months;
create policy "authenticated full access" on public.heart_months
  for all
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

alter publication supabase_realtime add table public.heart_months;

-- Atomically add hearts to one person's jar for a month, creating the month row
-- (with a fresh cute password) the first time anyone taps that month. Doing the
-- add server-side means two devices tapping at once never clobber each other's
-- count, and the password is minted exactly once per month.
create or replace function public.add_hearts(p_month text, p_author text, p_delta int)
returns public.heart_months
language plpgsql
as $$
declare
  rec public.heart_months;
  d int := greatest(coalesce(p_delta, 0), 0);
  pw text;
begin
  if p_author not in ('unif','tata') then
    raise exception 'author must be unif or tata';
  end if;

  pw := (array['honey','sweetie','cupcake','darling','sunshine',
               'cutie','sugarplum','mylove','pumpkin','babylove'])[floor(random()*10)+1]
        || (floor(random()*90)+10)::text;

  insert into public.heart_months (month, password, unif_hearts, tata_hearts)
  values (
    p_month, pw,
    case when p_author = 'unif' then d else 0 end,
    case when p_author = 'tata' then d else 0 end
  )
  on conflict (month) do update set
    unif_hearts = public.heart_months.unif_hearts + (case when p_author = 'unif' then d else 0 end),
    tata_hearts = public.heart_months.tata_hearts + (case when p_author = 'tata' then d else 0 end)
  returning * into rec;

  return rec;
end;
$$;
