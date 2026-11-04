# Email Summariser beta setup

The beta is deliberately limited: at most 50 invited Pro users, 500 new messages per user-local day, read-only Gmail and Outlook connections, and metadata-only sync every six hours. Reports use synthetic fixtures; this release does not read subjects or message bodies, call an AI model, or include mailbox content in email reports.

## Database and invites

1. Apply `supabase/002_email_beta.sql` after `supabase.sql` and `supabase/001_premium.sql` in the Supabase SQL Editor.
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

Configure the same exact URLs in `GOOGLE_EMAIL_REDIRECT_URI` and `MICROSOFT_EMAIL_REDIRECT_URI`. The beta uses Google's restricted `gmail.metadata` OAuth scope and Microsoft's delegated `Mail.ReadBasic`, `User.Read`, and `offline_access` scopes. The Google scope permits access to message headers and labels; `Mail.ReadBasic` permits basic message fields such as subject and sender. The beta requests only Gmail message IDs and change history, or Outlook message IDs and received times. It does not fetch or store subjects, senders, bodies, or attachments.

Google classifies `gmail.metadata` as a restricted scope. OAuth verification and a security assessment may be required before external testers can connect. Microsoft app registration and user-consent policies also need to permit the selected delegated scopes. Configure and test these provider apps before enabling the beta.

## Cloudflare Worker settings

In the Worker Settings → Variables and Secrets, configure:

- `EMAIL_BETA_ENABLED=true` as a non-secret variable. Leave it false until schema, OAuth apps, and tester invitations are ready.
- `EMAIL_TOKEN_ENCRYPTION_KEY` as a secret: a base64-encoded random 32-byte key. Generate one with `openssl rand -base64 32`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_EMAIL_REDIRECT_URI`.
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_EMAIL_REDIRECT_URI`.
- `EMAIL_BETA_RETURN_URL`, for example `https://<your-domain>/#/email`.
- `RESEND_API_KEY` and `EMAIL_FROM` only if beta test reports should be sent by email. Verify the sender domain with Resend first.

The Cloudflare Cron Triggers enqueue mailbox sync every six hours, process up to five queued users every five minutes, and check scheduled roll-ups every 15 minutes. Failed sync jobs retry with backoff and become visibly failed in the database after eight attempts. A user's local timezone and time are editable under the Email Beta tab. Schedule times must be on a 15-minute boundary (for example, 07:00, 07:15, 07:30, or 07:45) to match the cron cadence.

## Beta behavior and privacy

- Connect a mailbox from the signed-in Pro account's **EMAIL BETA** tab; the tester must check the consent box.
- `email_seen_messages` retains message IDs for deduplication and deletes them after 14 days. The Worker does not persist subjects, senders, bodies, or attachments.
- Every 100 new message IDs creates a labeled synthetic report. Scheduled roll-ups are also synthetic. A count of detected new messages may be included, but no email content is.
- In-app reports are available from the same tab. Email delivery uses the connected mailbox addresses and requires Resend configuration.
- Disconnecting Google attempts to revoke its refresh token, then deletes the local encrypted token and sync state. Outlook local tokens and sync state are deleted; the tester can also remove the app's consent from their Microsoft account.
- Set `EMAIL_BETA_ENABLED=false` to disable beta API access and scheduled processing.
- Do not enable a real AI model or send real mail content to any inference endpoint in this beta. Evaluate a self-hosted summarizer separately with synthetic or authorized anonymized data before expanding scope or limits.

## Checks before inviting testers

1. Apply all SQL migrations and verify each invite's Pro subscription.
2. Configure and test both OAuth callbacks and the token-encryption secret.
3. Deploy the Worker and verify `/api/email/settings` rejects signed-out and non-invited users.
4. Connect test mailboxes; confirm only metadata is requested and no body endpoints are called.
5. Test 100-message reports, local-time schedules, disconnect/deletion, and disabled-beta behavior.
6. Configure Resend and confirm a synthetic test report arrives without message content.
