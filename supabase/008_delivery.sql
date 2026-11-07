create table if not exists public.delivery_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_key text not null references public.editions(slot_key) on delete cascade,
  channel text not null check (channel in ('email', 'telegram')),
  status text not null check (status in ('sending', 'sent', 'failed')),
  provider_message_id text,
  status_code integer,
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (user_id, slot_key, channel)
);
create index if not exists delivery_logs_user_attempted_idx
  on public.delivery_logs (user_id, attempted_at desc);
alter table public.delivery_logs enable row level security;
revoke all on table public.delivery_logs from public, anon, authenticated;
grant all on table public.delivery_logs to service_role;

create table if not exists public.telegram_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_id text not null unique,
  linked_at timestamptz not null default now()
);
alter table public.telegram_connections enable row level security;
revoke all on table public.telegram_connections from public, anon, authenticated;
grant all on table public.telegram_connections to service_role;

create table if not exists public.telegram_link_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists telegram_link_codes_user_created_idx
  on public.telegram_link_codes (user_id, created_at desc);
alter table public.telegram_link_codes enable row level security;
revoke all on table public.telegram_link_codes from public, anon, authenticated;
grant all on table public.telegram_link_codes to service_role;

create or replace function public.claim_edition_delivery(
  p_user_id uuid,
  p_slot_key text,
  p_channel text,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed_id uuid;
begin
  insert into public.delivery_logs (user_id, slot_key, channel, status, attempted_at)
  values (p_user_id, p_slot_key, p_channel, 'sending', p_now)
  on conflict (user_id, slot_key, channel) do update
    set status = 'sending', attempted_at = excluded.attempted_at,
        status_code = null, provider_message_id = null, sent_at = null
    where public.delivery_logs.status = 'failed'
       or (public.delivery_logs.status = 'sending'
           and public.delivery_logs.attempted_at < p_now - interval '10 minutes')
  returning id into claimed_id;
  return claimed_id is not null;
end
$$;
revoke all on function public.claim_edition_delivery(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_edition_delivery(uuid, text, text, timestamptz) to service_role;

create or replace function public.consume_telegram_link_code(
  p_code_hash text,
  p_chat_id text,
  p_now timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  linked_user uuid;
begin
  select user_id into linked_user
  from public.telegram_link_codes
  where code_hash = p_code_hash
    and consumed_at is null
    and expires_at > p_now
  for update;
  if linked_user is null then return null; end if;

  update public.telegram_link_codes
  set consumed_at = p_now
  where code_hash = p_code_hash;
  insert into public.telegram_connections (user_id, chat_id, linked_at)
  values (linked_user, p_chat_id, p_now)
  on conflict (user_id) do update
    set chat_id = excluded.chat_id, linked_at = excluded.linked_at;
  return linked_user;
end
$$;
revoke all on function public.consume_telegram_link_code(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.consume_telegram_link_code(text, text, timestamptz) to service_role;

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
    select s.user_id, s.plan, p.timezone, p.delivery_time, p.delivery_channel,
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
    select e.user_id, e.plan, e.timezone, e.delivery_channel, e.local_now::date as edition_date,
           e.delivery_time as edition_time
    from eligible e
    where e.local_now >= date_trunc('day', e.local_now) + e.delivery_time
      and e.local_now < date_trunc('day', e.local_now) + e.delivery_time + interval '2 hours'
  )
  select d.user_id, d.plan, d.timezone, d.edition_date, d.edition_time,
         d.user_id::text || ':' || d.edition_date::text || ':' || to_char(d.edition_time, 'HH24MI')
  from due d
  where not exists (
    select 1 from public.editions e
    where e.slot_key = d.user_id::text || ':' || d.edition_date::text || ':' || to_char(d.edition_time, 'HH24MI')
      and (
        d.delivery_channel not in ('email','telegram')
        or exists (
          select 1 from public.delivery_logs l
          where l.user_id = d.user_id
            and l.slot_key = e.slot_key
            and l.channel = d.delivery_channel
            and (l.status = 'sent'
              or (l.status = 'sending' and l.attempted_at >= p_now - interval '10 minutes'))
        )
      )
  );
end
$$;
revoke all on function public.claim_due_edition_slots(timestamptz) from public, anon, authenticated;
grant execute on function public.claim_due_edition_slots(timestamptz) to service_role;
