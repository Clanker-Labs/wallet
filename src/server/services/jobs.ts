import { z } from "zod";
import { DateTime } from "luxon";
import {
  GRATUITY_COUNTRIES,
  GRATUITY_COUNTRY_KEYS,
  gratuityOn,
  gratuityParamsSchema,
  type GratuityCountry,
  type GratuityParams,
  type GratuityResult,
} from "@/lib/finance/gratuity";
import { isISODate } from "@/lib/dates";
import { createAccount, listAccounts, updateAccount, type AccountWithBalance } from "./accounts";
import { today } from "./settings";

/**
 * Jobs are accounts of type `end_of_service` whose balance is the gratuity
 * accrued under the job's country's law (see lib/finance/gratuity). This
 * module is the job-shaped view of them: terms in, accrual out.
 */

const isoDate = z.string().refine(isISODate, "Expected YYYY-MM-DD");

export const jobInputSchema = z.object({
  accountId: z.number().int().optional().describe("Existing job to update; omit to add a job"),
  employer: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).nullish(),
  country: z.enum(GRATUITY_COUNTRY_KEYS as [GratuityCountry, ...GratuityCountry[]]).describe(
    "AE (UAE mainland), AE_DIFC (DIFC, DEWS), SA (Saudi Arabia), QA (Qatar), FR (France), CUSTOM",
  ),
  startDate: isoDate,
  endDate: isoDate.nullish().describe("Last day of work; omit while the job is ongoing"),
  currency: z.string().trim().min(3).max(10).optional().describe("Salary currency, e.g. AED (default: base currency)"),
  monthlySalary: z.number().min(0).optional().describe("Monthly salary the law uses (UAE/Qatar: basic only), from the start date"),
  salaries: z
    .array(z.object({ from: isoDate, monthly: z.number().min(0) }))
    .optional()
    .describe("Full salary history (raises), replacing monthlySalary; each step applies from its date"),
  scenario: z.enum(["resignation", "termination"]).optional().describe("Exit counted in net worth (default resignation, the conservative one)"),
  custom: z.object({ daysPerYear: z.number(), minYears: z.number().default(1), capMonths: z.number().nullish() }).nullish(),
  includeInNetWorth: z.boolean().optional(),
});
export type JobInput = z.input<typeof jobInputSchema>;

export interface JobView {
  accountId: number;
  employer: string;
  role: string | null;
  currency: string;
  archived: boolean;
  includeInNetWorth: boolean;
  params: GratuityParams;
  rule: (typeof GRATUITY_COUNTRIES)[GratuityCountry];
  /** If the job ended today, by way of leaving. */
  now: { resignation: GratuityResult; termination: GratuityResult };
  /** The figure counted in net worth (the job's scenario), in the job's currency. */
  counted: GratuityResult;
  /** Accrued per day over the last ~30 days, at today's salary. */
  perDay: number;
  account: AccountWithBalance;
}

function view(a: AccountWithBalance, t: string): JobView {
  const p = a.gratuityParams!;
  const resignation = gratuityOn(p, t, "resignation");
  const termination = gratuityOn(p, t, "termination");
  const monthAgo = DateTime.fromISO(t).minus({ days: 30 }).toISODate()!;
  const counted = p.scenario === "termination" ? termination : resignation;
  return {
    accountId: a.id,
    employer: a.name,
    role: p.role ?? a.institution ?? null,
    currency: a.currency,
    archived: !!a.archivedAt,
    includeInNetWorth: a.includeInNetWorth,
    params: p,
    rule: GRATUITY_COUNTRIES[p.country],
    now: { resignation, termination },
    counted,
    perDay: Math.round(((counted.amount - gratuityOn(p, monthAgo).amount) / 30) * 100) / 100,
    account: a,
  };
}

export function listJobs(uid: string, opts: { includeArchived?: boolean } = {}): JobView[] {
  const t = today(uid);
  return listAccounts(uid, { includeArchived: opts.includeArchived ?? true })
    .filter((a) => a.gratuityParams)
    .map((a) => view(a, t));
}

export function getJob(uid: string, accountId: number): JobView {
  const job = listJobs(uid).find((j) => j.accountId === accountId);
  if (!job) throw new Error(`No job with id ${accountId}`);
  return job;
}

/** Add or update a job (and the account that carries its gratuity). */
export function saveJob(uid: string, raw: JobInput): JobView {
  const i = jobInputSchema.parse(raw);
  const existing = i.accountId ? getJob(uid, i.accountId) : null;
  const salaries =
    i.salaries ??
    (i.monthlySalary !== undefined
      ? [{ from: i.startDate, monthly: i.monthlySalary }]
      : existing
        ? existing.params.salaries
        : undefined);
  if (!salaries?.length) throw new Error("Give the monthly salary the gratuity is based on (monthlySalary or salaries).");
  // A start date moved earlier must not leave the first salary step dangling after it.
  if (salaries[0].from > i.startDate) salaries[0] = { ...salaries[0], from: i.startDate };
  const gratuityParams = gratuityParamsSchema.parse({
    country: i.country,
    role: i.role ?? null,
    startDate: i.startDate,
    endDate: i.endDate ?? null,
    salaries,
    scenario: i.scenario ?? existing?.params.scenario ?? "resignation",
    custom: i.custom ?? null,
  });
  if (existing) {
    updateAccount(uid, existing.accountId, {
      name: i.employer,
      institution: i.role ?? null,
      ...(i.currency ? { currency: i.currency } : {}),
      ...(i.includeInNetWorth !== undefined ? { includeInNetWorth: i.includeInNetWorth } : {}),
      gratuityParams,
    });
    return getJob(uid, existing.accountId);
  }
  const acc = createAccount(uid, {
    name: i.employer,
    institution: i.role ?? null,
    type: "end_of_service",
    currency: i.currency,
    includeInNetWorth: i.includeInNetWorth ?? true,
    gratuityParams,
  });
  return getJob(uid, acc.id);
}

/**
 * Accrual over time for a chart: every day from the start (thinned to keep
 * long careers light), then a projection if the job carries on.
 */
export function accrualSeries(p: GratuityParams, todayIso: string, projectYears = 3): { date: string; accrued?: number; projected?: number }[] {
  const start = DateTime.fromISO(p.startDate);
  const t = DateTime.fromISO(todayIso);
  const end = p.endDate ? DateTime.min(DateTime.fromISO(p.endDate), t) : t;
  const spanDays = Math.max(1, end.diff(start, "days").days);
  const step = Math.max(1, Math.ceil(spanDays / 1500)); // ≤ ~1,500 points
  const out: { date: string; accrued?: number; projected?: number }[] = [];
  for (let d = start; d <= end; d = d.plus({ days: step })) out.push({ date: d.toISODate()!, accrued: gratuityOn(p, d.toISODate()!).amount });
  const last = end.toISODate()!;
  if (out.at(-1)?.date !== last) out.push({ date: last, accrued: gratuityOn(p, last).amount });
  if (!p.endDate && projectYears > 0) {
    out[out.length - 1].projected = out[out.length - 1].accrued;
    for (let d = t.plus({ weeks: 2 }); d <= t.plus({ years: projectYears }); d = d.plus({ weeks: 2 }))
      out.push({ date: d.toISODate()!, projected: gratuityOn(p, d.toISODate()!).amount });
  }
  return out;
}
