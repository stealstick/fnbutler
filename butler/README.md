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
- **운영 스케줄 관리**: `/admin/schedules`에서 Cloud Scheduler Job을 조회하고 개별 ON/OFF·즉시실행

## 빠른 시작

```bash
cd butler
npm install

# 로컬 Postgres 준비(로컬 postgres 슈퍼유저가 있어야 함)
npm run db:setup:local

# 스키마 생성
npm run db:init

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

위 수집 명령은 누락분 보강이나 미래 재수집용이다.

## 매일 갱신

```bash
npm run refresh
npm run refresh:calendar
```

- `refresh-daily.ts` 는 Postgres에 직접 쓴다.
- 최신 피드에서 이미 가진 `report_id` 를 만나면 중단해 신규 리포트만 받는다.
- 신규 리포트 AI 요약은 상세 API의 긴 원문을 저장하고, 짧은 feed 요약 잔여분은 매일 자동 보정한다.
- 시세/목표가는 값이 바뀐 경우에만 UPDATE 하므로 같은 데이터를 여러 번 돌려도 안전하다.
- 운영 환경에서는 Cloud Scheduler/GitHub Actions가 Cloud Run Job `fnbutler-refresh` 를 매일 18:30 KST에 실행한다.
- 일일 갱신은 Nasdaq screener에서 NASDAQ/NYSE/AMEX 거래소별 시총 상위 500개 미국 상장기업도 `companies`에 보강한다. 가져오지 못하는 PER/PBR/목표가/재무 성장률은 화면에서 `-`로 표시한다.
- 국내 컨센서스 추정치는 FnGuide와 WiseReport를 `financials.source`별로 각각 저장한다. 웹에서는 FnGuide를 기본으로 보되, 브라우저 localStorage의 추정치 기준 선택에 따라 WiseReport 우선으로 바꿀 수 있고 선택 provider에 값이 없으면 다른 provider로 보완한다.
- `FMP_API_KEY`가 있으면 FMP 무료 플랜 한도에 맞춰 미국 상장기업 연간 컨센서스 추정치를 회전 보강한다. 기본 `FMP_DAILY_CALL_BUDGET=240`, `FMP_CALL_DELAY_MS=2500` 이며 오래된 순서로 천천히 돈다. 무료 플랜에서 확인된 `period=annual`만 사용하므로 `YoY`/`EPS성장E`는 채워지고, 분기 추정 기반 `QoQ 현재→다음E`는 유료 분기 endpoint 권한이 없으면 `-`로 남는다.
- Seeking Alpha 공개 JSON이 열리면 미국 상장기업의 최근/다음 분기 및 연간 EPS·매출 실제치/추정치를 보강한다. 별도 인증은 기본적으로 필요 없고, `SEEKING_ALPHA_NASDAQ_LIMIT=500`, `SEEKING_ALPHA_BATCH_SIZE=5`, `SEEKING_ALPHA_CALL_DELAY_MS=60000`으로 천천히 갱신한다. 운영 Job은 `SEEKING_ALPHA_USE_CURL=1`로 curl 경로를 사용한다. `*_NASDAQ_*` env 이름은 기존 배포 호환성을 위해 유지한다. PerimeterX/captcha로 차단되면 즉시 멈추며, 허용된 데이터 소스나 세션이 필요하다.
- Yahoo Finance 웹 JSON이 열리면 미국 상장기업의 목표가와 `0q/+1q/0y/+1y` EPS·매출 추정치를 보강한다. 기본은 기존 FMP 추정치를 덮어쓰지 않고 빈칸만 채운다. Yahoo 세션은 DB에 캐시하고, 실패 시 기존 데이터는 보존한 채 다음 실행 때 재시도한다.
- Nasdaq 실적 캘린더는 수집 범위 안에서 시총 상위 500개 해외/미국 상장기업 실적발표 일정을 캘린더에 넣는다.
- 기업 뉴스는 별도 Job `fnbutler-news-refresh`가 2시간 간격으로 회전 수집한다. 국내 기업은 네이버 뉴스 검색 API, 미국 상장기업은 StockAnalysis 기사 피드를 사용한다.
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
scripts/refresh-daily.ts
scripts/backfill-company-news.ts
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
| `BUTLER_BASE_URL` | 알림 링크용 외부 URL |
| `BUTLER_TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 |
| `BUTLER_TELEGRAM_WEBHOOK_SECRET` | 텔레그램 웹훅 secret token |
| `BUTLER_RATE_PER_MIN` | 업스트림 분당 요청 상한(기본 80) |
| `DART_API_KEY` | 국내 실적발표 캘린더 수집용 |
| `FNGUIDE_ESTIMATE_LIMIT` | FnGuide 국내 컨센서스 일일 보강 대상 수(기본 0=전체) |
| `WISEREPORT_ESTIMATE_LIMIT` | WiseReport 국내 컨센서스 일일 보강 대상 수(기본 0=전체) |
| `FMP_API_KEY` | 미국 상장기업 연간 컨센서스 추정치 수집용 |
| `FMP_DAILY_CALL_BUDGET` | FMP 하루 호출 예산(기본 240, 무료 250 calls/day 여유분 보존) |
| `FMP_CALL_DELAY_MS` | FMP 호출 간격(기본 2500ms, 무료 플랜 rate limit 보호) |
| `FMP_TARGET_CALLS_PER_DAY` | FMP 목표가 per-symbol 호출 예산(기본 0, bulk target은 무료 제한) |
| `SEEKING_ALPHA_NASDAQ_LIMIT` | Seeking Alpha 미국 상장기업 추정치 일일 보강 대상 수(기본 500) |
| `SEEKING_ALPHA_BATCH_SIZE` | Seeking Alpha 배치당 심볼 수(기본 5) |
| `SEEKING_ALPHA_CALL_DELAY_MS` | Seeking Alpha 배치 호출 간격(기본 60000ms) |
| `SEEKING_ALPHA_USE_CURL` | `1`이면 Node fetch 대신 curl 호출 사용(배포 기본값) |
| `SEEKING_ALPHA_OVERWRITE_ESTIMATES` | `1`이면 기존 추정치도 Seeking Alpha 값으로 덮어쓰기 |
| `SEEKING_ALPHA_COOKIE` | Cloud Run에서 공개 JSON이 차단될 때만 선택적으로 넣는 허용된 Seeking Alpha 세션 쿠키 |
| `YAHOO_NASDAQ_LIMIT` | Yahoo 미국 상장기업 추정치 일일 보강 대상 수(기본 30) |
| `YAHOO_CALL_DELAY_MS` | Yahoo 호출 간격(기본 2500ms) |
| `YAHOO_JITTER_MS` | Yahoo 호출 간 랜덤 추가 대기시간(기본 750ms) |
| `YAHOO_SESSION_RETRIES` | Yahoo cookie/crumb 발급 재시도 횟수(기본 3) |
| `YAHOO_SESSION_RETRY_DELAY_MS` | Yahoo cookie/crumb 재시도 대기시간(기본 60000ms) |
| `YAHOO_COOKIE` / `YAHOO_CRUMB` | Cloud Run에서 cookie/crumb 발급이 막힐 때 수동 bootstrap으로 넣는 Yahoo 세션 |
| `YAHOO_OVERWRITE_ESTIMATES` | `1`이면 기존 추정치도 Yahoo 값으로 덮어쓰기 |
| `YAHOO_OVERWRITE_TARGETS` | `1`이면 기존 평균 목표주가도 Yahoo 값으로 덮어쓰기 |
| `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` | 국내 기업 뉴스 검색용 네이버 검색 API 인증값 |
| `COMPANY_NEWS_LIMIT` | 기업 뉴스 회전 수집 대상 수(기본 80) |
| `COMPANY_NEWS_DISPLAY` | 기업당 저장 후보 기사 수(기본 8) |
| `COMPANY_NEWS_STALE_HOURS` | 재수집 간격 기준 시간(기본 2) |
| `COMPANY_NEWS_CALL_DELAY_MS` | 뉴스 수집 호출 간격(기본 500ms) |
| `SCHEDULER_PROJECT` / `SCHEDULER_LOCATION` | `/admin/schedules` Cloud Scheduler 관리 대상(기본 운영 project/region) |
| `CLOUD_SCHEDULER_ACCESS_TOKEN` | 로컬에서 `/admin/schedules`를 테스트할 때 선택적으로 쓰는 OAuth access token |

## 데이터 모델

- `companies`: 전종목 마스터와 최신 시세/밸류 스냅샷
- `brokers`: 증권사 마스터
- `consensus_reports`: 증권사 리포트 원본, `report_id` 멱등 저장
- `target_price_monthly`: 월별 목표가 min/avg/max
- `financials`: metric x year x quarter long-format 재무
- `valuations`: PER/PBR 시계열
- `change_logs`: 목표가/컨센서스/재무 변경 이력
- `daily_snapshots`: 일별 핵심 지표 스냅샷
- `company_news`: 기업별 최신 뉴스 캐시. 국내는 `naver`, 미국 상장기업은 `stockanalysis` provider로 저장
- `users`, `sessions`, `watchlist`, `notifications`: Postgres 유저 저장소
- `calendar_events`, `calendar_prefs`: Postgres 캘린더 저장소

운영/로컬 모두 Postgres를 단일 저장소로 쓴다. 캘린더는 크론/수동 refresh로
`calendar_events`를 전량 교체하므로 중복 없이 재생성된다.
