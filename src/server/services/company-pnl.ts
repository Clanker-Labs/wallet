import { db } from "@/server/db/client";
import type { FxConverter } from "./fx";

/**
 * A company's revenue and expenses per month, in the company's currency:
 * the transactions on its own accounts (income categories are revenue,
 * expense categories are costs, transfers are neither, uncategorized rows
 * count by sign), plus monthly figures entered by hand. DB-only so that the
 * account valuation can use it without an import cycle.
 */

export interface CompanyMonth {
  month: string;
  revenueCents: number;
  expensesCents: number;
  profitCents: number;
}

export function companyMonths(uid: string, company: { id: number; currency: string }, fx: FxConverter): CompanyMonth[] {
  const byMonth = new Map<string, { revenueCents: number; expensesCents: number }>();
  const add = (month: string, revenue: number, expenses: number) => {
    const m = byMonth.get(month) ?? { revenueCents: 0, expensesCents: 0 };
    m.revenueCents += revenue;
    m.expensesCents += expenses;
    byMonth.set(month, m);
  };
  const tx = db()
    .$client.prepare(
      `SELECT t.date AS date, t.currency AS currency, c.kind AS kind,
              sum(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END) AS inCents,
              sum(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END) AS outCents
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id AND a.company_id = @company AND a.user_id = @uid
       LEFT JOIN categories c ON c.id = t.category_id
       GROUP BY t.date, t.currency, c.kind`,
    )
    .all({ uid, company: company.id }) as { date: string; currency: string; kind: string | null; inCents: number; outCents: number }[];
  for (const r of tx) {
    if (r.kind === "transfer") continue;
    const inC = fx.convertCents(r.inCents, r.currency, company.currency, r.date);
    const outC = fx.convertCents(r.outCents, r.currency, company.currency, r.date);
    const month = r.date.slice(0, 7);
    if (r.kind === "income") add(month, inC - outC, 0);
    else if (r.kind === "expense") add(month, 0, outC - inC);
    else add(month, inC, outC);
  }
  const manual = db()
    .$client.prepare("SELECT month, revenue_cents AS revenueCents, expenses_cents AS expensesCents FROM company_financials WHERE company_id = ? AND user_id = ?")
    .all(company.id, uid) as { month: string; revenueCents: number; expensesCents: number }[];
  for (const m of manual) add(m.month, m.revenueCents, m.expensesCents);
  return [...byMonth]
    .map(([month, v]) => ({ month, ...v, profitCents: v.revenueCents - v.expensesCents }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Revenue, expenses and profit over the 12 months ending with `date`'s month. */
export function trailingTwelve(months: CompanyMonth[], date: string) {
  const end = date.slice(0, 7);
  const [y, m] = end.split("-").map(Number);
  const startDate = new Date(Date.UTC(y, m - 12, 1));
  const start = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, "0")}`;
  let revenue = 0;
  let expenses = 0;
  for (const x of months) {
    if (x.month < start || x.month > end) continue;
    revenue += x.revenueCents;
    expenses += x.expensesCents;
  }
  return { revenueCents: revenue, expensesCents: expenses, profitCents: revenue - expenses, from: start, to: end };
}
