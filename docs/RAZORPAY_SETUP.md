# Razorpay setup: $5 a month worldwide, rupees + GST in India

**What is already built:** a Razorpay *Subscriptions* flow (monthly auto-renewal). The browser never decides who has paid. Razorpay calls your webhook, the Worker checks its signature, and only then is the account unlocked.

**What this change adds**

| | What the customer sees | What is charged |
|---|---|---|
| Pricing page, everyone | `$5 / month`. No GSTIN box, no currency switch. | nothing yet |
| Checkout, outside India | straight to Razorpay | `$5.00` from your USD plan |
| Checkout, India | a choice: **Pay ₹522 in rupees** (shows `$5 x today's rate + 18% GST`) or **Pay $5.00 in US dollars** | rupees: `quantity` x a 1-rupee plan, fixed when they subscribe. Dollars: your USD plan |

Rates come from free daily reference rates (Frankfurter/ECB, then ExchangeRate-API). They update once per business day, cached for an hour. That is "live" at the level the free sources allow.

---

## 1. Where things are edited

| What you want to change | File | What to edit |
|---|---|---|
| Words on the pricing page (heading, plan name, tagline, the bullets of what a subscriber gets, "coming soon" bullets) | `public/config.js` | the `plan:{ ... }` block |
| The price | **three places that must match**: `public/config.js` (`price.usd`), `worker/src/pricing.js` (`USD_PRICE`), and the amount of the Razorpay USD plan. A test fails if the first two differ | |
| GST percentage | Cloudflare secret `GST_PERCENT` (empty = 18, `0` = off) | |
| Keys, plan IDs, webhook secret | Cloudflare (step 3). **Never** in code, never in `config.js`, never in GitHub | |

## 2. Razorpay dashboard (start in **Test Mode**, toggle at the top)

1. **Account & Settings -> API Keys -> Generate Test Key.** You get a Key ID (`rzp_test_...`) and a Key Secret (shown once).
2. **Subscriptions -> Plans -> Create Plan**, twice:
   - **INR unit plan:** Billing frequency *Monthly*, every *1* month, amount **INR 1.00**. Copy its `plan_...` ID -> `RAZORPAY_PLAN_LITE_MONTHLY`.
   - **USD plan:** Monthly, amount **USD 5.00**. Copy its ID -> `RAZORPAY_PLAN_LITE_MONTHLY_USD`.
   - Your existing INR 299 plan is not used any more. Leave it alone. The Worker refuses any INR plan that is not exactly INR 1.
   - If Razorpay will not let you create a USD plan, international payments are not switched on for your account yet (section 5).
3. **Account & Settings -> Webhooks -> Add New Webhook**
   - URL: `https://binglesignal.com/api/webhooks/razorpay`
   - Secret: invent a long random string (this becomes `RAZORPAY_WEBHOOK_SECRET`)
   - Tick exactly these events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused`, `subscription.resumed`, `subscription.updated`, `payment.failed`, `payment.refunded`, `refund.created`.
   - Test Mode and Live Mode have **separate** webhooks. You will repeat this in Live Mode.

## 3. Cloudflare (Workers & Pages -> binglesignal -> Settings -> Variables and Secrets)

Add each of these as type **Secret** (Secrets survive deploys; plain Variables can be wiped by a Git deploy):

| Name | Value |
|---|---|
| `RAZORPAY_KEY_ID` | `rzp_test_...` (later `rzp_live_...`) |
| `RAZORPAY_KEY_SECRET` | the Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | the string from step 2.3 |
| `RAZORPAY_PLAN_LITE_MONTHLY` | the INR unit plan ID |
| `RAZORPAY_PLAN_LITE_MONTHLY_USD` | the USD plan ID |
| `GST_PERCENT` | optional: `0` if you do not have a GSTIN yet |

Locally, copy `.dev.vars.example` to `.dev.vars` (already git-ignored) if you want to run the Worker on your computer.

## 4. Test it (Test Mode, no real money)

1. Open `https://binglesignal.com/api/health`. You should see `"razorpay_inr": true` and `"razorpay_usd": true`.
2. Open `https://binglesignal.com/api/quote` from India. You should see `usd: 5` and an `inr` block with the rate and `total_inr`.
3. Sign in with a test account -> **Pricing -> Subscribe**. In India you see the two-button choice with the breakdown. Choose rupees.
4. Pay with a Razorpay test card (list: razorpay.com/docs/payments/payments/test-card-details). Choose "Success" on the test bank page.
5. Check: Razorpay Dashboard -> **Subscriptions** shows the new subscription with the total (e.g. ₹522); **Webhooks -> logs** show `200`; the site's Account page says your plan is active.
6. Repeat with a VPN or a non-Indian browser location (or just pick "US dollars") to test the USD path.

## 5. Going live and collecting from customers outside India

1. In the Razorpay dashboard, request **International Payments** (look under Account & Settings / Payment Methods; the menu label changes, so search "International" or ask Razorpay support from the dashboard's help button). They check your website and business details. Your site already has Terms, Privacy and Refund pages, which they look for.
2. **Ask Razorpay in writing to confirm that international *recurring* card payments in USD are enabled for your account.** International one-time payments and international subscriptions are separate switches. Razorpay's own guidance says to confirm this before launch.
3. Customers outside India pay by international card. UPI and netbanking are India-only. Money is settled to your bank account in INR.
4. In **Live Mode** repeat steps 2.1 to 2.3 (live keys, both plans, live webhook), then replace the five Cloudflare secrets with the live values. Test and live plan IDs are different.
5. Run one real purchase on your own card and refund it, before announcing.

### Tax notes (not tax advice, confirm with a chartered accountant)
- You may only charge GST if you hold a GSTIN. Until then set `GST_PERCENT=0`. Charging GST without registration is not allowed.
- Sales to customers outside India are normally treated as exports of services (generally zero-rated), but conditions apply, so ask your CA.
- Customers in the EU, UK and some other countries can have local VAT / sales-tax rules for digital services. Razorpay is a payment gateway, not a Merchant of Record, so those obligations stay with you. If that becomes a burden, a Merchant of Record (Paddle, Lemon Squeezy, Polar) is the usual alternative for the global side.

## 6. If something looks wrong

| Symptom | Cause |
|---|---|
| Pricing page says "Payments opening soon" | the secret for that currency is missing or empty. Check `/api/health` |
| Checkout says "Rupee billing is not set up correctly" | `RAZORPAY_PLAN_LITE_MONTHLY` is not exactly a INR 1.00 monthly plan |
| Checkout says "live rupee price is unavailable" | both free rate sources failed. Set `FX_FALLBACK_USD_INR` or let customers pay in dollars |
| Paid, but the account stays locked | the webhook is not arriving or its secret is wrong. Razorpay -> Webhooks -> logs |
| After a deploy a setting vanished | it was a plain Variable, not a Secret. Re-add it as a Secret |
