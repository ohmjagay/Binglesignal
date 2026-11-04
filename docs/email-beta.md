# Email Summariser beta setup

The beta is limited to 50 invited Pro users. Combined metadata sync and user-requested content summaries share a 500-message per-user-local-day cap. Users can request a summary of inbox messages (up to remaining daily quota), latest 50 messages, or a date range up to 31 calendar days. A configured OpenAI-compatible HTTPS AI endpoint processes selected message text; raw message bodies are not stored by BingleSignal, while generated summaries and job status are stored for up to 30 days. Synthetic preview and scheduled reports remain fixtures and do not contain mailbox content.

## Database and invites

1. Apply `supabase/002_email_beta.sql` after `supabase.sql` and `supabase/001_premium.sql`, then apply `supabase/003_email_content_summaries.sql` in the Supabase SQL Editor.
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

In the Worker Settings → Variables and Secrets, configure:

- `EMAIL_BETA_ENABLED=true` as a non-secret variable. Leave it false until schema, OAuth apps, and tester invitations are ready.
- `EMAIL_TOKEN_ENCRYPTION_KEY` as a secret: a base64-encoded random 32-byte key. Generate one with `openssl rand -base64 32`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_EMAIL_REDIRECT_URI`.
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_EMAIL_REDIRECT_URI`.
- `EMAIL_BETA_RETURN_URL`, for example `https://<your-domain>/#/email`.
- `EMAIL_AI_ENDPOINT` as the full HTTPS URL to an OpenAI-compatible `/v1/chat/completions` endpoint; the endpoint must be publicly reachable by Cloudflare Workers.
- `EMAIL_AI_API_KEY` as a secret for that endpoint.
- `EMAIL_AI_MODEL` as the model identifier accepted by the endpoint.
- `RESEND_API_KEY` and `EMAIL_FROM` only if beta test reports should be sent by email. Verify the sender domain with Resend first.

The Cloudflare Cron Triggers enqueue mailbox sync every six hours, process up to five sync users and three content-summary pages every minute, and check scheduled roll-ups every 15 minutes. A content-summary page contains at most 10 messages. Failed sync jobs retry with backoff and become visibly failed in the database after eight attempts. A user's local timezone and time are editable under the Email Beta tab. Schedule times must be on a 15-minute boundary (for example, 07:00, 07:15, 07:30, or 07:45) to match the cron cadence.

## Beta behavior and privacy

- Connect a mailbox from the signed-in Pro account's **EMAIL BETA** tab; the tester must check the consent box. For connections made before content-reading scopes were added, reconnect to grant the expanded OAuth scope.
- User-requested summary modes are inbox mail (newest first, up to remaining daily quota), latest 50 messages, or a date range of up to 31 calendar days. Processing is resumable, in 10-message pages, with a combined 500-message daily cap shared with metadata sync. Only one summary job per user can be active at a time.
- Before starting a summary, the user must explicitly consent to sending selected message text to the configured AI endpoint. The self-hosted endpoint is preferred; it must not retain data beyond its intended processing and should have appropriate access controls. Email text is untrusted input and is never treated as instructions or used to take actions.
- Job status and generated summaries are retained for 30 days, then deleted automatically. Disconnecting a mailbox deletes jobs associated with that connection through the foreign-key cascade.
- `email_seen_messages` retains message IDs for deduplication and deletes them after 14 days. The Worker does not persist subjects, senders, bodies, or attachments.
- Every 100 new message IDs creates a labeled synthetic report. Scheduled roll-ups are also synthetic. A count of detected new messages may be included, but no email content is included in those fixture reports.
- In-app reports are available from the same tab. Email delivery uses the connected mailbox addresses and requires Resend configuration.
- Disconnecting Google attempts to revoke its refresh token, then deletes the local encrypted token and sync state. Outlook local tokens and sync state are deleted; the tester can also remove the app's consent from their Microsoft account.
- Set `EMAIL_BETA_ENABLED=false` to disable beta API access and scheduled processing.
- Content summaries require `EMAIL_AI_ENDPOINT`, `EMAIL_AI_API_KEY`, and `EMAIL_AI_MODEL`. Without them, the request is rejected and no email is fetched.

## Checks before inviting testers

1. Apply all SQL migrations and verify each invite's Pro subscription.
2. Configure and test both OAuth callbacks and the token-encryption secret.
3. Deploy the Worker and verify `/api/email/settings` rejects signed-out and non-invited users.
4. Reconnect test mailboxes with the updated OAuth scopes; confirm no summary starts without explicit content consent.
5. Test all-inbox, latest-50, and date-range summaries against authorized test mailboxes; verify the daily cap, resumability, retention, and disconnect deletion.
6. Test 100-message synthetic reports, local-time schedules, and disabled-beta behavior.
7. Configure Resend and confirm a synthetic test report arrives without message content.
