# CLAUDE.md - keystone

keystone 는 `butler.works` 데이터를 자체 정규화 DB로 모아 기업/섹터/증권사별
목표주가·컨센서스를 비교하는 Next.js 웹 앱이다.

## 현재 운영 원칙

- 운영 DB는 **Postgres** 다.
- 런타임은 **Cloud Run + Cloud SQL(Postgres)** 이다.
- 일일 갱신은 **Cloud Scheduler -> Cloud Run Job -> Postgres 직접 업데이트** 흐름이다.
- 운영 스케줄의 source of truth는 `docs/SCHEDULES.md` 다.
- 스케줄/cron 변경 시 `.github/workflows/deploy.yml`, `scripts/gcloud-postgres-bootstrap.sh`,
  `docs/SCHEDULES.md`, `DEPLOYMENT.md`, `CLAUDE.md`, 루트 `AGENTS.md` 를 같이 맞춘다.
- `.github/workflows/refresh.yml` 은 수동 실행용이다. 운영 cron으로 되돌리지 말 것.
- DB 파일을 GCS에 올리거나 이미지에 굽는 흐름으로 되돌리지 말 것.
- 운영/로컬 유저·세션·관심목록·알림·캘린더는 모두 Postgres에 저장한다.

## 라이브/로컬

- 라이브: https://fnbutler-l3why3suea-du.a.run.app
- 로컬: `cd butler && npm run dev` -> http://localhost:3939
- 기본 로컬 DB: `postgres://butler:butler@localhost:5432/butler`

## 기술 스택

| 영역 | 선택 |
|---|---|
| 프레임워크 | Next.js 15 App Router, React 19, TypeScript |
| 운영 DB | Cloud SQL Postgres 16 |
| 로컬 DB | Postgres |
| 유저 저장소 | Postgres |
| 수집/배치 | `tsx` scripts |
| 호스팅 | Cloud Run service + Cloud Run Job |
| 스케줄 | Cloud Scheduler |
| 알림 | Telegram Bot API |

## 주요 명령

```bash
npm run db:setup:local
npm run db:init
npm run build
npm run refresh
npm run refresh:calendar
npm run deploy:postgres
npm run postgres:import:cloud
```

## 데이터 모델

운영 스키마는 `db/postgres/schema.sql`.

- `companies`: 전종목 마스터, 시세/밸류 스냅샷
- `brokers`: 증권사 마스터
- `consensus_reports`: 리포트 원본, `report_id` 멱등 저장
- `target_price_monthly`: 월별 목표가 집계
- `financials`: long-format 재무
- `valuations`: PER/PBR 시계열
- `change_logs`: 목표가/컨센서스/재무 변경 타임라인
- `daily_snapshots`: 일별 핵심 지표
- `users`, `sessions`, `watchlist`, `notifications`: 로컬 Postgres userStore
- `calendar_events`, `calendar_prefs`: 로컬 Postgres calendar fallback

뷰:

- `v_latest_broker_target`
- `v_financials_growth`
- `v_sector_agg`

## 수집/갱신

- `ingestNewReports`: 피드 최신순으로 읽다가 이미 가진 `report_id` 를 만나면 중단한다.
- `refreshCompanyQuote`: 실제 값이 바뀐 경우에만 UPDATE 한다.
- `backfill:changes`: 원본 리포트일 기준으로 변경 로그를 재생성한다.
- `import:har`: 로그인 HAR로 공개 API에서 마스킹되는 최신 재무를 보강한다.

## 배포/비용

`scripts/gcloud-postgres-bootstrap.sh` 가 Cloud SQL, Cloud Run 서비스, Cloud Run Job,
Cloud Scheduler를 만든다. 비용을 30,000원/월 아래로 두기 위해 Cloud SQL은
`db-f1-micro`, zonal, HDD 10GB, backup off, storage auto increase off 로 만든다.

자세한 절차는 `DEPLOYMENT.md`.

## 주의

- `src/lib/db.ts` 는 `pg` Pool 기반 async API다. 새 조회/수집 코드는 `await` 를 빠뜨리지 말 것.
- DB 파일을 런타임 데이터 저장소로 되살리지 말 것.
- 한국어 UI, 상승=빨강/하락=파랑(한국식).
- 숫자 포맷은 `src/lib/format.ts` 를 우선 사용한다.
- 문서 변경 시 `README.md`, `DEPLOYMENT.md`, 이 파일을 같이 맞춘다.
