-- BingleSignal v4: storage for each reader's profile. Safe to run more than once.
create table if not exists public.bs_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.bs_profiles enable row level security;
drop policy if exists "bs_profiles select own" on public.bs_profiles;
drop policy if exists "bs_profiles insert own" on public.bs_profiles;
drop policy if exists "bs_profiles update own" on public.bs_profiles;
drop policy if exists "bs_profiles delete own" on public.bs_profiles;
create policy "bs_profiles select own" on public.bs_profiles for select to authenticated using (auth.uid() = id);
create policy "bs_profiles insert own" on public.bs_profiles for insert to authenticated with check (auth.uid() = id);
create policy "bs_profiles update own" on public.bs_profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
create policy "bs_profiles delete own" on public.bs_profiles for delete to authenticated using (auth.uid() = id);
grant select, insert, update, delete on public.bs_profiles to authenticated;
