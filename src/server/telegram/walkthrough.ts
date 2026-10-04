/**
 * /update: go through every manually-tracked account, stalest first, one
 * question per message. Reply with a number, "skip" or "stop".
 */
import { getAccount, listAccounts, recordBalance } from "@/server/services/accounts";
import { netWorthOn } from "@/server/services/networth";
import { getSettings } from "@/server/services/settings";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { escapeHtml as esc } from "./api";

interface Walkthrough {
  uid: string;
  queue: number[];
  total: number;
  updated: number;
  skipped: number;
  startNetCents: number;
  touchedAt: number;
}

const IDLE_MS = 60 * 60 * 1000;
const sessions = new Map<number, Walkthrough>();

const SKIP = /^(skip|next|pass|s|-)$/i;
const STOP = /^(stop|cancel|quit|done|fin)$/i;

function money(uid: string, cents: number, opts: { signed?: boolean; currency?: string } = {}) {
  const { currency, locale } = getSettings(uid);
  return formatMoney(cents, { currency: opts.currency ?? currency, locale, signed: opts.signed });
}

export function isWalking(chatId: number, now = Date.now()): boolean {
  const s = sessions.get(chatId);
  if (s && now - s.touchedAt > IDLE_MS) sessions.delete(chatId);
  return sessions.has(chatId);
}

function prompt(s: Walkthrough): string {
  const { account } = getAccount(s.uid, s.queue[0]);
  const { locale } = getSettings(s.uid);
  const step = s.total - s.queue.length + 1;
  const last = account.lastUpdated
    ? `Last: ${money(s.uid, account.balanceCents, { currency: account.currency })} · ${formatDate(account.lastUpdated, locale)}`
    : "No balance yet";
  return [
    `✏️ <b>${step}/${s.total} · ${esc(account.name)}</b>${account.institution ? ` (${esc(account.institution)})` : ""}`,
    last,
    "Reply with the new balance, <i>skip</i> or <i>stop</i>.",
  ].join("\n");
}

function summary(s: Walkthrough): string {
  const now = netWorthOn(s.uid).netCents;
  return [
    `✅ Done — ${s.updated} updated, ${s.skipped} skipped.`,
    `🏦 Net worth: <b>${money(s.uid, now)}</b> (${money(s.uid, now - s.startNetCents, { signed: true })})`,
  ].join("\n");
}

/** Start a walkthrough; returns the first prompt. */
export function startWalkthrough(uid: string, chatId: number, now = Date.now()): string {
  const accounts = listAccounts(uid)
    .filter((a) => !a.derivedFromLoan && !a.valuedByHoldings && a.includeInNetWorth)
    .sort((a, b) => (a.lastUpdated ?? "").localeCompare(b.lastUpdated ?? ""));
  if (!accounts.length) return "🤷 No accounts to update yet — add them in the web app.";
  const s: Walkthrough = {
    uid,
    queue: accounts.map((a) => a.id),
    total: accounts.length,
    updated: 0,
    skipped: 0,
    startNetCents: netWorthOn(uid).netCents,
    touchedAt: now,
  };
  sessions.set(chatId, s);
  return `🔁 Let's update ${accounts.length} account${accounts.length > 1 ? "s" : ""}, stalest first.\n\n${prompt(s)}`;
}

/**
 * Feed an answer to the active walkthrough. `amount` is the parsed number, if
 * the text was one. Returns the reply to send.
 */
export function answerWalkthrough(uid: string, chatId: number, text: string, amount: number | null, now = Date.now()): string {
  const s = sessions.get(chatId);
  if (!s || s.uid !== uid) return startWalkthrough(uid, chatId, now);
  s.touchedAt = now;
  const t = text.trim();
  let ack = "";
  if (STOP.test(t)) {
    sessions.delete(chatId);
    return summary(s);
  } else if (SKIP.test(t)) {
    s.skipped++;
  } else if (amount !== null) {
    const id = s.queue[0];
    const before = getAccount(uid, id).account;
    const { balanceCents } = recordBalance(uid, { accountId: id, balance: amount, source: "telegram" });
    s.updated++;
    const fmt = { currency: before.currency };
    ack = `👍 ${money(uid, balanceCents, fmt)} (${money(uid, balanceCents - before.balanceCents, { ...fmt, signed: true })})\n\n`;
  } else {
    return "🔢 Send a number (e.g. 12 500), <i>skip</i> or <i>stop</i>.";
  }
  s.queue.shift();
  if (!s.queue.length) {
    sessions.delete(chatId);
    return ack + summary(s);
  }
  return ack + prompt(s);
}

export function stopWalkthrough(chatId: number) {
  sessions.delete(chatId);
}
