-- 013: no free trial for NEW sign-ups.
-- A new account now starts in the same "not subscribed" state as someone whose trial has ended: it sees the
-- paywall until the first payment, and Razorpay starts billing the moment they subscribe.
-- People who are already in a trial keep it, because nothing already stored is changed.
-- Safe to run twice. To bring the trial back, set the defaults back to 'trialing' and now() + interval '7 days'.
alter table public.subscriptions alter column status set default 'expired';
alter table public.subscriptions alter column trial_ends_at set default now();
