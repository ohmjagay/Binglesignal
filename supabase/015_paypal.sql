-- 015: allow PayPal as a payment provider.
-- Razorpay rows are not touched. This only widens two "allowed values" lists so PayPal subscriptions can be saved.
-- Safe to run twice. Run it in Supabase -> SQL Editor BEFORE you switch PayPal on.
alter table public.subscriptions drop constraint if exists subscriptions_provider_check;
alter table public.subscriptions
  add constraint subscriptions_provider_check check (provider in ('razorpay', 'global', 'manual', 'paypal'));

alter table public.payment_checkout_sessions drop constraint if exists payment_checkout_sessions_provider_check;
alter table public.payment_checkout_sessions
  add constraint payment_checkout_sessions_provider_check check (provider in ('razorpay', 'global', 'paypal'));
