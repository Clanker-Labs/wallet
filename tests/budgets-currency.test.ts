import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { budgetStatus, cashflow, listBudgets, setBudget, spendingByCategory } from "@/server/services/budgets";
import { findCategory } from "@/server/services/categories";
import { addTransaction } from "@/server/services/transactions";
import { db } from "@/server/db/client";
import { fxRates } from "@/server/db/schema";

let uid: string;
const cat = (name: string) => findCategory(uid, name)!.id;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  uid = freshUser(); // base currency USD
  db()
    .insert(fxRates)
    .values([
      { date: "2026-10-01", currency: "AED", perUsd: 3.6725 },
      { date: "2026-10-01", currency: "EUR", perUsd: 0.9 },
      { date: "2026-10-10", currency: "EUR", perUsd: 0.8 },
    ])
    .run();
});

describe("multi-currency budgets", () => {
  it("tracks an envelope in its own currency, converting each expense at its date", () => {
    setBudget(uid, cat("Groceries"), 2_000, "AED");
    addTransaction(uid, { date: "2026-10-02", amount: -734.5, currency: "AED", description: "Carrefour", categoryId: cat("Groceries") });
    addTransaction(uid, { date: "2026-10-03", amount: -90, currency: "EUR", description: "Monoprix", categoryId: cat("Groceries") });
    addTransaction(uid, { date: "2026-10-12", amount: -80, currency: "EUR", description: "Franprix", categoryId: cat("Groceries") });

    const s = budgetStatus(uid, "2026-10");
    const g = s.lines.find((l) => l.name === "Groceries")!;
    expect(g.currency).toBe("AED");
    expect(g.budgetCents).toBe(2_000_00);
    // 734.50 AED + 90 EUR at 0.9 (= $100) + 80 EUR at 0.8 (= $100), the last two in AED.
    expect(g.spentCents).toBe(734_50 + 367_25 + 367_25);
    expect(g.spentByCurrency).toEqual([
      { currency: "AED", cents: 734_50 },
      { currency: "EUR", cents: 170_00 },
    ]);
    // In the page's currency (base USD): $200 + $100 + $100.
    expect(s.currency).toBe("USD");
    expect(g.displaySpentCents).toBe(400_00);
    expect(g.displayBudgetCents).toBe(Math.round(2_000_00 / 3.6725));
    expect(s.expensesCents).toBe(400_00);
    expect(s.totalBudgetCents).toBe(g.displayBudgetCents);
    expect(s.currencies).toEqual(["AED", "EUR", "USD"]);
  });

  it("shows the whole month in another currency on request", () => {
    setBudget(uid, cat("Housing"), 1_500, "EUR");
    addTransaction(uid, { date: "2026-10-01", amount: 36_725, currency: "AED", description: "Salary", categoryId: cat("Salary") });
    addTransaction(uid, { date: "2026-10-05", amount: -1_350, currency: "EUR", description: "Loyer", categoryId: cat("Housing") });
    const s = budgetStatus(uid, "2026-10", { currency: "AED" });
    expect(s.currency).toBe("AED");
    expect(s.incomeCents).toBe(36_725_00);
    expect(s.expensesCents).toBe(Math.round(1_350_00 * (3.6725 / 0.9)));
    const rent = s.lines.find((l) => l.name === "Housing")!;
    expect(rent).toMatchObject({ currency: "EUR", spentCents: 1_350_00, budgetCents: 1_500_00, spentByCurrency: [] });
    expect(cashflow(uid, 1, "EUR")[0].incomeCents).toBe(9_000_00);
    expect(spendingByCategory(uid, "2026-10-01", "2026-10-31", "EUR")[0]).toMatchObject({ name: "Housing", spentCents: 1_350_00 });
  });

  it("keeps an envelope's currency when only the amount changes; the base currency is stored as 'follow base'", () => {
    setBudget(uid, cat("Groceries"), 2_000, "AED");
    setBudget(uid, cat("Groceries"), 2_500);
    expect(listBudgets(uid)[0]).toMatchObject({ amountCents: 2_500_00, currency: "AED" });
    const row = setBudget(uid, cat("Groceries"), 600, "usd");
    expect(row?.currency).toBeNull();
    expect(listBudgets(uid)[0].currency).toBe("USD");
    expect(() => setBudget(uid, cat("Groceries"), 100, "not money")).toThrow(/Unknown currency/);
  });

  it("says which currencies have no rate instead of silently counting them", () => {
    setBudget(uid, cat("Groceries"), 100);
    addTransaction(uid, { date: "2026-10-02", amount: -50, currency: "GBP", description: "Tesco", categoryId: cat("Groceries") });
    const s = budgetStatus(uid, "2026-10");
    expect(s.missingFx).toContain("GBP");
  });
});
