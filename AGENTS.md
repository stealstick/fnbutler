# Project Rules

This repo is a monorepo with **two codebases**. Read the right rulebook before
touching either:

| Path | What | Rulebook |
|---|---|---|
| `butler/` | Production Next.js web app "keystone" (target-price / consensus comparison, Cloud Run + Cloud SQL Postgres) | `butler/CLAUDE.md` |
| `fnpipe/` | Python collector for fnguide.com research PDFs (legacy/local pipeline, Postgres) | root `README.md` + "Python collector" below |

Everything under `butler/**` is the live product. `fnpipe/` is the original
local PDF pipeline — still functional, but production scheduling is butler's
(`butler/docs/SCHEDULES.md`), not fnpipe's crontab.

## Git workflow

- Default branch is `main`. There is no PR gate — when a task is done and its
  quality gate passes, **commit and push to `main` directly**; don't wait to be
  asked. (Docs-only changes are safe: `*.md` edits never trigger the deploy.)
- Group related edits into one commit with a clear message. End commit messages
  with the `Co-Authored-By` trailer.
- Before committing app code, run the quality gate for that codebase (see below).

## Development

- The main development rulebook (architecture, DB access, client patterns,
  quality gates) is `butler/CLAUDE.md`. Read it before changing app code.
- Data flow is always **client component -> API route -> `src/lib/repo.ts`**.
  Adding a filter/column/screen touches all three layers; never put SQL in a
  route or hit the DB from a component.
- Postgres is the only datastore. Parameterize every query via `db.ts` helpers
  and the repo `push()` binder. Numbers/formatting go through `src/lib/format.ts`.
  Korean UI, up=red / down=blue.
- Before finishing: `npx tsc --noEmit` (or `npm run build`) and `npm run lint`
  must pass; add `node:test` specs under `src/lib/*.test.ts` for pure logic.

## Python collector (fnpipe)

Rules for `fnpipe/**` (full context in root `README.md`). Postgres only, via
`DATABASE_URL` (`postgresql+psycopg://…`).

- **Idempotent by `fn_rpt_id`.** `sync`/`feed`/`reparse` re-run daily and only
  process new reports. Never rewrite an existing report row in place — reports
  are immutable; "latest value" is the `v_latest_estimates` view. Revisions
  accumulate as new rows.
- **One facts table, long format.** Don't add per-company tables. Every metric
  is one `report_financials` row keyed by `(report, period, metric)` with a
  canonical `metric` code and the original text in `raw_label`.
- **Label mapping lives in `fnpipe/labels.py`** (one dict). A new label variant
  is one line there, then `reparse` the affected report — don't special-case it
  in the parser.
- **Amounts normalized to 억원** (`unit=KRW_100M`); ratios/원-unit values kept
  as-is. Load source values verbatim even when the source is wrong (flag later,
  don't "correct").
- **Parser (`fnpipe/parser.py`) has guard rails** — keep them: fill-rate gate
  (<40% → drop table), non-period header columns discarded, unit priority
  (row label > table caption > page caption). Prefer fixing mapping/heuristics
  over loosening these.
- **`--ai` vision fallback is selective** (only reports the coordinate parser
  handles poorly), to control cost — don't call it per report. Backend is
  Anthropic SDK when `ANTHROPIC_API_KEY` is set, else `claude` CLI headless.
- **Auth**: session cookie is short-lived; auto-relogin needs
  `FNGUIDE_USER_ID/PW` in `.env`. Mind the 20-min duplicate-login lockout when
  developing (don't log in repeatedly in a tight loop).

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
