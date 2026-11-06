-- attempts count failed claims, not successful pages through a large inbox.
create or replace function public.sweep_stuck_email_summary_jobs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  swept_count integer;
begin
  update public.email_summary_jobs
  set status = 'failed',
      error = 'stuck after 8 failed attempts',
      locked_until = null,
      updated_at = now()
  where status = 'running'
    and locked_until < now()
    and attempts >= 8;

  get diagnostics swept_count = row_count;
  return swept_count;
end $$;
revoke all on function public.sweep_stuck_email_summary_jobs() from public, anon, authenticated;
grant execute on function public.sweep_stuck_email_summary_jobs() to service_role;

-- Sweep before claiming so exhausted jobs stop blocking the one-active-job index.
create or replace function public.claim_email_summary_jobs(batch_limit integer default 3)
returns setof public.email_summary_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sweep_stuck_email_summary_jobs();

  return query
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
  returning job.*;
end $$;
revoke all on function public.claim_email_summary_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_email_summary_jobs(integer) to service_role;

-- A successful page is progress, not a failed retry. Only consecutive failures
-- should eventually exhaust the retry limit.
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
      attempts = 0,
      updated_at = now()
  where id = p_job_id
  returning *;
end $$;
revoke all on function public.advance_email_summary_job(uuid,text,integer,text,jsonb,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.advance_email_summary_job(uuid,text,integer,text,jsonb,boolean,jsonb) to service_role;
