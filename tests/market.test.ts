import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount, listAccounts, listSnapshots } from "@/server/services/accounts";
import { upsertHolding } from "@/server/services/holdings";
import { latestFxDate } from "@/server/services/fx";
import { refreshMarketData, refreshMarketDataInBackground } from "@/server/services/market";

const TODAY = "2026-10-15";

/** Free FX + Yahoo chart endpoints, answered locally. */
function fakeMarket() {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    if (url.includes("currency-api")) return Response.json({ date: TODAY, usd: { eur: 0.9, gbp: 0.75, jpy: 150, chf: 0.8 } });
    if (url.includes("finance/chart/VTI")) {
      return Response.json({
        chart: { result: [{ meta: { symbol: "VTI", currency: "USD", instrumentType: "ETF", gmtoffset: 0 }, timestamp: [Date.parse(`${TODAY}T20:00:00Z`) / 1000], indicators: { quote: [{ close: [300] }] } }] },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

let uid: string;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T21:00:00Z`));
  uid = freshUser();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("market data refresh", () => {
  it("updates rates and prices, then snapshots holdings accounts", async () => {
    const brokerage = createAccount(uid, { name: "Brokerage", type: "brokerage" });
    await upsertHolding(uid, { accountId: brokerage.id, symbol: "VTI", assetType: "etf", quantity: 10 }, { fetchPrice: false });
    const market = fakeMarket();

    const { log } = await refreshMarketData({ fetchImpl: market.impl });

    expect(latestFxDate()).toBe(TODAY);
    expect(log).toEqual([`💱 rates updated to ${TODAY}`, "📈 prices updated: VTI"]);
    expect(listAccounts(uid).find((a) => a.id === brokerage.id)!.balanceCents).toBe(3_000_00);
    expect(listSnapshots(uid, brokerage.id).map((s) => [s.date, s.balanceCents])).toContainEqual([TODAY, 3_000_00]);
  });

  it("reports failures without throwing", async () => {
    const brokerage = createAccount(uid, { name: "Brokerage", type: "brokerage" });
    await upsertHolding(uid, { accountId: brokerage.id, symbol: "NOPE", quantity: 1 }, { fetchPrice: false });
    const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    // (Rates were just attempted by the previous test, so ensureFreshRates is throttled here.)
    const { log } = await refreshMarketData({ fetchImpl: down });
    expect(log.some((l) => l.startsWith("⚠️ prices") && l.includes("NOPE"))).toBe(true);
    expect(listSnapshots(uid, brokerage.id)).toHaveLength(1); // still snapshotted, from the stored (missing) price
  });

  it("runs at most every 30 minutes from the web app", async () => {
    const brokerage = createAccount(uid, { name: "Brokerage", type: "brokerage" });
    await upsertHolding(uid, { accountId: brokerage.id, symbol: "VTI", quantity: 1 }, { fetchPrice: false });
    const market = fakeMarket();
    vi.stubGlobal("fetch", market.impl);
    const t0 = Date.now();
    await refreshMarketDataInBackground(t0);
    const first = market.calls.length;
    expect(first).toBeGreaterThan(0);
    await refreshMarketDataInBackground(t0 + 10 * 60_000);
    expect(market.calls.length).toBe(first);
    expect(listSnapshots(uid, brokerage.id)).toHaveLength(1);
  });
});
