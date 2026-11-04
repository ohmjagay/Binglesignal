-- Enables user-requested, capped summaries of email content.
alter table public.email_beta_users
  add column if not exists summary_usage_date text,
  add column if not exists summary_messages integer not null default 0
    check (summary_messages between 0 and 500);

create table if not exists public.email_summary_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.email_connections(id) on delete cascade,
  mode text not null check (mode in ('all','latest50','date_range')),
  date_from date,
  date_to date,
  max_messages integer not null check (max_messages between 1 and 500),
  processed_count integer not null default 0 check (processed_count between 0 and 500),
  provider_cursor text,
  partial_summaries jsonb not null default '[]'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  report jsonb,
  error text,
  attempts smallint not null default 0 check (attempts between 0 and 8),
  locked_until timestamptz,
  content_consented_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (mode = 'date_range' and date_from is not null and date_to is not null and date_from <= date_to)
    or (mode <> 'date_range' and date_from is null and date_to is null)
  )
);
create index if not exists email_summary_jobs_user_created_idx
  on public.email_summary_jobs (user_id, created_at desc);
create index if not exists email_summary_jobs_queue_idx
  on public.email_summary_jobs (status, locked_until, created_at);
create unique index if not exists email_summary_jobs_one_active_per_user_idx
  on public.email_summary_jobs (user_id)
  where status in ('queued','running');

alter table public.email_summary_jobs enable row level security;
revoke all on table public.email_summary_jobs from public, anon, authenticated;
grant all on table public.email_summary_jobs to service_role;

create or replace function public.claim_email_summary_jobs(batch_limit integer default 3)
returns setof public.email_summary_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select id
    from public.email_summary_jobs
    where status in ('queued','running')
      and attempts < 8
      and (locked_until is null or locked_until < now())
    order by created_at
    for update skip locked
    limit greatest(1, least(batch_limit, 3))
  )
  update public.email_summary_jobs job
  set status = 'running',
      attempts = job.attempts + 1,
      locked_until = now() + interval '10 minutes',
      updated_at = now()
  from due
  where job.id = due.id
  returning job.*
$$;
revoke all on function public.claim_email_summary_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_email_summary_jobs(integer) to service_role;

create or replace function public.advance_email_summary_job(
  p_job_id uuid,
  p_usage_date text,
  p_increment integer,
  p_provider_cursor text,
  p_partial_summaries jsonb,
  p_done boolean,
  p_report jsonb
)
returns setof public.email_summary_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.email_summary_jobs;
  current_usage integer;
  metadata_usage integer;
begin
  if p_increment < 0 or p_increment > 500 then
    raise exception 'invalid summary usage increment';
  end if;

  select * into current_job
  from public.email_summary_jobs
  where id = p_job_id and status = 'running'
  for update;
  if not found then
    raise exception 'summary job is not currently claimed';
  end if;

  update public.email_beta_users
  set summary_usage_date = case when summary_usage_date = p_usage_date then summary_usage_date else p_usage_date end,
      summary_messages = case when summary_usage_date = p_usage_date then summary_messages else 0 end
  where user_id = current_job.user_id;

  select summary_messages,
         case when usage_date = p_usage_date then daily_messages else 0 end
  into current_usage, metadata_usage
  from public.email_beta_users
  where user_id = current_job.user_id
  for update;
  if current_usage + metadata_usage + p_increment > 500 then
    raise exception 'daily email summary limit reached';
  end if;

  update public.email_beta_users
  set summary_messages = current_usage + p_increment,
      updated_at = now()
  where user_id = current_job.user_id;

  return query
  update public.email_summary_jobs
  set processed_count = processed_count + p_increment,
      provider_cursor = p_provider_cursor,
      partial_summaries = p_partial_summaries,
      status = case when p_done then 'completed' else 'queued' end,
      report = case when p_done then p_report else null end,
      error = null,
      locked_until = null,
      updated_at = now()
  where id = p_job_id
  returning *;
end $$;
revoke all on function public.advance_email_summary_job(uuid,text,integer,text,jsonb,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.advance_email_summary_job(uuid,text,integer,text,jsonb,boolean,jsonb) to service_role;
