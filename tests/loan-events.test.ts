import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { amortizationSchedule, interestBetween, loanEndDate, loanSchedule, monthlyPayment, paymentOn, scheduleBalanceOn } from "@/lib/finance/loan";
import { createAccount, getAccount } from "@/server/services/accounts";
import { netWorthOn } from "@/server/services/networth";
import type { LoanParams } from "@/lib/domain";

const base: LoanParams = { principal: 200_000, annualRatePct: 3, durationMonths: 240, startDate: "2024-01-05" };

describe("loan schedule with events", () => {
  it("equals the plain schedule without events", () => {
    const a = amortizationSchedule(200_000, 3, 240);
    const b = loanSchedule(base);
    expect(b).toHaveLength(240);
    expect(b[119].balance).toBeCloseTo(a[119].balance, 6);
    expect(b[0].date).toBe("2024-01-05");
    expect(b[1].date).toBe("2024-02-05");
  });

  it("lowers the payment after an early repayment that keeps the end date", () => {
    const p = { ...base, events: [{ date: "2026-01-20", type: "prepayment" as const, amount: 30_000, keep: "duration" as const }] };
    const before = paymentOn(base, "2026-03-01");
    const after = paymentOn(p, "2026-03-01");
    expect(after).toBeLessThan(before - 150);
    expect(loanEndDate(p)).toBe(loanEndDate(base));
    expect(scheduleBalanceOn(p, "2026-01-25")).toBeCloseTo(scheduleBalanceOn(base, "2026-01-25") - 30_000, 2);
  });

  it("ends sooner when the payment is kept, and costs less interest", () => {
    const p = { ...base, events: [{ date: "2026-01-20", type: "prepayment" as const, amount: 30_000, keep: "payment" as const }] };
    expect(paymentOn(p, "2026-03-01")).toBeCloseTo(monthlyPayment(200_000, 3, 240), 6);
    expect(loanEndDate(p)! < loanEndDate(base)!).toBe(true);
    expect(interestBetween(p, "2024-01-01", "2060-01-01")).toBeLessThan(interestBetween(base, "2024-01-01", "2060-01-01") - 10_000);
  });

  it("recomputes the payment after a renegotiated rate", () => {
    const p = { ...base, events: [{ date: "2025-06-01", type: "rate_change" as const, ratePct: 2 }] };
    const balance = scheduleBalanceOn(base, "2025-05-31");
    const rows = loanSchedule(p).filter((r) => r.kind === "payment");
    const left = rows.filter((r) => r.date >= "2025-06-01").length;
    expect(paymentOn(p, "2025-07-01")).toBeCloseTo(monthlyPayment(balance, 2, left), 4);
    expect(rows.at(-1)!.balance).toBeCloseTo(0, 6);
    // A year's interest for the tax view.
    expect(interestBetween(base, "2025-01-01", "2025-12-31")).toBeGreaterThan(interestBetween(p, "2025-01-01", "2025-12-31"));
  });
});

describe("loan accounts follow their events", () => {
  beforeEach(() => {
    process.env.WALLET_TIMEZONE = "UTC";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  });
  it("shows the balance after an early repayment", () => {
    const uid = freshUser();
    const plain = createAccount(uid, { name: "M1", type: "mortgage", currency: "USD", loanParams: base });
    const repaid = createAccount(uid, { name: "M2", type: "mortgage", currency: "USD", loanParams: { ...base, events: [{ date: "2026-01-20", type: "prepayment", amount: 30_000 }] } });
    const owed = (id: number) => netWorthOn(uid).accounts.find((a) => a.id === id)!.balanceCents;
    // Same end date, so lower payments: the 30,000 gap narrows a little each month after.
    const gap = owed(plain.id) - owed(repaid.id);
    expect(gap).toBeGreaterThan(28_000_00);
    expect(gap).toBeLessThan(30_000_00);
    expect(getAccount(uid, repaid.id).account.loanParams!.events).toHaveLength(1);
  });
});
