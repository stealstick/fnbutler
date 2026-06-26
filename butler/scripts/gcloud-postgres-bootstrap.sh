#!/usr/bin/env bash
# Provision and deploy the low-cost Postgres production stack:
#   Cloud SQL db-f1-micro + Cloud Run service + Cloud Run Job + Cloud Scheduler.
#
# Required:
#   gcloud auth login
#   gcloud config set project protein-test-469413
#
# Optional env overrides:
#   PROJECT REGION SERVICE INSTANCE DB_NAME DB_USER DB_PASSWORD BASE_URL
#   GITHUB_DEPLOYER_SA TG_TOKEN_SECRET TG_WEBHOOK_SECRET DART_API_KEY_SECRET FMP_API_KEY_SECRET
#   SEEKING_ALPHA_NASDAQ_LIMIT SEEKING_ALPHA_BATCH_SIZE SEEKING_ALPHA_CALL_DELAY_MS SEEKING_ALPHA_USE_CURL SEEKING_ALPHA_COOKIE_SECRET
#   STOCKANALYSIS_JOB STOCKANALYSIS_SCHEDULER_JOB STOCKANALYSIS_NASDAQ_LIMIT STOCKANALYSIS_CALL_DELAY_MS STOCKANALYSIS_JITTER_MS
#   NEWS_JOB NEWS_SCHEDULER_JOB COMPANY_NEWS_LIMIT COMPANY_NEWS_DISPLAY COMPANY_NEWS_STALE_HOURS COMPANY_NEWS_CALL_DELAY_MS
#   NAVER_CLIENT_ID_SECRET NAVER_CLIENT_SECRET_SECRET
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${PROJECT:-protein-test-469413}"
REGION="${REGION:-asia-northeast3}"
SERVICE="${SERVICE:-fnbutler}"
JOB="${JOB:-fnbutler-refresh}"
CALENDAR_JOB="${CALENDAR_JOB:-fnbutler-calendar-refresh}"
STOCKANALYSIS_JOB="${STOCKANALYSIS_JOB:-fnbutler-stockanalysis-backfill}"
NEWS_JOB="${NEWS_JOB:-fnbutler-news-refresh}"
SCHEDULER_JOB="${SCHEDULER_JOB:-fnbutler-refresh-weekdays}"
CALENDAR_SCHEDULER_JOB="${CALENDAR_SCHEDULER_JOB:-fnbutler-calendar-weekly}"
STOCKANALYSIS_SCHEDULER_JOB="${STOCKANALYSIS_SCHEDULER_JOB:-fnbutler-stockanalysis-backfill-6h}"
NEWS_SCHEDULER_JOB="${NEWS_SCHEDULER_JOB:-fnbutler-news-refresh-2h}"
INSTANCE="${INSTANCE:-fnbutler-pg}"
DB_NAME="${DB_NAME:-butler}"
DB_USER="${DB_USER:-butler}"
DB_PASSWORD_SECRET="${DB_PASSWORD_SECRET:-fnbutler-db-password}"
BASE_URL="${BASE_URL:-https://fnbutler-l3why3suea-du.a.run.app}"
SEEKING_ALPHA_NASDAQ_LIMIT="${SEEKING_ALPHA_NASDAQ_LIMIT:-500}"
SEEKING_ALPHA_BATCH_SIZE="${SEEKING_ALPHA_BATCH_SIZE:-5}"
SEEKING_ALPHA_CALL_DELAY_MS="${SEEKING_ALPHA_CALL_DELAY_MS:-60000}"
SEEKING_ALPHA_USE_CURL="${SEEKING_ALPHA_USE_CURL:-1}"
STOCKANALYSIS_NASDAQ_LIMIT="${STOCKANALYSIS_NASDAQ_LIMIT:-45}"
STOCKANALYSIS_CALL_DELAY_MS="${STOCKANALYSIS_CALL_DELAY_MS:-7000}"
STOCKANALYSIS_JITTER_MS="${STOCKANALYSIS_JITTER_MS:-3000}"
STOCKANALYSIS_BROKER_TARGETS="${STOCKANALYSIS_BROKER_TARGETS:-1}"
COMPANY_NEWS_LIMIT="${COMPANY_NEWS_LIMIT:-80}"
COMPANY_NEWS_DISPLAY="${COMPANY_NEWS_DISPLAY:-8}"
COMPANY_NEWS_STALE_HOURS="${COMPANY_NEWS_STALE_HOURS:-2}"
COMPANY_NEWS_CALL_DELAY_MS="${COMPANY_NEWS_CALL_DELAY_MS:-500}"
BUCKET="${BUCKET:-protein-test-469413-fnbutler}"
REPO="${REPO:-cloud-run-source-deploy}"
SA_NAME="${SA_NAME:-fnbutler-runner}"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
GITHUB_DEPLOYER_SA="${GITHUB_DEPLOYER_SA:-gh-deployer@${PROJECT}.iam.gserviceaccount.com}"
TAG="$(date +%Y%m%d-%H%M%S)"
APP_IMG="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:${TAG}"
JOB_IMG="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${JOB}:${TAG}"
CONNECTION="${PROJECT}:${REGION}:${INSTANCE}"

echo "==> Enabling APIs"
gcloud services enable \
  sqladmin.googleapis.com run.googleapis.com cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com \
  --project "$PROJECT"

echo "==> Ensuring service account"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name "FnButler runtime" --project "$PROJECT"
fi
for role in roles/cloudsql.client roles/run.developer roles/run.invoker roles/iam.serviceAccountUser roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:${SA_EMAIL}" \
    --role "$role" \
    --quiet >/dev/null
done
if gcloud iam service-accounts describe "$GITHUB_DEPLOYER_SA" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --member "serviceAccount:${GITHUB_DEPLOYER_SA}" \
    --role roles/iam.serviceAccountUser \
    --project "$PROJECT" \
    --quiet >/dev/null
fi

echo "==> Ensuring Artifact Registry repository"
if ! gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPO" \
    --repository-format docker \
    --location "$REGION" \
    --description "Cloud Run images" \
    --project "$PROJECT"
fi

echo "==> Ensuring Cloud SQL Postgres instance (${INSTANCE})"
if ! gcloud sql instances describe "$INSTANCE" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud sql instances create "$INSTANCE" \
    --project "$PROJECT" \
    --database-version POSTGRES_16 \
    --edition enterprise \
    --tier db-f1-micro \
    --region "$REGION" \
    --availability-type zonal \
    --storage-type HDD \
    --storage-size 10 \
    --no-storage-auto-increase \
    --no-backup \
    --no-deletion-protection
fi

echo "==> Ensuring database and password secret"
if ! gcloud secrets describe "$DB_PASSWORD_SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 36 | tr -d '/+=' | head -c 32)}"
  printf "%s" "$DB_PASSWORD" | gcloud secrets create "$DB_PASSWORD_SECRET" \
    --replication-policy automatic \
    --data-file - \
    --project "$PROJECT"
elif [[ -n "${DB_PASSWORD:-}" ]]; then
  printf "%s" "$DB_PASSWORD" | gcloud secrets versions add "$DB_PASSWORD_SECRET" \
    --data-file - \
    --project "$PROJECT"
else
  DB_PASSWORD="$(gcloud secrets versions access latest --secret "$DB_PASSWORD_SECRET" --project "$PROJECT")"
fi

if ! gcloud sql databases list --instance "$INSTANCE" --project "$PROJECT" --format="value(name)" | grep -qx "$DB_NAME"; then
  gcloud sql databases create "$DB_NAME" --instance "$INSTANCE" --project "$PROJECT"
fi
if gcloud sql users list --instance "$INSTANCE" --project "$PROJECT" --format="value(name)" | grep -qx "$DB_USER"; then
  gcloud sql users set-password "$DB_USER" --instance "$INSTANCE" --password "$DB_PASSWORD" --project "$PROJECT"
else
  gcloud sql users create "$DB_USER" --instance "$INSTANCE" --password "$DB_PASSWORD" --project "$PROJECT"
fi

echo "==> Building and pushing images"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker build --platform linux/amd64 --target runner -t "$APP_IMG" "$ROOT"
docker build --platform linux/amd64 --target worker -t "$JOB_IMG" "$ROOT"
docker push "$APP_IMG"
docker push "$JOB_IMG"

ENV_VARS="PGHOST=/cloudsql/${CONNECTION},PGDATABASE=${DB_NAME},PGUSER=${DB_USER},BUTLER_BASE_URL=${BASE_URL},BUTLER_RATE_PER_MIN=80,SEEKING_ALPHA_NASDAQ_LIMIT=${SEEKING_ALPHA_NASDAQ_LIMIT},SEEKING_ALPHA_BATCH_SIZE=${SEEKING_ALPHA_BATCH_SIZE},SEEKING_ALPHA_CALL_DELAY_MS=${SEEKING_ALPHA_CALL_DELAY_MS},SEEKING_ALPHA_USE_CURL=${SEEKING_ALPHA_USE_CURL},STOCKANALYSIS_NASDAQ_LIMIT=${STOCKANALYSIS_NASDAQ_LIMIT},STOCKANALYSIS_CALL_DELAY_MS=${STOCKANALYSIS_CALL_DELAY_MS},STOCKANALYSIS_JITTER_MS=${STOCKANALYSIS_JITTER_MS},STOCKANALYSIS_BROKER_TARGETS=${STOCKANALYSIS_BROKER_TARGETS},COMPANY_NEWS_LIMIT=${COMPANY_NEWS_LIMIT},COMPANY_NEWS_DISPLAY=${COMPANY_NEWS_DISPLAY},COMPANY_NEWS_STALE_HOURS=${COMPANY_NEWS_STALE_HOURS},COMPANY_NEWS_CALL_DELAY_MS=${COMPANY_NEWS_CALL_DELAY_MS}"
SECRET_VARS="PGPASSWORD=${DB_PASSWORD_SECRET}:latest"
if [[ -n "${TG_TOKEN_SECRET:-}" ]]; then SECRET_VARS="${SECRET_VARS},BUTLER_TELEGRAM_BOT_TOKEN=${TG_TOKEN_SECRET}:latest"; fi
if [[ -n "${TG_WEBHOOK_SECRET:-}" ]]; then SECRET_VARS="${SECRET_VARS},BUTLER_TELEGRAM_WEBHOOK_SECRET=${TG_WEBHOOK_SECRET}:latest"; fi
if [[ -n "${DART_API_KEY_SECRET:-}" ]]; then SECRET_VARS="${SECRET_VARS},DART_API_KEY=${DART_API_KEY_SECRET}:latest"; fi
if [[ -n "${FMP_API_KEY_SECRET:-}" ]]; then SECRET_VARS="${SECRET_VARS},FMP_API_KEY=${FMP_API_KEY_SECRET}:latest"; fi
if [[ -n "${SEEKING_ALPHA_COOKIE_SECRET:-}" ]]; then SECRET_VARS="${SECRET_VARS},SEEKING_ALPHA_COOKIE=${SEEKING_ALPHA_COOKIE_SECRET}:latest"; fi
if [[ -n "${NAVER_CLIENT_ID_SECRET:-}" ]]; then SECRET_VARS="${SECRET_VARS},NAVER_CLIENT_ID=${NAVER_CLIENT_ID_SECRET}:latest"; fi
if [[ -n "${NAVER_CLIENT_SECRET_SECRET:-}" ]]; then SECRET_VARS="${SECRET_VARS},NAVER_CLIENT_SECRET=${NAVER_CLIENT_SECRET_SECRET}:latest"; fi

echo "==> Deploying Cloud Run service"
gcloud run deploy "$SERVICE" \
  --image "$APP_IMG" \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 2 \
  --port 8080 \
  --service-account "$SA_EMAIL" \
  --set-cloudsql-instances "$CONNECTION" \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$SECRET_VARS"

echo "==> Creating/updating Cloud Run refresh job"
if gcloud run jobs describe "$JOB" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  JOB_CMD=(gcloud run jobs update "$JOB")
else
  JOB_CMD=(gcloud run jobs create "$JOB")
fi
"${JOB_CMD[@]}" \
  --image "$JOB_IMG" \
  --project "$PROJECT" \
  --region "$REGION" \
  --command npx \
  --args tsx,scripts/refresh-daily.ts,--no-stockanalysis-nasdaq-estimates \
  --memory 512Mi \
  --cpu 1 \
  --tasks 1 \
  --parallelism 1 \
  --max-retries 0 \
  --task-timeout 7200 \
  --service-account "$SA_EMAIL" \
  --set-cloudsql-instances "$CONNECTION" \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$SECRET_VARS"

echo "==> Creating/updating Cloud Run weekly calendar job"
if gcloud run jobs describe "$CALENDAR_JOB" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  CALENDAR_JOB_CMD=(gcloud run jobs update "$CALENDAR_JOB")
else
  CALENDAR_JOB_CMD=(gcloud run jobs create "$CALENDAR_JOB")
fi
"${CALENDAR_JOB_CMD[@]}" \
  --image "$JOB_IMG" \
  --project "$PROJECT" \
  --region "$REGION" \
  --command npx \
  --args tsx,scripts/refresh-daily.ts,--calendar-only \
  --memory 512Mi \
  --cpu 1 \
  --tasks 1 \
  --parallelism 1 \
  --max-retries 0 \
  --task-timeout 7200 \
  --service-account "$SA_EMAIL" \
  --set-cloudsql-instances "$CONNECTION" \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$SECRET_VARS"

echo "==> Creating/updating Cloud Scheduler job"
SCHEDULER_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run"
if gcloud scheduler jobs describe "$SCHEDULER_JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  SCHED_CMD=(gcloud scheduler jobs update http "$SCHEDULER_JOB")
else
  SCHED_CMD=(gcloud scheduler jobs create http "$SCHEDULER_JOB")
fi
"${SCHED_CMD[@]}" \
  --project "$PROJECT" \
  --location "$REGION" \
  --schedule "30 18 * * *" \
  --time-zone "Asia/Seoul" \
  --uri "$SCHEDULER_URI" \
  --http-method POST \
  --oauth-service-account-email "$SA_EMAIL" \
  --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
  --attempt-deadline 60s \
  --max-retry-attempts 1

echo "==> Creating/updating StockAnalysis backfill job"
if gcloud run jobs describe "$STOCKANALYSIS_JOB" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  STOCKANALYSIS_JOB_CMD=(gcloud run jobs update "$STOCKANALYSIS_JOB")
else
  STOCKANALYSIS_JOB_CMD=(gcloud run jobs create "$STOCKANALYSIS_JOB")
fi
"${STOCKANALYSIS_JOB_CMD[@]}" \
  --image "$JOB_IMG" \
  --project "$PROJECT" \
  --region "$REGION" \
  --command npx \
  --args tsx,scripts/backfill-stockanalysis-nasdaq-estimates.ts \
  --memory 512Mi \
  --cpu 1 \
  --tasks 1 \
  --parallelism 1 \
  --max-retries 0 \
  --task-timeout 1800 \
  --service-account "$SA_EMAIL" \
  --set-cloudsql-instances "$CONNECTION" \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$SECRET_VARS"

echo "==> Creating/updating StockAnalysis backfill Scheduler job"
STOCKANALYSIS_SCHEDULER_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${STOCKANALYSIS_JOB}:run"
if gcloud scheduler jobs describe "$STOCKANALYSIS_SCHEDULER_JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  STOCKANALYSIS_SCHED_CMD=(gcloud scheduler jobs update http "$STOCKANALYSIS_SCHEDULER_JOB")
else
  STOCKANALYSIS_SCHED_CMD=(gcloud scheduler jobs create http "$STOCKANALYSIS_SCHEDULER_JOB")
fi
"${STOCKANALYSIS_SCHED_CMD[@]}" \
  --project "$PROJECT" \
  --location "$REGION" \
  --schedule "10 2,8,14,20 * * *" \
  --time-zone "Asia/Seoul" \
  --uri "$STOCKANALYSIS_SCHEDULER_URI" \
  --http-method POST \
  --oauth-service-account-email "$SA_EMAIL" \
  --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
  --attempt-deadline 60s \
  --max-retry-attempts 0

echo "==> Creating/updating company news refresh job"
if gcloud run jobs describe "$NEWS_JOB" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  NEWS_JOB_CMD=(gcloud run jobs update "$NEWS_JOB")
else
  NEWS_JOB_CMD=(gcloud run jobs create "$NEWS_JOB")
fi
"${NEWS_JOB_CMD[@]}" \
  --image "$JOB_IMG" \
  --project "$PROJECT" \
  --region "$REGION" \
  --command npx \
  --args tsx,scripts/backfill-company-news.ts \
  --memory 512Mi \
  --cpu 1 \
  --tasks 1 \
  --parallelism 1 \
  --max-retries 0 \
  --task-timeout 1800 \
  --service-account "$SA_EMAIL" \
  --set-cloudsql-instances "$CONNECTION" \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$SECRET_VARS"

echo "==> Creating/updating company news Scheduler job"
NEWS_SCHEDULER_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${NEWS_JOB}:run"
if gcloud scheduler jobs describe "$NEWS_SCHEDULER_JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  NEWS_SCHED_CMD=(gcloud scheduler jobs update http "$NEWS_SCHEDULER_JOB")
else
  NEWS_SCHED_CMD=(gcloud scheduler jobs create http "$NEWS_SCHEDULER_JOB")
fi
"${NEWS_SCHED_CMD[@]}" \
  --project "$PROJECT" \
  --location "$REGION" \
  --schedule "15 7-23/2 * * *" \
  --time-zone "Asia/Seoul" \
  --uri "$NEWS_SCHEDULER_URI" \
  --http-method POST \
  --oauth-service-account-email "$SA_EMAIL" \
  --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
  --attempt-deadline 60s \
  --max-retry-attempts 0

echo "==> Creating/updating weekly calendar Scheduler job"
CALENDAR_SCHEDULER_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${CALENDAR_JOB}:run"
if gcloud scheduler jobs describe "$CALENDAR_SCHEDULER_JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  CALENDAR_SCHED_CMD=(gcloud scheduler jobs update http "$CALENDAR_SCHEDULER_JOB")
else
  CALENDAR_SCHED_CMD=(gcloud scheduler jobs create http "$CALENDAR_SCHEDULER_JOB")
fi
"${CALENDAR_SCHED_CMD[@]}" \
  --project "$PROJECT" \
  --location "$REGION" \
  --schedule "0 8 * * 6" \
  --time-zone "Asia/Seoul" \
  --uri "$CALENDAR_SCHEDULER_URI" \
  --http-method POST \
  --oauth-service-account-email "$SA_EMAIL" \
  --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
  --attempt-deadline 60s \
  --max-retry-attempts 1

cat <<EOF

Done.
Service image: $APP_IMG
Job image:     $JOB_IMG
Calendar job:  $CALENDAR_JOB
StockAnalysis: $STOCKANALYSIS_JOB
News job:      $NEWS_JOB
Cloud SQL:     $CONNECTION

Initial data import:
  LOCAL_DATABASE_URL=postgres://butler:butler@localhost:5432/butler \\
  PROJECT=$PROJECT REGION=$REGION INSTANCE=$INSTANCE DB_NAME=$DB_NAME BUCKET=$BUCKET \\
  bash scripts/gcloud-postgres-import-local.sh
EOF
