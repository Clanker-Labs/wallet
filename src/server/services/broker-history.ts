import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "@/server/db/client";
import { accounts, brokerConnections, type Account, type BrokerActivityKind, type BrokerConnection, type Holding } from "@/server/db/schema";
import { CONNECTORS, ConnectorError, getConnector, type BrokerActivity, type FetchLike } from "@/server/connectors";
import { decryptSecret } from "@/server/secrets";
import { addDays } from "@/lib/dates";
import { getAccountRow, snapshotsByAccount, withBalance } from "./accounts";
import { fxConverter } from "./fx";
import { getSettings, today } from "./settings";
import { listUsers } from "./users";
import { valuationContext, valueHolding, type ValuationContext } from "./valuation";

/**
 * A brokerage's history — fills, dividends, deposits, withdrawals, interest,
 * fees — imported into `broker_activity`, then used to rebuild the account's
 * value on every past day.
 *
 * The rebuild is anchored on today: positions and cash are what the broker
 * reports now, and each day before is today minus everything that happened
 * after it. A gap in old history then only blurs the far past, never today.
 * Positions are valued with the market close of the day when there is one,
 * else the price of the nearest fill (a broker's own trades are real prices),
 * else today's price.
 */

/** Pseudo-instrument id of a synced account's cash line (see connections.ts). */
const CASH_ID = "__cash__";
const QTY_EPSILON = 1e-6;
/** Background history imports skip connections fresher than this. */
const HISTORY_STALE_MS = 12 * 3_600_000;
const FLOW_KINDS: BrokerActivityKind[] = ["deposit", "withdrawal"];

const running = new Set<number>();

export interface HistorySyncResult {
  ok: boolean;
  connectionId: number;
  accountId: number;
  /** Events new to wallet, by kind. */
  added: Partial<Record<BrokerActivityKind, number>>;
  fetched: number;
  incomplete: boolean;
  warnings: string[];
  rebuiltDays: number;
  error?: string;
  /** Another import of the same connection was already running. */
  skipped?: boolean;
}

function connectionRow(uid: string, id: number): BrokerConnection {
  const row = db()
    .select()
    .from(brokerConnections)
    .where(and(eq(brokerConnections.id, id), eq(brokerConnections.userId, uid)))
    .get();
  if (!row) throw new Error(`Connection ${id} not found`);
  return row;
}

const localDate = (at: string, zone: string) => {
  const dt = DateTime.fromISO(at, { setZone: true });
  return (dt.isValid ? dt.setZone(zone) : DateTime.fromMillis(Date.parse(at)).setZone(zone)).toISODate() ?? at.slice(0, 10);
};

/**
 * Import a connection's history (incremental after a complete first import,
 * unless `full`), then rebuild the account's past values. Broker problems come
 * back as `ok: false` and are kept on the connection; never throws for them.
 */
export async function syncBrokerHistory(
  uid: string,
  connectionId: number,
  opts: { fetchImpl?: FetchLike; full?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<HistorySyncResult> {
  const row = connectionRow(uid, connectionId);
  const result: HistorySyncResult = { ok: false, connectionId, accountId: row.accountId, added: {}, fetched: 0, incomplete: false, warnings: [], rebuiltDays: 0 };
  const connector = getConnector(row.provider);
  if (!connector.fetchHistory) return { ...result, error: `${connector.name} doesn't expose its history` };
  if (running.has(connectionId)) return { ...result, skipped: true, error: "An import of this connection is already running" };
  running.add(connectionId);
  const setStatus = (historyStatus: string, synced: boolean) =>
    db()
      .update(brokerConnections)
      .set(synced ? { historyStatus, historySyncedAt: new Date() } : { historyStatus })
      .where(eq(brokerConnections.id, connectionId))
      .run();
  try {
    setStatus("running", false);
    const account = getAccountRow(uid, row.accountId);
    const zone = getSettings(uid).timezone;
    const known = db().$client.prepare("SELECT 1 FROM broker_activity WHERE account_id = ? AND kind = ? AND external_id = ?");
    const incremental = !opts.full && row.historyStatus === "ok" && !!row.historySyncedAt;
    const credentials = JSON.parse(decryptSecret(row.credentials)) as Record<string, string>;
    const history = await connector.fetchHistory({
      credentials,
      environment: row.environment,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      isKnown: incremental ? (kind, id) => !!known.get(account.id, kind, id) : undefined,
    });
    result.fetched = history.activities.length;
    result.incomplete = history.incomplete;
    result.warnings = [...history.warnings];
    result.added = storeActivities(uid, account, row.id, history.activities, zone, result.warnings);
    setStatus(history.incomplete ? "incomplete" : "ok", true);
    result.rebuiltDays = rebuildAccountHistory(uid, account.id).days;
    result.ok = true;
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    try {
      // The attempt is dated too, so a key without the permission is retried twice a day, not every run.
      setStatus(error, true);
    } catch {}
    if (!(e instanceof ConnectorError)) console.warn(`[broker-history] connection ${connectionId}: ${error}`);
    return { ...result, error };
  } finally {
    running.delete(connectionId);
  }
}

function storeActivities(uid: string, account: Account, connectionId: number, activities: BrokerActivity[], zone: string, warnings: string[]) {
  const fx = fxConverter();
  const insert = db().$client.prepare(
    `INSERT OR IGNORE INTO broker_activity
       (user_id, account_id, connection_id, kind, external_id, at, date, ticker, symbol, name, quantity, price, price_currency, cash_cents, currency, realized_cents)
     VALUES (@uid, @accountId, @connectionId, @kind, @externalId, @at, @date, @ticker, @symbol, @name, @quantity, @price, @priceCurrency, @cashCents, @currency, @realizedCents)`,
  );
  const added: Partial<Record<BrokerActivityKind, number>> = {};
  const unconverted = new Set<string>();
  db().$client.transaction(() => {
    for (const a of activities) {
      const date = localDate(a.at, zone);
      const from = a.currency || account.currency;
      // Amounts arrive in the account's currency; anything else is converted at that day's rate.
      const rate = fx.rate(from, account.currency, date);
      if (rate === null) unconverted.add(from);
      const cents = (v: number) => Math.round(v * (rate ?? 1) * 100);
      const res = insert.run({
        uid,
        accountId: account.id,
        connectionId,
        kind: a.kind,
        externalId: a.externalId,
        at: a.at,
        date,
        ticker: a.ticker,
        symbol: a.symbol ? a.symbol.toUpperCase() : null,
        name: a.name,
        quantity: a.quantity,
        price: a.price,
        priceCurrency: a.priceCurrency,
        cashCents: cents(a.cash),
        currency: account.currency,
        realizedCents: a.realized === null ? null : cents(a.realized),
      });
      if (res.changes) added[a.kind] = (added[a.kind] ?? 0) + 1;
    }
  })();
  if (unconverted.size) warnings.push(`No exchange rate for ${[...unconverted].join(", ")}: amounts kept as they came`);
  return added;
}

interface ActRow {
  kind: BrokerActivityKind;
  date: string;
  ticker: string | null;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  priceCurrency: string | null;
  cashCents: number;
}

/**
 * Write the account's value for every day from its first imported event to
 * yesterday, as `rebuilt` snapshots. Snapshots of any other source (recorded
 * by hand, or by the daily holdings snapshot) are real observations and stay.
 */
export function rebuildAccountHistory(uid: string, accountId: number): { days: number; from: string | null; to: string | null; unpriced: string[] } {
  const account = getAccountRow(uid, accountId);
  const c = db().$client;
  const acts = c
    .prepare(
      `SELECT kind, date, ticker, symbol, quantity, price, price_currency AS priceCurrency, cash_cents AS cashCents
       FROM broker_activity WHERE account_id = ? AND user_id = ? ORDER BY date, id`,
    )
    .all(account.id, uid) as ActRow[];
  const clear = c.prepare("DELETE FROM balance_snapshots WHERE account_id = ? AND source = 'rebuilt'");
  const ctx = valuationContext(uid);
  const t = ctx.today;
  const end = addDays(t, -1);
  if (!acts.length || account.archivedAt || acts[0].date > end) {
    clear.run(account.id);
    return { days: 0, from: null, to: null, unpriced: [] };
  }

  const held = ctx.holdingsByAccount.get(account.id) ?? [];
  const synced = held.filter((h) => h.connectionId !== null && h.externalId && h.externalId !== CASH_ID);
  const manual = held.filter((h) => h.connectionId === null);
  const cashLine = held.find((h) => h.externalId === CASH_ID);
  let cash = cashLine ? Math.round(ctx.fx.convert(cashLine.quantity, cashLine.currency, account.currency, t) * 100) : 0;

  // Per instrument: today's quantity, its symbol and currency, and every fill price.
  interface Line {
    qty: number;
    symbol: string | null;
    currency: string;
    holding: Holding | null;
    fills: { date: string; price: number; currency: string }[];
  }
  const lines = new Map<string, Line>();
  for (const h of synced) lines.set(h.externalId!, { qty: h.quantity, symbol: h.symbol, currency: h.currency, holding: h, fills: [] });
  for (const a of acts) {
    if (a.kind !== "trade" || !a.ticker) continue;
    const line = lines.get(a.ticker) ?? { qty: 0, symbol: a.symbol, currency: a.priceCurrency ?? account.currency, holding: null, fills: [] };
    if (!line.symbol && a.symbol) line.symbol = a.symbol;
    if (a.price !== null && a.price > 0) line.fills.push({ date: a.date, price: a.price, currency: a.priceCurrency ?? line.currency });
    lines.set(a.ticker, line);
  }

  const lastFillOnOrBefore = (fills: Line["fills"], d: string) => {
    let lo = 0;
    let hi = fills.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fills[mid].date <= d) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  const unpriced = new Set<string>();
  /** One unit of an instrument on a day, in the account currency. */
  const unitValue = (ticker: string, line: Line, d: string): number => {
    const market = line.symbol ? ctx.price(line.symbol, d) : null;
    const i = lastFillOnOrBefore(line.fills, d);
    const fill = i >= 0 ? line.fills[i] : null;
    let price: number | null = null;
    let currency = line.currency;
    if (market && (!fill || market.date >= fill.date)) [price, currency] = [market.close, market.currency];
    else if (fill) [price, currency] = [fill.price, fill.currency];
    else if (line.fills.length) [price, currency] = [line.fills[0].price, line.fills[0].currency];
    else if (line.holding) {
      const v = valueHolding(line.holding, t, ctx);
      if (v.unitPrice !== null) [price, currency] = [v.unitPrice, line.holding.currency];
    }
    if (price === null) {
      unpriced.add(ticker);
      return 0;
    }
    return ctx.fx.convert(price, currency, account.currency, d);
  };

  const rows: { date: string; cents: number }[] = [];
  const firstHeld = new Map<string, string>();
  const streakBroken = new Set<string>();
  let k = acts.length - 1;
  for (let d = end; d >= acts[0].date; d = addDays(d, -1)) {
    // Undo everything that happened after day d.
    while (k >= 0 && acts[k].date > d) {
      const a = acts[k--];
      cash -= a.cashCents;
      if (a.kind === "trade" && a.ticker && a.quantity !== null) lines.get(a.ticker)!.qty -= a.quantity;
    }
    let value = 0;
    for (const [ticker, line] of lines) {
      if (line.qty > QTY_EPSILON) {
        value += line.qty * unitValue(ticker, line, d);
        if (!streakBroken.has(ticker)) firstHeld.set(ticker, d);
      } else streakBroken.add(ticker);
    }
    for (const h of manual) value += ctx.fx.convert(valueHolding(h, d, ctx).value, h.currency, account.currency, d);
    rows.push({ date: d, cents: Math.round(value * 100) + cash });
  }

  const provider = c.prepare("SELECT provider FROM broker_connections WHERE account_id = ?").get(account.id) as { provider: string } | undefined;
  const brokerName = CONNECTORS.find((x) => x.id === provider?.provider)?.name ?? "broker";
  const insert = c.prepare(
    "INSERT OR IGNORE INTO balance_snapshots (account_id, date, balance_cents, note, source) VALUES (?, ?, ?, ?, 'rebuilt')",
  );
  const purchase = c.prepare("UPDATE holdings SET purchase_date = ? WHERE id = ? AND purchase_date IS NULL");
  c.transaction(() => {
    clear.run(account.id);
    for (const r of rows) insert.run(account.id, r.date, r.cents, `Rebuilt from ${brokerName} history`);
    // When a position was bought, on average (by value), since it was last at zero.
    for (const [ticker, line] of lines) {
      if (!line.holding || line.holding.purchaseDate) continue;
      const start = firstHeld.get(ticker);
      const buys = acts.filter((a) => a.kind === "trade" && a.ticker === ticker && (a.quantity ?? 0) > 0 && (!start || a.date >= start));
      const weight = buys.reduce((s, a) => s + Math.abs(a.cashCents), 0);
      if (!weight) continue;
      const meanDay = buys.reduce((s, a) => s + DateTime.fromISO(a.date).toMillis() * Math.abs(a.cashCents), 0) / weight;
      purchase.run(DateTime.fromMillis(meanDay, { zone: "utc" }).toISODate(), line.holding.id);
    }
  })();
  return { days: rows.length, from: acts[0].date, to: end, unpriced: [...unpriced] };
}

/** Money put in (positive) or taken out (negative) of an account per day, in its currency. */
export function brokerFlows(uid: string, accountId: number, from?: string, to?: string): { date: string; cents: number }[] {
  return db()
    .$client.prepare(
      `SELECT date, sum(cash_cents) AS cents FROM broker_activity
       WHERE user_id = ? AND account_id = ? AND kind IN ('deposit', 'withdrawal') AND date >= ? AND date <= ?
       GROUP BY date ORDER BY date`,
    )
    .all(uid, accountId, from ?? "0000-01-01", to ?? "9999-12-31") as { date: string; cents: number }[];
}

export interface ActivityFilter {
  accountId?: number;
  kind?: BrokerActivityKind;
  ticker?: string;
  limit?: number;
  offset?: number;
}

export interface ActivityTotals {
  boughtCents: number;
  soldCents: number;
  dividendsCents: number;
  interestCents: number;
  depositedCents: number;
  withdrawnCents: number;
  feesCents: number;
  realizedCents: number;
}

/** Imported broker events, newest first, with totals of the whole filtered set in the base currency. */
export function investmentActivity(uid: string, filter: ActivityFilter = {}) {
  const where = ["b.user_id = @uid"];
  if (filter.accountId) where.push("b.account_id = @accountId");
  if (filter.kind) where.push("b.kind = @kind");
  if (filter.ticker) where.push("(b.ticker = @ticker OR b.symbol = upper(@ticker))");
  const params = { uid, accountId: filter.accountId ?? null, kind: filter.kind ?? null, ticker: filter.ticker ?? null };
  const c = db().$client;
  const sqlWhere = where.join(" AND ");
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const rows = c
    .prepare(
      `SELECT b.id, b.account_id AS accountId, a.name AS accountName, b.kind, b.date, b.at, b.ticker, b.symbol, b.name,
              b.quantity, b.price, b.price_currency AS priceCurrency, b.cash_cents AS cashCents, b.currency,
              b.realized_cents AS realizedCents
       FROM broker_activity b JOIN accounts a ON a.id = b.account_id
       WHERE ${sqlWhere} ORDER BY b.at DESC, b.id DESC LIMIT ${limit} OFFSET ${offset}`,
    )
    .all(params) as {
    id: number;
    accountId: number;
    accountName: string;
    kind: BrokerActivityKind;
    date: string;
    at: string;
    ticker: string | null;
    symbol: string | null;
    name: string | null;
    quantity: number | null;
    price: number | null;
    priceCurrency: string | null;
    cashCents: number;
    currency: string;
    realizedCents: number | null;
  }[];
  const total = (c.prepare(`SELECT count(*) AS n FROM broker_activity b WHERE ${sqlWhere}`).get(params) as { n: number }).n;
  const base = getSettings(uid).currency;
  const fx = fxConverter();
  const totals: ActivityTotals = { boughtCents: 0, soldCents: 0, dividendsCents: 0, interestCents: 0, depositedCents: 0, withdrawnCents: 0, feesCents: 0, realizedCents: 0 };
  const all = c
    .prepare(`SELECT b.kind, b.date, b.cash_cents AS cashCents, b.realized_cents AS realizedCents, b.currency FROM broker_activity b WHERE ${sqlWhere}`)
    .all(params) as { kind: BrokerActivityKind; date: string; cashCents: number; realizedCents: number | null; currency: string }[];
  for (const r of all) {
    const v = fx.convertCents(r.cashCents, r.currency, base, r.date);
    if (r.kind === "trade") {
      if (v < 0) totals.boughtCents += -v;
      else totals.soldCents += v;
      if (r.realizedCents) totals.realizedCents += fx.convertCents(r.realizedCents, r.currency, base, r.date);
    } else if (r.kind === "dividend") totals.dividendsCents += v;
    else if (r.kind === "interest") totals.interestCents += v;
    else if (r.kind === "deposit") totals.depositedCents += v;
    else if (r.kind === "withdrawal") totals.withdrawnCents += -v;
    else if (r.kind === "fee") totals.feesCents += -v;
  }
  return { base, rows, total, limit, offset, totals };
}

/** Dividends, interest and realised gains per month (base currency), and their totals this year and over the window. */
export function investmentIncome(uid: string, opts: { months?: number } = {}) {
  const months = Math.min(Math.max(opts.months ?? 12, 1), 120);
  const base = getSettings(uid).currency;
  const t = today(uid);
  const first = DateTime.fromISO(t).startOf("month").minus({ months: months - 1 });
  const keys: string[] = [];
  for (let i = 0; i < months; i++) keys.push(first.plus({ months: i }).toFormat("yyyy-MM"));
  const byMonth = new Map(keys.map((m) => [m, { month: m, dividendsCents: 0, interestCents: 0, realizedCents: 0 }]));
  const fx = fxConverter();
  const rows = db()
    .$client.prepare(
      `SELECT kind, date, cash_cents AS cashCents, realized_cents AS realizedCents, currency FROM broker_activity
       WHERE user_id = ? AND date >= ? AND (kind IN ('dividend', 'interest') OR (kind = 'trade' AND realized_cents IS NOT NULL))`,
    )
    .all(uid, `${keys[0]}-01`) as { kind: BrokerActivityKind; date: string; cashCents: number; realizedCents: number | null; currency: string }[];
  for (const r of rows) {
    const m = byMonth.get(r.date.slice(0, 7));
    if (!m) continue;
    if (r.kind === "dividend") m.dividendsCents += fx.convertCents(r.cashCents, r.currency, base, r.date);
    else if (r.kind === "interest") m.interestCents += fx.convertCents(r.cashCents, r.currency, base, r.date);
    else m.realizedCents += fx.convertCents(r.realizedCents!, r.currency, base, r.date);
  }
  const list = [...byMonth.values()];
  const sum = (xs: typeof list) => ({
    dividendsCents: xs.reduce((s, x) => s + x.dividendsCents, 0),
    interestCents: xs.reduce((s, x) => s + x.interestCents, 0),
    realizedCents: xs.reduce((s, x) => s + x.realizedCents, 0),
  });
  // Year to date is always the whole year so far, whatever the window.
  const ytdRows = db()
    .$client.prepare(
      `SELECT kind, date, cash_cents AS cashCents, realized_cents AS realizedCents, currency FROM broker_activity
       WHERE user_id = ? AND date >= ? AND (kind IN ('dividend', 'interest') OR (kind = 'trade' AND realized_cents IS NOT NULL))`,
    )
    .all(uid, `${t.slice(0, 4)}-01-01`) as typeof rows;
  const ytd = { dividendsCents: 0, interestCents: 0, realizedCents: 0 };
  for (const r of ytdRows) {
    if (r.kind === "dividend") ytd.dividendsCents += fx.convertCents(r.cashCents, r.currency, base, r.date);
    else if (r.kind === "interest") ytd.interestCents += fx.convertCents(r.cashCents, r.currency, base, r.date);
    else ytd.realizedCents += fx.convertCents(r.realizedCents!, r.currency, base, r.date);
  }
  return { base, months: list, total: sum(list), ytd };
}

/** Accounts of the user that have imported broker history. */
function historyAccounts(uid: string): Account[] {
  const ids = (db().$client.prepare("SELECT DISTINCT account_id AS id FROM broker_activity WHERE user_id = ?").all(uid) as { id: number }[]).map((r) => r.id);
  if (!ids.length) return [];
  return db()
    .select()
    .from(accounts)
    .where(eq(accounts.userId, uid))
    .all()
    .filter((a) => ids.includes(a.id));
}

interface DailyBroker {
  base: string;
  dates: string[];
  /** Your share of the accounts' value, base currency. */
  value: number[];
  /** Net money in that day (your share), base currency. */
  flow: number[];
  /** Net money in before the first date. */
  flowBefore: number;
  /** Every flow ever, for a money-weighted return. */
  allFlows: { date: string; cents: number }[];
}

function dailyBroker(uid: string, days: number, ctx: ValuationContext = valuationContext(uid)): DailyBroker | null {
  const accs = historyAccounts(uid);
  if (!accs.length) return null;
  const t = ctx.today;
  const from = addDays(t, -days);
  const snaps = snapshotsByAccount(uid, accs.map((a) => a.id));
  const dates: string[] = [];
  for (let d = from; d <= t; d = addDays(d, 1)) dates.push(d);
  const index = new Map(dates.map((d, i) => [d, i]));
  const value = dates.map((d) =>
    accs.reduce((s, a) => s + (a.includeInNetWorth && (!a.archivedAt || a.archivedAt > d) ? withBalance(a, snaps.get(a.id) ?? [], d, ctx).baseOwnedCents : 0), 0),
  );
  const flow = dates.map(() => 0);
  let flowBefore = 0;
  const allFlows: { date: string; cents: number }[] = [];
  for (const a of accs) {
    if (!a.includeInNetWorth) continue;
    for (const f of brokerFlows(uid, a.id)) {
      const cents = Math.round((ctx.fx.convertCents(f.cents, a.currency, ctx.base, f.date) * a.ownershipPct) / 100);
      allFlows.push({ date: f.date, cents });
      const i = index.get(f.date);
      if (i !== undefined) flow[i] += cents;
      else if (f.date < from) flowBefore += cents;
    }
  }
  allFlows.sort((x, y) => x.date.localeCompare(y.date));
  return { base: ctx.base, dates, value, flow, flowBefore, allFlows };
}

/** Per day: money put in so far vs what it is worth (base currency), for a "money in vs worth" chart. */
export function contributionSeries(uid: string, opts: { days?: number } = {}) {
  const daily = dailyBroker(uid, opts.days ?? 365);
  if (!daily) return null;
  let deposited = daily.flowBefore;
  const points = daily.dates.map((date, i) => {
    deposited += daily.flow[i];
    return { date, depositedCents: deposited, valueCents: daily.value[i] };
  });
  const last = points.at(-1)!;
  return { base: daily.base, points, depositedCents: last.depositedCents, valueCents: last.valueCents, gainCents: last.valueCents - last.depositedCents };
}

/** Annual money-weighted return (XIRR) of dated cash flows, investor's view (money in is negative). */
export function xirr(flows: { date: string; cents: number }[]): number | null {
  if (flows.length < 2 || !flows.some((f) => f.cents < 0) || !flows.some((f) => f.cents > 0)) return null;
  const t0 = DateTime.fromISO(flows[0].date);
  const ts = flows.map((f) => DateTime.fromISO(f.date).diff(t0, "days").days / 365);
  if (ts.at(-1)! < 30 / 365) return null; // annualising a few weeks says nothing
  const npv = (r: number) => flows.reduce((s, f, i) => s + f.cents / (1 + r) ** ts[i], 0);
  let lo = -0.9999;
  let hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export interface BrokerPerformance {
  base: string;
  since: string;
  /** Time-weighted index (100 at `since`): what the portfolio did, deposits and withdrawals taken out. */
  index: { date: string; value: number }[];
  periods: { key: string; label: string; returnPct: number | null }[];
  twrPct: number | null;
  /** Annual money-weighted return since the first deposit: what your timing earned. */
  xirrPct: number | null;
  depositedCents: number;
  valueCents: number;
  gainCents: number;
}

/** True returns of the accounts with broker history: time-weighted from daily values and flows, plus XIRR. */
export function brokerPerformance(uid: string, opts: { days?: number; ctx?: ValuationContext } = {}): BrokerPerformance | null {
  const daily = dailyBroker(uid, opts.days ?? 365, opts.ctx);
  if (!daily) return null;
  const start = daily.value.findIndex((v) => v > 0);
  if (start < 0) return null;
  const index: { date: string; value: number }[] = [];
  let level = 100;
  for (let i = start; i < daily.dates.length; i++) {
    if (i > start) {
      const prev = daily.value[i - 1];
      // r = (V_t − F_t) / V_{t−1} − 1: the day's flow is money in, not performance.
      if (prev > 0) level *= (daily.value[i] - daily.flow[i]) / prev;
    }
    index.push({ date: daily.dates[i], value: Math.round(level * 1000) / 1000 });
  }
  const now = index.at(-1)!.value;
  const T = DateTime.fromISO(daily.dates.at(-1)!);
  const at = (d: string) => index.findLast((p) => p.date <= d)?.value ?? null;
  const refs: [string, string, string][] = [
    ["1m", "1M", T.minus({ months: 1 }).toISODate()!],
    ["3m", "3M", T.minus({ months: 3 }).toISODate()!],
    ["6m", "6M", T.minus({ months: 6 }).toISODate()!],
    ["ytd", "YTD", T.startOf("year").minus({ days: 1 }).toISODate()!],
    ["1y", "1Y", T.minus({ years: 1 }).toISODate()!],
  ];
  const periods = refs.map(([key, label, d]) => {
    const v = d >= index[0].date ? at(d) : null;
    return { key, label, returnPct: v ? Math.round((now / v - 1) * 10000) / 100 : null };
  });
  const valueCents = daily.value.at(-1)!;
  const depositedCents = daily.flowBefore + daily.flow.reduce((a, b) => a + b, 0);
  const cashflows = [...daily.allFlows.map((f) => ({ date: f.date, cents: -f.cents })), { date: daily.dates.at(-1)!, cents: valueCents }];
  const r = xirr(cashflows);
  return {
    base: daily.base,
    since: index[0].date,
    index,
    periods,
    twrPct: index.length > 1 ? Math.round((now / 100 - 1) * 10000) / 100 : null,
    xirrPct: r === null ? null : Math.round(r * 10000) / 100,
    depositedCents,
    valueCents,
    gainCents: valueCents - depositedCents,
  };
}

/** History status of each connection that can import one. */
export function historyStatus(uid: string) {
  return db()
    .select({ id: brokerConnections.id, accountId: brokerConnections.accountId, provider: brokerConnections.provider, historySyncedAt: brokerConnections.historySyncedAt, historyStatus: brokerConnections.historyStatus })
    .from(brokerConnections)
    .where(eq(brokerConnections.userId, uid))
    .all()
    .map((r) => ({ ...r, running: running.has(r.id), events: (db().$client.prepare("SELECT count(*) AS n FROM broker_activity WHERE account_id = ?").get(r.accountId) as { n: number }).n }));
}

/**
 * Every connection whose history is older than 12 hours (or never imported),
 * one at a time. For the background refresh; never throws.
 */
export async function syncStaleBrokerHistory(opts: { fetchImpl?: FetchLike; now?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ log: string[] }> {
  const log: string[] = [];
  const now = opts.now ?? Date.now();
  for (const u of listUsers()) {
    let rows: BrokerConnection[] = [];
    try {
      rows = db().select().from(brokerConnections).where(eq(brokerConnections.userId, u.id)).all();
    } catch (e) {
      log.push(`⚠️ history: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const row of rows) {
      if (!CONNECTORS.find((c) => c.id === row.provider)?.fetchHistory) continue;
      // Fresh, or failed recently (a key without the history permission): twice a day is enough.
      // An incomplete import (rate limit) carries on at the next run.
      const fresh = row.historySyncedAt && now - row.historySyncedAt.getTime() < HISTORY_STALE_MS;
      if (fresh && row.historyStatus !== "incomplete") continue;
      const r = await syncBrokerHistory(u.id, row.id, { fetchImpl: opts.fetchImpl, sleep: opts.sleep });
      if (r.ok) {
        const n = Object.values(r.added).reduce((a, b) => a + (b ?? 0), 0);
        log.push(`🗂️ ${row.provider} #${row.id} history: ${n} new events, ${r.rebuiltDays} days rebuilt${r.incomplete ? " (more next run)" : ""}`);
      } else if (!r.skipped) log.push(`⚠️ ${row.provider} #${row.id} history: ${r.error}`);
    }
  }
  return { log };
}
