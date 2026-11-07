alter table public.billing_email_jobs
  drop constraint if exists billing_email_jobs_email_type_check;
alter table public.billing_email_jobs
  add constraint billing_email_jobs_email_type_check
  check (email_type in ('trial_day_1', 'trial_day_3', 'trial_day_5', 'trial_day_7', 'payment_failed'));

create table if not exists public.user_metrics (
  user_id uuid primary key references auth.users(id) on delete cascade,
  completed_editions integer not null default 0 check (completed_editions >= 0),
  time_saved_minutes integer not null default 0 check (time_saved_minutes >= 0),
  updated_at timestamptz not null default now()
);
alter table public.user_metrics enable row level security;
revoke all on table public.user_metrics from public, anon, authenticated;
grant all on table public.user_metrics to service_role;

create table if not exists public.edition_event_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_key text not null references public.editions(slot_key) on delete cascade,
  event_name text not null check (event_name in ('edition_opened', 'edition_completed')),
  created_at timestamptz not null default now(),
  primary key (user_id, slot_key, event_name)
);
alter table public.edition_event_log enable row level security;
revoke all on table public.edition_event_log from public, anon, authenticated;
grant all on table public.edition_event_log to service_role;

create or replace function public.enqueue_trial_lifecycle_emails()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'trialing' then
    insert into public.billing_email_jobs (job_key, user_id, email_type, due_at)
    select new.user_id::text || ':trial:' || schedule.job_key_suffix, new.user_id,
      schedule.email_type, schedule.due_at
    from (values
      ('trial_day_1', 'day-1', new.trial_ends_at - interval '6 days'),
      ('trial_day_3', 'day-3', new.trial_ends_at - interval '4 days'),
      ('trial_day_5', 'day-5', new.trial_ends_at - interval '2 days'),
      ('trial_day_7', 'day-7', new.trial_ends_at)
    ) as schedule(email_type, job_key_suffix, due_at)
    where schedule.due_at > now()
    on conflict (job_key) do nothing;
  end if;
  return new;
end
$$;
drop trigger if exists subscriptions_enqueue_trial_lifecycle on public.subscriptions;
create trigger subscriptions_enqueue_trial_lifecycle
  after insert on public.subscriptions
  for each row execute function public.enqueue_trial_lifecycle_emails();
revoke all on function public.enqueue_trial_lifecycle_emails() from public, anon, authenticated;

insert into public.billing_email_jobs (job_key, user_id, email_type, due_at)
select s.user_id::text || ':trial:' || schedule.job_key_suffix, s.user_id,
  schedule.email_type, schedule.due_at
from public.subscriptions s
cross join lateral (values
  ('trial_day_1', 'day-1', s.trial_ends_at - interval '6 days'),
  ('trial_day_3', 'day-3', s.trial_ends_at - interval '4 days'),
  ('trial_day_5', 'day-5', s.trial_ends_at - interval '2 days'),
  ('trial_day_7', 'day-7', s.trial_ends_at)
) as schedule(email_type, job_key_suffix, due_at)
where s.status = 'trialing'
  and schedule.due_at > now()
on conflict (job_key) do nothing;

create or replace function public.claim_due_billing_email_jobs(p_limit integer default 10)
returns table(job_key text, user_id uuid, recipient text, email_type text, attempts smallint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.billing_email_jobs
  set state = 'failed', due_at = now(), updated_at = now()
  where state = 'sending' and updated_at < now() - interval '30 minutes';

  return query
  with candidates as (
    select j.job_key
    from public.billing_email_jobs j
    join public.subscriptions s on s.user_id = j.user_id and s.email is not null
    where j.state in ('pending', 'failed')
      and j.due_at <= now()
      and j.attempts < 5
      and (
        (j.email_type = 'payment_failed' and s.status = 'past_due')
        or (s.status = 'trialing' and j.email_type in ('trial_day_1', 'trial_day_3', 'trial_day_5', 'trial_day_7'))
        or (s.status = 'expired' and j.email_type = 'trial_day_7')
      )
    order by j.due_at
    for update skip locked
    limit greatest(1, least(p_limit, 20))
  ), claimed as (
    update public.billing_email_jobs j
    set state = 'sending', attempts = j.attempts + 1, updated_at = now()
    from candidates c
    where j.job_key = c.job_key
    returning j.job_key, j.user_id, j.email_type, j.attempts
  )
  select c.job_key, c.user_id, s.email, c.email_type, c.attempts
  from claimed c
  join public.subscriptions s on s.user_id = c.user_id
  where s.email is not null;
end
$$;
revoke all on function public.claim_due_billing_email_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_due_billing_email_jobs(integer) to service_role;

create or replace function public.finish_billing_email_job(
  p_job_key text,
  p_sent boolean,
  p_provider_message_id text,
  p_status_code integer
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.billing_email_jobs
  set state = case when p_sent then 'sent' else 'failed' end,
      provider_message_id = p_provider_message_id,
      status_code = p_status_code,
      due_at = case when not p_sent and attempts < 5
        then now() + make_interval(mins => 15 * attempts) else due_at end,
      updated_at = now()
  where job_key = p_job_key and state = 'sending'
$$;
revoke all on function public.finish_billing_email_job(text, boolean, text, integer) from public, anon, authenticated;
grant execute on function public.finish_billing_email_job(text, boolean, text, integer) to service_role;

create or replace function public.record_edition_event(p_user_id uuid, p_slot_key text, p_event_name text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_count integer;
begin
  if p_event_name not in ('edition_opened', 'edition_completed') then
    raise exception 'Unsupported edition event';
  end if;
  if not exists (
    select 1 from public.editions e
    where e.user_id = p_user_id and e.slot_key = p_slot_key
  ) then
    raise exception 'Edition does not belong to user';
  end if;

  insert into public.edition_event_log (user_id, slot_key, event_name)
  values (p_user_id, p_slot_key, p_event_name)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;

  if p_event_name = 'edition_opened' then
    update public.editions set opened_at = coalesce(opened_at, now())
    where user_id = p_user_id and slot_key = p_slot_key;
  else
    insert into public.user_metrics (user_id, completed_editions, time_saved_minutes)
    values (p_user_id, 1, 3)
    on conflict (user_id) do update set
      completed_editions = public.user_metrics.completed_editions + 1,
      time_saved_minutes = public.user_metrics.time_saved_minutes + 3,
      updated_at = now();
  end if;

  insert into public.events (user_id, name, props)
  values (p_user_id, p_event_name, jsonb_build_object('slot_key', p_slot_key));
  return true;
end
$$;
revoke all on function public.record_edition_event(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_edition_event(uuid, text, text) to service_role;
