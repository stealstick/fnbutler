"""PDF에서 기간(연/분기) 헤더를 가진 재무 테이블을 좌표 기반으로 추출.

증권사마다 테이블에 괘선이 없거나(사이드바 요약), 본문과 2단 레이아웃으로
겹치기 때문에 pdfplumber의 extract_tables 대신 단어 좌표를 직접 클러스터링한다.

지원하는 두 가지 테이블 방향:
  A) 행=지표, 열=기간  (NH 사이드바, 손익계산서 등 일반형)
     1) 단어를 y좌표로 순차 클러스터링해 시각적 라인 복원
     2) '2025 / 2026E / 2Q26E' 같은 기간 토큰이 2개 이상 모인 라인 = 헤더
        — 토큰 간 x 간격이 크게 벌어지면 나란히 붙은 별개 테이블로 분리
     3) 헤더 컬럼의 x중심 기준으로 아래 라인의 숫자를 가장 가까운 컬럼에 배정
        - 헤더 x범위 밖 단어 무시 → 2단 레이아웃의 다른 단 오염 차단
        - 컬럼에 정렬되지 않는 숫자는 버림 → y-y, 컨센서스 등 서브컬럼 차단
  B) 행=기간, 열=지표  (LS증권 등의 'Financial Data' 전치형)
     기간 토큰이 정확히 1개이고 그 오른쪽에 숫자가 3개 이상인 라인이 2줄 이상
     연속되면 전치 테이블로 보고, 위쪽 라인에서 컬럼별 지표 라벨을 스냅한다.
     결과는 A형과 같은 (지표 라벨, 기간별 값) 구조로 전치해 반환한다.
"""
import re
from dataclasses import dataclass, field

import pdfplumber

from .periods import PERIOD_RE, parse_period

NUM_TOKEN_RE = re.compile(r"^\(?-?[\d,]+(?:\.\d+)?\)?%?$")
NULL_TOKENS = {"-", "N/A", "n/a", "적자", "흑전", "적전", "잠식"}
STOP_PREFIXES = ("자료", "주:", "주1", "주2", "단위", "※", "참고")

COL_SNAP_PT = 25       # 숫자를 컬럼에 배정할 때 허용하는 x중심 거리
LABEL_MARGIN_PT = 170  # 첫 컬럼 왼쪽으로 라벨을 찾는 범위
LINE_YTOL_PT = 2.5     # 같은 시각적 라인으로 묶는 y 허용오차
HEADER_SPLIT_GAP = 3.0  # 기간 토큰 간격이 중앙값의 이 배수를 넘으면 별개 테이블


# 금액 단위 캡션: '(단위: 십억원, %)' 또는 '(십억원)' — 본문 문장 속 '0.6조원' 같은
# 우연한 언급에 속지 않도록 캡션 형태만 인정한다.
UNIT_CAPTION_RE = re.compile(r"(?:단위\s*[:：][^\n]*?|\(\s*)(조원|십억원|억원|백만원)")


@dataclass
class ParsedTable:
    page: int                      # 1-based
    periods: list[str]             # 원문 기간 토큰 ['2025', '2026E', ...]
    rows: list[tuple[str, list[str | None]]] = field(default_factory=list)
    money_unit: str | None = None  # 테이블/페이지 캡션에서 감지한 금액 단위명
    transposed: bool = False       # 원문이 B형(행=기간)이었는지

    def to_json(self) -> dict:
        return {"page": self.page, "periods": self.periods,
                "money_unit": self.money_unit, "transposed": self.transposed,
                "rows": self.rows}


def _is_period(text: str) -> bool:
    return bool(PERIOD_RE.match(text)) and parse_period(text) is not None


def _lines_from_words(page) -> list[list[dict]]:
    words = sorted(
        page.extract_words(keep_blank_chars=False, use_text_flow=False),
        key=lambda w: w["top"],
    )
    lines: list[list[dict]] = []
    cur: list[dict] = []
    cur_top: float | None = None
    for w in words:
        if cur_top is None or w["top"] - cur_top <= LINE_YTOL_PT:
            cur.append(w)
            cur_top = w["top"] if cur_top is None else min(cur_top, w["top"])
        else:
            lines.append(sorted(cur, key=lambda x: x["x0"]))
            cur, cur_top = [w], w["top"]
    if cur:
        lines.append(sorted(cur, key=lambda x: x["x0"]))
    return lines


# ---------------------------------------------------------------- A형: 행=지표
def _header_groups(line: list[dict]) -> list[list[dict]]:
    """라인의 기간 토큰들을 x 간격 기준으로 테이블별 그룹으로 분리."""
    pws = [w for w in line if _is_period(w["text"])]
    if len(pws) < 2:
        return []
    gaps = [pws[i + 1]["x0"] - pws[i]["x1"] for i in range(len(pws) - 1)]
    med = sorted(gaps)[len(gaps) // 2] or 1.0
    groups, cur = [], [pws[0]]
    for w, gap in zip(pws[1:], gaps):
        if gap > med * HEADER_SPLIT_GAP and gap > 40:
            groups.append(cur)
            cur = [w]
        else:
            cur.append(w)
    groups.append(cur)
    return [g for g in groups if len(g) >= 2]


def _parse_table_at(lines: list[list[dict]], hidx: int, header: list[dict],
                    page_no: int, header_line: list[dict]) -> ParsedTable | None:
    cols = [(w["x0"] + w["x1"]) / 2 for w in header]
    x_left = min(w["x0"] for w in header) - LABEL_MARGIN_PT
    x_right = max(w["x1"] for w in header) + COL_SNAP_PT
    label_right = cols[0] - 18
    # 헤더의 비기간 컬럼(QoQ, YoY, 컨센서스 등) 위치 = '버림 컬럼'.
    # 그 아래 증감률 숫자가 기간 컬럼으로 잘못 스냅되는 것을 막는다.
    period_ids = {id(w) for w in header}
    garbage = [
        (w["x0"] + w["x1"]) / 2
        for w in header_line
        if id(w) not in period_ids
        and min(w["x0"] for w in header) - 10 < (w["x0"] + w["x1"]) / 2 < max(w["x1"] for w in header) + 10
    ]

    table = ParsedTable(page=page_no, periods=[w["text"] for w in header])
    misses = 0
    # 글리프 높이 차이로 라벨과 숫자가 인접한 별도 라인으로 갈라지는 경우 재결합용
    pending_label: str | None = None   # 라벨만 먼저 나온 경우
    unlabeled_idx: int | None = None   # 숫자만 먼저 나온 행의 인덱스
    for line in lines[hidx + 1:hidx + 45]:
        ws = [w for w in line if x_left <= w["x0"] and w["x1"] <= x_right]
        if not ws:
            misses += 1
            if table.rows and misses >= 3:
                break
            continue
        label_parts: list[str] = []
        cells: dict[int, str] = {}
        for w in ws:
            t = w["text"]
            cx = (w["x0"] + w["x1"]) / 2
            if NUM_TOKEN_RE.match(t) or t in NULL_TOKENS:
                ci = min(range(len(cols)), key=lambda i: abs(cx - cols[i]))
                dist = abs(cx - cols[ci])
                if dist < COL_SNAP_PT and not any(abs(cx - g) < dist for g in garbage):
                    cells[ci] = t
                continue  # 컬럼 미정렬/버림컬럼 소속 숫자(y-y 등)는 버림
            if w["x1"] <= label_right:
                label_parts.append(t)
        label = " ".join(label_parts).strip()
        if label.startswith(STOP_PREFIXES):
            break
        if not cells:
            # 서브헤더 라인(KB추정치/잠정치/YoY/QoQ/컨센서스 등): 컬럼 영역의
            # 비숫자 단어 위치를 버림 컬럼으로 수확 → 병합 헤더의 서브컬럼 값 차단
            for w in ws:
                cx = (w["x0"] + w["x1"]) / 2
                if cx > label_right and not NUM_TOKEN_RE.match(w["text"]):
                    garbage.append(cx)
            if label and unlabeled_idx is not None:   # 직전 숫자행의 라벨이었음
                table.rows[unlabeled_idx] = (label, table.rows[unlabeled_idx][1])
                unlabeled_idx = None
            elif label:
                pending_label = label
            misses += 1
            if table.rows and misses >= 3:
                break
            continue
        misses = 0
        if not label and pending_label:
            label = pending_label
        pending_label = None
        table.rows.append((label, [cells.get(i) for i in range(len(cols))]))
        unlabeled_idx = len(table.rows) - 1 if not label else None
    return table if len(table.rows) >= 2 else None


# ---------------------------------------------------------------- B형: 행=기간
_UNIT_TOKEN_RE = re.compile(r"^\(?(원|조원|십억원|억원|백만원|천원|%|배|배수|x|adj\.?|원,)\)?,?$", re.IGNORECASE)


def _transposed_candidate(line: list[dict]) -> tuple[dict, list[dict]] | None:
    """'(차트숫자...) 2026E 1,149 1,039 ...' → (기간 단어, 오른쪽 숫자 단어들)"""
    pws = [w for w in line if _is_period(w["text"])]
    if len(pws) != 1:
        return None
    pw = pws[0]
    nums = [w for w in line
            if w["x0"] > pw["x1"] and (NUM_TOKEN_RE.match(w["text"]) or w["text"] in NULL_TOKENS)]
    return (pw, nums) if len(nums) >= 3 else None


def _find_transposed(lines: list[list[dict]], page_no: int,
                     used_y: list[tuple[float, float]]) -> list[ParsedTable]:
    """전치형 테이블 탐지. used_y(A형이 점유한 y구간)와 겹치는 라인은 제외."""
    from .labels import canonical_metric

    cands: list[tuple[int, float, dict, list[dict]]] = []
    for i, line in enumerate(lines):
        top = min(w["top"] for w in line)
        if any(a <= top <= b for a, b in used_y):
            continue
        c = _transposed_candidate(line)
        if c:
            cands.append((i, top, c[0], c[1]))

    out: list[ParsedTable] = []
    run: list[tuple[int, float, dict, list[dict]]] = []

    def flush(run):
        if len(run) < 2:
            return
        # 컬럼 기준 = 숫자가 가장 많은 데이터 행 (첫 행에 결측이 있을 수 있음)
        template = max(run, key=lambda r: len(r[3]))[3]
        cols = [(w["x0"] + w["x1"]) / 2 for w in template]
        periods, value_rows = [], []
        for _, _, pw, nums in run:
            periods.append(pw["text"])
            row: list[str | None] = [None] * len(cols)
            for w in nums:
                cx = (w["x0"] + w["x1"]) / 2
                ci = min(range(len(cols)), key=lambda i: abs(cx - cols[i]))
                if abs(cx - cols[ci]) < COL_SNAP_PT:
                    row[ci] = w["text"]
            value_rows.append(row)
        # 컬럼별 지표 라벨: 위쪽 5개 라인에서 후보를 모아 canonical 매핑되는 단어 우선,
        # '(원)' '(배)' 같은 단위 행은 라벨로 취급하지 않음
        first_idx = run[0][0]
        cand_labels: list[list[str]] = [[] for _ in cols]
        for li in range(first_idx - 1, max(first_idx - 6, -1), -1):
            for w in lines[li]:
                t = w["text"]
                if NUM_TOKEN_RE.match(t) or _UNIT_TOKEN_RE.match(t) or _is_period(t):
                    continue
                cx = (w["x0"] + w["x1"]) / 2
                ci = min(range(len(cols)), key=lambda i: abs(cx - cols[i]))
                if abs(cx - cols[ci]) < COL_SNAP_PT * 1.6:
                    cand_labels[ci].append(t)
        labels: list[str | None] = []
        for cl in cand_labels:
            best = next((t for t in cl if canonical_metric(t)), cl[0] if cl else None)
            labels.append(best)
        if not any(labels):
            return
        # (지표, 기간별 값) 구조로 전치
        t = ParsedTable(page=page_no, periods=periods, transposed=True)
        for ci, lab in enumerate(labels):
            if lab is None:
                continue
            t.rows.append((lab, [vr[ci] for vr in value_rows]))
        if t.rows:
            out.append(t)

    prev_top = None
    for idx, top, pw, nums in cands:
        if prev_top is not None and top - prev_top > 30:  # 행간이 벌어지면 다른 테이블
            flush(run)
            run = []
        run.append((idx, top, pw, nums))
        prev_top = top
    flush(run)
    return out


# ---------------------------------------------------------------- 진입점
def _unit_near(line_texts: list[str], idx: int, above: int = 4, below: int = 1) -> str | None:
    """테이블 헤더(idx) 주변 라인의 캡션에서 금액 단위를 찾는다."""
    for li in range(max(idx - above, 0), min(idx + below + 1, len(line_texts))):
        m = UNIT_CAPTION_RE.search(line_texts[li])
        if m:
            return m.group(1)
    return None


def _unit_page(line_texts: list[str]) -> str | None:
    """페이지 전체에서 캡션 형태('단위:' 또는 괄호 안 단위)만 찾는다."""
    for txt in line_texts:
        m = UNIT_CAPTION_RE.search(txt)
        if m:
            return m.group(1)
    return None


def extract_tables(pdf_path: str, max_pages: int = 4) -> list[ParsedTable]:
    """PDF 앞쪽 페이지에서 재무 테이블을 모두 추출 (요약 테이블은 1~2p에 있음)."""
    out: list[ParsedTable] = []
    with pdfplumber.open(pdf_path) as pdf:
        for pno, page in enumerate(pdf.pages[:max_pages], start=1):
            lines = _lines_from_words(page)
            line_texts = [" ".join(w["text"] for w in line) for line in lines]
            page_unit = _unit_page(line_texts)
            page_tables: list[tuple[int, ParsedTable]] = []
            used_y: list[tuple[float, float]] = []
            for i, line in enumerate(lines):
                for header in _header_groups(line):
                    t = _parse_table_at(lines, i, header, pno, line)
                    if t:
                        page_tables.append((i, t))
                        top = min(w["top"] for w in line)
                        used_y.append((top, top + (len(t.rows) + 1) * 14))
            transposed = _find_transposed(lines, pno, used_y)
            for idx, t in page_tables:
                t.money_unit = _unit_near(line_texts, idx) or page_unit
            for t in transposed:
                # 전치형은 헤더 라인을 모르므로 데이터 위쪽을 넓게 본 페이지 캡션 사용
                t.money_unit = page_unit
            out.extend([t for _, t in page_tables] + transposed)
    return out


def parse_number(token: str) -> float | None:
    """'1,070' / '-13.4' / '(123)' → float. '-', '적자' 등은 None."""
    if token is None or token in NULL_TOKENS:
        return None
    t = token.replace(",", "").rstrip("%")
    neg = t.startswith("(") and t.endswith(")")
    if neg:
        t = t[1:-1]
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v
