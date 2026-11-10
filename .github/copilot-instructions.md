# Non-negotiable BingleSignal engineering rules

1. Never commit secrets. Store secrets only in Cloudflare/GitHub Secrets; `.dev.vars.example` contains names/placeholders only.
2. Never log email content, including bodies, subjects, senders, or summaries. Log only IDs, counts, status codes, token counts, and cost.
3. Treat email text as untrusted. Models that read email receive no tools, return JSON only, and have outputs schema-validated. Render model output as plain text; never render model-provided markdown, HTML, or links.
4. Request read-only mailbox scopes only: Gmail `gmail.readonly`; Microsoft `Mail.Read`, `User.Read`, and `offline_access`. Never request modify/compose/send scopes or automatically send, archive, delete, label, or unsubscribe on a user's behalf.
5. Every database change is a new numbered, idempotent migration in `/supabase` (`004`, `005`, ...). Never edit old migrations. Enable RLS on every table; email-related tables are server-only with all privileges revoked from `anon` and `authenticated`.
6. Every Worker query on a user table filters by `user_id` and is covered by a test. The service-role key is Worker-only.
7. Payment webhooks fail closed (bad signature returns 401). The paywall continues to fail open as it does today. Preserve the paywall flag, `EMAIL_BETA_ENABLED`, and payment-rail secrets as emergency switches.
8. Add no Worker runtime dependencies except `postal-mime`. GitHub Actions scripts may use dependencies when needed.
9. Add or update automated tests for every change, and run `npm test` after each task. Do not mark a task done while tests fail.
10. Keep code clear and small, with comments for non-developers where useful. Do not add AdSense or third-party scripts to authenticated pages.
11. DeepSeek is the only AI provider (`worker/src/deepseek.js`). Never add Anthropic or OpenAI calls. Keep DeepSeek thinking mode disabled for JSON jobs. Embeddings stay on Cloudflare Workers AI because DeepSeek has no embeddings API. Send the model only public news text (or email text the user explicitly consented to), never account data.
12. Razorpay is the only payment rail and there is one plan (BingleSignal Briefing, stored as plan `lite`). Legacy `pro` and `global` code paths exist only so old subscribers keep working.
