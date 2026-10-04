import { and, eq, gte, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "@/server/db/client";
import { budgets, categories, transactions } from "@/server/db/schema";
import { addMonths, monthBounds, monthRange } from "@/lib/dates";
import { toCents } from "@/lib/money";
import { today } from "./settings";

export type BudgetLineStatus = "ok" | "ahead_of_pace" | "over" | "unbudgeted";

export interface BudgetLine {
  categoryId: number | null;
  name: string;
  icon: string | null;
  budgetCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  pct: number | null;
  status: BudgetLineStatus;
}

export interface BudgetStatus {
  month: string;
  /** Fraction of the month elapsed (1 for past months). */
  elapsed: number;
  incomeCents: number;
  expensesCents: number;
  netCents: number;
  savingsRatePct: number | null;
  totalBudgetCents: number;
  totalSpentInBudgetsCents: number;
  lines: BudgetLine[];
}

export function listBudgets() {
  return db()
    .select({
      id: budgets.id,
      categoryId: budgets.categoryId,
      amountCents: budgets.amountCents,
      name: categories.name,
      icon: categories.icon,
    })
    .from(budgets)
    .innerJoin(categories, eq(categories.id, budgets.categoryId))
    .all();
}

/** Set a monthly budget for a category. 0 or null removes it. */
export function setBudget(categoryId: number, amount: number | null) {
  if (!amount || amount <= 0) {
    db().delete(budgets).where(eq(budgets.categoryId, categoryId)).run();
    return null;
  }
  return db()
    .insert(budgets)
    .values({ categoryId, amountCents: toCents(amount) })
    .onConflictDoUpdate({ target: budgets.categoryId, set: { amountCents: toCents(amount) } })
    .returning()
    .get();
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

function totalsByCategory(from: string, to: string): CategoryTotal[] {
  return db()
    .select({
      categoryId: transactions.categoryId,
      kind: categories.kind,
      name: categories.name,
      icon: categories.icon,
      inCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`,
      outCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(gte(transactions.date, from), lte(transactions.date, to)))
    .groupBy(transactions.categoryId)
    .all();
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

export function budgetStatus(month = today().slice(0, 7)): BudgetStatus {
  const { start, end } = monthBounds(month);
  const t = today();
  const daysInMonth = DateTime.fromISO(start).daysInMonth ?? 30;
  const elapsed =
    t > end ? 1 : t < start ? 0 : DateTime.fromISO(t).day / daysInMonth;

  const rows = totalsByCategory(start, end);
  const { income, expenses, spentByCategory } = summarize(rows);
  const budgetRows = listBudgets();
  const meta = new Map(rows.map((r) => [r.categoryId, r]));

  const lines: BudgetLine[] = [];
  for (const b of budgetRows) {
    const spent = spentByCategory.get(b.categoryId) ?? 0;
    const pct = (spent / b.amountCents) * 100;
    // One fixed charge early in the month (a transit pass, a subscription) isn't "spending fast".
    const ahead = pct / 100 > elapsed + 0.1 && (meta.get(b.categoryId)?.count ?? 0) > 1;
    const status: BudgetLineStatus = spent > b.amountCents ? "over" : ahead ? "ahead_of_pace" : "ok";
    lines.push({
      categoryId: b.categoryId,
      name: b.name,
      icon: b.icon,
      budgetCents: b.amountCents,
      spentCents: spent,
      remainingCents: b.amountCents - spent,
      pct,
      status,
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
      budgetCents: null,
      spentCents: spent,
      remainingCents: null,
      pct: null,
      status: "unbudgeted",
    });
  }
  const order: Record<BudgetLineStatus, number> = { over: 0, ahead_of_pace: 1, ok: 2, unbudgeted: 3 };
  lines.sort((a, b) => order[a.status] - order[b.status] || b.spentCents - a.spentCents);

  const totalBudgetCents = budgetRows.reduce((s, b) => s + b.amountCents, 0);
  const totalSpentInBudgetsCents = lines
    .filter((l) => l.budgetCents !== null)
    .reduce((s, l) => s + l.spentCents, 0);
  return {
    month,
    elapsed,
    incomeCents: income,
    expensesCents: expenses,
    netCents: income - expenses,
    savingsRatePct: income > 0 ? ((income - expenses) / income) * 100 : null,
    totalBudgetCents,
    totalSpentInBudgetsCents,
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

/** Income vs expenses per month, oldest first, including the current month. */
export function cashflow(months = 12): CashflowMonth[] {
  const thisMonth = today().slice(0, 7);
  const list = monthRange(addMonths(thisMonth, -(months - 1)), thisMonth);
  const from = monthBounds(list[0]).start;
  const to = monthBounds(thisMonth).end;
  const rows = db()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      categoryId: transactions.categoryId,
      kind: categories.kind,
      name: categories.name,
      icon: categories.icon,
      inCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`,
      outCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(gte(transactions.date, from), lte(transactions.date, to)))
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, transactions.categoryId)
    .all();
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

/** Spending per expense category over a date range, largest first. */
export function spendingByCategory(from: string, to: string) {
  const rows = totalsByCategory(from, to);
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
export function averageMonthlySavings(months = 6): { netCents: number; incomeCents: number; expensesCents: number; monthsWithData: number } {
  const flows = cashflow(months + 1).slice(0, -1).filter((m) => m.incomeCents || m.expensesCents);
  if (!flows.length) return { netCents: 0, incomeCents: 0, expensesCents: 0, monthsWithData: 0 };
  const avg = (f: (m: CashflowMonth) => number) => Math.round(flows.reduce((s, m) => s + f(m), 0) / flows.length);
  return {
    netCents: avg((m) => m.netCents),
    incomeCents: avg((m) => m.incomeCents),
    expensesCents: avg((m) => m.expensesCents),
    monthsWithData: flows.length,
  };
}
