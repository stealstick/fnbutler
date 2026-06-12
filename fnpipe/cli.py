"""CLI: python -m fnpipe <command>

  init-db                                DB 테이블 생성
  add-company --code 005830 --name DB손해보험
  sync [--code 005830] [--days 7] [--limit N]   신규 리포트 수집+파싱
  show --code 005830                     계층 구조로 최신 추정치 출력
  reparse --rpt-id 1103861               저장된 PDF 재파싱 (매핑 룰 수정 후)
"""
import argparse
import logging
import sys

from sqlalchemy import select

from . import labels
from .client import FnGuideClient
from .db import init_db, make_session
from .models import Company, Report
from .pipeline import get_or_create_company, parse_report_pdf, sync_company, sync_feed

log = logging.getLogger("fnpipe")


def cmd_init_db(_args):
    init_db()
    print("DB 초기화 완료")


def cmd_add_company(args):
    init_db()
    with make_session() as s:
        c = get_or_create_company(s, args.code, args.name)
        c.name = args.name
        s.commit()
        print(f"등록: {c.name} ({c.stock_code})")


def cmd_sync(args):
    init_db()
    client = FnGuideClient()
    with make_session() as s:
        q = select(Company).where(Company.is_active.is_(True))
        if args.code:
            q = q.where(Company.stock_code == args.code)
        companies = s.scalars(q).all()
        if not companies:
            sys.exit("수집 대상 기업이 없습니다. add-company 로 먼저 등록하세요.")
        for c in companies:
            print(f"== {c.name} ({c.stock_code}) 최근 {args.days}일 ==")
            stats = sync_company(s, client, c, days=args.days, limit=args.limit,
                                 use_ai=args.ai)
            print(f"   {stats}")


def cmd_feed(args):
    init_db()
    client = FnGuideClient()
    with make_session() as s:
        print(f"== 전 종목 피드에서 등록 기업 최근 {args.days}일 신규 리포트 ==")
        stats = sync_feed(s, client, days=args.days, use_ai=args.ai, limit=args.limit)
        print(f"   {stats}")


def _fmt(v, money=False):
    if v is None:
        return "-"
    f = float(v)
    return f"{f:,.0f}" if money else f"{f:,.1f}"


def cmd_show(args):
    with make_session() as s:
        c = s.scalar(select(Company).where(Company.stock_code == args.code))
        if c is None:
            sys.exit(f"미등록 기업: {args.code}")
        reports = s.scalars(
            select(Report)
            .where(Report.company_id == c.id, Report.parse_status == "parsed")
            .order_by(Report.published_date.desc(), Report.fn_rpt_id.desc())
        ).all()
        latest_by_broker = {}
        for r in reports:  # 최신순이므로 첫 등장이 증권사별 최신
            latest_by_broker.setdefault(r.broker_id, r)

        print(f"{c.name} ({c.stock_code})")
        if not latest_by_broker:
            print("  (파싱된 리포트 없음 — sync 먼저 실행)")
            return
        for r in sorted(latest_by_broker.values(), key=lambda x: x.broker.name):
            tp = f" 목표가 {float(r.target_price):,.0f}" if r.target_price else ""
            print(f"└─ {r.broker.name} | {r.published_date} | {r.recomm or '-'}{tp} | {r.title}")
            rows = {}
            for f in r.financials:
                key = (f.period_type, f.fiscal_year, f.fiscal_quarter or 0)
                rows.setdefault(key, {"label": f.period_label, "est": f.is_estimate})[f.metric] = f.value
            for key in sorted(rows):
                d = rows[key]
                ptype = "연간" if key[0] == "A" else "분기"
                print(f"   {ptype} {d['label']:<7} {'(추정)' if d['est'] else '(실적)'}"
                      f"  매출액 {_fmt(d.get('revenue'), True):>10}"
                      f"  영업이익 {_fmt(d.get('operating_profit'), True):>9}"
                      f"  순이익 {_fmt(d.get('net_income'), True):>9}"
                      f"  PER {_fmt(d.get('per')):>6}"
                      f"  PBR {_fmt(d.get('pbr')):>5}")
        print("\n   (금액 단위: 억원, PER/PBR: 배)")


def cmd_reparse(args):
    with make_session() as s:
        r = s.scalar(select(Report).where(Report.fn_rpt_id == args.rpt_id))
        if r is None or not r.pdf_path:
            sys.exit(f"rptId={args.rpt_id}: 저장된 PDF 없음")
        parse_report_pdf(s, r, r.pdf_path, use_ai=args.ai)
        s.commit()
        method = (r.raw_tables or {}).get("method", "?")
        print(f"rptId={args.rpt_id} → {r.parse_status} ({method}, 지표 {len(r.financials)}건)")


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(prog="fnpipe", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init-db").set_defaults(fn=cmd_init_db)

    p = sub.add_parser("add-company")
    p.add_argument("--code", required=True)
    p.add_argument("--name", required=True)
    p.set_defaults(fn=cmd_add_company)

    p = sub.add_parser("sync")
    p.add_argument("--code")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--limit", type=int)
    p.add_argument("--ai", action="store_true",
                   help="좌표 파싱이 빈약하면 비전 AI 폴백 사용 (이미지/비정형 PDF)")
    p.set_defaults(fn=cmd_sync)

    p = sub.add_parser("feed")
    p.add_argument("--days", type=int, default=3)
    p.add_argument("--limit", type=int)
    p.add_argument("--ai", action="store_true", help="비전 AI 폴백 사용")
    p.set_defaults(fn=cmd_feed)

    p = sub.add_parser("show")
    p.add_argument("--code", required=True)
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("reparse")
    p.add_argument("--rpt-id", type=int, required=True)
    p.add_argument("--ai", action="store_true", help="비전 AI 폴백 사용")
    p.set_defaults(fn=cmd_reparse)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
