# BingleSignal remaining manual steps

This checklist is ordered. Do not enter secret values in chat, source files, or GitHub variables.

## 1. Apply the remaining database migrations

The founder reported migrations 004–008 as applied. Migrations 009 and 010 are new and still need to be applied.

For **each** migration, separately:

1. Open **Supabase Dashboard** → select the BingleSignal project → **SQL Editor** → **New query**.
2. In VS Code, open the linked migration, copy the complete file, and paste it into the SQL Editor.
3. Select **Run** and confirm that the query completes without an error before moving to the next migration.

Apply in this order:

1. [009_payment_hardening.sql](../supabase/009_payment_hardening.sql)
2. [010_lifecycle_metrics.sql](../supabase/010_lifecycle_metrics.sql)

Both migrations enable RLS on their new tables and restrict access to the Worker service role. Do not edit or rerun older migrations to change their contents.

## 2. Confirm GitHub Actions secrets for private briefing ingestion

If these secrets are not already present, open **GitHub** → **ohmjagay/Binglesignal** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add the exact names below; obtain values from the named provider dashboards. Never paste the service-role key into the website or a public file.

| Secret name | Where its value comes from |
|---|---|
| `SUPABASE_URL` | Supabase → **Project Settings** → **API** → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → **Project Settings** → **API** → service-role key |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account overview |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with the Workers AI permission documented in [briefing-pipeline.md](./briefing-pipeline.md) |
| `EMAIL_AI_PROVIDER` | `anthropic` or `openai_compatible`, matching your approved provider |
| `EMAIL_AI_API_KEY` | The approved provider's paid API key |
| `EMAIL_AI_MODEL` | Model identifier for that provider |
| `EMAIL_AI_ENDPOINT` | OpenAI-compatible HTTPS endpoint; leave empty for Anthropic |
| `YOUTUBE_API_KEY` | Optional; only needed if video keyword search is enabled |

The weekly preference-learning workflow also uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## 3. Deploy and verify the code

1. In VS Code, select **Terminal** → **New Terminal**.
2. Run `npm run deploy` from the repository folder.
3. Open `https://binglesignal.com/api/health` and confirm it returns JSON.
4. Open **GitHub** → **ohmjagay/Binglesignal** → **Actions** → **Refresh briefing** → **Run workflow**. Confirm the run completes successfully.

Do not treat this as proof of live payment or outbound-email delivery; those providers are intentionally not configured yet.

## 4. Set up email forwarding only if you intend to use it now

The founder reported migration 006 as applied. If forwarding is desired, follow the exact Cloudflare token and routing instructions in [forward-mode.md](./forward-mode.md). In particular, do not change the root-domain MX records if they currently serve business email. Keep `EMAIL_BETA_ENABLED` off until the routing and Worker settings are checked.

## 5. Verify the public Grievance Officer details

The founder provided the name now published on [contact.html](../public/contact.html). Before launch, verify that the displayed support email from `public/config.js` is the public address you want customers to use.

## 6. Provider setup intentionally deferred

No action is requested now for either item below, per the founder's instruction:

- **Payments:** do not create Razorpay plans, configure a payment webhook, add payment secrets, or run a live transaction until the founder finishes provider research. The global payment provider is also unverified against a live account.
- **Outbound briefing delivery:** do not configure Resend, Amazon SES, or Telegram or enable customer delivery until the founder is ready. The setup guide is [delivery.md](./delivery.md).

When resuming either item, configure provider secrets only in **Cloudflare Dashboard** → **Workers & Pages** → **binglesignal** → **Settings** → **Variables and Secrets**. Reconciliation also needs the Razorpay and Supabase values as **GitHub Actions secrets**; its workflow is documented in [reconcile-payments.yml](../.github/workflows/reconcile-payments.yml).
