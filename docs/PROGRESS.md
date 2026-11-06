# BingleSignal implementation progress

The source of truth is [BINGLESIGNAL_RESEARCH_BOOK.md](./BINGLESIGNAL_RESEARCH_BOOK.md), copied from `document.md`.

## Tasks

- [x] **T0 — Setup:** create this progress checklist and `.github/copilot-instructions.md`. `npm test`: 27 passed, 0 failed.
- [x] **T1 — P0 fixes:** align cron handling and tests; add migration 004 to reset attempts after successful pages and fail stuck jobs; correct the beta notice; remove AdSense; update Lite/Pro prices, centralize INR pricing in `public/config.js`, and list USD plan IDs. `npm test`: 31 passed, 0 failed. Founder reports migration 004 was run; Workers Paid selected.
- [x] **T2 — LLM adapter:** added Anthropic and OpenAI-compatible JSON-only adapters with validation, one retry, 30-second timeouts, an atomic Durable Object per-user/global token budget, a manual monthly kill-switch, rules-only fallback, injection fixture tests, and merges limited to 20 summaries at a time. `npm test`: 36 passed, 0 failed; Wrangler dry run passed.
- [x] **T3 — Security hardening:** migration 005 adds per-user wrapped keys, OAuth nonce hashes, reconnect state, encrypted report fields, and user-scoped job updates. The Worker encrypts refresh tokens and final/intermediate summaries, migrates legacy refresh tokens on use, binds OAuth to an HttpOnly cookie, handles invalid grants, and deletes email data from Account → Privacy. Sign-up/login use Supabase CAPTCHA with Turnstile; mailbox connection requires TOTP AAL2, with enrollment and login verification screens. Checkout/cancel have fail-closed Durable Object rate limits. Added report-only CSP, HSTS, X-Frame-Options, moved the home script to `public/home.js`, and added ownership/encryption/rate-limit tests. `npm test`: 48 passed, 0 failed; JS syntax checks passed; `npx wrangler deploy --dry-run` passed. Founder reports migration 005, KEK secrets, Turnstile, and TOTP setup complete.
- [x] **T4 — Email pipeline v2:** added plain-text/MIME normalization, secret/PII scrubbing, metadata-first triage (including Gmail labels and security mail), batched strict-JSON analysis with one validation retry, Workers AI embeddings and sender-first bulk clustering, explainable priority scores, and a three-line inbox brief. Gmail fetches full bodies only after metadata triage; reports are link-scrubbed and encrypted. The resumable cron now processes one sync or summary job at a time with an eight-message page derived from the 45-subrequest target. Added 100 synthetic emails (10 injection attempts) and regression tests. `npm test`: 60 passed, 0 failed; syntax checks and Wrangler dry-run passed.
- [x] **T5 — Forward-to-Brief:** migration 006 creates server-only address/message tables and atomic daily-cap, dedupe, and one-time-code functions; the Worker handles Cloudflare Email events, normalizes and analyzes forwarded email, encrypts confirmation codes/briefs, and stores no raw messages. The Email tab now supports private address setup, filters, one-time Gmail codes, and saved briefs. Exact Cloudflare rules are registered per address (the catch-all option is apex-only and cannot serve `in.binglesignal.com`). Added API-token setup and manual routing guidance in `docs/forward-mode.md`. `npm test`: 71 passed, 0 failed; Wrangler dry run and `git diff --check` passed. Manual setup remains: run migration 006, add the Cloudflare API settings, and verify receiving DNS for `in.binglesignal.com` without disrupting any existing business email.
- [ ] **T6 — Briefing v2:** improve ingestion/source tiers, secure the pool behind authenticated plan-aware API, add editions and feedback endpoints, and preserve client-side fallback.
- [ ] **T7 — Personalization v2:** add skippable onboarding, profiles, role templates, watchlists, feedback controls, and weekly learned weights.
- [ ] **T8 — Delivery:** add plain-text email editions, provider abstraction, Telegram linking/webhook, timezone-aware sending, and content-free delivery logs.
- [ ] **T9 — Payments hardening:** add webhook idempotency, plan-ID validation, duplicate guard, currency selection, lifecycle events, plan switching, reconciliation, GSTIN, and payment tests. **Checkpoint: provide Razorpay dashboard steps.**
- [ ] **T10 — Lifecycle and metrics:** add trial emails, time-saved counter, event instrumentation, and `docs/metrics.sql`.
- [ ] **T11 — Trust:** add trust page, privacy wording, security.txt, Grievance Officer details, and incident runbook.
- [ ] **T12 — Final:** update launch docs, add `docs/MANUAL_STEPS.md`, run the full test suite, and report untested areas.

## Checkpoint decisions

- **T1:** complete — founder reports migration 004 was run and selected Workers Paid.
- **T2:** complete — deployment dry-run confirms the new Durable Object binding and migration.
- **T3:** complete — founder reports migration 005, KEK secrets, Turnstile, and TOTP setup are complete. Keep the legacy token key until mailbox refresh-token migration is complete.
- **T9:** pending — complete Razorpay dashboard setup after review.
