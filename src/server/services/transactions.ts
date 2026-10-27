import { and, desc, eq, gte, inArray, isNull, like, lte, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, categories, transactionSplits, transactions } from "@/server/db/schema";
import { toCents } from "@/lib/money";
import { addDays, isISODate } from "@/lib/dates";
import type { ImportRow } from "@/lib/csv-import";
import { currencySchema, getAccountRow } from "./accounts";
import { listRules, normalizePattern, requireCategory, ruleEffects, upsertRule } from "./categories";
import { fxConverter } from "./fx";
import { getSettings, today } from "./settings";
import { matchTransfers } from "./transfers";
import { reconcileRecurring } from "./recurring";
import { audit } from "./audit";

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
  /** Only transactions with this tag. */
  tag: z.string().optional(),
  ids: z.array(z.number().int()).max(1000).optional(),
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
  // Always, not only when the currency is looked up from it: the account must be the caller's.
  if (input.accountId) getAccountRow(uid, input.accountId);
  const effects =
    input.categoryId === undefined
      ? ruleEffects({ description: input.description, amountCents: toCents(input.amount), accountId: input.accountId ?? null }, listRules(uid))
      : null;
  const categoryId = input.categoryId === undefined ? (effects?.categoryId ?? null) : input.categoryId;
  const row = db()
    .insert(transactions)
    .values({
      userId: uid,
      date: input.date ?? today(uid),
      amountCents: toCents(input.amount),
      currency: input.currency ?? defaultCurrency(uid, input.accountId),
      description: input.description,
      categoryId: categoryId ?? null,
      payee: effects?.payee ?? null,
      tags: effects?.tags ?? null,
      accountId: input.accountId ?? null,
      notes: input.notes ?? null,
      source: input.source,
    })
    .returning()
    .get();
  reconcileRecurring(uid);
  audit(uid, "transaction", row.id, "add", `${row.description}: ${(row.amountCents / 100).toFixed(2)} ${row.currency} on ${row.date}`);
  return row;
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
  const updated = db().update(transactions).set(patch).where(eq(transactions.id, id)).returning().get();
  audit(uid, "transaction", id, "update", `Changed ${Object.keys(patch).join(", ")} of “${updated?.description}”`);
  return updated;
}

export function deleteTransaction(uid: string, id: number) {
  db()
    .delete(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, uid)))
    .run();
  audit(uid, "transaction", id, "delete", `Deleted transaction ${id}`);
}

function filterWhere(uid: string, f: z.output<typeof transactionFilterSchema>) {
  const where: SQL[] = [eq(transactions.userId, uid)];
  if (f.from) where.push(gte(transactions.date, f.from));
  if (f.to) where.push(lte(transactions.date, f.to));
  if (f.accountId) where.push(eq(transactions.accountId, f.accountId));
  if (f.categoryId === "none") where.push(isNull(transactions.categoryId));
  else if (f.categoryId) where.push(eq(transactions.categoryId, f.categoryId));
  if (f.search) {
    // Literal text: % and _ in a search box mean themselves, not wildcards.
    const q = `%${f.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(${transactions.description} LIKE ${q} ESCAPE '\\' OR ${transactions.payee} LIKE ${q} ESCAPE '\\')`);
  }
  if (f.ids) where.push(inArray(transactions.id, f.ids.length ? f.ids : [-1]));
  if (f.tag) where.push(sql`EXISTS (SELECT 1 FROM json_each(${transactions.tags}) WHERE value = ${f.tag.replace(/^#/, "").toLowerCase()})`);
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
      recurringId: transactions.recurringId,
      payee: transactions.payee,
      tags: transactions.tags,
      splitCount: sql<number>`(SELECT count(*) FROM transaction_splits s WHERE s.transaction_id = ${transactions.id})`,
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
  if (accountId) getAccountRow(uid, accountId); // the caller's account, whatever the currency
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
    `INSERT OR IGNORE INTO transactions (user_id, account_id, date, amount_cents, currency, description, category_id, import_hash, source, payee, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // A payment typed in by hand (or recorded from a recurring item) that the
  // statement now brings: same account, same amount, within a few days.
  // The statement row takes it over instead of adding a second one.
  const adoptable = db().$client.prepare(
    `SELECT id FROM transactions
     WHERE user_id = ? AND account_id = ? AND amount_cents = ? AND import_hash IS NULL AND source != 'csv'
       AND date BETWEEN date(?, '-5 days') AND date(?, '+5 days')
     ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1`,
  );
  const adopt = db().$client.prepare(
    "UPDATE transactions SET date = ?, description = ?, import_hash = ?, source = ? WHERE id = ?",
  );
  const hashTaken = db().$client.prepare("SELECT 1 FROM transactions WHERE user_id = ? AND import_hash = ?");
  let inserted = 0;
  let categorized = 0;
  let adopted = 0;
  db().$client.transaction(() => {
    for (const row of rows) {
      const key = `${row.date}|${toCents(row.amount)}|${row.description.toLowerCase()}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      if (accountId) {
        const hash = importHash(accountId, row, occurrence);
        const existing = !hashTaken.get(uid, hash) && (adoptable.get(uid, accountId, toCents(row.amount), row.date, row.date, row.date) as { id: number } | undefined);
        if (existing) {
          adopt.run(row.date, row.description, hash, opts.source ?? "csv", existing.id);
          adopted++;
          continue;
        }
      }
      const effects = ruleEffects({ description: row.description, amountCents: toCents(row.amount), accountId }, rules);
      const categoryId = row.categoryId && ownCategories.has(row.categoryId) ? row.categoryId : (effects?.categoryId ?? null);
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
        effects?.payee ?? null,
        effects?.tags ? JSON.stringify(effects.tags) : null,
      );
      if (res.changes) {
        inserted++;
        if (categoryId) categorized++;
      }
    }
  })();
  // Both sides of a move between your own accounts usually arrive in two imports: pair them now.
  let transfers = 0;
  if (inserted && rows.length) {
    const dates = rows.map((r) => r.date).sort();
    transfers = matchTransfers(uid, { from: addDays(dates[0], -3), to: addDays(dates.at(-1)!, 3) }).matched;
  }
  if (inserted || adopted) reconcileRecurring(uid);
  if (inserted || adopted) audit(uid, "transaction", accountId, "import", `Imported ${inserted} transaction${inserted === 1 ? "" : "s"}${adopted ? `, ${adopted} matched to ones entered by hand` : ""} (${opts.source ?? "csv"})`);
  return {
    inserted,
    duplicates: rows.length - inserted - adopted,
    categorized,
    ...(adopted ? { adopted } : {}),
    ...(transfers ? { transfers } : {}),
  };
}

// ── Splits & tags ──────────────────────────────────────────────────────────

export const splitInputSchema = z.array(
  z.object({ categoryId: z.number().int().nullable(), amount: z.number(), note: z.string().max(200).nullish() }),
);

/**
 * Split one payment over several categories. The parts must add up to the
 * transaction's amount; budgets then count the parts. An empty list removes
 * the split. The transaction keeps the largest part's category for display.
 */
export function setSplits(uid: string, id: number, raw: z.input<typeof splitInputSchema>) {
  const tx = getTransactionRow(uid, id);
  const parts = splitInputSchema.parse(raw);
  for (const p of parts) if (p.categoryId) requireCategory(uid, p.categoryId);
  db().transaction((t) => {
    t.delete(transactionSplits).where(eq(transactionSplits.transactionId, id)).run();
    if (!parts.length) return;
    if (parts.length < 2) throw new Error("A split needs at least two parts.");
    const cents = parts.map((p) => toCents(p.amount));
    const total = cents.reduce((a, b) => a + b, 0);
    if (total !== tx.amountCents)
      throw new Error(`The parts add up to ${(total / 100).toFixed(2)} but the payment is ${(tx.amountCents / 100).toFixed(2)} ${tx.currency}.`);
    if (cents.some((c) => Math.sign(c) !== Math.sign(tx.amountCents))) throw new Error("Every part must have the payment's sign.");
    t.insert(transactionSplits)
      .values(parts.map((p, i) => ({ transactionId: id, userId: uid, categoryId: p.categoryId, amountCents: cents[i], note: p.note ?? null })))
      .run();
    audit(uid, "transaction", id, "split", `Split “${tx.description}” in ${parts.length}`);
    const largest = parts[cents.map(Math.abs).indexOf(Math.max(...cents.map(Math.abs)))];
    t.update(transactions).set({ categoryId: largest.categoryId }).where(eq(transactions.id, id)).run();
  });
  return listSplits(uid, id);
}

export function listSplits(uid: string, id: number) {
  getTransactionRow(uid, id);
  return db()
    .select({ id: transactionSplits.id, categoryId: transactionSplits.categoryId, categoryName: categories.name, amountCents: transactionSplits.amountCents, note: transactionSplits.note })
    .from(transactionSplits)
    .leftJoin(categories, eq(categories.id, transactionSplits.categoryId))
    .where(eq(transactionSplits.transactionId, id))
    .all();
}

const cleanTag = (t: string) => t.trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-").slice(0, 40);

/** Add and/or remove tags on transactions. */
export function tagTransactions(uid: string, ids: number[], opts: { add?: string[]; remove?: string[] }) {
  const add = (opts.add ?? []).map(cleanTag).filter(Boolean);
  const remove = new Set((opts.remove ?? []).map(cleanTag));
  if (!ids.length) return { updated: 0 };
  const rows = db()
    .select({ id: transactions.id, tags: transactions.tags })
    .from(transactions)
    .where(and(eq(transactions.userId, uid), inArray(transactions.id, ids)))
    .all();
  const stmt = db().$client.prepare("UPDATE transactions SET tags = ? WHERE id = ?");
  db().$client.transaction(() => {
    for (const r of rows) {
      const next = [...new Set([...(r.tags ?? []), ...add])].filter((t) => !remove.has(t));
      stmt.run(next.length ? JSON.stringify(next) : null, r.id);
    }
  })();
  return { updated: rows.length };
}

/** Every tag in use, most used first. */
export function listTags(uid: string): { tag: string; count: number }[] {
  return db()
    .$client.prepare(
      "SELECT j.value AS tag, count(*) AS count FROM transactions t, json_each(t.tags) j WHERE t.user_id = ? GROUP BY j.value ORDER BY count DESC, tag",
    )
    .all(uid) as { tag: string; count: number }[];
}
