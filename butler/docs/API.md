# butler.works API 정리 (HAR 리버스 엔지니어링)

`api.butler.works` 내부 API 를 HAR 캡처(841 + 52 요청)로 분석해 정리한 문서.
기계가독 명세는 [`openapi.yaml`](../public/docs/openapi.yaml).

## 공통 사실

- **베이스**: `https://api.butler.works`
- **인증**: 공개 엔드포인트는 토큰/쿠키 불필요. `Access-Control-Allow-Origin: *`.
- **레이트리밋(비로그인)**: IP당 60초에 100요청 (`x-ratelimit-limit-user: 100`,
  `x-ratelimit-reset-user: 60`). 파트너십 키는 500.
- **필수 헤더**: `origin: https://www.butler.works`, `referer: https://www.butler.works/`
  (없어도 대개 동작하나 붙이는 게 안전).
- **기업 식별자**: `corpCode` = **DART 고유번호 8자리**(`00126380`=삼성전자),
  `stockCode` = 6자리(`005930`).
- **데이터 게이팅**: 목표주가/컨센서스는 비로그인도 최신까지. 재무 시계열은
  비로그인 시 **~2023년까지**, 로그인(구독) 세션만 최신 분기까지. 응답의
  `isLegacyMasking: true` 가 마스킹 신호.

---

## 1. 전종목 가져오기 (2,555개) — 스크리너

전종목 enumerate 의 출발점. `filters: []` = 조건 없음.

```bash
# 전체 개수
curl -s https://api.butler.works/api/screener/count \
  -H 'content-type: application/json' -H 'origin: https://www.butler.works' \
  -d '{"filters":[]}'
# → {"count":2555}

# 페이지네이션 (시총 내림차순)
curl -s https://api.butler.works/api/screener/screen \
  -H 'content-type: application/json' -H 'origin: https://www.butler.works' \
  -d '{"filters":[],"orderBy":"DESC","orderColumn":"marketCap","page":1,"size":50}'
```

```jsonc
// screen 응답
{ "columns": null,
  "results": [
    { "stockCode":"005930","stockName":"삼성전자","corpCode":"00126380",
      "price":333000,"fluctuationRate":"11.37","marketCap":"1946810776464000" }
  ] }
```

→ `ceil(2555/50)=52` 페이지로 전종목 corpCode 확보.

---

## 2. 기업 기본정보 / 현재 시세·밸류

```bash
curl -s https://api.butler.works/api/companies/00937324 -H 'origin: https://www.butler.works'
```

```jsonc
{ "corpCode":"00937324","stockCode":"161390","stockName":"한국타이어앤테크놀로지",
  "corpCls":"Y",            // Y=KOSPI, K=KOSDAQ
  "codeNameKR":"고무제품 제조업","industryCode":"221","fsDiv":"CFS",
  "priceInfo": { "price":73100,"per":"8.11","pbr":"0.71","fper":"6.75",
                 "eps":9008.5,"bps":102691.4,"dps":2300,"marketDividendYield":"3.15",
                 "marketCapital":"9055267543900" },
  "menuOptions": { "consensus":true, "fundamental":true } }
```

→ **현재 PER/PBR/시세는 비로그인도 최신**.

---

## 3. 증권사별 목표주가 (핵심)

### 3-1. 월별 집계 차트

```bash
curl -s 'https://api.butler.works/api/consensus/target-prices?corpCode=00937324' \
  -H 'origin: https://www.butler.works'
```

```jsonc
{ "charts": {
    "targetPrices": [
      { "max":62000,"avg":55154,"min":46000,"date":"25.07","fullDate":"2025.07.31",
        "price":44450,"coverSecurities":14,"returnRatio":0.2408 }
    ],
    "stocksHistories": [ { "date":"25.07","value":44450 } ] },
  "tables": { "price":73100,"targetPriceAvg":84375,"returnRate":"15.4","coverSecurities":16 } }
```

### 3-2. 증권사별 개별 리포트 — 피드에서 `type=CONSENSUS`

리포트 1건 = **증권사 1곳의 한 시점 목표가**. 페이지네이션은 `nextCursor`(base64).

```bash
curl -s 'https://api.butler.works/api/feed/00937324?limit=15&nextCursor=' \
  -H 'origin: https://www.butler.works'
```

```jsonc
{ "nextCursor":"MzY1...","hasNext":true,
  "data": [
    { "id":3941257,"type":"CONSENSUS","corpCode":"00937324",
      "contents": { "reportId":"51291",
        "values": { "date":"2026.06.12","analyst":"김귀연","securitiesCompany":"대신증권",
          "targetPrice":93000,"priceClose":72450,"rating":"매수 (BUY)",
          "ratingChange":"유지","targetPriceChange":"유지","returnRate":"28.4",
          "aiSummary":"- 밸류업 공시 …" } } }
  ] }
```

### 3-3. 리포트 상세

```bash
curl -s https://api.butler.works/api/consensus/reports/51291 -H 'origin: https://www.butler.works'
# → securitiesCompanyUrl(리서치 포털), aiSummary(전문 요약) 포함
```

### 3-4. 커버 증권사 목록

```bash
curl -s 'https://api.butler.works/api/consensus/securities-companies?corpCode=00937324'
# → {"data":[{"corpName":"대신증권"}, …]}
```

---

## 4. 재무 (매출·영업이익·순이익·PER·PBR)

가장 큰 응답. 하나로 실적 시계열 + 컨센서스 추정 + 밸류에이션 + 목표주가까지.

```bash
curl -s 'https://api.butler.works/api/v2/analysis/summary/00937324?fsDiv=MFS&quarterPeriod=accumulated'
```

핵심 필드:

| 경로 | 의미 | 비고 |
|---|---|---|
| `fs.isRevenue` / `isOperatingProfitLoss` / `isNetIncome` | 매출/영업이익/순이익 | **accumulated=TTM(과거 12M 롤링)**. 연간값=`quarter==4` |
| `consensus.isRevenue` / `isOperatingProfitLoss` | **분기 단독** 실적+추정 | `isPreliminary===null` → 미래 추정치. (순이익 시계열 없음) |
| `valuations.valPER.data` / `valPBR.data` | 분기 PER/PBR | `{date,value}` |
| `consensus.targetPrices` | 월별 목표가 | 3-1 과 동일 |

> ⚠️ 비로그인은 `quarterPeriod` 무관하게 `fs.*` 가 **~2023Q4 까지만** 채워지고
> 이후는 `value:null`. 최신까지 받으려면 로그인 세션(HAR) 필요.

`fsDiv`: `MFS`(주재무, 기본) · `CFS`(연결) · `OFS`(별도).
`quarterPeriod`: `quarter` · `accumulated` · `year`.

---

## 5. 기타

| 엔드포인트 | 용도 |
|---|---|
| `GET /api/markets/all` | KOSPI/KOSDAQ 지수 스냅샷 |
| `GET /api/analysis/valuations/bands?corpCode=&fsDiv=MFS` | PER/PBR 밴드 |
| `GET /api/v2/consensus/reports?cursor=&filter=ALL` | 컨센서스 글로벌 피드 |
| `GET /api/feed/{corpCode}/recent-disclosure` | 최근 공시 |
| `GET /api/disclosures/dividend/cash/{corpCode}` | 현금배당 공시 |
| `GET /api/trade/hs-codes?corpCode=` | 수출입 HS코드 |

---

## 본 프로젝트의 매핑

| butler 응답 | → 로컬 테이블 |
|---|---|
| `screener/screen.results[]` | `companies` |
| `companies/{corp}.priceInfo` | `companies`(시세/밸류 스냅샷) |
| `feed[].contents(type=CONSENSUS)` | `consensus_reports` + `brokers` |
| `consensus/target-prices.charts` | `target_price_monthly` |
| `summary.fs.*` / `consensus.is*` | `financials` (분기 Q / 연간 A / 추정) |
| `summary.valuations.valPER/valPBR` | `valuations` |
| 재수집 diff | `change_logs` (목표가 up/down, QoQ/YoY) |
