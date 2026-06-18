# keystone

`butler.works` 의 목표주가·컨센서스·재무 데이터를 **Postgres 정규화 DB** 로 모은
애널리스트 데스크. 전체/섹터/기업 3계층 조회, 로그인·관심목록, 텔레그램 알림,
경제·실적 캘린더를 제공한다. 모든 적재 출처는 `source = "butler"`.

## 핵심 기능

- **전체 리스트**: 전종목 2,555개 검색/필터/정렬
- **섹터**: KSIC 기반 섹터별 평균 상승여력·PER/PBR·목표가 모멘텀
- **기업**: 증권사별 목표주가, 분기/연간 재무, PER/PBR, 변경 이력, AI 요약
- **관심목록/알림**: 목표주가 변경 시 텔레그램 알림
- **일일 갱신**: Postgres에 직접 증분·멱등 업데이트. DB 파일 업로드/재배포 없음

## 빠른 시작

```bash
cd butler
npm install

# 로컬 Postgres 준비(로컬 postgres 슈퍼유저가 있어야 함)
npm run db:setup:local

# 스키마 생성
npm run db:init

# 기존 SQLite 백필 스냅샷을 Postgres로 이관
npm run db:migrate-sqlite

# 개발 서버
npm run dev
```

기본 로컬 접속 정보는 `postgres://butler:butler@localhost:5432/butler` 이다.
다른 DB를 쓰려면 `BUTLER_DATABASE_URL` 또는 `DATABASE_URL` 을 설정한다.

## 새로 수집/보강할 때

```bash
npm run ingest:companies
npm run ingest:covered
npm run ingest:detail -- --only-consensus --feed-pages 25
npm run backfill:sectors
npm run backfill:changes
npm run import:har -- ~/Downloads/www.butler.works.har
```

이미 백필된 로컬 `db/butler.db` 가 있으면 먼저 `npm run db:migrate-sqlite` 로 옮기는 편이
빠르고 안전하다. 위 수집 명령은 누락분 보강이나 미래 재수집용이다.

## 매일 갱신

```bash
npm run refresh
npm run refresh:calendar
```

- `refresh-daily.ts` 는 Postgres에 직접 쓴다.
- 최신 피드에서 이미 가진 `report_id` 를 만나면 중단해 신규 리포트만 받는다.
- 시세/목표가는 값이 바뀐 경우에만 UPDATE 하므로 같은 데이터를 여러 번 돌려도 안전하다.
- 운영 환경에서는 Cloud Scheduler가 Cloud Run Job `fnbutler-refresh` 를 매 영업일 18:30 KST에 실행한다.
- Nasdaq 실적 캘린더는 수집 범위 안에서 시총 상위 500개 해외/미국 상장기업 실적발표 일정을 캘린더에 넣는다.
- 국내 100대 기업 DART 잠정실적 공시는 `DART_API_KEY` secret이 있는 `fnbutler-calendar-refresh`
  Job이 매주 토요일 08:00 KST에 캘린더 전용으로 보강한다.

## 배포

```bash
npm run deploy:postgres

# 로컬 Postgres 스냅샷을 Cloud SQL로 최초 임포트
npm run postgres:import:cloud
```

배포 스크립트는 Cloud SQL(Postgres), Cloud Run 서비스, Cloud Run Job, Cloud Scheduler를
한 번에 준비한다. 자세한 절차와 비용 가정은 [DEPLOYMENT.md](./DEPLOYMENT.md)에 있다.

## 주요 경로

```text
db/postgres/schema.sql      Postgres 운영 스키마
db/schema.sql               레거시 SQLite 스키마(이관 참고용)
scripts/migrate-sqlite-to-postgres.ts
scripts/refresh-daily.ts
scripts/gcloud-postgres-bootstrap.sh
scripts/gcloud-postgres-import-local.sh
src/lib/db.ts               pg Pool + schema migrate
src/lib/repo.ts             async 조회 계층
src/lib/ingest.ts           async upsert + 변경 감지
```

## 환경변수

| 변수 | 용도 |
|---|---|
| `BUTLER_DATABASE_URL` / `DATABASE_URL` | Postgres 접속 URL |
| `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | URL 미사용 시 Postgres 접속값 |
| `BUTLER_USERSTORE` | `firestore`면 유저/세션/알림/캘린더를 Firestore에 저장 |
| `BUTLER_BASE_URL` | 알림 링크용 외부 URL |
| `BUTLER_TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 |
| `BUTLER_TELEGRAM_WEBHOOK_SECRET` | 텔레그램 웹훅 secret token |
| `BUTLER_RATE_PER_MIN` | 업스트림 분당 요청 상한(기본 80) |
| `DART_API_KEY` | 국내 실적발표 캘린더 수집용 |

## 데이터 모델

- `companies`: 전종목 마스터와 최신 시세/밸류 스냅샷
- `brokers`: 증권사 마스터
- `consensus_reports`: 증권사 리포트 원본, `report_id` 멱등 저장
- `target_price_monthly`: 월별 목표가 min/avg/max
- `financials`: metric x year x quarter long-format 재무
- `valuations`: PER/PBR 시계열
- `change_logs`: 목표가/컨센서스/재무 변경 이력
- `daily_snapshots`: 일별 핵심 지표 스냅샷
- `users`, `sessions`, `watchlist`, `notifications`: 로컬 Postgres 유저 저장소
- `calendar_events`, `calendar_prefs`: 로컬 Postgres 캘린더 저장소

운영에서는 `BUTLER_USERSTORE=firestore` 를 써서 유저/알림/캘린더를 Firestore에 두고,
시세·컨센서스·재무 본체는 Cloud SQL Postgres에 둔다.
