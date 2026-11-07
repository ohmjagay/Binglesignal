alter table public.subscriptions
  add column if not exists billing_interval text check (billing_interval in ('month', 'year')),
  add column if not exists gstin text;

create table if not exists public.payment_checkout_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  attempt_id uuid not null unique,
  provider text not null check (provider in ('razorpay', 'global')),
  plan text not null references public.plans(id),
  currency text not null check (currency in ('INR', 'USD')),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  gstin text,
  provider_subscription_id text,
  checkout_url text,
  state text not null check (state in ('creating', 'open', 'failed', 'completed')),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.payment_checkout_sessions enable row level security;
revoke all on table public.payment_checkout_sessions from public, anon, authenticated;
grant all on table public.payment_checkout_sessions to service_role;

create table if not exists public.billing_email_jobs (
  job_key text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  email_type text not null check (email_type in ('trial_day_1', 'trial_day_3', 'trial_day_5', 'trial_day_7', 'payment_failed')),
  due_at timestamptz not null,
  state text not null default 'pending' check (state in ('pending', 'sending', 'sent', 'failed')),
  attempts smallint not null default 0,
  provider_message_id text,
  status_code integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_email_jobs_due_idx
  on public.billing_email_jobs (state, due_at) where state in ('pending', 'failed');
alter table public.billing_email_jobs enable row level security;
revoke all on table public.billing_email_jobs from public, anon, authenticated;
grant all on table public.billing_email_jobs to service_role;

alter table public.webhook_events enable row level security;
revoke all on table public.webhook_events from public, anon, authenticated;
grant all on table public.webhook_events to service_role;

create or replace function public.reserve_payment_checkout(
  p_user_id uuid,
  p_attempt_id uuid,
  p_provider text,
  p_plan text,
  p_currency text,
  p_billing_interval text,
  p_gstin text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.payment_checkout_sessions%rowtype;
begin
  if exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user_id
      and (
        s.status in ('active', 'past_due')
        or (s.status = 'canceled' and s.current_period_end > now())
      )
  ) then
    return jsonb_build_object('state', 'already_subscribed');
  end if;

  insert into public.payment_checkout_sessions (
    user_id, attempt_id, provider, plan, currency, billing_interval, gstin,
    state, expires_at
  ) values (
    p_user_id, p_attempt_id, p_provider, p_plan, p_currency, p_billing_interval, p_gstin,
    'creating', p_expires_at
  )
  on conflict (user_id) do update set
    attempt_id = excluded.attempt_id,
    provider = excluded.provider,
    plan = excluded.plan,
    currency = excluded.currency,
    billing_interval = excluded.billing_interval,
    gstin = excluded.gstin,
    provider_subscription_id = null,
    checkout_url = null,
    state = 'creating',
    expires_at = excluded.expires_at,
    updated_at = now()
  where payment_checkout_sessions.expires_at <= now()
     or payment_checkout_sessions.state in ('failed', 'completed');

  select * into existing from public.payment_checkout_sessions s where s.user_id = p_user_id;
  if existing.attempt_id = p_attempt_id then
    return jsonb_build_object('state', 'reserved', 'attempt_id', p_attempt_id);
  end if;
  return jsonb_build_object(
    'state', existing.state,
    'provider', existing.provider,
    'checkout_url', existing.checkout_url,
    'provider_subscription_id', existing.provider_subscription_id,
    'expires_at', existing.expires_at
  );
end
$$;
revoke all on function public.reserve_payment_checkout(uuid, uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reserve_payment_checkout(uuid, uuid, text, text, text, text, text, timestamptz)
  to service_role;

create or replace function public.finish_payment_checkout(
  p_user_id uuid,
  p_attempt_id uuid,
  p_provider_subscription_id text,
  p_checkout_url text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payment_checkout_sessions
  set provider_subscription_id = p_provider_subscription_id,
      checkout_url = p_checkout_url,
      state = 'open',
      updated_at = now()
  where user_id = p_user_id and attempt_id = p_attempt_id and state = 'creating';
  return found;
end
$$;
revoke all on function public.finish_payment_checkout(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.finish_payment_checkout(uuid, uuid, text, text) to service_role;

create or replace function public.release_payment_checkout(p_user_id uuid, p_attempt_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.payment_checkout_sessions
  set state = 'failed', updated_at = now()
  where user_id = p_user_id and attempt_id = p_attempt_id and state = 'creating'
$$;
revoke all on function public.release_payment_checkout(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_payment_checkout(uuid, uuid) to service_role;

create or replace function public.apply_payment_webhook(
  p_event_key text,
  p_provider text,
  p_type text,
  p_user_id uuid,
  p_patch jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_count integer;
  updated_count integer;
  event_time timestamptz;
begin
  if not exists (select 1 from public.subscriptions s where s.user_id = p_user_id) then
    raise exception 'Payment event references an unknown user';
  end if;
  insert into public.webhook_events (id, provider, type)
  values (p_event_key, p_provider, p_type)
  on conflict (id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;

  event_time := nullif(p_patch->>'last_event_at', '')::timestamptz;
  update public.subscriptions s set
    plan = coalesce(p_patch->>'plan', s.plan),
    status = coalesce(p_patch->>'status', s.status),
    provider = coalesce(p_patch->>'provider', s.provider),
    provider_subscription_id = coalesce(p_patch->>'provider_subscription_id', s.provider_subscription_id),
    provider_customer_id = coalesce(p_patch->>'provider_customer_id', s.provider_customer_id),
    currency = coalesce(p_patch->>'currency', s.currency),
    billing_interval = coalesce(p_patch->>'billing_interval', s.billing_interval),
    gstin = coalesce(p_patch->>'gstin', s.gstin),
    current_period_end = coalesce(nullif(p_patch->>'current_period_end', '')::timestamptz, s.current_period_end),
    cancel_at_period_end = coalesce((p_patch->>'cancel_at_period_end')::boolean, s.cancel_at_period_end),
    last_event_at = coalesce(event_time, s.last_event_at),
    updated_at = now()
  where s.user_id = p_user_id
    and (event_time is null or s.last_event_at is null or s.last_event_at <= event_time);
  get diagnostics updated_count = row_count;

  update public.payment_checkout_sessions
  set state = 'completed', updated_at = now()
  where user_id = p_user_id and provider_subscription_id = p_patch->>'provider_subscription_id';

  if updated_count > 0 and p_type in ('payment.failed', 'subscription.pending', 'subscription.failed', 'subscription.on_hold') then
    insert into public.billing_email_jobs (job_key, user_id, email_type, due_at)
    values
      (p_event_key || ':dunning:now', p_user_id, 'payment_failed', now()),
      (p_event_key || ':dunning:2d', p_user_id, 'payment_failed', now() + interval '2 days'),
      (p_event_key || ':dunning:5d', p_user_id, 'payment_failed', now() + interval '5 days')
    on conflict (job_key) do nothing;
  end if;
  return true;
end
$$;
revoke all on function public.apply_payment_webhook(text, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_payment_webhook(text, text, text, uuid, jsonb) to service_role;
