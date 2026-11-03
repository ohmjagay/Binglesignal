# BingleSignal v5: launch build breakdown

Built 1 Nov 2026 · every process, feature and fix in this version · written for tonight's personal-invite test

## 0. Read this first

1. **What this build is.** The platform for launch: the Android layout fix, the 7-day trial and paywall layer, payments for India and worldwide (keys left empty), legal pages, safer caching and headers, monitoring and tests.
2. **What this build is not.** It does **not** yet contain the executive-grade content layer from Part 3: primary-source feeds, source tiers, "why it matters" lines, the Principal Brief, alerts. The pricing page labels those "soon". Google News still supplies about 64% of story links. So tonight, invite people as **founding readers of a beta**, and do not promise the executive-grade features yet.
3. **Nothing breaks if you skip a step.** If the database step is skipped, or a payment key is empty, the app keeps working (details in §3 and §4).

## 1. What changed, file by file

| File | Change |
|---|---|
| `public/index.html` | **Date strip removed** (markup and script). Phone viewport now covers notches. Added the trial-banner slot, the premium-screens slot and `premium.js` |
| `public/style.css` | Date-strip styles removed. New phone rules (headers wrap, side padding, single-column grids, long words wrap). Styles for the banner, pricing, paused and account screens |
| `public/premium.js` (new) | Reads the member's plan, shows the trial banner, applies plan limits, and draws `#/pricing`, `#/paused`, `#/account`. Opens Razorpay or the international checkout |
| `public/app.js` | Small hooks only: tells `premium.js` when login changes, waits for the plan before drawing the lists, skips the new routes, adds Pricing/Terms/Refunds/Contact to the footer and Account to the member header |
| `public/terms.html`, `refund.html`, `contact.html` (new) | Terms, Refund and Cancellation, Contact and Grievance Officer. Privacy and Copyright pages now use the real logo |
| `public/config.js` | Added `paywall:true` (instant switch, §8) and `portalUrl:''` |
| `public/_headers` | Security headers; HTML, JS and CSS always revalidate; `feed.json` and `pool.json` cached 5 minutes at the edge |
| `public/pool.json`, `feed.json` | The 9 old Reddit stories removed (the next robot run replaces both files anyway) |
| `scripts/ingest.mjs` | **Reddit removed** (its terms need a commercial agreement). The robot now reads 216 sources instead of 285 |
| `worker/src/index.js` (new) | Payments API: checkout, cancel, Razorpay and international webhooks, `/api/health` |
| `worker/tests/` (new) | 13 automated tests |
| `wrangler.toml` | Deploys the site and the Worker together; only `/api/*` runs the Worker |
| `supabase/001_premium.sql` (new) | Trial, plans, paywall rules, Pro-only tables (tested on PostgreSQL in Part 2; file unchanged) |
| `.github/workflows/` | `refresh-briefing.yml` (existing) + `healthcheck.yml`, `ci.yml`, `db-backup.yml` (new) |
| `.dev.vars.example` (new) | Every key and ID you will fill later, all blank, each with where to find it |
| `loadtest/k6-static.js` (new) | A load test you can run yourself (§7) |

## 2. The Android fix: cause, fix, proof

- **Cause 1:** the 7-day date strip is about 450 px wide. On a 360 px phone it pushed the whole page wider than the screen.
- **Cause 2:** the member header (logo, READ/WATCH tabs, three links) could not wrap and was about 559 px wide.
- **Fix:** strip removed; headers wrap into two rows on phones; side padding restored; one-column grids; long words wrap; the web-app viewport respects notches.
- **Proof:** I rendered the pages in a real browser engine (headless Firefox) inside frames of exactly 320, 360, 390 and 412 px, on 7 pages: home, pricing, terms, privacy, READ, WATCH, account. **Old code: 5 of those combinations overflowed at 360 px (home 450 px, member pages 559 px). New code: 0 of 28 overflow.** The measured width matched the target each time, and the date strip is gone everywhere.
- **Limit:** this is not a physical Android phone or Chrome. Check on your own phone tonight (§6).

## 3. The trial and paywall

- Every sign-up becomes a **7-day Pro trial, no card**. Nothing needs a cron job: access is calculated live in the database.
- After day 7 the member sees "Your briefing is paused" with three teaser headlines and a "Choose a plan" button.
- **Plan limits:** Lite = READ 40, WATCH 8. Pro (and trial) = READ 200, WATCH 30. Edit the numbers in the `plans` table.
- **Fail-open:** if the plan check cannot be reached (SQL not run yet, an outage), nobody is blocked and no banner shows.
- Customers can read only their own plan row and can never change it (tested in the database).
- **Manual grant** (founding members, refunds, concierge clients): Supabase → Table Editor → `subscriptions` → set `status = active`, `plan`, `current_period_end`, `provider = manual`, `currency`.

## 4. Payments (keys empty by design)

| Rail | For | Provider | What the app does with no keys |
|---|---|---|---|
| India | ₹99 / ₹299 monthly, ₹999 / ₹2,999 yearly | Razorpay Subscriptions (UPI AutoPay and cards) | The Pricing button says "Payments opening soon"; the trial keeps running |
| Worldwide | $2.99 / $5.99 monthly, $29 / $59 yearly | Dodo Payments (merchant of record: handles foreign VAT and sales tax) | Same |

`/api/health` tells the pricing page which rails are ready, without exposing any secret. A webhook with a missing or wrong signature is rejected (401).

**Razorpay (when you have an account):** create 4 plans (Lite and Pro, monthly and yearly) and copy each plan ID; add a webhook to `https://binglesignal.com/api/webhooks/razorpay` with the events `subscription.authenticated`, `.activated`, `.charged`, `.pending`, `.halted`, `.cancelled`, `.completed`, `.resumed`; paste the key ID, key secret, webhook secret and 4 plan IDs into Cloudflare. Confirm your account uses *Subscriptions* (Razorpay also has a separate "Recurring Payments" product). Start in test mode.

**Dodo (when you have an account):** create the 4 subscription products, copy their hosted checkout links, set the webhook to `https://binglesignal.com/api/webhooks/global`, paste the links and the `whsec_` secret into Cloudflare. **Not checked against a live Dodo account:** the link parameter names (change `GLOBAL_LINK_PARAMS` if needed) and the webhook event and field names. Send me one test webhook and I will adjust it in minutes.

**Where secrets go:** Cloudflare → Workers & Pages → binglesignal → Settings → Variables and Secrets, added as **Secrets**. The full list is in `.dev.vars.example`. Never put a key in GitHub files or in `public/`.

**Cancelling:** Razorpay plans cancel from the Account page at the end of the period. Worldwide customers email support until you add a billing-portal link in `config.js` (`portalUrl`).

## 5. Tonight, in order (about 30 minutes)

1. **GitHub:** replace the repo contents with this zip. The `.github` folder is hidden; afterwards confirm `.github/workflows/` shows 4 files. If it does not, create each by hand (Add file → Create new file, type the path, paste).
2. **Supabase → SQL Editor:** paste `supabase/001_premium.sql` → Run. Check that `subscriptions` has a row per existing user. (Existing users' trials end 8 Nov 2026 03:00 IST; edit that date in the file first if your launch moved.)
3. **Supabase → Authentication → SMTP:** add your own email sender, or confirm that sign-up emails really arrive (the built-in sender allows only a few emails an hour).
4. **Supabase → Advisors → Security Advisor:** fix any "RLS disabled" table.
5. **Cloudflare secrets:** add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
6. **Open `https://binglesignal.com/api/health`.** Expect JSON containing `"rails":{"razorpay":false,"global":false}`. That means the Worker is live and the keys are empty.
7. **GitHub → Actions:** confirm "Refresh briefing" ran green after your push, then run "Site health" once.
8. **Phone check (5 minutes, on your own Android):** home fits the screen with no sideways scroll · sign up · trial banner shows "7 days left" · READ and WATCH load · Pricing shows ₹ prices and "Payments opening soon" · Terms, Refunds, Privacy and Contact open · sign out and in.

## 6. Final checks I ran

| Check | Result |
|---|---|
| JavaScript syntax: app, premium, taxonomy, config, robot, Worker, the inline script in `index.html` | Pass |
| Worker tests (signatures incl. the official Standard Webhooks test vector, checkout India and worldwide, webhook mapping, cancel, health) | **13 of 13** on Node 22 (CI runs them on Node 20) |
| Premium screens in a simulated browser: India and worldwide prices, yearly toggle, empty keys, trial banner, expired trial → paused, plan check down → fail-open, checkout request, account page, plan limits | **8 of 8** (this found and fixed a real bug: opening `#/account` or `#/paused` directly would have hung) |
| Database rules (Part 2, PostgreSQL 16: trial, limits, cannot self-upgrade, grace periods, re-run safe) | Pass; the file is byte-identical to the tested one |
| Robot dry run on a fake network | 216 sources, exit 0, 0 Reddit items |
| Every local link and script in the pages | All resolve |
| Phone-width render (above) | 0 of 28 overflow |

**Not tested, and I cannot from here:** a physical Android phone; real Supabase login (email and Google); real Razorpay or Dodo accounts; the live Cloudflare deploy of the Worker; real email delivery; any load test; the AdSense behaviour.

## 7. Can it carry 100,000 users?

**Designed to, with two paid upgrades. Not load-tested.**

- **Scales by design:** the site, scripts, `feed.json` and `pool.json` are static files from Cloudflare's network. More visitors do not add server work. Ranking runs in each person's browser. The Worker only handles pricing, checkout, cancel and webhooks.
- **Rough load at 100,000 members (30,000 active a day):** about 24 GB of daily downloads (served by Cloudflare), about 5 database calls per second on average, and a few thousand payment events a month. These are estimates, not measurements.
- **Where the limits are:**

| Component | Free limit | At 100,000 users |
|---|---|---|
| Supabase | 50,000 monthly users; 500 MB database; pauses when idle | **Pro, $25 a month** (100,000 users included, bigger database, no pause) |
| Login emails | The built-in sender is tiny | Your own email provider; check its daily limit |
| Worker | 100,000 requests a day | Only pricing, checkout and webhooks count, so usually fine; Workers Paid ($5) if not |
| GitHub Actions | about 2,000 minutes a month (verify) | The 6-hourly robot uses about 360–600 |
| Data | 100,000 profiles of about 3 KB ≈ 300 MB | Fits Pro comfortably |

- **Run the load test** (free tool k6): `k6 run loadtest/k6-static.js`. It ramps to 2,000 simultaneous visitors on the public pages only. Never point it at payment endpoints.
- **Weak spots to fix as you grow:** `pool.json` is a public file (so the READ/WATCH limits are display-level), and the profile is saved on every change. Both are on the next-build list.

## 8. Emergency switches

| Problem | Fix |
|---|---|
| Paywall locking people out | In `public/config.js` set `paywall:false` and commit. Nobody is blocked |
| A bad deploy | Cloudflare → Workers & Pages → binglesignal → Deployments → roll back to the last good one |
| Payments misbehaving | Delete that rail's secrets in Cloudflare. The page shows "opening soon" |
| Launch cohort needs more trial time | `update public.subscriptions set trial_ends_at = trial_ends_at + interval '2 days' where status = 'trialing';` (add a `created_at` filter to target a group) |
| Empty or stale feed | The health check emails you (and Telegram, if set up). Run "Refresh briefing" manually |

## 9. Known issues and decisions for you

1. Google News is still about 64% of story links, and there are no primary sources yet (the Part 3 gate G1 has not passed).
2. The executive-grade layer is not in this build (§0).
3. The AdSense script is still in `index.html`. Keep Auto ads **off**, and keep ads out of the member product.
4. The legal pages are plain-language drafts. Have a lawyer review them, and fill in the Grievance Officer name in `contact.html`.
5. `config.js`: `x`, `instagram` and `youtube` are empty.
6. No sign-up bot protection yet (Cloudflare Turnstile is planned), so repeat trials are possible.
7. Yearly plans need all four plan IDs and links; until the monthly ones exist the page shows "opening soon".

## 10. Next build, in order

1. Primary sources, source tiers and original links; replace Google News. 2. "Why it matters" lines and the Principal Brief. 3. Turnstile, trial reminder emails and the day-5 email. 4. Installable web app (PWA) and offline cache. 5. Gate the full `pool.json` behind login. 6. Alerts, meeting prep and Deep Dives.
