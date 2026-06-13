#!/usr/bin/env bash
# butler.view 배포 — 로컬 db/butler.db 를 이미지에 구워 Cloud Run(fnbutler)에 올린다.
#
# 사전: gcloud 인증이 살아있어야 함. 만료 시:  gcloud auth login
#
#   bash butler/scripts/deploy.sh
#
# 동작: (1) 로컬 DB WAL 체크포인트 → (2) amd64 이미지 빌드 → (3) Artifact Registry 푸시
#       → (4) Cloud Run 배포 → (5) 라이브 /api/stats 검증.
set -euo pipefail

PROJECT=protein-test-469413
REGION=asia-northeast3
SERVICE=fnbutler
IMG="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${SERVICE}:$(date +%Y%m%d-%H%M%S)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"        # butler/
URL="https://fnbutler-l3why3suea-du.a.run.app"

echo "▶ 1/5 로컬 DB WAL 체크포인트"
( cd "$ROOT" && npx tsx -e "import {getDb} from './src/lib/db'; getDb().pragma('wal_checkpoint(TRUNCATE)');" )
ls -lh "$ROOT/db/butler.db"

echo "▶ 2/5 이미지 빌드 ($IMG)"
docker build --platform linux/amd64 -t "$IMG" "$ROOT"

echo "▶ 3/5 Artifact Registry 푸시"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker push "$IMG"

echo "▶ 4/5 Cloud Run 배포"
gcloud run deploy "$SERVICE" \
  --image "$IMG" --project "$PROJECT" --region "$REGION" \
  --allow-unauthenticated --memory 1Gi --cpu 1 \
  --min-instances 0 --max-instances 1 --port 8080 \
  --set-env-vars "BUTLER_DB_PATH=/app/db/butler.db,BUTLER_BASE_URL=${URL}"

echo "▶ 5/5 라이브 검증"
sleep 5
curl -s -m 20 "${URL}/api/stats" | head -c 300
echo
echo "✅ 배포 완료 → ${URL}"
