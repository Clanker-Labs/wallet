import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount } from "@/server/services/accounts";
import { addTransaction } from "@/server/services/transactions";
import { ensureHistoricalRates, fxConverter, storeRates } from "@/server/services/fx";

let uid: string;
const calls: string[] = [];

/** Fake Frankfurter series + currency-api: EUR drifts, AED stays pegged. */
const fakeFetch = (async (input: string | URL) => {
  const url = String(input);
  calls.push(url);
  const series = url.match(/frankfurter\.dev\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/);
  if (series) {
    const rates: Record<string, Record<string, number>> = {};
    if (series[1] <= "2025-03-10" && series[2] >= "2025-03-10") rates["2025-03-10"] = { EUR: 0.95, GBP: 0.8 };
    if (series[1] <= "2026-01-02" && series[2] >= "2026-01-02") rates["2026-01-02"] = { EUR: 0.85, GBP: 0.74 };
    return new Response(JSON.stringify({ base: "USD", rates }));
  }
  const day = url.match(/currency-api@(\d{4}-\d{2}-\d{2})/);
  if (day) {
    const usd: Record<string, number> = { aed: 3.6725, eur: 0.9, gbp: 0.78, sar: 3.75, jpy: 150, chf: 0.88 };
    return new Response(JSON.stringify({ date: day[1], usd }));
  }
  return new Response("nope", { status: 404 });
}) as typeof fetch;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  uid = freshUser();
  calls.length = 0;
  storeRates({ date: "2026-10-15", perUsd: { USD: 1, EUR: 0.86, GBP: 0.75, AED: 3.6725, CHF: 0.8, JPY: 140, SAR: 3.75 } });
});

describe("historical exchange rates", () => {
  it("fills past ECB days and month-ends for the rest, so the past uses past rates", async () => {
    createAccount(uid, { name: "Emirates NBD", type: "checking", currency: "AED" });
    addTransaction(uid, { date: "2025-03-10", amount: -100, currency: "EUR", description: "Old flat repair" });
    // Before: only today's rate exists, so March 2025 converts at today's rate.
    expect(fxConverter().rate("EUR", "USD", "2025-03-10")).toBeCloseTo(1 / 0.86, 6);

    const r = await ensureHistoricalRates({ force: true, fetchImpl: fakeFetch });
    expect(r.days).toBe(2);
    expect(r.monthEnds).toBeGreaterThan(10);
    expect(calls.filter((c) => c.includes("frankfurter.dev/v1/2025-03-10..2025-12-31"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("frankfurter.dev/v1/2026-01-01..2026-10-15"))).toHaveLength(1);

    const fx = fxConverter();
    expect(fx.rate("EUR", "USD", "2025-03-10")).toBeCloseTo(1 / 0.95, 6);
    expect(fx.rate("EUR", "USD", "2026-01-05")).toBeCloseTo(1 / 0.85, 6); // carries the last ECB day forward
    expect(fx.rate("AED", "USD", "2025-04-15")).toBeCloseTo(1 / 3.6725, 6); // from the March month-end
    expect(fx.missing.size).toBe(0);
  });

  it("does nothing more once covered, and never throws when every source is down", async () => {
    addTransaction(uid, { date: "2026-09-01", amount: -10, currency: "EUR", description: "x" });
    await ensureHistoricalRates({ force: true, fetchImpl: fakeFetch });
    calls.length = 0;
    await ensureHistoricalRates({ force: true, fetchImpl: fakeFetch });
    expect(calls.filter((c) => c.includes("frankfurter"))).toHaveLength(1); // still thin: 2 days in 6 weeks, asks again
    const down = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(ensureHistoricalRates({ force: true, fetchImpl: down })).resolves.toMatchObject({ error: expect.stringContaining("offline") });
  });
});
