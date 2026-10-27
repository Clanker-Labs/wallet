import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db } from "@/server/db/client";
import { categories, recurring, transactions, type RecurringCadence } from "@/server/db/schema";
import { isCurrencyCode, normalizeCurrency } from "@/lib/domain";
import { addDays, isISODate } from "@/lib/dates";
import { toCents } from "@/lib/money";
import { getAccountRow } from "./accounts";
import { requireCategory } from "./categories";
import { fxConverter } from "./fx";
import { getSettings, today } from "./settings";
import { netWorthOn } from "./networth";
import { audit } from "./audit";

/**
 * Recurring money: salary, rent, subscriptions, loan payments.
 *
 * A recurring item is an EXPECTATION, never a transaction. Statements bring
 * the real payment; `reconcileRecurring` links it to the item
 * (transactions.recurringId) and moves the item to its next date. Nothing is
 * created on a schedule, so nothing is counted twice. When no statement will
 * ever bring it (cash rent, a bank you don't import), `recordOccurrence`
 * writes the transaction, and a later import of the same payment adopts that
 * row instead of adding a second one (see importTransactions).
 */

export const CADENCES: Record<RecurringCadence, { label: string; days: number; perYear: number }> = {
  weekly: { label: "Every week", days: 7, perYear: 52 },
  biweekly: { label: "Every 2 weeks", days: 14, perYear: 26 },
  monthly: { label: "Every month", days: 30.44, perYear: 12 },
  quarterly: { label: "Every quarter", days: 91.3, perYear: 4 },
  yearly: { label: "Every year", days: 365.25, perYear: 1 },
};
const CADENCE_KEYS = Object.keys(CADENCES) as RecurringCadence[];

export type Recurring = typeof recurring.$inferSelect;

export function advance(date: string, cadence: RecurringCadence, n = 1): string {
  const d = DateTime.fromISO(date);
  const next =
    cadence === "weekly"
      ? d.plus({ weeks: n })
      : cadence === "biweekly"
        ? d.plus({ weeks: 2 * n })
        : cadence === "monthly"
          ? d.plus({ months: n })
          : cadence === "quarterly"
            ? d.plus({ months: 3 * n })
            : d.plus({ years: n });
  return next.toISODate()!;
}

/**
 * The stable part of a bank label: "CB NETFLIX.COM 12/09 AMSTERDAM 4X23" →
 * "netflix.com amsterdam". Card prefixes, dates, references and long numbers
 * vary from one month to the next; the payee doesn't.
 */
export function payeeKey(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?/g, " ")
    .replace(/[^a-z0-9à-ÿ.&' ]+/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/\d/.test(w)) // references (4X23, REF0599) change every time
    .filter((w) => !STOP.has(w));
  return words.slice(0, 3).join(" ");
}
const STOP = new Set(["cb", "carte", "card", "prlv", "sepa", "vir", "virement", "paiement", "payment", "pos", "purchase", "debit", "credit", "achat", "inst", "recu", "emis", "de", "du", "le", "la", "the", "to", "from", "ref", "x"]);

// ── CRUD ───────────────────────────────────────────────────────────────────

const isoDate = z.string().refine(isISODate, "Expected YYYY-MM-DD");

export const recurringInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  pattern: z.string().trim().min(2).max(120).optional().describe("Text the bank label contains (default: from the name)"),
  accountId: z.number().int().nullish(),
  categoryId: z.number().int().nullish(),
  amount: z.number().describe("Expected amount, signed: negative for money out (rent), positive for money in (salary)"),
  currency: z.string().optional(),
  cadence: z.enum(CADENCE_KEYS as [RecurringCadence, ...RecurringCadence[]]),
  nextDate: isoDate.describe("Next date it is expected"),
  tolerancePct: z.number().min(0).max(100).optional(),
  windowDays: z.number().int().min(0).max(31).optional(),
  status: z.enum(["active", "suggested", "paused", "dismissed"]).optional(),
});
export type RecurringInput = z.input<typeof recurringInputSchema>;

function requireRecurring(uid: string, id: number): Recurring {
  const row = db().select().from(recurring).where(and(eq(recurring.id, id), eq(recurring.userId, uid))).get();
  if (!row) throw new Error(`No recurring item with id ${id}`);
  return row;
}

function currencyFor(uid: string, accountId: number | null | undefined, currency?: string) {
  if (currency) {
    const c = normalizeCurrency(currency);
    if (!isCurrencyCode(c)) throw new Error(`Unknown currency "${currency}"`);
    return c;
  }
  return accountId ? getAccountRow(uid, accountId).currency : getSettings(uid).currency;
}

export function createRecurring(uid: string, raw: RecurringInput, source: "manual" | "detected" = "manual"): Recurring {
  const i = recurringInputSchema.parse(raw);
  if (i.accountId) getAccountRow(uid, i.accountId);
  if (i.categoryId) requireCategory(uid, i.categoryId);
  const row = db()
    .insert(recurring)
    .values({
      userId: uid,
      name: i.name,
      pattern: (i.pattern ?? i.name).toLowerCase().replace(/\s+/g, " ").trim(),
      accountId: i.accountId ?? null,
      categoryId: i.categoryId ?? null,
      amountCents: toCents(i.amount),
      currency: currencyFor(uid, i.accountId, i.currency),
      cadence: i.cadence,
      nextDate: i.nextDate,
      tolerancePct: i.tolerancePct ?? 10,
      windowDays: i.windowDays ?? 5,
      status: i.status ?? "active",
      source,
    })
    .returning()
    .get();
  audit(uid, "recurring", row.id, source === "detected" ? "suggest" : "create", `${source === "detected" ? "Found" : "Added"} recurring “${row.name}”: ${(row.amountCents / 100).toFixed(2)} ${row.currency}, ${row.cadence}`);
  return row;
}

export function updateRecurring(uid: string, id: number, raw: Partial<RecurringInput>): Recurring {
  const cur = requireRecurring(uid, id);
  const i = recurringInputSchema.partial().parse(raw);
  if (i.accountId) getAccountRow(uid, i.accountId);
  if (i.categoryId) requireCategory(uid, i.categoryId);
  const patch: Partial<typeof recurring.$inferInsert> = {};
  if (i.name !== undefined) patch.name = i.name;
  if (i.pattern !== undefined) patch.pattern = i.pattern.toLowerCase().replace(/\s+/g, " ").trim();
  if (i.accountId !== undefined) patch.accountId = i.accountId ?? null;
  if (i.categoryId !== undefined) patch.categoryId = i.categoryId ?? null;
  if (i.amount !== undefined) patch.amountCents = toCents(i.amount);
  if (i.currency !== undefined) patch.currency = currencyFor(uid, i.accountId ?? cur.accountId, i.currency);
  if (i.cadence !== undefined) patch.cadence = i.cadence;
  if (i.nextDate !== undefined) patch.nextDate = i.nextDate;
  if (i.tolerancePct !== undefined) patch.tolerancePct = i.tolerancePct;
  if (i.windowDays !== undefined) patch.windowDays = i.windowDays;
  if (i.status !== undefined) patch.status = i.status;
  return db().update(recurring).set(patch).where(eq(recurring.id, id)).returning().get()!;
}

export function deleteRecurring(uid: string, id: number) {
  const r = requireRecurring(uid, id);
  audit(uid, "recurring", id, "delete", `Deleted recurring “${r.name}”`);
  db().delete(recurring).where(eq(recurring.id, id)).run();
}

export function listRecurring(uid: string, opts: { status?: Recurring["status"][] } = {}): Recurring[] {
  const conds = [eq(recurring.userId, uid)];
  if (opts.status) conds.push(inArray(recurring.status, opts.status));
  return db().select().from(recurring).where(and(...conds)).orderBy(asc(recurring.nextDate)).all();
}

// ── Matching ───────────────────────────────────────────────────────────────

type TxRow = { id: number; date: string; amountCents: number; currency: string; description: string; accountId: number | null; recurringId: number | null };

function matches(r: Recurring, t: TxRow, fx: ReturnType<typeof fxConverter>): boolean {
  if (Math.sign(t.amountCents) !== Math.sign(r.amountCents)) return false;
  if (r.accountId && t.accountId !== r.accountId) return false;
  const label = t.description.toLowerCase().replace(/\s+/g, " ");
  if (!label.includes(r.pattern) && payeeKey(t.description) !== r.pattern) return false;
  const amount = t.currency === r.currency ? t.amountCents : fx.convertCents(t.amountCents, t.currency, r.currency, t.date);
  return Math.abs(amount - r.amountCents) <= Math.abs(r.amountCents) * (r.tolerancePct / 100) + 1;
}

/**
 * Link new payments to their recurring items and move each item on. An
 * expected payment that never came stays "late" until a later one arrives,
 * which marks it missed — statements are often imported weeks after the fact.
 */
export function reconcileRecurring(uid: string): { linked: number; priceChanges: { name: string; pct: number }[] } {
  const items = listRecurring(uid, { status: ["active"] });
  if (!items.length) return { linked: 0, priceChanges: [] };
  const t = today(uid);
  const fx = fxConverter();
  const earliest = items.reduce((m, r) => (addDays(r.nextDate, -r.windowDays) < m ? addDays(r.nextDate, -r.windowDays) : m), t);
  const pool: TxRow[] = db()
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      description: transactions.description,
      accountId: transactions.accountId,
      recurringId: transactions.recurringId,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, uid), isNull(transactions.recurringId), gte(transactions.date, earliest)))
    .orderBy(asc(transactions.date))
    .all();
  const used = new Set<number>();
  let linked = 0;
  const priceChanges: { name: string; pct: number }[] = [];
  const link = db().$client.prepare("UPDATE transactions SET recurring_id = ? WHERE id = ? AND recurring_id IS NULL");
  for (const r of items) {
    let next = r.nextDate;
    let amount = r.amountCents;
    let lastMatched = r.lastMatchedDate;
    let lastAmount = r.lastAmountCents;
    let change = r.lastChangePct;
    for (let guard = 0; guard < 400 && next <= addDays(t, r.windowDays); guard++) {
      const find = (on: string) =>
        pool.find((x) => !used.has(x.id) && x.date >= addDays(on, -r.windowDays) && x.date <= addDays(on, r.windowDays) && matches({ ...r, amountCents: amount }, x, fx));
      const hit = find(next);
      if (hit) {
        used.add(hit.id);
        link.run(r.id, hit.id);
        linked++;
        const paid = hit.currency === r.currency ? hit.amountCents : fx.convertCents(hit.amountCents, hit.currency, r.currency, hit.date);
        if (lastAmount !== null && paid !== lastAmount) {
          // In size, so a bill going from -15.99 to -17.99 is "+12.5%", a rise.
          change = Math.round(((Math.abs(paid) - Math.abs(lastAmount)) / Math.abs(lastAmount)) * 1000) / 10;
          if (Math.abs(change) >= 1) priceChanges.push({ name: r.name, pct: change });
        }
        lastAmount = paid;
        lastMatched = hit.date;
        amount = paid; // expect what was last paid: prices move
        next = advance(next, r.cadence);
      } else if (find(advance(next, r.cadence))) {
        // The next one arrived and this one never did: it was missed. Only a later
        // payment proves that — time alone doesn't, since statements arrive late.
        next = advance(next, r.cadence);
      } else break;
    }
    if (next !== r.nextDate || lastMatched !== r.lastMatchedDate) {
      db()
        .update(recurring)
        .set({ nextDate: next, amountCents: amount, lastMatchedDate: lastMatched, lastAmountCents: lastAmount, lastChangePct: change })
        .where(eq(recurring.id, r.id))
        .run();
    }
  }
  return { linked, priceChanges };
}

// ── Detection ──────────────────────────────────────────────────────────────

export interface RecurringSuggestion {
  name: string;
  pattern: string;
  accountId: number | null;
  categoryId: number | null;
  amount: number;
  currency: string;
  cadence: RecurringCadence;
  nextDate: string;
  occurrences: number;
  lastDate: string;
  tolerancePct: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function fitCadence(gaps: number[]): RecurringCadence | null {
  const m = median(gaps);
  const fits: [RecurringCadence, number, number][] = [
    ["weekly", 7, 2],
    ["biweekly", 14, 3],
    ["monthly", 30.44, 5],
    ["quarterly", 91.3, 12],
    ["yearly", 365.25, 25],
  ];
  for (const [c, days, tol] of fits) {
    if (Math.abs(m - days) > tol) continue;
    const regular = gaps.filter((g) => Math.abs(g - days) <= tol * 1.5).length;
    if (regular / gaps.length >= 0.7) return c;
  }
  return null;
}

/**
 * Look through the last 18 months for payments that repeat: the same payee
 * on the same account, at a regular interval, for a similar amount. Items
 * already tracked (or dismissed) are not suggested again.
 */
export function detectRecurring(uid: string): RecurringSuggestion[] {
  const t = today(uid);
  const since = DateTime.fromISO(t).minus({ months: 18 }).toISODate()!;
  const rows = db()
    .select({
      date: transactions.date,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      description: transactions.description,
      accountId: transactions.accountId,
      categoryId: transactions.categoryId,
      kind: categories.kind,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(eq(transactions.userId, uid), gte(transactions.date, since), lte(transactions.date, t)))
    .orderBy(asc(transactions.date))
    .all()
    .filter((r) => r.kind !== "transfer");
  const known = listRecurring(uid).map((r) => ({ pattern: r.pattern, accountId: r.accountId, sign: Math.sign(r.amountCents) }));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = payeeKey(r.description);
    if (key.length < 3) continue;
    const g = `${r.accountId ?? "-"}|${Math.sign(r.amountCents)}|${r.currency}|${key}`;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const out: RecurringSuggestion[] = [];
  for (const [g, list] of groups) {
    // One payment per day at most: two same-day card charges are one occurrence.
    const byDay = [...new Map(list.map((r) => [r.date, r])).values()];
    if (byDay.length < 3 && !(byDay.length === 2 && DateTime.fromISO(byDay[1].date).diff(DateTime.fromISO(byDay[0].date), "days").days > 330)) continue;
    const gaps = byDay.slice(1).map((r, i) => DateTime.fromISO(r.date).diff(DateTime.fromISO(byDay[i].date), "days").days);
    const cadence = fitCadence(gaps);
    if (!cadence) continue;
    const amounts = byDay.map((r) => r.amountCents);
    const mid = median(amounts);
    const spread = Math.max(...amounts.map((a) => Math.abs(a - mid) / Math.abs(mid)));
    if (spread > 0.35) continue; // groceries at one shop are not a bill
    const [, , currency, pattern] = g.split("|");
    const last = byDay.at(-1)!;
    if (known.some((k) => k.pattern === pattern && k.sign === Math.sign(mid) && (k.accountId ?? null) === (last.accountId ?? null))) continue;
    // Stale: nothing for two periods — it stopped.
    if (DateTime.fromISO(t).diff(DateTime.fromISO(last.date), "days").days > CADENCES[cadence].days * 2 + 7) continue;
    let next = advance(last.date, cadence);
    while (next < addDays(t, -5)) next = advance(next, cadence);
    out.push({
      name: titleCase(pattern),
      pattern,
      accountId: last.accountId,
      categoryId: last.categoryId,
      amount: Math.round(mid) / 100,
      currency,
      cadence,
      nextDate: next,
      occurrences: byDay.length,
      lastDate: last.date,
      tolerancePct: Math.min(30, Math.max(5, Math.ceil(spread * 150))),
    });
  }
  return out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** Store detection results as suggestions the user accepts or dismisses. */
export function suggestRecurring(uid: string): Recurring[] {
  const created: Recurring[] = [];
  for (const s of detectRecurring(uid)) {
    created.push(
      createRecurring(
        uid,
        { name: s.name, pattern: s.pattern, accountId: s.accountId, categoryId: s.categoryId, amount: s.amount, currency: s.currency, cadence: s.cadence, nextDate: s.nextDate, tolerancePct: s.tolerancePct, status: "suggested" },
        "detected",
      ),
    );
  }
  return created;
}

/** Record a payment that no statement will bring (cash rent…), linked to its item. */
export function recordOccurrence(uid: string, id: number, opts: { date?: string; amount?: number } = {}) {
  const r = requireRecurring(uid, id);
  const date = opts.date ?? r.nextDate;
  const row = db()
    .insert(transactions)
    .values({
      userId: uid,
      accountId: r.accountId,
      date,
      amountCents: opts.amount !== undefined ? toCents(opts.amount) : r.amountCents,
      currency: r.currency,
      description: r.name,
      categoryId: r.categoryId,
      recurringId: r.id,
      source: "recurring",
    })
    .returning()
    .get();
  db()
    .update(recurring)
    .set({ nextDate: date >= r.nextDate ? advance(r.nextDate, r.cadence) : r.nextDate, lastMatchedDate: date, lastAmountCents: row.amountCents })
    .where(eq(recurring.id, r.id))
    .run();
  return row;
}

// ── Views ──────────────────────────────────────────────────────────────────

export interface Occurrence {
  recurringId: number;
  name: string;
  date: string;
  amountCents: number;
  currency: string;
  baseCents: number;
  /** late = expected and its window has passed with nothing matched. */
  status: "late" | "due" | "upcoming";
}

/** Expected payments from today (plus any late one) for the next `days` days. */
export function upcoming(uid: string, days = 30): Occurrence[] {
  const t = today(uid);
  const end = addDays(t, days);
  const base = getSettings(uid).currency;
  const fx = fxConverter();
  const out: Occurrence[] = [];
  for (const r of listRecurring(uid, { status: ["active"] })) {
    for (let d = r.nextDate, i = 0; d <= end && i < 60; d = advance(d, r.cadence), i++) {
      const status = addDays(d, r.windowDays) < t ? "late" : d <= addDays(t, 3) ? "due" : "upcoming";
      out.push({ recurringId: r.id, name: r.name, date: d, amountCents: r.amountCents, currency: r.currency, baseCents: fx.convertCents(r.amountCents, r.currency, base, t), status });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Monthly equivalents in the base currency: what comes in and goes out on a schedule. */
export function recurringSummary(uid: string) {
  const base = getSettings(uid).currency;
  const fx = fxConverter();
  const t = today(uid);
  let income = 0;
  let fixed = 0;
  let subscriptions = 0;
  const subsCats = new Set(
    db()
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, uid), inArray(categories.name, ["Subscriptions", "Utilities & internet"])))
      .all()
      .map((c) => c.id),
  );
  for (const r of listRecurring(uid, { status: ["active"] })) {
    const monthly = Math.round((fx.convertCents(r.amountCents, r.currency, base, t) * CADENCES[r.cadence].perYear) / 12);
    if (monthly > 0) income += monthly;
    else {
      fixed += -monthly;
      if (r.categoryId && subsCats.has(r.categoryId)) subscriptions += -monthly;
    }
  }
  return { currency: base, monthlyIncomeCents: income, monthlyFixedCents: fixed, monthlySubscriptionsCents: subscriptions, freeCents: income - fixed };
}

/**
 * Cash forecast: today's cash (cash & savings accounts) plus every expected
 * payment, day by day. A floor under which it dips is the number to watch.
 */
export function forecastCash(uid: string, days = 90, startCents?: number) {
  const t = today(uid);
  const base = getSettings(uid).currency;
  const fx = fxConverter();
  let cash = startCents ?? netWorthOn(uid).byClassCents.cash;
  const occ = upcoming(uid, days);
  const points: { date: string; cents: number }[] = [];
  let low = { date: t, cents: cash };
  for (let d = t, i = 0; i <= days; d = addDays(d, 1), i++) {
    for (const o of occ) if (o.date === d || (i === 0 && o.status === "late")) cash += fx.convertCents(o.amountCents, o.currency, base, t);
    points.push({ date: d, cents: cash });
    if (cash < low.cents) low = { date: d, cents: cash };
  }
  return { currency: base, points, low };
}

/** Items that need a look: late (salary not in yet) or with a price change. */
export function recurringNudges(uid: string): { kind: "late" | "price"; text: string }[] {
  const out: { kind: "late" | "price"; text: string }[] = [];
  for (const o of upcoming(uid, 0).filter((x) => x.status === "late")) out.push({ kind: "late", text: `${o.name} was expected on ${o.date} and hasn't shown up` });
  const t = today(uid);
  for (const r of listRecurring(uid, { status: ["active"] })) {
    if (r.lastChangePct && Math.abs(r.lastChangePct) >= 1 && r.lastMatchedDate && r.lastMatchedDate >= addDays(t, -35))
      out.push({ kind: "price", text: `${r.name} ${r.lastChangePct > 0 ? "went up" : "went down"} ${Math.abs(r.lastChangePct)}%` });
  }
  return out;
}

