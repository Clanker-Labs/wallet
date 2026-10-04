/**
 * Telegram command handling. `handleUpdate` is the single entry point; the
 * API client is injected so tests can run it against a fake.
 */
import { ZodError } from "zod";
import type { Account, Reminder } from "@/server/db/schema";
import { findAccounts, getAccount, listAccounts, recordBalance } from "@/server/services/accounts";
import { findCategory } from "@/server/services/categories";
import { acknowledgeReminder, findReminderByMessageId, getReminder, snoozeReminder } from "@/server/services/reminders";
import { addTransaction } from "@/server/services/transactions";
import { isMonth } from "@/lib/dates";
import { parseAmount, toCents } from "@/lib/money";
import { escapeHtml as esc, TelegramError, type TelegramApi, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./api";
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

export type BotApi = Pick<TelegramApi, "sendMessage" | "editMessageReplyMarkup" | "answerCallbackQuery" | "sendChatAction">;

export interface AgentPort {
  status(): { ready: boolean; reason?: string };
  run(opts: {
    conversationId?: string;
    message: string;
    channel: "telegram";
    signal?: AbortSignal;
  }): Promise<{ conversationId: string; text: string }>;
}

export interface BotContext {
  api: BotApi;
  /** Chats allowed to use the bot. The first one is the primary chat (reminder replies). */
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
function findCategoryAtWordStart(query: string) {
  const category = findCategory(query);
  if (!category) return undefined;
  const name = category.name.toLowerCase();
  const i = name.indexOf(query.toLowerCase());
  return i === 0 || (i > 0 && !/[\p{L}\p{N}]/u.test(name[i - 1])) ? category : undefined;
}

/**
 * "groceries — lunch with Bob" or "groceries lunch with Bob": the longest
 * leading run of words naming a category wins; the rest is the note.
 */
export function resolveCategoryAndNote(text: string) {
  const sep = text.match(/^(.*?)\s*(?:[—–]|\s--?\s)\s*(.*)$/s);
  const head = (sep ? sep[1] : text).trim();
  const explicitNote = sep ? sep[2].trim() : "";
  const words = tokenize(head);
  for (let k = words.length; k > 0; k--) {
    const query = words.slice(0, k).join(" ");
    if (query.length < 3) break;
    const category = findCategoryAtWordStart(query);
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

function budgetCommand(args: string): string {
  if (args && !isMonth(args)) return USAGE.budget;
  return renderBudget(args || undefined);
}

function recordAndConfirm(account: Account, amount: number): string {
  const before = getAccount(account.id).account;
  const { balanceCents } = recordBalance({ accountId: account.id, balance: amount, source: "telegram" });
  return renderBalanceRecorded({
    accountName: account.name,
    beforeCents: before.balanceCents,
    afterCents: balanceCents,
    derivedFromLoan: !!account.loanParams,
  });
}

function balanceCommand(args: string): string {
  const parsed = splitTrailingAmount(args);
  if (!parsed || !parsed.rest) return USAGE.balance;
  const matches = findAccounts(parsed.rest);
  if (matches.length === 1) return recordAndConfirm(matches[0], parsed.amount);
  if (matches.length > 1) {
    return [
      `🤔 Several accounts match “${esc(parsed.rest)}”:`,
      ...matches.map((a) => `• ${esc(a.name)}${a.institution ? ` (${esc(a.institution)})` : ""}`),
      "Be more specific.",
    ].join("\n");
  }
  const names = listAccounts().map((a) => esc(a.name));
  return [
    `🔍 No account matches “${esc(parsed.rest)}”.`,
    names.length ? `Your accounts: ${names.slice(0, 15).join(", ")}` : "No accounts yet — add them in the web app.",
  ].join("\n");
}

function transactionCommand(args: string, kind: "expense" | "income"): string {
  const parsed = splitLeadingAmount(args);
  if (!parsed || parsed.amount === 0 || !parsed.rest) return kind === "expense" ? USAGE.spent : USAGE.earned;
  const { category, note, query } = resolveCategoryAndNote(parsed.rest);
  const amount = kind === "expense" ? -Math.abs(parsed.amount) : Math.abs(parsed.amount);
  addTransaction({
    amount,
    description: (category ? note || category.name : note) || (kind === "expense" ? "Expense" : "Income"),
    categoryId: category?.id ?? null,
    source: "telegram",
  });
  return renderTransactionAdded({ amountCents: toCents(amount), category, categoryQuery: query, note: category ? note : null });
}

const COMMANDS: Record<string, (args: string) => string> = {
  start: renderHelp,
  help: renderHelp,
  networth: renderNetWorth,
  nw: renderNetWorth,
  budget: budgetCommand,
  balance: balanceCommand,
  spent: (args) => transactionCommand(args, "expense"),
  earned: (args) => transactionCommand(args, "income"),
  reminders: renderReminders,
};

// ── Reminder replies & buttons ───────────────────────────────────────────

const DONE_WORDS = /^(done|ok|okay|fait|✅|👍)$/i;

/** A reply to a reminder message. Returns null when the text isn't meant for the reminder. */
function reminderReply(reminder: Reminder, text: string): string | null {
  const amount = parseAmountOnly(text);
  if (amount !== null && reminder.kind === "balance_update" && reminder.accountId !== null) {
    const confirmation = recordAndConfirm(getAccount(reminder.accountId).account, amount);
    acknowledgeReminder(reminder.id);
    return confirmation;
  }
  if (amount !== null || DONE_WORDS.test(text.trim())) {
    acknowledgeReminder(reminder.id);
    return `✅ Noted — <b>${esc(reminder.title)}</b> marked done.`;
  }
  return null;
}

/** Apply a button press. `settled` = the reminder's keyboard can go away. */
function reminderAction(data: string): { toast: string; settled: boolean } {
  const m = data.match(/^(done|snooze):(\d+)(?::(\d+))?$/);
  if (!m) return { toast: "🤷 Unknown action", settled: false };
  const id = Number(m[2]);
  const reminder = getReminder(id);
  if (!reminder) return { toast: "This reminder no longer exists", settled: true };
  if (m[1] === "done") {
    acknowledgeReminder(id);
    return { toast: `✅ Done: ${reminder.title}`, settled: true };
  }
  const hours = Number(m[3] ?? 3);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) return { toast: "🤷 Invalid snooze", settled: false };
  snoozeReminder(id, hours);
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

async function askAgent(chatId: number, question: string, ctx: BotContext, opts: { fromPlainText: boolean }) {
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
        conversationId: conversations.get(chatId),
        message: question,
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

// ── Dispatch ─────────────────────────────────────────────────────────────

async function handleMessage(msg: TgMessage, text: string, ctx: BotContext) {
  const chatId = msg.chat.id;
  const reply = (html: string) => ctx.api.sendMessage(chatId, html);
  const cmd = parseCommand(text, ctx.botUsername);

  if (!cmd) {
    // Reminder message ids are recorded for the primary chat only.
    const repliedTo = msg.reply_to_message;
    if (repliedTo && chatId === ctx.allowedChatIds[0]) {
      const reminder = findReminderByMessageId(repliedTo.message_id);
      const answer = reminder ? reminderReply(reminder, text) : null;
      if (answer) {
        await reply(answer);
        await ctx.api.editMessageReplyMarkup(chatId, repliedTo.message_id).catch(() => {});
        return;
      }
    }
    if (isWalking(chatId)) {
      await reply(answerWalkthrough(chatId, text, parseAmountOnly(text)));
      return;
    }
    await askAgent(chatId, text, ctx, { fromPlainText: true });
    return;
  }

  // Any command ends a running /update walkthrough.
  stopWalkthrough(chatId);

  if (cmd.command === "ask") {
    if (cmd.args) await askAgent(chatId, cmd.args, ctx, { fromPlainText: false });
    else await reply(USAGE.ask);
  } else if (cmd.command === "update" || cmd.command === "balances") {
    await reply(startWalkthrough(chatId));
  } else if (cmd.command === "new") {
    (ctx.conversations ?? defaultConversations).delete(chatId);
    await reply("🆕 Fresh conversation. Ask away!");
  } else {
    const handler = COMMANDS[cmd.command];
    await reply(handler ? handler(cmd.args) : "🤷 Unknown command. Try /help");
  }
}

async function handleCallback(q: TgCallbackQuery, ctx: BotContext) {
  const chatId = q.message?.chat.id;
  if (chatId === undefined || !ctx.allowedChatIds.includes(chatId)) {
    ctx.log?.(`ignored button press from chat ${chatId ?? "?"}`);
    return;
  }
  if (q.data === "walk:start") {
    await ctx.api.answerCallbackQuery(q.id, "✏️ Let's go");
    await ctx.api.sendMessage(chatId, startWalkthrough(chatId));
    return;
  }
  let result: { toast: string; settled: boolean };
  try {
    result = reminderAction(q.data ?? "");
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
    if (!msg?.text) return;
    const chatId = msg.chat.id;

    if (!ctx.allowedChatIds.includes(chatId)) {
      // Strangers learn their chat id (to set up the allowlist) and nothing else.
      if (parseCommand(msg.text)?.command === "start") {
        await ctx.api.sendMessage(chatId, `👋 Your chat id is <code>${chatId}</code> — add it to TELEGRAM_CHAT_ID`);
      }
      log(`ignored message from chat ${chatId}`);
      return;
    }

    try {
      await handleMessage(msg, msg.text, { ...ctx, log });
    } catch (e) {
      log(`⚠️ update ${update.update_id} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      await ctx.api.sendMessage(chatId, `⚠️ ${esc(errorMessage(e))}`);
    }
  } catch (e) {
    log(`⚠️ update ${update.update_id}: ${errorMessage(e)}`);
  }
}
