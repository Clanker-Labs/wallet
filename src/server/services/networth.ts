import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "@/server/db/client";
import { accounts } from "@/server/db/schema";
import { ASSET_CLASSES, isLiability, type AssetClass } from "@/lib/domain";
import { addDays, addMonths, endOfMonth, monthRange } from "@/lib/dates";
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
      accs.filter((a) => !a.archivedAt || a.archivedAt > date).map((a) => withBalance(a, byAccount.get(a.id) ?? [], date, ctx)),
      date,
    ),
  );
}

/**
 * The first day anything existed: the earliest snapshot, loan drawdown or job
 * start. Derived accounts have no snapshots, so the snapshots alone would
 * start a job's or a mortgage's chart on the day of its first manual entry.
 */
function earliestDate(accs: { loanParams: { startDate: string } | null; gratuityParams: { startDate: string } | null }[], firstDate: string | null) {
  let d = firstDate;
  for (const a of accs) {
    const start = a.gratuityParams?.startDate ?? (a.loanParams ? addDays(a.loanParams.startDate, -31) : null);
    if (start && (!d || start < d)) d = start;
  }
  return d;
}

/**
 * Net worth for every day of the last `days` days (and today). Days without a
 * new balance carry the last one forward; investment accounts use their daily
 * market snapshot, loans their schedule and jobs their accrued gratuity.
 */
export function netWorthDaily(uid: string, days = 365): NetWorthPoint[] {
  const ctx = valuationContext(uid);
  const { accs, byAccount, firstDate } = loadAll(uid);
  const t = ctx.today;
  let from = addDays(t, -days);
  const start = earliestDate(accs, firstDate);
  if (start && start > from) from = start;
  const out: NetWorthPoint[] = [];
  for (let d = from; d <= t; d = addDays(d, 1)) {
    out.push(
      pointFrom(
        accs.filter((a) => !a.archivedAt || a.archivedAt > d).map((a) => withBalance(a, byAccount.get(a.id) ?? [], d, ctx)),
        d,
      ),
    );
  }
  return out;
}

export interface NetWorthMover {
  accountId: number;
  name: string;
  assetClass: AssetClass;
  /** Signed change in net-worth contribution (a loan paid down is positive). */
  deltaCents: number;
  /** What made it move: a new balance, the market, a loan schedule, a job's accrual, or only the exchange rate. */
  driver: "balance" | "market" | "loan" | "job" | "fx";
}

export interface NetWorthMove extends NetWorthChange {
  key: string;
  movers: NetWorthMover[];
}

/**
 * How net worth moved over 1 day, 1 week, 1 month, the year to date and 1
 * year, and which accounts moved it — the "why" behind the number.
 */
export function netWorthMoves(uid: string, ctx: ValuationContext = valuationContext(uid)): { current: NetWorthBreakdown; moves: NetWorthMove[] } {
  const current = netWorthOn(uid, undefined, ctx);
  const { accs, byAccount } = loadAll(uid);
  const t = DateTime.fromISO(current.date);
  const refs: [string, string, string][] = [
    ["1d", "1 day", t.minus({ days: 1 }).toISODate()!],
    ["1w", "1 week", t.minus({ weeks: 1 }).toISODate()!],
    ["1m", "1 month", t.minus({ months: 1 }).toISODate()!],
    ["ytd", "YTD", t.startOf("year").minus({ days: 1 }).toISODate()!],
    ["1y", "1 year", t.minus({ years: 1 }).toISODate()!],
  ];
  // Same rule as netWorthOn: an account archived by a date counts as nothing on it.
  const at = (a: (typeof accs)[number], d: string) => {
    const v = withBalance(a, byAccount.get(a.id) ?? [], d, ctx);
    return a.archivedAt && a.archivedAt <= d ? { ...v, netCents: 0 } : v;
  };
  const now = new Map(accs.map((a) => [a.id, at(a, current.date)]));
  const moves = refs.map(([key, label, fromDate]) => {
    const movers: NetWorthMover[] = [];
    let before = 0;
    for (const a of accs) {
      const then = at(a, fromDate);
      const after = now.get(a.id)!;
      before += then.netCents;
      const deltaCents = after.netCents - then.netCents;
      if (deltaCents === 0) continue;
      movers.push({
        accountId: a.id,
        name: a.name,
        assetClass: a.assetClass,
        deltaCents,
        // Same balance in its own currency, different value in yours: the rate moved, not the account.
        driver:
          then.ownedCents === after.ownedCents && a.currency !== ctx.base && then.netCents !== 0
            ? "fx"
            : after.derivedFromJob
              ? "job"
              : after.derivedFromLoan
                ? "loan"
                : after.valuedByHoldings
                  ? "market"
                  : "balance",
      });
    }
    movers.sort((x, y) => Math.abs(y.deltaCents) - Math.abs(x.deltaCents));
    const deltaCents = current.netCents - before;
    return { key, label, fromDate, deltaCents, deltaPct: changePct(before, current.netCents), movers };
  });
  return { current, moves };
}

/** Month-end dates the history chart needs (for FX backfill). */
export function historyDates(months = 24, todayIso: string): string[] {
  const thisMonth = todayIso.slice(0, 7);
  return monthRange(addMonths(thisMonth, -months), addMonths(thisMonth, -1)).map(endOfMonth);
}

/**
 * A percentage is only meaningful against a base of some size: from the day
 * accounts were first entered, net worth "grows" by 170,000%. Below a twentieth
 * of today's figure, say nothing rather than something silly.
 */
export function changePct(before: number, after: number): number | null {
  if (before === 0 || Math.abs(before) * 20 < Math.abs(after)) return null;
  return ((after - before) / Math.abs(before)) * 100;
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
    ["1 day", t.minus({ days: 1 }).toISODate()!],
    ["1 week", t.minus({ weeks: 1 }).toISODate()!],
    ["1 month", t.minus({ months: 1 }).toISODate()!],
    ["YTD", t.startOf("year").minus({ days: 1 }).toISODate()!],
    ["1 year", t.minus({ years: 1 }).toISODate()!],
  ];
  const changes = refs.map(([label, fromDate]) => {
    const past = netWorthOn(uid, fromDate, ctx);
    const deltaCents = current.netCents - past.netCents;
    const deltaPct = changePct(past.netCents, current.netCents);
    return { label, fromDate, deltaCents, deltaPct };
  });
  return { current, changes };
}
