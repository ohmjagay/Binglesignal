-- Paying subscribers by plan and currency (multiply by your prices for MRR).
select plan, currency, count(*) as subscribers
from public.subscriptions
where status in ('active', 'past_due')
group by 1, 2
order by 1, 2;

-- Trial funnel.
select count(*) filter (where status = 'trialing') as in_trial,
       count(*) filter (where status in ('active', 'past_due')) as paying,
       count(*) filter (where status = 'expired') as expired_unpaid
from public.subscriptions;

-- Events by day.
select date_trunc('day', created_at) as day, name, count(*)
from public.events
group by 1, 2
order by 1 desc
limit 60;

-- Aggregate usage estimates: three minutes per completed briefing.
select coalesce(sum(completed_editions), 0) as completed_editions,
       coalesce(sum(time_saved_minutes), 0) as estimated_time_saved_minutes
from public.user_metrics;
