# BingleSignal incident response runbook

Use this runbook if an account, mailbox token, payment integration, database, or Worker may have been accessed without authorization.

## 1. Contain first

1. Record the UTC time you noticed the issue and the affected service; do not copy email bodies, subjects, or sender details into notes.
2. If email processing is involved, set `EMAIL_BETA_ENABLED=false` in Cloudflare Workers & Pages → binglesignal → Settings → Variables and Secrets, then deploy the change.
3. If an AI cost or provider issue is involved, set `EMAIL_AI_MONTHLY_BUDGET_EXCEEDED=true` in the same settings page.
4. If payments may be affected, disable the affected payment rail by removing or rotating its Cloudflare secret. Keep the paywall flag and the other rail available unless they are also affected.
5. If delivery may be affected, disable the configured delivery provider secret; do not send a test message until the incident is understood.

## 2. Preserve safe evidence

1. Cloudflare Dashboard → Workers & Pages → binglesignal → Logs: record request IDs, timestamps, status codes, and counts only.
2. GitHub → ohmjagay/Binglesignal → Actions: record the failed workflow name, run ID, and timestamp.
3. Supabase Dashboard → Logs: record request IDs, table names, timestamps, and status codes. Never export mailbox content for the incident file.
4. Restrict evidence access to the people handling the incident. Do not paste secrets into tickets, chat, or this runbook.

## 3. Rotate credentials

1. Rotate the compromised key in its provider dashboard (Cloudflare, Supabase, Google, Microsoft, Razorpay, Resend, AWS, or Telegram).
2. Cloudflare Dashboard → Workers & Pages → binglesignal → Settings → Variables and Secrets: replace only the affected secret and deploy.
3. For KEK exposure, do not overwrite the current KEK blindly. Prepare a versioned replacement, rewrap user keys using the approved migration procedure, verify decryption, then retire the old key.
4. Revoke exposed Google or Microsoft OAuth grants from the corresponding provider console and mark affected mailbox connections for reconnect.
5. Never add a real credential to `.dev.vars.example`, GitHub source files, or this runbook.

## 4. Recover and verify

1. Run the relevant automated tests and `npm test`.
2. Use synthetic accounts and synthetic email fixtures only.
3. Verify that webhook signature failures return 401, database queries remain user-scoped, and no email content appears in logs.
4. Re-enable the affected switch only after the root cause is fixed and the test suite passes.

## 5. Notify and document

1. Contact the affected users and providers through the approved contact channels, following applicable legal advice and notification deadlines.
2. Record the incident timeline, impact, containment, credential rotations, verified fixes, and follow-up tasks.
3. Notify the Grievance Officer at the published contact address and keep the affected-user notice free of other users' data.
