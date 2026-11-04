-- BingleSignal email beta: invited users only, metadata-only mailbox sync, no message-body storage.
create table if not exists public.email_beta_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  timezone text not null default 'Asia/Kolkata',
  digest_time text not null default '07:00' check (digest_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  last_digest_local_date text,
  usage_date text,
  daily_messages integer not null default 0 check (daily_messages between 0 and 500),
  pending_messages integer not null default 0 check (pending_messages between 0 and 99),
  batch_sequence integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail','outlook')),
  provider_email text not null,
  encrypted_refresh_token text not null,
  cursor text,
  page_cursor text,
  window_start timestamptz,
  last_sync_at timestamptz,
  last_error text,
  enabled boolean not null default true,
  consented_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table if not exists public.email_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail','outlook')),
  encrypted_code_verifier text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.email_seen_messages (
  connection_id uuid not null references public.email_connections(id) on delete cascade,
  provider_message_id text not null,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (connection_id, provider_message_id)
);
create index if not exists email_seen_messages_created_idx
  on public.email_seen_messages (created_at);

create table if not exists public.email_jobs (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_after timestamptz not null default now(),
  attempts smallint not null default 0 check (attempts between 0 and 8),
  locked_until timestamptz,
  status text not null default 'pending' check (status in ('pending','failed')),
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists email_jobs_run_after_idx on public.email_jobs (run_after);

create table if not exists public.email_reports (
  report_key text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('batch','scheduled')),
  email_count integer not null check (email_count >= 0),
  report jsonb not null,
  delivery_status text not null default 'pending' check (delivery_status in ('pending','sent','failed','not_configured')),
  delivery_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists email_reports_user_created_idx
  on public.email_reports (user_id, created_at desc);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'email_beta_users',
    'email_connections',
    'email_oauth_states',
    'email_seen_messages',
    'email_jobs',
    'email_reports'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant all on table public.%I to service_role', table_name);
  end loop;
end $$;

create or replace function public.claim_email_beta_jobs(batch_limit integer default 5)
returns setof public.email_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select id
    from public.email_jobs
    where status = 'pending' and run_after <= now() and attempts < 8 and (locked_until is null or locked_until < now())
    order by run_after, created_at
    for update skip locked
    limit greatest(1, least(batch_limit, 5))
  )
  update public.email_jobs job
  set attempts = job.attempts + 1,
      locked_until = now() + interval '10 minutes'
  using due
  where job.id = due.id
  returning job.*
$$;
revoke all on function public.claim_email_beta_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_email_beta_jobs(integer) to service_role;
