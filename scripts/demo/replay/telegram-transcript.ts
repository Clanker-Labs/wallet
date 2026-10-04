/**
 * Drives the REAL Telegram bot (handleUpdate from src/server/telegram/bot.ts)
 * against a copy of the demo database with a fake Bot API that records what
 * the bot sends (HTML text, inline keyboards, toasts, "typing…"), and prints a
 * JSON transcript for scripts/demo/replay/telegram.html to replay.
 *
 *   WALLET_DB_PATH=data/rec-telegram.db npx tsx scripts/demo/replay/telegram-transcript.ts scripts/demo/replay/telegram-transcript.json
 *
 * The CSV at the end goes to the real assistant (whatever WALLET_AGENT_PROVIDER
 * says, e.g. claude-code); set TRANSCRIPT_CANNED_AGENT=1 to use a canned reply.
 */
import { db } from "@/server/db/client";
import { defaultUser } from "@/server/services/users";
import { listReminders, markSent } from "@/server/services/reminders";
import { handleUpdate, type AgentPort, type BotApi, type BotContext } from "@/server/telegram/bot";
import { reminderKeyboard, renderReminder } from "@/server/telegram/messages";
import type { InlineKeyboardMarkup, SendOptions, TgUpdate } from "@/server/telegram/api";
import { today } from "@/server/services/settings";

const CHAT = 4242;

type Event =
  | { type: "date"; label: string }
  | { type: "bot"; id: number; html: string; keyboard?: InlineKeyboardMarkup["inline_keyboard"]; time: string }
  | { type: "user"; id: number; text?: string; file?: { name: string; size: number }; caption?: string; time: string }
  | { type: "tap"; message: number; button: string }
  | { type: "toast"; text: string }
  | { type: "typing"; ms: number }
  | { type: "keyboard_removed"; message: number }
  | { type: "note"; text: string };

const events: Event[] = [];
let clock = "09:00";
let nextId = 900;
let typingSince: number | null = null;

function flushTyping() {
  if (typingSince !== null) {
    events.push({ type: "typing", ms: Date.now() - typingSince });
    typingSince = null;
  }
}

const CSV = [
  "Date opération;Libellé;Montant",
  "01/10/2026;CB BOULANGERIE PAUL LYON 7;-6,40",
  "01/10/2026;CB FRANPRIX LYON GERLAND;-23,85",
  "02/10/2026;CB VELOV LYON METROPOLE;-3,00",
  "02/10/2026;CB LA BOITE A CAFE;-4,20",
  "02/10/2026;CB DECATHLON LYON;-54,99",
  "03/10/2026;CB CINEMA COMOEDIA;-11,50",
  "03/10/2026;CB HALLES PAUL BOCUSE;-38,70",
  "03/10/2026;VIR INST LUCAS MARTIN REMB DINER;+32,00",
  "",
].join("\n");

const api: BotApi = {
  async sendMessage(chatId: number, text: string, opts?: SendOptions) {
    flushTyping();
    const id = nextId++;
    events.push({ type: "bot", id, html: text, keyboard: opts?.replyMarkup?.inline_keyboard, time: clock });
    return id;
  },
  async editMessageReplyMarkup(_chatId: number, messageId: number) {
    events.push({ type: "keyboard_removed", message: messageId });
  },
  async answerCallbackQuery(_id: string, text?: string) {
    if (text) events.push({ type: "toast", text });
  },
  async sendChatAction() {
    if (typingSince === null) typingSince = Date.now();
  },
  async downloadFile() {
    return Buffer.from(CSV, "utf8");
  },
};

const canned: AgentPort = {
  status: () => ({ ready: true }),
  async run() {
    return { conversationId: "canned", text: "Imported **8 transactions** into Compte courant (BoursoBank)." };
  },
};

const ctx: BotContext = {
  api,
  allowedChatIds: [CHAT],
  conversations: new Map(),
  log: (line) => process.stderr.write(line + "\n"),
  ...(process.env.TRANSCRIPT_CANNED_AGENT ? { agent: async () => canned } : {}),
};

let updateId = 1;
const chat = { id: CHAT, type: "private" };

async function say(text: string, time: string) {
  clock = time;
  const id = nextId++;
  events.push({ type: "user", id, text, time });
  await handleUpdate({ update_id: updateId++, message: { message_id: id, date: 0, chat, text } }, ctx);
}

async function tap(message: number, data: string, label: string, time: string) {
  clock = time;
  events.push({ type: "tap", message, button: label });
  await handleUpdate(
    {
      update_id: updateId++,
      callback_query: { id: `cb${updateId}`, from: { id: CHAT }, data, message: { message_id: message, date: 0, chat } },
    } as TgUpdate,
    ctx,
  );
}

async function sendFile(name: string, caption: string, time: string) {
  clock = time;
  const id = nextId++;
  events.push({ type: "user", id, file: { name, size: Buffer.byteLength(CSV) }, caption, time });
  await handleUpdate(
    {
      update_id: updateId++,
      message: {
        message_id: id,
        date: 0,
        chat,
        caption,
        document: { file_id: "demo-csv", file_unique_id: "demo-csv", file_name: name, mime_type: "text/csv", file_size: Buffer.byteLength(CSV) },
      },
    } as TgUpdate,
    ctx,
  );
  flushTyping();
}

// ── The demo state: balances last entered at the end of September ─────────
const uid = defaultUser().id;
const t = today(uid);
// The demo seed records every manual balance "today"; drop those so the
// reminder finds what a month-old wallet really looks like.
db()
  .$client.prepare("DELETE FROM balance_snapshots WHERE date = ? AND source = 'demo' AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)")
  .run(t, uid);

const reminder = listReminders(uid).find((r) => r.kind === "balance_update" && r.accountId === null);
if (!reminder) throw new Error("demo reminder 'Update your balances' not found");

// 1. The monthly reminder fires, then nags the next morning.
events.push({ type: "date", label: "October 1" });
clock = "09:00";
const firstId = await api.sendMessage(CHAT, renderReminder(reminder), { replyMarkup: reminderKeyboard(reminder) });
markSent(reminder.id, firstId, { nag: false });
events.push({ type: "date", label: "October 2" });
clock = "09:00";
const nagId = await api.sendMessage(CHAT, renderReminder(reminder, { nag: true }), { replyMarkup: reminderKeyboard(reminder) });
markSent(reminder.id, nagId, { nag: true });

// 2. Tap "Update balances now" and answer the walkthrough.
await tap(nagId, "walk:start", "✏️ Update balances now", "09:02");
await say("352 000", "09:02");
await say("11 200", "09:03");
await say("stop", "09:03");

// 3. Everyday commands.
await say("/networth", "12:41");
await say("/spent 12.50 groceries — lunch", "12:42");
await say("/budget", "12:42");

// 4. A bank export sent as a file goes to the assistant.
await sendFile("boursobank-octobre.csv", "compte courant", "18:15");

const json = JSON.stringify({ bot: "Wallet", username: "alex_wallet_bot", canned: !!process.env.TRANSCRIPT_CANNED_AGENT, events }, null, 2);
// Agent runs may log to stdout, so the transcript goes to a file when one is given.
if (process.argv[2]) (await import("node:fs")).writeFileSync(process.argv[2], json + "\n");
else console.log(json);
