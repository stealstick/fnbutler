# CLAUDE.md - keystone

keystone 는 `butler.works` 데이터를 자체 정규화 DB로 모아 기업/섹터/증권사별
목표주가·컨센서스를 비교하는 Next.js 웹 앱이다.

## 현재 운영 원칙

- 운영 DB는 **Postgres** 다.
- 런타임은 **Cloud Run + Cloud SQL(Postgres)** 이다.
- 일일 갱신은 **Cloud Scheduler -> Cloud Run Job -> Postgres 직접 업데이트** 흐름이다.
- 기업 뉴스는 별도 **Cloud Scheduler -> `fnbutler-news-refresh` Job** 으로 회전 수집한다.
- 운영 스케줄은 `/admin/schedules`에서 조회·ON/OFF·즉시실행할 수 있다. ON/OFF는 `scheduler_controls`에 저장되어 각 배치 스크립트가 시작 시 확인하고, 런타임 서비스 계정에 `roles/cloudscheduler.admin`이 있으면 Cloud Scheduler pause/resume/run도 함께 시도한다.
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
| 뉴스 | 국내 NAVER Search API, 미국 상장기업 StockAnalysis 기사 피드 |

## 개발 규칙 (아키텍처·코드 관례)

### 3계층 구조 — UI는 DB를 직접 만지지 않는다

데이터 흐름은 항상 **클라이언트 컴포넌트 → API 라우트 → repo(데이터 계층)** 다.
새 필터/컬럼/화면을 붙일 때 세 층을 함께 고친다(예: 시장 복수선택 = `companies/page.tsx`
+ `api/companies/route.ts` + `lib/repo.ts`).

1. **클라이언트** `src/app/**/page.tsx` (`"use client"`)
   - 필터·정렬·페이지 상태는 `useState`. `URLSearchParams` 를 만들어 `/api/*` 를 `fetch`.
   - 조회는 `useCallback` 로 묶은 `load` 를 debounce(`setTimeout` ~200ms)로 호출하고,
     필터가 바뀌면 `setPage(0)` 로 리셋한다.
   - 필터 UI는 `globals.css` 공용 클래스(`.toolbar`, `.input`, `.toggle`, `.tab`)를 재사용한다.
     복수 선택은 `.toggle` 버튼 그룹으로 만들고 **아무것도 안 고르면 전체** 규칙을 따른다.
2. **API 라우트** `src/app/api/**/route.ts`
   - 쿼리 파라미터를 파싱해 repo 의 `Opts` 객체로 넘기고 결과를 `NextResponse.json` 한다.
     SQL·비즈니스 로직을 라우트에 두지 않는다.
   - 다중 값 필터는 **콤마 구분** 규약: `market=KOSPI,NASDAQ`
     → `sp.get("market")?.split(",").filter(Boolean)`.
3. **데이터 계층** `src/lib/repo.ts` (+ `src/lib/db.ts`)
   - 기업/섹터/컨센서스 SQL 은 전부 여기 모은다. 타입 계약은 `ListOpts`, `CompanyRow` 등.

### DB 접근

- 모든 쿼리는 `src/lib/db.ts` 헬퍼(`all` / `one` / `value` / `query` / `tx`)로. `pg` Pool
  기반 async 이니 **`await` 필수**.
- 값은 반드시 파라미터 바인딩. repo 안의 `push(v)` 헬퍼가 `$1,$2…` 를 만든다.
  사용자 입력을 문자열로 이어붙이지 말 것.
- 다중 값은 `IN (${vals.map((v) => push(v)).join(", ")})` 패턴.
- 저장소는 Postgres 하나뿐(운영/로컬/유저·세션·관심목록·캘린더 전부). sqlite·DB 파일 굽기
  흐름으로 되돌리지 말 것.

### 표시/포맷

- 숫자·통화·등락은 항상 `src/lib/format.ts`(`won`, `num`, `price`, `pct`, `signClass`).
  즉석 포맷을 만들지 말 것.
- UI 는 한국어. **상승=빨강, 하락=파랑**(한국식) — 색은 `signClass()` → `up`/`down`/`flat` 로 처리.

### 타입·품질 게이트

- TypeScript strict. `any` 로 때우지 말고 repo 타입을 확장한다(예: `ListOpts.market: string | string[]`).
- 끝내기 전 `npx tsc --noEmit`(또는 `npm run build`) 통과 확인 + `npm run lint`(next lint).
- 순수 로직(파싱, 코드 정규화, 성장률 계산)은 `src/lib/*.test.ts` 로 테스트를 붙인다
  (`node:test` + `node:assert/strict`). 실행: `npx tsx --test src/lib/<x>.test.ts`.
- 배포 게이트는 CI 의 Docker `next build`.

### 배포 트리거

- `main` 브랜치에 `butler/**`(단 `*.md` 제외) 변경을 push 하면 `.github/workflows/deploy.yml`
  이 이미지 빌드 → DB 마이그레이션 → Cloud Run 배포까지 자동 수행한다.
- **문서(`*.md`)만 바꾸면 배포가 트리거되지 않는다.**

### 수집/배치

- `tsx scripts/*` 로 돌리고 **멱등**하게: 피드는 아는 `report_id` 만나면 중단, 시세/값은 실제
  변화가 있을 때만 UPDATE.

### Git 작업 방침

- 기본 브랜치는 `main`. PR 게이트가 없다. 작업이 끝나고 품질 게이트(`tsc`/`build` + `lint`)를
  통과하면 **묻지 말고 `main` 에 바로 커밋·푸시**한다.
- `butler/**`(단 `*.md` 제외) 변경을 push 하면 배포가 트리거되므로, 코드 변경은 게이트
  통과를 확인한 뒤 커밋한다. 문서(`*.md`)만 바꾸면 배포는 안 돈다.
- 커밋 메시지는 관련 변경을 한 커밋으로 묶고, 끝에 `Co-Authored-By` 트레일러를 붙인다.

## 주요 명령

```bash
npm run db:setup:local
npm run db:init
npm run build
npm run refresh
npm run refresh:calendar
npm run backfill:company-news
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
- `company_news`: 기업별 최신 뉴스 캐시
- `users`, `sessions`, `watchlist`, `notifications`: 로컬 Postgres userStore
- `calendar_events`, `calendar_prefs`: 로컬 Postgres calendar fallback

뷰:

- `v_latest_broker_target`
- `v_financials_growth`
- `v_sector_agg`

## 수집/갱신

- `ingestNewReports`: 피드 최신순으로 읽다가 이미 가진 `report_id` 를 만나면 중단한다.
- `refreshCompanyQuote`: 실제 값이 바뀐 경우에만 UPDATE 한다.
- `backfill-company-news`: 국내 기업은 네이버 뉴스 API, 미국 상장기업은 StockAnalysis 기사 피드로 최신 뉴스를 회전 저장한다.
- `fnbutler-stockanalysis-backfill`: 일일 refresh와 분리된 Cloud Run Job으로 02:10/08:10/14:10/20:10 KST에 돌며, 기본 45 symbols/run으로 현재 미국 상장기업 유니버스를 약 7일 안에 한 바퀴 회전한다.
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
