import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { db } from "@/server/db/client";
import { listAccounts, listSnapshots } from "@/server/services/accounts";
import { listHoldings } from "@/server/services/holdings";
import { createConnection, listConnections } from "@/server/services/connections";
import { storeRates } from "@/server/services/fx";
import { storePrices } from "@/server/services/prices";
import { setSetting } from "@/server/services/settings";
import { netWorthOn } from "@/server/services/networth";
import {
  brokerFlows,
  brokerPerformance,
  contributionSeries,
  investmentActivity,
  investmentIncome,
  rebuildAccountHistory,
  syncBrokerHistory,
  syncStaleBrokerHistory,
  xirr,
} from "@/server/services/broker-history";
import { parseDividend, parseOrder, parseTransaction, resetTrading212CachesForTests } from "@/server/connectors/trading212";
import { investmentAnalytics } from "@/server/services/investment-analytics";

const TODAY = "2026-10-15";

/** An /equity/history/orders item in the current API shape. */
function order(id: number, ticker: string, side: "BUY" | "SELL", qty: number, price: number, at: string, net: number, opts: { realized?: number; currency?: string; status?: string } = {}) {
  return {
    order: {
      id: id * 10,
      strategy: "QUANTITY",
      type: "MARKET",
      ticker,
      status: opts.status ?? "FILLED",
      side,
      currency: opts.currency ?? "USD",
      createdAt: at,
      instrument: { ticker, name: ticker.split("_")[0], isin: "XX", currency: opts.currency ?? "USD" },
    },
    fill: {
      id,
      quantity: side === "SELL" ? -qty : qty,
      price,
      type: "TRADE",
      filledAt: at,
      walletImpact: { currency: "EUR", netValue: net, fxRate: 0.9, ...(opts.realized !== undefined ? { realisedProfitLoss: opts.realized } : {}), taxes: [] },
    },
  };
}

const ORDERS = [
  // Newest first, like the API.
  order(6, "SAPd_EQ", "SELL", 1, 120, "2026-10-06T10:00:00.000Z", 120, { realized: 20, currency: "EUR" }),
  order(5, "AAPL_US_EQ", "BUY", 1, 160, "2026-10-05T15:00:00.000Z", 145),
  order(4, "SAPd_EQ", "BUY", 1, 100, "2026-10-03T10:00:00.000Z", 100, { currency: "EUR" }),
  order(3, "AAPL_US_EQ", "BUY", 2, 150, "2026-10-02T15:00:00.000Z", 270),
  order(2, "AAPL_US_EQ", "BUY", 5, 140, "2026-10-01T15:00:00.000Z", 0, { status: "CANCELLED" }),
];
const DIVIDENDS = [
  { ticker: "AAPL_US_EQ", instrument: { ticker: "AAPL_US_EQ", name: "Apple", isin: "US0378331005", currency: "USD" }, reference: "div-1", quantity: 3, amount: 0.5, currency: "EUR", grossAmountPerShare: 0.2, paidOn: "2026-10-08T13:44:51.000+03:00", type: "DIVIDEND" },
];
const TRANSACTIONS = [
  { type: "WITHDRAW", amount: 200, currency: "EUR", reference: "tx-3", dateTime: "2026-10-12T09:00:00.000Z" },
  { type: "INTEREST_ON_FREE_CASH", amount: 0.2, currency: "EUR", reference: "tx-2", dateTime: "2026-10-10T01:16:50.604Z" },
  { type: "DEPOSIT", amount: 1000, currency: "EUR", reference: "tx-1", dateTime: "2026-10-01T08:00:00.000Z" },
];

interface Fake {
  pageSize: number;
  /** Answer 429 from this page (0-based) of the orders endpoint. */
  ordersRateLimitAt?: number;
  forbidden?: boolean;
}

function fakeT212(f: Fake) {
  const calls: string[] = [];
  const page = (items: unknown[], path: string, url: URL) => {
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const slice = items.slice(start, start + f.pageSize);
    const next = start + f.pageSize < items.length ? `/api/v0${path}?limit=50&cursor=${start + f.pageSize}` : null;
    return Response.json({ items: slice, nextPagePath: next });
  };
  const impl = (async (raw: string) => {
    calls.push(raw);
    const url = new URL(raw);
    const p = url.pathname.replace("/api/v0", "");
    if (p === "/equity/account/info") return Response.json({ id: 4242, currencyCode: "EUR" });
    if (p === "/equity/account/cash") return Response.json({ free: 405.7, pieCash: 0, blocked: 0 });
    if (p === "/equity/portfolio") return Response.json([{ ticker: "AAPL_US_EQ", quantity: 3, averagePrice: 153.33, currentPrice: 200 }]);
    if (p === "/equity/metadata/instruments") return Response.json([{ ticker: "AAPL_US_EQ", name: "Apple", currencyCode: "USD", type: "STOCK" }, { ticker: "SAPd_EQ", name: "SAP", currencyCode: "EUR", type: "STOCK" }]);
    if (f.forbidden && p.includes("history")) return new Response("{}", { status: 403 });
    if (p === "/equity/history/orders") {
      const n = calls.filter((c) => c.includes("/equity/history/orders")).length - 1;
      if (f.ordersRateLimitAt !== undefined && n >= f.ordersRateLimitAt) return new Response("{}", { status: 429 });
      return page(ORDERS, p, url);
    }
    if (p === "/equity/history/dividends") return page(DIVIDENDS, p, url);
    if (p === "/history/transactions") return page(TRANSACTIONS, p, url);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

let uid: string;
const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

async function connect(f: Fake) {
  const t212 = fakeT212(f);
  const { connection } = await createConnection(
    uid,
    { provider: "trading212", environment: "live", credentials: { apiKey: "k", apiSecret: "s" } },
    { fetchImpl: t212.impl, fetchPrices: false, history: false },
  );
  return { t212, connection };
}

const snap = (accountId: number, date: string) => listSnapshots(uid, accountId).find((s) => s.date === date);

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  uid = freshUser();
  setSetting(uid, "currency", "EUR");
  resetTrading212CachesForTests();
  storeRates({ date: "2026-01-01", perUsd: { USD: 1, EUR: 0.9 } });
  sleeps.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Trading 212 history parsing", () => {
  it("reads fills, dividends and cash movements, signed for the account's cash", () => {
    expect(parseOrder(ORDERS[0])).toMatchObject({ kind: "trade", externalId: "6", ticker: "SAPd_EQ", symbol: "SAP.DE", quantity: -1, price: 120, cash: 120, realized: 20, currency: "EUR" });
    expect(parseOrder(ORDERS[3])).toMatchObject({ quantity: 2, price: 150, priceCurrency: "USD", cash: -270, symbol: "AAPL" });
    expect(parseOrder(ORDERS[4])).toBeNull(); // cancelled
    expect(parseOrder({ order: { status: "FILLED" } })).toBeNull(); // no fill
    // Pence become pounds.
    expect(parseOrder(order(9, "VUSAl_EQ", "BUY", 1, 8000, "2026-10-01T10:00:00Z", 80, { currency: "GBX" }))).toMatchObject({ price: 80, priceCurrency: "GBP", symbol: "VUSA.L" });
    // The older flat shape.
    expect(parseOrder({ id: 7, ticker: "AAPL_US_EQ", status: "FILLED", filledQuantity: -2, fillPrice: 10, filledValue: -20, dateExecuted: "2026-01-02T00:00:00Z" })).toMatchObject({ quantity: -2, cash: 20 });
    expect(parseDividend(DIVIDENDS[0])).toMatchObject({ kind: "dividend", externalId: "div-1", cash: 0.5, name: "Apple" });
    expect(parseTransaction(TRANSACTIONS[0])).toMatchObject({ kind: "withdrawal", cash: -200 });
    expect(parseTransaction(TRANSACTIONS[1])).toMatchObject({ kind: "interest", cash: 0.2 });
    expect(parseTransaction({ type: "FEE", amount: 1.5, currency: "EUR", reference: "f", dateTime: "2026-01-01T00:00:00Z" })).toMatchObject({ kind: "fee", cash: -1.5 });
    expect(parseTransaction({ type: "TRANSFER", amount: -50, currency: "EUR", reference: "t", dateTime: "2026-01-01T00:00:00Z" })).toMatchObject({ kind: "withdrawal", cash: -50 });
  });
});

describe("importing history", () => {
  it("pages every endpoint at the broker's pace and stores each event once", async () => {
    const { t212, connection } = await connect({ pageSize: 2 });
    const r = await syncBrokerHistory(uid, connection.id, { fetchImpl: t212.impl, sleep });
    expect(r).toMatchObject({ ok: true, incomplete: false, added: { trade: 4, dividend: 1, deposit: 1, interest: 1, withdrawal: 1 } });
    // Orders came in 3 pages, transactions in 2: a pause before each later page.
    expect(t212.calls.filter((c) => c.includes("/equity/history/orders"))).toHaveLength(3);
    expect(sleeps).toEqual([3_200, 3_200, 3_200]);
    // Only paths on the same API are followed.
    expect(t212.calls.every((c) => c.startsWith("https://live.trading212.com/api/v0/"))).toBe(true);
    expect(listConnections(uid)[0]).toMatchObject({ historyStatus: "ok" });
    expect(listConnections(uid)[0].historySyncedAt).toBeInstanceOf(Date);

    // A full re-read adds nothing; an incremental one stops at the first page already known.
    expect((await syncBrokerHistory(uid, connection.id, { fetchImpl: t212.impl, sleep, full: true })).added).toEqual({});
    const before = t212.calls.length;
    const inc = await syncBrokerHistory(uid, connection.id, { fetchImpl: t212.impl, sleep });
    expect(inc.added).toEqual({});
    expect(t212.calls.length - before).toBe(3); // one page per endpoint
    expect((db().$client.prepare("SELECT count(*) AS n FROM broker_activity").get() as { n: number }).n).toBe(8);
  });

  it("keeps what came when the broker says to slow down, and says it is incomplete", async () => {
    const { t212, connection } = await connect({ pageSize: 2, ordersRateLimitAt: 1 });
    const r = await syncBrokerHistory(uid, connection.id, { fetchImpl: t212.impl, sleep });
    expect(r.ok).toBe(true);
    expect(r.incomplete).toBe(true);
    expect(r.added.trade).toBe(2);
    expect(r.warnings[0]).toMatch(/rate limit/);
    expect(listConnections(uid)[0].historyStatus).toBe("incomplete");
  });

  it("explains a key without the history permission", async () => {
    const { t212, connection } = await connect({ pageSize: 50, forbidden: true });
    const r = await syncBrokerHistory(uid, connection.id, { fetchImpl: t212.impl, sleep });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/History permissions/);
    expect(listConnections(uid)[0].historyStatus).toMatch(/History permissions/);
    // …and isn't retried on every background run.
    const { log } = await syncStaleBrokerHistory({ fetchImpl: t212.impl, sleep });
    expect(log).toEqual([]);
  });
});

describe("rebuilding the past", () => {
  it("anchors on today's positions and cash, valuing days with fills or market closes", async () => {
    const { t212, connection } = await connect({ pageSize: 50 });
    const acc = connection.accountId;
    // A market close on the 13th wins over the older fill price from then on.
    storePrices({ symbol: "AAPL", name: null, currency: "USD", assetType: "stock", closes: [{ date: "2026-10-13", close: 210 }] });
    await syncBrokerHistory(uid, connection.id, { fetchImpl: t212.impl, sleep });

    const v = (d: string) => snap(acc, d)?.balanceCents;
    expect(snap(acc, "2026-09-30")).toBeUndefined();
    expect(v("2026-10-01")).toBe(1_000_00); // the deposit, nothing bought yet
    expect(v("2026-10-02")).toBe(1_000_00); // 2 AAPL at 150 USD (270 €) + 730 € cash
    expect(v("2026-10-03")).toBe(1_000_00); // + SAP at 100 €
    expect(v("2026-10-05")).toBe(1_017_00); // 3 AAPL at 160 USD = 432 €, SAP 100, cash 485
    expect(v("2026-10-06")).toBe(1_037_00); // SAP sold for 120
    expect(v("2026-10-12")).toBe(837_70); // after the withdrawal (dividend and interest in)
    expect(v("2026-10-13")).toBe(972_70); // 3 × 210 USD
    expect(snap(acc, "2026-10-13")!.source).toBe("rebuilt");
    expect(snap(acc, "2026-10-13")!.note).toBe("Rebuilt from Trading 212 history");
    // Today stays the live value; before the first event there is nothing.
    expect(snap(acc, TODAY)!.source).toBe("holdings");
    expect(netWorthOn(uid, "2026-10-05").netCents).toBe(1_017_00);
    expect(netWorthOn(uid, "2026-09-20").netCents).toBe(0);
    // The position's purchase date: the value-weighted mean of its buys.
    expect(listHoldings(uid, { accountId: acc }).find((h) => h.symbol === "AAPL")!.purchaseDate).toBe("2026-10-03");
  });

  it("never overwrites a balance recorded some other way, and starts over cleanly", async () => {
    const { t212, connection } = await connect({ pageSize: 50 });
    const acc = connection.accountId;
    db().$client.prepare("INSERT INTO balance_snapshots (account_id, date, balance_cents, source) VALUES (?, '2026-10-04', 99_900, 'manual')").run(acc);
    await syncBrokerHistory(uid, connection.id, { fetchImpl: t212.impl, sleep });
    expect(snap(acc, "2026-10-04")).toMatchObject({ balanceCents: 99_900, source: "manual" });
    const n = listSnapshots(uid, acc).filter((s) => s.source === "rebuilt").length;
    expect(rebuildAccountHistory(uid, acc).days).toBe(14);
    expect(listSnapshots(uid, acc).filter((s) => s.source === "rebuilt")).toHaveLength(n);
    expect(n).toBe(13);
  });
});

describe("returns, flows and income", () => {
  it("separates money in from performance", async () => {
    const { t212, connection } = await connect({ pageSize: 50 });
    storePrices({ symbol: "AAPL", name: null, currency: "USD", assetType: "stock", closes: [{ date: "2026-10-13", close: 210 }] });
    await syncBrokerHistory(uid, connection.id, { fetchImpl: t212.impl, sleep });
    expect(brokerFlows(uid, connection.accountId)).toEqual([
      { date: "2026-10-01", cents: 1_000_00 },
      { date: "2026-10-12", cents: -200_00 },
    ]);

    const live = listAccounts(uid).find((a) => a.id === connection.accountId)!.balanceCents;
    expect(live).toBe(945_70); // 3 × 200 USD + 405.70 cash

    const c = contributionSeries(uid, { days: 30 })!;
    expect(c).toMatchObject({ depositedCents: 800_00, valueCents: 945_70, gainCents: 145_70 });
    expect(c.points.find((p) => p.date === "2026-10-05")).toEqual({ date: "2026-10-05", depositedCents: 1_000_00, valueCents: 1_017_00 });

    const perf = brokerPerformance(uid, { days: 30 })!;
    expect(perf.since).toBe("2026-10-01");
    // The withdrawal is not a loss: 1000 → 1037.70, then 837.70 → 945.70.
    expect(perf.twrPct).toBeCloseTo(((1037.7 / 1000) * (945.7 / 837.7) - 1) * 100, 1);
    expect(perf.xirrPct).toBeNull(); // two weeks: not annualised
    expect(investmentAnalytics(uid, { days: 30 }).broker?.twrPct).toBe(perf.twrPct);

    const inc = investmentIncome(uid, { months: 3 });
    expect(inc.months.map((m) => m.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(inc.months[2]).toEqual({ month: "2026-10", dividendsCents: 50, interestCents: 20, realizedCents: 20_00 });
    expect(inc.ytd).toEqual({ dividendsCents: 50, interestCents: 20, realizedCents: 20_00 });

    const act = investmentActivity(uid, { kind: "trade", limit: 2 });
    expect(act.total).toBe(4);
    expect(act.rows.map((r) => r.ticker)).toEqual(["SAPd_EQ", "AAPL_US_EQ"]);
    expect(act.totals).toMatchObject({ boughtCents: 515_00, soldCents: 120_00, realizedCents: 20_00 });
    expect(investmentActivity(uid, { ticker: "AAPL" }).total).toBe(3); // two buys and the dividend
  });

  it("computes a money-weighted annual return", () => {
    expect(xirr([{ date: "2025-01-01", cents: -1_000_00 }, { date: "2026-01-01", cents: 1_100_00 }])).toBeCloseTo(0.1, 4);
    expect(xirr([{ date: "2025-01-01", cents: -1_000_00 }])).toBeNull();
  });
});
