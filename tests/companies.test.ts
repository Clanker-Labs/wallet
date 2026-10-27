import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount, recordBalance } from "@/server/services/accounts";
import { addTransaction } from "@/server/services/transactions";
import { findCategory } from "@/server/services/categories";
import { netWorthOn } from "@/server/services/networth";
import { getCompany, saveCompany, setCompanyFinancials } from "@/server/services/companies";
import { storeRates } from "@/server/services/fx";

let uid: string;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  uid = freshUser(); // base USD
  storeRates({ date: "2025-01-01", perUsd: { USD: 1, AED: 4, EUR: 0.9 } }); // round AED rate for the arithmetic
});

describe("companies in net worth", () => {
  it("values a company from its own accounts, takes your share, and never counts its accounts twice", () => {
    const co = saveCompany(uid, { name: "Clanker FZ-LLC", currency: "AED", ownershipPct: 50, params: { country: "AE", legalForm: "FZ-LLC", valuation: "book" } });
    const bank = createAccount(uid, { name: "Co bank", type: "checking", currency: "AED", companyId: co.account.id, initialBalance: 100_000 });
    createAccount(uid, { name: "Co loan", type: "loan", currency: "AED", companyId: co.account.id, initialBalance: 20_000 });
    createAccount(uid, { name: "My cash", type: "checking", currency: "USD", initialBalance: 1_000 });

    const c = getCompany(uid, co.account.id);
    expect(c.valueCents).toBe(80_000_00);
    expect(c.ownedCents).toBe(40_000_00);
    expect(c.accounts.map((a) => a.id)).toContain(bank.id);
    const nw = netWorthOn(uid);
    expect(nw.byClassCents.business).toBe(10_000_00); // 40,000 AED at 4
    expect(nw.byClassCents.cash).toBe(1_000_00); // the company's bank is not here
    expect(nw.liabilitiesCents).toBe(0); // nor its loan
    expect(nw.netCents).toBe(11_000_00);
    expect(() => recordBalance(uid, { accountId: co.account.id, balance: 5 })).toThrow(/valued from its accounts/);
  });

  it("values from trailing revenue or profit times a multiple, from transactions and hand-entered months", () => {
    const co = saveCompany(uid, { name: "Studio", currency: "EUR", params: { country: "FR", valuation: "revenue_multiple", multiple: 2 } });
    const bank = createAccount(uid, { name: "Studio bank", type: "checking", currency: "EUR", companyId: co.account.id });
    for (const m of ["2026-07", "2026-08", "2026-09"]) {
      addTransaction(uid, { date: `${m}-10`, amount: 10_000, accountId: bank.id, description: "Client", categoryId: findCategory(uid, "Freelance & side income")!.id });
      addTransaction(uid, { date: `${m}-20`, amount: -4_000, accountId: bank.id, description: "Rent", categoryId: findCategory(uid, "Housing")!.id });
    }
    setCompanyFinancials(uid, co.account.id, "2025-12", 6_000, 1_000);
    setCompanyFinancials(uid, co.account.id, "2024-12", 99_000, 0); // outside the 12 months
    let c = getCompany(uid, co.account.id);
    expect(c.ttm).toMatchObject({ revenueCents: 36_000_00, expensesCents: 13_000_00, profitCents: 23_000_00 });
    expect(c.valueCents).toBe(72_000_00);
    expect(c.marginPct).toBeCloseTo(63.9, 1);

    saveCompany(uid, { accountId: co.account.id, name: "Studio", params: { country: "FR", valuation: "profit_multiple", multiple: 4 } });
    c = getCompany(uid, co.account.id);
    expect(c.valueCents).toBe(92_000_00);
  });

  it("records a manual value", () => {
    const co = saveCompany(uid, { name: "Angel stake", currency: "USD", ownershipPct: 2, params: { country: "US", valuation: "manual" }, initialValue: 5_000_000 });
    expect(getCompany(uid, co.account.id).ownedCents).toBe(100_000_00);
    recordBalance(uid, { accountId: co.account.id, balance: 6_000_000 });
    expect(getCompany(uid, co.account.id).ownedCents).toBe(120_000_00);
  });

  it("refuses nesting and attaching to a non-company", () => {
    const co = saveCompany(uid, { name: "A", params: { country: "AE", valuation: "book" } });
    const plain = createAccount(uid, { name: "Plain", type: "checking" });
    expect(() => createAccount(uid, { name: "x", type: "checking", companyId: plain.id })).toThrow(/not a company/);
    expect(() => saveCompany(uid, { name: "B", params: { country: "AE", valuation: "book" } }) && createAccount(uid, { name: "Sub", type: "company", companyId: co.account.id, companyParams: { country: "AE", valuation: "book" } })).toThrow(/can't belong/);
  });
});
