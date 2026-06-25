export const MAX_COMPARE_CODES = 80;

export function parseCompareCodes(raw: string | null | undefined, maxCodes = MAX_COMPARE_CODES): string[] {
  const limit = Math.max(0, Math.floor(maxCodes));
  if (!raw || limit === 0) return [];

  const seen = new Set<string>();
  const codes: string[] = [];
  for (const code of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
    if (codes.length >= limit) break;
  }
  return codes;
}
