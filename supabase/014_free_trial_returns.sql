-- 014: the 7-day free trial is back for every NEW sign-up.
--
-- 1) New accounts start as 'trialing' with a trial that ends 7 days after sign-up (undoes the defaults set in 013).
--    People who signed up while 013 was in force stay "not subscribed": nothing already stored is changed.
--
-- 2) Subscribing during the trial does not use the trial up. The worker (worker/src/index.js, handleCheckout) tells Razorpay to
--    take the first payment on the day the trial ends, so the days left are added to the plan. Example: the trial ends on 25 Nov,
--    someone subscribes on 20 Nov; the 5 unused days come first, the first payment is on 25 Nov, and the plan then runs
--    to 25 Dec (35 days after they subscribed). Someone who subscribes on 24 Nov keeps their 1 unused day the same way.
--    No payment code changes here: that is how the worker already worked.
--
-- 3) my_access now also says whether a person who is still in their trial has already subscribed (approved the payment, first
--    charge still to come), so the app can show the first payment date instead of asking them to subscribe again.
--    Everything else it returns is unchanged.
-- Safe to run twice.
alter table public.subscriptions alter column status set default 'trialing';
alter table public.subscriptions alter column trial_ends_at set default (now() + interval '7 days');

create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_build_object('status', a.eff_status, 'plan', a.plan_id, 'has_access', a.has_access,
      'trial_ends_at', a.trial_ends_at, 'current_period_end', a.current_period_end, 'days_left', a.days_left,
      'trial_subscribed', exists (select 1 from public.subscriptions s
        where s.user_id = auth.uid() and s.status = 'trialing' and s.provider_subscription_id is not null),
      'features', case when a.has_access then to_jsonb(p) - 'id' - 'name' else null end)
    from public._access_for(auth.uid()) a join public.plans p on p.id = a.plan_id),
    jsonb_build_object('status','none','plan',null,'has_access',false,'features',null))
$$;
revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;
