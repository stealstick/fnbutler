/**
 * 텔레그램 봇 웹훅 등록(1회성). 토큰을 발급받은 뒤 한 번만 실행하면 된다.
 *
 *   BUTLER_TELEGRAM_BOT_TOKEN=123456:ABC... \
 *   BUTLER_BASE_URL=https://fnbutler-l3why3suea-du.a.run.app \
 *   BUTLER_TELEGRAM_WEBHOOK_SECRET=<랜덤시크릿(선택)> \
 *   npx tsx scripts/telegram-setup.ts
 *
 * getMe → setWebhook(<BASE>/api/telegram/webhook) → getWebhookInfo 순으로 호출/검증한다.
 */
const TOKEN = process.env.BUTLER_TELEGRAM_BOT_TOKEN;
const BASE = process.env.BUTLER_BASE_URL;
const SECRET = process.env.BUTLER_TELEGRAM_WEBHOOK_SECRET || "";

async function tg(method: string, body?: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function main() {
  if (!TOKEN) throw new Error("BUTLER_TELEGRAM_BOT_TOKEN 필요");
  if (!BASE) throw new Error("BUTLER_BASE_URL 필요 (예: https://fnbutler-...run.app)");

  const me = await tg("getMe");
  console.log("getMe:", JSON.stringify(me.result ?? me));

  const url = `${BASE.replace(/\/$/, "")}/api/telegram/webhook`;
  const body: Record<string, unknown> = { url, allowed_updates: ["message"] };
  if (SECRET) body.secret_token = SECRET;
  const set = await tg("setWebhook", body);
  console.log("setWebhook:", JSON.stringify(set));

  const info = await tg("getWebhookInfo");
  console.log("getWebhookInfo:", JSON.stringify(info.result ?? info));

  if (!SECRET) console.warn("⚠️ BUTLER_TELEGRAM_WEBHOOK_SECRET 미설정 — 웹훅 위조 검증이 비활성입니다(권장: 설정).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
