"use client";

import { useEffect, useRef } from "react";

const STORAGE_KEY = "keystone.browser.uuid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10).join("")}`;
}

function browserUuid(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing && UUID_RE.test(existing)) return existing;

  const next = crypto.randomUUID ? crypto.randomUUID() : fallbackUuid();
  localStorage.setItem(STORAGE_KEY, next);
  return next;
}

export default function CompanyViewTracker({ corpCode }: { corpCode: string }) {
  const sentRef = useRef(false);

  useEffect(() => {
    if (sentRef.current) return;
    sentRef.current = true;

    try {
      const uuid = browserUuid();
      void fetch("/api/company-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          browserUuid: uuid,
          corpCode,
          path: window.location.pathname,
          referrer: document.referrer,
        }),
        keepalive: true,
      });
    } catch {
      // View tracking must never block the company page.
    }
  }, [corpCode]);

  return null;
}
