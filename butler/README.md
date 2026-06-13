# butler.view

`butler.works` 의 목표주가·컨센서스·재무 데이터를 **자체 SQLite DB 로 정규화**한
**애널리스트 데스크**. 전체/섹터/기업 3계층 + 로그인·관심목록·텔레그램 알림.
변경분(목표주가 상향/하향, QoQ/YoY)을 날짜와 함께 자동 로깅하고, 매일 크론 폴링으로
관심 기업의 목표주가가 바뀌면 텔레그램으로 쏜다. 모든 적재 출처는 `source = "butler"`.

핵심 기능
- **전체 리스트** — 전종목 2,555개 검색/필터/정렬
- **섹터** — KSIC 기반 광역 섹터별 평균 상승여력·PER/PBR·목표가 모멘텀 비교
- **기업** — 증권사 N곳 목표주가 한눈 비교 + 분기/연간 재무(매출·영업이익·순이익·PER·PBR) + 변경이력
- **로그인 + 관심목록(★)** — 즐겨찾기 기업의 목표주가 변경 시 텔레그램 알림
- **일일 폴링 크론** — 변경 자동 감지/로깅(날짜 포함) + 일별 스냅샷 + 알림 발송

> fnguide 본 프로젝트의 `schema.sql` 설계 철학(단일 팩트 테이블 + FK, 리포트 불변/멱등
> 저장, long-format 지표, 최신값은 뷰로 계산)을 SQLite 로 그대로 이식했다.

## 빠른 시작

```bash
cd butler
npm install

# 1) DB 스키마 생성
npm run db:init

# 2) 전종목(2,555개) 목록 수집  (~52 호출, 1분 이내)
npm run ingest:companies

# 3) 시총 상위 40개 상세(증권사별 목표가 + 재무) 수집 + 변경 로깅
npm run ingest:seed

# 4) 전종목 섹터(업종) 백필  (companies/{corpCode} 호출, ~30분, 멱등/재개가능)
npm run backfill:sectors

# 5) 변경이력을 원본 리포트일(발생일) 기준으로 재생성 — 과거까지 백필
npm run backfill:changes

# (선택) 컨센서스 기업 과거 리포트를 더 깊이 (피드 25페이지)
npm run ingest:detail -- --only-consensus --feed-pages 25

# (선택) 로그인 HAR 로 최신 재무(2024~2026) 백필
npx tsx scripts/import-har.ts ~/Downloads/www.butler.works.har

# 6) 개발 서버
npm run dev            # → http://localhost:3939
```

> 배포·이전은 [DEPLOYMENT.md](./DEPLOYMENT.md) 참고 (영속 디스크/도커/크론/호스팅).

> 섹터 분류 규칙(src/lib/sectors.ts)을 바꾼 뒤엔 API 호출 없이 재분류만:
> `npx tsx -e "import {getDb} from './src/lib/db';import {reclassifySectors} from './src/lib/ingest';reclassifySectors(getDb())"`

특정 기업만 상세 수집:

```bash
npx tsx scripts/ingest.ts --detail --corp 00937324,00372226
npx tsx scripts/ingest.ts --detail --only-consensus --limit 200   # 컨센서스 보유 기업
npx tsx scripts/ingest.ts --companies --detail --all              # 전종목 (느림, 1~2시간)
```

## 화면 (3계층 IA)

- `/` — **데스크 개요**: KOSPI/KOSDAQ 지수 + 섹터별 평균 상승여력 카드 + 최근 목표주가 상향/하향 Top
- `/companies` — **전체 리스트**: 전종목 검색/필터(시장·컨센서스)/정렬(시총·상승여력·커버수)
- `/sectors` — **섹터 리스트**: 광역 섹터별 기업수·시총합·평균 PER/PBR·평균 상승여력(분포 막대)
- `/sectors/{code}` — **섹터 상세**: 평균 지표 + 목표가 상향/하향 모멘텀(90일) + 구성 기업(상승여력순)
- `/companies/{corpCode}` — **기업뷰**:
  - 헤더: 현재가·시총·PER·PBR·선행PER·EPS·BPS·배당 + ★관심추가 + ↻최신 새로고침 + 섹터 링크
  - **증권사별 목표주가 비교표**: 증권사 N곳 목표가 내림차순, 애널리스트·리포트일·투자의견·
    목표가·상대막대·상향/하향·상승여력·AI요약(펼치기)
  - **실적 추이**: 분기별/연도별 토글, 매출액(순이자이익)·영업이익(총영업이익)·당기순이익
    + PER/PBR, 각 셀 YoY%, 추정치는 기울임/E
  - **변경 이력**: 목표가 상향·하향, 신규 커버리지, 분기 QoQ/YoY (날짜 포함)
- `/watchlist` — **관심목록** (로그인): 즐겨찾기 기업 + 알림 대상
- `/settings` — **알림 설정**: 텔레그램 chat_id, 알림 on/off
- `/login` — 로그인 / 회원가입
- `/changes` — 전체 변경 피드(구분 필터)
- `/docs/openapi.yaml` — OpenAPI 3.1 명세

## 로그인 · 관심목록 · 텔레그램 알림

1. `/login` 에서 가입(이메일+비번, scrypt 해시, httpOnly 세션 쿠키).
2. 기업뷰에서 **★ 관심추가** → `/watchlist` 에 모임.
3. `/settings` 에서 텔레그램 chat_id 입력.
   - 봇 토큰을 서버 env 에 설정: `BUTLER_TELEGRAM_BOT_TOKEN=...`
   - chat_id 확인: 봇에게 메시지 후 `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. 매일 폴링이 관심 기업의 **목표주가 변경**을 감지하면 텔레그램으로 발송(중복 발송 없음).

## 매일 갱신 (크론) — 증분 + 멱등

```bash
npm run refresh            # 자체 DB 만 갱신 (증분 신규 리포트 + 변경된 시세만)
npm run refresh:push       # 변경 있으면 GCS 업로드 + Cloud Run 재배포까지
npx tsx scripts/refresh-daily.ts --scope watchlist   # 관심목록만
```

- **증분**: 피드 최신순 → 이미 가진 리포트를 만나면 중단 → 최근 신규분만 받음.
- **멱등**: 시세/목표가는 값이 바뀐 경우에만 UPDATE. 같은 데이터로 여러 번 돌려도 DB 무변경
  (`updated_at` 도 그대로), 변경 없으면 GCS 업로드·재배포도 건너뜀.
- 변경이 있을 때만 `change_logs`(발생일 포함) + 텔레그램 알림(이번 실행 신규분만, 중복 없음).

crontab (매 영업일 18:30, 장 마감 후):

```
30 18 * * 1-5  cd /path/to/butler && npx tsx scripts/refresh-daily.ts --push --redeploy >> /tmp/butler-refresh.log 2>&1
```

> 전체 재수집(과거 깊이 보강)은 가끔 `npm run ingest:detail -- --only-consensus --feed-pages 25`
> + `npm run backfill:changes` 로. 자세한 배포·운영은 [DEPLOYMENT.md](./DEPLOYMENT.md).

## 데이터 출처와 게이팅 (중요)

| 데이터 | 비로그인 공개 | 로그인(구독) |
|---|---|---|
| 전종목 목록 / 현재 시세·PER·PBR | ✅ 전체 | ✅ |
| **증권사별 목표주가 / 컨센서스 리포트** | ✅ **최신까지** | ✅ |
| 재무 시계열(매출·영업이익·순이익), PER/PBR 과거값 | ⚠️ **~2023년까지** | ✅ 최신 분기 |

→ 핵심 기능(증권사별 기대주가 비교)은 공개 API 만으로 완전 동작.
최신 재무까지 원하면 **로그인 세션으로 캡처한 HAR** 을 `import-har` 로 넣으면
`consensus.isRevenue` 등에서 분기 실적/추정을 최신까지 백필한다(`isPreliminary` 로 구분).

## 아키텍처

```
scripts/ingest.ts          라이브 수집 CLI (screener enumerate → 상세 → 변경 감지)
scripts/import-har.ts      HAR 임포트 CLI (로그인 캡처 → 최신 재무 백필)
scripts/backfill-sectors.ts 섹터(업종) 백필
scripts/poll-daily.ts      ★ 일일 크론: 재수집 → 변경 로깅 → 스냅샷 → 텔레그램 알림
scripts/init-db.ts         스키마 적용

src/lib/butler.ts          업스트림 클라이언트 (토큰버킷 80req/min, 재시도)
src/lib/ingest.ts          upsert + 변경 감지(목표가 리비전 / QoQ·YoY) + 섹터 재분류
src/lib/import-har.ts      HAR 바디 → 동일 upsert 재사용
src/lib/sectors.ts         KSIC 산업코드 → 광역 섹터 매핑
src/lib/auth.ts            scrypt 해시 + 세션 토큰(httpOnly 쿠키)
src/lib/telegram.ts        텔레그램 봇 발송 + 알림 메시지 포맷
src/lib/poll.ts            일별 스냅샷 + 알림 디스패치(멱등)
src/lib/db.ts              SQLite 연결 + 자동 마이그레이트
src/lib/repo.ts            조회 계층 (API·서버컴포넌트 공용)
src/lib/format.ts          억/조 단위·퍼센트·업종별 라벨

src/app/(page)             /(데스크) /companies /sectors /sectors/[code]
                           /companies/[corpCode] /watchlist /settings /login /changes
src/app/api/proxy/[...path]  butler 투명 프록시
src/app/api/companies/*      로컬 DB API (목록/상세/컨센서스/재무/변경)
src/app/api/sectors/*        섹터 집계/상세
src/app/api/auth/*           signup/login/logout/me/telegram
src/app/api/watchlist        관심목록 CRUD
src/app/api/ingest           온디맨드 수집 트리거
db/schema.sql                정규화 스키마 (아래)
```

### 데이터 모델 (db/schema.sql)

- `companies` — 전종목 마스터 (corp_code=DART 8자리 PK, 시세/밸류 스냅샷, 커버리지)
- `brokers` — 증권사 마스터
- `consensus_reports` — 리포트 불변 저장(report_id 멱등). **리포트 1건 = 증권사 1곳 목표가**
- `target_price_monthly` — 월별 목표가 min/avg/max 집계 스냅샷
- `financials` — long-format 재무 (metric × year × quarter × period_type × is_estimate)
- `valuations` — PER/PBR 분기 시계열
- `change_logs` — 변경 이력 (목표가 상향/하향, QoQ/YoY, 신규 커버리지).
  **`occurred_at`=실제 발생일(리포트 발행일/분기말, 원본 기준)** + `observed_at`=우리가 감지한 시각.
  화면·정렬은 `occurred_at` 기준
- `daily_snapshots` — 매일 폴링이 기록하는 기업별 핵심 지표(가격/평균목표가/PER/PBR) 일별 스냅샷
- `users` / `sessions` / `watchlist` / `notifications` — 로그인·관심목록·알림(멱등 발송)
- 뷰: `v_latest_broker_target`(증권사별 최신 목표가) · `v_financials_growth`(QoQ·YoY, window LAG) ·
  `v_sector_agg`(섹터 집계)

## 환경변수

| 변수 | 용도 |
|---|---|
| `BUTLER_TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰(없으면 알림 발송 비활성, 그 외 정상) |
| `BUTLER_BASE_URL` | 알림 링크용 외부 URL (기본 http://localhost:3939) |
| `BUTLER_DB_PATH` | SQLite 경로 (기본 db/butler.db) |
| `BUTLER_RATE_PER_MIN` | 업스트림 분당 요청 상한 (기본 80) |

## 멱등성 / 변경 로깅

- `consensus_reports.report_id`, `financials` 복합 PK 로 **같은 기간을 다시 수집해도 중복 없음**.
- 재수집 때 직전 상태와 비교해 바뀐 것만 `change_logs` 에 기록(변경 있을 때만):
  - 증권사가 목표가를 바꾼 새 리포트 → `target_price` up/down (직전 리포트 대비 delta), `occurred_at`=리포트 발행일
  - 평균 목표주가 변동 → `consensus_avg`
  - 새 분기 실적 유입 → `financial` (QoQ/YoY %), `occurred_at`=분기말
- **raw 보존**: `consensus_reports` 가 증권사 리포트 원본(불변)을 그대로 보관 → "어느 증권사가
  언제 목표가를 얼마로 수정했는지"를 영구 추적. `change_logs` 는 그로부터 파생된 변경 타임라인.
- `npm run backfill:changes` — 원본 리포트일 기준으로 과거 변경 타임라인 전체 재생성(멱등).
