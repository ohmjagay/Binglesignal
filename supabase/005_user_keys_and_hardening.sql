-- Per-user envelope-encryption keys and browser-bound OAuth state.
create table if not exists public.user_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  kid text not null,
  wrapped_dek text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);
alter table public.user_keys enable row level security;
revoke all on table public.user_keys from public, anon, authenticated;
grant all on table public.user_keys to service_role;

alter table public.email_oauth_states
  add column if not exists nonce_hash text;

alter table public.email_connections
  add column if not exists status text not null default 'active';
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'email_connections_status_check'
      and conrelid = 'public.email_connections'::regclass
  ) then
    alter table public.email_connections
      add constraint email_connections_status_check
      check (status in ('active', 'needs_reconnect', 'revoked'));
  end if;
end $$;

alter table public.email_seen_messages
  add column if not exists user_id uuid;
update public.email_seen_messages seen
set user_id = connection.user_id
from public.email_connections connection
where seen.connection_id = connection.id and seen.user_id is null;
alter table public.email_seen_messages
  alter column user_id set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'email_seen_messages_user_id_fkey'
      and conrelid = 'public.email_seen_messages'::regclass
  ) then
    alter table public.email_seen_messages
      add constraint email_seen_messages_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

alter table public.email_summary_jobs
  add column if not exists report_enc text,
  add column if not exists partial_summaries_enc text;

-- Plaintext report columns remain for compatibility, but new jobs do not write content to them.
create or replace function public.advance_email_summary_job(
  p_job_id uuid,
  p_user_id uuid,
  p_usage_date text,
  p_increment integer,
  p_provider_cursor text,
  p_partial_summaries_enc text,
  p_done boolean,
  p_report_enc text
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
  where id = p_job_id and user_id = p_user_id and status = 'running'
  for update;
  if not found then
    raise exception 'summary job is not currently claimed for this user';
  end if;

  update public.email_beta_users
  set summary_usage_date = p_usage_date,
      summary_messages = case when summary_usage_date = p_usage_date then summary_messages else 0 end
  where user_id = p_user_id;

  select summary_messages,
         case when usage_date = p_usage_date then daily_messages else 0 end
  into current_usage, metadata_usage
  from public.email_beta_users
  where user_id = p_user_id
  for update;
  if current_usage + metadata_usage + p_increment > 500 then
    raise exception 'daily email summary limit reached';
  end if;

  update public.email_beta_users
  set summary_messages = current_usage + p_increment,
      updated_at = now()
  where user_id = p_user_id;

  return query
  update public.email_summary_jobs
  set processed_count = processed_count + p_increment,
      provider_cursor = p_provider_cursor,
      partial_summaries = '[]'::jsonb,
      partial_summaries_enc = p_partial_summaries_enc,
      status = case when p_done then 'completed' else 'queued' end,
      report = null,
      report_enc = case when p_done then p_report_enc else null end,
      error = null,
      locked_until = null,
      attempts = 0,
      updated_at = now()
  where id = p_job_id and user_id = p_user_id
  returning *;
end $$;
revoke all on function public.advance_email_summary_job(uuid,uuid,text,integer,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.advance_email_summary_job(uuid,uuid,text,integer,text,text,boolean,text) to service_role;
drop function if exists public.advance_email_summary_job(uuid,text,integer,text,jsonb,boolean,jsonb);
