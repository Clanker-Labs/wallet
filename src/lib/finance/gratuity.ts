import { DateTime } from "luxon";
import { z } from "zod";
import { isISODate } from "@/lib/dates";

/**
 * End-of-service gratuity (EOSG / EOSB): what an employer owes when a job
 * ends, under the labour law of the country the job is in. Pure — safe in the
 * browser, the server and the agent.
 *
 * Every rule is a statutory MINIMUM as written in the law cited next to it.
 * Contracts and collective agreements can be more generous, unpaid leave can
 * shorten the service counted, and courts interpret edge cases: the numbers
 * are an estimate to plan with, not a payout statement.
 *
 * Amounts are in the job's currency units (not cents), like LoanParams.
 */

export const GRATUITY_COUNTRIES = {
  AE: {
    label: "United Arab Emirates (mainland & most free zones)",
    law: "Federal Decree-Law No. 33 of 2021, Art. 51",
    salary: "Basic monthly salary (no allowances)",
    summary: "21 days' basic pay per year for the first 5 years, 30 days per year after, from 1 year of service; capped at 2 years' pay. Same whether you resign or are let go.",
  },
  AE_DIFC: {
    label: "UAE · DIFC (DEWS)",
    law: "DIFC Employment Law No. 2 of 2019, Art. 66 (DEWS)",
    salary: "Basic monthly salary (no allowances)",
    summary: "The employer pays 5.83% of basic salary into DEWS every month for the first 5 years, 8.33% after. Shown here is what has been contributed; the fund's investment return comes on top.",
  },
  SA: {
    label: "Saudi Arabia",
    law: "Labor Law (Royal Decree M/51), Art. 84–85",
    salary: "Last monthly wage (basic + regular allowances such as housing)",
    summary: "Half a month's wage per year for the first 5 years, a full month per year after. Resigning pays nothing before 2 years, a third from 2 years, two thirds from 5, all of it from 10.",
  },
  QA: {
    label: "Qatar",
    law: "Labour Law No. 14 of 2004, Art. 54",
    salary: "Basic monthly salary",
    summary: "At least 3 weeks' basic pay per year of service, from 1 year of service.",
  },
  FR: {
    label: "France",
    law: "Code du travail, L1234-9 and R1234-2",
    salary: "Gross monthly salary (best of the last 12 or last 3 months' average)",
    summary: "Indemnité légale de licenciement: ¼ month per year up to 10 years, ⅓ month per year beyond, from 8 months of service. Owed on dismissal or rupture conventionnelle, not on resignation.",
  },
  CUSTOM: {
    label: "Other (set the rule yourself)",
    law: "Your contract or local law",
    salary: "Monthly salary the rule is based on",
    summary: "A number of days' pay per year of service, after a minimum service, with an optional cap.",
  },
} as const;

export type GratuityCountry = keyof typeof GRATUITY_COUNTRIES;
export const GRATUITY_COUNTRY_KEYS = Object.keys(GRATUITY_COUNTRIES) as GratuityCountry[];
export type ExitScenario = "resignation" | "termination";

const isoDate = z.string().refine(isISODate, "Expected YYYY-MM-DD");

export const gratuityParamsSchema = z
  .object({
    country: z.enum(GRATUITY_COUNTRY_KEYS as [GratuityCountry, ...GratuityCountry[]]),
    role: z.string().trim().max(120).nullish(),
    startDate: isoDate,
    endDate: isoDate.nullish().describe("Last day of work; empty while the job is ongoing"),
    /** Salary the rule is based on, with its changes over time (raises). */
    salaries: z
      .array(z.object({ from: isoDate, monthly: z.number().min(0) }))
      .min(1)
      .transform((s) => [...s].sort((a, b) => a.from.localeCompare(b.from))),
    /** Which exit the net-worth figure assumes. Only SA and FR tell them apart. */
    scenario: z.enum(["resignation", "termination"]).default("resignation"),
    custom: z
      .object({
        daysPerYear: z.number().min(0).max(366),
        minYears: z.number().min(0).max(20).default(1),
        capMonths: z.number().min(0).max(600).nullish(),
      })
      .nullish(),
  })
  .refine((p) => !p.endDate || p.endDate >= p.startDate, { message: "The end date is before the start date", path: ["endDate"] })
  .refine((p) => p.country !== "CUSTOM" || !!p.custom, { message: "A custom rule needs days per year", path: ["custom"] });

export type GratuityParams = z.output<typeof gratuityParamsSchema>;

export interface GratuityResult {
  amount: number;
  /** Years of service counted, with the fraction (e.g. 3.42). */
  years: number;
  eligible: boolean;
  /** Monthly salary the amount is based on. */
  salary: number;
  /** One line on how the number was reached. */
  formula: string;
  /** The next date the rule changes in your favour, if any. */
  next: { date: string; text: string } | null;
}

/** Salary in force on a date (the earliest one before the first step). */
export function salaryOn(p: Pick<GratuityParams, "salaries">, date: string): number {
  let s = p.salaries[0].monthly;
  for (const step of p.salaries) {
    if (step.from > date) break;
    s = step.monthly;
  }
  return s;
}

/** Calendar years between two ISO dates, fraction included: exactly 1 on the first anniversary. */
export function serviceYears(start: string, end: string): number {
  if (end <= start) return 0;
  return DateTime.fromISO(end).diff(DateTime.fromISO(start), "years").years;
}

const anniversary = (start: string, years: number) =>
  DateTime.fromISO(start).plus({ months: Math.round(years * 12) }).toISODate()!;

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtYears = (y: number) => `${round2(y).toFixed(2)} years`;

/**
 * The gratuity owed if the job ended on `date` (or on its end date, whichever
 * comes first), for the given way of leaving.
 */
export function gratuityOn(p: GratuityParams, date: string, scenario: ExitScenario = p.scenario): GratuityResult {
  const end = p.endDate && p.endDate < date ? p.endDate : date;
  const years = serviceYears(p.startDate, end);
  const salary = salaryOn(p, end);
  const daily = salary / 30; // UAE / Qatar practice: a month's pay is 30 days' pay.
  const result = (amount: number, eligible: boolean, formula: string, next: GratuityResult["next"]): GratuityResult => ({
    amount: round2(Math.max(0, amount)),
    years: round2(years),
    eligible,
    salary,
    formula,
    next: p.endDate && p.endDate <= date ? null : next,
  });

  switch (p.country) {
    case "AE": {
      if (years < 1) return result(0, false, `Under 1 year of service (${fmtYears(years)}): nothing is owed yet.`, { date: anniversary(p.startDate, 1), text: "1 year of service: gratuity starts at 21 days' basic pay per year." });
      const days = 21 * Math.min(years, 5) + 30 * Math.max(years - 5, 0);
      const cap = salary * 24;
      const amount = Math.min(days * daily, cap);
      const capped = days * daily > cap;
      return result(
        amount,
        true,
        `${round2(days).toFixed(1)} days × ${round2(daily)} a day (basic ÷ 30)${capped ? ", capped at 2 years' pay" : ""}.`,
        years < 5 ? { date: anniversary(p.startDate, 5), text: "5 years: each further year earns 30 days instead of 21." } : null,
      );
    }
    case "AE_DIFC": {
      // Contributions accrue month by month on the salary of that month.
      let total = 0;
      let cursor = DateTime.fromISO(p.startDate);
      const stop = DateTime.fromISO(end);
      while (cursor < stop) {
        const monthEnd = DateTime.min(cursor.plus({ months: 1 }), stop);
        const fraction = monthEnd.diff(cursor, "months").months;
        const rate = serviceYears(p.startDate, cursor.toISODate()!) < 5 ? 0.0583 : 0.0833;
        total += salaryOn(p, cursor.toISODate()!) * rate * fraction;
        cursor = monthEnd;
      }
      return result(
        total,
        true,
        `Employer DEWS contributions: ${years < 5 ? "5.83%" : "8.33%"} of basic a month now, ${fmtYears(years)} so far. Fund returns not included.`,
        years < 5 ? { date: anniversary(p.startDate, 5), text: "5 years: the monthly contribution rises from 5.83% to 8.33%." } : null,
      );
    }
    case "SA": {
      const full = salary * (0.5 * Math.min(years, 5) + Math.max(years - 5, 0));
      const share = scenario === "termination" ? 1 : years < 2 ? 0 : years < 5 ? 1 / 3 : years < 10 ? 2 / 3 : 1;
      const label = share === 1 ? "in full" : share === 0 ? "nothing on resignation before 2 years" : `${share < 0.5 ? "⅓" : "⅔"} on resignation`;
      const nextStep =
        years < 5
          ? { date: anniversary(p.startDate, scenario === "resignation" && years < 2 ? 2 : 5), text: scenario === "resignation" && years < 2 ? "2 years: resigning earns a third of the gratuity." : "5 years: a full month's wage per year from here, and two thirds on resignation." }
          : scenario === "resignation" && years < 10
            ? { date: anniversary(p.startDate, 10), text: "10 years: resigning earns the full gratuity." }
            : null;
      return result(full * share, share > 0, `${round2(0.5 * Math.min(years, 5) + Math.max(years - 5, 0)).toFixed(2)} months' wage, ${label}.`, nextStep);
    }
    case "QA": {
      if (years < 1) return result(0, false, `Under 1 year of service (${fmtYears(years)}): nothing is owed yet.`, { date: anniversary(p.startDate, 1), text: "1 year of service: 3 weeks' basic pay per year." });
      return result(21 * years * daily, true, `3 weeks (21 days) × ${fmtYears(years)} × ${round2(daily)} a day.`, null);
    }
    case "FR": {
      if (scenario === "resignation") return result(0, false, "No indemnité on resignation — only on dismissal or a rupture conventionnelle.", null);
      if (years < 8 / 12) return result(0, false, `Under 8 months of service (${fmtYears(years)}).`, { date: anniversary(p.startDate, 8 / 12), text: "8 months of service: the indemnité légale applies." });
      const months = 0.25 * Math.min(years, 10) + (1 / 3) * Math.max(years - 10, 0);
      return result(
        months * salary,
        true,
        `${round2(months).toFixed(2)} months' gross salary (¼ per year${years > 10 ? ", ⅓ beyond 10" : ""}). Check your convention collective, often higher.`,
        years < 10 ? { date: anniversary(p.startDate, 10), text: "10 years: each further year earns ⅓ of a month instead of ¼." } : null,
      );
    }
    case "CUSTOM": {
      const c = p.custom!;
      if (years < c.minYears) return result(0, false, `Under ${c.minYears} year(s) of service.`, { date: anniversary(p.startDate, c.minYears), text: `${c.minYears} year(s) of service: gratuity starts.` });
      const raw = c.daysPerYear * years * daily;
      const cap = c.capMonths ? c.capMonths * salary : Infinity;
      return result(Math.min(raw, cap), true, `${c.daysPerYear} days × ${fmtYears(years)} × ${round2(daily)} a day${raw > cap ? `, capped at ${c.capMonths} months` : ""}.`, null);
    }
  }
}
