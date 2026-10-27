import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { archiveAccount, createAccount, recordBalance } from "@/server/services/accounts";
import { upsertHolding } from "@/server/services/holdings";
import { netWorthHistory, netWorthOn } from "@/server/services/networth";

let uid: string;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  uid = freshUser();
});

describe("history only shows what wallet knew", () => {
  it("gives an investment account no value before it was added", async () => {
    const pea = createAccount(uid, { name: "PEA", type: "pea", currency: "USD" });
    await upsertHolding(uid, { accountId: pea.id, name: "Gold coins", assetType: "commodity", quantity: 10, manualPrice: 100 }, { fetchPrice: false });
    expect(netWorthOn(uid).netCents).toBe(1_000_00);
    expect(netWorthOn(uid, "2026-09-01").netCents).toBe(0); // not a year of invented history
  });

  it("drops an archived brokerage from today's point of the monthly chart", async () => {
    const b = createAccount(uid, { name: "Broker", type: "brokerage", currency: "USD" });
    await upsertHolding(uid, { accountId: b.id, name: "Leftover", assetType: "stock", quantity: 1, manualPrice: 500 }, { fetchPrice: false });
    archiveAccount(uid, b.id);
    expect(netWorthHistory(uid, 3).at(-1)!.netCents).toBe(0);
    expect(netWorthOn(uid).netCents).toBe(0);
  });

  it("refuses a balance a loan's schedule would silently ignore", () => {
    const loan = createAccount(uid, {
      name: "Mortgage",
      type: "mortgage",
      loanParams: { principal: 200_000, annualRatePct: 3, durationMonths: 240, startDate: "2024-01-05" },
    });
    expect(() => recordBalance(uid, { accountId: loan.id, balance: 150_000 })).toThrow(/amortization schedule/);
  });
});
