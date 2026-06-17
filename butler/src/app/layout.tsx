import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import UserNav from "@/components/UserNav";

export const metadata: Metadata = {
  title: "butler.view — 목표주가 · 컨센서스 데스크",
  description: "butler.works 데이터 기반 기업·섹터·증권사 목표주가 비교 데스크 (source: butler)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="topbar">
          <div className="inner">
            <Link href="/" className="brand">
              butler<span className="dot">.</span>view
            </Link>
            <nav>
              <Link href="/companies">기업</Link>
              <Link href="/sectors">섹터</Link>
              <Link href="/calendar">캘린더</Link>
              <Link href="/changes">변경이력</Link>
              <a href="/docs/openapi.yaml">API</a>
            </nav>
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 14, alignItems: "center" }}>
              <UserNav />
            </span>
          </div>
        </header>
        <main className="container" style={{ padding: "22px 20px 60px" }}>
          {children}
        </main>
      </body>
    </html>
  );
}
