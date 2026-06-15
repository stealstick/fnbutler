# CLAUDE.md — butler.view

butler.works 데이터를 자체 정규화 DB로 모아 **기업/섹터/증권사별 목표주가·컨센서스**를
비교하는 애널리스트 데스크(웹). 이 파일은 이 프로젝트에서 작업하는 Claude/개발자를 위한 안내다.

## 1. 한 줄 요약 / 라이브

- 라이브: **https://fnbutler-l3why3suea-du.a.run.app** (Cloud Run, asia-northeast3)
- 로컬: `npm run dev` → http://localhost:3939
- 데이터 출처: 전부 `source = "butler"` (api.butler.works 리버스 엔지니어링). 출처 분석은 메모리 `butler-works-consensus-api` 참고.

## 2. 기술 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 프레임워크 | **Next.js 15 (App Router) + React 19 + TypeScript** | `output: standalone` |
| 시세/컨센서스 DB | **SQLite (better-sqlite3)** `db/butler.db` | 조인·집계·윈도우함수 필요. 읽기 위주, 매 배포 GCS에서 재시드 |
| 유저 DB | **Firestore (Native, 서울리전)** | 회원/세션/관심목록/알림. 배포해도 영속. 로컬은 SQLite 폴백 |
| 런타임 스크립트 | **tsx** | 수집/갱신 CLI (`scripts/*.ts`) |
| 호스팅 | **Cloud Run** (min=0, max=1, 1CPU/1Gi) | 스케일투제로 → 유휴 시 ~무료 |
| 데이터 보관 | **GCS** `gs://protein-test-469413-fnbutler/butler.db` | 배포 이미지에 굽는 시세 DB 스냅샷 |
| CI/CD | **GitHub Actions** (repo `stealstick/fnbutler`, PUBLIC=무료) | push 배포 + 일일 크론 |
| 알림 | **Telegram Bot API** | `BUTLER_TELEGRAM_BOT_TOKEN` 있을 때만 |
| GCP 프로젝트 | `protein-test-469413` (번호 765232817913) | 리전 asia-northeast3 |

## 3. 아키텍처 / 데이터 흐름

```
            ┌─ 라이브(Cloud Run, 읽기 위주) ─────────────────────────┐
api.butler  │  Next 서버  ── SQLite(butler.db, 이미지에 구움) 읽기    │
   .works   │            └─ Firestore  ←→ 회원/관심목록/세션/알림     │
     ▲      └──────────────────────────────────────────────────────┘
     │ 수집(공개 API)                          ▲ 배포(이미지 빌드)
     │                                         │
GitHub Actions 일일 크론(refresh.yml)          GitHub Actions(deploy.yml, push 시)
  GCS butler.db pull → 증분·멱등 갱신 →         GCS butler.db pull → 이미지 빌드 →
  변경 시 GCS 업로드 + 빌드/배포 + 텔레그램알림    Cloud Run 배포
```

- **시세/컨센서스 데이터**: SQLite. 라이브에선 읽기 전용에 가깝다(배포 때 GCS 스냅샷을 이미지에
  구움). 갱신은 오프라인(크론/CLI)이 담당 → GCS 업로드 → 재배포. 그래서 "배포 시 초기화"가
  문제되지 않는다(최신본을 다시 굽는 것).
- **유저 데이터**: Firestore. 라이브에서 발생(회원가입/관심목록)하며 배포와 무관하게 영속.
  ⚠️ Cloud Run FS는 휘발성이라 유저 데이터를 SQLite에 두면 재배포 때 사라진다 → Firestore로 분리한 이유.

## 4. 데이터 모델 (`db/schema.sql`)

설계 철학(부모 fnguide schema.sql 계승): 단일 팩트테이블+`corp_code` FK, 리포트 불변/멱등,
long-format 지표, 최신값·파생지표는 뷰로 계산, 모든 적재 `source='butler'`.

- `companies` — 전종목 마스터(2,555). `corp_code`=DART 8자리 PK. 시세/밸류 스냅샷 + `sector_code`(광역섹터) + `has_consensus`.
- `consensus_reports` — 리포트 불변 저장(`report_id` 멱등). **리포트 1건 = 증권사 1곳 목표가**. 원본(raw).
- `target_price_monthly` — 월별 목표가 min/avg/max 집계.
- `financials` — long-format 재무(metric×year×quarter×period_type×is_estimate).
- `valuations` — PER/PBR 분기 시계열.
- `change_logs` — 변경 이력. `occurred_at`(실제 발생일=리포트일/분기말) + `observed_at`(감지시각).
- `daily_snapshots` — 일별 핵심지표 스냅샷.
- 유저 테이블(`users/sessions/watchlist/notifications`)은 로컬 SQLite 폴백용으로만 존재. prod는 Firestore.
- 뷰: `v_latest_broker_target`(증권사별 최신 목표가), `v_financials_growth`(QoQ/YoY, window LAG), `v_sector_agg`(섹터 집계).

## 5. ⚠️ 데이터 소스 / 인증 게이팅 (꼭 알아야 함)

- 목표주가·컨센서스 리포트: 비로그인 공개 → 최신까지 수집 가능.
- **재무 시계열(매출/영업이익/순이익, PER/PBR 과거값): 비로그인 시 ~2023년까지만**. 최신 분기는 로그인(구독) 세션 필요.
  → 로그인 캡처 HAR을 `scripts/import-har.ts`로 적재하면 최신 재무 백필됨.
- 커버리지: 전종목 2,555 중 **분석보고서(최근1년)≥1 = ~1,386개만** 목표주가 존재. 나머진 무커버(목표가 없음).
- 레이트리밋: api.butler.works 분당 100요청/IP. 수집기는 `BUTLER_RATE_PER_MIN`(기본 80)로 셀프 throttle.

## 6. 수집/갱신 스크립트 (`scripts/`)

| 명령 | 용도 |
|---|---|
| `npm run db:init` | 스키마 생성(멱등) |
| `npm run ingest:companies` | 전종목 목록(스크리너) |
| `npm run ingest:covered` | 커버리지 전종목 목표가 수집(batch 10/10s 점잖게) |
| `npm run ingest:detail -- --only-consensus --feed-pages 25` | 상세(증권사 목표가+재무+과거리포트) |
| `npm run backfill:sectors` | 섹터(업종) 분류 백필 |
| `npm run backfill:changes` | 변경이력을 원본 리포트일 기준 재생성 |
| `npm run import:har -- <file.har>` | 로그인 HAR로 최신 재무 백필 |
| `npm run refresh` / `refresh:push` | **일일 증분·멱등 갱신** (+ 변경 시 GCS 업로드/재배포) |

**증분·멱등 핵심**: `ingestNewReports`(피드 최신순, 이미 가진 report_id 만나면 중단 → 신규분만),
`refreshCompanyQuote`(시세/목표가 값이 바뀐 경우에만 UPDATE; `toNum`으로 "N/A"→null NaN오탐 방지).
변경 없으면 GCS 업로드·재배포까지 건너뜀.

## 7. 배포 / CI/CD

- **push 자동배포** (`.github/workflows/deploy.yml`): main에 `butler/**` push → GCS DB pull → 이미지 빌드/푸시 → Cloud Run 배포. 인증=`gh-deployer` SA 키(GitHub 시크릿 `GCP_SA_KEY`).
- **일일 크론** (`.github/workflows/refresh.yml`): 매 영업일 18:30 KST(09:30 UTC) + 수동(workflow_dispatch). GCS DB pull → `refresh-daily.ts`(증분·멱등) → 변경 시 GCS 업로드 + 빌드/배포 + 텔레그램 알림(대상은 Firestore에서 조회, `BUTLER_USERSTORE=firestore`). 문서(*.md)만 바뀌면 배포 제외.
- 수동 배포: `bash butler/scripts/deploy.sh` (로컬 docker 빌드→푸시→배포).
- 데이터 갱신을 prod에 반영: 로컬 수집 → `gcloud storage cp db/butler.db gs://…/butler.db` → 재배포(또는 크론이 처리).

## 8. 비용 (월, ~$0 목표)

- Cloud Run min=0 → 유휴 무료(무료한도 내). 콜드스타트 ~2초.
- Firestore: 무료한도(유저 데이터 소량) → ~$0.
- GitHub Actions: repo PUBLIC → **무제한 무료**.
- GCS(4MB DB) + Artifact Registry(이미지) → 수 센트.
- 합계 사실상 **$0~2/월**. (콜드스타트 없애려 min=1 두면 ~$30~45/월이라 비권장)

## 9. 환경변수

| 변수 | 용도 |
|---|---|
| `BUTLER_USERSTORE` | `firestore`(prod) / 미설정(로컬 SQLite) |
| `BUTLER_DB_PATH` | SQLite 경로 (prod `/app/db/butler.db`) |
| `BUTLER_BASE_URL` | 알림 링크 도메인 |
| `BUTLER_TELEGRAM_BOT_TOKEN` | 텔레그램 봇(없으면 알림·웹훅 비활성) |
| `BUTLER_TELEGRAM_WEBHOOK_SECRET` | 웹훅 위조 검증 시크릿(선택, setWebhook secret_token 과 동일) |
| `BUTLER_TELEGRAM_BOT_USERNAME` | 봇 username 강제(선택, 미설정 시 getMe 자동 조회) |
| `BUTLER_RATE_PER_MIN` | 업스트림 분당 호출 상한(기본 80) |
| `GOOGLE_APPLICATION_CREDENTIALS` | 로컬에서 Firestore 테스트 시 SA 키 경로 |

### 텔레그램 자동 연결(딥링크)

`/settings` 의 **텔레그램 연결** 버튼이 일회성 토큰을 발급(`/api/auth/telegram/link`) →
`https://t.me/<bot>?start=<token>` 딥링크로 봇을 시작하면 웹훅(`/api/telegram/webhook`)이
그 토큰으로 계정을 찾아 `chat_id` 를 자동 바인딩한다(수동 입력 불필요). 토큰은 SQLite
`telegram_link_tokens` / Firestore `tg_link_tokens` 에 저장(15분 만료·일회용). 최초 1회
`npm run telegram:setup`(env: 토큰·BASE_URL·시크릿) 으로 setWebhook 등록이 필요하다.
봇 토큰/웹훅 시크릿은 GitHub Secrets(`BUTLER_TELEGRAM_BOT_TOKEN`,
`BUTLER_TELEGRAM_WEBHOOK_SECRET`) → 두 워크플로의 Cloud Run `--set-env-vars` 로 주입된다.

## 10. 화면 (3계층 IA)

`/`(데스크 개요) · `/companies`(전체) · `/sectors`+`/sectors/[code]`(섹터) ·
`/companies/[corpCode]`(증권사별 목표가 비교+차트오버레이+분기/연간 재무+변경이력) ·
`/watchlist` `/settings` `/login` `/changes`. API 명세: `public/docs/openapi.yaml`.

## 11. 컨벤션 / 주의

- 한국어 UI, 다크 터미널 테마. 상승=빨강/하락=파랑(한국식).
- 숫자 포맷은 `src/lib/format.ts`에서 로케일 `en-US` 고정(SSR/CSR hydration 일치).
- `getDb()`는 최초 연결 시 자동 migrate(+busy_timeout 5s). 스키마 변경은 `db/schema.sql` + `migrate()`의 ALTER 가드.
- **작업 단위마다 커밋+푸시**(사용자 지시). 커밋 메시지 한국어, Co-Authored-By 트레일러.
- 배포/문서는 `DEPLOYMENT.md`, `README.md` 와 함께 최신 유지.
