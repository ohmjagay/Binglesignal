create table if not exists public.email_forward_addresses (
  user_id uuid primary key references auth.users(id) on delete cascade,
  local_part text not null unique check (local_part ~ '^[a-z0-9_-]{24,64}$'),
  enabled boolean not null default true,
  usage_date date,
  daily_messages integer not null default 0 check (daily_messages between 0 and 100),
  confirmation_code_enc text,
  confirmation_code_expires_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_forward_messages (
  message_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  report_enc text,
  status text not null default 'processing' check (status in ('processing','completed','failed')),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists email_forward_messages_user_created_idx
  on public.email_forward_messages (user_id, created_at desc);

alter table public.email_forward_addresses enable row level security;
alter table public.email_forward_messages enable row level security;
revoke all on table public.email_forward_addresses from public, anon, authenticated;
revoke all on table public.email_forward_messages from public, anon, authenticated;
grant all on table public.email_forward_addresses to service_role;
grant all on table public.email_forward_messages to service_role;

create or replace function public.claim_email_forward_message(
  p_local_part text,
  p_message_hash text,
  p_usage_date date,
  p_daily_limit integer default 100
) returns table(result text, owner_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  address_row public.email_forward_addresses;
  existing public.email_forward_messages;
  message_exists boolean := false;
begin
  if p_local_part !~ '^[a-z0-9_-]{24,64}$'
     or p_message_hash !~ '^[a-f0-9]{64}$'
     or p_daily_limit < 1 or p_daily_limit > 100 then
    raise exception 'invalid forward-message claim';
  end if;

  select * into address_row
  from public.email_forward_addresses
  where local_part = p_local_part and enabled
  for update;
  if not found then
    return query select 'unknown'::text, null::uuid;
    return;
  end if;

  select * into existing
  from public.email_forward_messages
  where message_hash = p_message_hash
  for update;
  message_exists := found;
  if found and existing.status = 'completed' then
    return query select 'duplicate'::text, address_row.user_id;
    return;
  end if;
  if found and existing.status = 'processing' and existing.locked_until > now() then
    return query select 'duplicate'::text, address_row.user_id;
    return;
  end if;

  if address_row.usage_date is distinct from p_usage_date then
    address_row.daily_messages := 0;
  end if;
  if address_row.daily_messages >= p_daily_limit then
    return query select 'limit'::text, address_row.user_id;
    return;
  end if;

  update public.email_forward_addresses
  set usage_date = p_usage_date,
      daily_messages = address_row.daily_messages + case when message_exists then 0 else 1 end,
      updated_at = now()
  where user_id = address_row.user_id;

  if message_exists then
    update public.email_forward_messages
    set status = 'processing', locked_until = now() + interval '10 minutes', updated_at = now()
    where message_hash = p_message_hash;
  else
    insert into public.email_forward_messages (message_hash, user_id, locked_until)
    values (p_message_hash, address_row.user_id, now() + interval '10 minutes');
  end if;
  return query select 'accepted'::text, address_row.user_id;
end $$;
revoke all on function public.claim_email_forward_message(text,text,date,integer) from public, anon, authenticated;
grant execute on function public.claim_email_forward_message(text,text,date,integer) to service_role;

create or replace function public.consume_email_forward_confirmation(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  encrypted_code text;
begin
  select confirmation_code_enc into encrypted_code
  from public.email_forward_addresses
  where user_id = p_user_id
    and confirmation_code_expires_at > now()
  for update;
  if encrypted_code is null then return null; end if;

  update public.email_forward_addresses
  set confirmation_code_enc = null,
      confirmation_code_expires_at = null,
      updated_at = now()
  where user_id = p_user_id;
  return encrypted_code;
end $$;
revoke all on function public.consume_email_forward_confirmation(uuid) from public, anon, authenticated;
grant execute on function public.consume_email_forward_confirmation(uuid) to service_role;
