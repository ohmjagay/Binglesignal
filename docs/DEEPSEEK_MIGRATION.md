# BingleSignal v6: DeepSeek AI, one Razorpay plan, working feed again

This page is the checklist. Do the steps in order (about 20-30 minutes). Nothing here needs a database change.

## Why the homepage and sign-up page were empty

1. **`public/feed.json` was corrupted by a Git merge conflict.** The file contained `<<<<<<<` / `=======` / `>>>>>>>` lines, so it was not valid JSON. The homepage and the sign-up ("paused") page both read that file, failed silently and showed nothing. Fixed in three layers: the file is repaired (it is the small 30-headline teaser again), the homepage and sign-up page now read a live teaser from the Worker (`/api/teaser`) and only fall back to the file, and a test plus the CI check now fail loudly if the file is ever broken again.
2. **One AI failure killed the whole feed run.** The old summarizer threw an error when the AI could not be reached, and that stopped `scripts/ingest.mjs` before it published anything. Now stories are always published; AI notes are best-effort. If DeepSeek has a fatal problem (bad key, empty balance) the run still publishes, then turns red so GitHub emails you.
3. **Changing only the endpoint secrets would not have worked.** DeepSeek's current models run in "thinking mode" unless you switch it off, which makes short JSON jobs slow, expensive and often empty. The new client (`worker/src/deepseek.js`) always sends `thinking: disabled`.

## Do these steps

### 1. Put the new files in your repository
Unzip the project over your repo (keep your `.git` folder), commit and push to `main`. Cloudflare redeploys automatically. Do **not** commit a `.dev.vars` file.

### 2. Create the DeepSeek key
1. Sign up at https://platform.deepseek.com, open **Top up**, add a small balance first (for example $2-5) to prove your card works. DeepSeek is prepaid: when the balance reaches zero every request fails with error 402.
2. If your SBI debit card is declined here too, it is probably the same reason OpenAI and Anthropic declined it: international online payments are switched off on the card. Enable international online transactions in SBI's card settings (or ask the bank), or use another Visa/Mastercard or a payment method DeepSeek offers for your region.
3. **API keys → Create new API key.** Copy it once. Never paste it into `public/config.js` or a committed file.
4. Check the exact model ID on https://api-docs.deepseek.com. When this was written it was `deepseek-flash` (the cheaper, faster model, ideal for summaries). Model names change: if DeepSeek renames it you only change the `DEEPSEEK_MODEL` secret, not code.

### 3. GitHub Actions secrets (repo → Settings → Secrets and variables → Actions)
Add:

| Secret | Value |
|---|---|
| `DEEPSEEK_API_KEY` | your DeepSeek key |
| `DEEPSEEK_MODEL` | `deepseek-flash` |

Keep: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (needed: DeepSeek has no embeddings API, so story grouping stays on Cloudflare Workers AI), `YOUTUBE_API_KEY` (optional).
Delete: `EMAIL_AI_PROVIDER`, `EMAIL_AI_ENDPOINT`, `EMAIL_AI_API_KEY`, `EMAIL_AI_MODEL`. If any of them held an OpenAI or Anthropic key, also revoke that key in the provider's dashboard.

### 4. Cloudflare (Workers & Pages → your Worker → Settings → Variables and Secrets)
Add as secrets: `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_LITE_MONTHLY`, `RAZORPAY_PLAN_LITE_MONTHLY_USD` (see step 5 for the last two).
Keep `EMAIL_BETA_ENABLED` = `false`. Delete the four `EMAIL_AI_*` provider settings above. The `GLOBAL_*` settings can be deleted unless someone already paid through the old global provider.

### 5. Razorpay dashboard (start in Test mode, then repeat in Live mode)
1. **Subscriptions → Plans → Create plan**, twice:
   - INR plan: billing period monthly, interval 1, amount **₹299** → copy the `plan_...` ID into `RAZORPAY_PLAN_LITE_MONTHLY`.
   - USD plan: monthly, amount **$5** → copy the ID into `RAZORPAY_PLAN_LITE_MONTHLY_USD`. USD plans need international payments to be enabled on your Razorpay account; until Razorpay approves that, leave this secret empty and the pricing page shows "Payments opening soon" for non-India visitors.
   - The amounts must match `prices` in `public/config.js` (₹299 and $5). If you want a different rupee price, change both.
   - The plan name in the code is `lite` for historical reasons; customers only ever see "BingleSignal Briefing". Everyone on the plan gets the full READ (200) and WATCH (30) sizes from `public/config.js`.
2. **Settings → Webhooks → Add**: URL `https://binglesignal.com/api/webhooks/razorpay`, secret = the value you put in `RAZORPAY_WEBHOOK_SECRET`. Tick: `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused`, `subscription.resumed`, `subscription.updated`, `payment.failed`, `refund.created`.
3. Keys: **Account & Settings → API keys** → `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.

### 6. Run the feed and check it
1. GitHub → **Actions → Refresh briefing → Run workflow**. In the log look for a line like `AI notes: 480 new (118 from full article text), 2 failed, ...`. A green run with that line means DeepSeek works.
2. Open `https://binglesignal.com/api/teaser`: it should list headlines. Then open the homepage and the sign-up page.
3. Open `https://binglesignal.com/api/health`: `rails.razorpay_inr` (and `razorpay_usd`) should be `true`.
4. Make a Test-mode subscription with a Razorpay test card and confirm the account page shows "Briefing plan".

## What changed

| Area | Files | Change |
|---|---|---|
| AI client | `worker/src/deepseek.js` (new) | One DeepSeek client for the Worker and the scripts: thinking off, JSON output, retries on 429/5xx, clear errors for bad key (401) and empty balance (402), key never logged |
| Story notes | `scripts/story-summary.mjs`, `scripts/article-text.mjs` (new), `scripts/ingest.mjs` | Real summaries (3-4 sentences + "why it matters") from the article text of the top 120 stories, shorter summaries for the rest, "Watch if…" notes for videos. Paywalled sites are skipped and only the short summary is stored. AI failures no longer stop publishing |
| Email AI | `worker/src/llm.js` | DeepSeek only; Anthropic/OpenAI code removed. Email beta stays off (`EMAIL_BETA_ENABLED=false`) and its tab is hidden (`emailBeta:false` in `public/config.js`) |
| Feed | `public/feed.json`, `worker/src/index.js` (`/api/teaser`), `public/home.js`, `public/premium.js` | Repaired file, live teaser endpoint with fallback, no more committed feed file |
| Payments | `worker/src/index.js`, `public/premium.js`, `public/config.js`, `.dev.vars.example` | One plan, monthly, Razorpay only (INR and USD). Old Pro/yearly/global webhooks stay so any earlier subscriber is not orphaned |
| READ / WATCH | `public/app.js`, `public/taste.js` (new), `public/style.css` | Summary and "why it matters" on every READ card, watch notes on every WATCH card, "taste vector" personalization, at most 3 videos per channel up front |
| Legal | `public/privacy.html`, `public/terms.html` | DeepSeek and Razorpay listed as processors; one plan. Please read these once and confirm they say what you want |
| Tests | `scripts/*.test.mjs`, `worker/tests/*` | 40+ new or rewritten tests, including a fake-network run of the whole ingest with an empty DeepSeek balance |

## How READ and WATCH personalization works now

- **Summaries.** Every run ranks stories by quality. The best `DEEP_SUMMARY_TOP` (default 120) are summarized from the real article text of their two most reliable sources; the rest from headline and excerpt. Videos are summarized from title and description only (never a transcript), and the note says so by being cautious ("Watch if…").
- **Learning.** The app already learned from likes, saves, hides, skips and how much of a video you watched. It now also keeps a "taste vector": the average meaning of what you liked and watched, pushed away from what you hid. Items close in meaning rank higher even without matching keywords. It counts more once about 8 positive signals have been collected.
- **Variety.** At most 3 videos from one channel appear at the top of WATCH.
- **Knobs** (optional GitHub variables or workflow env): `MAX_NEW_NOTES` (500), `MAX_VIDEO_NOTES` (150), `DEEP_SUMMARY_TOP` (120), `AI_TIME_BUDGET_MS` (13 minutes).

## Rough cost

A full run of 500 notes is about 0.6 million input tokens and 65 thousand output tokens, roughly $0.10 at the DeepSeek Flash rates I saw in its docs (about $0.14 per million input tokens and $0.28 per million output tokens; rates change, check the pricing page). Later runs only summarize new stories, so expect a few dollars a month. This is an estimate, not a bill.

## If something goes wrong

| You see | Meaning | Fix |
|---|---|---|
| Action red: `balance is empty (402)` | DeepSeek balance is zero | Top up. The next run adds the missing notes |
| Action red: `rejected the API key (401)` | Wrong or revoked key | Re-create the key, update both GitHub and Cloudflare secrets |
| `rejected the request (400)… update DEEPSEEK_MODEL` | Model name changed | Copy the current ID from DeepSeek's docs into `DEEPSEEK_MODEL` |
| `AI notes stopped: time budget reached` | Normal on the first big run | Nothing; the rest follows on the next run |
| Homepage empty | No clusters yet or Supabase down | Open `/api/teaser`; if it says 503, run the Refresh briefing workflow |
| Pricing button says "Payments opening soon" | Plan ID missing for that currency | Add `RAZORPAY_PLAN_LITE_MONTHLY` (INR) or `..._USD` |

## Not changed, on purpose

- The 7-day free trial for new accounts is created by the database (`supabase/001_premium.sql`). To make the product pay-to-use instead, that is the place to change; I left it alone because you did not ask for it.
- Email beta code is still in the repo, switched off. To bring it back: `EMAIL_BETA_ENABLED=true` in Cloudflare and `emailBeta:true` in `public/config.js`.
- Briefing delivery (Telegram or email digests) is untouched and still optional.
