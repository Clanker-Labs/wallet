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

// ── Loans that changed: early repayments and renegotiated rates ──────────

export interface ScheduleEntry {
  /** Payment number (1-based), or 0 for an early repayment between payments. */
  n: number;
  date: string;
  kind: "payment" | "prepayment";
  payment: number;
  interest: number;
  principal: number;
  /** Remaining principal after this entry. */
  balance: number;
  ratePct: number;
}

const addMonthsIso = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
};

/**
 * The real schedule, events included: each payment on its date, early
 * repayments as their own entries, the rate and payment recomputed after each
 * event. Without events it equals amortizationSchedule.
 */
export function loanSchedule(params: LoanParams): ScheduleEntry[] {
  const events = [...(params.events ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const out: ScheduleEntry[] = [];
  let balance = params.principal;
  let rate = params.annualRatePct;
  let remaining = params.durationMonths;
  let pmt = monthlyPayment(balance, rate, remaining);
  let e = 0;
  for (let n = 1; balance > 0.005 && n <= params.durationMonths + 600; n++) {
    const date = addMonthsIso(params.startDate, n - 1);
    // Events dated before this payment change the loan first.
    while (e < events.length && events[e].date <= date) {
      const ev = events[e++];
      if (ev.type === "prepayment" && ev.amount) {
        const paid = Math.min(balance, ev.amount);
        balance -= paid;
        out.push({ n: 0, date: ev.date, kind: "prepayment", payment: paid, interest: 0, principal: paid, balance, ratePct: rate });
      } else if (ev.type === "rate_change" && ev.ratePct !== undefined) {
        rate = ev.ratePct;
      }
      if (balance <= 0.005) break;
      if ((ev.keep ?? "duration") === "duration") {
        pmt = monthlyPayment(balance, rate, remaining);
      } else {
        // Same payment: the term follows. A payment that no longer covers interest keeps the term instead.
        const r = rate / 100 / 12;
        if (r > 0 && pmt <= balance * r) pmt = monthlyPayment(balance, rate, remaining);
      }
    }
    if (balance <= 0.005) break;
    const r = rate / 100 / 12;
    const interest = balance * r;
    let principal = pmt - interest;
    if (principal >= balance - 0.005 || remaining <= 1) principal = balance;
    balance = Math.max(0, balance - principal);
    out.push({ n, date, kind: "payment", payment: principal + interest, interest, principal, balance, ratePct: rate });
    remaining = Math.max(1, remaining - 1);
  }
  return out;
}

/** Balance on a date, events included. */
export function scheduleBalanceOn(params: LoanParams, asOf: string): number {
  if (!params.events?.length) return loanBalanceOn(params, asOf);
  let balance = params.principal;
  for (const row of loanSchedule(params)) {
    if (row.date > asOf) break;
    balance = row.balance;
  }
  return balance;
}

/** Interest paid between two dates (inclusive): what a French réel régime deducts. */
export function interestBetween(params: LoanParams, from: string, to: string): number {
  let sum = 0;
  for (const row of loanSchedule(params)) if (row.kind === "payment" && row.date >= from && row.date <= to) sum += row.interest;
  return sum;
}

/** The monthly payment in force on a date (0 once repaid). */
export function paymentOn(params: LoanParams, date: string): number {
  const rows = loanSchedule(params).filter((r) => r.kind === "payment");
  const next = rows.find((r) => r.date >= date) ?? null;
  return next ? next.payment : 0;
}

/** When the loan ends, events included. */
export function loanEndDate(params: LoanParams): string | null {
  const rows = loanSchedule(params).filter((r) => r.kind === "payment");
  return rows.at(-1)?.date ?? null;
}
