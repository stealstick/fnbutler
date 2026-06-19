#!/usr/bin/env bash
# Import the already-migrated local Postgres snapshot into Cloud SQL.
#
# Run after:
#   npm run db:setup:local
#   npm run db:init
set -euo pipefail

PROJECT="${PROJECT:-protein-test-469413}"
REGION="${REGION:-asia-northeast3}"
INSTANCE="${INSTANCE:-fnbutler-pg}"
DB_NAME="${DB_NAME:-butler}"
BUCKET="${BUCKET:-protein-test-469413-fnbutler}"
LOCAL_DATABASE_URL="${LOCAL_DATABASE_URL:-postgres://butler:butler@localhost:5432/butler}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="/tmp/fnbutler-${STAMP}.sql"
GCS_URI="gs://${BUCKET}/postgres-imports/fnbutler-${STAMP}.sql"

echo "==> Dumping local Postgres snapshot"
pg_dump --clean --if-exists --no-owner --no-privileges "$LOCAL_DATABASE_URL" > "$DUMP"
ls -lh "$DUMP"

echo "==> Uploading dump to ${GCS_URI}"
if ! gcloud storage buckets describe "gs://${BUCKET}" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" --location "$REGION" --project "$PROJECT"
fi
gcloud storage cp "$DUMP" "$GCS_URI" --project "$PROJECT"

SQL_SA="$(gcloud sql instances describe "$INSTANCE" --project "$PROJECT" --format='value(serviceAccountEmailAddress)')"
echo "==> Granting Cloud SQL import access to ${SQL_SA}"
for role in roles/storage.objectViewer roles/storage.legacyBucketReader; do
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member "serviceAccount:${SQL_SA}" \
    --role "$role" \
    --project "$PROJECT" >/dev/null
done

echo "==> Importing into Cloud SQL (${INSTANCE}/${DB_NAME})"
gcloud sql import sql "$INSTANCE" "$GCS_URI" \
  --database "$DB_NAME" \
  --project "$PROJECT" \
  --quiet

echo "Import requested. Verify with:"
echo "  gcloud sql connect ${INSTANCE} --database=${DB_NAME} --user=butler --project=${PROJECT}"
