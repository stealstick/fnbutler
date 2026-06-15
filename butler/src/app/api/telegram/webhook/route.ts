import { NextRequest, NextResponse } from "next/server";
import { userStore } from "@/lib/userstore";
import { sendTelegram, webhookSecret } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 텔레그램 봇 웹훅. setWebhook 으로 이 URL 을 등록해두면 봇이 받은 메시지가 여기로 POST 된다.
 * 핵심 동작: 사용자가 딥링크(/start <token>) 로 봇을 시작하면 그 token 으로 계정을 찾아
 * chat_id 를 자동 바인딩한다. (수동 chat_id 입력 불필요)
 */
export async function POST(req: NextRequest) {
  // Telegram secret_token 검증(설정돼 있을 때만). 위조 요청 차단.
  const secret = webhookSecret();
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as any;
  const msg = update?.message ?? update?.edited_message;
  const chatId = msg?.chat?.id;
  const text: string | undefined = msg?.text;
  if (chatId == null || !text) return NextResponse.json({ ok: true }); // 처리 대상 아님 — 조용히 200

  const chat = String(chatId);

  if (text.startsWith("/start")) {
    const payload = text.slice("/start".length).trim();
    if (payload) {
      const userId = await userStore.consumeLinkToken(payload);
      if (userId) {
        await userStore.updateUserTelegram(userId, { telegramChatId: chat, alertsEnabled: true });
        await sendTelegram(chat, "✅ 연결 완료! 관심목록에 담은 종목의 목표주가가 바뀌면 여기로 알려드릴게요.");
      } else {
        await sendTelegram(chat, "⚠️ 연결 링크가 만료됐어요. 설정 페이지에서 '텔레그램 연결'을 다시 눌러주세요.");
      }
    } else {
      await sendTelegram(
        chat,
        `안녕하세요! 알림을 받으려면 butler 설정 페이지에서 '텔레그램 연결' 버튼을 눌러주세요.\n(이 대화의 chat_id: ${chat})`,
      );
    }
    return NextResponse.json({ ok: true });
  }

  // 그 외 메시지: 수동 입력 대비 chat_id 안내
  await sendTelegram(chat, `이 대화의 chat_id: ${chat}\n자동 연결은 설정 페이지의 '텔레그램 연결' 버튼을 권장해요.`);
  return NextResponse.json({ ok: true });
}
