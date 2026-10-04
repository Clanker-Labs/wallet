import { z } from "zod";
import { purchaseInputSchema, simulatePurchase } from "./mortgage";
import { balanceAfter } from "./loan";

/**
 * Buy vs rent over a horizon. Both sides start with the same cash: the buyer
 * spends it on the down payment, the renter invests it. Every month whoever
 * spends less invests the difference at the same expected return.
 */
export const buyVsRentInputSchema = purchaseInputSchema
  .omit({ monthlyNetIncome: true, otherMonthlyDebts: true })
  .extend({
    monthlyRent: z.number().positive().describe("Rent for an equivalent home, per month"),
    rentIncreasePct: z.number().min(-5).max(15).default(2).describe("Yearly rent increase, %"),
    propertyTaxYearly: z.number().min(0).default(1200).describe("Property tax (taxe foncière), per year"),
    coOwnershipMonthly: z.number().min(0).default(150).describe("Building charges (charges de copropriété), per month"),
    maintenancePct: z.number().min(0).max(5).default(1).describe("Upkeep, % of property value per year"),
    sellingCostsPct: z.number().min(0).max(15).default(5).describe("Costs when selling, % of value"),
    investmentReturnPct: z.number().min(-10).max(20).default(5).describe("Return on invested savings, % per year"),
    portfolioTaxPct: z
      .number()
      .min(0)
      .max(60)
      .default(0)
      .describe("Tax on investment gains when cashing out (e.g. 30 flat tax, 17.2 PEA after 5y)"),
    horizonYears: z.number().int().min(1).max(40).default(20),
  });
export type BuyVsRentInput = z.input<typeof buyVsRentInputSchema>;

export interface BuyVsRentYear {
  year: number;
  buyerNetWorth: number;
  renterNetWorth: number;
  propertyValue: number;
  loanBalance: number;
  buyerMonthlyCost: number;
  monthlyRent: number;
}

export interface BuyVsRentResult {
  yearly: BuyVsRentYear[];
  /** First year from which buying stays ahead; null if it never does. */
  breakEvenYear: number | null;
  finalDifference: number;
  priceToRentRatio: number;
  initialMonthlyCostBuy: number;
  initialMonthlyRent: number;
  loanAmount: number;
}

export function simulateBuyVsRent(raw: BuyVsRentInput): BuyVsRentResult {
  const i = buyVsRentInputSchema.parse(raw);
  const purchase = simulatePurchase(i);
  const months = i.horizonYears * 12;
  const loanMonths = i.durationYears * 12;
  const rInv = Math.pow(1 + i.investmentReturnPct / 100, 1 / 12) - 1;
  const gHome = Math.pow(1 + i.appreciationPct / 100, 1 / 12) - 1;

  // Cash committed at t0 by the buyer (the down payment covers fees first).
  let renterPortfolio = i.downPayment;
  let renterContrib = i.downPayment;
  let buyerPortfolio = 0;
  let buyerContrib = 0;
  let value = i.price;
  let rent = i.monthlyRent;

  const liquidation = (portfolio: number, contributed: number) =>
    portfolio - (Math.max(0, portfolio - contributed) * i.portfolioTaxPct) / 100;

  const yearly: BuyVsRentYear[] = [];
  let initialMonthlyCostBuy = 0;
  let lastBuyCost = 0;
  for (let m = 1; m <= months; m++) {
    if (m > 1 && (m - 1) % 12 === 0) rent *= 1 + i.rentIncreasePct / 100;
    const loanActive = m <= loanMonths && purchase.loanAmount > 0;
    const loanCost = loanActive ? purchase.monthlyTotal : 0;
    const ownerCost = i.propertyTaxYearly / 12 + i.coOwnershipMonthly + (value * i.maintenancePct) / 100 / 12;
    const buyCost = loanCost + ownerCost;
    if (m === 1) initialMonthlyCostBuy = buyCost;
    lastBuyCost = buyCost;

    renterPortfolio *= 1 + rInv;
    buyerPortfolio *= 1 + rInv;
    const diff = buyCost - rent;
    if (diff > 0) {
      renterPortfolio += diff;
      renterContrib += diff;
    } else {
      buyerPortfolio += -diff;
      buyerContrib += -diff;
    }
    value *= 1 + gHome;

    if (m % 12 === 0) {
      const loanBalance = balanceAfter(purchase.loanAmount, i.annualRatePct, loanMonths, m);
      const homeNet = value * (1 - i.sellingCostsPct / 100) - loanBalance;
      yearly.push({
        year: m / 12,
        buyerNetWorth: homeNet + liquidation(buyerPortfolio, buyerContrib),
        renterNetWorth: liquidation(renterPortfolio, renterContrib),
        propertyValue: value,
        loanBalance,
        buyerMonthlyCost: lastBuyCost,
        monthlyRent: rent,
      });
    }
  }

  let breakEvenYear: number | null = null;
  for (let k = yearly.length - 1; k >= 0; k--) {
    if (yearly[k].buyerNetWorth >= yearly[k].renterNetWorth) breakEvenYear = yearly[k].year;
    else break;
  }
  const last = yearly.at(-1)!;
  return {
    yearly,
    breakEvenYear,
    finalDifference: last.buyerNetWorth - last.renterNetWorth,
    priceToRentRatio: i.price / (i.monthlyRent * 12),
    initialMonthlyCostBuy,
    initialMonthlyRent: i.monthlyRent,
    loanAmount: purchase.loanAmount,
  };
}
