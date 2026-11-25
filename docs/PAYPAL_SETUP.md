# PayPal setup (about 45 minutes)

PayPal is the first choice on the checkout page: **Pay $5 a month via PayPal**, with **Choose another option** underneath.
That second button opens the same Razorpay screens you have today. Razorpay code, plans and webhooks are not changed.

Until you complete step 7, PayPal stays hidden and the pricing page works exactly as before.

## Read this first: PayPal and customers in India

PayPal in India is built for international payments. An Indian PayPal account paying an Indian business is a domestic payment, and PayPal may refuse it.
So PayPal will work best for customers outside India, and Indian customers may need "Choose another option" (UPI, cards, rupees).
Watch the first few Indian attempts after launch. If they fail, ask for a one-line change that shows Razorpay first when the visitor is in India.

## 1. Create the PayPal app (keys)

1. Go to developer.paypal.com and log in with your verified business account.
2. Apps & Credentials, switch the toggle to **Live**, then **Create App**. Name it `BingleSignal`.
3. Under Features, make sure **Subscriptions** is ticked, and save.
4. Copy the **Client ID** and **Secret**. Keep them private.

## 2. Create the $5 monthly plan

1. In your PayPal business dashboard open **Subscriptions** (menu names can differ slightly: look for "Pay & Get Paid" then "Subscriptions").
2. Create a product: `BingleSignal Briefing`, type Digital goods or service.
3. Create a plan on that product:
   - Billing cycle: every 1 month, **no end** (unlimited cycles).
   - Price: **$5.00 USD**. It must match `price.usd` in `public/config.js`.
   - **No free trial on the plan.** The website gives the free days itself.
   - Setup fee: none. Turn on "automatically bill outstanding balance" and allow 3 failed payments.
4. Copy the **Plan ID**. It starts with `P-`.

## 3. Add the webhook

1. In the same app (Live) scroll to **Webhooks** and **Add Webhook**.
2. URL: `https://binglesignal.com/api/webhooks/paypal`
3. Tick these events:
   - Billing subscription: activated, re-activated, updated, suspended, cancelled, expired, payment failed
   - Payment sale: completed, refunded, reversed
4. Save, then copy the **Webhook ID** shown for it.

## 4. Update the database

Supabase, then SQL Editor, paste the whole of `supabase/015_paypal.sql`, then Run. It is safe to run twice.

## 5. Add the four secrets in Cloudflare

Workers & Pages, then your Worker, Settings, Variables and Secrets. Add each as a **Secret**:

| Name | Value |
|---|---|
| `PAYPAL_CLIENT_ID` | Client ID from step 1 |
| `PAYPAL_CLIENT_SECRET` | Secret from step 1 |
| `PAYPAL_WEBHOOK_ID` | Webhook ID from step 3 |
| `PAYPAL_PLAN_LITE_MONTHLY` | Plan ID from step 2 (`P-...`) |

Optional: `PAYPAL_ENV` = `sandbox` while testing with sandbox keys (leave it out for live). `SITE_URL` only if you test on a address other than binglesignal.com.

## 6. Deploy the code

Copy the files from this package over your project (same folders), then deploy the way you normally do (`npm run deploy`, or push to GitHub).
Files: `worker/src/paypal.js` (new), `worker/src/index.js`, `public/premium.js`, `public/config.js`, `public/privacy.html`, `public/terms.html`, `public/trust.html`, `supabase/015_paypal.sql` (new), tests.

## 7. Check it is switched on

Open `https://binglesignal.com/api/health`. You should see `"paypal": true` inside `rails` and `"paypal_mode": "live"`.
If `paypal` is `false`, one of the four secrets is missing or misspelled.

## 8. Test before real customers

Best: do a full run in **sandbox** first. Create sandbox keys, a sandbox plan and a sandbox webhook, set `PAYPAL_ENV=sandbox`, and pay with a sandbox buyer account (developer.paypal.com, Testing Tools, Sandbox Accounts).
Then switch to live and run one real $5 payment from an account that is not in India:

1. Sign up on the site with a test email, open Pricing, press **Subscribe**.
2. Press **Pay $5.00 a month via PayPal** and approve on PayPal.
3. You return to the site, see "Confirming your payment with PayPal", then the welcome screen.
4. In Supabase, table `subscriptions`: `provider = paypal`, `status = active`, `current_period_end` about a month ahead.
5. In your Account page press **Cancel subscription**: PayPal shows the agreement cancelled and the site says you keep access until the period ends.
6. Refund the test payment in PayPal. The webhook sets the row to `expired`.

A customer who subscribes **during the free trial** is not charged until the trial ends. They see "You are subscribed" with the first payment date.

## Where to look when something is wrong

- Cloudflare, your Worker, Logs: search for `PayPal`. Only PayPal's error name is logged, never keys.
- PayPal developer dashboard, your app, Webhooks: shows each delivery and lets you resend it.
- Customer paid but plan not active: resend the `PAYMENT.SALE.COMPLETED` webhook from the PayPal dashboard.

## Switching PayPal off

Delete the `PAYPAL_PLAN_LITE_MONTHLY` secret. The PayPal button disappears and the site is back to Razorpay only. Existing PayPal subscribers keep being billed by PayPal and still unlock access through the webhook.

## Good to know

- PayPal cancel stops billing immediately; access continues until the date already paid for.
- The nightly reconcile job only checks Razorpay. PayPal state arrives through webhooks.
- No change is needed in `public/_headers`: the customer is sent to PayPal's own page, no PayPal script runs on your site.
