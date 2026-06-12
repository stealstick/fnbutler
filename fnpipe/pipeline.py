"""수집 오케스트레이션: 목록 조회 → PDF 다운로드 → 파싱 → DB 저장.

멱등 설계: fn_rpt_id 가 이미 parsed/no_table 이면 건너뛰므로
매일 크론으로 같은 기간을 다시 돌려도 신규 리포트만 처리된다.
"""
import logging
import time
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config, labels
from .client import FnGuideClient, SyncfusionBlockedError
from .models import Broker, Company, Report, ReportFinancial
from .parser import ParsedTable, extract_tables, parse_number
from .periods import Period, parse_period

log = logging.getLogger("fnpipe")


# ---------------------------------------------------------------- 엔티티 매칭
def get_or_create_company(s: Session, stock_code: str, name: str) -> Company:
    c = s.scalar(select(Company).where(Company.stock_code == stock_code))
    if c is None:
        c = Company(stock_code=stock_code, name=name)
        s.add(c)
        s.flush()
    return c


def get_or_create_broker(s: Session, fn_brk_cd: str | None, name: str) -> Broker:
    b = None
    if fn_brk_cd:
        b = s.scalar(select(Broker).where(Broker.fn_brk_cd == fn_brk_cd))
    if b is None:
        b = s.scalar(select(Broker).where(Broker.name == name))
    if b is None:
        b = Broker(fn_brk_cd=fn_brk_cd, name=name)
        s.add(b)
        s.flush()
    return b


# ---------------------------------------------------------------- 파싱 → 지표
def _period_end(p: Period) -> date:
    if p.period_type == "Q":
        m = p.fiscal_quarter * 3
        return date(p.fiscal_year, m, monthrange(p.fiscal_year, m)[1])
    return date(p.fiscal_year, 12, 31)


def _is_estimate(p: Period, published: date) -> bool:
    # E/F 접미사가 정답이지만, 접미사를 생략하는 테이블은 발행일 기준으로 보정
    if p.suffix:
        return p.is_estimate
    return _period_end(p) > published


def financial_rows(tables: list[ParsedTable], published: date) -> list[dict]:
    """파싱된 테이블들 → 지표 행.

    같은 (기간, 지표)가 여러 번 나오면 라벨 우선순위가 높은 쪽이 이기고
    (예: '영업이익' > '보험손익'), 우선순위가 같으면 먼저 나온 테이블(요약) 우선.
    """
    acc: dict[tuple, tuple[int, dict]] = {}
    for t in tables:
        # 셀 충전율 게이트: 매핑되는 행들의 값이 듬성듬성하면(<40%) 컬럼 정렬이
        # 깨진 테이블로 보고 통째로 버린다 (행 시프트 오염 방지)
        mapped = [vals for lab, vals in t.rows if labels.canonical_metric(lab)]
        if not mapped:
            continue
        total = sum(len(v) for v in mapped)
        filled = sum(1 for v in mapped for x in v if x is not None)
        if total == 0 or filled / total < 0.4:
            continue
        table_money = labels.MONEY_FACTOR.get(t.money_unit) if t.money_unit else None
        for raw_label, values in t.rows:
            hit = labels.canonical_metric(raw_label)
            if hit is None:
                continue
            metric, priority = hit
            # 라벨에 단위가 명시되면('영업이익 (십억원)') 캡션보다 우선
            label_unit = labels.label_money_unit(raw_label)
            money = labels.MONEY_FACTOR.get(label_unit) if label_unit else table_money
            for ptoken, vtoken in zip(t.periods, values):
                p = parse_period(ptoken)
                v = parse_number(vtoken) if vtoken else None
                if p is None or v is None:
                    continue
                norm = labels.normalize_value(metric, v, money)
                if norm is None:  # 금액 지표인데 단위 미상 → 오염 방지 위해 버림
                    continue
                value, unit = norm
                key = (p.period_type, p.fiscal_year, p.fiscal_quarter, metric)
                if key in acc and acc[key][0] <= priority:
                    continue
                acc[key] = (priority, dict(
                    period_type=p.period_type, fiscal_year=p.fiscal_year,
                    fiscal_quarter=p.fiscal_quarter, period_label=p.label,
                    is_estimate=_is_estimate(p, published),
                    metric=metric, raw_label=raw_label, value=value, unit=unit,
                ))
    return [row for _, row in acc.values()]


def _needs_vision(rows: list[dict], pdf_path: str) -> bool:
    """좌표 파싱 결과가 빈약하면 비전 폴백이 필요한지 판단.

    - 행 자체가 없음(no_table), 또는
    - 연간 핵심 추정치(영업이익·순이익)가 둘 다 비어 있음, 또는
    - PDF 앞면이 거의 텍스트 없는 이미지(스캔/벡터)
    """
    if not rows:
        return True
    have = {(r["metric"]) for r in rows if r["is_estimate"] and r["period_type"] == "A"}
    if not ({"operating_profit", "net_income"} & have):
        return True
    try:
        import fitz
        with fitz.open(pdf_path) as doc:
            if doc.page_count and len(doc[0].get_text().strip()) < 400:
                return True
    except Exception:
        pass
    return False


def parse_report_pdf(s: Session, report: Report, pdf_path: str, use_ai: bool = False) -> None:
    """PDF 파싱 결과를 report_financials 에 반영하고 상태를 갱신.

    use_ai=True 면 좌표 파싱이 빈약할 때 비전 AI 폴백으로 보강한다.
    """
    report.financials.clear()
    try:
        tables = extract_tables(pdf_path)
    except Exception as e:  # 손상 PDF 등
        report.parse_status, report.parse_error = "failed", repr(e)[:500]
        return
    rows = financial_rows(tables, report.published_date)
    method = "coord"

    if use_ai and _needs_vision(rows, pdf_path):
        try:
            from .ai_extract import extract_tables_via_vision
            ai_tables = extract_tables_via_vision(pdf_path)
        except Exception as e:
            ai_tables = []
            report.parse_error = f"vision 폴백 실패: {repr(e)[:200]}"
        if ai_tables:
            # 좌표 결과를 앞에 둬 신뢰도 우선, 비전은 빈 곳을 채운다
            merged = financial_rows(tables + ai_tables, report.published_date)
            if len(merged) > len(rows):
                rows, tables = merged, tables + ai_tables
                method = "coord+vision" if tables[:len(tables) - len(ai_tables)] else "vision"

    report.raw_tables = {"method": method, "tables": [t.to_json() for t in tables]}
    if not rows:
        report.parse_status = "no_table"
    else:
        for r in rows:
            report.financials.append(ReportFinancial(**r))
        report.parse_status = "parsed"
        if method == "coord":
            report.parse_error = None
    report.parsed_at = datetime.now(timezone.utc)


# ---------------------------------------------------------------- 동기화
def _parse_anl_dt(s: str) -> date:
    yy, mm, dd = s.split(".")
    return date(2000 + int(yy), int(mm), int(dd))


def _parse_price(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


def _new_stats() -> dict:
    return {"seen": 0, "new": 0, "parsed": 0, "no_table": 0,
            "failed": 0, "blocked": 0, "skipped": 0}


def _process_report(s: Session, client: FnGuideClient, company: Company,
                    meta: dict, use_ai: bool) -> str | None:
    """리포트 메타 1건 처리: 다운로드 → 파싱 → 저장. 반환: 처리 상태(스킵 시 None)."""
    brk = meta.get("BROKERAGE") or {}
    if str(brk.get("VALUE")) in config.SKIP_BROKER_CODES or meta.get("BLIND_YN"):
        return None

    rpt_id = int(meta["RPT_ID"])
    report = s.scalar(select(Report).where(Report.fn_rpt_id == rpt_id))
    if report is not None and report.parse_status in ("parsed", "no_table"):
        return None  # 이미 확정 처리됨 — 멱등 (failed/blocked는 재시도)

    if report is None:
        broker = get_or_create_broker(s, str(brk.get("VALUE") or "") or None,
                                      brk.get("NAME") or "(미상)")
        report = Report(
            fn_rpt_id=rpt_id, company_id=company.id, broker_id=broker.id,
            title=meta.get("RPT_TITLE"),
            analysts=", ".join(a["NAME"] for a in meta.get("ANALYSTS") or []),
            published_date=_parse_anl_dt(meta["ANL_DT"]),
            recomm=meta.get("RECOMM"),
            target_price=_parse_price(meta.get("TARGET_PRICE")),
            page_cnt=meta.get("PAGE_CNT"),
        )
        s.add(report)
        s.flush()

    pdf_dir = config.PDF_DIR / company.stock_code
    pdf_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = pdf_dir / f"{rpt_id}.pdf"
    try:
        if not pdf_path.exists():
            pdf_path.write_bytes(client.download_pdf(rpt_id))
            time.sleep(config.REQUEST_DELAY)
        report.pdf_path = str(pdf_path)
        parse_report_pdf(s, report, str(pdf_path), use_ai=use_ai)
    except SyncfusionBlockedError as e:
        # HTTP로 PDF를 못 받는 케이스 — documentPath 보존 후 브라우저 폴백 대상으로 표시
        report.parse_status, report.parse_error = "blocked", str(e)
        report.raw_tables = {"method": "syncfusion_blocked", "document_path": e.document_path}
    except Exception as e:
        report.parse_status, report.parse_error = "failed", repr(e)[:500]
    s.commit()
    log.info("rptId=%s %s [%s] %s → %s", rpt_id, report.published_date,
             (brk.get("NAME") or ""), (report.title or "")[:30], report.parse_status)
    return report.parse_status


def sync_company(s: Session, client: FnGuideClient, company: Company,
                 days: int = 7, limit: int | None = None, use_ai: bool = False) -> dict:
    """기업 하나의 최근 N일 리포트를 수집. 반환: 처리 통계."""
    to_dt = date.today()
    from_dt = to_dt - timedelta(days=days)
    stats = _new_stats()

    for meta in client.iter_reports(company_code=company.stock_code,
                                    keyword=company.name,
                                    from_dt=from_dt, to_dt=to_dt):
        stats["seen"] += 1
        cat = meta.get("CATEGORY") or {}
        if str(cat.get("VALUE")) != company.stock_code:
            stats["skipped"] += 1
            continue
        if limit is not None and stats["new"] >= limit:
            break
        status = _process_report(s, client, company, meta, use_ai)
        if status is None:
            stats["skipped"] += 1
        else:
            stats["new"] += 1
            stats[status] = stats.get(status, 0) + 1

    s.commit()
    return stats


def sync_feed(s: Session, client: FnGuideClient, days: int = 3,
              use_ai: bool = False, limit: int | None = None) -> dict:
    """전 종목 피드에서 '등록된 기업'의 신규 리포트만 골라 수집.

    기업별로 N번 조회하는 대신 하루치 전체 피드를 한 번 훑어 등록 기업만 처리.
    등록 기업 수가 많을 때 호출 횟수가 크게 줄어든다.
    """
    to_dt = date.today()
    from_dt = to_dt - timedelta(days=days)
    registry = {c.stock_code: c for c in
                s.scalars(select(Company).where(Company.is_active.is_(True))).all()}
    if not registry:
        return _new_stats()
    stats = _new_stats()

    for meta in client.iter_feed(from_dt=from_dt, to_dt=to_dt):
        # 피드는 ANL_DT 내림차순. period 파라미터가 날짜범위를 덮어쓰므로
        # from_dt 이전 리포트가 나오면 더 볼 필요 없이 종료 (불필요한 페이지 요청 차단)
        if _parse_anl_dt(meta["ANL_DT"]) < from_dt:
            break
        stats["seen"] += 1
        cat = meta.get("CATEGORY") or {}
        company = registry.get(str(cat.get("VALUE")))
        if company is None:
            continue  # 미등록 기업 — 피드에는 있지만 수집 대상 아님
        if limit is not None and stats["new"] >= limit:
            break
        status = _process_report(s, client, company, meta, use_ai)
        if status is None:
            stats["skipped"] += 1
        else:
            stats["new"] += 1
            stats[status] = stats.get(status, 0) + 1

    s.commit()
    return stats
