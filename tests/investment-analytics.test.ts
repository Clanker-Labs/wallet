import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount } from "@/server/services/accounts";
import { listHoldings, upsertHolding } from "@/server/services/holdings";
import { storePrices } from "@/server/services/prices";
import { storeRates } from "@/server/services/fx";
import { investmentAnalytics, regionOf } from "@/server/services/investment-analytics";
import { addDays } from "@/lib/dates";

let uid: string;
const T = "2026-10-15";

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${T}T12:00:00Z`));
  uid = freshUser(); // base USD
});

/** Daily closes for the last `n` days ending today, from a function of the day index. */
function series(symbol: string, n: number, price: (i: number) => number, currency = "USD") {
  storePrices({ symbol, currency, closes: Array.from({ length: n + 1 }, (_, i) => ({ date: addDays(T, i - n), close: price(i) })) } as never);
}

describe("investment analytics", () => {
  it("chains a daily index, finds the drawdown and the best and worst days", async () => {
    const b = createAccount(uid, { name: "Broker", type: "brokerage", currency: "USD" });
    series("AAA", 40, (i) => (i <= 20 ? 100 + i : 120 - (i - 20) * 2)); // up to 120, then down to 80
    await upsertHolding(uid, { accountId: b.id, symbol: "AAA", quantity: 10, currency: "USD" }, { fetchPrice: false });
    const a = investmentAnalytics(uid, { days: 40 });
    expect(a.index[0].value).toBe(100);
    expect(a.index.at(-1)!.value).toBeCloseTo(80, 6);
    expect(a.maxDrawdown).toMatchObject({ pct: expect.closeTo(-33.33, 1), recovered: null });
    expect(a.bestDay!.pct).toBeCloseTo(1, 1);
    expect(a.worstDay!.pct).toBeLessThan(-1.6);
    expect(a.periods.find((p) => p.key === "1m")!.returnPct).toBeCloseTo((80 / 110 - 1) * 100, 1); // 30 days ago: day 10, 110
    expect(a.volatilityPct).toBeGreaterThan(0);
    expect(a.holdings[0]).toMatchObject({ symbol: "AAA", weightPct: 100, contributionCents: -200_00 });
  });

  it("weights positions, includes currency moves, and splits a gain into price and FX", async () => {
    storeRates({ date: addDays(T, -30), perUsd: { USD: 1, EUR: 1 } });
    storeRates({ date: T, perUsd: { USD: 1, EUR: 0.8 } }); // the euro rose 25%
    const b = createAccount(uid, { name: "PEA", type: "pea", currency: "EUR" });
    series("CW8.PA", 30, () => 50, "EUR"); // flat in euros
    series("BBB", 30, (i) => 100 + i, "USD");
    await upsertHolding(uid, { accountId: b.id, symbol: "CW8.PA", quantity: 100, currency: "EUR", costBasis: 50, purchaseDate: addDays(T, -30) }, { fetchPrice: false });
    await upsertHolding(uid, { accountId: b.id, symbol: "BBB", quantity: 10, currency: "USD" }, { fetchPrice: false });
    const a = investmentAnalytics(uid, { days: 30 });
    const cw8 = a.holdings.find((h) => h.symbol === "CW8.PA")!;
    expect(cw8.returns["1m"]).toBeCloseTo(25, 0); // all from the euro
    expect(a.allocation.byRegion.map((r) => r.key).sort()).toEqual(["France", "United States"]);
    expect(a.concentration!.effectiveHoldings).toBeGreaterThan(1);

    const h = listHoldings(uid).find((x) => x.symbol === "CW8.PA")!;
    expect(h.gainCents).toBe(0); // no price gain in euros
    expect(h.baseGainCents).toBe(1_250_00); // 5,000 € was $5,000, is $6,250
    expect(h.fxGainBaseCents).toBe(1_250_00);
    expect(h.priceGainBaseCents).toBe(0);
    expect(h.costDateEstimated).toBe(false);
  });

  it("places listings by exchange", () => {
    expect(regionOf({ symbol: "VUSA.L", assetType: "etf" })).toBe("United Kingdom");
    expect(regionOf({ symbol: "AAPL", assetType: "stock" })).toBe("United States");
    expect(regionOf({ symbol: "BTC-USD", assetType: "crypto" })).toBe("Crypto");
  });

  it("doesn't let a small position with history stand in for the whole portfolio", async () => {
    const b = createAccount(uid, { name: "Broker", type: "brokerage", currency: "USD" });
    series("OLD", 60, (i) => 100 - i); // history, falling — but tiny
    series("NEW", 0, () => 100); // today only — and most of the value
    await upsertHolding(uid, { accountId: b.id, symbol: "OLD", quantity: 1, currency: "USD" }, { fetchPrice: false });
    await upsertHolding(uid, { accountId: b.id, symbol: "NEW", quantity: 100, currency: "USD" }, { fetchPrice: false });
    const a = investmentAnalytics(uid, { days: 60 });
    expect(a.enoughHistory).toBe(false);
    expect(a.since).toBe(T);
    expect(a.periods.every((p) => p.returnPct === null)).toBe(true);
    expect(a).toMatchObject({ volatilityPct: null, maxDrawdown: null, index: [], monthly: [] });
    expect(a.excluded).toEqual(["NEW"]);
    expect(a.holdings.find((h) => h.symbol === "OLD")!.returns["1m"]).toBeLessThan(0); // its own history still shows
  });
});
