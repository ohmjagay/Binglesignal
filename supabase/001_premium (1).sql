-- =====================================================================
-- BingleSignal premium layer: 7-day trial, Lite/Pro plans, paywall rules
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste ALL -> Run.
-- Safe to run twice. It never touches your existing table bs_profiles.
-- =====================================================================

-- 1) The two plans and what each unlocks (change numbers HERE, not in code)
-- Lite = "Signal Desk" in your thesis doc (finite briefing), Pro = "Daily Mix" (endless mix + alerts + prep + deep dives).
create table if not exists public.plans (
  id text primary key check (id in ('lite','pro')),
  name text not null,
  read_cap int not null,                      -- READ list length: Lite is finite, Pro is the big mix
  watch_cap int not null,
  infinite_mix boolean not null default false,
  max_interests int not null,
  max_geos int not null,
  history_days int not null,                  -- archive-search window
  why_lines boolean not null default true,    -- "why it matters / do next" under each story
  alerts boolean not null default false,
  meeting_prep boolean not null default false,
  deep_dives_per_month int not null default 0,
  digest text not null default 'daily'
);
insert into public.plans (id,name,read_cap,watch_cap,infinite_mix,max_interests,max_geos,history_days,why_lines,alerts,meeting_prep,deep_dives_per_month,digest) values
  ('lite','Lite',40,8,false,56,20,30,true,false,false,0,'daily'),
  ('pro','Pro',200,30,true,56,20,365,true,true,true,3,'daily+weekly')
on conflict (id) do update set name=excluded.name, read_cap=excluded.read_cap, watch_cap=excluded.watch_cap,
  infinite_mix=excluded.infinite_mix, max_interests=excluded.max_interests, max_geos=excluded.max_geos,
  history_days=excluded.history_days, why_lines=excluded.why_lines, alerts=excluded.alerts,
  meeting_prep=excluded.meeting_prep, deep_dives_per_month=excluded.deep_dives_per_month, digest=excluded.digest;
alter table public.plans enable row level security;
drop policy if exists "anyone reads plans" on public.plans;
create policy "anyone reads plans" on public.plans for select using (true);

-- 2) One subscription row per user (written ONLY by the server / payment webhooks)
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  plan text not null default 'pro' references public.plans(id),
  status text not null default 'trialing' check (status in ('trialing','active','past_due','canceled','expired')),
  trial_ends_at timestamptz not null default (now() + interval '7 days'),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  provider text check (provider in ('razorpay','global','manual')),
  provider_customer_id text,
  provider_subscription_id text,
  currency text check (currency in ('INR','USD')),
  founding_member boolean not null default false,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_email_idx on public.subscriptions (lower(email));
create unique index if not exists subscriptions_provider_sub_uidx
  on public.subscriptions (provider, provider_subscription_id) where provider_subscription_id is not null;
alter table public.subscriptions enable row level security;
drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription" on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
-- (no insert/update/delete policy on purpose: users can never edit their own plan)

-- 3) Every new signup automatically gets a 7-day Pro trial
create or replace function public.handle_new_user_subscription() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscriptions (user_id, email) values (new.id, lower(new.email)) on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created_subscription on auth.users;
create trigger on_auth_user_created_subscription after insert on auth.users
  for each row execute function public.handle_new_user_subscription();

-- 3b) People who signed up BEFORE launch: trial runs to launch + 7 days (8 Nov 2026, 03:00 IST) and
--     they are flagged as founding members. Edit the date/flag if you prefer.
insert into public.subscriptions (user_id, email, trial_ends_at, founding_member)
select id, lower(email), timestamptz '2026-11-08 03:00:00+05:30', true from auth.users
on conflict (user_id) do nothing;

-- 4) The ONE place that decides who has access (no cron job needed: it is computed live)
create or replace function public._access_for(uid uuid)
returns table (eff_status text, plan_id text, has_access boolean, trial_ends_at timestamptz, current_period_end timestamptz, days_left int)
language sql stable security definer set search_path = public as $$
  with e as (
    select s.*, case
      when s.status = 'trialing' and s.trial_ends_at <= now() then 'expired'
      when s.status = 'active'   and s.current_period_end is not null and s.current_period_end + interval '2 days' <= now() then 'expired'
      when s.status = 'past_due' and coalesce(s.current_period_end, s.trial_ends_at) + interval '3 days' <= now() then 'expired'
      when s.status = 'canceled' and coalesce(s.current_period_end, '-infinity'::timestamptz) <= now() then 'expired'
      else s.status end as eff
    from public.subscriptions s where s.user_id = uid)
  select e.eff, e.plan, e.eff in ('trialing','active','past_due','canceled'), e.trial_ends_at, e.current_period_end,
    greatest(0, ceil(extract(epoch from (case when e.eff = 'trialing' then e.trial_ends_at else coalesce(e.current_period_end, now()) end) - now()) / 86400))::int
  from e
$$;

-- What the website calls after login:  POST /rest/v1/rpc/my_access
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_build_object('status', a.eff_status, 'plan', a.plan_id, 'has_access', a.has_access,
      'trial_ends_at', a.trial_ends_at, 'current_period_end', a.current_period_end, 'days_left', a.days_left,
      'features', case when a.has_access then to_jsonb(p) - 'id' - 'name' else null end)
    from public._access_for(auth.uid()) a join public.plans p on p.id = a.plan_id),
    jsonb_build_object('status','none','plan',null,'has_access',false,'features',null))
$$;

-- Used inside database rules: returns 'none' | 'lite' | 'pro'
create or replace function public.access_level() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select case when a.has_access then a.plan_id else 'none' end from public._access_for(auth.uid()) a), 'none')
$$;

revoke all on function public._access_for(uuid) from public, anon, authenticated;
revoke all on function public.my_access() from public, anon;
revoke all on function public.access_level() from public, anon;
grant execute on function public.my_access() to authenticated;
grant execute on function public.access_level() to authenticated;

-- 5) The "judgment layer": why-it-matters / do-next lines. The pipeline (service key) writes ONE row per
--    story ("summarise once, rank per user"); Lite, Pro and trial users can read it.
create table if not exists public.story_notes (
  story_id text primary key,                  -- = the story cluster id "c" used in feed.json / pool.json
  edition_at timestamptz not null default now(),
  why_it_matters text not null,
  do_next text,
  source_count int not null default 1,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.story_notes enable row level security;
drop policy if exists "paid readers read story_notes" on public.story_notes;
create policy "paid readers read story_notes" on public.story_notes for select to authenticated
  using ((select public.access_level()) in ('lite','pro'));

-- Pro-only tool: watchlists (alerts are matched against these by the pipeline)
create table if not exists public.watchlists (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('company','keyword','regulator','person')),
  term text not null check (char_length(term) between 2 and 80),
  created_at timestamptz not null default now(),
  unique (user_id, kind, term)
);
alter table public.watchlists enable row level security;
drop policy if exists "pro manages own watchlist" on public.watchlists;
create policy "pro manages own watchlist" on public.watchlists for all to authenticated
  using (user_id = (select auth.uid()) and (select public.access_level()) = 'pro')
  with check (user_id = (select auth.uid()) and (select public.access_level()) = 'pro');

-- 6) Funnel events (trial_start, brief_opened, paywall_seen, checkout_started ...) and webhook log
create table if not exists public.events (
  id bigint generated always as identity primary key,
  user_id uuid default auth.uid() references auth.users(id) on delete set null,
  name text not null check (char_length(name) <= 40),
  props jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.events enable row level security;
drop policy if exists "insert own events" on public.events;
create policy "insert own events" on public.events for insert to authenticated with check (user_id = (select auth.uid()));

create table if not exists public.webhook_events (
  id text primary key, provider text not null, type text, received_at timestamptz not null default now());
alter table public.webhook_events enable row level security;   -- no policy = server only
