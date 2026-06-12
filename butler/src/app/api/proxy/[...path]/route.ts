import { NextRequest, NextResponse } from "next/server";
import { BUTLER_BASE } from "@/lib/butler";

/**
 * butler.works 업스트림 투명 프록시.
 *   /api/proxy/consensus/target-prices?corpCode=00937324
 *     → https://api.butler.works/api/consensus/target-prices?corpCode=00937324
 *
 * 브라우저가 우리 서버를 거쳐 butler 를 호출하게 해 CORS/레이트리밋/헤더를
 * 한 곳에서 관리한다. (실데이터 서비스는 DB 기반 /api/companies/* 사용)
 */

const COMMON: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  origin: "https://www.butler.works",
  referer: "https://www.butler.works/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

async function forward(req: NextRequest, path: string[], method: "GET" | "POST") {
  const search = req.nextUrl.search;
  const url = `${BUTLER_BASE}/api/${path.join("/")}${search}`;
  const init: RequestInit = { method, headers: { ...COMMON } };
  if (method === "POST") {
    init.body = await req.text();
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(url, init);
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "x-butler-proxied-url": url,
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward(req, path, "GET");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward(req, path, "POST");
}
