# keystone Scheduled Jobs

This is the source of truth for production cron-like automation.

Production recurring jobs are managed by **Cloud Scheduler -> Cloud Run Job**.
`.github/workflows/refresh.yml` is manual-only and must not be treated as a
production cron source.

## Production Schedules

| Scheduler job | Schedule (KST) | Cron | Target Cloud Run Job | Command | Purpose | Retry policy |
|---|---:|---|---|---|---|---|
| `fnbutler-refresh-weekdays` | Daily 18:30 | `30 18 * * *` | `fnbutler-refresh` | `npx tsx scripts/refresh-daily.ts --no-stockanalysis-nasdaq-estimates` | Daily company/report/quote refresh. Runs regular domestic refresh plus non-StockAnalysis US-listed enrichments. StockAnalysis is excluded to avoid duplicate calls. | Cloud Scheduler `--max-retry-attempts 1`; Cloud Run Job `--max-retries 0`, `--task-timeout 7200` |
| `fnbutler-stockanalysis-backfill-6h` | Daily 02:10, 08:10, 14:10, 20:10 | `10 2,8,14,20 * * *` | `fnbutler-stockanalysis-backfill` | `npx tsx scripts/backfill-stockanalysis-nasdaq-estimates.ts` | Slow US-listed StockAnalysis backfill for actual/estimated financials, valuation fields, target consensus, and broker targets. Default 45 symbols per run, about 180 per day, so the current US-listed universe rotates in about 7 days. | Cloud Scheduler `--max-retry-attempts 0`; Cloud Run Job `--max-retries 0`, `--task-timeout 1800` |
| `fnbutler-news-refresh-2h` | Daily 07:15-23:15 every 2h | `15 7-23/2 * * *` | `fnbutler-news-refresh` | `npx tsx scripts/backfill-company-news.ts` | Rotating company news refresh. Korean companies use NAVER Search when credentials are configured; US-listed companies use StockAnalysis article feeds. Default 80 companies/run, 8 articles/company, 2h stale window. | Cloud Scheduler `--max-retry-attempts 0`; Cloud Run Job `--max-retries 0`, `--task-timeout 1800` |
| `fnbutler-calendar-weekly` | Saturday 08:00 | `0 8 * * 6` | `fnbutler-calendar-refresh` | `npx tsx scripts/refresh-daily.ts --calendar-only` | Weekly calendar refresh, including NASDAQ earnings calendar and DART provisional earnings notices when `DART_API_KEY` is configured. | Cloud Scheduler `--max-retry-attempts 1`; Cloud Run Job `--max-retries 0`, `--task-timeout 7200` |

Notes:

- `fnbutler-refresh-weekdays` is a historical name. Its current cron runs every
  day, not weekdays only.
- All schedules use `Asia/Seoul`.
- The deploy workflow creates or updates these Cloud Scheduler jobs.
- `/admin/schedules` shows these jobs in the web UI and lets an admin turn each
  job on/off. The on/off switch is stored in Postgres `scheduler_controls`, so a
  disabled job exits immediately even if Cloud Scheduler still invokes Cloud
  Run. When the Cloud Run runtime service account has `roles/cloudscheduler.admin`,
  the UI also attempts Cloud Scheduler pause/resume/run.
- `scripts/gcloud-postgres-bootstrap.sh` mirrors the same schedule definitions
  for one-shot stack bootstrap. Keep it in sync with `.github/workflows/deploy.yml`.
- If `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET` are absent, Korean company news is
  skipped and the news job still refreshes US-listed StockAnalysis news.

## Manual Backfill Workflow

`.github/workflows/refresh.yml` is a manual escape hatch. It has no `schedule:`
trigger.

Available modes:

| Mode | Target |
|---|---|
| `full` | `fnbutler-refresh` with the job's default args |
| `calendar-only` | `fnbutler-calendar-refresh` |
| `stockanalysis-nasdaq-estimates` | `fnbutler-stockanalysis-backfill`; supports `stockanalysis_limit`, `stockanalysis_symbol`, `stockanalysis_call_delay_ms`, `stockanalysis_jitter_ms` |
| `dart-financials`, `dart-2024-financials`, `dart-2025-financials` | `fnbutler-refresh` with DART financial backfill args |
| `fnguide-estimates` | `fnbutler-refresh` with FnGuide estimates backfill args |
| `wisereport-estimates` | `fnbutler-refresh` with WiseReport estimates backfill args |
| `nasdaq-companies` | `fnbutler-refresh` with US-listed company ingest args (historical mode name) |
| `fmp-nasdaq-estimates` | `fnbutler-refresh` with FMP US-listed estimates args |
| `seekingalpha-nasdaq-estimates` | `fnbutler-refresh` with Seeking Alpha US-listed estimates args |
| `yahoo-nasdaq-estimates` | `fnbutler-refresh` with Yahoo US-listed estimates args |
| `company-news` | `fnbutler-news-refresh` |

## Source Files

Update all of these together when changing production schedules:

- `.github/workflows/deploy.yml`
- `butler/scripts/gcloud-postgres-bootstrap.sh`
- `butler/docs/SCHEDULES.md`
- `butler/DEPLOYMENT.md`
- `butler/CLAUDE.md`
- `AGENTS.md`

## Verification

```bash
gh run list --workflow deploy.yml --limit 5

gcloud scheduler jobs list \
  --location asia-northeast3 \
  --project protein-test-469413

gcloud run jobs executions list \
  --job fnbutler-refresh \
  --region asia-northeast3 \
  --project protein-test-469413

gcloud run jobs executions list \
  --job fnbutler-stockanalysis-backfill \
  --region asia-northeast3 \
  --project protein-test-469413

gcloud run jobs executions list \
  --job fnbutler-news-refresh \
  --region asia-northeast3 \
  --project protein-test-469413

gcloud run jobs executions list \
  --job fnbutler-calendar-refresh \
  --region asia-northeast3 \
  --project protein-test-469413
```

Local `gcloud` may require re-authentication. If it cannot refresh credentials,
use the GitHub Actions run history and the GCP Console until local auth is fixed.

## Legacy Local Crontab Example

The repository root `README.md` contains an old local crontab example for the
Python FnGuide PDF pipeline. That is not part of the current keystone production
Cloud Run schedule unless a developer manually installed it on a local machine.
