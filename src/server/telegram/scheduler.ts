/**
 * Reminder delivery. All state (next run, nag, last message id) lives in the
 * reminders table, so ticks are safe to repeat and survive restarts. Each
 * reminder goes to its user's linked chat (plus TELEGRAM_CHAT_ID for the owner).
 */
import type { Reminder } from "@/server/db/schema";
import { dueNags, dueReminders, markSent } from "@/server/services/reminders";
import { defaultUser, getUser } from "@/server/services/users";
import { escapeHtml, allowedChatIds, type TelegramApi } from "./api";
import { reminderKeyboard, renderReminder } from "./messages";

export type SchedulerApi = Pick<TelegramApi, "sendMessage">;

export interface TickSummary {
  sent: number;
  nagged: number;
  /** Reminders that could not be delivered to any chat (retried next tick). */
  failed: number;
}

/** Chats a user's reminders go to. */
export function chatsForUser(userId: string, legacyChatIds: number[]): number[] {
  const chats = new Set<number>();
  const user = getUser(userId);
  if (user?.telegramChatId) chats.add(user.telegramChatId);
  let ownerId: string | null = null;
  try {
    ownerId = defaultUser().id;
  } catch {}
  if (ownerId === userId) for (const c of legacyChatIds) chats.add(c);
  return [...chats];
}

/** Render, falling back to the bare title if building the body fails (e.g. a report query). */
function safeRender(r: Reminder, nag: boolean, log: (line: string) => void): string {
  try {
    return renderReminder(r, { nag });
  } catch (e) {
    log(`⚠️ reminder ${r.id}: could not render: ${e instanceof Error ? e.message : String(e)}`);
    return `${nag ? "🔁 Still pending:" : "🔔"} <b>${escapeHtml(r.title)}</b>`;
  }
}

/**
 * Send to every chat of the reminder's user. Returns whether any send
 * succeeded and the first chat's message id (replies are matched against it).
 */
async function deliver(r: Reminder, nag: boolean, api: SchedulerApi, legacy: number[], log: (line: string) => void) {
  const chatIds = chatsForUser(r.userId, legacy);
  const text = safeRender(r, nag, log);
  let delivered = false;
  let primaryMessageId: number | null = null;
  for (const [i, chatId] of chatIds.entries()) {
    try {
      const messageId = await api.sendMessage(chatId, text, { replyMarkup: reminderKeyboard(r) });
      delivered = true;
      if (i === 0) primaryMessageId = messageId;
    } catch (e) {
      log(`⚠️ reminder ${r.id} → chat ${chatId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { delivered, primaryMessageId, noChat: chatIds.length === 0 };
}

/** Send due reminders, then re-send unacknowledged ones whose nag time has come. */
export async function tick(
  now: Date = new Date(),
  api: SchedulerApi,
  legacyChatIds: number[] = allowedChatIds(),
  log: (line: string) => void = console.log,
): Promise<TickSummary> {
  const summary: TickSummary = { sent: 0, nagged: 0, failed: 0 };
  const sentNow = new Set<number>();

  for (const r of dueReminders(now)) {
    const { delivered, primaryMessageId, noChat } = await deliver(r, false, api, legacyChatIds, log);
    if (noChat) continue; // user hasn't linked Telegram: keep it due until they do
    if (!delivered) {
      summary.failed++;
      continue;
    }
    markSent(r.id, primaryMessageId, { nag: false }, now);
    sentNow.add(r.id);
    summary.sent++;
    log(`🔔 sent reminder ${r.id} “${r.title}”`);
  }

  for (const r of dueNags(now)) {
    if (sentNow.has(r.id)) continue;
    const { delivered, primaryMessageId, noChat } = await deliver(r, true, api, legacyChatIds, log);
    if (noChat) continue;
    if (!delivered) {
      summary.failed++;
      continue;
    }
    markSent(r.id, primaryMessageId, { nag: true }, now);
    summary.nagged++;
    log(`🔁 nagged reminder ${r.id} “${r.title}”`);
  }
  return summary;
}
