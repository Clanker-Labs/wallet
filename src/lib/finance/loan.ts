import type { LoanParams } from "@/lib/domain";
import { monthsBetween } from "@/lib/dates";

/** Monthly payment (principal + interest) of a fixed-rate amortizing loan. */
export function monthlyPayment(principal: number, annualRatePct: number, months: number): number {
  if (principal <= 0 || months <= 0) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

/** Remaining principal after `paid` monthly payments. */
export function balanceAfter(
  principal: number,
  annualRatePct: number,
  months: number,
  paid: number,
): number {
  if (paid <= 0) return principal;
  if (paid >= months) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal * (1 - paid / months);
  const pmt = monthlyPayment(principal, annualRatePct, months);
  const growth = Math.pow(1 + r, paid);
  return Math.max(0, principal * growth - (pmt * (growth - 1)) / r);
}

export interface AmortizationRow {
  month: number;
  payment: number;
  interest: number;
  principal: number;
  balance: number;
}

export function amortizationSchedule(
  principal: number,
  annualRatePct: number,
  months: number,
): AmortizationRow[] {
  const rows: AmortizationRow[] = [];
  const r = annualRatePct / 100 / 12;
  const pmt = monthlyPayment(principal, annualRatePct, months);
  let balance = principal;
  for (let m = 1; m <= months; m++) {
    const interest = balance * r;
    const principalPart = m === months ? balance : pmt - interest;
    balance = Math.max(0, balance - principalPart);
    rows.push({ month: m, payment: principalPart + interest, interest, principal: principalPart, balance });
  }
  return rows;
}

/** Number of payments made on or before `asOf`. */
export function paymentsMade(params: LoanParams, asOf: string): number {
  if (asOf < params.startDate) return 0;
  return Math.min(params.durationMonths, monthsBetween(params.startDate, asOf) + 1);
}

/** Outstanding principal of a loan on a given date. */
export function loanBalanceOn(params: LoanParams, asOf: string): number {
  return balanceAfter(
    params.principal,
    params.annualRatePct,
    params.durationMonths,
    paymentsMade(params, asOf),
  );
}

/**
 * Solve for the annual rate (proportional, % per year) that discounts a stream
 * of equal monthly payments to `presentValue`. Used for an APR-style figure.
 */
export function impliedAnnualRate(presentValue: number, payment: number, months: number): number {
  if (presentValue <= 0 || payment <= 0 || months <= 0) return 0;
  const pv = (r: number) => (r === 0 ? payment * months : (payment * (1 - Math.pow(1 + r, -months))) / r);
  if (pv(0) <= presentValue) return 0;
  let lo = 0;
  let hi = 1; // 100% per month: absurdly high upper bound
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > presentValue) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * 12 * 100;
}
