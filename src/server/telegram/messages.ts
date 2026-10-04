/**
 * Telegram message renderers. Each returns an HTML string (Telegram's HTML
 * parse mode); anything coming from the DB or the user goes through `esc`.
 */
import { DateTime } from "luxon";
import type { Category, Reminder } from "@/server/db/schema";
import { getAccount, staleAccounts } from "@/server/services/accounts";
import { budgetStatus, cashflow, type BudgetLineStatus } from "@/server/services/budgets";
import { netWorthChanges } from "@/server/services/networth";
import { listReminders } from "@/server/services/reminders";
import { getSettings, today } from "@/server/services/settings";
import { ASSET_CLASSES, ASSET_CLASS_LABELS, type AssetClass } from "@/lib/domain";
import { formatMoney, type MoneyFormat } from "@/lib/money";
import { formatDate, formatMonth } from "@/lib/dates";
import { escapeHtml as esc, type InlineKeyboardMarkup } from "./api";

/** Telegram caps messages at 4096 characters; keep a margin. */
export const MAX_MESSAGE_LENGTH = 4000;

export const BOT_COMMANDS = [
  { command: "networth", args: "", emoji: "🏦", description: "Net worth snapshot" },
  { command: "budget", args: "[YYYY-MM]", emoji: "🧾", description: "Budget progress" },
  { command: "update", args: "", emoji: "🔁", description: "Update all balances, one by one" },
  { command: "balance", args: "<account> <amount>", emoji: "✏️", description: "Update a balance" },
  { command: "spent", args: "<amount> <category> [— note]", emoji: "💸", description: "Log an expense" },
  { command: "earned", args: "<amount> <category> [— note]", emoji: "💰", description: "Log income" },
  { command: "reminders", args: "", emoji: "⏰", description: "Upcoming & pending reminders" },
  { command: "ask", args: "<question>", emoji: "🤖", description: "Ask the assistant" },
  { command: "new", args: "", emoji: "🆕", description: "Fresh assistant conversation" },
  { command: "help", args: "", emoji: "❓", description: "What I can do" },
] as const;

const CLASS_EMOJI: Record<AssetClass, string> = {
  cash: "💵",
  investments: "📈",
  retirement: "🏖️",
  real_estate: "🏠",
  crypto: "🪙",
  commodities: "🥇",
  other: "📦",
  liabilities: "💳",
};

const STATUS_EMOJI: Record<BudgetLineStatus, string> = {
  ok: "🟢",
  ahead_of_pace: "🟡",
  over: "🔴",
  unbudgeted: "⚪",
};

/** Money formatter bound to the user's base currency & locale. */
function moneyFormatter(uid: string) {
  const { currency, locale } = getSettings(uid);
  return (cents: number, opts: MoneyFormat = {}) => formatMoney(cents, { currency, locale, ...opts });
}

/** A category icon followed by a space, or nothing. */
const icon = (value: string | null) => (value ? `${esc(value)} ` : "");
const trend = (cents: number) => (cents < 0 ? "📉" : "📈");
const pct = (value: number) => `${Math.round(value)}%`;
const signedPct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;

/** ▓▓▓▓░░░░ */
export function progressBar(percent: number, width = 8): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

// ── Help ─────────────────────────────────────────────────────────────────

export function renderHelp(): string {
  const commands = BOT_COMMANDS.map(
    (c) => `${c.emoji} /${c.command}${c.args ? ` ${esc(c.args)}` : ""} — ${esc(c.description)}`,
  );
  return [
    "👋 <b>wallet bot</b>",
    "",
    ...commands,
    "",
    "<b>Examples</b>",
    "/balance livret a 12 500",
    "/spent 12.50 groceries — lunch",
    "",
    "↩️ Reply to a reminder with a number to update that balance.",
    "💬 Or just type a question.",
  ].join("\n");
}

// ── Reminders ────────────────────────────────────────────────────────────

export function reminderKeyboard(r: Pick<Reminder, "id" | "kind" | "accountId">): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  // A general "update balances" reminder can start the /update walkthrough directly.
  if (r.kind === "balance_update" && r.accountId === null) {
    rows.push([{ text: "✏️ Update balances now", callback_data: "walk:start" }]);
  }
  rows.push([
    { text: "✅ Done", callback_data: `done:${r.id}` },
    { text: "⏰ Snooze 3h", callback_data: `snooze:${r.id}:3` },
    { text: "💤 Tomorrow", callback_data: `snooze:${r.id}:24` },
  ]);
  return { inline_keyboard: rows };
}

/** The message sent when a reminder fires (or nags, with `nag: true`). */
export function renderReminder(r: Reminder, opts: { nag?: boolean } = {}): string {
  const title = `<b>${esc(r.title)}</b>`;
  const lines = [opts.nag ? `🔁 Still pending: ${title}` : `🔔 ${title}`];
  if (r.message) lines.push(esc(r.message));
  const body = reminderBody(r);
  if (body.length) lines.push("", ...body);
  return lines.join("\n");
}

function reminderBody(r: Reminder): string[] {
  switch (r.kind) {
    case "balance_update":
      return balanceUpdateBody(r.userId, r.accountId);
    case "statement":
      return statementBody(r.userId, r.accountId);
    case "monthly_report":
      return [renderMonthlyReport(r.userId)];
    default:
      return [];
  }
}

function accountOrNull(uid: string, id: number | null) {
  if (id === null) return null;
  try {
    return getAccount(uid, id).account;
  } catch {
    return null;
  }
}

function balanceUpdateBody(uid: string, accountId: number | null): string[] {
  const { locale } = getSettings(uid);
  const account = accountOrNull(uid, accountId);
  if (account) {
    const last = account.lastUpdated ? ` (${formatDate(account.lastUpdated, locale)})` : "";
    return [
      `🏦 ${esc(account.name)}${account.institution ? ` · ${esc(account.institution)}` : ""}`,
      `Last: ${formatMoney(account.balanceCents, { currency: account.currency, locale })}${last}`,
      "↩️ <b>Reply to this message with the new balance.</b>",
    ];
  }
  const stale = staleAccounts(uid);
  const lines = stale.length ? ["🕰️ Not updated for a while:"] : [];
  for (const a of stale.slice(0, 8)) {
    lines.push(`• ${esc(a.name)} — ${a.lastUpdated ? formatDate(a.lastUpdated, locale) : "never"}`);
  }
  if (stale.length > 8) lines.push(`• …and ${stale.length - 8} more`);
  lines.push("👉 Tap <b>Update balances now</b> or send /update to go through them one by one.");
  return lines;
}

function statementBody(uid: string, accountId: number | null): string[] {
  const account = accountOrNull(uid, accountId);
  const base = process.env.WALLET_PUBLIC_URL?.replace(/\/+$/, "");
  return [
    `📄 Time to import your bank statement${account ? ` for <b>${esc(account.name)}</b>` : ""}.`,
    "📎 Send the CSV or PDF right here and the assistant will import it.",
    base ? `👉 Or drop it in the <a href="${esc(base)}/assistant">web assistant</a>.` : "👉 Or drop it in the web app's assistant.",
  ];
}

/** Last month in review: cash flow, budget overruns, net worth. */
export function renderMonthlyReport(uid: string): string {
  const m = moneyFormatter(uid);
  const whole = { whole: true };
  const flow = cashflow(uid, 2)[0];
  const month = flow.month;
  const lines = [`📊 <b>${DateTime.fromISO(`${month}-01`).setLocale(getSettings(uid).locale).toFormat("LLLL yyyy")}</b>`];

  if (!flow.incomeCents && !flow.expensesCents) {
    lines.push("🤷 No transactions recorded.");
  } else {
    lines.push(`💰 Income: ${m(flow.incomeCents, whole)}`, `💸 Expenses: ${m(flow.expensesCents, whole)}`);
    if (flow.netCents >= 0) {
      const rate = flow.savingsRatePct !== null ? ` · ${pct(flow.savingsRatePct)}` : "";
      lines.push(`🐖 Saved: ${m(flow.netCents, whole)}${rate}`);
    } else {
      lines.push(`🔥 Overspent: ${m(-flow.netCents, whole)}`);
    }
  }

  const budget = budgetStatus(uid, month);
  const over = budget.lines
    .filter((l) => l.status === "over" && l.budgetCents !== null)
    .sort((a, b) => b.spentCents - b.budgetCents! - (a.spentCents - a.budgetCents!));
  if (over.length) {
    lines.push("", "🔴 <b>Over budget</b>");
    for (const l of over.slice(0, 3)) {
      const excess = m(l.spentCents - l.budgetCents!, { ...whole, signed: true });
      lines.push(`• ${icon(l.icon)}${esc(l.name)}: ${excess} (${m(l.spentCents, whole)} / ${m(l.budgetCents!, whole)})`);
    }
    if (over.length > 3) lines.push(`• …and ${over.length - 3} more`);
  } else if (budget.totalBudgetCents > 0) {
    lines.push("", "🟢 All budgets on track ✨");
  }

  const { current, changes } = netWorthChanges(uid);
  lines.push("", `🏦 Net worth: ${m(current.netCents, whole)}`);
  const month1 = changes.find((c) => c.label === "1 month");
  if (month1) lines.push(changeLine(uid, month1.label, month1.deltaCents, month1.deltaPct));
  return lines.join("\n");
}

function changeLine(uid: string, label: string, deltaCents: number, deltaPct: number | null): string {
  const m = moneyFormatter(uid);
  const p = deltaPct !== null ? ` (${signedPct(deltaPct)})` : "";
  return `${trend(deltaCents)} ${label}: ${m(deltaCents, { whole: true, signed: true })}${p}`;
}

/** /reminders: what's waiting for a ✅ and what's coming up. */
export function renderReminders(uid: string): string {
  const { timezone, locale } = getSettings(uid);
  const when = (d: Date) => DateTime.fromJSDate(d).setZone(timezone).setLocale(locale).toFormat("ccc d LLL, HH:mm");
  const list = listReminders(uid).filter((r) => r.enabled);
  if (!list.length) return "⏰ No reminders yet. Add some in the web app.";

  const lines = ["⏰ <b>Reminders</b>"];
  const waiting = list.filter((r) => r.nextNagAt !== null);
  if (waiting.length) {
    lines.push("", "⏳ <b>Waiting for ✅</b>");
    for (const r of waiting) lines.push(`• ${esc(r.title)} — next nudge ${when(r.nextNagAt!)}`);
  }
  const upcoming = list
    .filter((r) => r.nextRunAt !== null)
    .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime());
  if (upcoming.length) {
    lines.push("", "📅 <b>Next up</b>");
    for (const r of upcoming) lines.push(`• <b>${when(r.nextRunAt!)}</b> · ${esc(r.title)}`, `   <i>${esc(r.schedule)}</i>`);
  }
  lines.push("", `<i>Times in ${esc(timezone)}</i>`);
  return lines.join("\n");
}

// ── Net worth & budget ───────────────────────────────────────────────────

export function renderNetWorth(uid: string): string {
  const m = moneyFormatter(uid);
  const whole = { whole: true };
  const { current, changes } = netWorthChanges(uid);
  if (!current.accounts.length) return "🏦 No accounts yet. Add them in the web app.";

  const lines = [
    `🏦 <b>Net worth: ${m(current.netCents, whole)}</b>`,
    `➕ Assets: ${m(current.assetsCents, whole)}`,
    `➖ Liabilities: ${m(current.liabilitiesCents, whole)}`,
  ];
  const classes = ASSET_CLASSES.filter((c) => c !== "liabilities" && current.byClassCents[c] !== 0).sort(
    (a, b) => current.byClassCents[b] - current.byClassCents[a],
  );
  if (classes.length) {
    lines.push("");
    for (const c of classes) {
      const value = current.byClassCents[c];
      const share = current.assetsCents ? ` · ${pct((value / current.assetsCents) * 100)}` : "";
      lines.push(`${CLASS_EMOJI[c]} ${esc(ASSET_CLASS_LABELS[c])}: ${m(value, whole)}${share}`);
    }
  }
  const shown = changes.filter((c) => c.label === "1 month" || c.label === "YTD");
  if (shown.length) lines.push("", ...shown.map((c) => changeLine(uid, c.label, c.deltaCents, c.deltaPct)));
  return lines.join("\n");
}

export function renderBudget(uid: string, month = today(uid).slice(0, 7)): string {
  const m = moneyFormatter(uid);
  const whole = { whole: true };
  const { locale } = getSettings(uid);
  const s = budgetStatus(uid, month);

  let header = `🧾 <b>Budget · ${formatMonth(month, locale)}</b>`;
  if (s.elapsed > 0 && s.elapsed < 1) header += ` · ${pct(s.elapsed * 100)} of month gone`;
  const lines = [
    header,
    `💰 Income: ${m(s.incomeCents, whole)}`,
    `💸 Expenses: ${m(s.expensesCents, whole)}`,
    `🐖 Savings rate: ${s.savingsRatePct !== null ? pct(s.savingsRatePct) : "—"}`,
    "",
  ];

  const budgeted = s.lines.filter((l) => l.budgetCents !== null);
  if (!budgeted.length) lines.push("No budgets set yet — add some in the web app.");
  for (const l of budgeted) {
    lines.push(
      `${STATUS_EMOJI[l.status]} ${icon(l.icon)}<b>${esc(l.name)}</b>`,
      `${progressBar(l.pct ?? 0)} ${pct(l.pct ?? 0)} · ${m(l.spentCents, whole)} / ${m(l.budgetCents!, whole)}`,
    );
  }

  const unbudgeted = s.lines.filter((l) => l.budgetCents === null);
  if (unbudgeted.length) {
    const top = unbudgeted.slice(0, 4).map((l) => `${esc(l.name)} ${m(l.spentCents, whole)}`);
    const more = unbudgeted.length > 4 ? ` +${unbudgeted.length - 4} more` : "";
    lines.push("", `⚪ Unbudgeted: ${top.join(", ")}${more}`);
  }
  return lines.join("\n");
}

// ── Confirmations ────────────────────────────────────────────────────────

export function renderBalanceRecorded(opts: {
  uid: string;
  accountName: string;
  currency: string;
  beforeCents: number;
  afterCents: number;
  derivedFromLoan?: boolean;
}): string {
  const { locale } = getSettings(opts.uid);
  const m = (cents: number, o: MoneyFormat = {}) => formatMoney(cents, { currency: opts.currency, locale, ...o });
  const delta = opts.afterCents - opts.beforeCents;
  const lines = [
    `✅ <b>${esc(opts.accountName)}</b> updated`,
    `${m(opts.beforeCents)} → <b>${m(opts.afterCents)}</b>`,
  ];
  if (delta !== 0) lines.push(`${trend(delta)} ${m(delta, { signed: true })}`);
  if (opts.derivedFromLoan) lines.push("ℹ️ This loan's balance is computed from its schedule.");
  return lines.join("\n");
}

export function renderTransactionAdded(opts: {
  uid: string;
  currency: string;
  amountCents: number;
  category: Category | undefined;
  categoryQuery: string;
  note: string | null;
}): string {
  const m = moneyFormatter(opts.uid);
  const { locale } = getSettings(opts.uid);
  const { amountCents, category } = opts;
  const verb = amountCents < 0 ? "💸 Spent" : "💰 Earned";
  const label = category ? `${icon(category.icon)}${esc(category.name)}` : "❔ Uncategorized";
  const lines = [`${verb} <b>${formatMoney(Math.abs(amountCents), { currency: opts.currency, locale })}</b> · ${label}`];
  if (opts.note) lines.push(`📝 ${esc(opts.note)}`);
  if (!category && opts.categoryQuery) {
    lines.push(`❔ No category matches “${esc(opts.categoryQuery)}” — saved as uncategorized.`);
  }
  if (category && amountCents < 0) {
    const line = budgetStatus(opts.uid).lines.find((l) => l.categoryId === category.id && l.budgetCents !== null);
    if (line) {
      lines.push(
        `${STATUS_EMOJI[line.status]} ${m(line.spentCents, { whole: true })} / ${m(line.budgetCents!, { whole: true })} this month (${pct(line.pct ?? 0)})`,
      );
    }
  }
  return lines.join("\n");
}

// ── Agent replies ────────────────────────────────────────────────────────

/** Inline markdown → Telegram HTML: `code`, **bold**, [links](url). */
function inlineMarkdown(line: string): string {
  return line
    .split(/(`[^`]+`)/)
    .map((part, i) =>
      i % 2
        ? `<code>${esc(part.slice(1, -1))}</code>`
        : esc(part)
            .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
            .replace(/__(.+?)__/g, "<b>$1</b>")
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>'),
    )
    .join("");
}

/** Convert the agent's markdown to the subset of HTML Telegram accepts. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let fence: string[] | null = null;
  for (const line of md.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (fence) {
        out.push(`<pre>${esc(fence.join("\n"))}</pre>`);
        fence = null;
      } else fence = [];
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) out.push(`<b>${inlineMarkdown(heading[1])}</b>`);
    else out.push(inlineMarkdown(line.replace(/^(\s*)[-*]\s+/, "$1• ")));
  }
  if (fence) out.push(`<pre>${esc(fence.join("\n"))}</pre>`);
  return out.join("\n");
}

/** Back to plain text, for when Telegram rejects our HTML. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Split a long message at line breaks so each part fits in one Telegram message. */
export function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}
