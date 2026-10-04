import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  accounts,
  agentConversations,
  balanceSnapshots,
  budgets,
  categories,
  categoryRules,
  holdings,
  reminders,
  settings,
  simulations,
  transactions,
  users,
} from "@/server/db/schema";

/**
 * Export of one user's data (every table except raw agent transcripts and
 * uploaded files), plus counts for the settings page.
 */
export function exportAll(uid: string) {
  const d = db();
  const accountIds = d
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, uid))
    .all()
    .map((a) => a.id);
  return {
    app: "wallet",
    format: 2,
    exportedAt: new Date().toISOString(),
    user: d.select({ id: users.id, name: users.name, createdAt: users.createdAt }).from(users).where(eq(users.id, uid)).get(),
    tables: {
      accounts: d.select().from(accounts).where(eq(accounts.userId, uid)).all(),
      balance_snapshots: accountIds.length
        ? d.select().from(balanceSnapshots).where(inArray(balanceSnapshots.accountId, accountIds)).all()
        : [],
      holdings: d.select().from(holdings).where(eq(holdings.userId, uid)).all(),
      categories: d.select().from(categories).where(eq(categories.userId, uid)).all(),
      category_rules: d.select().from(categoryRules).where(eq(categoryRules.userId, uid)).all(),
      transactions: d.select().from(transactions).where(eq(transactions.userId, uid)).all(),
      budgets: d.select().from(budgets).where(eq(budgets.userId, uid)).all(),
      reminders: d.select().from(reminders).where(eq(reminders.userId, uid)).all(),
      simulations: d.select().from(simulations).where(eq(simulations.userId, uid)).all(),
      agent_conversations: d.select().from(agentConversations).where(eq(agentConversations.userId, uid)).all(),
      settings: d.select().from(settings).where(eq(settings.userId, uid)).all(),
    },
  };
}

/** Row counts of the user's main tables. */
export function dataCounts(uid: string) {
  const count = (table: "accounts" | "transactions" | "categories" | "reminders" | "simulations" | "holdings") =>
    (db().$client.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(uid) as { n: number }).n;
  const snapshots = (
    db()
      .$client.prepare(
        "SELECT COUNT(*) AS n FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?",
      )
      .get(uid) as { n: number }
  ).n;
  return {
    accounts: count("accounts"),
    balance_snapshots: snapshots,
    holdings: count("holdings"),
    transactions: count("transactions"),
    categories: count("categories"),
    reminders: count("reminders"),
    simulations: count("simulations"),
  };
}

/** How many transactions each category holds (for delete warnings). */
export function transactionCountsByCategory(uid: string): Record<number, number> {
  const rows = db()
    .select({ id: transactions.categoryId, n: sql<number>`count(*)` })
    .from(transactions)
    .where(eq(transactions.userId, uid))
    .groupBy(transactions.categoryId)
    .all();
  const out: Record<number, number> = {};
  for (const r of rows) if (r.id !== null) out[r.id] = r.n;
  return out;
}

export function uncategorizedCount(uid: string): number {
  return (
    db()
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(and(eq(transactions.userId, uid), isNull(transactions.categoryId)))
      .get()?.n ?? 0
  );
}
