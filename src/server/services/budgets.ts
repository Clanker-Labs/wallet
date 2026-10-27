import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "@/server/db/client";
import { budgets, categories } from "@/server/db/schema";
import { addMonths, monthBounds, monthRange } from "@/lib/dates";
import { toCents } from "@/lib/money";
import { requireCategory } from "./categories";
import { fxConverter, type FxConverter } from "./fx";
import { isCurrencyCode, normalizeCurrency } from "@/lib/domain";
import { getSettings, today } from "./settings";
import { audit } from "./audit";

export type BudgetLineStatus = "ok" | "ahead_of_pace" | "over" | "unbudgeted";

export interface BudgetLine {
  categoryId: number | null;
  name: string;
  icon: string | null;
  /** The envelope's own currency; budget/spent/remaining below are in it. */
  currency: string;
  budgetCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  pct: number | null;
  status: BudgetLineStatus;
  /** Budget and spending in the page's display currency, for totals. */
  displayBudgetCents: number | null;
  displaySpentCents: number;
  /** What was actually spent, per transaction currency, when it isn't all in the envelope's. */
  spentByCurrency: { currency: string; cents: number }[];
}

export interface BudgetStatus {
  month: string;
  /** Display currency: income, expenses, totals and display… fields are in it. */
  currency: string;
  /** Fraction of the month elapsed (1 for past months). */
  elapsed: number;
  incomeCents: number;
  expensesCents: number;
  netCents: number;
  savingsRatePct: number | null;
  totalBudgetCents: number;
  totalSpentInBudgetsCents: number;
  /** Currencies used this month or by an envelope (for the display switcher). */
  currencies: string[];
  /** Currencies with no exchange rate (their amounts count as 0 in conversions). */
  missingFx: string[];
  lines: BudgetLine[];
}

export function listBudgets(uid: string) {
  const base = getSettings(uid).currency;
  return db()
    .select({
      id: budgets.id,
      categoryId: budgets.categoryId,
      amountCents: budgets.amountCents,
      currency: budgets.currency,
      name: categories.name,
      icon: categories.icon,
    })
    .from(budgets)
    .innerJoin(categories, eq(categories.id, budgets.categoryId))
    .where(eq(budgets.userId, uid))
    .all()
    .map((b) => ({ ...b, currency: b.currency ?? base }));
}

/**
 * Set a category's monthly budget. `currency` sets the envelope's currency
 * (default: keep the current one, or the base currency for a new envelope).
 * 0 or null removes it.
 */
export function setBudget(uid: string, categoryId: number, amount: number | null, currency?: string | null) {
  requireCategory(uid, categoryId);
  if (!amount || amount <= 0) {
    db().delete(budgets).where(and(eq(budgets.userId, uid), eq(budgets.categoryId, categoryId))).run();
    audit(uid, "budget", categoryId, "delete", `Removed the budget of category ${categoryId}`);
    return null;
  }
  audit(uid, "budget", categoryId, "set", `Budget of category ${categoryId}: ${amount}${currency ? ` ${currency}` : ""} a month`);
  const base = getSettings(uid).currency;
  let cur: string | null | undefined = currency === undefined ? undefined : currency ? normalizeCurrency(currency) : null;
  if (cur && !isCurrencyCode(cur)) throw new Error(`Unknown currency "${currency}"`);
  if (cur === base) cur = null; // stored as "follow the base currency"
  const values = { userId: uid, categoryId, amountCents: toCents(amount), currency: cur ?? null };
  return db()
    .insert(budgets)
    .values(values)
    .onConflictDoUpdate({
      target: budgets.categoryId,
      set: cur === undefined ? { amountCents: values.amountCents } : { amountCents: values.amountCents, currency: values.currency },
    })
    .returning()
    .get();
}

interface RawTotal {
  date: string;
  currency: string;
  categoryId: number | null;
  kind: "income" | "expense" | "transfer" | null;
  name: string | null;
  icon: string | null;
  inCents: number;
  outCents: number;
  count: number;
}

interface CategoryTotal {
  categoryId: number | null;
  kind: "income" | "expense" | "transfer" | null;
  name: string | null;
  icon: string | null;
  inCents: number;
  outCents: number;
  count: number;
}

/**
 * Money in / out per category, transaction currency and day, unconverted.
 * A split payment contributes one row per part, each under its own category.
 */
function rawTotals(uid: string, from: string, to: string): RawTotal[] {
  return db()
    .$client.prepare(
      `SELECT t.date AS date, t.currency AS currency, c.id AS categoryId, c.kind AS kind, c.name AS name, c.icon AS icon,
              coalesce(sum(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END), 0) AS inCents,
              coalesce(sum(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END), 0) AS outCents,
              count(DISTINCT t.id) AS count
       FROM transactions t
       JOIN (
         SELECT t2.id AS tx, t2.category_id AS cat, t2.amount_cents AS amount FROM transactions t2
           WHERE t2.user_id = @uid AND t2.date BETWEEN @from AND @to
             AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t2.id)
         UNION ALL
         SELECT s.transaction_id, s.category_id, s.amount_cents FROM transaction_splits s
           JOIN transactions t3 ON t3.id = s.transaction_id
           WHERE t3.user_id = @uid AND t3.date BETWEEN @from AND @to
       ) p ON p.tx = t.id
       LEFT JOIN categories c ON c.id = p.cat
       GROUP BY c.id, t.currency, t.date`,
    )
    .all({ uid, from, to }) as RawTotal[];
}

/**
 * Money in / out per category (and month), converted to `target` at each
 * transaction's date — so a June expense uses June's rate, not today's.
 */
function categoryTotals(rows: RawTotal[], target: string, fx: FxConverter): (CategoryTotal & { month: string })[] {
  const merged = new Map<string, CategoryTotal & { month: string }>();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    const key = `${month}|${r.categoryId ?? "none"}`;
    const acc = merged.get(key) ?? { month, categoryId: r.categoryId, kind: r.kind, name: r.name, icon: r.icon, inCents: 0, outCents: 0, count: 0 };
    acc.inCents += fx.convertCents(r.inCents, r.currency, target, r.date);
    acc.outCents += fx.convertCents(r.outCents, r.currency, target, r.date);
    acc.count += r.count;
    merged.set(key, acc);
  }
  return [...merged.values()];
}

/** Per-category totals over a range (months merged). */
function totalsByCategory(rows: RawTotal[], target: string, fx: FxConverter): CategoryTotal[] {
  const merged = new Map<number | null, CategoryTotal>();
  for (const r of categoryTotals(rows, target, fx)) {
    const acc = merged.get(r.categoryId) ?? { ...r, inCents: 0, outCents: 0, count: 0 };
    acc.inCents += r.inCents;
    acc.outCents += r.outCents;
    acc.count += r.count;
    merged.set(r.categoryId, acc);
  }
  return [...merged.values()];
}

/**
 * Income/expense split. Transfers are ignored. Uncategorized rows count by
 * sign. Refunds inside an expense category reduce that category's spending.
 */
function summarize(rows: Omit<CategoryTotal, "count">[]) {
  let income = 0;
  let expenses = 0;
  const spentByCategory = new Map<number | null, number>();
  for (const r of rows) {
    if (r.kind === "transfer") continue;
    if (r.kind === "income") income += r.inCents - r.outCents;
    else if (r.kind === "expense") {
      const spent = r.outCents - r.inCents;
      expenses += spent;
      spentByCategory.set(r.categoryId, spent);
    } else {
      income += r.inCents;
      expenses += r.outCents;
      if (r.outCents) spentByCategory.set(null, r.outCents);
    }
  }
  return { income, expenses, spentByCategory };
}

/** Net spending of one category per transaction currency (refunds net out). */
function spentByCurrency(rows: RawTotal[], categoryId: number | null): { currency: string; cents: number }[] {
  const by = new Map<string, number>();
  for (const r of rows) {
    if (r.categoryId !== categoryId || r.kind === "transfer" || r.kind === "income") continue;
    const net = r.kind === "expense" ? r.outCents - r.inCents : r.outCents;
    by.set(r.currency, (by.get(r.currency) ?? 0) + net);
  }
  return [...by].filter(([, c]) => c !== 0).map(([currency, cents]) => ({ currency, cents })).sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * A month's budget. Each envelope is tracked in its own currency (spending in
 * other currencies converted at each transaction's date); income, expenses
 * and the totals are shown in `opts.currency` (default: the base currency).
 */
export function budgetStatus(uid: string, month = today(uid).slice(0, 7), opts: { currency?: string } = {}): BudgetStatus {
  const { start, end } = monthBounds(month);
  const t = today(uid);
  const base = getSettings(uid).currency;
  const display = opts.currency ? normalizeCurrency(opts.currency) : base;
  const fx = fxConverter();
  const daysInMonth = DateTime.fromISO(start).daysInMonth ?? 30;
  const elapsed =
    t > end ? 1 : t < start ? 0 : DateTime.fromISO(t).day / daysInMonth;
  // Envelopes convert their budget to the display currency at month end (or today).
  const rateDate = t < end ? t : end;

  const raw = rawTotals(uid, start, end);
  const rows = totalsByCategory(raw, display, fx);
  const { income, expenses, spentByCategory } = summarize(rows);
  const budgetRows = listBudgets(uid);
  const meta = new Map(rows.map((r) => [r.categoryId, r]));
  const inCurrency = new Map<string, Map<number | null, number>>();
  const spentIn = (currency: string, categoryId: number | null) => {
    if (currency === display) return spentByCategory.get(categoryId) ?? 0;
    if (!inCurrency.has(currency)) inCurrency.set(currency, summarize(totalsByCategory(raw, currency, fx)).spentByCategory);
    return inCurrency.get(currency)!.get(categoryId) ?? 0;
  };
  const breakdown = (categoryId: number | null, currency: string) => {
    const list = spentByCurrency(raw, categoryId);
    return list.length === 1 && list[0].currency === currency ? [] : list;
  };

  const lines: BudgetLine[] = [];
  for (const b of budgetRows) {
    const spent = spentIn(b.currency, b.categoryId);
    const pct = (spent / b.amountCents) * 100;
    // One fixed charge early in the month (a transit pass, a subscription) isn't "spending fast".
    const ahead = pct / 100 > elapsed + 0.1 && (meta.get(b.categoryId)?.count ?? 0) > 1;
    const status: BudgetLineStatus = spent > b.amountCents ? "over" : ahead ? "ahead_of_pace" : "ok";
    lines.push({
      categoryId: b.categoryId,
      name: b.name,
      icon: b.icon,
      currency: b.currency,
      budgetCents: b.amountCents,
      spentCents: spent,
      remainingCents: b.amountCents - spent,
      pct,
      status,
      displayBudgetCents: fx.convertCents(b.amountCents, b.currency, display, rateDate),
      displaySpentCents: spentByCategory.get(b.categoryId) ?? 0,
      spentByCurrency: breakdown(b.categoryId, b.currency),
    });
  }
  const budgeted = new Set(budgetRows.map((b) => b.categoryId));
  for (const [categoryId, spent] of spentByCategory) {
    if (categoryId !== null && budgeted.has(categoryId)) continue;
    if (spent <= 0) continue;
    const m = meta.get(categoryId);
    lines.push({
      categoryId,
      name: categoryId === null ? "Uncategorized" : (m?.name ?? "?"),
      icon: categoryId === null ? "❔" : (m?.icon ?? null),
      currency: display,
      budgetCents: null,
      spentCents: spent,
      remainingCents: null,
      pct: null,
      status: "unbudgeted",
      displayBudgetCents: null,
      displaySpentCents: spent,
      spentByCurrency: breakdown(categoryId, display),
    });
  }
  const order: Record<BudgetLineStatus, number> = { over: 0, ahead_of_pace: 1, ok: 2, unbudgeted: 3 };
  lines.sort((a, b) => order[a.status] - order[b.status] || b.displaySpentCents - a.displaySpentCents);

  const budgetedLines = lines.filter((l) => l.budgetCents !== null);
  const currencies = [...new Set([base, display, ...raw.map((r) => r.currency), ...budgetRows.map((b) => b.currency)])].sort();
  return {
    month,
    currency: display,
    elapsed,
    incomeCents: income,
    expensesCents: expenses,
    netCents: income - expenses,
    savingsRatePct: income > 0 ? ((income - expenses) / income) * 100 : null,
    totalBudgetCents: budgetedLines.reduce((s, l) => s + (l.displayBudgetCents ?? 0), 0),
    totalSpentInBudgetsCents: budgetedLines.reduce((s, l) => s + l.displaySpentCents, 0),
    currencies,
    missingFx: [...fx.missing],
    lines,
  };
}

export interface CashflowMonth {
  month: string;
  incomeCents: number;
  expensesCents: number;
  netCents: number;
  savingsRatePct: number | null;
}

/** Income vs expenses per month (base currency, or `currency`), oldest first, including the current month. */
export function cashflow(uid: string, months = 12, currency?: string): CashflowMonth[] {
  const thisMonth = today(uid).slice(0, 7);
  const list = monthRange(addMonths(thisMonth, -(months - 1)), thisMonth);
  const rows = categoryTotals(
    rawTotals(uid, monthBounds(list[0]).start, monthBounds(thisMonth).end),
    currency ? normalizeCurrency(currency) : getSettings(uid).currency,
    fxConverter(),
  );
  return list.map((month) => {
    const { income, expenses } = summarize(rows.filter((r) => r.month === month));
    return {
      month,
      incomeCents: income,
      expensesCents: expenses,
      netCents: income - expenses,
      savingsRatePct: income > 0 ? ((income - expenses) / income) * 100 : null,
    };
  });
}

/** Spending per expense category over a date range (base currency, or `currency`), largest first. */
export function spendingByCategory(uid: string, from: string, to: string, currency?: string) {
  const rows = totalsByCategory(rawTotals(uid, from, to), currency ? normalizeCurrency(currency) : getSettings(uid).currency, fxConverter());
  const { spentByCategory } = summarize(rows);
  const meta = new Map(rows.map((r) => [r.categoryId, r]));
  const total = [...spentByCategory.values()].reduce((a, b) => a + Math.max(0, b), 0);
  return [...spentByCategory.entries()]
    .filter(([, v]) => v > 0)
    .map(([categoryId, spentCents]) => ({
      categoryId,
      name: categoryId === null ? "Uncategorized" : (meta.get(categoryId)?.name ?? "?"),
      icon: categoryId === null ? "❔" : (meta.get(categoryId)?.icon ?? null),
      spentCents,
      sharePct: total ? (spentCents / total) * 100 : 0,
    }))
    .sort((a, b) => b.spentCents - a.spentCents);
}

/** Average monthly net savings over the last `months` complete months. */
export function averageMonthlySavings(
  uid: string,
  months = 6,
): { netCents: number; incomeCents: number; expensesCents: number; monthsWithData: number } {
  const flows = cashflow(uid, months + 1).slice(0, -1).filter((m) => m.incomeCents || m.expensesCents);
  if (!flows.length) return { netCents: 0, incomeCents: 0, expensesCents: 0, monthsWithData: 0 };
  const avg = (f: (m: CashflowMonth) => number) => Math.round(flows.reduce((s, m) => s + f(m), 0) / flows.length);
  return {
    netCents: avg((m) => m.netCents),
    incomeCents: avg((m) => m.incomeCents),
    expensesCents: avg((m) => m.expensesCents),
    monthsWithData: flows.length,
  };
}
