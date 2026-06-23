# Project Rules

## Scheduled Jobs

- The source of truth for production cron-like automation is
  `butler/docs/SCHEDULES.md`.
- Production recurring jobs use Cloud Scheduler -> Cloud Run Job.
- `.github/workflows/refresh.yml` is manual-only. Do not add or reintroduce a
  GitHub Actions `schedule:` trigger unless `butler/docs/SCHEDULES.md` and
  `butler/DEPLOYMENT.md` are updated in the same change.
- When changing schedule names, cron expressions, target jobs, job args, retry
  policy, or default backfill limits, update all of these together:
  `.github/workflows/deploy.yml`, `butler/scripts/gcloud-postgres-bootstrap.sh`,
  `butler/docs/SCHEDULES.md`, `butler/DEPLOYMENT.md`, and
  `butler/CLAUDE.md`.
- Keep StockAnalysis in its separate slow backfill job. The daily refresh job
  should keep `--no-stockanalysis-nasdaq-estimates` to avoid duplicate calls.
