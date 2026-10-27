import { DateTime } from "luxon";
import { db } from "@/server/db/client";
import { accounts, type Holding } from "@/server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { HoldingType } from "@/lib/domain";
import { addDays } from "@/lib/dates";
import { snapshotsByAccount, withBalance } from "./accounts";
import { listHoldings, type HoldingRow } from "./holdings";
import { valuationContext } from "./valuation";
import { brokerPerformance, type BrokerPerformance } from "./broker-history";

/**
 * Portfolio analytics from stored daily prices.
 *
 * Returns, risk and the monthly grid describe the portfolio you hold TODAY,
 * as a chain-linked index in your base currency (exchange rates included):
 * "how have these positions done". The actual value line (deposits and all)
 * is returned alongside, and for accounts with imported broker history
 * (`broker`), the real time- and money-weighted returns of past decisions.
 */

export interface AnalyticsPeriod {
  key: string;
  label: string;
  returnPct: number | null;
}

export interface HoldingAnalytics {
  id: number;
  name: string;
  symbol: string | null;
  assetType: HoldingType;
  currency: string;
  weightPct: number;
  baseValueCents: number;
  returns: Record<string, number | null>;
  /** Value change over 1 year at today's quantity, base currency. */
  contributionCents: number | null;
  spark: number[];
}

export interface InvestmentAnalytics {
  base: string;
  asOf: string;
  totalCents: number;
  /** First day the figures cover: when ≥80% of today's portfolio (by value) had prices. */
  since: string;
  /** Share of today's portfolio priced on that day (%). */
  coveragePct: number;
  /** False when there is too little common history for returns and risk to mean anything. */
  enoughHistory: boolean;
  index: { date: string; value: number }[];
  drawdown: { date: string; pct: number }[];
  actual: { date: string; netCents: number }[];
  periods: AnalyticsPeriod[];
  volatilityPct: number | null;
  maxDrawdown: { pct: number; peak: string; trough: string; recovered: string | null } | null;
  bestDay: { date: string; pct: number } | null;
  worstDay: { date: string; pct: number } | null;
  /** Annualized return over volatility (risk-free rate taken as 0). */
  sharpe: number | null;
  upDaysPct: number | null;
  monthly: { month: string; pct: number }[];
  holdings: HoldingAnalytics[];
  allocation: { byType: Slice[]; byCurrency: Slice[]; byRegion: Slice[]; byAccount: Slice[] };
  concentration: { top1Pct: number; top5Pct: number; effectiveHoldings: number } | null;
  /** Holdings with too little price history to include. */
  excluded: string[];
  /**
   * Accounts with imported broker history: the true time-weighted return of
   * what was actually held day by day (deposits taken out), the money-weighted
   * return (XIRR) and money in vs worth. Null without broker history.
   */
  broker: BrokerPerformance | null;
}

export interface Slice {
  key: string;
  label: string;
  cents: number;
  pct: number;
}

const SUFFIX_REGION: Record<string, string> = {
  PA: "France", DE: "Germany", F: "Germany", L: "United Kingdom", AS: "Netherlands", MI: "Italy", MC: "Spain", SW: "Switzerland",
  BR: "Belgium", LS: "Portugal", ST: "Sweden", CO: "Denmark", OL: "Norway", HE: "Finland", IR: "Ireland", VI: "Austria",
  TO: "Canada", V: "Canada", AX: "Australia", HK: "Hong Kong", T: "Japan", SS: "China", SZ: "China", NS: "India", BO: "India",
  SI: "Singapore", KS: "South Korea", SA: "Brazil", MX: "Mexico", JO: "South Africa", DU: "United Arab Emirates", AD: "United Arab Emirates", SR: "Saudi Arabia",
};

/** Where a position is listed: from the exchange suffix (CW8.PA → France); crypto and commodities are their own. */
export function regionOf(h: Pick<Holding, "symbol" | "assetType">): string {
  if (h.assetType === "crypto") return "Crypto";
  if (h.assetType === "commodity") return "Commodities";
  if (!h.symbol) return "Other";
  if (/-USD$|-EUR$/.test(h.symbol)) return "Crypto";
  if (/=F$/.test(h.symbol)) return "Commodities";
  const m = h.symbol.match(/\.([A-Z]{1,2})$/);
  return m ? (SUFFIX_REGION[m[1]] ?? m[1]) : "United States";
}

function slices(map: Map<string, { label: string; cents: number }>, total: number): Slice[] {
  return [...map]
    .map(([key, v]) => ({ key, label: v.label, cents: v.cents, pct: total ? (v.cents / total) * 100 : 0 }))
    .filter((s) => s.cents > 0)
    .sort((a, b) => b.cents - a.cents);
}

const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Share of today's portfolio (by value) that must have prices for a day to count. */
const MIN_COVERAGE = 0.8;

export function investmentAnalytics(uid: string, opts: { days?: number } = {}): InvestmentAnalytics {
  const ctx = valuationContext(uid);
  const t = ctx.today;
  const days = opts.days ?? 365;
  const from = addDays(t, -days);
  const rows: HoldingRow[] = listHoldings(uid, { ctx }).filter((h) => h.quantity > 0);
  const totalCents = rows.reduce((s, r) => s + r.baseValueCents, 0);

  // Daily closes of every held symbol over the window (plus one point before it to start from).
  const symbols = [...new Set(rows.map((r) => r.symbol).filter((s): s is string => !!s))];
  const closes = new Map<string, { date: string; close: number; currency: string }[]>();
  if (symbols.length) {
    const ps = db()
      .$client.prepare(
        `SELECT symbol, date, close, currency FROM prices WHERE symbol IN (${symbols.map(() => "?").join(",")}) AND date >= ? ORDER BY date`,
      )
      .all(...symbols, addDays(from, -10)) as { symbol: string; date: string; close: number; currency: string }[];
    for (const p of ps) closes.set(p.symbol, [...(closes.get(p.symbol) ?? []), p]);
  }
  /** A holding's unit value in the base currency on a date (null before its first known price). */
  const cursor = new Map<number, number>();
  const unitBase = (h: HoldingRow, date: string): number | null => {
    if (h.manualPrice !== null && h.manualPrice !== undefined) return ctx.fx.convert(h.manualPrice, h.currency, ctx.base, date);
    const list = h.symbol ? closes.get(h.symbol) : undefined;
    if (!list?.length) return null;
    let i = cursor.get(h.id) ?? 0;
    while (i + 1 < list.length && list[i + 1].date <= date) i++;
    cursor.set(h.id, i);
    if (list[i].date > date) return null;
    const unit = list[i].currency === h.currency ? list[i].close : ctx.fx.convert(list[i].close, list[i].currency, h.currency, date);
    return ctx.fx.convert(unit, h.currency, ctx.base, date);
  };

  const allDates: string[] = [];
  for (let d = from; d <= t; d = addDays(d, 1)) allDates.push(d);
  const allSeries = new Map<number, (number | null)[]>(rows.map((h) => [h.id, allDates.map((d) => unitBase(h, d))]));

  // Only describe the portfolio from the first day most of it (by today's value) has prices:
  // otherwise one small position with history would stand in for all of it.
  const weightOf = new Map(rows.map((h) => [h.id, totalCents ? h.baseValueCents / totalCents : 0]));
  const coverage = allDates.map((_, i) => rows.reduce((s, h) => s + (allSeries.get(h.id)![i] !== null ? weightOf.get(h.id)! : 0), 0));
  let startIdx = coverage.findIndex((c) => c >= MIN_COVERAGE);
  if (startIdx < 0) startIdx = allDates.length - 1;
  const dates = allDates.slice(startIdx);
  const series = new Map<number, (number | null)[]>(rows.map((h) => [h.id, allSeries.get(h.id)!.slice(startIdx)]));
  const since = dates[0];
  const coveragePct = Math.round((coverage[startIdx] ?? 0) * 1000) / 10;
  const enoughHistory = dates.length >= 20;

  // Chain-linked index: each day's return over the positions priced on both days.
  const index: { date: string; value: number }[] = [];
  const dailyReturns: { date: string; r: number }[] = [];
  let level = 100;
  for (let i = 0; i < dates.length; i++) {
    if (i > 0) {
      let prev = 0;
      let cur = 0;
      for (const h of rows) {
        const a = series.get(h.id)![i - 1];
        const b = series.get(h.id)![i];
        if (a === null || b === null) continue;
        prev += a * h.quantity;
        cur += b * h.quantity;
      }
      if (prev > 0) {
        const r = cur / prev - 1;
        if (Math.abs(r) > 1e-12) dailyReturns.push({ date: dates[i], r });
        level *= 1 + r;
      }
    }
    index.push({ date: dates[i], value: Math.round(level * 1000) / 1000 });
  }

  const at = (date: string) => {
    let v: number | null = null;
    for (const p of index) {
      if (p.date > date) break;
      v = p.value;
    }
    return v;
  };
  const now = index.at(-1)?.value ?? 100;
  const T = DateTime.fromISO(t);
  const refs: [string, string, string][] = [
    ["1m", "1M", T.minus({ months: 1 }).toISODate()!],
    ["3m", "3M", T.minus({ months: 3 }).toISODate()!],
    ["6m", "6M", T.minus({ months: 6 }).toISODate()!],
    ["ytd", "YTD", T.startOf("year").minus({ days: 1 }).toISODate()!],
    ["1y", "1Y", T.minus({ years: 1 }).toISODate()!],
  ];
  const periods = refs.map(([key, label, d]) => {
    const v = d >= since ? at(d) : null;
    return { key, label, returnPct: v ? Math.round((now / v - 1) * 10000) / 100 : null };
  });

  // Risk.
  const rs = dailyReturns.map((x) => x.r);
  const vol = enoughHistory && rs.length >= 20 ? stdev(rs) * Math.sqrt(252) : null;
  let peak = index[0]?.value ?? 100;
  let peakDate = index[0]?.date ?? t;
  let mdd: InvestmentAnalytics["maxDrawdown"] = null;
  const drawdown: { date: string; pct: number }[] = [];
  for (const p of index) {
    if (p.value > peak) {
      peak = p.value;
      peakDate = p.date;
    }
    const dd = (p.value / peak - 1) * 100;
    drawdown.push({ date: p.date, pct: Math.round(dd * 100) / 100 });
    if (!mdd || dd < mdd.pct) mdd = { pct: Math.round(dd * 100) / 100, peak: peakDate, trough: p.date, recovered: null };
  }
  if (mdd && mdd.pct < 0) {
    const peakValue = index.find((p) => p.date === mdd!.peak)!.value;
    mdd.recovered = index.find((p) => p.date > mdd!.trough && p.value >= peakValue)?.date ?? null;
  } else mdd = null;
  const best = dailyReturns.reduce<{ date: string; r: number } | null>((b, x) => (!b || x.r > b.r ? x : b), null);
  const worst = dailyReturns.reduce<{ date: string; r: number } | null>((b, x) => (!b || x.r < b.r ? x : b), null);
  const yearReturn = periods.find((p) => p.key === "1y")?.returnPct ?? null;
  const spanYears = Math.max(1 / 12, (DateTime.fromISO(t).diff(DateTime.fromISO(index.find((p) => p.value !== 100)?.date ?? from), "days").days || 1) / 365);
  const annualized = yearReturn ?? ((now / 100) ** (1 / spanYears) - 1) * 100;
  const sharpe = vol && vol > 0 && rs.length >= 20 && yearReturn !== null ? Math.round((annualized / 100 / vol) * 100) / 100 : null;

  // Month by month.
  const monthly: { month: string; pct: number }[] = [];
  let prevEnd: number | null = null;
  for (let i = 0; i < index.length; i++) {
    const p = index[i];
    const last = i === index.length - 1 || index[i + 1].date.slice(0, 7) !== p.date.slice(0, 7);
    if (!last) continue;
    if (prevEnd !== null) monthly.push({ month: p.date.slice(0, 7), pct: Math.round((p.value / prevEnd - 1) * 10000) / 100 });
    prevEnd = p.value;
  }

  // Per holding.
  const excluded: string[] = [];
  const yearAgoIdx = 0;
  const holdings: HoldingAnalytics[] = rows.map((h) => {
    // Each position over its own full history, whatever the portfolio's start.
    const s = allSeries.get(h.id)!;
    const valueAt = (d: string) => {
      const i = allDates.indexOf(d);
      return i >= 0 ? s[i] : null;
    };
    const last = s.at(-1);
    const returns: Record<string, number | null> = {};
    for (const [key, , d] of refs) {
      const v = d >= from ? valueAt(d) : null;
      returns[key] = v && last ? Math.round((last / v - 1) * 10000) / 100 : null;
    }
    const first = s[yearAgoIdx];
    if (first === null && !h.manualPrice && h.baseValueCents > 0) excluded.push(h.symbol ?? h.name);
    const step = Math.max(1, Math.floor(s.length / 52));
    return {
      id: h.id,
      name: h.name,
      symbol: h.symbol,
      assetType: h.assetType,
      currency: h.currency,
      weightPct: totalCents ? (h.baseValueCents / totalCents) * 100 : 0,
      baseValueCents: h.baseValueCents,
      returns,
      contributionCents: first !== null && last != null ? Math.round((last - first) * h.quantity * 100) : null,
      spark: s.filter((_, i) => i % step === 0 || i === s.length - 1).map((v) => (v === null ? NaN : Math.round(v * 100) / 100)),
    };
  });
  holdings.sort((a, b) => b.baseValueCents - a.baseValueCents);

  // Allocation and concentration.
  const typeMap = new Map<string, { label: string; cents: number }>();
  const curMap = new Map<string, { label: string; cents: number }>();
  const regMap = new Map<string, { label: string; cents: number }>();
  const accMap = new Map<string, { label: string; cents: number }>();
  for (const h of rows) {
    const add = (m: Map<string, { label: string; cents: number }>, k: string, label: string) => m.set(k, { label, cents: (m.get(k)?.cents ?? 0) + h.baseValueCents });
    add(typeMap, h.assetType, h.assetType);
    add(curMap, h.currency, h.currency);
    const reg = regionOf(h);
    add(regMap, reg, reg);
    add(accMap, String(h.accountId), h.accountName);
  }
  const weights = rows.map((h) => (totalCents ? h.baseValueCents / totalCents : 0)).sort((a, b) => b - a);
  const hhi = weights.reduce((s, w) => s + w * w, 0);

  // Actual value of the investment accounts over time (contributions included).
  const holdingAccountIds = [...new Set(rows.map((r) => r.accountId))];
  const accs = holdingAccountIds.length
    ? db().select().from(accounts).where(and(eq(accounts.userId, uid), inArray(accounts.id, holdingAccountIds))).all()
    : [];
  const snaps = snapshotsByAccount(uid, holdingAccountIds);
  const actual = allDates
    .filter((_, i) => i % 7 === 0 || i === allDates.length - 1)
    .map((d) => ({
      date: d,
      netCents: accs.reduce((s, a) => s + (a.archivedAt && a.archivedAt <= d ? 0 : withBalance(a, snaps.get(a.id) ?? [], d, ctx).baseOwnedCents), 0),
    }));

  return {
    base: ctx.base,
    asOf: t,
    totalCents,
    since,
    coveragePct,
    enoughHistory,
    index: enoughHistory ? index : [],
    drawdown: enoughHistory ? drawdown : [],
    actual,
    periods,
    volatilityPct: vol === null ? null : Math.round(vol * 10000) / 100,
    maxDrawdown: enoughHistory ? mdd : null,
    bestDay: enoughHistory && best ? { date: best.date, pct: Math.round(best.r * 10000) / 100 } : null,
    worstDay: enoughHistory && worst ? { date: worst.date, pct: Math.round(worst.r * 10000) / 100 } : null,
    sharpe,
    upDaysPct: enoughHistory && rs.length ? Math.round((rs.filter((r) => r > 0).length / rs.length) * 1000) / 10 : null,
    monthly: enoughHistory ? monthly : [],
    holdings,
    allocation: { byType: slices(typeMap, totalCents), byCurrency: slices(curMap, totalCents), byRegion: slices(regMap, totalCents), byAccount: slices(accMap, totalCents) },
    concentration: rows.length ? { top1Pct: (weights[0] ?? 0) * 100, top5Pct: weights.slice(0, 5).reduce((a, b) => a + b, 0) * 100, effectiveHoldings: hhi ? Math.round((1 / hhi) * 10) / 10 : 0 } : null,
    excluded,
    broker: brokerPerformance(uid, { days, ctx }),
  };
}
