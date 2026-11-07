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
| `EMAIL_AI_PROVIDER` | `anthropic` or `openai_compatible` |
| `EMAIL_AI_API_KEY` | Paid provider API key approved for public-news text |
| `EMAIL_AI_MODEL` | The chosen provider model |
| `EMAIL_AI_ENDPOINT` | OpenAI-compatible HTTPS endpoint; leave empty for Anthropic |
| `YOUTUBE_API_KEY` | Optional; leave empty if video keyword search is not used |

Use the same approved paid AI provider used for the email summarizer. Do not copy any key into `public/config.js`, a committed file, or GitHub variables.

## Checking source feeds

From VS Code, open **Terminal** → **New Terminal**, then run:

```text
node scripts/ingest.mjs --check-feeds
```

The check prints `OK`, `RETRY`, or `DROP` with status for each configured/generated feed and exits without publishing. Normal ingestion skips unavailable feeds and records successful source counts. In the latest completed check, **204 of 217 feeds returned OK, 13 were transient (timeouts, HTTP 429, or HTTP 500), and 0 were dead**. Retriable examples included VentureBeat (429), the European Commission (timeout), Federal Register (500), and several Google News searches (timeouts); they were kept because these responses do not prove the feeds are permanently dead.

Earlier checks identified dead feeds, which were removed: Entrackr and CNBC's YouTube RSS endpoint (404); the Hacker News RSS endpoint also returned 419 and is not used because Hacker News is fetched through its API. Feed availability can change; rerun the command before launch for a fresh per-feed report.

To run ingestion manually, use **GitHub → Actions → Refresh briefing → Run workflow**. The workflow writes results to Supabase and updates only the small public teaser; it no longer commits a complete `pool.json`.

The */15 Worker cron composes one timezone-aware daily edition per due account. Lite editions contain up to 10 stories; Pro editions contain up to 15. The edition slot key makes repeated cron calls idempotent. `GET /api/edition/latest` and `POST /api/feedback` are authenticated and user-scoped.
