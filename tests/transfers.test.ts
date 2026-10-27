import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount } from "@/server/services/accounts";
import { addTransaction, importTransactions, listTransactions } from "@/server/services/transactions";
import { budgetStatus } from "@/server/services/budgets";
import { findCategory } from "@/server/services/categories";
import { findTransferPairs, matchTransfers } from "@/server/services/transfers";
import { storeRates } from "@/server/services/fx";

let uid: string;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  uid = freshUser();
  storeRates({ date: "2026-10-01", perUsd: { USD: 1, AED: 3.6725, EUR: 0.9 } });
});

describe("transfer matching", () => {
  it("pairs an AED → EUR move across the FX spread, and budgets stop counting it", () => {
    const enbd = createAccount(uid, { name: "Emirates NBD", type: "checking", currency: "AED" });
    const bourso = createAccount(uid, { name: "BoursoBank", type: "checking", currency: "EUR" });
    // 10,000 AED = 2,450.65 EUR at mid; the bank delivered 2,440 (0.4% spread).
    addTransaction(uid, { date: "2026-10-03", amount: -10_000, accountId: enbd.id, description: "TT TO FRANCE", categoryId: null });
    addTransaction(uid, { date: "2026-10-05", amount: 2_440, accountId: bourso.id, description: "VIR RECU", categoryId: null });
    // Noise that must not match: same account, too far apart, too different.
    addTransaction(uid, { date: "2026-10-03", amount: 10_000, accountId: enbd.id, description: "REFUND", categoryId: null });
    addTransaction(uid, { date: "2026-10-20", amount: 2_440, accountId: bourso.id, description: "LATER", categoryId: null });
    addTransaction(uid, { date: "2026-10-04", amount: 2_000, accountId: bourso.id, description: "OTHER", categoryId: null });

    const before = budgetStatus(uid, "2026-10");
    const pairs = findTransferPairs(uid);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ outAccount: "Emirates NBD", inAccount: "BoursoBank", amount: 10_000, currency: "AED", received: 2_440 });
    expect(pairs[0].gap).toBeLessThan(0.005);

    expect(matchTransfers(uid).matched).toBe(1);
    const transfers = findCategory(uid, "Transfers")!.id;
    expect(listTransactions(uid, { categoryId: transfers }).total).toBe(2);
    const after = budgetStatus(uid, "2026-10");
    expect(before.expensesCents - after.expensesCents).toBe(Math.round(1_000_000 / 3.6725));
    expect(findTransferPairs(uid)).toHaveLength(0); // idempotent
  });

  it("matches automatically when the second side is imported", () => {
    const a = createAccount(uid, { name: "Checking", type: "checking", currency: "EUR" });
    const b = createAccount(uid, { name: "Livret A", type: "savings", currency: "EUR" });
    importTransactions(uid, [{ date: "2026-10-02", amount: -500, description: "VIR LIVRET A" }], a.id);
    const r = importTransactions(uid, [{ date: "2026-10-02", amount: 500, description: "VIR DE CHECKING" }], b.id);
    expect(r).toMatchObject({ inserted: 1, transfers: 1 });
  });

  it("leaves categorized rows and rows without an account alone", () => {
    const a = createAccount(uid, { name: "A", type: "checking", currency: "EUR" });
    createAccount(uid, { name: "B", type: "checking", currency: "EUR" });
    addTransaction(uid, { date: "2026-10-02", amount: -50, accountId: a.id, description: "Dinner", categoryId: findCategory(uid, "Restaurants & bars")!.id });
    addTransaction(uid, { date: "2026-10-02", amount: 50, description: "Cash in", categoryId: null });
    expect(findTransferPairs(uid)).toHaveLength(0);
  });
});
