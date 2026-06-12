"""비전 AI 폴백: 이미지/비정형 PDF를 페이지 이미지로 렌더해 LLM으로 표를 추출.

좌표 파서(parser.py)가 실패하는 두 경우를 구제한다:
  - 텍스트가 아니라 이미지/벡터로 그려진 PDF (다올·미래에셋 등 — 텍스트 추출 ≈ 0)
  - 좌표 휴리스틱이 못 잡는 비정형 레이아웃

백엔드 자동 선택:
  1) ANTHROPIC_API_KEY 환경변수 → Anthropic SDK (권장, 프로덕션)
  2) 없으면 `claude` CLI headless (-p) — 키 없이 동작, 로컬 개발용

출력은 parser.ParsedTable 과 동일 구조라 financial_rows() 정규화 파이프를
그대로 재사용한다.
"""
import json
import os
import re
import subprocess
from pathlib import Path

import fitz  # PyMuPDF

from . import config
from .parser import ParsedTable

VISION_DPI = 150
VISION_MODEL = os.environ.get("FNGUIDE_VISION_MODEL", "claude-sonnet-4-6")

_PROMPT = """\
You are extracting a financial estimates table from a Korean securities research \
report page image. Look for the summary/forecast table with year or quarter column \
headers (e.g. 2024, 2025E, 2026F, 1Q26, 2Q26E).

Output ONLY a JSON object — no prose, no markdown fences — with this exact shape:
{"unit": "<금액 단위: 십억원|억원|조원|백만원, 표에 명시된 대로>",
 "periods": ["2024","2025E","2026F", ...],
 "rows": [{"label":"<원문 행 라벨>", "values":["1,234","2,345", ...]}]}

Rules:
- Include rows whose label matches: 매출액/영업수익/순영업수익/순이자이익/보험수익/원수보험료,
  영업이익/보험손익, 당기순이익/순이익/지배주주순이익, EPS, BPS, PER, PBR, ROE, DPS.
- "values" length MUST equal "periods" length. Use null for an empty/missing cell.
- Copy numbers exactly as printed (keep commas, minus signs, parentheses). Do not compute.
- If a quarterly table and an annual table both exist, prefer the annual forecast table;
  include the quarterly one as additional rows only if clearly separable.
- If no such table is on the page, output {"unit":null,"periods":[],"rows":[]}.
"""


# 페이지에 재무 요약표가 있는지 가늠하는 느슨한 신호어 (정확 매칭 아님 — 선별용)
_METRIC_HINTS = ("영업이익", "순이익", "매출", "순이자이익", "보험손익", "영업수익",
                 "EPS", "BPS", "PER", "PBR", "ROE", "DPS")
_PERIOD_HINT_RE = re.compile(r"\b(?:19|20)\d{2}[AEFP]?\b|\b[1-4]Q\d{2}\b")


def select_vision_pages(pdf_path: str, max_pages: int = 3) -> list[int]:
    """전 페이지를 텍스트로 훑어 비전을 돌릴 가치가 있는 페이지만 선별 (0-based).

    페이지마다 '재무 신호 점수'(기간 토큰 + 지표 신호어)를 매겨 상위 페이지만 고른다.
    텍스트 PDF든 이미지 PDF든, 표의 제목·라벨은 텍스트로 남는 경우가 많아 신호가
    잡힌다. 신호가 전혀 없는 순수 스캔본만 앞쪽 페이지로 fallback.
    무료·즉시인 PyMuPDF 텍스트 추출만 쓰므로 비전 호출 전에 후보를 좁힌다.
    """
    scored: list[tuple[int, int]] = []  # (page_idx, score)
    with fitz.open(pdf_path) as doc:
        n_pages = doc.page_count
        for i, page in enumerate(doc):
            text = page.get_text() or ""
            period_hits = len(_PERIOD_HINT_RE.findall(text))
            metric_hits = sum(1 for kw in _METRIC_HINTS if kw in text)
            # 기간 헤더와 지표가 함께 많을수록 재무 요약표일 확률↑
            scored.append((i, period_hits + metric_hits * 2))

    ranked = sorted((t for t in scored if t[1] >= 3), key=lambda t: -t[1])
    if ranked:
        return sorted(i for i, _ in ranked[:max_pages])
    # 재무 신호가 전혀 없음(순수 스캔본 등) → 앞쪽 페이지로 fallback
    return list(range(min(max_pages, n_pages)))


def render_pdf_pages(pdf_path: str, pages: list[int], dpi: int = VISION_DPI) -> list[Path]:
    """PDF의 지정 페이지(0-based)를 PNG로 렌더해 경로 리스트 반환."""
    out_dir = config.PDF_DIR / "_pages"
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(pdf_path).stem
    paths = []
    with fitz.open(pdf_path) as doc:
        for i in pages:
            if i >= doc.page_count:
                break
            pix = doc[i].get_pixmap(dpi=dpi)
            p = out_dir / f"{stem}_p{i + 1}.png"
            pix.save(p)
            paths.append(p)
    return paths


def _strip_json(text: str) -> dict | None:
    """LLM 응답에서 JSON 오브젝트만 추출 (코드펜스/잡설 제거)."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


# ----------------------------------------------------------- 백엔드: SDK / CLI
def _call_sdk(image_path: Path) -> str:
    import base64

    import anthropic

    client = anthropic.Anthropic()
    b64 = base64.standard_b64encode(image_path.read_bytes()).decode()
    msg = client.messages.create(
        model=VISION_MODEL,
        max_tokens=2000,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64",
                                             "media_type": "image/png", "data": b64}},
                {"type": "text", "text": _PROMPT},
            ],
        }],
    )
    return "".join(b.text for b in msg.content if b.type == "text")


def _call_cli(image_path: Path) -> str:
    """claude CLI headless 호출 — Read 도구로 이미지를 읽혀 추출.

    주의: 다른 claude 세션 안에서 중첩 호출하면 hang할 수 있다. 프로덕션/크론에서는
    ANTHROPIC_API_KEY 를 설정해 SDK 백엔드(_call_sdk)를 쓰는 것을 강력 권장한다.
    """
    prompt = f"Read the image file at {image_path} using the Read tool, then:\n\n{_PROMPT}"
    proc = subprocess.run(
        ["claude", "-p", prompt, "--allowedTools", "Read",
         "--permission-mode", "bypassPermissions",
         "--output-format", "json", "--max-budget-usd", "0.20"],
        capture_output=True, text=True, timeout=240,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude CLI 실패 (rc={proc.returncode}): {proc.stderr[:200]}")
    envelope = json.loads(proc.stdout)
    return envelope.get("result", "") if isinstance(envelope, dict) else proc.stdout


def _extract_one(image_path: Path, page_no: int) -> ParsedTable | None:
    backend = _call_sdk if os.environ.get("ANTHROPIC_API_KEY") else _call_cli
    raw = backend(image_path)
    data = _strip_json(raw)
    if not data or not data.get("periods") or not data.get("rows"):
        return None
    t = ParsedTable(page=page_no, periods=[str(p) for p in data["periods"]],
                    money_unit=data.get("unit"))
    n = len(t.periods)
    for row in data["rows"]:
        label = (row.get("label") or "").strip()
        vals = row.get("values") or []
        vals = [(str(v) if v is not None else None) for v in vals][:n]
        vals += [None] * (n - len(vals))  # 길이 보정
        if label:
            t.rows.append((label, vals))
    return t if t.rows else None


def extract_tables_via_vision(pdf_path: str, max_pages: int = 3) -> list[ParsedTable]:
    """재무 신호가 있는 페이지만 골라 이미지로 렌더 → LLM으로 표 추출.

    전 페이지를 텍스트로 먼저 훑어(select_vision_pages) 비전 호출 페이지를 좁힌다.
    실패 페이지는 건너뜀.
    """
    pages = select_vision_pages(pdf_path, max_pages)
    if not pages:
        return []
    out = []
    for page_path in render_pdf_pages(pdf_path, pages):
        page_no = int(re.search(r"_p(\d+)\.png$", page_path.name).group(1))
        try:
            t = _extract_one(page_path, page_no)
        except Exception:
            t = None
        if t:
            out.append(t)
    return out
