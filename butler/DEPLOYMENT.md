# butler.view 배포 가이드

다른 개발자가 이 프로젝트를 그대로 인계받아 운영/이전할 수 있도록 정리한 문서.
앱은 **Next.js 15 (App Router) + better-sqlite3** 단일 프로세스다. DB는 로컬 파일
하나(`db/butler.db`)이므로 "영속 디스크"만 있으면 어디서든 뜬다.

---

## 1. 구성 요소 한눈에

| 요소 | 정체 | 비고 |
|------|------|------|
| 웹 서버 | `next start -p 3939` | SSR + API 라우트. 1 인스턴스 |
| DB | SQLite 파일 `db/butler.db` (WAL) | **영속 볼륨 필수**. 서버리스 비권장 |
| 일일 폴링 | `scripts/poll-daily.ts` (cron) | 변경 감지·스냅샷·텔레그램 알림 |
| 업스트림 | `api.butler.works` (공개) | 인증 불필요. rate limit 100req/60s/IP |
| 알림 | Telegram Bot API | `BUTLER_TELEGRAM_BOT_TOKEN` 있을 때만 |

**핵심 제약**: SQLite는 한 파일에 한 쓰기 프로세스. 웹과 크론이 같은 파일을 쓰지만
WAL + `busy_timeout=5000` 으로 직렬화된다. **수평 확장(다중 인스턴스) 불가** —
필요해지면 Postgres 로 이전(아래 9번).

---

## 2. 사전 준비

- Node.js **20.x 이상** (better-sqlite3 prebuilt 바이너리 사용. 네이티브 빌드 시 build-essential/python3 필요)
- 디스크: DB 파일은 전종목 상세까지 넣어도 수십~수백 MB 수준

```bash
cd butler
npm ci            # 또는 npm install
```

## 3. 환경변수 (`.env.local`)

```bash
# 업스트림 (기본값 있음, 보통 그대로)
BUTLER_API_BASE=https://api.butler.works
BUTLER_RATE_PER_MIN=80               # 분당 호출 상한(100 미만 권장)

# DB 경로 (기본: ./db/butler.db). 영속 볼륨 경로로 바꾼다.
BUTLER_DB_PATH=/data/butler.db

# 알림용 (선택)
BUTLER_TELEGRAM_BOT_TOKEN=123456:ABC-...   # @BotFather 발급
BUTLER_BASE_URL=https://butler.example.com  # 알림 메시지의 링크 도메인
```

> 모든 값은 서버 전용. 클라이언트로 노출되는 `NEXT_PUBLIC_*` 는 없다.

## 4. 최초 데이터 적재 (순서 중요)

```bash
npm run db:init             # 1) 스키마 생성 (멱등)
npm run ingest:companies    # 2) 전종목 2,555개 목록  (~1분)
npm run backfill:sectors    # 3) 섹터(업종) 분류용 상세  (~30분, 멱등/재개가능)
npm run ingest:detail -- --only-consensus --feed-pages 25
                            # 4) 컨센서스 보유 기업 상세(증권사별 목표가+재무+과거 리포트)
npm run backfill:changes    # 5) 원본 리포트일 기준 변경이력 재생성
# (선택) 로그인 HAR 로 최신 재무(2024~) 백필:
npm run import:har -- /path/to/login-session.har
```

5번까지 끝나면 웹에서 전체/섹터/기업/변경이력이 모두 채워진다.
재실행해도 안전(UPSERT + 멱등). 중단 후 재개 가능.

## 5. 빌드 & 실행

```bash
npm run build      # next build (output: standalone)
npm run start      # next start -p 3939
```

standalone 출력은 `.next/standalone/` 에 self-contained 번들을 만든다. 단,
**better-sqlite3 네이티브 바이너리**와 `db/schema.sql`, `db/butler.db` 는 별도로
포함시켜야 한다(아래 Docker 참고).

## 6. 일일 갱신 크론 (증분 + 멱등)

장 마감 후 1회 권장. **`scripts/refresh-daily.ts`** 를 쓴다:
- **증분**: 피드가 최신순이라 이미 가진 리포트를 만나면 중단 → 최근 신규분만 받음(빠름).
- **멱등**: 시세/목표가는 값이 바뀐 경우에만 UPDATE. 같은 데이터면 DB 무변경.
- 변경 없으면 GCS 업로드·재배포까지 건너뜀(불필요한 배포 방지).
- 변경이 있을 때만 `change_logs` 에 발생일과 함께 기록 + 관심목록 유저에게 텔레그램 알림.

```cron
# 매 영업일(월~금) 18:30 KST — 자체 DB 갱신 후, 변경 있으면 GCS 업로드 + Cloud Run 재배포
30 18 * * 1-5  cd /app/butler && BUTLER_DB_PATH=/data/butler.db npx tsx scripts/refresh-daily.ts --push --redeploy >> /var/log/butler-refresh.log 2>&1
```

- 플래그: `--scope watchlist`(관심목록만) · `--push`(변경 시 GCS 업로드) · `--redeploy`(변경 시 Actions 재배포 트리거).
- `--push`/`--redeploy` 는 gcloud·gh 인증이 있는 환경에서만(없으면 자체 DB 갱신까지만).
- 전체 재수집(과거 깊이 보강)이 필요하면 `scripts/poll-daily.ts` 또는
  `ingest:detail --feed-pages N` 을 가끔 수동 실행.
- 크론과 웹은 **같은 `BUTLER_DB_PATH`** 를 봐야 한다.

## 7. Docker (권장 배포 형태)

```dockerfile
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production BUTLER_DB_PATH=/data/butler.db
# standalone 번들 + 네이티브 모듈 + 스키마/스크립트
COPY --from=deps /app/.next/standalone ./
COPY --from=deps /app/.next/static ./.next/static
COPY --from=deps /app/db/schema.sql ./db/schema.sql
COPY --from=deps /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=deps /app/scripts ./scripts
COPY --from=deps /app/src ./src
VOLUME /data
EXPOSE 3939
CMD ["node", "server.js"]
```

`-v butler-data:/data` 로 볼륨을 붙이면 DB 가 영속된다.

## 8. 호스팅 선택지

| 플랫폼 | 적합성 | 메모 |
|--------|--------|------|
| **소형 VPS** (Lightsail/Hetzner/EC2 t4g.small) | ★ 최적 | 디스크 영속 + cron 그대로. 가장 단순 |
| **Fly.io** | ★ 좋음 | volume 마운트(`/data`), 머신 1대로 고정. cron 은 `fly machine run` |
| **Render / Railway** | ○ | persistent disk 옵션 필요. cron job 별도 |
| **Cloud Run** | △ 비권장 | 파일시스템 휘발성 → SQLite 부적합. 굳이 쓰면 GCS-FUSE 볼륨+인스턴스1 고정(min=max=1) |

> 부모 레포(fnguide)에 Cloud Run/Cloud Build 설정이 있으나 그건 Python 파이프라인용.
> butler.view 는 SQLite 영속성 때문에 **단일 인스턴스 + 디스크** 모델로 가는 게 맞다.

## 9. Postgres 로 이전해야 할 때

다중 인스턴스/동시 쓰기/대량 트래픽이 필요해지면:
- `db/schema.sql` 은 이미 부모 프로젝트의 PostgreSQL 설계 철학(단일 팩트테이블,
  리포트 불변, long-format, 멱등 UPSERT)을 따르므로 이식이 쉽다.
- 바꿀 곳: `src/lib/db.ts`(드라이버), `INSERT ... ON CONFLICT`(거의 호환),
  윈도우 함수 뷰(`v_financials_growth`, `v_latest_broker_target`)는 그대로 동작.
- `better-sqlite3` 동기 API → `pg` 비동기로 repo 계층 함수 시그니처만 async 화.

## 10. 백업 / 운영

```bash
# 무중단 백업 (WAL 안전)
sqlite3 /data/butler.db ".backup '/data/backup/butler-$(date +%F).db'"
```

- 로그: 폴링은 `ingest_runs` 테이블에 실행 기록을 남긴다.
- 헬스체크: `GET /api/stats` → `{ companies, reports, changes, ... }`.
- rate limit 429 발생 시 `BUTLER_RATE_PER_MIN` 을 낮춘다(기본 80).

## 12. 자동배포 (GitHub Actions — 현재 설정)

`main` 에 push 하면 자동으로 Cloud Run 에 배포된다. 사람이 로그인할 필요 없음.

- 워크플로: [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) (저장소 루트 기준)
- 인증: GCP 서비스계정 `gh-deployer@protein-test-469413.iam.gserviceaccount.com`
  의 키를 GitHub 시크릿 **`GCP_SA_KEY`** 로 저장. 부여 역할:
  `run.admin`, `artifactregistry.writer`, `storage.objectViewer`,
  런타임 SA(`<projnum>-compute`)에 대한 `iam.serviceAccountUser`.
- 동작: GCS `butler.db` pull → `docker build butler` → Artifact Registry push →
  `gcloud run deploy fnbutler`. `butler/**` 또는 `cloudbuild.yaml` 변경 시에만 발동.
- 수동 실행: GitHub Actions 탭 → "deploy butler.view" → Run workflow.

> 키 교체: `gcloud iam service-accounts keys create k.json --iam-account=gh-deployer@…`
> → `gh secret set GCP_SA_KEY --repo stealstick/fnbutler < k.json` → `rm k.json`.

### 데이터 갱신 흐름 (중요)

배포 이미지는 **GCS 의 butler.db 를 구워서** 만든다. 따라서 라이브 데이터를 바꾸려면:

1. 로컬/CI 에서 수집·폴링으로 `butler/db/butler.db` 갱신
2. `gcloud storage cp butler/db/butler.db gs://protein-test-469413-fnbutler/butler.db`
3. 재배포(빈 커밋 push 또는 Actions 수동 실행) → 새 DB 가 구워짐

매일 자동 갱신은 위 1~3을 한 번에 하는 **`scripts/refresh-daily.ts --push --redeploy`** 를
크론에 걸면 된다(§6). 변경 없으면 업로드·재배포를 건너뛰어 같은 데이터로 여러 번 돌려도 안전.

### ⚠️ Cloud Run + SQLite 영속성 한계

Cloud Run 컨테이너 파일시스템은 **휘발성**이다. 즉 라이브에서 발생한 쓰기
(회원가입/관심목록/폴링 변경)는 **콜드스타트·재배포 시 사라진다**. 읽기 전용
스냅샷(목표주가/재무 조회)에는 문제없지만, 사용자 데이터를 영속하려면:
- **Fly.io + volume** (`/data` 마운트) 로 옮기거나,
- **Cloud SQL(Postgres)** 로 DB 이전(§9) — 다중 인스턴스/동시쓰기까지 해결.

개인 데스크/데모 용도면 현재 구조로 충분하고, 관심목록·알림을 여러 사용자가
영속적으로 써야 하면 위 둘 중 하나로 전환할 것.

## 11. 트러블슈팅

| 증상 | 원인/해결 |
|------|-----------|
| `SQLITE_BUSY` | 웹·크론 동시 쓰기. `busy_timeout` 이 처리하지만 폴링 시간을 트래픽 낮은 때로 |
| 재무가 2023까지만 | 비로그인 게이팅. 로그인 HAR 를 `import:har` 로 적재 (README 참고) |
| 네이티브 모듈 에러 | `npm rebuild better-sqlite3`. Node 메이저 버전 일치 확인 |
| 알림 안옴 | `BUTLER_TELEGRAM_BOT_TOKEN` 미설정 / 유저 `telegram_chat_id` 미입력 / `alerts_enabled=0` |
| 변경이력이 다 오늘 날짜 | `npm run backfill:changes` 로 원본 리포트일 기준 재생성 |
