import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { holdings, type Account, type Holding } from "@/server/db/schema";
import { fxConverter, type FxConverter } from "./fx";
import { priceReader, type PriceReader } from "./prices";
import { getSettings, today } from "./settings";

/**
 * Everything needed to value a user's accounts on any date: base currency,
 * FX rates, market prices and holdings. Built once per request; reads only
 * the DB. Missing prices / rates are collected so the UI can warn.
 */
export interface ValuationContext {
  uid: string;
  today: string;
  base: string;
  fx: FxConverter;
  price: PriceReader;
  holdingsByAccount: Map<number, Holding[]>;
  missingPrices: Set<string>;
}

export function valuationContext(uid: string): ValuationContext {
  const byAccount = new Map<number, Holding[]>();
  for (const h of db().select().from(holdings).where(eq(holdings.userId, uid)).all()) {
    const list = byAccount.get(h.accountId) ?? [];
    list.push(h);
    byAccount.set(h.accountId, list);
  }
  return {
    uid,
    today: today(uid),
    base: getSettings(uid).currency,
    fx: fxConverter(),
    price: priceReader(),
    holdingsByAccount: byAccount,
    missingPrices: new Set(),
  };
}

export interface HoldingValue {
  /** Price per unit in the holding's currency, or null if unknown. */
  unitPrice: number | null;
  priceDate: string | null;
  priceSource: "market" | "manual" | null;
  /** quantity × price, in the holding's currency (units, not cents). */
  value: number;
}

export function valueHolding(h: Holding, date: string, ctx: ValuationContext): HoldingValue {
  if (h.manualPrice !== null && h.manualPrice !== undefined) {
    return { unitPrice: h.manualPrice, priceDate: null, priceSource: "manual", value: h.quantity * h.manualPrice };
  }
  if (!h.symbol) {
    ctx.missingPrices.add(h.name);
    return { unitPrice: null, priceDate: null, priceSource: null, value: 0 };
  }
  const p = ctx.price(h.symbol, date);
  if (!p) {
    ctx.missingPrices.add(h.symbol);
    return { unitPrice: null, priceDate: null, priceSource: null, value: 0 };
  }
  // A quote in another currency than the holding's is converted.
  const unit = p.currency === h.currency ? p.close : ctx.fx.convert(p.close, p.currency, h.currency, date);
  return { unitPrice: unit, priceDate: p.date, priceSource: "market", value: h.quantity * unit };
}

/** Market value of an account's holdings in the account's currency (cents). */
export function holdingsValueCents(
  account: Pick<Account, "id" | "currency">,
  date: string,
  ctx: ValuationContext,
): { cents: number; asOf: string | null } {
  let total = 0;
  let asOf: string | null = null;
  for (const h of ctx.holdingsByAccount.get(account.id) ?? []) {
    const v = valueHolding(h, date, ctx);
    total += ctx.fx.convert(v.value, h.currency, account.currency, date);
    if (v.priceDate && (!asOf || v.priceDate > asOf)) asOf = v.priceDate;
  }
  return { cents: Math.round(total * 100), asOf };
}
