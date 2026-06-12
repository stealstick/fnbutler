/** 텔레그램 봇 알림. BUTLER_TELEGRAM_BOT_TOKEN 환경변수 필요. */

const TOKEN = process.env.BUTLER_TELEGRAM_BOT_TOKEN;

export function telegramConfigured(): boolean {
  return !!TOKEN;
}

export async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 목표주가 변경 1건 → 텔레그램 메시지 본문. */
export function formatTargetAlert(p: {
  companyName: string;
  corpCode: string;
  broker: string;
  oldValue: string | null;
  newValue: string | null;
  deltaPct: number | null;
  kind: string | null;
  note: string | null;
  baseUrl: string;
}): string {
  const arrow = p.kind === "up" ? "🔺" : p.kind === "down" ? "🔻" : "•";
  const pctStr = p.deltaPct != null ? ` (${p.deltaPct > 0 ? "+" : ""}${p.deltaPct.toFixed(1)}%)` : "";
  const change =
    p.oldValue && p.newValue
      ? `${Number(p.oldValue).toLocaleString()} → <b>${Number(p.newValue).toLocaleString()}</b>원${pctStr}`
      : p.newValue
        ? `신규 <b>${Number(p.newValue).toLocaleString()}</b>원`
        : "";
  return (
    `${arrow} <b>${escapeHtml(p.companyName)}</b> 목표주가 변경\n` +
    `${escapeHtml(p.broker)}: ${change}\n` +
    (p.note ? `${escapeHtml(p.note)}\n` : "") +
    `${p.baseUrl}/companies/${p.corpCode}`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
