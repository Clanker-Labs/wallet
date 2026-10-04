import { z } from "zod";

/**
 * Net worth projection: monthly compounding of a blended portfolio with
 * growing contributions, one-off events, inflation-adjusted view, an optional
 * Monte Carlo band and a financial-independence target.
 */
export const projectionInputSchema = z.object({
  startingNetWorth: z.number().describe("Net worth today"),
  monthlyContribution: z.number().default(500).describe("Amount saved/invested per month"),
  contributionGrowthPct: z.number().min(-20).max(30).default(2).describe("Yearly growth of the monthly contribution, %"),
  annualReturnPct: z.number().min(-20).max(30).default(5).describe("Expected blended return, % per year"),
  volatilityPct: z
    .number()
    .min(0)
    .max(100)
    .default(12)
    .describe("Annual volatility for the Monte Carlo band (0 = deterministic only)"),
  inflationPct: z.number().min(-5).max(20).default(2),
  horizonYears: z.number().int().min(1).max(60).default(20),
  annualExpenses: z
    .number()
    .min(0)
    .optional()
    .describe("Yearly spending in today's money, to compute a financial-independence target"),
  withdrawalRatePct: z.number().min(1).max(10).default(4),
  events: z
    .array(
      z.object({
        year: z.number().int().min(0).describe("Years from now (0 = this year)"),
        amount: z.number().describe("Positive = inflow (inheritance, bonus), negative = outflow (wedding, car)"),
        label: z.string().default(""),
      }),
    )
    .default([]),
  simulations: z.number().int().min(0).max(2000).default(400),
  seed: z.number().int().default(42),
});
export type ProjectionInput = z.input<typeof projectionInputSchema>;

export interface ProjectionYear {
  year: number;
  nominal: number;
  real: number;
  contributions: number;
  p10?: number;
  p50?: number;
  p90?: number;
}

export interface ProjectionResult {
  yearly: ProjectionYear[];
  finalNominal: number;
  finalReal: number;
  totalContributions: number;
  totalGrowth: number;
  fiTarget: number | null;
  /** First year (from now) when the real net worth reaches the FI target. */
  fiYear: number | null;
  /** Share of Monte Carlo paths that reach the FI target by the horizon. */
  fiProbability: number | null;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function projectNetWorth(raw: ProjectionInput): ProjectionResult {
  const i = projectionInputSchema.parse(raw);
  const months = i.horizonYears * 12;
  const rMonthly = Math.pow(1 + i.annualReturnPct / 100, 1 / 12) - 1;
  const eventsByYear = new Map<number, number>();
  for (const e of i.events) eventsByYear.set(e.year, (eventsByYear.get(e.year) ?? 0) + e.amount);

  const contributionAt = (m: number) =>
    i.monthlyContribution * Math.pow(1 + i.contributionGrowthPct / 100, Math.floor((m - 1) / 12));
  const deflator = (years: number) => Math.pow(1 + i.inflationPct / 100, years);

  // Deterministic path
  let nw = i.startingNetWorth + (eventsByYear.get(0) ?? 0);
  let contributions = 0;
  const yearly: ProjectionYear[] = [
    { year: 0, nominal: nw, real: nw, contributions: 0 },
  ];
  for (let m = 1; m <= months; m++) {
    nw = nw * (1 + rMonthly) + contributionAt(m);
    contributions += contributionAt(m);
    if (m % 12 === 0) {
      const y = m / 12;
      nw += eventsByYear.get(y) ?? 0;
      yearly.push({ year: y, nominal: nw, real: nw / deflator(y), contributions });
    }
  }

  const fiTarget =
    i.annualExpenses && i.annualExpenses > 0 ? i.annualExpenses / (i.withdrawalRatePct / 100) : null;
  const fiYear = fiTarget === null ? null : (yearly.find((p) => p.real >= fiTarget)?.year ?? null);

  // Monte Carlo band (log-normal monthly returns with the same expected growth).
  let fiProbability: number | null = null;
  if (i.volatilityPct > 0 && i.simulations > 0) {
    const rand = mulberry32(i.seed);
    const sigmaM = i.volatilityPct / 100 / Math.sqrt(12);
    const muM = Math.log(1 + rMonthly) - (sigmaM * sigmaM) / 2;
    const byYear: number[][] = Array.from({ length: i.horizonYears + 1 }, () => []);
    let reached = 0;
    for (let s = 0; s < i.simulations; s++) {
      let v = i.startingNetWorth + (eventsByYear.get(0) ?? 0);
      byYear[0].push(v);
      let hit = fiTarget !== null && v >= fiTarget;
      for (let m = 1; m <= months; m++) {
        v = v * Math.exp(muM + sigmaM * gaussian(rand)) + contributionAt(m);
        if (m % 12 === 0) {
          const y = m / 12;
          v += eventsByYear.get(y) ?? 0;
          byYear[y].push(v);
          if (fiTarget !== null && v / deflator(y) >= fiTarget) hit = true;
        }
      }
      if (hit) reached++;
    }
    for (const point of yearly) {
      const sorted = byYear[point.year].sort((a, b) => a - b);
      point.p10 = percentile(sorted, 0.1);
      point.p50 = percentile(sorted, 0.5);
      point.p90 = percentile(sorted, 0.9);
    }
    if (fiTarget !== null) fiProbability = reached / i.simulations;
  }

  const last = yearly.at(-1)!;
  return {
    yearly,
    finalNominal: last.nominal,
    finalReal: last.real,
    totalContributions: contributions,
    totalGrowth: last.nominal - i.startingNetWorth - contributions - [...eventsByYear.values()].reduce((a, b) => a + b, 0),
    fiTarget,
    fiYear,
    fiProbability,
  };
}

/** Rough long-run assumptions per asset class, used to prefill projections. */
export const CLASS_ASSUMPTIONS: Record<string, { returnPct: number; volatilityPct: number }> = {
  cash: { returnPct: 2.5, volatilityPct: 0.5 },
  investments: { returnPct: 6, volatilityPct: 15 },
  retirement: { returnPct: 5, volatilityPct: 12 },
  real_estate: { returnPct: 2.5, volatilityPct: 6 },
  crypto: { returnPct: 8, volatilityPct: 60 },
  other: { returnPct: 0, volatilityPct: 5 },
};

/** Value-weighted return & volatility of the current allocation (assets only). */
export function blendedAssumptions(byClass: Record<string, number>): {
  returnPct: number;
  volatilityPct: number;
} {
  let total = 0;
  let r = 0;
  let v = 0;
  for (const [cls, amount] of Object.entries(byClass)) {
    const a = CLASS_ASSUMPTIONS[cls];
    if (!a || amount <= 0) continue;
    total += amount;
    r += a.returnPct * amount;
    v += a.volatilityPct * amount;
  }
  if (total === 0) return { returnPct: 4, volatilityPct: 10 };
  return { returnPct: round1(r / total), volatilityPct: round1(v / total) };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
