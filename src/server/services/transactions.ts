import { and, desc, eq, gte, inArray, isNull, like, lte, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, categories, transactions } from "@/server/db/schema";
import { toCents } from "@/lib/money";
import { isISODate } from "@/lib/dates";
import type { ImportRow } from "@/lib/csv-import";
import { currencySchema, getAccountRow } from "./accounts";
import { listRules, matchCategory, normalizePattern, requireCategory, upsertRule } from "./categories";
import { fxConverter } from "./fx";
import { getSettings, today } from "./settings";

export const transactionInputSchema = z.object({
  date: z.string().refine(isISODate, "Expected YYYY-MM-DD").optional(),
  amount: z.number().refine((n) => n !== 0, "Amount cannot be zero").describe("Signed: negative = spending, positive = income"),
  currency: currencySchema.optional().describe("Defaults to the account's currency, else your base currency"),
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

function defaultCurrency(uid: string, accountId: number | null | undefined): string {
  return accountId ? getAccountRow(uid, accountId).currency : getSettings(uid).currency;
}

function getTransactionRow(uid: string, id: number) {
  const row = db()
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, uid)))
    .get();
  if (!row) throw new Error(`Transaction ${id} not found`);
  return row;
}

export function addTransaction(uid: string, raw: TransactionInput) {
  const input = transactionInputSchema.parse(raw);
  if (input.categoryId) requireCategory(uid, input.categoryId);
  const categoryId =
    input.categoryId === undefined ? matchCategory(input.description, listRules(uid)) : input.categoryId;
  return db()
    .insert(transactions)
    .values({
      userId: uid,
      date: input.date ?? today(uid),
      amountCents: toCents(input.amount),
      currency: input.currency ?? defaultCurrency(uid, input.accountId),
      description: input.description,
      categoryId: categoryId ?? null,
      accountId: input.accountId ?? null,
      notes: input.notes ?? null,
      source: input.source,
    })
    .returning()
    .get();
}

export function updateTransaction(uid: string, id: number, raw: Partial<TransactionInput>) {
  getTransactionRow(uid, id);
  const input = transactionInputSchema.partial().parse(raw);
  const patch: Partial<typeof transactions.$inferInsert> = {};
  if (input.date !== undefined) patch.date = input.date;
  if (input.amount !== undefined) patch.amountCents = toCents(input.amount);
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.description !== undefined) patch.description = input.description;
  if (input.categoryId !== undefined) {
    if (input.categoryId) requireCategory(uid, input.categoryId);
    patch.categoryId = input.categoryId ?? null;
  }
  if (input.accountId !== undefined) {
    if (input.accountId) getAccountRow(uid, input.accountId);
    patch.accountId = input.accountId ?? null;
  }
  if (input.notes !== undefined) patch.notes = input.notes ?? null;
  return db().update(transactions).set(patch).where(eq(transactions.id, id)).returning().get();
}

export function deleteTransaction(uid: string, id: number) {
  db()
    .delete(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, uid)))
    .run();
}

function filterWhere(uid: string, f: z.output<typeof transactionFilterSchema>) {
  const where: SQL[] = [eq(transactions.userId, uid)];
  if (f.from) where.push(gte(transactions.date, f.from));
  if (f.to) where.push(lte(transactions.date, f.to));
  if (f.accountId) where.push(eq(transactions.accountId, f.accountId));
  if (f.categoryId === "none") where.push(isNull(transactions.categoryId));
  else if (f.categoryId) where.push(eq(transactions.categoryId, f.categoryId));
  if (f.search) where.push(like(transactions.description, `%${f.search}%`));
  return and(...where);
}

export function listTransactions(uid: string, raw: TransactionFilter = {}) {
  const f = transactionFilterSchema.parse(raw);
  const cond = filterWhere(uid, f);
  const base = getSettings(uid).currency;
  const fx = fxConverter();
  const rows = db()
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
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
    .all()
    .map((r) => ({ ...r, baseAmountCents: fx.convertCents(r.amountCents, r.currency, base, r.date) }));
  const total = db().select({ n: sql<number>`count(*)` }).from(transactions).where(cond).get()?.n ?? 0;
  return { rows, total, currency: base };
}

/**
 * Assign a category to transactions; optionally remember it as a rule and
 * apply the rule to other uncategorized transactions.
 */
export function categorizeTransactions(uid: string, ids: number[], categoryId: number | null, rulePattern?: string) {
  if (categoryId) requireCategory(uid, categoryId);
  let updated = 0;
  if (ids.length) {
    updated = db()
      .update(transactions)
      .set({ categoryId })
      .where(and(eq(transactions.userId, uid), inArray(transactions.id, ids)))
      .run().changes;
  }
  let ruleApplied = 0;
  if (rulePattern && categoryId) {
    upsertRule(uid, rulePattern, categoryId);
    const p = normalizePattern(rulePattern);
    ruleApplied = db()
      .update(transactions)
      .set({ categoryId })
      .where(
        and(
          eq(transactions.userId, uid),
          isNull(transactions.categoryId),
          sql`lower(${transactions.description}) like ${`%${p}%`}`,
        ),
      )
      .run().changes;
  }
  return { updated, ruleApplied };
}

/** Count, money in and money out (base currency) for the same filters as `listTransactions`. */
export function transactionTotals(uid: string, raw: TransactionFilter = {}) {
  const f = transactionFilterSchema.parse(raw);
  const base = getSettings(uid).currency;
  const fx = fxConverter();
  const groups = db()
    .select({
      currency: transactions.currency,
      date: transactions.date,
      count: sql<number>`count(*)`,
      inCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} end), 0)`,
      outCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then ${transactions.amountCents} end), 0)`,
    })
    .from(transactions)
    .where(filterWhere(uid, f))
    .groupBy(transactions.currency, transactions.date)
    .all();
  let count = 0;
  let inCents = 0;
  let outCents = 0;
  for (const g of groups) {
    count += g.count;
    inCents += fx.convertCents(g.inCents, g.currency, base, g.date);
    outCents += fx.convertCents(g.outCents, g.currency, base, g.date);
  }
  return { count, inCents, outCents, currency: base };
}

/** First month with a transaction (YYYY-MM). */
export function firstTransactionMonth(uid: string): string | null {
  const row = db()
    .select({ d: sql<string | null>`min(${transactions.date})` })
    .from(transactions)
    .where(eq(transactions.userId, uid))
    .get();
  return row?.d ? row.d.slice(0, 7) : null;
}

export function countUncategorized(uid: string): number {
  return (
    db()
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(and(eq(transactions.userId, uid), isNull(transactions.categoryId)))
      .get()?.n ?? 0
  );
}

function importHash(accountId: number | null, row: ImportRow, occurrence: number) {
  const key = [accountId ?? "-", row.date, toCents(row.amount), row.description.toLowerCase(), occurrence].join("|");
  return createHash("sha1").update(key).digest("hex");
}

export type ImportTransactionRow = ImportRow & { currency?: string; categoryId?: number | null };

/**
 * Insert imported rows, skipping ones already imported (same file twice is a
 * no-op). Rows without a category get one from the rules.
 */
export function importTransactions(
  uid: string,
  rows: ImportTransactionRow[],
  accountId: number | null,
  opts: { currency?: string; source?: string } = {},
) {
  const fallbackCurrency = opts.currency ?? defaultCurrency(uid, accountId);
  const rules = listRules(uid);
  const ownCategories = new Set(
    db()
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.userId, uid))
      .all()
      .map((c) => c.id),
  );
  const seen = new Map<string, number>();
  const stmt = db().$client.prepare(
    `INSERT OR IGNORE INTO transactions (user_id, account_id, date, amount_cents, currency, description, category_id, import_hash, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  let categorized = 0;
  db().$client.transaction(() => {
    for (const row of rows) {
      const key = `${row.date}|${toCents(row.amount)}|${row.description.toLowerCase()}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const categoryId =
        row.categoryId && ownCategories.has(row.categoryId) ? row.categoryId : matchCategory(row.description, rules);
      const res = stmt.run(
        uid,
        accountId,
        row.date,
        toCents(row.amount),
        (row.currency ?? fallbackCurrency).toUpperCase(),
        row.description,
        categoryId,
        importHash(accountId, row, occurrence),
        opts.source ?? "csv",
      );
      if (res.changes) {
        inserted++;
        if (categoryId) categorized++;
      }
    }
  })();
  return { inserted, duplicates: rows.length - inserted, categorized };
}
