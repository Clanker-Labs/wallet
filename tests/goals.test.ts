import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount, recordBalance } from "@/server/services/accounts";
import { listGoals, saveGoal } from "@/server/services/goals";
import { storeRates } from "@/server/services/fx";

let uid: string;
beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  uid = freshUser();
  storeRates({ date: "2026-01-01", perUsd: { USD: 1, EUR: 0.8 } });
});

describe("goals", () => {
  it("measures progress on linked accounts in the goal's currency, and the monthly need", () => {
    const fund = createAccount(uid, { name: "Deposit fund", type: "savings", currency: "USD", initialBalance: 20_000 });
    createAccount(uid, { name: "Other", type: "checking", currency: "USD", initialBalance: 99_000 });
    saveGoal(uid, { name: "Flat deposit", target: 40_000, currency: "EUR", targetDate: "2027-10-15", accountIds: [fund.id], monthly: 1_000 });
    const [g] = listGoals(uid);
    expect(g.currentCents).toBe(16_000_00); // $20,000 at 0.8
    expect(g.pct).toBeCloseTo(40, 6);
    expect(g.monthsLeft).toBe(12);
    expect(g.neededMonthlyCents).toBe(2_000_00);
    expect(g).toMatchObject({ paceSource: "plan", projectedDate: "2028-10-15", onTrack: false });
  });

  it("uses the whole net worth when no account is linked, and is reached", () => {
    const a = createAccount(uid, { name: "Cash", type: "checking", currency: "USD", initialBalance: 5_000 });
    saveGoal(uid, { name: "First 5k", target: 5_000 });
    expect(listGoals(uid)[0]).toMatchObject({ pct: 100, remainingCents: 0, onTrack: null });
    recordBalance(uid, { accountId: a.id, balance: 2_500 });
    expect(listGoals(uid)[0]).toMatchObject({ pct: 50, paceSource: "none", projectedDate: null });
  });
});
