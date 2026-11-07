# BingleSignal V6 implementation breakdown

V6 completes the private briefing and personalization work, payment/lifecycle code, and trust documentation. Razorpay/global payment dashboards and outbound email/Telegram provider setup remain deliberately deferred. This is an implementation report, not a claim that external services or a live deployment were tested.

## What changed by file

| File(s) | Plain-English change |
|---|---|
| `.dev.vars.example` | Lists provider setting names and placeholders only; no secret values. |
| `.github/workflows/refresh-briefing.yml` | Runs ingestion and publishes the private story pool through Supabase. |
| `.github/workflows/learn-weights.yml` | Adds weekly preference learning. |
| `.github/workflows/reconcile-payments.yml` | Adds a bounded nightly Razorpay reconciliation job; it will fail until the founder configures secrets. |
| `.gitignore` | Keeps generated/private output out of source control. |
| `package.json` | Includes the current complete test command; no new Worker runtime dependency was added. |
| `docs/PROGRESS.md` | Tracks completed work and founder-owned remaining items. |
| `docs/briefing-pipeline.md` | Explains private pool ingestion, required secrets, and feed checks. |
| `docs/delivery.md` | Documents email and Telegram delivery setup; setup is deferred. |
| `docs/email-beta.md` | Points to the current migration sequence and clarifies that beta reports and edition delivery are separate. |
| `docs/incident-runbook.md` | Adds response steps for incidents and emergency switches. |
| `docs/metrics.sql` | Provides the requested metrics query. |
| `docs/MANUAL_STEPS.md` | Lists outstanding founder actions in order. |
| `docs/LAUNCH_BREAKDOWN.md` → `docs/V6_BREAKDOWN.md` | Replaces the outdated launch description with the current V6 status. |
| `public/_headers` | Adds security headers while keeping the content security policy in report-only mode. |
| `public/app.js` | Adds onboarding/activity hooks and reads authenticated editions and metrics. |
| `public/feed.json` | Contains only the small public teaser. |
| `public/pool.json` | Removed; the full story pool is private. |
| `public/onboarding.js` | Adds the skippable personalization questions. |
| `public/premium.js` | Adds currency/plan switching and account metrics UI. |
| `public/privacy.html` | Adds Google's Limited Use policy wording. |
| `public/trust.html` | Publishes the data lifecycle and subprocessor information. |
| `public/contact.html` | Publishes the founder-provided Grievance Officer name. |
| `.well-known/security.txt` | Publishes the security contact route. |
| `scripts/ingest.mjs` | Deduplicates and clusters public stories, validates notes, and publishes privately. |
| `scripts/learn-weights.mjs` | Learns per-user preference weights from feedback. |
| `scripts/reconcile-payments.mjs` | Reconciles provider subscription state using configured plan IDs and user-scoped updates. |
| `supabase/007_briefing_v2.sql` | Adds private briefing/profile/edition tables and policies. |
| `supabase/008_delivery.sql` | Adds server-only delivery state and claims. |
| `supabase/009_payment_hardening.sql` | Adds private checkout reservations and atomic payment-event handling. |
| `supabase/010_lifecycle_metrics.sql` | Adds trial/dunning queues, user metrics, and idempotent edition events. |
| `worker/src/index.js` | Wires payment webhooks, checkout reservations, plan switching, and scheduled features. |
| `worker/src/rate-limit.js` | Applies fail-closed rate limits to payment-changing routes. |
| `worker/src/briefing.js` | Serves authenticated pools, composes editions, records feedback/events, and triggers delivery. |
| `worker/src/delivery.js` | Provides plain-text email/Telegram delivery and signed unsubscribe handling. |
| `worker/src/lifecycle.js` | Claims and sends lifecycle emails when provider settings are present; otherwise leaves jobs queued. |
| `worker/tests/worker.test.mjs` | Covers payment mapping, signatures, checkout, plan switching, rate limits, and existing security behavior. |
| `worker/tests/briefing.test.mjs` | Covers edition ranking, plan limits, and user-scoped briefing behavior. |
| `worker/tests/delivery.test.mjs` | Covers safe plain-text delivery and provider behavior. |
| `worker/tests/lifecycle.test.mjs` | Covers lifecycle deferral, emails, migration safety, and metrics. |
| `worker/tests/payment-reconciliation.test.mjs` | Covers provider-plan mapping and user-scoped reconciliation. |

## Verification

- `npm test` — 99 passed, 0 failed.
- JavaScript syntax check — 39 files passed.
- `npx wrangler deploy --dry-run` — passed; Cloudflare read 17 public asset files.
- `git diff --check` — passed.
- Live Supabase application of migrations 009 and 010 has not been verified.
- No live payment-provider, email-provider, Telegram, account, or production Worker integration has been tested.
- The source feed check previously reported 204 OK, 13 transient responses, and 0 dead feeds; availability changes over time.
- Physical-device behavior and legal compliance have not been independently verified.

## Founder-owned items still open

- Apply migrations 009 and 010 using [MANUAL_STEPS.md](./MANUAL_STEPS.md).
- Finish Razorpay/global payment-provider research before configuring payment dashboards.
- Finish delivery-provider research before enabling outbound email or Telegram.
