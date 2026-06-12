"""기간 토큰 파싱: '2025' '2026E' '2028F' '2Q26E' '12/25A' '2025.12E' → 구조화.

접미사 의미: A=실적, P=잠정실적, E=추정, F=예측. (E/F만 추정치로 본다)
"""
import re
from dataclasses import dataclass

PERIOD_RE = re.compile(
    r"^(?:"
    r"(?P<y>(?:19|20)\d{2})(?:[./]1?\d)?"      # 2025, 2025.12, 2025/12
    r"|(?P<q>[1-4])Q(?P<qy>\d{2}|\d{4})"        # 2Q26, 2Q2026
    r"|(?P<m>1?\d)/(?P<my>\d{2})"               # 12/25
    r"|FY(?P<fy>\d{2}|\d{4})"                   # FY26
    r")(?P<suffix>[AEFP])?$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Period:
    period_type: str        # 'A'(연간) / 'Q'(분기)
    fiscal_year: int
    fiscal_quarter: int | None
    suffix: str             # 'A'/'E'/'F'/'P'/''
    label: str              # 원문

    @property
    def is_estimate(self) -> bool:
        return self.suffix in ("E", "F")


def _full_year(two_or_four: str) -> int:
    n = int(two_or_four)
    return n if n >= 1900 else 2000 + n


def parse_period(token: str) -> Period | None:
    m = PERIOD_RE.match(token.strip())
    if not m:
        return None
    suffix = (m.group("suffix") or "").upper()
    if m.group("y"):
        return Period("A", int(m.group("y")), None, suffix, token)
    if m.group("q"):
        return Period("Q", _full_year(m.group("qy")), int(m.group("q")), suffix, token)
    if m.group("m"):  # '12/25' — 결산월/연도 표기 → 연간으로 취급
        return Period("A", _full_year(m.group("my")), None, suffix, token)
    if m.group("fy"):
        return Period("A", _full_year(m.group("fy")), None, suffix, token)
    return None
