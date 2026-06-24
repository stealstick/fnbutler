# keystone Postgres 배포 가이드

운영 구조는 **Cloud Run + Cloud SQL(Postgres) + Cloud Run Job + Cloud Scheduler** 다.
운영 중 데이터 갱신은 Postgres에 직접 쓴다.

운영 스케줄의 source of truth는 [`docs/SCHEDULES.md`](./docs/SCHEDULES.md)다.

## 구성

| 요소 | 이름/값 | 용도 |
|---|---|---|
| GCP 프로젝트 | `protein-test-469413` | 운영 프로젝트 |
| 리전 | `asia-northeast3` | 서울 |
| Cloud Run 서비스 | `fnbutler` | Next.js 웹/API |
| Cloud Run Job | `fnbutler-refresh` | 일일 데이터 갱신 |
| Cloud Run Job | `fnbutler-calendar-refresh` | 주간 캘린더 전용 갱신 |
| Cloud Run Job | `fnbutler-stockanalysis-backfill` | NASDAQ 목표가·예상실적 저속 백필 |
| Cloud Run Job | `fnbutler-news-refresh` | 국내/NASDAQ 기업 뉴스 회전 수집 |
| Cloud Scheduler | `fnbutler-refresh-weekdays` | 매일 18:30 KST `fnbutler-refresh` 실행 |
| Cloud Scheduler | `fnbutler-calendar-weekly` | 토요일 08:00 KST `fnbutler-calendar-refresh` 실행 |
| Cloud Scheduler | `fnbutler-stockanalysis-backfill-6h` | 02:10/08:10/14:10/20:10 KST 저속 백필 실행 |
| Cloud Scheduler | `fnbutler-news-refresh-2h` | 07:15-23:15 KST 2시간 간격 뉴스 수집 |
| GitHub Actions workflow | `run refresh job` | 스케줄 없음. 수동 백필/재실행용 escape hatch |
| Cloud SQL | `fnbutler-pg` | Postgres 16, `db-f1-micro` |
| DB | `butler` / user `butler` | 시세·컨센서스·재무 운영 DB |
| Secret | `fnbutler-db-password`, `DART_API_KEY`, `FMP_API_KEY`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | DB 비밀번호, 국내 실적 캘린더 키, 해외 컨센서스 추정치 키, 국내 뉴스 검색 키 |

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
- DB 마이그레이션 선실행
- Cloud Run 서비스 배포
- Cloud Run Job 생성/업데이트 (`fnbutler-refresh`, `fnbutler-calendar-refresh`, `fnbutler-stockanalysis-backfill`, `fnbutler-news-refresh`)
- Cloud Scheduler 생성/업데이트 (`fnbutler-refresh-weekdays`, `fnbutler-calendar-weekly`, `fnbutler-stockanalysis-backfill-6h`, `fnbutler-news-refresh-2h`)

선택 secret을 이미 Secret Manager에 만들어 둔 경우 환경변수로 이름을 넘길 수 있다.
GitHub Actions 배포는 repo secret `DART_API_KEY`, `FMP_API_KEY` 가 있으면 Cloud Run Job env 로 직접 주입하고,
GCP Secret Manager에 같은 이름의 secret이 있으면 Secret Manager 값을 우선 사용한다.

```bash
TG_TOKEN_SECRET=BUTLER_TELEGRAM_BOT_TOKEN \
TG_WEBHOOK_SECRET=BUTLER_TELEGRAM_WEBHOOK_SECRET \
DART_API_KEY_SECRET=DART_API_KEY \
FMP_API_KEY_SECRET=FMP_API_KEY \
NAVER_CLIENT_ID_SECRET=NAVER_CLIENT_ID \
NAVER_CLIENT_SECRET_SECRET=NAVER_CLIENT_SECRET \
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

운영 갱신은 Cloud Scheduler가 Cloud Run Job을 호출한다.

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

# StockAnalysis NASDAQ 백필만 수동 실행
gcloud run jobs execute fnbutler-stockanalysis-backfill \
  --project protein-test-469413 \
  --region asia-northeast3 \
  --wait

# 기업 뉴스만 수동 실행
gcloud run jobs execute fnbutler-news-refresh \
  --project protein-test-469413 \
  --region asia-northeast3 \
  --wait
```

GitHub의 `.github/workflows/refresh.yml` 은 같은 Job들을 수동 실행하는 비상 버튼이다.
스케줄 트리거는 없으며, DB 파일을 내려받거나 이미지를 다시 굽지 않는다.

FMP 무료 플랜은 250 calls/day 기준이다. 일일 Job은 기본적으로 `FMP_DAILY_CALL_BUDGET=240`만 쓰고
`FMP_CALL_DELAY_MS=2500`으로 천천히 호출해 분당 rate limit도 피한다.
Nasdaq 기업 중 `fmp_estimates_at`이 오래된 순서로 연간 추정치를 갱신한다. 무료 플랜에서
`analyst-estimates?period=quarter`와 `price-target-summary-bulk`는 제한되므로, 기본값으로는
연간 추정치 기반 `YoY`/`EPS성장E`만 채운다. 목표가는 `FMP_TARGET_CALLS_PER_DAY`를 별도로 주면
per-symbol `price-target-consensus`로 천천히 채울 수 있다.

Seeking Alpha NASDAQ 추정치는 공개 `symbol_data` JSON 경로다. 현재 확인한 엔드포인트는 별도 인증 없이
`symbol_data?slugs=...`로 ticker id를 얻고, `symbol_data/estimates`에서 분기/연간 EPS·매출
실제치/컨센서스 평균을 배치로 가져온다. 일일 Job 기본값은 `SEEKING_ALPHA_NASDAQ_LIMIT=500`,
`SEEKING_ALPHA_BATCH_SIZE=5`, `SEEKING_ALPHA_CALL_DELAY_MS=60000`, `SEEKING_ALPHA_USE_CURL=1`이며,
`seekingalpha_estimates_at`이 오래된 NASDAQ 기업부터 천천히 회전 보강한다. PerimeterX/captcha로
차단되면 즉시 멈추며, Cloud Run에서 공개 호출이 차단될 때는 허용된 데이터 소스나 세션이 필요하다.

Yahoo NASDAQ 추정치는 비공식 웹 JSON 경로다. 실행 시 DB 캐시 세션,
`YAHOO_COOKIE`/`YAHOO_CRUMB` env, 새 쿠키+crumb 발급 순서로 `quoteSummary`를 호출한다. 기본값은
`YAHOO_NASDAQ_LIMIT=30`, `YAHOO_CALL_DELAY_MS=2500`, `YAHOO_JITTER_MS=750`,
`YAHOO_SESSION_RETRIES=3`, `YAHOO_SESSION_RETRY_DELAY_MS=60000`이며, 기존 FMP 데이터는
덮어쓰지 않고 비어 있는 `financials.is_estimate=1` 행과 목표가만 보강한다.

Yahoo 실패 시 운영 플랜:

- crumb/cookie 실패: 해당 실행은 `ok=0, fail=대상수`로 기록하고 프로세스는 성공 종료한다. 기존 FMP NASDAQ 갱신은 계속 사용한다.
- 개별 종목 실패: `yahoo_estimates_at`을 갱신하지 않아 다음 일일 Job에서 재시도한다.
- Cloud Run 장기 차단: 로컬/브라우저에서 발급한 `YAHOO_COOKIE`/`YAHOO_CRUMB`를 Secret Manager로 넣어 bootstrap한다. 그래도 막히면 `--no-yahoo-nasdaq-estimates` 또는 `YAHOO_NASDAQ_LIMIT=0`으로 즉시 비활성화하고, NASDAQ 추정치는 FMP 연간 추정치로 유지한다.
- 데이터 품질 이슈: 기본값은 덮어쓰지 않으므로 기존 FMP/FnGuide 컨센서스가 우선이다. 검증 후 `YAHOO_OVERWRITE_ESTIMATES=1` 또는 `YAHOO_OVERWRITE_TARGETS=1`만 선택적으로 켠다.

StockAnalysis NASDAQ 백필은 공식 API가 아닌 공개 페이지 기반이므로 별도 Cloud Run Job
`fnbutler-stockanalysis-backfill`로 분리해서 천천히 회전한다. 운영 기본값은
`STOCKANALYSIS_NASDAQ_LIMIT=20`, `STOCKANALYSIS_CALL_DELAY_MS=7000`,
`STOCKANALYSIS_JITTER_MS=3000`, `STOCKANALYSIS_BROKER_TARGETS=1`이며,
Cloud Scheduler가 02:10/08:10/14:10/20:10 KST에 실행한다.
하루 약 80종목만 요청하므로 NASDAQ 500개는 7일 안에 채워지고, 이미 처리한 종목은
`stockanalysis_estimates_at`이 갱신되어 오래된 순서로 자연스럽게 다음 회차로 밀린다.
일일 refresh Job은 `--no-stockanalysis-nasdaq-estimates`로 실행해 중복 호출을 피한다.

기업 뉴스 수집은 별도 Job `fnbutler-news-refresh`가 담당한다. 국내 기업(KOSPI/KOSDAQ 등)은
네이버 뉴스 검색 API를 사용하므로 `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`이 필요하다. 키가 없으면
국내 뉴스만 건너뛰고, NASDAQ 기업은 StockAnalysis 티커 페이지의 기사 피드를 계속 수집한다.
운영 기본값은 `COMPANY_NEWS_LIMIT=80`, `COMPANY_NEWS_DISPLAY=8`, `COMPANY_NEWS_STALE_HOURS=2`,
`COMPANY_NEWS_CALL_DELAY_MS=500`이며, Cloud Scheduler가 07:15부터 23:15까지 2시간 간격으로 실행한다.
기업명이 모호한 경우 `companies.news_keyword`에 검색 키워드를 직접 넣어 네이버 검색어를 조정한다.

## 5. 배포 업데이트

- `main` push: `.github/workflows/deploy.yml` 이 웹 이미지와 refresh/calendar Job 이미지를 빌드/푸시하고 업데이트한다.
- 수동: `npm run deploy:postgres`
- 단일 서비스만 Cloud Build로 배포: `cloudbuild.yaml`

## 6. 비용 가정

저비용 우선 설정이다.

- Cloud SQL: `db-f1-micro`, zonal, HDD 10GB, 자동 스토리지 증가 off, 백업 off, HA off
- Cloud Run: min instances 0, 서비스 max 2
- Cloud Run Job: 매일 일일 갱신 1회 + StockAnalysis 저속 백필 4회 + 뉴스 수집 9회 + 주간 캘린더 갱신 1회, 512Mi/1CPU
- Cloud Scheduler: 기본 refresh 1개, StockAnalysis 1개, 뉴스 1개, 캘린더 1개

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

gcloud run jobs executions list \
  --job fnbutler-news-refresh \
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
| 텔레그램 알림 없음 | `BUTLER_TELEGRAM_BOT_TOKEN`, Postgres `users.alerts_enabled`, `users.telegram_chat_id` |
| 캘린더 국내 실적 없음 | `DART_API_KEY` secret 누락 가능 |
| 국내 추정치 provider별 차이 | FnGuide/WiseReport는 `financials.source`별로 별도 저장된다. 웹의 추정치 기준 토글은 localStorage에 저장되고, 선택 provider 값이 없으면 다른 provider가 fallback으로 표시된다. |
| Nasdaq 성장률 없음 | `FMP_API_KEY` secret 누락, 아직 회전 갱신 순서 미도달, 또는 FMP 무료 플랜에서 해당 symbol 추정치 미제공 |
| NASDAQ Yahoo 성장률 없음 | Yahoo crumb/cookie 차단, 해당 종목 커버리지 없음, 또는 `YAHOO_NASDAQ_LIMIT=0` 설정 |
| 국내 기업 뉴스 없음 | `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET` secret 누락 또는 네이버 검색 API 권한 미설정 |
| NASDAQ 기업 뉴스 없음 | StockAnalysis 차단/HTML 구조 변경, 해당 티커 뉴스 없음, 또는 `company_news` 수집 순서 미도달 |
| Cloud SQL 비용 증가 | HA/backup/autostorage가 켜졌는지 확인 |
