import { asc } from "drizzle-orm";
import { db } from "@/server/db/client";
import { accounts, balanceSnapshots } from "@/server/db/schema";
import { ASSET_CLASSES, isLiability, type AssetClass } from "@/lib/domain";
import { addMonths, endOfMonth, monthRange } from "@/lib/dates";
import { DateTime } from "luxon";
import { withBalance, type AccountWithBalance } from "./accounts";
import { today } from "./settings";

export interface NetWorthPoint {
  date: string;
  assetsCents: number;
  liabilitiesCents: number;
  netCents: number;
  byClassCents: Record<AssetClass, number>;
}

export interface NetWorthBreakdown extends NetWorthPoint {
  accounts: AccountWithBalance[];
}

function loadAll() {
  const accs = db().select().from(accounts).all();
  const snaps = db().select().from(balanceSnapshots).orderBy(asc(balanceSnapshots.date)).all();
  const byAccount = new Map<number, typeof snaps>();
  for (const s of snaps) {
    const list = byAccount.get(s.accountId) ?? [];
    list.push(s);
    byAccount.set(s.accountId, list);
  }
  return { accs, byAccount, firstDate: snaps[0]?.date ?? null };
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
    byClassCents[a.assetClass] += a.ownedCents;
    if (isLiability(a.assetClass)) liabilities += a.ownedCents;
    else assets += a.ownedCents;
  }
  return { date, assetsCents: assets, liabilitiesCents: liabilities, netCents: assets - liabilities, byClassCents };
}

export function netWorthOn(date = today()): NetWorthBreakdown {
  const { accs, byAccount } = loadAll();
  const list = accs
    .filter((a) => !a.archivedAt || a.archivedAt > date)
    .map((a) => withBalance(a, byAccount.get(a.id) ?? [], date));
  return { ...pointFrom(list, date), accounts: list };
}

/** Month-end net worth for the last `months` months, plus today. */
export function netWorthHistory(months = 24): NetWorthPoint[] {
  const { accs, byAccount, firstDate } = loadAll();
  const t = today();
  const thisMonth = t.slice(0, 7);
  let from = addMonths(thisMonth, -months);
  if (firstDate && firstDate.slice(0, 7) > from) from = firstDate.slice(0, 7);
  const dates = monthRange(from, addMonths(thisMonth, -1)).map(endOfMonth);
  dates.push(t);
  return dates.map((date) =>
    pointFrom(
      accs.map((a) => withBalance(a, byAccount.get(a.id) ?? [], date)),
      date,
    ),
  );
}

export interface NetWorthChange {
  label: string;
  fromDate: string;
  deltaCents: number;
  deltaPct: number | null;
}

export function netWorthChanges(): { current: NetWorthBreakdown; changes: NetWorthChange[] } {
  const current = netWorthOn();
  const t = DateTime.fromISO(current.date);
  const refs: [string, string][] = [
    ["1 month", t.minus({ months: 1 }).toISODate()!],
    ["YTD", t.startOf("year").minus({ days: 1 }).toISODate()!],
    ["1 year", t.minus({ years: 1 }).toISODate()!],
  ];
  const changes = refs.map(([label, fromDate]) => {
    const past = netWorthOn(fromDate);
    const deltaCents = current.netCents - past.netCents;
    const deltaPct = past.netCents !== 0 ? (deltaCents / Math.abs(past.netCents)) * 100 : null;
    return { label, fromDate, deltaCents, deltaPct };
  });
  return { current, changes };
}
