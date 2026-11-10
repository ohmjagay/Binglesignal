-- Migration 009 accidentally restricted checkout reservations to USD.
-- The current Razorpay checkout supports the configured INR and USD monthly plans.
alter table public.payment_checkout_sessions
  drop constraint if exists payment_checkout_sessions_currency_check;

alter table public.payment_checkout_sessions
  add constraint payment_checkout_sessions_currency_check
  check (currency in ('INR', 'USD'));
