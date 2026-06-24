import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { isValidBrowserUuid, recordCompanyView } from "@/lib/analytics";
import { normalizeCompanyRouteParam } from "@/lib/company-code";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    browserUuid?: string;
    corpCode?: string;
    path?: string;
    referrer?: string;
  };

  const browserUuid = typeof body.browserUuid === "string" ? body.browserUuid : "";
  if (!isValidBrowserUuid(browserUuid)) {
    return NextResponse.json({ error: "invalid browser uuid" }, { status: 400 });
  }

  const corpCode = normalizeCompanyRouteParam(String(body.corpCode ?? ""));
  if (!corpCode) {
    return NextResponse.json({ error: "corpCode required" }, { status: 400 });
  }

  const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  const id = await recordCompanyView({
    browserUuid,
    userId: user?.id ?? null,
    corpCode,
    path: body.path,
    referrer: body.referrer || req.headers.get("referer"),
    userAgent: req.headers.get("user-agent"),
  });

  if (!id) return NextResponse.json({ error: "company not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
