import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "@/server/db/client";
import { accounts } from "@/server/db/schema";
import { ASSET_CLASSES, isLiability, type AssetClass } from "@/lib/domain";
import { addMonths, endOfMonth, monthRange } from "@/lib/dates";
import { snapshotsByAccount, withBalance, type AccountWithBalance } from "./accounts";
import { valuationContext, type ValuationContext } from "./valuation";

/** All amounts are in the user's base currency. */
export interface NetWorthPoint {
  date: string;
  assetsCents: number;
  liabilitiesCents: number;
  netCents: number;
  byClassCents: Record<AssetClass, number>;
}

export interface NetWorthBreakdown extends NetWorthPoint {
  currency: string;
  accounts: AccountWithBalance[];
  /** Currencies without an exchange rate (counted as 0) and assets without a price. */
  missingFx: string[];
  missingPrices: string[];
}

function loadAll(uid: string) {
  const accs = db().select().from(accounts).where(eq(accounts.userId, uid)).all();
  const byAccount = snapshotsByAccount(
    uid,
    accs.map((a) => a.id),
  );
  let firstDate: string | null = null;
  for (const list of byAccount.values()) if (list[0] && (!firstDate || list[0].date < firstDate)) firstDate = list[0].date;
  return { accs, byAccount, firstDate };
}

function emptyByClass(): Record<AssetClass, number> {
  return Object.fromEntries(ASSET_CLASSES.map((c) => [c, 0])) as Record<AssetClass, number>;
}

function pointFrom(list: AccountWithBalance[], date: string): NetWorthPoint {
  const byClassCents = emptyByClass();
  let assets = 0;
  let liabilities = 0;
  for (const a of list) {
    if (!a.includeInNetWorth) continue;
    byClassCents[a.assetClass] += a.baseOwnedCents;
    if (isLiability(a.assetClass)) liabilities += a.baseOwnedCents;
    else assets += a.baseOwnedCents;
  }
  return { date, assetsCents: assets, liabilitiesCents: liabilities, netCents: assets - liabilities, byClassCents };
}

export function netWorthOn(uid: string, date?: string, ctx: ValuationContext = valuationContext(uid)): NetWorthBreakdown {
  const d = date ?? ctx.today;
  const { accs, byAccount } = loadAll(uid);
  const list = accs
    .filter((a) => !a.archivedAt || a.archivedAt > d)
    .map((a) => withBalance(a, byAccount.get(a.id) ?? [], d, ctx));
  return {
    ...pointFrom(list, d),
    currency: ctx.base,
    accounts: list,
    missingFx: [...ctx.fx.missing],
    missingPrices: [...ctx.missingPrices],
  };
}

/** Month-end net worth for the last `months` months, plus today. */
export function netWorthHistory(uid: string, months = 24): NetWorthPoint[] {
  const ctx = valuationContext(uid);
  const { accs, byAccount, firstDate } = loadAll(uid);
  const t = ctx.today;
  const thisMonth = t.slice(0, 7);
  let from = addMonths(thisMonth, -months);
  if (firstDate && firstDate.slice(0, 7) > from) from = firstDate.slice(0, 7);
  const dates = monthRange(from, addMonths(thisMonth, -1)).map(endOfMonth);
  dates.push(t);
  return dates.map((date) =>
    pointFrom(
      accs.map((a) => withBalance(a, byAccount.get(a.id) ?? [], date, ctx)),
      date,
    ),
  );
}

/** Month-end dates the history chart needs (for FX backfill). */
export function historyDates(months = 24, todayIso: string): string[] {
  const thisMonth = todayIso.slice(0, 7);
  return monthRange(addMonths(thisMonth, -months), addMonths(thisMonth, -1)).map(endOfMonth);
}

export interface NetWorthChange {
  label: string;
  fromDate: string;
  deltaCents: number;
  deltaPct: number | null;
}

export function netWorthChanges(uid: string): { current: NetWorthBreakdown; changes: NetWorthChange[] } {
  const ctx = valuationContext(uid);
  const current = netWorthOn(uid, undefined, ctx);
  const t = DateTime.fromISO(current.date);
  const refs: [string, string][] = [
    ["1 month", t.minus({ months: 1 }).toISODate()!],
    ["YTD", t.startOf("year").minus({ days: 1 }).toISODate()!],
    ["1 year", t.minus({ years: 1 }).toISODate()!],
  ];
  const changes = refs.map(([label, fromDate]) => {
    const past = netWorthOn(uid, fromDate, ctx);
    const deltaCents = current.netCents - past.netCents;
    const deltaPct = past.netCents !== 0 ? (deltaCents / Math.abs(past.netCents)) * 100 : null;
    return { label, fromDate, deltaCents, deltaPct };
  });
  return { current, changes };
}
