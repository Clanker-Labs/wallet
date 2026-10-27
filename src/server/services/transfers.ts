import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "@/server/db/client";
import { accounts, categories, transactions } from "@/server/db/schema";
import { fxConverter } from "./fx";

/**
 * Money moved between your own accounts shows up twice — once leaving one
 * account, once arriving in the other — and uncategorized, both sides count:
 * the AED salary you send to your EUR account becomes "income" there and
 * "spending" here, and the savings rate is wrong twice over.
 *
 * This pairs the two sides: opposite signs, different accounts of yours,
 * a few days apart, the same amount once converted (within a small tolerance
 * for the bank's FX spread and fees). Pairs are filed under the Transfers
 * category, which budgets and cash flow ignore.
 */

export interface TransferPair {
  outId: number;
  inId: number;
  date: string;
  outAccount: string;
  inAccount: string;
  description: string;
  /** Leaving amount, in its currency (positive). */
  amount: number;
  currency: string;
  /** Arriving amount, in its currency. */
  received: number;
  receivedCurrency: string;
  /** Relative difference after conversion (0.004 = 0.4%). */
  gap: number;
}

export function findTransferPairs(
  uid: string,
  opts: { from?: string; to?: string; days?: number; tolerance?: number } = {},
): TransferPair[] {
  const days = opts.days ?? 3;
  const tolerance = opts.tolerance ?? 0.02;
  // Only rows nobody has decided about yet: uncategorized, on one of your accounts.
  const conds = [eq(transactions.userId, uid), isNull(transactions.categoryId)];
  if (opts.from) conds.push(gte(transactions.date, opts.from));
  if (opts.to) conds.push(lte(transactions.date, opts.to));
  const rows = db()
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      accountId: transactions.accountId,
      description: transactions.description,
      account: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, and(eq(accounts.id, transactions.accountId), eq(accounts.userId, uid)))
    .where(and(...conds))
    .all();
  const fx = fxConverter();
  const outs = rows.filter((r) => r.amountCents < 0).sort((a, b) => a.amountCents - b.amountCents); // biggest first
  const ins = rows.filter((r) => r.amountCents > 0);
  const used = new Set<number>();
  const pairs: TransferPair[] = [];
  for (const o of outs) {
    const leaving = -o.amountCents;
    let best: { r: (typeof ins)[number]; gap: number; dd: number } | null = null;
    for (const i of ins) {
      if (used.has(i.id) || i.accountId === o.accountId) continue;
      const dd = Math.abs(DateTime.fromISO(i.date).diff(DateTime.fromISO(o.date), "days").days);
      if (dd > days) continue;
      const arriving = fx.convertCents(i.amountCents, i.currency, o.currency, o.date);
      if (!arriving) continue;
      const gap = Math.abs(arriving - leaving) / leaving;
      if (gap > tolerance) continue;
      if (!best || gap < best.gap - 1e-9 || (Math.abs(gap - best.gap) < 1e-9 && dd < best.dd)) best = { r: i, gap, dd };
    }
    if (!best) continue;
    used.add(best.r.id);
    pairs.push({
      outId: o.id,
      inId: best.r.id,
      date: o.date,
      outAccount: o.account,
      inAccount: best.r.account,
      description: o.description,
      amount: leaving / 100,
      currency: o.currency,
      received: best.r.amountCents / 100,
      receivedCurrency: best.r.currency,
      gap: Math.round(best.gap * 10_000) / 10_000,
    });
  }
  return pairs.sort((a, b) => b.date.localeCompare(a.date));
}

/** The category transfers are filed under (the user's "Transfers", or any transfer-kind one). */
function transferCategoryId(uid: string): number | null {
  const list = db()
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.userId, uid), eq(categories.kind, "transfer")))
    .all();
  return (list.find((c) => c.name.toLowerCase() === "transfers") ?? list[0])?.id ?? null;
}

/** Find pairs and file both sides as transfers. Returns what was matched. */
export function matchTransfers(uid: string, opts: Parameters<typeof findTransferPairs>[1] & { dryRun?: boolean } = {}) {
  const pairs = findTransferPairs(uid, opts);
  const categoryId = transferCategoryId(uid);
  if (opts.dryRun || !pairs.length || categoryId === null) return { matched: 0, pairs, categoryId };
  const ids = pairs.flatMap((p) => [p.outId, p.inId]);
  db()
    .update(transactions)
    .set({ categoryId })
    .where(and(eq(transactions.userId, uid), inArray(transactions.id, ids), isNull(transactions.categoryId)))
    .run();
  return { matched: pairs.length, pairs, categoryId };
}
