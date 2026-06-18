/** 숫자/라벨 포맷 유틸 (한국식 억/조 단위). 서버·클라이언트 공용.
 *  로케일을 'en-US' 로 고정 → SSR(Node)/CSR(브라우저) 결과가 동일해 hydration 불일치 방지. */
const LC = "en-US";

type NumericLike = number | string | null | undefined;

function toFiniteNumber(v: NumericLike): number | null {
  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 원 단위 정수를 '조/억' 한글 단위로. 예: 21552634000000 → '21조 5,526억' */
export function won(v: NumericLike, digits = 0): string {
  const parsed = toFiniteNumber(v);
  if (parsed == null) return "-";
  const neg = parsed < 0;
  let n = Math.abs(parsed);
  const jo = Math.floor(n / 1_0000_0000_0000);
  n -= jo * 1_0000_0000_0000;
  const eok = n / 1_0000_0000;
  const parts: string[] = [];
  if (jo > 0) parts.push(`${jo.toLocaleString(LC)}조`);
  if (eok >= 1 || jo === 0)
    parts.push(`${eok.toLocaleString(LC, { maximumFractionDigits: jo > 0 ? 0 : digits })}억`);
  return (neg ? "-" : "") + parts.join(" ");
}

/** 천단위 콤마. */
export function num(v: NumericLike, digits = 0): string {
  const parsed = toFiniteNumber(v);
  if (parsed == null) return "-";
  return parsed.toLocaleString(LC, { maximumFractionDigits: digits });
}

/** 퍼센트(부호 포함). */
export function pct(v: NumericLike, digits = 1): string {
  const parsed = toFiniteNumber(v);
  if (parsed == null) return "-";
  const s = parsed.toLocaleString(LC, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${parsed > 0 ? "+" : ""}${s}%`;
}

export function signClass(v: NumericLike): "up" | "down" | "flat" {
  const parsed = toFiniteNumber(v);
  if (parsed == null || parsed === 0) return "flat";
  return parsed > 0 ? "up" : "down";
}

/**
 * canonical metric → 표시 라벨. is_financial 이면 금융업 라벨로 치환.
 *  제조업 매출액 = 금융업 순이자이익(영업수익),
 *  영업이익 = 총영업이익 등.
 */
export const METRICS = ["REVENUE", "OPERATING_PROFIT", "NET_INCOME"] as const;
export type Metric = (typeof METRICS)[number];

export function metricLabel(metric: string, isFinancial = false): string {
  const map: Record<string, [string, string]> = {
    // [일반, 금융]
    REVENUE: ["매출액", "순이자이익(영업수익)"],
    OPERATING_PROFIT: ["영업이익", "총영업이익"],
    NET_INCOME: ["당기순이익", "당기순이익"],
    GROSS_PROFIT: ["매출총이익", "총영업이익"],
  };
  const pair = map[metric];
  if (!pair) return metric;
  return isFinancial ? pair[1] : pair[0];
}

/** 'YY.MM' (예 '26.03') → {year, quarter}. 결산월 12월 가정(3/6/9/12 → 1~4분기). */
export function parseDateLabel(label: string): { year: number; quarter: number } | null {
  const m = /^(\d{2})\.(\d{2})$/.exec(label);
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const mm = Number(m[2]);
  const quarter = Math.ceil(mm / 3);
  return { year, quarter };
}

export function ratingChangeBadge(c?: string | null): { label: string; kind: string } {
  switch (c) {
    case "상향":
      return { label: "▲ 상향", kind: "up" };
    case "하향":
      return { label: "▼ 하향", kind: "down" };
    default:
      return { label: c || "유지", kind: "flat" };
  }
}
