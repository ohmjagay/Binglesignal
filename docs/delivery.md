# Brief delivery setup

The */15 Worker cron sends a saved edition to the channel selected in **Brief settings**. Email uses Resend or Amazon SES; Telegram uses a private bot connection. The Worker stores delivery status, provider message IDs, and HTTP status codes only—not message text or email addresses.

## Database

1. Open **Supabase Dashboard** → your project → **SQL Editor** → **New query**.
2. Paste the complete contents of `supabase/008_delivery.sql`.
3. Select **Run** and confirm the query completes successfully.

## Cloudflare values

1. Open **Cloudflare Dashboard** → **Workers & Pages** → **binglesignal** → **Settings** → **Variables and Secrets**.
2. Select **Add** for each secret. Use the exact names below; values must come from your provider/account and must not be committed to Git.

| Secret name | Value |
|---|---|
| `DELIVERY_FROM_EMAIL` | The sender address verified with Resend or Amazon SES. |
| `DELIVERY_PHYSICAL_ADDRESS` | Your real business mailing address for the required email footer. Do not use a placeholder. |
| `DELIVERY_UNSUBSCRIBE_SECRET` | A new random 32-byte value. Generate locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste the output directly into Cloudflare. |
| `RESEND_API_KEY` | Resend API key, if using Resend. |
| `SES_ACCESS_KEY_ID` | IAM access key restricted to `ses:SendEmail`, if using SES. |
| `SES_SECRET_ACCESS_KEY` | Matching IAM secret access key. |
| `SES_SESSION_TOKEN` | Optional temporary AWS session token. |
| `TELEGRAM_BOT_TOKEN` | Bot token from Telegram's official **@BotFather**. |
| `TELEGRAM_WEBHOOK_SECRET` | A new random secret, used to authenticate Telegram webhook requests. Generate locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste the output directly into Cloudflare. Keep a copy in your password manager for the webhook setup below. |

Set these as ordinary Worker variables in the same **Variables and Secrets** page:

| Variable | Value |
|---|---|
| `DELIVERY_EMAIL_PROVIDER` | `resend` or `ses` |
| `TELEGRAM_BOT_USERNAME` | Public Telegram bot username without `@`. |
| `PUBLIC_BASE_URL` | `https://binglesignal.com` |

For Resend, also open **Resend Dashboard** → **Domains** and verify the sending domain before selecting a sender address. For SES, verify the sender/domain and ensure the AWS account has production sending access.

## Telegram webhook

1. In Telegram, open **@BotFather** → send `/newbot` → follow the prompts, then save the bot token directly as the Cloudflare `TELEGRAM_BOT_TOKEN` secret. Do not paste it into this repository.
2. Set `TELEGRAM_BOT_USERNAME` to the public bot username in Cloudflare.
3. Set `TELEGRAM_WEBHOOK_SECRET` in Cloudflare. Keep the same value available locally for the command below.
4. In a local PowerShell terminal, run the following. Enter the bot token and webhook secret only when prompted; neither value is included in command history:

```powershell
$botToken = Read-Host "Telegram bot token"
$webhookSecret = Read-Host "Telegram webhook secret"
$body = @{ url = "https://binglesignal.com/api/telegram/webhook"; secret_token = $webhookSecret } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$botToken/setWebhook" -ContentType "application/json" -Body $body
Remove-Variable botToken, webhookSecret, body
```

5. In BingleSignal, open **Brief settings** → select **Telegram** → **Create one-time Telegram code**. Open your bot and send the displayed `/start` command before its 10-minute expiry.

## Turn on delivery

Open **Brief settings**, select **Email** or **Telegram**, select the delivery time and timezone, and save. Editions are delivered on the next matching */15 cron tick. Failed or interrupted provider attempts retry on later quarter-hour ticks for up to two hours. The email footer contains the mailing address and a signed unsubscribe link; using it switches the account back to in-app delivery. A provider failure is recorded for diagnosis without storing the briefing text.

Do not enable email delivery until the sender is verified and the real mailing address is set. Do not enable Telegram delivery until the webhook and one-time linking flow have both been tested.
