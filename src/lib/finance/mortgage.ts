import { z } from "zod";
import { impliedAnnualRate, monthlyPayment, amortizationSchedule } from "./loan";

/**
 * Property purchase financed by a mortgage, with French-market defaults
 * (notary fees, borrower insurance on initial capital, guarantee fees,
 * HCSF 35% debt-to-income cap).
 */
export const purchaseInputSchema = z.object({
  price: z.number().positive().describe("Property price (net seller price)"),
  notaryFeesPct: z
    .number()
    .min(0)
    .max(20)
    .default(7.5)
    .describe("Notary fees as % of price (~7.5% existing, ~2.5% new build in France)"),
  agencyFees: z.number().min(0).default(0).describe("Agency fees paid by the buyer, if not in price"),
  renovation: z.number().min(0).default(0).describe("Works budget financed with the purchase"),
  downPayment: z.number().min(0).default(0).describe("Personal contribution (apport)"),
  annualRatePct: z.number().min(0).max(25).default(3.3).describe("Nominal loan rate, % per year"),
  insuranceRatePct: z
    .number()
    .min(0)
    .max(3)
    .default(0.3)
    .describe("Borrower insurance, % of initial capital per year"),
  durationYears: z.number().int().min(1).max(35).default(25),
  guaranteeFeesPct: z
    .number()
    .min(0)
    .max(5)
    .default(1.2)
    .describe("Loan guarantee (caution / hypothèque) as % of the loan"),
  bankFees: z.number().min(0).default(1000).describe("Bank arrangement fees (frais de dossier)"),
  monthlyNetIncome: z
    .number()
    .min(0)
    .optional()
    .describe("Household net monthly income, for the debt-to-income ratio"),
  otherMonthlyDebts: z.number().min(0).default(0).describe("Other monthly loan payments"),
  appreciationPct: z.number().min(-20).max(20).default(2).describe("Expected property value growth, % per year"),
});
export type PurchaseInput = z.input<typeof purchaseInputSchema>;

export interface PurchaseYear {
  year: number;
  interest: number;
  principal: number;
  insurance: number;
  balanceEnd: number;
  propertyValue: number;
  equity: number;
}

export interface PurchaseResult {
  notaryFees: number;
  guaranteeFees: number;
  totalProjectCost: number;
  loanAmount: number;
  monthlyPayment: number;
  monthlyInsurance: number;
  monthlyTotal: number;
  totalInterest: number;
  totalInsurance: number;
  totalCreditCost: number;
  aprPct: number;
  downPaymentPct: number;
  debtRatioPct: number | null;
  /** HCSF rules: ≤35% debt-to-income incl. insurance, ≤25 years. */
  hcsfCompliant: boolean | null;
  warnings: string[];
  yearly: PurchaseYear[];
}

export const HCSF_MAX_DEBT_RATIO = 35;
export const HCSF_MAX_YEARS = 25;

export function simulatePurchase(raw: PurchaseInput): PurchaseResult {
  const i = purchaseInputSchema.parse(raw);
  const months = i.durationYears * 12;
  const notaryFees = (i.price * i.notaryFeesPct) / 100;
  const baseNeed = i.price + notaryFees + i.agencyFees + i.renovation + i.bankFees - i.downPayment;
  const g = i.guaranteeFeesPct / 100;
  // Guarantee fees are themselves financed: L = base + g·L.
  const loanAmount = baseNeed > 0 ? baseNeed / (1 - g) : 0;
  const guaranteeFees = loanAmount * g;
  const totalProjectCost = i.price + notaryFees + i.agencyFees + i.renovation + i.bankFees + guaranteeFees;

  const pmt = monthlyPayment(loanAmount, i.annualRatePct, months);
  const monthlyInsurance = (loanAmount * i.insuranceRatePct) / 100 / 12;
  const monthlyTotal = pmt + monthlyInsurance;
  const schedule = amortizationSchedule(loanAmount, i.annualRatePct, months);
  const totalInterest = schedule.reduce((s, r) => s + r.interest, 0);
  const totalInsurance = monthlyInsurance * months;
  const totalCreditCost = totalInterest + totalInsurance + guaranteeFees + i.bankFees;

  // APR-style rate: what you actually receive vs everything you pay monthly.
  const netReceived = loanAmount - guaranteeFees - i.bankFees;
  const aprPct = loanAmount > 0 ? impliedAnnualRate(netReceived, monthlyTotal, months) : 0;

  const debtRatioPct =
    i.monthlyNetIncome && i.monthlyNetIncome > 0
      ? ((monthlyTotal + i.otherMonthlyDebts) / i.monthlyNetIncome) * 100
      : null;
  const hcsfCompliant =
    debtRatioPct === null ? null : debtRatioPct <= HCSF_MAX_DEBT_RATIO && i.durationYears <= HCSF_MAX_YEARS;

  const warnings: string[] = [];
  if (debtRatioPct !== null && debtRatioPct > HCSF_MAX_DEBT_RATIO)
    warnings.push(`Debt-to-income ${debtRatioPct.toFixed(1)}% exceeds the ${HCSF_MAX_DEBT_RATIO}% HCSF cap.`);
  if (i.durationYears > HCSF_MAX_YEARS)
    warnings.push(`Duration above ${HCSF_MAX_YEARS} years is only allowed for some new builds.`);
  const downPaymentPct = totalProjectCost > 0 ? (i.downPayment / totalProjectCost) * 100 : 0;
  if (loanAmount > 0 && i.downPayment < notaryFees + guaranteeFees)
    warnings.push("Most banks expect the down payment to at least cover notary and guarantee fees.");

  const yearly: PurchaseYear[] = [];
  for (let y = 1; y <= i.durationYears; y++) {
    const rows = schedule.slice((y - 1) * 12, y * 12);
    const balanceEnd = rows.at(-1)?.balance ?? 0;
    const propertyValue = i.price * Math.pow(1 + i.appreciationPct / 100, y);
    yearly.push({
      year: y,
      interest: rows.reduce((s, r) => s + r.interest, 0),
      principal: rows.reduce((s, r) => s + r.principal, 0),
      insurance: monthlyInsurance * rows.length,
      balanceEnd,
      propertyValue,
      equity: propertyValue - balanceEnd,
    });
  }

  return {
    notaryFees,
    guaranteeFees,
    totalProjectCost,
    loanAmount,
    monthlyPayment: pmt,
    monthlyInsurance,
    monthlyTotal,
    totalInterest,
    totalInsurance,
    totalCreditCost,
    aprPct,
    downPaymentPct,
    debtRatioPct,
    hcsfCompliant,
    warnings,
    yearly,
  };
}

export const capacityInputSchema = z.object({
  monthlyNetIncome: z.number().positive().describe("Household net monthly income"),
  otherMonthlyDebts: z.number().min(0).default(0),
  maxDebtRatioPct: z.number().min(1).max(60).default(HCSF_MAX_DEBT_RATIO),
  annualRatePct: z.number().min(0).max(25).default(3.3),
  insuranceRatePct: z.number().min(0).max(3).default(0.3),
  durationYears: z.number().int().min(1).max(35).default(25),
  downPayment: z.number().min(0).default(0),
  notaryFeesPct: z.number().min(0).max(20).default(7.5),
  guaranteeFeesPct: z.number().min(0).max(5).default(1.2),
});
export type CapacityInput = z.input<typeof capacityInputSchema>;

export interface CapacityResult {
  maxMonthlyPayment: number;
  maxLoan: number;
  maxPropertyPrice: number;
}

/** How much can be borrowed — and what price that buys — under a debt-ratio cap. */
export function borrowingCapacity(raw: CapacityInput): CapacityResult {
  const i = capacityInputSchema.parse(raw);
  const maxMonthlyPayment = Math.max(0, (i.monthlyNetIncome * i.maxDebtRatioPct) / 100 - i.otherMonthlyDebts);
  const months = i.durationYears * 12;
  const perUnit = monthlyPayment(1, i.annualRatePct, months) + i.insuranceRatePct / 100 / 12;
  const maxLoan = perUnit > 0 ? maxMonthlyPayment / perUnit : 0;
  // Loan finances price + notary + guarantee − down payment.
  const usable = maxLoan * (1 - i.guaranteeFeesPct / 100) + i.downPayment;
  const maxPropertyPrice = usable / (1 + i.notaryFeesPct / 100);
  return { maxMonthlyPayment, maxLoan, maxPropertyPrice };
}
