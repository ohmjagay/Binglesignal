# BingleSignal v4 — Implementation guide (no coding needed)

**What you are adding:** a sign-up gate (Google or email) behind the **Tune my briefing** button, then two personal pages: **READ** (up to 200 ranked stories and posts) and **WATCH** (up to 30 ranked videos). Also: a bigger geography and interest picker (all countries, 56 interests), a legal footer, no scrollbars.

**Time:** about 45 minutes the first time (most of it is Google and Supabase settings). **Cost:** ₹0.

Do the steps **in order**. Each step ends with a check. If a check fails, jump to *Troubleshooting* at the bottom.

---

## Step 1 — Replace the files on GitHub (browser only)

This zip has **no outer folder** (that is what broke the last upload). After you extract it, the folder you open already shows the files.

1. Right-click `binglesignal-v4.zip` → **Extract All** → **Extract**. Open the extracted folder. You must see these 7 items together: `.github`, `public`, `scripts`, `package.json`, `supabase.sql`, `UPGRADE-V4.md`, `wrangler.toml`. If you only see one folder, double-click into it until you do.
2. In Chrome open `https://vscode.dev/github/omjagay/binglesignal`.
3. In the left **Explorer** list click the first item, hold **Shift**, click the last item (selects everything). Right-click → **Delete** → confirm. The list is now empty.
4. Press **Ctrl+A** in the folder from item 1 and drag all 7 items into the empty Explorer list. If asked "Copy files?", click **Copy**.
5. **Check:** the Explorer shows exactly those 7 items, and **no** folder called `binglesignal-v4`. Open `public`: it must contain `_headers`, `app.js`, `config.js`, `copyright.html`, `index.html`, `privacy.html`, `style.css`, `taxonomy.js`.
6. Click the **Source Control** icon in the left bar, type `BingleSignal v4` in the message box, click **Commit & Push**.
7. Open Cloudflare → **Workers & Pages** → **binglesignal** → **Deployments**. Wait for **Success** (1–3 minutes). Do not press *Retry build*.

At this point the public home page already works. Sign-up will not work until Step 2.

---

## Step 2 — Supabase (accounts and saved profiles)

Your Supabase project is the one the old BingleSignal used: `bpgstmqbbvvlibgcssvq`.

**2.1 Open it.** Go to `https://supabase.com/dashboard`, open your project. The address bar must contain `bpgstmqbbvvlibgcssvq`. (If your project has a different ID: **Project Settings → API**, copy the *Project URL* and the *Publishable key*, then on GitHub open `public/config.js`, click the pencil icon, replace the two values, **Commit changes**.)

**2.2 Create the profile table.** Left sidebar → **SQL Editor** → **New query**. On GitHub open `supabase.sql`, click the copy icon, paste it into the editor, click **Run**. Expected: *Success. No rows returned.* (It is safe to run twice.)

**2.3 Email sign-up.** **Authentication** → **Sign In / Providers** → **Email**. Make sure it is **Enabled**, and switch **Confirm email** **OFF** → **Save**.
*Why:* with Confirm email ON, Supabase's built-in mailer sends only a few emails per hour, so real users would not get their confirmation. OFF = accounts work instantly. Turn it on later when you add your own mail service.
Also check that **Allow new users to sign up** is ON (same page or **Authentication → Sign In / Providers → User Signups**).

**2.4 Allowed addresses.** **Authentication** → **URL Configuration**:
- **Site URL:** `https://binglesignal.com`
- **Redirect URLs** → **Add URL**: `https://binglesignal.com/**` and, if you use it, `https://www.binglesignal.com/**` → **Save**.

**2.5 Google sign-in.** **Authentication** → **Sign In / Providers** → **Google**. If it is already switched on and shows a Client ID, skip to Step 3. Otherwise:
1. Open `https://console.cloud.google.com` → project selector (top bar) → **New project** → name `BingleSignal` → **Create**.
2. Menu → **APIs & Services** → **OAuth consent screen** (also called *Google Auth Platform*). Fill: app name `BingleSignal`, your support email, audience **External**, app home page `https://binglesignal.com`, **Privacy policy** `https://binglesignal.com/privacy`, authorised domain `binglesignal.com`, developer contact email → **Save**. Then **Publish app** so anyone with a Google account can sign in (basic sign-in needs no Google review).
3. **Credentials** (or *Clients*) → **Create credentials / Create client** → type **Web application**.
   - **Authorised JavaScript origins:** `https://binglesignal.com`
   - **Authorised redirect URIs:** copy the *Callback URL (for OAuth)* shown in the Supabase Google panel. It looks like `https://bpgstmqbbvvlibgcssvq.supabase.co/auth/v1/callback`.
   - **Create**, then copy the **Client ID** and **Client secret**.
4. Back in Supabase → Google panel → switch **Enable** on → paste Client ID and Client secret → **Save**.

**Check:** nothing to see yet; you test it in Step 5.

---

## Step 3 — Build the first personal feed

The robot starts by itself after Step 1.
1. GitHub → your repo → **Actions** tab → **Refresh briefing**. Yellow dot = running, green tick = done (2–5 minutes this time, it reads ~290 sources). If nothing is running: click **Refresh briefing** (left) → **Run workflow** → green **Run workflow**.
2. **Check:** in the repo, folder `public` now also contains **`feed.json`** and **`pool.json`**. Cloudflare publishes again by itself (another 1–3 minutes).
3. Want to see what worked? Actions → the run → **ingest** → **Run node scripts/ingest.mjs**. Lines starting `ok` worked, `skip` did not. The last line reads like `pool.json: 2600 stories + 400 videos`. Some `skip` lines are normal (see *Known limits*).

---

## Step 4 — YouTube keyword search for WATCH (free, strongly recommended)

Without this, WATCH uses about 57 hand-picked channels (Bloomberg Originals, CNBC, TED, Vogue, T-Series, HYBE and more). With it, the robot also searches YouTube for each of the 56 interests, so niche videos (travel, beauty, fashion, K-pop) appear.
1. Google Cloud (same project) → **APIs & Services** → **Library** → search **YouTube Data API v3** → **Enable**.
2. **Credentials** → **Create credentials** → **API key** → copy it. Click the key → **API restrictions** → **Restrict key** → tick **YouTube Data API v3** → **Save**.
3. GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Name: `YOUTUBE_API_KEY`. Secret: paste the key. **Add secret**.
4. **Actions** → **Refresh briefing** → **Run workflow**. In the log you should see `ok   YouTube keyword search`.

Free quota is 10,000 units a day; this uses about 5,600.

---

## Step 5 — Test it like a real user (the "Bill Tret" journey)

Use a private/incognito window.
1. Open the site. The page scrolls with no scrollbars.
2. Name: `Bill Tret`. Geography: tap **United States** and **Europe**; tap **+ Add geography**, search a country, tap it, **Done**.
3. Interests: tap **More +N**, then **Your interests ›**. Add Funding & VC, Climate Change, Media & Entertainment, Markets → **Done**.
4. Tap **Tune my briefing**. A sign-up window opens with the name filled in.
5. **Create account** with email and a password (6+ characters), or **Continue with Google**. You land on **READ**.
6. READ: 20 stories first, more load as you scroll, up to 200. Stories that touch several of your interests rank first ("Touches 4 interests"). The source pills (News, Reddit, Hacker News, Blog) filter the list.
7. Tap ♥ Like, ⚑ Save, ✕ Less like this: the stories you have not seen yet re-rank immediately.
8. **WATCH**: up to 30 videos. Tap one to play it; close it. Your watch time teaches the feed.
9. **Sign out**, then **Sign in** again: your name, geography and interests are back (saved in Supabase). In Supabase → **Table Editor** → `bs_profiles` you will see one row per user.

---

## Step 6 — Company email and social handles (when you have them)

GitHub → `public/config.js` → pencil icon → fill the quoted values, for example `email:'hello@binglesignal.com'`, `x:'binglesignal'`, `linkedin:'binglesignal'`, `instagram:'binglesignal'`, `youtube:'binglesignal'` → **Commit changes**. They appear in the footer and on the Privacy and Copyright pages by themselves. Leave a value as `''` to hide it.

---

## How the ranking works (plain English)

It follows the same blueprint as the big short-video apps, at small scale:

1. **Candidate pool (the robot, every 6 hours).** About 3,000 stories and 600 videos from ~290 sources. Each item is tagged with interests and country, similar stories are merged into one, and each gets a base score from freshness, source trust and social proof (outlets covering it, upvotes, views per hour).
2. **Your ranking (in your browser).** For every item the engine predicts four things: *click, like, save, skip*, and combines them: **score = click + 2×like + 3×save − 1.6×skip**. It looks at how many of your interests the item touches (weighted by your priority order, so touching all of them wins), your geography, freshness, social proof, source quality, and the keywords and sources you have rewarded.
3. **Learning.** Every like, save, hide, open and watch updates those predictions and your topic, keyword and source preferences straight away. Quietly scrolling past never lowers an interest you declared; only ✕ *Less like this* does.
4. **Diversity and exploration.** One item per story, no long runs from the same source or topic, and about 1 slot in 6 (less as it learns you) tests something outside your declared interests, marked *Explore*.
5. **Fresh every visit.** Items you have already seen drop down next time.

**Honest limit:** it learns only from each person's own behaviour. It does not have the billions of signals the big apps have, so early results depend on the interests chosen and improve with use.

---

## Known limits (and the plan)

- **LinkedIn and X (Twitter) are not included.** LinkedIn has no open feed; X's read access is a paid API. Scraping either breaks their terms and can get you blocked. Add them later through their official paid APIs: the pipeline already tags every item by platform, so they slot into `scripts/ingest.mjs` without redesign.
- **Reddit** is read through its public feeds, which Reddit often blocks for GitHub's servers (many `skip r/...` lines are normal). Reliable Reddit needs Reddit's API credentials, and a business needs Reddit's approval.
- **200 stories and 30 videos** are the caps you asked for (`readCap`, `watchCap` in `public/config.js`). Infinite scroll is the paid version.
- English-language sources only for now. No password-reset email until you add your own mail service.
- The **Privacy Policy** and **Copyright** pages are good-faith starting texts. Have a lawyer review them before you grow.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| Cloudflare log: `ENOENT … package.json` | Files went one folder too deep. Redo Step 1, items 3–6. |
| "Unsupported provider: provider is not enabled" | Step 2.5: switch Google on in Supabase. |
| Google says `redirect_uri_mismatch` | The *Authorised redirect URI* in Google Cloud must be exactly Supabase's Callback URL (Step 2.5, item 3). |
| After Google you return to the home page and the sign-in window shows an error | Step 2.4: add `https://binglesignal.com/**` to Redirect URLs. |
| "Signups not allowed" | Step 2.3: switch **Allow new users to sign up** on. |
| "Email rate limit exceeded", or confirmation mails never arrive | Step 2.3: **Confirm email** OFF. |
| Profile does not save, or Supabase shows "relation bs_profiles does not exist" / "row-level security" | Run `supabase.sql` again (Step 2.2). |
| "Database error saving new user" | Copy the exact message and send it to me. It comes from a rule left by the old app. |
| READ says "being prepared" | Step 3 has not finished. |
| WATCH is short, or the Action log shows `skip` for a YouTube channel | That channel id is wrong or blocked: delete its line in `scripts/ingest.mjs`, or add the API key (Step 4). |
| A video says "Video unavailable" | The owner disabled embedding. Use **Open on YouTube**. |
| Old design still shows | Press **Ctrl+Shift+R**, then check Cloudflare Deployments says Success. |
| Green tick on GitHub but the site has no new data | Edit any tiny thing (add a space in `UPGRADE-V4.md`), **Commit changes**. That starts a fresh build. |

---

## Where things live

| File | What it does |
|---|---|
| `public/index.html` | Public home page and the Tune my briefing panel |
| `public/app.js` | Sign-in, pickers, READ and WATCH, the ranking engine |
| `public/taxonomy.js` | The 56 interests and all countries (add an interest = add one line) |
| `public/config.js` | The only file you edit: keys, caps, email, social handles |
| `public/style.css`, `privacy.html`, `copyright.html`, `_headers` | Design, legal pages, caching rules |
| `scripts/ingest.mjs` | The robot: reads sources, tags, merges, ranks, writes `feed.json` and `pool.json` |
| `.github/workflows/refresh-briefing.yml` | Runs the robot every 6 hours |
| `supabase.sql` | Creates the profile table (run once) |
| `wrangler.toml`, `package.json` | Cloudflare settings. Do not edit. |
