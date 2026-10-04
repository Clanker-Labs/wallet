/**
 * Reminder delivery. All state (next run, nag, last message id) lives in the
 * reminders table, so ticks are safe to repeat and survive restarts.
 */
import type { Reminder } from "@/server/db/schema";
import { dueNags, dueReminders, markSent } from "@/server/services/reminders";
import { escapeHtml, allowedChatIds, type TelegramApi } from "./api";
import { reminderKeyboard, renderReminder } from "./messages";

export type SchedulerApi = Pick<TelegramApi, "sendMessage">;

export interface TickSummary {
  sent: number;
  nagged: number;
  /** Reminders that could not be delivered to any chat (retried next tick). */
  failed: number;
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
 * Send to every chat. Returns whether any send succeeded and the primary
 * chat's message id (replies to reminders are matched against it).
 */
async function deliver(r: Reminder, nag: boolean, api: SchedulerApi, chatIds: number[], log: (line: string) => void) {
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
  return { delivered, primaryMessageId };
}

/** Send due reminders, then re-send unacknowledged ones whose nag time has come. */
export async function tick(
  now: Date = new Date(),
  api: SchedulerApi,
  chatIds: number[] = allowedChatIds(),
  log: (line: string) => void = console.log,
): Promise<TickSummary> {
  const summary: TickSummary = { sent: 0, nagged: 0, failed: 0 };
  if (!chatIds.length) return summary;
  const sentNow = new Set<number>();

  for (const r of dueReminders(now)) {
    const { delivered, primaryMessageId } = await deliver(r, false, api, chatIds, log);
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
    const { delivered, primaryMessageId } = await deliver(r, true, api, chatIds, log);
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
