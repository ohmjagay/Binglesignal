# Private briefing pool

The full story pool is no longer a static website file. GitHub Actions ingests the public-source RSS feeds, normalizes and deduplicates URLs, clusters stories, creates embeddings and validated story notes, then writes the pool to Supabase. Signed-in Lite/Pro users load their plan-limited pool from `/api/pool`; anonymous visitors only receive the small `public/feed.json` teaser. The existing browser ranking remains as a local fallback over the authenticated pool.

## Database setup

In Supabase, open **SQL Editor** → **New query**, paste all of `supabase/007_briefing_v2.sql`, and select **Run**. This creates private story-cluster, profile, edition, and feedback tables; expands `story_notes`; enables RLS; and grants data access only to the Worker service role.

## GitHub Actions settings

In GitHub, open the **ohmjagay/Binglesignal** repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add the following values:

| Secret name | Value |
|---|---|
| `SUPABASE_URL` | Supabase project URL from **Supabase → Project Settings → API** |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key from the same API page; never put this in public site configuration |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID shown in the Workers & Pages account overview |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token scoped to this account with **Account → Workers AI → Read** (Workers AI inference permission) |
| `DEEPSEEK_API_KEY` | API key from platform.deepseek.com → API keys (the account needs a topped-up balance) |
| `DEEPSEEK_MODEL` | `deepseek-flash`, or the current model ID listed in DeepSeek's docs |
| `YOUTUBE_API_KEY` | Optional; leave empty if video keyword search is not used |

DeepSeek is the only AI provider. The email summarizer (currently paused) uses the same `DEEPSEEK_API_KEY`, stored as a Cloudflare secret. Do not copy any key into `public/config.js`, a committed file, or GitHub variables.

### How the notes are written

Every run, stories are ranked and the best ones are summarized first:

- The top `DEEP_SUMMARY_TOP` (default 120) stories are summarized from the real article text of their two most reliable sources (a short fetch; paywalled publishers are skipped). Only the short summary is stored, never the article text.
- Other stories are summarized from the headline and excerpt, in one or two sentences.
- Videos get a short "what it covers / Watch if…" note from the title and description (never a transcript).
- A run stops calling DeepSeek after `AI_TIME_BUDGET_MS` (13 minutes) or when it hits a fatal error (bad key, empty balance). Stories are always published; missing notes are added on the next run. A fatal AI error makes the workflow turn red so GitHub emails you.

Optional workflow variables (all have defaults): `MAX_NEW_NOTES` (500), `MAX_VIDEO_NOTES` (150), `DEEP_SUMMARY_TOP` (120), `AI_TIME_BUDGET_MS`.

## Checking source feeds

From VS Code, open **Terminal** → **New Terminal**, then run:

```text
node scripts/ingest.mjs --check-feeds
```

The check prints `OK`, `RETRY`, or `DROP` with status for each configured/generated feed and exits without publishing. Normal ingestion skips unavailable feeds and records successful source counts. In the latest completed check, **204 of 217 feeds returned OK, 13 were transient (timeouts, HTTP 429, or HTTP 500), and 0 were dead**. Retriable examples included VentureBeat (429), the European Commission (timeout), Federal Register (500), and several Google News searches (timeouts); they were kept because these responses do not prove the feeds are permanently dead.

Earlier checks identified dead feeds, which were removed: Entrackr and CNBC's YouTube RSS endpoint (404); the Hacker News RSS endpoint also returned 419 and is not used because Hacker News is fetched through its API. Feed availability can change; rerun the command before launch for a fresh per-feed report.

To run ingestion manually, use **GitHub → Actions → Refresh briefing → Run workflow**. The workflow writes results to Supabase. The small public teaser for the homepage is served live by the Worker at `/api/teaser` (the static `public/feed.json` is only a fallback; refresh it with `node scripts/ingest.mjs --write-teaser`).

The */15 Worker cron composes one timezone-aware daily edition per due account. Lite editions contain up to 10 stories; Pro editions contain up to 15. The edition slot key makes repeated cron calls idempotent. `GET /api/edition/latest` and `POST /api/feedback` are authenticated and user-scoped.
