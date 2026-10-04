import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import {
  archiveAccount,
  createAccount,
  deleteAccount,
  findAccounts,
  listAccounts,
  recordBalance,
  staleAccounts,
  unarchiveAccount,
} from "@/server/services/accounts";
import { netWorthHistory, netWorthOn } from "@/server/services/networth";
import { addTransaction, categorizeTransactions, importTransactions, listTransactions } from "@/server/services/transactions";
import { findCategory, matchCategory, suggestPattern, upsertRule } from "@/server/services/categories";
import { budgetStatus, cashflow, setBudget } from "@/server/services/budgets";
import { acknowledgeReminder, createReminder, dueNags, dueReminders, markSent } from "@/server/services/reminders";
import { applyMapping, guessMapping, parseCsv } from "@/lib/csv-import";

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  freshDb();
});

const cat = (name: string) => findCategory(name)!.id;

describe("net worth", () => {
  it("sums assets, subtracts liabilities and applies ownership", () => {
    const cash = createAccount({ name: "Checking", type: "checking", initialBalance: 2_000 });
    const flat = createAccount({ name: "Flat", type: "real_estate", ownershipPct: 50, initialBalance: 400_000 });
    createAccount({ name: "Card", type: "credit_card", initialBalance: -300 }); // stored as owed
    const nw = netWorthOn();
    expect(nw.assetsCents).toBe(2_000_00 + 200_000_00);
    expect(nw.liabilitiesCents).toBe(300_00);
    expect(nw.netCents).toBe(2_000_00 + 200_000_00 - 300_00);
    expect(nw.byClassCents.real_estate).toBe(200_000_00);
    expect(listAccounts().find((a) => a.id === flat.id)!.balanceCents).toBe(400_000_00);
    expect(cash.assetClass).toBe("cash");
  });

  it("uses the latest snapshot on or before a date", () => {
    const a = createAccount({ name: "PEA", type: "pea" });
    recordBalance({ accountId: a.id, balance: 1_000, date: "2026-01-31" });
    recordBalance({ accountId: a.id, balance: 1_500, date: "2026-06-30" });
    recordBalance({ accountId: a.id, balance: 1_600, date: "2026-06-30" }); // same day → upsert
    expect(netWorthOn("2026-03-01").netCents).toBe(1_000_00);
    expect(netWorthOn("2026-07-01").netCents).toBe(1_600_00);
    expect(netWorthOn("2025-12-31").netCents).toBe(0);
    const history = netWorthHistory(12);
    expect(history.at(-1)!.date).toBe("2026-10-15");
    expect(history[0].date).toBe("2026-01-31"); // starts at first data
  });

  it("amortizes loans automatically and zeroes archived accounts", () => {
    const loan = createAccount({
      name: "Mortgage",
      type: "mortgage",
      loanParams: { principal: 120_000, annualRatePct: 0, durationMonths: 120, startDate: "2026-01-05" },
    });
    // 10 payments made by mid-October at 0% → 110,000 left
    expect(netWorthOn().liabilitiesCents).toBe(110_000_00);
    expect(netWorthOn("2025-06-01").liabilitiesCents).toBe(0); // before the loan existed
    archiveAccount(loan.id);
    expect(netWorthOn().liabilitiesCents).toBe(0);
    unarchiveAccount(loan.id); // the schedule applies again
    expect(netWorthOn().liabilitiesCents).toBe(110_000_00);
  });

  it("unlinks loans when their property is deleted", () => {
    const flat = createAccount({ name: "Flat", type: "real_estate", initialBalance: 300_000 });
    const loan = createAccount({ name: "Loan", type: "mortgage", linkedAccountId: flat.id, initialBalance: 200_000 });
    deleteAccount(flat.id);
    expect(listAccounts().find((a) => a.id === loan.id)!.linkedAccountId).toBeNull();
  });

  it("finds accounts by fuzzy name and flags stale ones", () => {
    createAccount({ name: "Livret A", institution: "BoursoBank", type: "savings", initialBalance: 10 });
    const old = createAccount({ name: "LDDS", type: "savings" });
    recordBalance({ accountId: old.id, balance: 5, date: "2026-01-01" });
    expect(findAccounts("livret").map((a) => a.name)).toEqual(["Livret A"]);
    expect(findAccounts("bourso livret").map((a) => a.name)).toEqual(["Livret A"]);
    expect(staleAccounts().map((a) => a.name)).toEqual(["LDDS"]);
  });
});

describe("transactions & budgets", () => {
  it("auto-categorizes with the longest matching rule", () => {
    upsertRule("carrefour", cat("Groceries"));
    upsertRule("carrefour voyages", cat("Travel"));
    expect(matchCategory("CB CARREFOUR CITY")).toBe(cat("Groceries"));
    expect(matchCategory("CARREFOUR VOYAGES 12/03")).toBe(cat("Travel"));
    expect(suggestPattern("CB CARREFOUR CITY 12/03 PARIS")).toBe("carrefour city");
    expect(suggestPattern("PAYPAL *VINTED")).toBe("paypal"); // must match its own label
  });

  it("computes budget status, excluding transfers and netting refunds", () => {
    setBudget(cat("Groceries"), 300);
    setBudget(cat("Restaurants & bars"), 100);
    addTransaction({ date: "2026-10-01", amount: 3_000, description: "Salary", categoryId: cat("Salary") });
    addTransaction({ date: "2026-10-02", amount: -250, description: "Market", categoryId: cat("Groceries") });
    addTransaction({ date: "2026-10-03", amount: 20, description: "Refund", categoryId: cat("Groceries") });
    addTransaction({ date: "2026-10-04", amount: -130, description: "Dinner", categoryId: cat("Restaurants & bars") });
    addTransaction({ date: "2026-10-05", amount: -1_000, description: "To PEA", categoryId: cat("Savings & investing") });
    addTransaction({ date: "2026-10-06", amount: -40, description: "Mystery" });

    const s = budgetStatus("2026-10");
    expect(s.incomeCents).toBe(3_000_00);
    expect(s.expensesCents).toBe(230_00 + 130_00 + 40_00);
    expect(s.savingsRatePct).toBeCloseTo(((3_000 - 400) / 3_000) * 100);
    const groceries = s.lines.find((l) => l.name === "Groceries")!;
    expect(groceries.spentCents).toBe(230_00);
    expect(groceries.status).toBe("ahead_of_pace"); // 77% spent, ~48% of month gone
    expect(s.lines.find((l) => l.name === "Restaurants & bars")!.status).toBe("over");
    expect(s.lines.find((l) => l.categoryId === null)!.spentCents).toBe(40_00);
    expect(cashflow(2).map((m) => m.netCents)).toEqual([0, 2_600_00]);
  });

  it("imports CSV rows idempotently and applies rules", () => {
    upsertRule("monoprix", cat("Groceries"));
    const csv = "﻿Date;Libellé;Montant\n01/10/2026;CB MONOPRIX;-12,50\n01/10/2026;CB MONOPRIX;-12,50\n02/10/2026;VIR SALAIRE;2 500,00\n";
    const parsed = parseCsv(csv);
    const mapping = guessMapping(parsed.headers);
    expect(mapping).toMatchObject({ date: "Date", description: "Libellé", amount: "Montant" });
    const { ok, errors } = applyMapping(parsed.rows, mapping);
    expect(errors).toEqual([]);
    expect(ok[2]).toEqual({ date: "2026-10-02", amount: 2500, description: "VIR SALAIRE" });

    const first = importTransactions(ok, null);
    expect(first).toEqual({ inserted: 3, duplicates: 0, categorized: 2 });
    expect(importTransactions(ok, null)).toEqual({ inserted: 0, duplicates: 3, categorized: 0 });
  });

  it("supports debit/credit columns", () => {
    const parsed = parseCsv("Date,Description,Debit,Credit\n2026-10-01,Coffee,3.20,\n2026-10-02,Refund,,10\n");
    const { ok } = applyMapping(parsed.rows, guessMapping(parsed.headers));
    expect(ok.map((r) => r.amount)).toEqual([-3.2, 10]);
  });

  it("categorizes and remembers a rule for the rest", () => {
    const a = addTransaction({ date: "2026-10-01", amount: -9.99, description: "NETFLIX.COM 123" });
    addTransaction({ date: "2026-09-01", amount: -9.99, description: "NETFLIX.COM 456" });
    const res = categorizeTransactions([a.id], cat("Subscriptions"), "netflix");
    expect(res).toEqual({ updated: 1, ruleApplied: 1 });
    expect(listTransactions({ categoryId: "none" }).total).toBe(0);
    expect(addTransaction({ amount: -9.99, description: "Netflix" }).categoryId).toBe(cat("Subscriptions"));
  });
});

describe("reminders", () => {
  it("schedules, nags until acknowledged, then moves on", () => {
    const r = createReminder({ title: "Update balances", frequency: "monthly", dayOfMonth: 20, timeOfDay: "09:00", nagEveryHours: 24 });
    expect(r.nextRunAt!.toISOString()).toBe("2026-10-20T09:00:00.000Z");

    const at = new Date("2026-10-20T09:01:00Z");
    expect(dueReminders(at).map((x) => x.id)).toEqual([r.id]);
    markSent(r.id, 42, { nag: false }, at);
    expect(dueReminders(at)).toEqual([]);
    expect(dueNags(new Date("2026-10-21T09:00:00Z"))).toEqual([]);
    expect(dueNags(new Date("2026-10-21T09:02:00Z")).map((x) => x.id)).toEqual([r.id]);

    acknowledgeReminder(r.id);
    expect(dueNags(new Date("2026-10-25T00:00:00Z"))).toEqual([]);
    expect(dueReminders(new Date("2026-11-20T09:00:00Z")).map((x) => x.id)).toEqual([r.id]);
  });
});
