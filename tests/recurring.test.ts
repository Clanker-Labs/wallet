import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount } from "@/server/services/accounts";
import { addTransaction, importTransactions, listTransactions } from "@/server/services/transactions";
import { findCategory } from "@/server/services/categories";
import {
  createRecurring,
  detectRecurring,
  forecastCash,
  listRecurring,
  payeeKey,
  reconcileRecurring,
  recordOccurrence,
  recurringNudges,
  recurringSummary,
  upcoming,
} from "@/server/services/recurring";

let uid: string;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  uid = freshUser(); // base USD
});

const checking = () => createAccount(uid, { name: "Checking", type: "checking", currency: "USD", initialBalance: 5_000 });

describe("payee keys", () => {
  it("keep the payee and drop what changes every month", () => {
    expect(payeeKey("CB NETFLIX.COM 12/09 AMSTERDAM 4X23")).toBe(payeeKey("CB NETFLIX.COM 14/10 AMSTERDAM 9Q81"));
    expect(payeeKey("PRLV SEPA FREE MOBILE 123456789")).toBe("free mobile");
  });
});

describe("detection", () => {
  it("finds monthly bills and salary, not irregular shopping", () => {
    const a = checking();
    for (const m of ["05", "06", "07", "08", "09", "10"])
      addTransaction(uid, { date: `2026-${m}-03`, amount: -15.99, accountId: a.id, description: `CB NETFLIX.COM ${m}/03 REF${m}99`, categoryId: null });
    for (const m of ["05", "06", "07", "08", "09"])
      addTransaction(uid, { date: `2026-${m}-28`, amount: 8_000, accountId: a.id, description: "SALARY ACME LLC", categoryId: null });
    for (const [d, amt] of [["2026-09-02", -54], ["2026-09-09", -12], ["2026-09-30", -140], ["2026-10-11", -33]] as const)
      addTransaction(uid, { date: d, amount: amt, accountId: a.id, description: "CARREFOUR MARKET", categoryId: null });

    const found = detectRecurring(uid);
    const netflix = found.find((f) => f.pattern.includes("netflix"))!;
    expect(netflix).toMatchObject({ cadence: "monthly", amount: -15.99, nextDate: "2026-11-03", accountId: a.id });
    expect(found.find((f) => f.pattern.includes("salary"))).toMatchObject({ cadence: "monthly", amount: 8_000 });
    expect(found.find((f) => f.pattern.includes("carrefour"))).toBeUndefined();
  });
});

describe("expectations, matched against real payments", () => {
  it("links the payment, moves to the next date, and notices a price rise", () => {
    const a = checking();
    const rent = createRecurring(uid, { name: "Rent", pattern: "loyer", accountId: a.id, amount: -1_500, cadence: "monthly", nextDate: "2026-09-05" });
    const nf = createRecurring(uid, { name: "Netflix", pattern: "netflix", accountId: a.id, amount: -15.99, cadence: "monthly", nextDate: "2026-09-03", tolerancePct: 20 });
    addTransaction(uid, { date: "2026-09-06", amount: -1_500, accountId: a.id, description: "VIR LOYER SEPT", categoryId: null });
    addTransaction(uid, { date: "2026-10-04", amount: -1_500, accountId: a.id, description: "VIR LOYER OCT", categoryId: null });
    addTransaction(uid, { date: "2026-09-03", amount: -15.99, accountId: a.id, description: "NETFLIX.COM", categoryId: null });
    addTransaction(uid, { date: "2026-10-03", amount: -17.99, accountId: a.id, description: "NETFLIX.COM", categoryId: null });

    const items = listRecurring(uid);
    expect(items.find((r) => r.id === rent.id)).toMatchObject({ nextDate: "2026-11-05", lastMatchedDate: "2026-10-04" });
    const netflix = items.find((r) => r.id === nf.id)!;
    expect(netflix).toMatchObject({ nextDate: "2026-11-03", amountCents: -17_99, lastChangePct: 12.5 });
    expect(recurringNudges(uid)).toContainEqual({ kind: "price", text: "Netflix went up 12.5%" });
    expect(listTransactions(uid).rows.filter((r) => r.recurringId !== null)).toHaveLength(4);
  });

  it("flags a salary that hasn't arrived, links it if a late statement brings it, and skips it only when the next one comes", () => {
    const a = checking();
    createRecurring(uid, { name: "Salary", pattern: "salary", accountId: a.id, amount: 8_000, cadence: "monthly", nextDate: "2026-09-01" });
    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    reconcileRecurring(uid);
    // Time alone moves nothing on: September is still late, waiting for its statement.
    expect(listRecurring(uid)[0].nextDate).toBe("2026-09-01");
    expect(upcoming(uid, 0)[0]).toMatchObject({ name: "Salary", status: "late" });
    expect(recurringNudges(uid)[0]).toMatchObject({ kind: "late" });
    // September's statement comes in late: it still links.
    addTransaction(uid, { date: "2026-09-01", amount: 8_000, accountId: a.id, description: "SALARY ACME", categoryId: null });
    expect(listRecurring(uid)[0].nextDate).toBe("2026-10-01");
    // October never came, November did: October was missed.
    addTransaction(uid, { date: "2026-11-02", amount: 8_000, accountId: a.id, description: "SALARY ACME", categoryId: null });
    expect(listRecurring(uid)[0]).toMatchObject({ nextDate: "2026-12-01", lastMatchedDate: "2026-11-02" });
  });

  it("records a cash payment, and a later statement row takes it over instead of duplicating it", () => {
    const a = checking();
    const rent = createRecurring(uid, { name: "Rent", pattern: "loyer", accountId: a.id, amount: -1_500, cadence: "monthly", nextDate: "2026-10-05" });
    recordOccurrence(uid, rent.id);
    expect(listRecurring(uid)[0].nextDate).toBe("2026-11-05");
    const r = importTransactions(uid, [{ date: "2026-10-07", amount: -1_500, description: "VIR LOYER OCTOBRE" }], a.id);
    expect(r).toMatchObject({ inserted: 0, adopted: 1, duplicates: 0 });
    const rows = listTransactions(uid).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-10-07", description: "VIR LOYER OCTOBRE", recurringId: rent.id });
    // Importing the same file again is a plain duplicate now.
    expect(importTransactions(uid, [{ date: "2026-10-07", amount: -1_500, description: "VIR LOYER OCTOBRE" }], a.id)).toMatchObject({ inserted: 0, duplicates: 1 });
  });
});

describe("forecast and summary", () => {
  it("projects cash from today's balance and the schedule", () => {
    const a = checking();
    createRecurring(uid, { name: "Salary", pattern: "salary", accountId: a.id, amount: 8_000, cadence: "monthly", nextDate: "2026-10-28" });
    createRecurring(uid, { name: "Rent", pattern: "loyer", accountId: a.id, amount: -1_500, cadence: "monthly", nextDate: "2026-11-05" });
    const f = forecastCash(uid, 30);
    expect(f.points[0].cents).toBe(5_000_00);
    expect(f.points.at(-1)!.cents).toBe(5_000_00 + 8_000_00 - 1_500_00);
    expect(recurringSummary(uid)).toMatchObject({ monthlyIncomeCents: 8_000_00, monthlyFixedCents: 1_500_00, freeCents: 6_500_00 });
    void findCategory;
  });
});
