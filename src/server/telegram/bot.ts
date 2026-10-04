/**
 * Telegram command handling. `handleUpdate` is the single entry point; the
 * API client is injected so tests can run it against a fake. Each chat acts
 * for one wallet user: chats are linked with a one-time code from Settings
 * (`/start CODE`), and chats listed in TELEGRAM_CHAT_ID act for the owner.
 */
import { ZodError } from "zod";
import type { Account, Reminder, User } from "@/server/db/schema";
import { findAccounts, getAccount, listAccounts, recordBalance } from "@/server/services/accounts";
import { findCategory } from "@/server/services/categories";
import { acknowledgeReminder, findReminderByMessageId, getReminder, snoozeReminder } from "@/server/services/reminders";
import { addTransaction } from "@/server/services/transactions";
import { saveUpload, uploadKind } from "@/server/services/uploads";
import { defaultUser, userByTelegramChat } from "@/server/services/users";
import { redeemTelegramLinkCode } from "@/server/services/telegram-link";
import { isMonth } from "@/lib/dates";
import { parseAmount, toCents } from "@/lib/money";
import {
  escapeHtml as esc,
  TelegramError,
  type TelegramApi,
  type TgCallbackQuery,
  type TgMessage,
  type TgUpdate,
} from "./api";
import { answerWalkthrough, isWalking, startWalkthrough, stopWalkthrough } from "./walkthrough";
import {
  markdownToHtml,
  renderBalanceRecorded,
  renderBudget,
  renderHelp,
  renderNetWorth,
  renderReminders,
  renderTransactionAdded,
  splitMessage,
  stripHtml,
} from "./messages";

export type BotApi = Pick<
  TelegramApi,
  "sendMessage" | "editMessageReplyMarkup" | "answerCallbackQuery" | "sendChatAction" | "downloadFile"
>;

export interface AgentPort {
  status(): { ready: boolean; reason?: string };
  run(opts: {
    userId: string;
    conversationId?: string;
    message: string;
    attachments?: string[];
    channel: "telegram";
    signal?: AbortSignal;
  }): Promise<{ conversationId: string; text: string }>;
}

export interface BotContext {
  api: BotApi;
  /** Legacy allowlist (TELEGRAM_CHAT_ID): these chats act for the owner unless linked to someone. */
  allowedChatIds: number[];
  /** Lets "/cmd@OtherBot" in group chats be ignored. */
  botUsername?: string;
  /** Agent loader; defaults to the real runner, imported lazily. */
  agent?: () => Promise<AgentPort>;
  /** Rolling agent conversation per chat; defaults to a process-wide map. */
  conversations?: Map<number, string>;
  /** Aborted on shutdown; passed to agent runs. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** The wallet user a chat acts for, if any. */
export function userForChat(chatId: number, allowedChatIds: number[]): User | null {
  const linked = userByTelegramChat(chatId);
  if (linked) return linked;
  if (!allowedChatIds.includes(chatId)) return null;
  try {
    return defaultUser();
  } catch {
    return null;
  }
}

const defaultConversations = new Map<number, string>();
/** Agent turns run one at a time per chat, so a conversation's history stays ordered. */
const agentQueues = new Map<number, Promise<unknown>>();

const USAGE = {
  balance: "✏️ Usage: /balance &lt;account&gt; &lt;amount&gt;\ne.g. /balance livret a 12 500",
  spent: "💸 Usage: /spent &lt;amount&gt; &lt;category&gt; [— note]\ne.g. /spent 12.50 groceries — lunch",
  earned: "💰 Usage: /earned &lt;amount&gt; &lt;category&gt; [— note]\ne.g. /earned 2500 salary",
  budget: "🧾 Usage: /budget or /budget 2026-09",
  ask: "🤖 Usage: /ask &lt;question&gt;\nOr just type your question.",
};

// ── Parsing ──────────────────────────────────────────────────────────────

export interface ParsedCommand {
  command: string;
  args: string;
}

/** "/Balance@WalletBot livret a 1 234" → { command: "balance", args: "livret a 1 234" }. */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | null {
  const m = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { command: m[1].toLowerCase(), args: (m[3] ?? "").trim() };
}

const AMOUNT_TOKEN = /^[-+−(]?[€$£]?\d[\d.,']*[kKmM]?[€$£]?\)?$/;
/** A first thousands group: "1", "12", "-123". */
const LEAD_GROUP = /^[-+−(]?[€$£]?\d{1,3}$/;
/** A following thousands group, optionally with decimals: "234", "234,56". */
const NEXT_GROUP = /^\d{3}([.,]\d{1,2})?[kKmM]?[€$£]?\)?$/;
const CURRENCY_TOKEN = /^(€|\$|£|eur|euros?|usd|gbp|chf)$/i;

const tokenize = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** "livret a 1 234,56" → { rest: "livret a", amount: 1234.56 }. */
export function splitTrailingAmount(text: string): { rest: string; amount: number } | null {
  const tokens = tokenize(text);
  if (tokens.length && CURRENCY_TOKEN.test(tokens[tokens.length - 1])) tokens.pop();
  let start = tokens.length - 1;
  if (start < 0 || !AMOUNT_TOKEN.test(tokens[start])) return null;
  // Absorb space-separated thousands, but always leave a word for the name.
  while (start > 1 && NEXT_GROUP.test(tokens[start]) && LEAD_GROUP.test(tokens[start - 1])) start--;
  const amount = parseAmount(tokens.slice(start).join(" "));
  if (amount === null) return null;
  return { rest: tokens.slice(0, start).join(" "), amount };
}

/** "1 234,56 rent — june" → { amount: 1234.56, rest: "rent — june" }. */
export function splitLeadingAmount(text: string): { amount: number; rest: string } | null {
  const tokens = tokenize(text);
  if (tokens.length && CURRENCY_TOKEN.test(tokens[0])) tokens.shift();
  if (!tokens.length || !AMOUNT_TOKEN.test(tokens[0])) return null;
  let end = 1;
  if (LEAD_GROUP.test(tokens[0])) {
    while (end < tokens.length && NEXT_GROUP.test(tokens[end]) && (end === 1 || /^\d{3}$/.test(tokens[end - 1]))) end++;
  }
  const amount = parseAmount(tokens.slice(0, end).join(" "));
  if (amount === null) return null;
  if (end < tokens.length && CURRENCY_TOKEN.test(tokens[end])) end++;
  return { amount, rest: tokens.slice(end).join(" ") };
}

/** The whole text is an amount ("2 500", "12.5k"), nothing else. */
export function parseAmountOnly(text: string): number | null {
  const r = splitLeadingAmount(text);
  return r && !r.rest ? r.amount : null;
}

/** findCategory, but the query has to start a word ("the" must not match "Other expenses"). */
function findCategoryAtWordStart(uid: string, query: string) {
  const category = findCategory(uid, query);
  if (!category) return undefined;
  const name = category.name.toLowerCase();
  const i = name.indexOf(query.toLowerCase());
  return i === 0 || (i > 0 && !/[\p{L}\p{N}]/u.test(name[i - 1])) ? category : undefined;
}

/**
 * "groceries — lunch with Bob" or "groceries lunch with Bob": the longest
 * leading run of words naming a category wins; the rest is the note.
 */
export function resolveCategoryAndNote(uid: string, text: string) {
  const sep = text.match(/^(.*?)\s*(?:[—–]|\s--?\s)\s*(.*)$/s);
  const head = (sep ? sep[1] : text).trim();
  const explicitNote = sep ? sep[2].trim() : "";
  const words = tokenize(head);
  for (let k = words.length; k > 0; k--) {
    const query = words.slice(0, k).join(" ");
    if (query.length < 3) break;
    const category = findCategoryAtWordStart(uid, query);
    if (category) {
      const note = [words.slice(k).join(" "), explicitNote].filter(Boolean).join(" — ");
      return { category, note: note || null, query: head };
    }
  }
  return { category: undefined, note: [head, explicitNote].filter(Boolean).join(" — ") || null, query: head };
}

function errorMessage(e: unknown): string {
  if (e instanceof ZodError) return e.issues.map((i) => i.message).join("; ");
  return e instanceof Error ? e.message : String(e);
}

// ── Commands ─────────────────────────────────────────────────────────────

function budgetCommand(uid: string, args: string): string {
  if (args && !isMonth(args)) return USAGE.budget;
  return renderBudget(uid, args || undefined);
}

function recordAndConfirm(uid: string, account: Account, amount: number): string {
  const before = getAccount(uid, account.id).account;
  const { balanceCents } = recordBalance(uid, { accountId: account.id, balance: amount, source: "telegram" });
  return renderBalanceRecorded({
    uid,
    accountName: account.name,
    currency: account.currency,
    beforeCents: before.balanceCents,
    afterCents: balanceCents,
    derivedFromLoan: !!account.loanParams,
  });
}

function balanceCommand(uid: string, args: string): string {
  const parsed = splitTrailingAmount(args);
  if (!parsed || !parsed.rest) return USAGE.balance;
  const matches = findAccounts(uid, parsed.rest);
  if (matches.length === 1) return recordAndConfirm(uid, matches[0], parsed.amount);
  if (matches.length > 1) {
    return [
      `🤔 Several accounts match “${esc(parsed.rest)}”:`,
      ...matches.map((a) => `• ${esc(a.name)}${a.institution ? ` (${esc(a.institution)})` : ""}`),
      "Be more specific.",
    ].join("\n");
  }
  const names = listAccounts(uid).map((a) => esc(a.name));
  return [
    `🔍 No account matches “${esc(parsed.rest)}”.`,
    names.length ? `Your accounts: ${names.slice(0, 15).join(", ")}` : "No accounts yet — add them in the web app.",
  ].join("\n");
}

function transactionCommand(uid: string, args: string, kind: "expense" | "income"): string {
  const parsed = splitLeadingAmount(args);
  if (!parsed || parsed.amount === 0 || !parsed.rest) return kind === "expense" ? USAGE.spent : USAGE.earned;
  const { category, note, query } = resolveCategoryAndNote(uid, parsed.rest);
  const amount = kind === "expense" ? -Math.abs(parsed.amount) : Math.abs(parsed.amount);
  const tx = addTransaction(uid, {
    amount,
    description: (category ? note || category.name : note) || (kind === "expense" ? "Expense" : "Income"),
    categoryId: category?.id ?? null,
    source: "telegram",
  });
  return renderTransactionAdded({
    uid,
    currency: tx.currency,
    amountCents: toCents(amount),
    category,
    categoryQuery: query,
    note: category ? note : null,
  });
}

const COMMANDS: Record<string, (uid: string, args: string) => string> = {
  start: () => renderHelp(),
  help: () => renderHelp(),
  networth: (uid) => renderNetWorth(uid),
  nw: (uid) => renderNetWorth(uid),
  budget: budgetCommand,
  balance: balanceCommand,
  spent: (uid, args) => transactionCommand(uid, args, "expense"),
  earned: (uid, args) => transactionCommand(uid, args, "income"),
  reminders: (uid) => renderReminders(uid),
};

// ── Reminder replies & buttons ───────────────────────────────────────────

const DONE_WORDS = /^(done|ok|okay|fait|✅|👍)$/i;

/** A reply to a reminder message. Returns null when the text isn't meant for the reminder. */
function reminderReply(uid: string, reminder: Reminder, text: string): string | null {
  const amount = parseAmountOnly(text);
  if (amount !== null && reminder.kind === "balance_update" && reminder.accountId !== null) {
    const confirmation = recordAndConfirm(uid, getAccount(uid, reminder.accountId).account, amount);
    acknowledgeReminder(uid, reminder.id);
    return confirmation;
  }
  if (amount !== null || DONE_WORDS.test(text.trim())) {
    acknowledgeReminder(uid, reminder.id);
    return `✅ Noted — <b>${esc(reminder.title)}</b> marked done.`;
  }
  return null;
}

/** Apply a button press. `settled` = the reminder's keyboard can go away. */
function reminderAction(uid: string, data: string): { toast: string; settled: boolean } {
  const m = data.match(/^(done|snooze):(\d+)(?::(\d+))?$/);
  if (!m) return { toast: "🤷 Unknown action", settled: false };
  const id = Number(m[2]);
  const reminder = getReminder(id);
  if (!reminder || reminder.userId !== uid) return { toast: "This reminder no longer exists", settled: true };
  if (m[1] === "done") {
    acknowledgeReminder(uid, id);
    return { toast: `✅ Done: ${reminder.title}`, settled: true };
  }
  const hours = Number(m[3] ?? 3);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) return { toast: "🤷 Invalid snooze", settled: false };
  snoozeReminder(uid, id, hours);
  return { toast: hours >= 24 ? "💤 I'll remind you tomorrow" : `⏰ Snoozed ${hours}h`, settled: true };
}

// ── Agent ────────────────────────────────────────────────────────────────

async function loadAgent(): Promise<AgentPort> {
  const runner = await import("@/server/agent/runner");
  return { status: runner.agentStatus, run: runner.runAgent };
}

/** Send HTML, falling back to plain text if Telegram can't parse it. */
async function sendRich(api: BotApi, chatId: number, html: string) {
  for (const part of splitMessage(html)) {
    try {
      await api.sendMessage(chatId, part);
    } catch (e) {
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
      await api.sendMessage(chatId, stripHtml(part), { parseMode: null });
    }
  }
}

/** Show "typing…" until stopped (Telegram clears it after ~5 s). */
function keepTyping(api: BotApi, chatId: number): () => void {
  const ping = () => void api.sendChatAction(chatId, "typing").catch(() => {});
  ping();
  const timer = setInterval(ping, 4_500);
  return () => clearInterval(timer);
}

async function askAgent(
  uid: string,
  chatId: number,
  question: string,
  ctx: BotContext,
  opts: { fromPlainText: boolean; attachments?: string[] },
) {
  let agent: AgentPort;
  let reason: string | undefined;
  try {
    agent = await (ctx.agent ?? loadAgent)();
    const status = agent.status();
    if (!status.ready) reason = status.reason ?? "not configured";
  } catch (e) {
    ctx.log?.(`agent failed to load: ${errorMessage(e)}`);
    reason = "it failed to load";
  }
  if (reason) {
    const text = opts.fromPlainText
      ? `🤖 The assistant isn't available (${esc(reason)}).\n\n${renderHelp()}`
      : `🤖 The assistant isn't available: ${esc(reason)}`;
    await ctx.api.sendMessage(chatId, text);
    return;
  }

  const conversations = ctx.conversations ?? defaultConversations;
  const turn = async () => {
    const stopTyping = keepTyping(ctx.api, chatId);
    try {
      const res = await agent.run({
        userId: uid,
        conversationId: conversations.get(chatId),
        message: question,
        attachments: opts.attachments,
        channel: "telegram",
        signal: ctx.signal,
      });
      conversations.set(chatId, res.conversationId);
      await sendRich(ctx.api, chatId, markdownToHtml(res.text.trim() || "🤷 (no answer)"));
    } finally {
      stopTyping();
    }
  };
  const run = (agentQueues.get(chatId) ?? Promise.resolve()).catch(() => {}).then(turn);
  agentQueues.set(chatId, run);
  try {
    await run;
  } finally {
    if (agentQueues.get(chatId) === run) agentQueues.delete(chatId);
  }
}

/** A statement or screenshot sent to the bot: store it and hand it to the assistant. */
async function handleFile(uid: string, msg: TgMessage, ctx: BotContext) {
  const chatId = msg.chat.id;
  const doc = msg.document;
  const photo = msg.photo?.at(-1); // largest size
  const fileId = doc?.file_id ?? photo?.file_id;
  if (!fileId) return;
  const filename = doc?.file_name ?? `photo-${msg.message_id}.jpg`;
  const mimeType = doc?.mime_type ?? "image/jpeg";
  if (!uploadKind(mimeType, filename)) {
    await ctx.api.sendMessage(chatId, "📎 I can read CSV, TXT/OFX, PDF and images — not this file type.");
    return;
  }
  const data = await ctx.api.downloadFile(fileId);
  const upload = saveUpload(uid, { filename, mimeType, data });
  await ctx.api.sendMessage(chatId, `📥 Got <b>${esc(filename)}</b> — reading it…`);
  await askAgent(uid, chatId, msg.caption ?? "", ctx, { fromPlainText: false, attachments: [upload.id] });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

async function handleMessage(user: User, msg: TgMessage, ctx: BotContext) {
  const uid = user.id;
  const chatId = msg.chat.id;
  const reply = (html: string) => ctx.api.sendMessage(chatId, html);
  if (msg.document || msg.photo) return handleFile(uid, msg, ctx);
  const text = msg.text ?? "";
  const cmd = parseCommand(text, ctx.botUsername);

  if (!cmd) {
    const repliedTo = msg.reply_to_message;
    if (repliedTo) {
      const reminder = findReminderByMessageId(uid, repliedTo.message_id);
      const answer = reminder ? reminderReply(uid, reminder, text) : null;
      if (answer) {
        await reply(answer);
        await ctx.api.editMessageReplyMarkup(chatId, repliedTo.message_id).catch(() => {});
        return;
      }
    }
    if (isWalking(chatId)) {
      await reply(answerWalkthrough(uid, chatId, text, parseAmountOnly(text)));
      return;
    }
    await askAgent(uid, chatId, text, ctx, { fromPlainText: true });
    return;
  }

  // Any command ends a running /update walkthrough.
  stopWalkthrough(chatId);

  if (cmd.command === "ask") {
    if (cmd.args) await askAgent(uid, chatId, cmd.args, ctx, { fromPlainText: false });
    else await reply(USAGE.ask);
  } else if (cmd.command === "update" || cmd.command === "balances") {
    await reply(startWalkthrough(uid, chatId));
  } else if (cmd.command === "new") {
    (ctx.conversations ?? defaultConversations).delete(chatId);
    await reply("🆕 Fresh conversation. Ask away!");
  } else if ((cmd.command === "start" || cmd.command === "link") && cmd.args) {
    await reply(linkChat(chatId, cmd.args) ?? renderHelp());
  } else {
    const handler = COMMANDS[cmd.command];
    await reply(handler ? handler(uid, cmd.args) : "🤷 Unknown command. Try /help");
  }
}

/** `/start CODE` from Settings → Telegram links this chat to that user. Returns a reply, or null if the code is invalid. */
function linkChat(chatId: number, code: string): string | null {
  const user = redeemTelegramLinkCode(code.trim(), chatId);
  return user ? `🔗 Linked! This chat now belongs to <b>${esc(user.name)}</b>'s wallet.\n\n${renderHelp()}` : null;
}

async function handleCallback(q: TgCallbackQuery, ctx: BotContext) {
  const chatId = q.message?.chat.id;
  const user = chatId === undefined ? null : userForChat(chatId, ctx.allowedChatIds);
  if (chatId === undefined || !user) {
    ctx.log?.(`ignored button press from chat ${chatId ?? "?"}`);
    return;
  }
  if (q.data === "walk:start") {
    await ctx.api.answerCallbackQuery(q.id, "✏️ Let's go");
    await ctx.api.sendMessage(chatId, startWalkthrough(user.id, chatId));
    return;
  }
  let result: { toast: string; settled: boolean };
  try {
    result = reminderAction(user.id, q.data ?? "");
  } catch (e) {
    ctx.log?.(`callback ${q.data} failed: ${errorMessage(e)}`);
    result = { toast: `⚠️ ${errorMessage(e)}`.slice(0, 200), settled: false };
  }
  await ctx.api.answerCallbackQuery(q.id, result.toast);
  if (result.settled && q.message) {
    await ctx.api.editMessageReplyMarkup(chatId, q.message.message_id).catch(() => {});
  }
}

/** Handle one Telegram update. Never throws: failures are logged and reported as "⚠️ …". */
export async function handleUpdate(update: TgUpdate, ctx: BotContext): Promise<void> {
  const log = ctx.log ?? console.log;
  try {
    if (update.callback_query) return await handleCallback(update.callback_query, { ...ctx, log });
    const msg = update.message;
    if (!msg || !(msg.text || msg.document || msg.photo)) return;
    const chatId = msg.chat.id;
    const user = userForChat(chatId, ctx.allowedChatIds);

    if (!user) {
      // Strangers can link with a code; otherwise they learn their chat id and nothing else.
      const cmd = msg.text ? parseCommand(msg.text) : null;
      if (cmd && (cmd.command === "start" || cmd.command === "link")) {
        const linked = cmd.args ? linkChat(chatId, cmd.args) : null;
        await ctx.api.sendMessage(
          chatId,
          linked ??
            `👋 To connect this chat, open wallet → Settings → Telegram and send the <code>/start CODE</code> shown there.\n(Your chat id is <code>${chatId}</code>.)`,
        );
      }
      log(`ignored message from unlinked chat ${chatId}`);
      return;
    }

    try {
      await handleMessage(user, msg, { ...ctx, log });
    } catch (e) {
      log(`⚠️ update ${update.update_id} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      await ctx.api.sendMessage(chatId, `⚠️ ${esc(errorMessage(e))}`);
    }
  } catch (e) {
    log(`⚠️ update ${update.update_id}: ${errorMessage(e)}`);
  }
}
