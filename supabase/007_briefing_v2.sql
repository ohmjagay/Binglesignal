create table if not exists public.story_clusters (
  story_id text primary key,
  stories jsonb not null default '[]'::jsonb,
  embedding jsonb,
  source_tier smallint not null default 4 check (source_tier between 1 and 4),
  source_count integer not null default 1 check (source_count > 0),
  published_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists story_clusters_expires_published_idx
  on public.story_clusters (expires_at, published_at desc);
alter table public.story_clusters enable row level security;
revoke all on table public.story_clusters from public, anon, authenticated;
grant all on table public.story_clusters to service_role;

alter table public.story_notes
  add column if not exists headline text,
  add column if not exists summary text not null default '',
  add column if not exists category text not null default 'news',
  add column if not exists entities jsonb not null default '[]'::jsonb,
  add column if not exists confidence double precision not null default 0,
  add column if not exists source_ids jsonb not null default '[]'::jsonb;
revoke insert, update, delete on table public.story_notes from anon, authenticated;

create table if not exists public.user_profile_v2 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'other',
  industry text not null default '',
  region text not null default 'GL',
  timezone text not null default 'UTC',
  delivery_time time not null default '07:00',
  delivery_channel text not null default 'app' check (delivery_channel in ('app','email','telegram')),
  brief_length smallint not null default 10 check (brief_length in (5, 10, 15)),
  interests jsonb not null default '[]'::jsonb,
  interest_vector jsonb,
  learned_weights jsonb not null default '{}'::jsonb,
  blocked_topics text[] not null default '{}',
  muted_sources text[] not null default '{}',
  updated_at timestamptz not null default now(),
  check (extract(minute from delivery_time)::integer % 15 = 0)
);
alter table public.user_profile_v2 enable row level security;
revoke all on table public.user_profile_v2 from public, anon, authenticated;
grant all on table public.user_profile_v2 to service_role;

create table if not exists public.editions (
  slot_key text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'daily' check (kind in ('daily','midday','evening')),
  plan text not null check (plan in ('lite','pro')),
  local_date date not null,
  local_slot time not null,
  items jsonb not null default '[]'::jsonb,
  safely_ignore jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  opened_at timestamptz
);
create index if not exists editions_user_created_idx on public.editions (user_id, created_at desc);
alter table public.editions enable row level security;
revoke all on table public.editions from public, anon, authenticated;
grant all on table public.editions to service_role;

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  story_id text not null references public.story_clusters(story_id) on delete cascade,
  signal text not null check (signal in ('like','dislike','less_like','mute_source','open','dwell','save','share','skip')),
  source text,
  created_at timestamptz not null default now(),
  unique (user_id, story_id, signal)
);
create index if not exists feedback_user_created_idx on public.feedback (user_id, created_at desc);
alter table public.feedback enable row level security;
revoke all on table public.feedback from public, anon, authenticated;
grant all on table public.feedback to service_role;

create or replace function public.claim_due_edition_slots(p_now timestamptz default now())
returns table(user_id uuid, plan text, timezone text, local_date date, local_slot time, slot_key text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.user_profile_v2 (user_id)
  select s.user_id
  from public.subscriptions s
  where (s.status = 'trialing' and s.trial_ends_at > p_now)
     or (s.status = 'active' and (s.current_period_end is null or s.current_period_end + interval '2 days' > p_now))
     or (s.status = 'past_due' and coalesce(s.current_period_end, s.trial_ends_at) + interval '3 days' > p_now)
     or (s.status = 'canceled' and s.current_period_end > p_now)
  on conflict (user_id) do nothing;

  return query
  with eligible as (
    select s.user_id, s.plan, p.timezone, p.delivery_time,
           p_now at time zone p.timezone as local_now
    from public.subscriptions s
    join public.user_profile_v2 p on p.user_id = s.user_id
    where s.plan in ('lite','pro')
      and ((s.status = 'trialing' and s.trial_ends_at > p_now)
        or (s.status = 'active' and (s.current_period_end is null or s.current_period_end + interval '2 days' > p_now))
        or (s.status = 'past_due' and coalesce(s.current_period_end, s.trial_ends_at) + interval '3 days' > p_now)
        or (s.status = 'canceled' and s.current_period_end > p_now))
      and p.timezone in (select name from pg_timezone_names)
  ), due as (
    select e.user_id, e.plan, e.timezone, e.local_now::date as edition_date,
           e.delivery_time as edition_time
    from eligible e
    where date_trunc('hour', e.local_now) +
          floor(extract(minute from e.local_now) / 15) * interval '15 minutes' =
          date_trunc('hour', e.local_now) +
          floor(extract(minute from e.delivery_time) / 15) * interval '15 minutes'
  )
  select d.user_id, d.plan, d.timezone, d.edition_date, d.edition_time,
         d.user_id::text || ':' || d.edition_date::text || ':' || to_char(d.edition_time, 'HH24MI')
  from due d
  where not exists (
    select 1 from public.editions e
    where e.slot_key = d.user_id::text || ':' || d.edition_date::text || ':' || to_char(d.edition_time, 'HH24MI')
  );
end $$;
revoke all on function public.claim_due_edition_slots(timestamptz) from public, anon, authenticated;
grant execute on function public.claim_due_edition_slots(timestamptz) to service_role;
