import { isNull, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  accounts,
  agentConversations,
  balanceSnapshots,
  budgets,
  categories,
  categoryRules,
  reminders,
  settings,
  simulations,
  transactions,
} from "@/server/db/schema";

/**
 * Full data export (every table except the raw agent transcript) and a few
 * counts for the settings page.
 */

export function exportAll() {
  const d = db();
  return {
    app: "wallet",
    format: 1,
    exportedAt: new Date().toISOString(),
    tables: {
      accounts: d.select().from(accounts).all(),
      balance_snapshots: d.select().from(balanceSnapshots).all(),
      categories: d.select().from(categories).all(),
      category_rules: d.select().from(categoryRules).all(),
      transactions: d.select().from(transactions).all(),
      budgets: d.select().from(budgets).all(),
      reminders: d.select().from(reminders).all(),
      simulations: d.select().from(simulations).all(),
      agent_conversations: d.select().from(agentConversations).all(),
      settings: d.select().from(settings).all(),
    },
  };
}

/** Row counts of the main tables. */
export function dataCounts() {
  const tables = ["accounts", "balance_snapshots", "transactions", "categories", "reminders", "simulations"] as const;
  const client = db().$client;
  return Object.fromEntries(
    tables.map((t) => [t, (client.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
  ) as Record<(typeof tables)[number], number>;
}

/** How many transactions each category holds (for delete warnings). */
export function transactionCountsByCategory(): Record<number, number> {
  const rows = db()
    .select({ id: transactions.categoryId, n: sql<number>`count(*)` })
    .from(transactions)
    .groupBy(transactions.categoryId)
    .all();
  const out: Record<number, number> = {};
  for (const r of rows) if (r.id !== null) out[r.id] = r.n;
  return out;
}

export function uncategorizedCount(): number {
  return db().select({ n: sql<number>`count(*)` }).from(transactions).where(isNull(transactions.categoryId)).get()?.n ?? 0;
}
