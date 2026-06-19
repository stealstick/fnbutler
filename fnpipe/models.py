"""SQLAlchemy ORM 모델 — schema.sql 과 1:1 대응.

런타임 테이블 생성은 이 모델이 정본(create_all)이고, schema.sql 은
PostgreSQL 운영 배포용 DDL 문서다. 컬럼을 바꾸면 양쪽을 함께 수정할 것.
"""
from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON, BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey,
    Index, Integer, Numeric, SmallInteger, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    stock_code: Mapped[str] = mapped_column(String(12), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    sector: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    reports: Mapped[list["Report"]] = relationship(back_populates="company")


class Broker(Base):
    __tablename__ = "brokers"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    fn_brk_cd: Mapped[str | None] = mapped_column(String(12), unique=True)
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (
        Index("idx_reports_company_pub", "company_id", "published_date"),
        Index("idx_reports_broker", "broker_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    fn_rpt_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), nullable=False)
    broker_id: Mapped[int] = mapped_column(ForeignKey("brokers.id"), nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    analysts: Mapped[str | None] = mapped_column(Text)
    published_date: Mapped[date] = mapped_column(Date, nullable=False)
    recomm: Mapped[str | None] = mapped_column(Text)
    target_price: Mapped[float | None] = mapped_column(Numeric(18, 2))
    page_cnt: Mapped[int | None] = mapped_column(Integer)
    pdf_path: Mapped[str | None] = mapped_column(Text)
    parse_status: Mapped[str] = mapped_column(
        Text, nullable=False, default="pending",
        # pending: 미처리 / parsed: 지표 저장됨 / no_table: 추정 테이블 없음 / failed: 오류
    )
    parse_error: Mapped[str | None] = mapped_column(Text)
    raw_tables: Mapped[dict | None] = mapped_column(JSON)
    parsed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    company: Mapped[Company] = relationship(back_populates="reports")
    broker: Mapped[Broker] = relationship()
    financials: Mapped[list["ReportFinancial"]] = relationship(
        back_populates="report", cascade="all, delete-orphan")


class ReportFinancial(Base):
    __tablename__ = "report_financials"
    __table_args__ = (
        UniqueConstraint("report_id", "period_type", "fiscal_year", "fiscal_quarter",
                         "metric", name="uq_rf"),
        Index("idx_rf_metric", "metric", "fiscal_year"),
        CheckConstraint("period_type IN ('A','Q')"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    period_type: Mapped[str] = mapped_column(String(1), nullable=False)
    fiscal_year: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    fiscal_quarter: Mapped[int | None] = mapped_column(SmallInteger)
    period_label: Mapped[str] = mapped_column(Text, nullable=False)
    is_estimate: Mapped[bool] = mapped_column(Boolean, nullable=False)
    metric: Mapped[str] = mapped_column(Text, nullable=False)
    raw_label: Mapped[str] = mapped_column(Text, nullable=False)
    value: Mapped[float] = mapped_column(Numeric(20, 4), nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)

    report: Mapped[Report] = relationship(back_populates="financials")
