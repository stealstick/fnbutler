import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import UserNav from "@/components/UserNav";

export const metadata: Metadata = {
  title: "keystone — 목표주가 · 컨센서스 데스크",
  description: "기업·섹터·증권사 목표주가를 비교하는 Keystone 리서치 데스크",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="topbar">
          <div className="inner">
            <Link href="/" className="brand">
              <span className="brand-mark">K</span>
              <span className="brand-word">keystone</span>
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
