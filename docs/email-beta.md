# Email Summariser beta setup

The beta is limited to 50 invited Pro users. Combined metadata sync and user-requested content summaries share a 500-message per-user-local-day cap. Users can request a summary of inbox messages (up to remaining daily quota), latest 50 messages, or a date range up to 31 calendar days. The Worker can use Anthropic's Messages API or an OpenAI-compatible HTTPS endpoint. Email text is untrusted, sent without model tools, and accepted only as schema-checked JSON; raw message bodies are not stored by BingleSignal, while generated summaries are encrypted with per-user data keys and retained for up to 30 days. Synthetic preview and scheduled reports remain fixtures and do not contain mailbox content.

## Database and invites

1. Apply `supabase/002_email_beta.sql` after `supabase.sql` and `supabase/001_premium.sql`, then apply `supabase/003_email_content_summaries.sql`, `supabase/004_fix_summary_attempts.sql`, and `supabase/005_user_keys_and_hardening.sql` in order in the Supabase SQL Editor.
2. Invite only testers who already have a Pro subscription or active Pro trial.
3. After a tester has signed up, add their Supabase user UUID in SQL Editor:

   ```sql
   insert into public.email_beta_users (user_id, enabled)
   values ('<tester-auth-user-uuid>', true)
   on conflict (user_id) do update set enabled = true;
   ```

   Disable a tester by setting `enabled = false`. Keep no more than 50 enabled rows.

## OAuth applications

Set each OAuth application's callback URL to the exact deployed Worker route:

- Google: `https://<your-domain>/api/email/oauth/gmail/callback`
- Microsoft: `https://<your-domain>/api/email/oauth/outlook/callback`

Configure the same exact URLs in `GOOGLE_EMAIL_REDIRECT_URI` and `MICROSOFT_EMAIL_REDIRECT_URI`. The beta requests Google's restricted `gmail.readonly` OAuth scope and Microsoft's delegated `Mail.Read`, `User.Read`, and `offline_access` scopes. These allow the Worker to read email content for user-requested summaries. The sync/report fixture path itself still only uses message IDs and timestamps; summary jobs fetch selected inbox messages in memory and send their text to the configured AI endpoint only after the user checks the separate content-processing consent box.

Google classifies `gmail.readonly` as a restricted scope. OAuth verification and a security assessment may be required before external testers can connect. Microsoft app registration and user-consent policies also need to permit the selected delegated scopes. Users who connected before this scope change must reconnect and grant the updated permission. Configure and test these provider apps before enabling content summaries.

## Cloudflare Worker settings

In **Cloudflare → Workers & Pages → binglesignal → Settings → Variables and Secrets**, configure:

- `EMAIL_BETA_ENABLED=true` as a non-secret variable. Leave it false until schema, OAuth apps, and tester invitations are ready.
- `KEK_V1` as a secret, and `KEK_CURRENT=v1` as a text variable. Generate the 32-byte key with `openssl rand -base64 32`; save it in a password manager because losing it makes encrypted email data unrecoverable.
- Keep the prior `EMAIL_TOKEN_ENCRYPTION_KEY` secret until every existing mailbox has refreshed at least once; old refresh tokens migrate to per-user encryption lazily.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_EMAIL_REDIRECT_URI`.
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_EMAIL_REDIRECT_URI`.
- `EMAIL_BETA_RETURN_URL`, for example `https://<your-domain>/#/email`.
- `EMAIL_AI_ENDPOINT` as the full HTTPS URL to an OpenAI-compatible `/v1/chat/completions` endpoint; the endpoint must be publicly reachable by Cloudflare Workers.
- `EMAIL_AI_API_KEY` as a secret for that endpoint.
- `EMAIL_AI_PROVIDER` as `openai_compatible` or `anthropic`. Anthropic uses `https://api.anthropic.com/v1/messages` and defaults to `claude-haiku-5-5`; its API key is also a Cloudflare Secret.
- `EMAIL_AI_MODEL` as the model identifier accepted by the endpoint (optional for Anthropic).
- `EMAIL_AI_DAILY_TOKEN_CAP` and `EMAIL_AI_MONTHLY_TOKEN_BUDGET` as numeric limits. Wrangler provisions a Durable Object budget counter so per-user daily and global monthly usage are reserved atomically. If the monthly cap is reached, the AI budget service is unavailable, or `EMAIL_AI_MONTHLY_BUDGET_EXCEEDED=true`, summaries fall back to rules-only output.
- `RESEND_API_KEY` and `EMAIL_FROM` only if beta test reports should be sent by email. Verify the sender domain with Resend first.

The Worker rate-limits checkout to five requests per IP every 10 minutes and cancellation to three requests per IP per hour using the `API_RATE_LIMITS` Durable Object. If the limiter is unavailable, those payment-changing routes fail closed with HTTP 503.

Configure sign-in CAPTCHA in **Supabase → Authentication → Settings → CAPTCHA** using Cloudflare Turnstile. Put the public Turnstile site key in `public/config.js` as `turnstileSiteKey`; the secret is entered only in Supabase Auth, not the public config. TOTP MFA is required for mailbox connection. Turn it on in **Supabase → Authentication → Multi-Factor Authentication**, then sign in and use **Account → Account security → Set up authenticator** to register an authenticator app and verify its current 6-digit code.

The Cloudflare Cron Triggers enqueue mailbox sync every six hours, process up to five sync users and three content-summary pages every minute, and check scheduled roll-ups every 15 minutes. A content-summary page contains at most 10 messages. Failed sync jobs retry with backoff and become visibly failed in the database after eight attempts. A user's local timezone and time are editable under the Email Beta tab. Schedule times must be on a 15-minute boundary (for example, 07:00, 07:15, 07:30, or 07:45) to match the cron cadence.

## Beta behavior and privacy

- Connect a mailbox from the signed-in Pro account's **EMAIL BETA** tab; the tester must check the consent box. For connections made before content-reading scopes were added, reconnect to grant the expanded OAuth scope.
- User-requested summary modes are inbox mail (newest first, up to remaining daily quota), latest 50 messages, or a date range of up to 31 calendar days. Processing is resumable, in 10-message pages, with a combined 500-message daily cap shared with metadata sync. Only one summary job per user can be active at a time.
- Before starting a summary, the user must explicitly consent to sending selected message text to the configured AI endpoint. The self-hosted endpoint is preferred; it must not retain data beyond its intended processing and should have appropriate access controls. Email text is untrusted input and is never treated as instructions or used to take actions.
- Job status and encrypted generated summaries are retained for 30 days, then deleted when the user next opens the summaries page. Disconnecting a mailbox deletes jobs associated with that connection through the foreign-key cascade.
- `email_seen_messages` retains message IDs for deduplication and deletes them after 14 days. The Worker does not persist subjects, senders, bodies, or attachments.
- Every 100 new message IDs creates a labeled synthetic report. Scheduled roll-ups are also synthetic. A count of detected new messages may be included, but no email content is included in those fixture reports.
- In-app reports are available from the same tab. Email delivery uses the connected mailbox addresses and requires Resend configuration.
- The Account → Privacy button deletes mailbox connections, summary jobs, reports, message IDs, OAuth state, and the per-user encryption key. Google refresh-token revocation is attempted. Microsoft does not offer a per-refresh-token revoke endpoint; users should also remove BingleSignal from their Microsoft account app permissions when requesting immediate provider-side revocation.
- Set `EMAIL_BETA_ENABLED=false` to disable beta API access and scheduled processing.
- Content summaries require a valid provider configuration and `EMAIL_AI_API_KEY`. OpenAI-compatible providers also require the endpoint and model. Anthropic can use the default model. Deploy the Wrangler Durable Object migration before enabling email summarization; without the budget service, summaries fall back to rules-only output.

## Checks before inviting testers

1. Apply all SQL migrations and verify each invite's Pro subscription.
2. Configure and test both OAuth callbacks, the KEK, Turnstile, and TOTP MFA.
3. Deploy the Worker and verify `/api/email/settings` rejects signed-out and non-invited users.
4. Reconnect test mailboxes with the updated OAuth scopes; confirm no summary starts without explicit content consent.
5. Test all-inbox, latest-50, and date-range summaries against authorized test mailboxes; verify the daily cap, resumability, retention, and disconnect deletion.
6. Test 100-message synthetic reports, local-time schedules, and disabled-beta behavior.
7. Configure Resend and confirm a synthetic test report arrives without message content.
