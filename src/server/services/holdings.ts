import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, holdings, type Holding } from "@/server/db/schema";
import { HOLDING_TYPE_KEYS, type HoldingType } from "@/lib/domain";
import { isISODate } from "@/lib/dates";
import { currencySchema, getAccountRow, recordBalance, snapshotHoldingAccounts } from "./accounts";
import { valuationContext, valueHolding, type ValuationContext } from "./valuation";
import { refreshPrices } from "./prices";
import { audit } from "./audit";

export const holdingInputSchema = z.object({
  accountId: z.number().int().describe("Account that holds the position (brokerage, PEA, crypto wallet…)"),
  symbol: z
    .string()
    .trim()
    .max(30)
    .nullish()
    .describe("Yahoo Finance symbol: AAPL, VOO, CW8.PA (Paris), VWCE.DE (Xetra), BTC-USD, GC=F (gold). Omit for manual assets."),
  name: z.string().trim().max(120).optional().describe("Display name (defaults to the symbol)"),
  assetType: z.enum(HOLDING_TYPE_KEYS as [HoldingType, ...HoldingType[]]).default("stock"),
  quantity: z.number().min(0).describe("Units / shares / coins / ounces held"),
  currency: currencySchema.optional().describe("Quote currency (default: the account's currency)"),
  costBasis: z.number().min(0).nullish().describe("Average purchase price per unit, in the quote currency"),
  manualPrice: z.number().min(0).nullish().describe("Price per unit when there's no market symbol (or to override it)"),
  purchaseDate: z
    .string()
    .refine(isISODate, "Expected YYYY-MM-DD")
    .nullish()
    .describe("When it was bought (average date): the cost is converted to your currency at that day's rate, so gains split into price and currency"),
});
export type HoldingInput = z.input<typeof holdingInputSchema>;

export interface HoldingRow extends Holding {
  accountName: string;
  accountCurrency: string;
  unitPrice: number | null;
  priceDate: string | null;
  priceSource: "market" | "manual" | null;
  /** quantity × price, quote currency, cents. */
  valueCents: number;
  /** Market value converted to the base currency, cents (ignores ownership share). */
  baseValueCents: number;
  /** Unrealized gain vs cost basis, quote currency, cents (null without cost basis). */
  gainCents: number | null;
  gainPct: number | null;
  /**
   * The same gain in your base currency, split: price (what the asset did, at
   * today's rate) and currency (what the exchange rate did since purchase).
   * The cost uses the rate on purchaseDate, or the day the holding was added.
   */
  baseCostCents: number | null;
  baseGainCents: number | null;
  baseGainPct: number | null;
  priceGainBaseCents: number | null;
  fxGainBaseCents: number | null;
  /** True when the purchase date is a guess (the day it was added to wallet). */
  costDateEstimated: boolean;
}

function getHoldingRow(uid: string, id: number): Holding {
  const row = db()
    .select()
    .from(holdings)
    .where(and(eq(holdings.id, id), eq(holdings.userId, uid)))
    .get();
  if (!row) throw new Error(`Holding ${id} not found`);
  return row;
}

export function listHoldings(uid: string, opts: { accountId?: number; ctx?: ValuationContext } = {}): HoldingRow[] {
  const ctx = opts.ctx ?? valuationContext(uid);
  const rows = db()
    .select({ h: holdings, accountName: accounts.name, accountCurrency: accounts.currency })
    .from(holdings)
    .innerJoin(accounts, eq(accounts.id, holdings.accountId))
    .where(
      opts.accountId
        ? and(eq(holdings.userId, uid), eq(holdings.accountId, opts.accountId))
        : eq(holdings.userId, uid),
    )
    .orderBy(asc(accounts.name), asc(holdings.name))
    .all();
  return rows.map(({ h, accountName, accountCurrency }) => {
    const v = valueHolding(h, ctx.today, ctx);
    const valueCents = Math.round(v.value * 100);
    const cost = h.costBasis !== null && h.costBasis !== undefined ? h.costBasis * h.quantity : null;
    const gain = cost !== null && v.unitPrice !== null ? v.value - cost : null;
    const baseValueCents = ctx.fx.convertCents(valueCents, h.currency, ctx.base, ctx.today);
    const costDate = h.purchaseDate ?? new Date(h.createdAt).toISOString().slice(0, 10);
    const baseCostCents = cost === null ? null : ctx.fx.convertCents(Math.round(cost * 100), h.currency, ctx.base, costDate);
    const baseGainCents = baseCostCents === null || v.unitPrice === null ? null : baseValueCents - baseCostCents;
    const priceGainBaseCents = gain === null ? null : ctx.fx.convertCents(Math.round(gain * 100), h.currency, ctx.base, ctx.today);
    return {
      ...h,
      accountName,
      accountCurrency,
      ...v,
      valueCents,
      baseValueCents,
      gainCents: gain === null ? null : Math.round(gain * 100),
      gainPct: gain !== null && cost ? (gain / cost) * 100 : null,
      baseCostCents,
      baseGainCents,
      baseGainPct: baseGainCents !== null && baseCostCents ? (baseGainCents / baseCostCents) * 100 : null,
      priceGainBaseCents,
      fxGainBaseCents: baseGainCents !== null && priceGainBaseCents !== null ? baseGainCents - priceGainBaseCents : null,
      costDateEstimated: !h.purchaseDate,
    };
  });
}

/** Totals for the investments page: by asset type and by quote currency (base currency). */
export function holdingsSummary(uid: string) {
  const ctx = valuationContext(uid);
  const rows = listHoldings(uid, { ctx });
  const byType = new Map<HoldingType, number>();
  const byCurrency = new Map<string, number>();
  let totalCents = 0;
  let costCents = 0;
  let valueWithCostCents = 0;
  let fxGainCents = 0;
  for (const r of rows) {
    totalCents += r.baseValueCents;
    byType.set(r.assetType, (byType.get(r.assetType) ?? 0) + r.baseValueCents);
    byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.baseValueCents);
    if (r.baseCostCents !== null && r.unitPrice !== null) {
      // At the purchase date's rate: the gain includes what the currency did.
      costCents += r.baseCostCents;
      valueWithCostCents += r.baseValueCents;
      fxGainCents += r.fxGainBaseCents ?? 0;
    }
  }
  return {
    base: ctx.base,
    rows,
    totalCents,
    gainCents: costCents ? valueWithCostCents - costCents : null,
    gainPct: costCents ? ((valueWithCostCents - costCents) / costCents) * 100 : null,
    /** Part of the gain that is the exchange rate, not the assets. */
    fxGainCents: costCents ? fxGainCents : null,
    byType: [...byType.entries()].map(([type, cents]) => ({ type, cents })).sort((a, b) => b.cents - a.cents),
    byCurrency: [...byCurrency.entries()].map(([currency, cents]) => ({ currency, cents })).sort((a, b) => b.cents - a.cents),
    missingPrices: [...ctx.missingPrices],
    missingFx: [...ctx.fx.missing],
  };
}

/**
 * Add a position, or update it when the account already holds that symbol
 * (quantity is replaced, not added). Fetches its price, then records today's
 * account value so history stays continuous.
 */
export async function upsertHolding(uid: string, raw: HoldingInput, opts: { fetchPrice?: boolean } = {}) {
  const input = holdingInputSchema.parse(raw);
  const account = getAccountRow(uid, input.accountId);
  const symbol = input.symbol ? input.symbol.toUpperCase() : null;
  const values = {
    userId: uid,
    accountId: account.id,
    symbol,
    name: input.name || symbol || "Asset",
    assetType: input.assetType,
    quantity: input.quantity,
    currency: input.currency ?? account.currency,
    costBasis: input.costBasis ?? null,
    manualPrice: input.manualPrice ?? null,
    purchaseDate: input.purchaseDate ?? null,
  };
  const existing = symbol
    ? db()
        .select()
        .from(holdings)
        .where(and(eq(holdings.userId, uid), eq(holdings.accountId, account.id), eq(holdings.symbol, symbol)))
        .get()
    : undefined;
  const holding = existing
    ? db()
        .update(holdings)
        .set({
          ...values,
          name: input.name || existing.name,
          costBasis: input.costBasis === undefined ? existing.costBasis : values.costBasis,
          purchaseDate: input.purchaseDate === undefined ? existing.purchaseDate : values.purchaseDate,
          currency: input.currency ?? existing.currency,
        })
        .where(eq(holdings.id, existing.id))
        .returning()
        .get()!
    : db().insert(holdings).values(values).returning().get();

  let priceError: string | null = null;
  if (symbol && opts.fetchPrice !== false) {
    // A year of daily prices gives history charts something to work with.
    const r = await refreshPrices({ symbols: [symbol], range: existing ? "5d" : "1y" });
    priceError = r.failed[0]?.error ?? null;
  }
  snapshotHoldingAccounts(uid);
  audit(uid, "holding", holding.id, existing ? "update" : "add", `${holding.name}: ${holding.quantity} in ${account.name}`);
  return { holding, updated: !!existing, priceError };
}

export function updateHolding(uid: string, id: number, raw: Partial<HoldingInput>) {
  const current = getHoldingRow(uid, id);
  const input = holdingInputSchema.partial().parse(raw);
  if (input.accountId) getAccountRow(uid, input.accountId);
  const patch: Partial<typeof holdings.$inferInsert> = {};
  if (input.accountId !== undefined) patch.accountId = input.accountId;
  if (input.symbol !== undefined) patch.symbol = input.symbol ? input.symbol.toUpperCase() : null;
  if (input.name !== undefined) patch.name = input.name;
  if (input.assetType !== undefined) patch.assetType = input.assetType;
  if (input.quantity !== undefined) patch.quantity = input.quantity;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.costBasis !== undefined) patch.costBasis = input.costBasis ?? null;
  if (input.purchaseDate !== undefined) patch.purchaseDate = input.purchaseDate ?? null;
  if (input.manualPrice !== undefined) patch.manualPrice = input.manualPrice ?? null;
  const updated = db().update(holdings).set(patch).where(eq(holdings.id, current.id)).returning().get();
  snapshotHoldingAccounts(uid);
  return updated;
}

export function deleteHolding(uid: string, id: number) {
  const h = getHoldingRow(uid, id);
  db().delete(holdings).where(eq(holdings.id, h.id)).run();
  const left = db().select({ id: holdings.id }).from(holdings).where(eq(holdings.accountId, h.accountId)).get();
  // Last position gone: the account is empty today (rather than frozen at its old value).
  if (!left) recordBalance(uid, { accountId: h.accountId, balance: 0, source: "holdings" });
  snapshotHoldingAccounts(uid);
}
