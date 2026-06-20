"use client";

import { useMemo, useState } from "react";

export type Dir = "asc" | "desc";

/** 클라이언트 정렬 훅. getVal 로 행에서 정렬값(숫자|문자열|null) 추출. null 은 항상 하단. */
export function useTableSort<T>(
  rows: T[],
  getVal: (row: T, key: string) => number | string | null,
  initKey: string,
  initDir: Dir = "desc",
) {
  const [sortKey, setSortKey] = useState(initKey);
  const [dir, setDir] = useState<Dir>(initDir);

  function onSort(key: string, defaultDir: Dir = "desc") {
    if (key === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDir(defaultDir);
    }
  }

  const sorted = useMemo(() => {
    const r = [...rows];
    r.sort((a, b) => {
      const va = getVal(a, sortKey);
      const vb = getVal(b, sortKey);
      if (typeof va === "string" || typeof vb === "string") {
        const c = String(va ?? "").localeCompare(String(vb ?? ""), "ko");
        return dir === "asc" ? c : -c;
      }
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // null 하단
      if (vb == null) return -1;
      return dir === "asc" ? va - vb : vb - va;
    });
    return r;
  }, [rows, getVal, sortKey, dir]);

  return { sorted, sortKey, dir, onSort };
}

/** 정렬 가능한 th. 클릭 시 onSort(k). 활성 컬럼에 ▲▼ 표시. */
export function SortTh({
  label,
  k,
  sortKey,
  dir,
  onSort,
  align,
  defaultDir = "desc",
  className = "",
}: {
  label: string;
  k: string;
  sortKey: string;
  dir: Dir;
  onSort: (k: string, d?: Dir) => void;
  align?: "l";
  defaultDir?: Dir;
  className?: string;
}) {
  return (
    <th
      className={`${align === "l" ? "l " : ""}sortable${sortKey === k ? " active" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => onSort(k, defaultDir)}
      title={`${label} 기준 정렬`}
    >
      {label}
      <span className="sort-ind">{sortKey === k ? (dir === "asc" ? "▲" : "▼") : ""}</span>
    </th>
  );
}
