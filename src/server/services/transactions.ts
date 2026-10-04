import { and, desc, eq, gte, inArray, isNull, like, lte, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, categories, transactions } from "@/server/db/schema";
import { toCents } from "@/lib/money";
import { isISODate } from "@/lib/dates";
import type { ImportRow } from "@/lib/csv-import";
import { listRules, matchCategory, upsertRule } from "./categories";
import { today } from "./settings";

export const transactionInputSchema = z.object({
  date: z.string().refine(isISODate, "Expected YYYY-MM-DD").optional(),
  amount: z.number().refine((n) => n !== 0, "Amount cannot be zero").describe("Signed: negative = spending, positive = income"),
  description: z.string().trim().min(1).max(300),
  categoryId: z.number().int().nullish(),
  accountId: z.number().int().nullish(),
  notes: z.string().max(1000).nullish(),
  source: z.string().default("manual"),
});
export type TransactionInput = z.input<typeof transactionInputSchema>;

export const transactionFilterSchema = z.object({
  from: z.string().refine(isISODate).optional(),
  to: z.string().refine(isISODate).optional(),
  accountId: z.number().int().optional(),
  /** A category id, or "none" for uncategorized. */
  categoryId: z.union([z.number().int(), z.literal("none")]).optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
});
export type TransactionFilter = z.input<typeof transactionFilterSchema>;

export function addTransaction(raw: TransactionInput) {
  const input = transactionInputSchema.parse(raw);
  const categoryId = input.categoryId === undefined ? matchCategory(input.description) : input.categoryId;
  return db()
    .insert(transactions)
    .values({
      date: input.date ?? today(),
      amountCents: toCents(input.amount),
      description: input.description,
      categoryId: categoryId ?? null,
      accountId: input.accountId ?? null,
      notes: input.notes ?? null,
      source: input.source,
    })
    .returning()
    .get();
}

export function updateTransaction(id: number, raw: Partial<TransactionInput>) {
  const input = transactionInputSchema.partial().parse(raw);
  const patch: Partial<typeof transactions.$inferInsert> = {};
  if (input.date !== undefined) patch.date = input.date;
  if (input.amount !== undefined) patch.amountCents = toCents(input.amount);
  if (input.description !== undefined) patch.description = input.description;
  if (input.categoryId !== undefined) patch.categoryId = input.categoryId ?? null;
  if (input.accountId !== undefined) patch.accountId = input.accountId ?? null;
  if (input.notes !== undefined) patch.notes = input.notes ?? null;
  return db().update(transactions).set(patch).where(eq(transactions.id, id)).returning().get();
}

export function deleteTransaction(id: number) {
  db().delete(transactions).where(eq(transactions.id, id)).run();
}

function filterWhere(f: z.output<typeof transactionFilterSchema>) {
  const where: SQL[] = [];
  if (f.from) where.push(gte(transactions.date, f.from));
  if (f.to) where.push(lte(transactions.date, f.to));
  if (f.accountId) where.push(eq(transactions.accountId, f.accountId));
  if (f.categoryId === "none") where.push(isNull(transactions.categoryId));
  else if (f.categoryId) where.push(eq(transactions.categoryId, f.categoryId));
  if (f.search) where.push(like(transactions.description, `%${f.search}%`));
  return where.length ? and(...where) : undefined;
}

export function listTransactions(raw: TransactionFilter = {}) {
  const f = transactionFilterSchema.parse(raw);
  const cond = filterWhere(f);

  const rows = db()
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      description: transactions.description,
      notes: transactions.notes,
      source: transactions.source,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryIcon: categories.icon,
      categoryKind: categories.kind,
      accountId: transactions.accountId,
      accountName: accounts.name,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(cond)
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(f.limit)
    .offset(f.offset)
    .all();
  const total = db().select({ n: sql<number>`count(*)` }).from(transactions).where(cond).get()?.n ?? 0;
  return { rows, total };
}

/**
 * Assign a category to transactions; optionally remember it as a rule and
 * apply the rule to other uncategorized transactions.
 */
export function categorizeTransactions(ids: number[], categoryId: number | null, rulePattern?: string) {
  if (ids.length) {
    db().update(transactions).set({ categoryId }).where(inArray(transactions.id, ids)).run();
  }
  let ruleApplied = 0;
  if (rulePattern && categoryId) {
    upsertRule(rulePattern, categoryId);
    const p = rulePattern.trim().toLowerCase();
    ruleApplied = db()
      .update(transactions)
      .set({ categoryId })
      .where(and(isNull(transactions.categoryId), sql`lower(${transactions.description}) like ${`%${p}%`}`))
      .run().changes;
  }
  return { updated: ids.length, ruleApplied };
}

/** Count, money in and money out for the same filters as `listTransactions`. */
export function transactionTotals(raw: TransactionFilter = {}) {
  const f = transactionFilterSchema.parse(raw);
  const row = db()
    .select({
      count: sql<number>`count(*)`,
      inCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} end), 0)`,
      outCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then ${transactions.amountCents} end), 0)`,
    })
    .from(transactions)
    .where(filterWhere(f))
    .get();
  return { count: row?.count ?? 0, inCents: row?.inCents ?? 0, outCents: row?.outCents ?? 0 };
}

/** First month with a transaction (YYYY-MM). */
export function firstTransactionMonth(): string | null {
  const row = db().select({ d: sql<string | null>`min(${transactions.date})` }).from(transactions).get();
  return row?.d ? row.d.slice(0, 7) : null;
}

export function countUncategorized(): number {
  return (
    db()
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(isNull(transactions.categoryId))
      .get()?.n ?? 0
  );
}

function importHash(accountId: number | null, row: ImportRow, occurrence: number) {
  const key = [accountId ?? "-", row.date, toCents(row.amount), row.description.toLowerCase(), occurrence].join("|");
  return createHash("sha1").update(key).digest("hex");
}

/** Insert imported rows, skipping ones already imported (same file twice is a no-op). */
export function importTransactions(rows: ImportRow[], accountId: number | null) {
  const rules = listRules();
  const seen = new Map<string, number>();
  const stmt = db().$client.prepare(
    `INSERT OR IGNORE INTO transactions (account_id, date, amount_cents, description, category_id, import_hash, source)
     VALUES (?, ?, ?, ?, ?, ?, 'csv')`,
  );
  let inserted = 0;
  let categorized = 0;
  db().$client.transaction(() => {
    for (const row of rows) {
      const base = `${row.date}|${toCents(row.amount)}|${row.description.toLowerCase()}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const categoryId = matchCategory(row.description, rules);
      const res = stmt.run(
        accountId,
        row.date,
        toCents(row.amount),
        row.description,
        categoryId,
        importHash(accountId, row, occurrence),
      );
      if (res.changes) {
        inserted++;
        if (categoryId) categorized++;
      }
    }
  })();
  return { inserted, duplicates: rows.length - inserted, categorized };
}
