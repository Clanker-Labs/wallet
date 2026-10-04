import { formatMoney, type MoneyFormat } from "@/lib/money";
import { HOLDING_TYPES, type HoldingType } from "@/lib/domain";

/**
 * Pure helpers for the investments page (safe on server and client): holding
 * type → chart slot, page totals from holding rows, and native-currency formatting.
 */

// ── Allocation groups ────────────────────────────────────────────────────

export type TypeGroupKey = "etf" | "fund" | "stock" | "cash_other" | "crypto" | "commodity" | "bond";

/**
 * Holding types → categorical slots (--series-N), in a fixed order. Donut
 * slices are drawn in this order and colour follows the type, never its rank.
 *
 *   slot 1  ETFs           indigo
 *   slot 2  Funds          teal
 *   slot 3  Stocks         plum
 *   slot 4  Cash & other   terracotta   (8 types, 7 slots: `cash` and `other` fold together)
 *   slot 5  Crypto         azure        = the Crypto asset-class hue on the dashboard
 *   slot 6  Commodities    ochre gold   = the Commodities asset-class hue
 *   slot 7  Bonds          raspberry
 *
 * Why not stock/etf/fund/bond order: when a type is empty its two neighbours
 * touch, and the palette has four non-consecutive pairs below the ΔE 15
 * normal-vision floor (dataviz validator, see globals.css): 2↔5 (10.2), 4↔7
 * (12.1), 4↔6 (13.1) and 3↔7 (13.5). This order keeps the common types
 * (ETFs, stocks, crypto) out of those pairs: enumerating all 5 040 orders with
 * crypto and commodities pinned to their asset-class hues, and rough odds of
 * each type being held, it cuts expected weak contacts by ~60% versus the
 * natural order. Consecutive slots, the 7↔1 wrap included, all pass in both
 * modes (CVD ≥ 13.8, normal-vision ≥ 21), and the 2px surface gap between
 * slices plus the legend carry identity.
 */
export const TYPE_GROUPS: { key: TypeGroupKey; label: string; slot: number; types: HoldingType[] }[] = [
  { key: "etf", label: "ETFs", slot: 1, types: ["etf"] },
  { key: "fund", label: "Funds", slot: 2, types: ["fund"] },
  { key: "stock", label: "Stocks", slot: 3, types: ["stock"] },
  { key: "cash_other", label: "Cash & other", slot: 4, types: ["cash", "other"] },
  { key: "crypto", label: "Crypto", slot: 5, types: ["crypto"] },
  { key: "commodity", label: "Commodities", slot: 6, types: ["commodity"] },
  { key: "bond", label: "Bonds", slot: 7, types: ["bond"] },
];

export const HOLDING_TYPE_SLOT = Object.fromEntries(
  TYPE_GROUPS.flatMap((g) => g.types.map((t) => [t, g.slot])),
) as Record<HoldingType, number>;

export function holdingTypeLabel(t: HoldingType): string {
  return HOLDING_TYPES[t] ?? t;
}

// ── Totals ───────────────────────────────────────────────────────────────

/** The fields of a holding row (services/holdings HoldingRow) the page needs. */
export interface HoldingLike {
  assetType: HoldingType;
  currency: string;
  valueCents: number;
  baseValueCents: number;
  gainCents: number | null;
  unitPrice: number | null;
  priceDate: string | null;
  priceSource: "market" | "manual" | null;
}

/** A market price older than this many days is flagged (covers weekends and a holiday). */
export const STALE_PRICE_DAYS = 5;

export type PriceState = "ok" | "manual" | "stale" | "missing";

export function priceState(h: Pick<HoldingLike, "unitPrice" | "priceDate" | "priceSource">, today: string): PriceState {
  if (h.unitPrice === null) return "missing";
  if (h.priceSource === "manual") return "manual";
  if (h.priceDate && daysBetween(h.priceDate, today) > STALE_PRICE_DAYS) return "stale";
  return "ok";
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export interface InvestmentsSummary {
  /** Market value in the base currency. */
  totalCents: number;
  /** Unrealized gain in the base currency over positions with a cost basis and a price; null if none. */
  gainCents: number | null;
  gainPct: number | null;
  /** What was paid for those positions, base currency. */
  costCents: number;
  /** Positions the gain covers. */
  withCost: number;
  groups: { key: TypeGroupKey; label: string; slot: number; cents: number }[];
  currencies: { currency: string; cents: number }[];
  /** Most recent market quote date across positions. */
  latestQuote: string | null;
  missing: number;
  stale: number;
}

/**
 * Totals for a set of holdings, all in the base currency. Gains are converted
 * with each row's own value→base rate (the same FX the service used for the
 * value), so filtered and unfiltered views add up the same way.
 */
export function summarize(rows: HoldingLike[], today: string): InvestmentsSummary {
  let totalCents = 0;
  let gain = 0;
  let cost = 0;
  let withCost = 0;
  let latestQuote: string | null = null;
  let missing = 0;
  let stale = 0;
  const byType = new Map<HoldingType, number>();
  const byCurrency = new Map<string, number>();
  for (const r of rows) {
    totalCents += r.baseValueCents;
    byType.set(r.assetType, (byType.get(r.assetType) ?? 0) + r.baseValueCents);
    byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.baseValueCents);
    if (r.gainCents !== null && r.valueCents !== 0) {
      const rate = r.baseValueCents / r.valueCents;
      gain += r.gainCents * rate;
      cost += (r.valueCents - r.gainCents) * rate;
      withCost++;
    }
    if (r.priceSource === "market" && r.priceDate && (!latestQuote || r.priceDate > latestQuote)) latestQuote = r.priceDate;
    const state = priceState(r, today);
    if (state === "missing") missing++;
    if (state === "stale") stale++;
  }
  const groups = TYPE_GROUPS.map((g) => {
    const present = g.types.filter((t) => byType.has(t));
    // A folded group only says "Cash & other" when both are there.
    const label = present.length === 1 && g.types.length > 1 ? `${holdingTypeLabel(present[0])}` : g.label;
    return { key: g.key, label, slot: g.slot, cents: g.types.reduce((s, t) => s + (byType.get(t) ?? 0), 0) };
  });
  return {
    totalCents,
    gainCents: withCost ? Math.round(gain) : null,
    gainPct: withCost && cost > 0 ? (gain / cost) * 100 : null,
    costCents: Math.round(cost),
    withCost,
    groups,
    currencies: [...byCurrency.entries()].map(([currency, cents]) => ({ currency, cents })).sort((a, b) => b.cents - a.cents),
    latestQuote,
    missing,
    stale,
  };
}

// ── Formatting in any currency ───────────────────────────────────────────

/**
 * formatMoney in a given currency. Intl only knows 3-letter codes; longer
 * ones (USDT…) fall back to "1,234.56 USDT".
 */
export function moneyIn(cents: number, currency: string, locale: string, opts: MoneyFormat = {}): string {
  try {
    return formatMoney(cents, { locale, ...opts, currency });
  } catch {
    const n = new Intl.NumberFormat(locale, {
      maximumFractionDigits: opts.whole ? 0 : 2,
      minimumFractionDigits: opts.whole ? 0 : 2,
      signDisplay: opts.signed ? "exceptZero" : "auto",
    }).format(cents / 100);
    return `${n} ${currency}`;
  }
}

/** Unit price: 2 decimals, more for sub-unit prices (0.0123). */
export function priceIn(unit: number, currency: string, locale: string): string {
  const digits = Math.abs(unit) >= 1 ? 2 : Math.abs(unit) >= 0.01 ? 4 : 6;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    }).format(unit);
  } catch {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(unit)} ${currency}`;
  }
}

export function formatQuantity(q: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 8 }).format(q);
}

/** "today", "yesterday", "3 days ago", or a short date. */
export function relativeDay(date: string, today: string, locale = "en-GB"): string {
  const d = daysBetween(date, today);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
}
