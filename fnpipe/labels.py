"""지표 라벨 정규화.

증권사/업종마다 같은 개념을 다른 라벨로 쓴다:
  매출액(제조) = 영업수익(통신·서비스) = 순영업수익(증권) = 순이자이익(은행)
              = 원수보험료·보험수익(보험)

- 각 metric의 라벨 리스트 순서가 우선순위다. 한 리포트에서 같은 (기간, 지표)에
  여러 라벨이 발견되면 우선순위 높은(앞쪽) 라벨 값이 이긴다.
  예: 손익계산서의 '영업이익'이 요약표의 '보험손익'을 이긴다.
- 본문 텍스트가 라벨 앞에 섞여 들어오는 경우가 있어 endswith 매칭을 쓰되,
  긴 라벨부터 검사해 '지배주주순이익'이 '순이익'으로 오인되는 것을 막는다.
- BLOCKED_SUFFIXES: endswith 매칭의 함정 라벨('비지배주주순이익' 등)을 먼저 차단.
"""
import re

METRIC_LABELS: dict[str, list[str]] = {
    "revenue": [
        "매출액", "영업수익", "순영업수익", "순이자이익", "보험수익",
        "원수보험료", "경과보험료", "순수수료이익", "매출",
    ],
    "operating_profit": [
        "영업이익", "총영업이익", "충전영업이익", "조정영업이익",
        "보험영업이익", "보험손익", "보험이익",
    ],
    "net_income": [
        "지배주주순이익", "지배순이익", "당기순이익", "순이익",
    ],
    "pretax_income": ["세전이익", "법인세차감전이익", "세전계속사업이익"],
    "per": ["PER", "P/E"],
    "pbr": ["PBR", "P/B"],
    "eps": ["EPS"],
    "bps": ["BPS"],
    "roe": ["ROE"],
    "roa": ["ROA"],
    "dps": ["DPS"],
}

# 사용자에게 보여줄 핵심 5개 지표 (계층 구조의 leaf)
CORE_METRICS = ["revenue", "operating_profit", "net_income", "per", "pbr"]

# 지표별 단위 클래스: 금액(억원 정규화) / 주당값(원) / 배수 / 비율
METRIC_UNIT = {
    "revenue": "KRW_100M", "operating_profit": "KRW_100M",
    "net_income": "KRW_100M", "pretax_income": "KRW_100M",
    "per": "X", "pbr": "X",
    "eps": "KRW", "bps": "KRW", "dps": "KRW",
    "roe": "PCT", "roa": "PCT",
}

# 억원 기준 환산 배수
MONEY_FACTOR = {"조원": 10000.0, "십억원": 10.0, "억원": 1.0, "백만원": 0.01}

# 정규화 라벨 → (canonical, 우선순위)
_LABEL_MAP: dict[str, tuple[str, int]] = {
    lab.upper(): (metric, pri)
    for metric, labs in METRIC_LABELS.items()
    for pri, lab in enumerate(labs)
}

_PAREN_RE = re.compile(r"\([^)]*\)")  # '당기순이익(지배)' → '당기순이익'
_SEP_RE = re.compile(r"[\s,·]+")
_LABEL_UNIT_RE = re.compile(r"\(\s*(조원|십억원|억원|백만원)")


def label_money_unit(raw_label: str) -> str | None:
    """행 라벨에 단위가 박혀 있으면 추출: '영업이익 (십억원)' → '십억원'.

    KB증권처럼 라벨에 단위를 명시하는 경우 테이블/페이지 캡션보다 신뢰도가 높다.
    """
    m = _LABEL_UNIT_RE.search(raw_label)
    return m.group(1) if m else None


def canonical_metric(raw_label: str) -> tuple[str, int] | None:
    """원문 행 라벨 → (canonical metric, 우선순위). 매칭 실패 시 None.

    토큰 경계 기반 정확 일치만 허용한다:
      - 괄호 제거 후 전체 일치: '당기순이익(지배)' → '당기순이익' ✓
      - 끝쪽 토큰 1~3개 결합 일치: 본문이 앞에 섞인 '… 경상 당기순이익' ✓
    부분 문자열 매칭은 하지 않으므로 '장기보험손익'이 '보험손익'으로,
    '비지배주주순이익'이 '순이익'으로 오인되지 않는다.
    """
    stripped = _PAREN_RE.sub(" ", raw_label)
    tokens = [t for t in _SEP_RE.split(stripped) if t]
    if not tokens:
        return None
    candidates = ["".join(tokens).upper()]  # 전체 결합 ('지배주주 순이익' 등)
    for k in (3, 2, 1):
        if len(tokens) >= k:
            candidates.append("".join(tokens[-k:]).upper())
    for cand in candidates:
        hit = _LABEL_MAP.get(cand)
        if hit:
            return hit
    return None


def normalize_value(metric: str, value: float, money_factor: float | None) -> tuple[float, str] | None:
    """지표 단위 클래스에 맞춰 (값, 단위) 반환. 금액인데 단위 미상이면 None."""
    unit = METRIC_UNIT[metric]
    if unit == "KRW_100M":
        if money_factor is None:
            return None
        return value * money_factor, unit
    return value, unit
