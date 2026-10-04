import { describe, expect, it } from "vitest";
import { amortizationSchedule, balanceAfter, impliedAnnualRate, loanBalanceOn, monthlyPayment } from "@/lib/finance/loan";
import { borrowingCapacity, simulatePurchase } from "@/lib/finance/mortgage";
import { simulateBuyVsRent } from "@/lib/finance/buy-vs-rent";
import { blendedAssumptions, projectNetWorth } from "@/lib/finance/projection";

describe("loan math", () => {
  it("matches the standard annuity formula", () => {
    expect(monthlyPayment(200_000, 3, 300)).toBeCloseTo(948.42, 2);
    expect(monthlyPayment(12_000, 0, 12)).toBe(1000);
  });

  it("amortizes to zero and repays the principal", () => {
    const rows = amortizationSchedule(150_000, 3.5, 240);
    expect(rows).toHaveLength(240);
    expect(rows.at(-1)!.balance).toBeCloseTo(0, 6);
    expect(rows.reduce((s, r) => s + r.principal, 0)).toBeCloseTo(150_000, 4);
    expect(balanceAfter(150_000, 3.5, 240, 120)).toBeCloseTo(rows[119].balance, 4);
  });

  it("derives a loan balance from its schedule", () => {
    const params = { principal: 100_000, annualRatePct: 2, durationMonths: 120, startDate: "2025-01-05" };
    expect(loanBalanceOn(params, "2024-12-31")).toBe(100_000);
    expect(loanBalanceOn(params, "2025-01-05")).toBeCloseTo(balanceAfter(100_000, 2, 120, 1), 6);
    expect(loanBalanceOn(params, "2040-01-01")).toBe(0);
  });

  it("recovers the rate from payments", () => {
    const pmt = monthlyPayment(200_000, 4.2, 300);
    expect(impliedAnnualRate(200_000, pmt, 300)).toBeCloseTo(4.2, 4);
  });
});

describe("property purchase", () => {
  const base = { price: 300_000, downPayment: 40_000, annualRatePct: 3.5, durationYears: 25, monthlyNetIncome: 5_000 };

  it("finances fees and the guarantee", () => {
    const r = simulatePurchase(base);
    expect(r.notaryFees).toBeCloseTo(22_500);
    // loan = (price + notary + bank fees − down payment) / (1 − 1.2%)
    expect(r.loanAmount).toBeCloseTo((300_000 + 22_500 + 1_000 - 40_000) / (1 - 0.012), 2);
    expect(r.guaranteeFees).toBeCloseTo(r.loanAmount * 0.012, 6);
    expect(r.monthlyTotal).toBeCloseTo(r.monthlyPayment + (r.loanAmount * 0.003) / 12, 6);
    expect(r.aprPct).toBeGreaterThan(3.5);
    expect(r.yearly).toHaveLength(25);
    expect(r.yearly.at(-1)!.balanceEnd).toBeCloseTo(0, 4);
  });

  it("flags the HCSF debt-to-income cap", () => {
    const ok = simulatePurchase(base); // ≈30% of 5,000
    expect(ok.debtRatioPct!).toBeCloseTo((ok.monthlyTotal / 5_000) * 100, 6);
    expect(ok.hcsfCompliant).toBe(true);
    const tight = simulatePurchase({ ...base, monthlyNetIncome: 4_000 });
    expect(tight.hcsfCompliant).toBe(false);
    expect(tight.warnings.join(" ")).toMatch(/35%/);
  });

  it("round-trips with borrowing capacity", () => {
    const cap = borrowingCapacity({ monthlyNetIncome: 6_000, annualRatePct: 3.5, durationYears: 25, downPayment: 50_000 });
    const r = simulatePurchase({
      price: cap.maxPropertyPrice,
      downPayment: 50_000,
      annualRatePct: 3.5,
      durationYears: 25,
      monthlyNetIncome: 6_000,
      bankFees: 0,
    });
    expect(r.debtRatioPct!).toBeCloseTo(35, 1);
    expect(r.hcsfCompliant).toBe(true);
  });
});

describe("buy vs rent", () => {
  const common = { price: 300_000, downPayment: 60_000, annualRatePct: 3.5, durationYears: 25, horizonYears: 25 };

  it("favours buying when rent is expensive and prices rise", () => {
    const r = simulateBuyVsRent({ ...common, monthlyRent: 2_000, appreciationPct: 3, investmentReturnPct: 4 });
    expect(r.finalDifference).toBeGreaterThan(0);
    expect(r.breakEvenYear).not.toBeNull();
  });

  it("favours renting when rent is cheap and prices are flat", () => {
    const r = simulateBuyVsRent({ ...common, monthlyRent: 700, appreciationPct: 0, investmentReturnPct: 7 });
    expect(r.finalDifference).toBeLessThan(0);
    expect(r.breakEvenYear).toBeNull();
  });

  it("reports the price-to-rent ratio", () => {
    expect(simulateBuyVsRent({ ...common, monthlyRent: 1_250 }).priceToRentRatio).toBeCloseTo(20);
  });
});

describe("projection", () => {
  it("is plain accumulation with zero return", () => {
    const r = projectNetWorth({
      startingNetWorth: 10_000,
      monthlyContribution: 1_000,
      contributionGrowthPct: 0,
      annualReturnPct: 0,
      volatilityPct: 0,
      inflationPct: 0,
      horizonYears: 2,
      events: [{ year: 1, amount: -5_000, label: "car" }],
    });
    expect(r.finalNominal).toBeCloseTo(10_000 + 24_000 - 5_000);
    expect(r.totalContributions).toBeCloseTo(24_000);
    expect(r.totalGrowth).toBeCloseTo(0, 6);
  });

  it("finds the financial independence year", () => {
    const r = projectNetWorth({
      startingNetWorth: 0,
      monthlyContribution: 2_000,
      annualReturnPct: 5,
      volatilityPct: 0,
      inflationPct: 0,
      horizonYears: 30,
      annualExpenses: 24_000, // target 600k at 4%
    });
    expect(r.fiTarget).toBe(600_000);
    const year = r.fiYear!;
    expect(r.yearly[year].real).toBeGreaterThanOrEqual(600_000);
    expect(r.yearly[year - 1].real).toBeLessThan(600_000);
  });

  it("produces a reproducible Monte Carlo band", () => {
    const input = { startingNetWorth: 50_000, monthlyContribution: 500, horizonYears: 10, volatilityPct: 15, seed: 7 };
    const a = projectNetWorth(input);
    const b = projectNetWorth(input);
    expect(a.yearly.at(-1)!.p50).toBe(b.yearly.at(-1)!.p50);
    expect(a.yearly.at(-1)!.p10!).toBeLessThan(a.yearly.at(-1)!.p90!);
  });

  it("blends assumptions from the allocation", () => {
    expect(blendedAssumptions({ cash: 100, investments: 100, liabilities: 500 }).returnPct).toBeCloseTo((2.5 + 6) / 2, 1);
  });
});
