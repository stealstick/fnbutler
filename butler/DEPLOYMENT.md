# butler.view Postgres 배포 가이드

운영 구조는 **Cloud Run + Cloud SQL(Postgres) + Cloud Run Job + Cloud Scheduler** 다.
기존 `db/butler.db` 는 최초 이관 소스로만 사용하고, 운영 중 데이터 갱신은 Postgres에 직접 쓴다.

## 구성

| 요소 | 이름/값 | 용도 |
|---|---|---|
| GCP 프로젝트 | `protein-test-469413` | 운영 프로젝트 |
| 리전 | `asia-northeast3` | 서울 |
| Cloud Run 서비스 | `fnbutler` | Next.js 웹/API |
| Cloud Run Job | `fnbutler-refresh` | 일일 데이터 갱신 |
| Cloud Scheduler | `fnbutler-refresh-weekdays` | 평일 18:30 KST Job 실행 |
| Cloud SQL | `fnbutler-pg` | Postgres 16, `db-f1-micro` |
| DB | `butler` / user `butler` | 시세·컨센서스·재무 운영 DB |
| Secret Manager | `fnbutler-db-password` | DB 비밀번호 |

## 1. 로컬 Postgres 이관

```bash
cd butler
npm install
npm run db:setup:local
npm run db:init
npm run db:migrate-sqlite
npm run build
```

`db:migrate-sqlite` 는 기본으로 `db/butler.db` 를 읽어 로컬 Postgres에 넣는다.
목적지 DB에 이미 데이터가 있으면 멈추며, 초기화 후 다시 넣고 싶을 때만
`tsx scripts/migrate-sqlite-to-postgres.ts --source db/butler.db --reset` 을 사용한다.

## 2. GCP 스택 생성/배포

```bash
cd butler
npm run deploy:postgres
```

이 명령은 다음을 한 번에 맞춘다.

- 필요한 GCP API 활성화
- 런타임 서비스 계정 `fnbutler-runner` 생성
- Artifact Registry Docker 저장소 생성
- Cloud SQL Postgres `fnbutler-pg` 생성
- DB 비밀번호 Secret 생성
- 웹/Job Docker 이미지 빌드 및 푸시
- Cloud Run 서비스 배포
- Cloud Run Job 생성/업데이트
- Cloud Scheduler 평일 18:30 KST 스케줄 생성/업데이트

선택 secret을 이미 Secret Manager에 만들어 둔 경우 환경변수로 이름을 넘길 수 있다.

```bash
TG_TOKEN_SECRET=BUTLER_TELEGRAM_BOT_TOKEN \
TG_WEBHOOK_SECRET=BUTLER_TELEGRAM_WEBHOOK_SECRET \
DART_API_KEY_SECRET=DART_API_KEY \
npm run deploy:postgres
```

## 3. 로컬 스냅샷을 Cloud SQL로 임포트

```bash
cd butler
LOCAL_DATABASE_URL=postgres://butler:butler@localhost:5432/butler \
npm run postgres:import:cloud
```

스크립트는 로컬 Postgres를 `pg_dump --clean --if-exists` 로 덤프해 GCS에 올린 뒤
Cloud SQL import를 실행한다. 최초 이관용이므로 기존 Cloud SQL 데이터가 있으면 덮어쓴다.

## 4. 일일 갱신

운영 갱신은 GitHub Actions가 아니라 Cloud Scheduler가 Cloud Run Job을 호출한다.

```bash
# 수동 실행
gcloud run jobs execute fnbutler-refresh \
  --project protein-test-469413 \
  --region asia-northeast3 \
  --wait

# 캘린더만 수동 갱신
gcloud run jobs execute fnbutler-refresh \
  --project protein-test-469413 \
  --region asia-northeast3 \
  --wait \
  --args=tsx,scripts/refresh-daily.ts,--calendar-only
```

GitHub의 `.github/workflows/refresh.yml` 은 같은 Job을 수동 실행하는 비상 버튼이다.
DB 파일을 내려받거나 이미지를 다시 굽지 않는다.

## 5. 배포 업데이트

- `main` push: `.github/workflows/deploy.yml` 이 웹 이미지와 refresh Job 이미지를 빌드/푸시하고 업데이트한다.
- 수동: `npm run deploy:postgres`
- 단일 서비스만 Cloud Build로 배포: `cloudbuild.yaml`

## 6. 비용 가정

저비용 우선 설정이다.

- Cloud SQL: `db-f1-micro`, zonal, HDD 10GB, 자동 스토리지 증가 off, 백업 off, HA off
- Cloud Run: min instances 0, 서비스 max 2
- Cloud Run Job: 평일 1회, 512Mi/1CPU
- Cloud Scheduler: Job 1개

공식 가격표 기준으로 Cloud SQL `db-f1-micro` 는 시간당 약 `$0.0105` 이며,
Scheduler는 Job당 월 `$0.10` 수준이다. Cloud Run은 요청/작업 시간 과금이라 이 트래픽에서는
대부분 무료 한도 또는 소액이다. 환율과 세금에 따라 달라지지만 월 30,000원 한도 안으로 잡는 설계다.

참고: [Cloud SQL pricing](https://cloud.google.com/sql/pricing),
[Cloud Run pricing](https://cloud.google.com/run/pricing),
[Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing).

## 7. 운영 확인

```bash
curl -s https://fnbutler-l3why3suea-du.a.run.app/api/stats

gcloud run jobs executions list \
  --job fnbutler-refresh \
  --region asia-northeast3 \
  --project protein-test-469413

gcloud sql connect fnbutler-pg \
  --user butler \
  --database butler \
  --project protein-test-469413
```

## 8. 트러블슈팅

| 증상 | 확인 |
|---|---|
| 웹이 DB 연결 실패 | Cloud Run `PGHOST=/cloudsql/<connection>`, Cloud SQL 연결 설정, `PGPASSWORD` secret |
| Job이 실행되지만 데이터 변화 없음 | `ingest_runs`, 최신 `report_id`, 업스트림 rate limit |
| 텔레그램 알림 없음 | `BUTLER_TELEGRAM_BOT_TOKEN`, Firestore userStore, 유저 `alertsEnabled` |
| 캘린더 국내 실적 없음 | `DART_API_KEY` secret 누락 가능 |
| Cloud SQL 비용 증가 | HA/backup/autostorage가 켜졌는지 확인 |
