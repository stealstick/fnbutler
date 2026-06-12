# fnguide 리서치 추정치 수집 파이프라인

fnguide.com 의 증권사 리서치 PDF를 매일 수집해 기업별 재무 추정치
(매출액 / 영업이익 / 당기순이익 / PER / PBR — 분기·연간, 실적·추정)를
DB에 적재하고, **기업 → 증권사 → 기간 → 지표** 계층으로 조회한다.

## 동작 플로우

```
1. 리포트 목록 — POST /Research/GetReports (둘 중 하나)
   · 기업별:   srchTyp=1, srchCode=종목코드            → 그 기업 리포트만
   · 전 종목:  srchTyp=0, estTyp=2, ordCol=ANL_DT      → 전 종목 최신 피드(하루 수십~수백건)
   메타데이터(증권사·발행일·목표가·투자의견)가 JSON에 전부 들어있어 PDF에서 안 긁어도 됨
2. GET  /Research/PdfViewer?rptId=N ← hidden input #documentData 추출
       ※ documentData는 페이지 로드마다 새로 발급되는 단기 토큰 (재사용 불가)
3. PDF 받기 (뷰어 종류에 따라 분기)
   · 일반(대부분):  POST /Research/GetPdfFile → {"dataSet":"data:application/pdf;base64,..."}
   · Syncfusion:    documentData 없이 documentPath만 존재. Load는 되지만 Download/Render는
                    403으로 차단(한국투자증권 등) → 'blocked' 표시 + 브라우저 폴백 대상
4. 표 추출 (2단 폴백)
   · 1차: pdfplumber 좌표 클러스터링 (텍스트 PDF)
   · 2차: 비전 AI (이미지/벡터 PDF·비정형 — 좌표 파서가 빈약할 때만)
5. 라벨/단위/기간 정규화 → reports + report_financials 적재 (fn_rpt_id 멱등)
```

## 설치 / 사용

```bash
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 인증 (둘 중 하나)
#  A) 자동 로그인(권장): .env 에 FNGUIDE_USER_ID/PW 설정 → 쿠키 만료 시 자동 재로그인
#  B) 쿠키: 브라우저 DevTools → Network → Cookie 헤더 값 전체 → .secrets/cookie.txt
cp .env.example .env   # 편집해서 자격증명/API키 입력

.venv/bin/python -m fnpipe init-db
.venv/bin/python -m fnpipe add-company --code 005830 --name DB손해보험
.venv/bin/python -m fnpipe add-company --code 105560 --name KB금융

# 수집 — 두 방식
.venv/bin/python -m fnpipe sync --days 7           # 등록 기업별로 각각 조회
.venv/bin/python -m fnpipe feed --days 3           # 전 종목 피드에서 등록 기업만 골라 수집(권장)
.venv/bin/python -m fnpipe sync --code 005830 --days 35 --limit 5

.venv/bin/python -m fnpipe show --code 005830      # 계층 구조 출력
.venv/bin/python -m fnpipe reparse --rpt-id 1103861          # 매핑 룰 수정 후 재파싱
.venv/bin/python -m fnpipe reparse --rpt-id 1090746 --ai     # 비전 폴백으로 이미지 PDF 재파싱
```

`sync`(기업별 N회) vs `feed`(전 종목 1패스 후 필터): 등록 기업이 많을수록 `feed`가
호출 횟수를 크게 줄인다. 둘 다 `fn_rpt_id` 멱등이라 매일 돌려도 신규만 처리.

매일 자동 수집 (crontab 예시, 평일 18시):
```
0 18 * * 1-5 cd /Users/kimjuyong/project/fnguide && .venv/bin/python -m fnpipe feed --days 3 >> data/sync.log 2>&1
```

### 비전 AI 폴백 (`--ai`)

이미지/벡터로 그려진 PDF(다올·미래에셋 등 — 텍스트 추출 ≈ 0)나 좌표 파서가 못 잡는
비정형 표는 페이지를 이미지로 렌더해 LLM에게 읽힌다. 백엔드 자동 선택:

- **`ANTHROPIC_API_KEY` 설정 시** → Anthropic SDK (프로덕션 권장, 검증됨)
- 미설정 시 → `claude` CLI headless (로컬용; 다른 claude 세션 안에서 중첩 실행하면 hang할 수 있음)

`sync`/`feed`/`reparse` 에 `--ai` 를 붙이면 좌표 파싱이 빈약한 리포트에만 선별 적용된다
(매 리포트마다 부르지 않음 — 비용 절약). 모델은 `FNGUIDE_VISION_MODEL` 로 변경.

DB는 기본 SQLite(`data/fnguide.db`). 운영 전환 시 `DATABASE_URL` 환경변수로
PostgreSQL 지정 (`schema.sql` 이 운영용 DDL + 최신추정치 뷰 정의).

## 스키마 설계 (schema.sql)

| 테이블 | 역할 |
|---|---|
| `companies` | 수집 대상 기업 (stock_code 유니크) |
| `brokers` | 증권사 (fnguide 코드 + 이름) |
| `reports` | 리포트 1건 = 1행. fn_rpt_id 유니크(멱등), 투자의견/목표가/PDF경로/파싱상태, raw_tables(JSON 원본) |
| `report_financials` | 지표 1개 = 1행 (long format). (report, 기간, 지표) 유니크 |
| `v_latest_estimates` | 증권사별 최신 리포트만 골라 5개 지표로 피벗한 뷰 — UI 계층이 이 뷰 한 장 |

핵심 설계 결정:

1. **기업별 테이블 분리 안 함.** 기업마다 테이블을 만들면 기업 추가 시 DDL이
   필요하고 교차 조회가 불가능하다. 단일 팩트 테이블 + `company_id` 인덱스로
   "기업별 관리"는 WHERE 절 하나다.
2. **리포트는 불변, "최신값"은 뷰.** 같은 증권사가 추정치를 수정하면 새 report
   행이 쌓일 뿐이고 `v_latest_estimates` 가 자동으로 최신을 가리킨다.
   덕분에 추정치 리비전 히스토리가 공짜로 남는다.
3. **지표는 long format + canonical 코드.** 업종마다 라벨이 다르다
   (제조 매출액 = 은행 순이자이익 = 보험 원수보험료/보험수익). `metric` 은
   canonical 코드, `raw_label` 에 원문을 보존한다. 매핑 룰은 `fnpipe/labels.py`
   의 dict 하나 — 새 라벨 변형은 거기 한 줄 추가 후 `reparse`.
4. **금액은 억원으로 정규화** (`unit=KRW_100M`). 십억원/조원/백만원 표기는
   환산하고, 원 단위(EPS/DPS)·배(PER/PBR)·%(ROE)는 그대로.

## 파서 (fnpipe/parser.py)

괘선 없는 사이드바·2단 레이아웃 때문에 pdfplumber `extract_tables` 가 아니라
단어 좌표를 직접 클러스터링한다:

- **A형 (행=지표, 열=기간)**: `2025 / 2026E / 2Q26E` 기간 토큰 2개 이상인 라인을
  헤더로 잡고, 숫자를 가장 가까운 컬럼에 스냅. 헤더 x범위 밖(다른 단), 컬럼에
  정렬 안 되는 숫자(YoY/QoQ/컨센서스 서브컬럼)는 버린다. 나란히 붙은 두 테이블은
  기간 토큰 간 x 간격으로 분리. 라벨과 숫자가 별도 라인으로 갈라진 행은 재결합.
- **B형 (행=기간, 열=지표, LS증권 'Financial Data' 형)**: 기간 토큰 1개 + 우측
  숫자 3개 이상인 라인 묶음을 전치해 A형과 같은 구조로 반환.
- **버림 컬럼**: 헤더/서브헤더의 비기간 단어(KB추정치·잠정치·YoY·QoQ 등) 위치로
  스냅되는 숫자는 폐기 — 병합 헤더의 모호한 값이 기간 컬럼을 오염시키지 않는다.
- **셀 충전율 게이트**: 매핑된 행들의 값 충전율 40% 미만이면 테이블 폐기
  (컬럼 정렬이 깨진 테이블의 행 시프트 오염 방지).
- **단위 우선순위**: 행 라벨 내 `(십억원)` > 테이블 캡션 `단위: …` > 페이지 캡션.
  본문 문장 속 "0.6조원" 같은 우연한 언급은 무시.

검증: DB손해보험 최근 35일 25건 중 21건 파싱(증권사 리포트 기준 91%),
1Q26 영업이익 4,627~4,630억으로 전 증권사 교차 일치, 2026E 순이익
13,000~15,700억 수렴 확인.

## 인증 / 자동 로그인

세션 쿠키(`fnguide.Auth`)는 수명이 짧다. `.env` 에 `FNGUIDE_USER_ID/PW` 를 넣으면
요청이 401을 받는 순간 자동으로 재로그인하고 새 쿠키를 `.secrets/cookie.txt` 에 저장한다.

- 로그인 흐름: `GET /Users/Login`(토큰·공개키 획득) → 비밀번호를 **RSA-OAEP/SHA-256**
  으로 암호화 → `POST /Users/UserLogin`. 캡차 없음.
- **20분 중복 로그인 제한**: 같은 계정이 최근 20분 내 로그인했거나 브라우저에서 활성
  세션이면 "20분 이내 사용했음"으로 거부된다. 매일 1회 크론(사용자 비활성 시간)에선
  문제없지만, 개발 중 연속 로그인하면 걸린다.

## 알려진 한계 / 다음 단계

- **쿠키 수명**: 자동 로그인 미설정 시 `fnguide.Auth` 만료 → 브라우저에서 쿠키 재복사.
- **이미지/벡터 PDF**(다올·미래에셋 등 — 텍스트≈0): 좌표 파서로는 no_table.
  `--ai` 비전 폴백으로 구제됨(검증: 다올 1090746 no_table → coord+vision 38건,
  연간 PER/PBR·분기 영업이익/순이익 정확 추출).
- **원문 자체 오류는 그대로 적재** (예: 교보 5/18 리포트의 PBR 8.29는 원문 인쇄
  값). 다음 단계로 같은 (기간,지표)의 증권사 간 중앙값 대비 이상치 플래깅 권장.
- 영업이익이 없는 보험 리포트는 `보험손익` 이 fallback 매핑됨 — `raw_label` 로
  구분 가능. UI에서 라벨 병기 권장.
- 유저 노출용 API(FastAPI 등)는 `v_latest_estimates` 뷰를 그대로 직렬화하면 됨.
