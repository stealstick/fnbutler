# keystone Postgres 배포 가이드

운영 구조는 **Cloud Run + Cloud SQL(Postgres) + Cloud Run Job + GitHub Actions schedule** 다.
운영 중 데이터 갱신은 Postgres에 직접 쓴다.

## 구성

| 요소 | 이름/값 | 용도 |
|---|---|---|
| GCP 프로젝트 | `protein-test-469413` | 운영 프로젝트 |
| 리전 | `asia-northeast3` | 서울 |
| Cloud Run 서비스 | `fnbutler` | Next.js 웹/API |
| Cloud Run Job | `fnbutler-refresh` | 일일 데이터 갱신 |
| Cloud Run Job | `fnbutler-calendar-refresh` | 주간 캘린더 전용 갱신 |
| Cloud Scheduler | `fnbutler-refresh-weekdays` | 매일 18:30 KST Job 실행 |
| GitHub Actions schedule | `run refresh job` | 매일 18:30 KST 일일 갱신 + 토요일 08:00 KST 캘린더 Job 실행 |
| Cloud Scheduler | `fnbutler-calendar-weekly` | 선택 운영 경로, 권한이 있으면 토요일 08:00 KST 캘린더 Job 실행 |
| Cloud SQL | `fnbutler-pg` | Postgres 16, `db-f1-micro` |
| DB | `butler` / user `butler` | 시세·컨센서스·재무 운영 DB |
| Secret | `fnbutler-db-password`, `DART_API_KEY`, `FMP_API_KEY` | DB 비밀번호, 국내 실적 캘린더 키, 해외 컨센서스 추정치 키 |

## 1. 로컬 Postgres 준비

```bash
cd butler
npm install
npm run db:setup:local
npm run db:init
npm run build
```

## 2. GCP 스택 생성/배포

```bash
cd butler
npm run deploy:postgres
```

이 명령은 다음을 한 번에 맞춘다.

- 필요한 GCP API 활성화
- 런타임 서비스 계정 `fnbutler-runner` 생성
- GitHub 배포 서비스 계정 `gh-deployer` 가 `fnbutler-runner` 를 사용할 수 있도록 actAs 권한 부여
- Artifact Registry Docker 저장소 생성
- Cloud SQL Postgres `fnbutler-pg` 생성
- DB 비밀번호 Secret 생성
- 웹/Job Docker 이미지 빌드 및 푸시
- Cloud Run 서비스 배포
- Cloud Run Job 생성/업데이트 (`fnbutler-refresh`, `fnbutler-calendar-refresh`)
- GitHub Actions 매일 18:30 KST 일일 갱신 + 토요일 08:00 KST 캘린더 전용 스케줄 실행
- Cloud Scheduler 권한이 있으면 토요일 08:00 KST 캘린더 전용 스케줄도 생성/업데이트

선택 secret을 이미 Secret Manager에 만들어 둔 경우 환경변수로 이름을 넘길 수 있다.
GitHub Actions 배포는 repo secret `DART_API_KEY`, `FMP_API_KEY` 가 있으면 Cloud Run Job env 로 직접 주입하고,
GCP Secret Manager에 같은 이름의 secret이 있으면 Secret Manager 값을 우선 사용한다.

```bash
TG_TOKEN_SECRET=BUTLER_TELEGRAM_BOT_TOKEN \
TG_WEBHOOK_SECRET=BUTLER_TELEGRAM_WEBHOOK_SECRET \
DART_API_KEY_SECRET=DART_API_KEY \
FMP_API_KEY_SECRET=FMP_API_KEY \
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

운영 갱신은 Cloud Scheduler 또는 GitHub Actions schedule이 Cloud Run Job을 호출한다.

```bash
# 수동 실행
gcloud run jobs execute fnbutler-refresh \
  --project protein-test-469413 \
  --region asia-northeast3 \
  --wait

# 캘린더만 수동 갱신 (Nasdaq 해외 TOP500 + DART_API_KEY secret이 있으면 국내 100대 기업 잠정실적 공시 포함)
gcloud run jobs execute fnbutler-calendar-refresh \
  --project protein-test-469413 \
  --region asia-northeast3 \
  --wait
```

GitHub의 `.github/workflows/refresh.yml` 은 같은 Job들을 수동 실행하는 비상 버튼이다.
DB 파일을 내려받거나 이미지를 다시 굽지 않는다.

FMP 무료 플랜은 250 calls/day 기준이다. 일일 Job은 기본적으로 `FMP_DAILY_CALL_BUDGET=240`만 쓰고,
Nasdaq 기업 중 `fmp_estimates_at`이 오래된 순서로 연간 추정치를 갱신한다. 무료 플랜에서
`analyst-estimates?period=quarter`와 `price-target-summary-bulk`는 제한되므로, 기본값으로는
연간 추정치 기반 `YoY`/`EPS성장E`만 채운다. 목표가는 `FMP_TARGET_CALLS_PER_DAY`를 별도로 주면
per-symbol `price-target-consensus`로 천천히 채울 수 있다.

## 5. 배포 업데이트

- `main` push: `.github/workflows/deploy.yml` 이 웹 이미지와 refresh/calendar Job 이미지를 빌드/푸시하고 업데이트한다.
- 수동: `npm run deploy:postgres`
- 단일 서비스만 Cloud Build로 배포: `cloudbuild.yaml`

## 6. 비용 가정

저비용 우선 설정이다.

- Cloud SQL: `db-f1-micro`, zonal, HDD 10GB, 자동 스토리지 증가 off, 백업 off, HA off
- Cloud Run: min instances 0, 서비스 max 2
- Cloud Run Job: 매일 일일 갱신 1회 + 주간 캘린더 갱신 1회, 512Mi/1CPU
- Cloud Scheduler: 기본 Job 1개, 선택 캘린더 Job 1개

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

gcloud run jobs executions list \
  --job fnbutler-calendar-refresh \
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
| Nasdaq 성장률 없음 | `FMP_API_KEY` secret 누락, 아직 회전 갱신 순서 미도달, 또는 FMP 무료 플랜에서 해당 symbol 추정치 미제공 |
| Cloud SQL 비용 증가 | HA/backup/autostorage가 켜졌는지 확인 |
