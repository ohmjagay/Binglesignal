> **Update (v6):** DeepSeek is the only AI provider. New purchases use one monthly Razorpay plan; the email beta is paused. See [DEEPSEEK_MIGRATION.md](./DEEPSEEK_MIGRATION.md).

# BingleSignal remaining manual steps

This checklist is ordered. Do not enter secret values in chat, source files, or GitHub variables.
The [Refresh briefing workflow](../.github/workflows/refresh-briefing.yml) runs automatically every 6 hours (it was paused on 10 Nov and switched back on 11 Nov, see [FIX-2026-11-11.md](./FIX-2026-11-11.md)). You can also use **Run workflow** for an immediate manual refresh.

## 1. Apply the remaining database migrations

The founder reported migrations 004–008 as applied. Confirm their status and apply missing migrations in order.

For **each** migration, separately:

1. Open **Supabase Dashboard** → select the BingleSignal project → **SQL Editor** → **New query**.
2. In VS Code, open the linked migration, copy the complete file, and paste it into the SQL Editor.
3. Select **Run** and confirm that the query completes without an error before moving to the next migration.

Apply in this order:

1. [009_payment_hardening.sql](../supabase/009_payment_hardening.sql)
2. [010_lifecycle_metrics.sql](../supabase/010_lifecycle_metrics.sql)
3. [011_checkout_currency_support.sql](../supabase/011_checkout_currency_support.sql)

The payment migrations enable RLS on new tables and restrict access to the Worker service role. Migration 011 corrects the checkout currency constraint without editing migration 009. Do not edit old migrations.

## 2. Confirm GitHub Actions secrets for private briefing ingestion

If these secrets are not already present, open **GitHub** → **ohmjagay/Binglesignal** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add the exact names below; obtain values from the named provider dashboards. Never paste the service-role key into the website or a public file.

| Secret name | Where its value comes from |
|---|---|
| `SUPABASE_URL` | Supabase → **Project Settings** → **API** → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → **Project Settings** → **API** → service-role key |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account overview |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with the Workers AI permission documented in [briefing-pipeline.md](./briefing-pipeline.md) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `DEEPSEEK_MODEL` | DeepSeek model identifier |
| `YOUTUBE_API_KEY` | Optional; only needed if video keyword search is enabled |

The weekly preference-learning workflow also uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## 3. Deploy and verify the code

1. In VS Code, select **Terminal** → **New Terminal**.
2. Run `npm run deploy` from the repository folder.
3. Open `https://binglesignal.com/api/health` and confirm it returns JSON.
4. The **Refresh briefing** workflow no longer runs on a schedule or on pushes. If an intentional refresh is needed, open **GitHub** → **ohmjagay/Binglesignal** → **Actions** → **Refresh briefing** → **Run workflow**. The workflow publishes stories to Supabase; it does not refresh the static `public/feed.json` fallback.

Do not treat this as proof of live payment or outbound-email delivery. Resolve and verify the production server error before enabling live checkout.

## 4. Set up email forwarding only if you intend to use it now

The founder reported migration 006 as applied. If forwarding is desired, follow the exact Cloudflare token and routing instructions in [forward-mode.md](./forward-mode.md). In particular, do not change the root-domain MX records if they currently serve business email. Keep `EMAIL_BETA_ENABLED` off until the routing and Worker settings are checked.

## 5. Verify the public Grievance Officer details

The founder provided the name now published on [contact.html](../public/contact.html). Before launch, verify that the displayed support email from `public/config.js` is the public address you want customers to use.

## 6. Activate Razorpay payment handling

The website currently sells one monthly plan, **BingleSignal Briefing**: INR 299 for India and USD 5 elsewhere. Do not enable live checkout until the production Worker/server error is resolved and verified. Keep `paywall` enabled; do not put credentials in this repository.

1. **Verify prerequisites.** Confirm Supabase migrations 001 and 009–011 are applied in order and the production Worker has the correct `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Keep the service-role key Worker-only. Confirm the current Worker deployment and `/api/health` are healthy.
2. **Enable Razorpay account features.** In Razorpay, finish account/business verification and enable Subscriptions/recurring payments. Enable international payments before offering USD. If Razorpay has not approved international payments, configure only the INR plan and leave the USD plan ID unset.
3. **Create monthly plans.** In the Razorpay dashboard, select **Test Mode** first, go to **Subscriptions** → **Plans** → **Create Plan**, and create:
   - INR monthly plan: amount matching `IN.month` in [config.js](../public/config.js) (currently ₹299).
   - USD monthly plan: amount matching `GL.month` in [config.js](../public/config.js) (currently $5), only if international recurring payments are enabled.

   Use the generated plan IDs with keys from the same mode. Do not create annual or Pro plans; those are not offered for new purchases.
4. **Configure the Worker.** In **Cloudflare Dashboard** → **Workers & Pages** → **binglesignal** → **Settings** → **Variables and Secrets**, add:
   - Secrets: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
   - Variables: `RAZORPAY_PLAN_LITE_MONTHLY` (INR plan ID) and, only when approved, `RAZORPAY_PLAN_LITE_MONTHLY_USD` (USD plan ID).

   Start with Test Mode API keys and matching Test Mode plan IDs. Never put secrets in `public/config.js`, `.dev.vars.example`, or committed files.
5. **Register the webhook.** In Razorpay **Account & Settings** → **Webhooks**, add `https://binglesignal.com/api/webhooks/razorpay`. Generate a webhook secret and set exactly that value as the Worker secret `RAZORPAY_WEBHOOK_SECRET`. Subscribe to the events the Worker handles: `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.resumed`, `subscription.updated`, `subscription.pending`, `subscription.paused`, `subscription.halted`, `subscription.completed`, `subscription.cancelled`, and `payment.failed`. Save the webhook and confirm Razorpay reports successful delivery after a test event.
6. **Deploy and verify Test Mode.** Deploy the Worker after adding its settings. Open `https://binglesignal.com/api/health`; it should report `rails.razorpay_inr: true` and report USD true only when its keys and plan ID are set. Use a designated test account to complete a Test Mode checkout. Confirm the checkout is associated with that account, the webhook delivery succeeds, and the subscription becomes active. Do not use a real card or make a live charge during this step.
7. **Add reconciliation secrets.** In GitHub **Settings** → **Secrets and variables** → **Actions**, add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, the plan ID secret(s) used by [reconcile-payments.yml](../.github/workflows/reconcile-payments.yml), `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. This workflow reconciles subscription state; it does not replace signed webhook handling. Run it manually once in Test Mode and inspect its count-only output.
8. **Switch to Live Mode only when ready.** Create/confirm the Live Mode plan IDs separately, replace the Worker Razorpay keys and plan-ID variables with their Live Mode values, set the Live webhook secret, update the matching GitHub Actions secrets, and deploy. Recheck `/api/health`, then make one explicitly authorized low-risk live test purchase and verify the webhook, access state, and refund/cancellation process in Razorpay.
9. **Keep monitoring.** Verify webhook delivery and subscription state before treating payment as active. A failed Razorpay signature is intentionally rejected with HTTP 401. Never manually edit subscription rows to simulate a successful payment.

Troubleshooting a payment or webhook error is separate from the READ/WATCH error; use [incident-runbook.md](./incident-runbook.md) and check Worker logs using the request ID. Do not share signatures, credentials, or customer payment details in logs or chat.

## 7. Outbound briefing delivery remains deferred

Do not configure Resend, Amazon SES, or Telegram or enable customer delivery until ready. The setup guide is [delivery.md](./delivery.md).
