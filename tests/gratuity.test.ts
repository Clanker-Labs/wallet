import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { gratuityOn, gratuityParamsSchema, serviceYears, type GratuityParams } from "@/lib/finance/gratuity";
import { archiveAccount, createAccount, listAccounts, recordBalance } from "@/server/services/accounts";
import { changePct, netWorthDaily, netWorthMoves, netWorthOn } from "@/server/services/networth";
import { db } from "@/server/db/client";
import { fxRates } from "@/server/db/schema";

const job = (p: Partial<GratuityParams> & Pick<GratuityParams, "country">): GratuityParams =>
  gratuityParamsSchema.parse({ startDate: "2020-01-01", salaries: [{ from: "2020-01-01", monthly: 10_000 }], ...p });

describe("gratuity rules", () => {
  it("counts calendar years, exactly 1 on the anniversary", () => {
    expect(serviceYears("2020-01-01", "2021-01-01")).toBe(1);
    expect(serviceYears("2020-01-01", "2020-07-01")).toBeCloseTo(0.5, 1);
    expect(serviceYears("2020-01-01", "2019-01-01")).toBe(0);
  });

  it("UAE: 21 days a year for 5 years, 30 after, from 1 year, on basic ÷ 30", () => {
    const p = job({ country: "AE" });
    expect(gratuityOn(p, "2020-12-31")).toMatchObject({ amount: 0, eligible: false, next: { date: "2021-01-01" } });
    expect(gratuityOn(p, "2023-01-01").amount).toBe(21_000); // 3 × 21 days × 333.33
    expect(gratuityOn(p, "2027-01-01").amount).toBe(55_000); // (105 + 60) days
    expect(gratuityOn(p, "2027-01-01").next).toBeNull();
    // Resigning changes nothing under the 2021 law.
    expect(gratuityOn(p, "2027-01-01", "termination").amount).toBe(55_000);
  });

  it("UAE: capped at two years' pay", () => {
    expect(gratuityOn(job({ country: "AE" }), "2050-01-01").amount).toBe(240_000);
  });

  it("uses the salary in force at the end, and stops at the end date", () => {
    const salaries = [
      { from: "2020-01-01", monthly: 10_000 },
      { from: "2025-06-01", monthly: 12_000 },
    ];
    expect(gratuityOn(job({ country: "AE", salaries }), "2027-01-01").amount).toBe(66_000);
    const ended = job({ country: "AE", salaries, endDate: "2026-01-01" });
    expect(gratuityOn(ended, "2030-01-01").amount).toBe(54_000); // 6 years, frozen
    expect(gratuityOn(ended, "2030-01-01").next).toBeNull();
  });

  it("Saudi Arabia: half a month then a month a year, reduced on resignation", () => {
    const p = job({ country: "SA", salaries: [{ from: "2020-01-01", monthly: 9_000 }] });
    expect(gratuityOn(p, "2027-01-01", "termination").amount).toBe(40_500);
    expect(gratuityOn(p, "2027-01-01", "resignation").amount).toBe(27_000); // ⅔ from 5 years
    expect(gratuityOn(p, "2023-01-01", "resignation").amount).toBe(4_500); // ⅓ of 13,500
    expect(gratuityOn(p, "2021-07-01", "resignation")).toMatchObject({ amount: 0, eligible: false });
    expect(gratuityOn(p, "2030-01-01", "resignation").amount).toBe(67_500); // in full from 10
  });

  it("Qatar: three weeks of basic a year, from 1 year", () => {
    const p = job({ country: "QA", salaries: [{ from: "2020-01-01", monthly: 6_000 }] });
    expect(gratuityOn(p, "2022-01-01").amount).toBe(8_400);
    expect(gratuityOn(p, "2020-06-01").amount).toBe(0);
  });

  it("France: indemnité légale on dismissal only, ¼ then ⅓ month a year", () => {
    const p = job({ country: "FR", salaries: [{ from: "2020-01-01", monthly: 4_000 }], scenario: "termination" });
    expect(gratuityOn(p, "2032-01-01").amount).toBeCloseTo(12_666.67, 2);
    expect(gratuityOn(p, "2032-01-01", "resignation").amount).toBe(0);
    expect(gratuityOn(p, "2020-07-01").amount).toBe(0); // under 8 months
  });

  it("DIFC: DEWS contributions of 5.83% then 8.33% a month", () => {
    const p = job({ country: "AE_DIFC" });
    expect(gratuityOn(p, "2021-01-01").amount).toBeCloseTo(6_996, 0);
    expect(gratuityOn(p, "2026-01-01").amount).toBeCloseTo(34_980 + 9_996, 0);
  });

  it("custom: days a year after a minimum, with a cap", () => {
    const p = job({ country: "CUSTOM", salaries: [{ from: "2020-01-01", monthly: 3_000 }], custom: { daysPerYear: 30, minYears: 1, capMonths: 12 } });
    expect(gratuityOn(p, "2022-01-01").amount).toBe(6_000);
    expect(gratuityOn(p, "2040-01-01").amount).toBe(36_000);
    expect(() => gratuityParamsSchema.parse({ country: "CUSTOM", startDate: "2020-01-01", salaries: [{ from: "2020-01-01", monthly: 1 }] })).toThrow();
  });
});

describe("jobs in net worth", () => {
  let uid: string;
  beforeEach(() => {
    process.env.WALLET_TIMEZONE = "UTC";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    uid = freshUser();
  });

  const addJob = () =>
    createAccount(uid, {
      name: "Acme",
      type: "end_of_service",
      currency: "USD",
      gratuityParams: { country: "AE", startDate: "2023-10-15", salaries: [{ from: "2023-10-15", monthly: 3_000 }] },
    });

  it("counts the accrued gratuity as a retirement asset, derived every day", () => {
    const acc = addJob();
    const nw = netWorthOn(uid);
    expect(nw.byClassCents.retirement).toBe(6_300_00); // 3 years × 21 days × 100
    const a = listAccounts(uid).find((x) => x.id === acc.id)!;
    expect(a.derivedFromJob).toBe(true);
    expect(netWorthOn(uid, "2026-10-14").netCents).toBeLessThan(nw.netCents);
  });

  it("needs its terms, refuses manual balances, and archiving pays it out", () => {
    expect(() => createAccount(uid, { name: "Bare", type: "end_of_service" })).toThrow(/gratuityParams/);
    const acc = addJob();
    expect(() => recordBalance(uid, { accountId: acc.id, balance: 500 })).toThrow(/is a job/);
    archiveAccount(uid, acc.id);
    expect(netWorthOn(uid).netCents).toBe(0);
  });

  it("plots daily from the job's start and explains the move", () => {
    addJob();
    createAccount(uid, { name: "Checking", type: "checking", initialBalance: 1_000 });
    const days = netWorthDaily(uid, 30);
    expect(days).toHaveLength(31);
    expect(days.at(-1)!.date).toBe("2026-10-15");
    const { current, moves } = netWorthMoves(uid);
    const week = moves.find((m) => m.key === "1w")!;
    expect(week.movers.map((m) => m.driver).sort()).toEqual(["balance", "job"]);
    // The movers add up to the headline change.
    expect(week.movers.reduce((s, m) => s + m.deltaCents, 0)).toBe(week.deltaCents);
    expect(current.netCents - week.deltaCents).toBe(netWorthOn(uid, week.fromDate).netCents);
  });

  it("labels a move that is only the exchange rate", () => {
    db().insert(fxRates).values([
      { date: "2026-10-01", currency: "EUR", perUsd: 0.9 },
      { date: "2026-10-15", currency: "EUR", perUsd: 0.8 },
    ]).run();
    const flat = createAccount(uid, { name: "Flat", type: "real_estate", currency: "EUR" });
    recordBalance(uid, { accountId: flat.id, balance: 90_000, date: "2026-09-01" });
    const month = netWorthMoves(uid).moves.find((m) => m.key === "1m")!;
    expect(month.movers).toEqual([expect.objectContaining({ name: "Flat", driver: "fx", deltaCents: 112_500_00 - 100_000_00 })]);
  });

  it("gives no percentage against a near-zero start", () => {
    expect(changePct(100, 1_000_000)).toBeNull();
    expect(changePct(0, 5)).toBeNull();
    expect(changePct(1_000, 1_100)).toBeCloseTo(10, 6);
  });
});
