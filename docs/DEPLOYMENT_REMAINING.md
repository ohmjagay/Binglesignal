# BingleSignal deployment and server-error checklist

This is a documentation-only checklist. It does not diagnose the current HTTP 500 by itself and does not change application code. Do not copy secrets, email content, subjects, sender addresses, or summaries into support chats or logs.

## What “full deployment” means here

The site and Worker code can be deployed, but the live READ, WATCH, and Email Beta experience also depends on Supabase migrations, Cloudflare Worker settings, provider dashboards, GitHub Actions secrets, and populated database data.

Payment-provider setup and scheduled outbound email/Telegram setup remain intentionally deferred. Until those are configured and tested, the site is not a fully enabled payments-and-delivery product. Do not turn on those features just to clear a READ/WATCH/Email Beta error.

## Step 1 — Capture the server error safely before changing settings

1. Reproduce one failure at a time: READ, WATCH, or Email Beta. Note the page, action, local time and timezone, and HTTP status.
2. Open **Cloudflare Dashboard** → **Workers & Pages** → **binglesignal** → **Logs** (or **Observability** → **Logs**, depending on the dashboard layout). Filter to the reproduction time and failed request. Record the route, status, timestamp, and request/trace ID. Do not copy request bodies or authorization headers.
3. Open **Supabase Dashboard** → the BingleSignal project → **Logs**. Check API/PostgREST and database logs for the same time. Record the error/status and table or RPC name only.
4. If the failure occurs during an Email Beta OAuth or AI-summary action, also note the provider and route, but do not include mailbox content or tokens.
5. Use [incident-runbook.md](./incident-runbook.md) if there is any indication of unauthorized access, secret exposure, or unusual provider activity.

The user-facing “server error” is not enough to identify the cause. Do not rotate keys, rerun old SQL, or enable unrelated providers unless the logs point to them.

## Step 2 — Verify database migrations in order

In Supabase, open **SQL Editor** and confirm which migrations already ran. Do not blindly rerun migrations or edit old migration files.

The feature sequence is:

1. Existing project schema and [001_premium.sql](../supabase/001_premium.sql)
2. Email Beta base schema: [002_email_beta.sql](../supabase/002_email_beta.sql)
3. Email content summaries: [003_email_content_summaries.sql](../supabase/003_email_content_summaries.sql)
4. Summary attempts/sweeper: [004_fix_summary_attempts.sql](../supabase/004_fix_summary_attempts.sql)
5. Encryption keys and security hardening: [005_user_keys_and_hardening.sql](../supabase/005_user_keys_and_hardening.sql)
6. Forward-to-Brief: [006_forward_to_brief.sql](../supabase/006_forward_to_brief.sql)
7. Private briefing and personalization: [007_briefing_v2.sql](../supabase/007_briefing_v2.sql)
8. Delivery state: [008_delivery.sql](../supabase/008_delivery.sql)
9. Payment hardening: [009_payment_hardening.sql](../supabase/009_payment_hardening.sql)
10. Lifecycle email queue and metrics: [010_lifecycle_metrics.sql](../supabase/010_lifecycle_metrics.sql)

The founder previously reported 004–008 as run. Confirm that report against the actual Supabase project. Migrations 009 and 010 were not confirmed as applied in the last handoff; they concern payments/lifecycle and are not the first fix to try for READ/WATCH or Email Beta 500s.

If a needed migration is missing, use **Supabase Dashboard** → project → **SQL Editor** → **New query**, paste that migration's complete contents from VS Code, and select **Run**. Apply only the missing migration(s), in sequence. Check for an error before proceeding.

## Step 3 — Check Cloudflare Worker settings for READ/WATCH

Open **Cloudflare Dashboard** → **Workers & Pages** → **binglesignal** → **Settings** → **Variables and Secrets**. Confirm the settings are present in the deployed Worker environment, not only in a local file:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` as a Worker secret only
- `EMAIL_AI_PROVIDER`, `EMAIL_AI_API_KEY`, and `EMAIL_AI_MODEL`; for an OpenAI-compatible provider, also `EMAIL_AI_ENDPOINT`
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in GitHub Actions, if story ingestion uses Workers AI
- Any Worker AI binding and Durable Object bindings shown by the Worker deployment configuration

Never put the Supabase service-role key or provider keys in website/public settings. Do not change the paywall emergency switch to troubleshoot a server error.

The READ/WATCH code and data surfaces to include in a deployment/review are:

- [public/config.js](../public/config.js) — public Supabase URL/key, public Turnstile site key, prices and display settings; never put private keys here.
- [public/app.js](../public/app.js) and [public/premium.js](../public/premium.js) — authenticated app and account/pricing screens.
- [public/taxonomy.js](../public/taxonomy.js) and [public/feed.json](../public/feed.json) — client taxonomy and small anonymous teaser.
- [worker/src/index.js](../worker/src/index.js) and [worker/src/briefing.js](../worker/src/briefing.js) — API routing and authenticated pool/edition behavior.
- [scripts/ingest.mjs](../scripts/ingest.mjs) and [.github/workflows/refresh-briefing.yml](../.github/workflows/refresh-briefing.yml) — builds and publishes the private story pool.
- [supabase/001_premium.sql](../supabase/001_premium.sql) and [supabase/007_briefing_v2.sql](../supabase/007_briefing_v2.sql) — plan access and private briefing tables.

Confirm the **Refresh briefing** GitHub Action completes successfully: GitHub → **ohmjagay/Binglesignal** → **Actions** → **Refresh briefing** → **Run workflow**. A green run should write to Supabase and update the public teaser; it should not publish a full public pool file.

## Step 4 — Check Email Beta prerequisites

Email Beta requires all of the following, even if the website itself loads:

- Migrations 002–005 applied in order and RLS/security settings intact.
- `EMAIL_BETA_ENABLED=true` only when the beta is intentionally enabled.
- `KEK_V1` and `KEK_CURRENT` configured as Cloudflare Worker secrets/variables. Keep the legacy `EMAIL_TOKEN_ENCRYPTION_KEY` until legacy mailbox tokens have migrated.
- Google and Microsoft OAuth client IDs/secrets and exact callback URLs matching the deployed routes.
- Supabase CAPTCHA/Turnstile configuration for sign-in, and TOTP MFA configured as required for mailbox connection.
- `EMAIL_AI_PROVIDER`, `EMAIL_AI_API_KEY`, and model settings; the OpenAI-compatible provider also needs its HTTPS endpoint.
- The Worker AI budget Durable Object binding/deployment. If the global budget switch is on or the budget service is unavailable, summary generation may intentionally fall back to rules-only output.
- An invited/eligible user and explicit consent before sending selected email text to the configured AI provider.

Relevant files to deploy/review for this feature:

- [docs/email-beta.md](./email-beta.md) — setup and privacy guide.
- [worker/src/email-beta.js](../worker/src/email-beta.js) and [worker/src/email/](../worker/src/email/) — mailbox API and processing pipeline.
- [worker/src/llm.js](../worker/src/llm.js) and [worker/src/crypto.js](../worker/src/crypto.js) — model adapter/budget and encryption.
- [public/app.js](../public/app.js) and [public/premium.js](../public/premium.js) — Email Beta and account UI.
- [supabase/002_email_beta.sql](../supabase/002_email_beta.sql), [003_email_content_summaries.sql](../supabase/003_email_content_summaries.sql), [004_fix_summary_attempts.sql](../supabase/004_fix_summary_attempts.sql), and [005_user_keys_and_hardening.sql](../supabase/005_user_keys_and_hardening.sql).

Use the callback URL shown by the deployed site/Worker documentation, not a local development URL. Verify one synthetic/test-account flow at a time. Never use real mailbox content as a diagnostic fixture.

## Step 5 — Check forwarding only if that Email Beta mode is needed

Forward-to-Brief is separate from connecting Gmail/Microsoft through OAuth. If you use it, follow [forward-mode.md](./forward-mode.md), confirm migration 006, the narrow Cloudflare Email Routing API token, and the receiving subdomain DNS. Do not change the root-domain MX records if they deliver existing business mail.

The key files are [worker/src/forward.js](../worker/src/forward.js), the Email UI in [public/app.js](../public/app.js), and [006_forward_to_brief.sql](../supabase/006_forward_to_brief.sql).

## Step 6 — Deploy the matching repository version

After confirming the intended code revision and required settings:

1. In VS Code, use **Terminal** → **New Terminal** and run `npm test`.
2. In the same repository, run `npx wrangler deploy --dry-run`.
3. If both succeed, deploy with `npm run deploy`.
4. Open `https://binglesignal.com/api/health` and confirm it returns JSON.
5. Re-run the Refresh briefing GitHub Action and confirm it succeeds.
6. Sign in with a test account and verify READ, WATCH, and Email Beta separately.
7. If a route still returns 500, return to Step 1 and compare its request ID and timestamp with Cloudflare and Supabase logs.

Do not treat a successful Worker deployment or `/api/health` response as proof that OAuth, Supabase policies, AI provider calls, ingestion, payment, or delivery works end-to-end.

## Step 7 — Features intentionally not ready until provider setup

These are not required to fix READ/WATCH/Email Beta server errors:

- Payment checkout/webhooks: payment provider accounts, product/plan IDs, webhook configuration, and the Cloudflare/GitHub secrets described in [MANUAL_STEPS.md](./MANUAL_STEPS.md).
- Scheduled outbound briefing email/Telegram: sender verification, physical mailing address, provider credentials, webhook/bot setup, and testing in [delivery.md](./delivery.md).

Keep both features unconfigured and do not enable customer-facing payment/delivery until provider research and live test transactions/messages are complete.

## Do not publish these as website files

`SUPABASE_SERVICE_ROLE_KEY`, OAuth client secrets, `KEK_V1`, AI provider keys, payment secrets, Cloudflare API tokens, Resend/SES credentials, and Telegram bot tokens belong only in the appropriate Cloudflare or GitHub **Secrets** settings. `public/config.js` may contain public client settings only.
