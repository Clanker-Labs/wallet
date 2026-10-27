import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { aeCorporateTax, aeResidency, frCorporateTax, frIfi, frIncomeTax, frNonResidentTax, frRentalTaxable, progressive } from "@/lib/finance/tax";
import { createAccount } from "@/server/services/accounts";
import { addTransaction } from "@/server/services/transactions";
import { createCategory, findCategory } from "@/server/services/categories";
import { saveCompany, setCompanyFinancials } from "@/server/services/companies";
import { storeRates } from "@/server/services/fx";
import { addPresence, daysByCountry, setTaxInput, taxReport } from "@/server/services/tax";

describe("tax rules", () => {
  it("France: barème with parts, the non-resident minimum rate, micro-foncier", () => {
    expect(progressive(50_000, [{ upTo: 10_000, rate: 0 }, { upTo: null, rate: 0.1 }]).tax).toBe(4_000);
    expect(frIncomeTax(50_000, 1, 2024).tax).toBeCloseTo(1_959.98 + 6_205.5, 2);
    expect(frIncomeTax(100_000, 2, 2024).tax).toBeCloseTo(2 * (1_959.98 + 6_205.5), 2);
    expect(frNonResidentTax(20_000, 1, 2024)).toMatchObject({ tax: 4_000, byMinimumRate: true });
    expect(frRentalTaxable(12_000, { regime: "micro" }).taxable).toBe(8_400);
    expect(frRentalTaxable(20_000, { regime: "micro", expenses: 3_000, interest: 4_000 })).toMatchObject({ taxable: 13_000, regime: "reel" });
  });

  it("IFI with its décote, corporate taxes", () => {
    expect(frIfi(1_200_000).tax).toBe(0);
    expect(frIfi(1_350_000).tax).toBeCloseTo(2_850 - 625, 2);
    expect(frIfi(3_000_000).tax).toBeCloseTo(2_500 + 8_890 + 4_300, 2);
    expect(frCorporateTax(100_000).tax).toBe(6_375 + 14_375);
    expect(aeCorporateTax(1_000_000, 5_000_000, { year: 2025 }).tax).toBe(56_250);
    expect(aeCorporateTax(400_000, 2_000_000, { year: 2025, smallBusinessRelief: true }).tax).toBe(0);
    expect(aeCorporateTax(400_000, 2_000_000, { year: 2027, smallBusinessRelief: true }).tax).toBe(2_250); // relief ended
    expect(aeResidency(120, { homeOrJobInUae: true }).resident).toBe(true);
    expect(aeResidency(120).resident).toBe(false);
  });
});

describe("the yearly report", () => {
  let uid: string;
  beforeEach(() => {
    process.env.WALLET_TIMEZONE = "UTC";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    uid = freshUser();
    storeRates({ date: "2024-01-01", perUsd: { USD: 1, EUR: 0.9, AED: 3.6725 } });
  });

  it("a UAE resident with a rented flat in France: French tax on the rent, nothing on the salary", () => {
    setTaxInput(uid, 0, "residence", "AE");
    const enbd = createAccount(uid, { name: "ENBD", type: "checking", currency: "AED", country: "AE" });
    const bourso = createAccount(uid, { name: "Bourso", type: "checking", currency: "EUR", country: "FR" });
    createAccount(uid, { name: "Nantes flat", type: "real_estate", currency: "EUR", country: "FR", initialBalance: 400_000 });
    const rent = createCategory(uid, { name: "Rental income", kind: "income" });
    for (const m of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"])
      addTransaction(uid, { date: `2025-${m}-05`, amount: 1_000, accountId: bourso.id, description: "LOYER", categoryId: rent.id });
    addTransaction(uid, { date: "2025-03-01", amount: 40_000, accountId: enbd.id, description: "SALARY", categoryId: findCategory(uid, "Salary")!.id });
    addPresence(uid, { country: "AE", fromDate: "2025-01-01", toDate: "2025-10-31" });
    addPresence(uid, { country: "FR", fromDate: "2025-11-01", toDate: "2025-11-20" });

    const r = taxReport(uid, 2025);
    expect(r.days).toEqual([{ country: "AE", days: 304 }, { country: "FR", days: 20 }]);
    expect(r.residencyNotes[0]).toMatch(/resident \(183-day test\)/);
    const ir = r.lines.find((l) => l.id === "fr.ir.nonresident")!;
    expect(ir).toMatchObject({ base: 8_400, tax: 1_680 }); // 30% allowance, then the 20% minimum
    expect(r.lines.find((l) => l.id === "fr.ps")!.tax).toBeCloseTo(8_400 * 0.172, 2);
    expect(r.lines.find((l) => l.id === "ae.pit")).toMatchObject({ tax: 0, base: 40_000 });
    expect(r.lines.find((l) => l.id === "fr.ifi")!.tax).toBe(0);
    expect(r.totals.find((x) => x.currency === "EUR")!.tax).toBeCloseTo(1_680 + 1_444.8, 2);

    // Switch to the réel regime with costs: the base follows.
    setTaxInput(uid, 2025, "fr.rental.regime", "reel");
    setTaxInput(uid, 2025, "fr.rental.expenses", "2000");
    expect(taxReport(uid, 2025).lines.find((l) => l.id === "fr.ir.nonresident")!.base).toBe(10_000);
  });

  it("estimates corporate tax for a company where it is", () => {
    setTaxInput(uid, 0, "residence", "AE");
    const co = saveCompany(uid, { name: "Clanker FZ-LLC", currency: "AED", params: { country: "AE", valuation: "profit_multiple", multiple: 3 } });
    for (const m of ["01", "06", "12"]) setCompanyFinancials(uid, co.account.id, `2025-${m}`, 2_000_000, 1_500_000);
    const line = taxReport(uid, 2025).lines.find((l) => l.id === `company.${co.account.id}`)!;
    expect(line).toMatchObject({ currency: "AED", base: 1_500_000, tax: 0.09 * (1_500_000 - 375_000) });
  });

  it("counts days once even when stays overlap", () => {
    addPresence(uid, { country: "FR", fromDate: "2026-01-01", toDate: "2026-01-10" });
    addPresence(uid, { country: "AE", fromDate: "2026-01-10", toDate: "2026-01-20" });
    expect(daysByCountry(uid, "2026-01-01", "2026-01-31")).toEqual({ days: [{ country: "AE", days: 11 }, { country: "FR", days: 9 }], unlogged: 11 });
  });
});
