/**
 * Tax rules by country. Pure functions on amounts in the country's currency
 * (EUR for France, AED for the UAE). Every rule cites its source and is an
 * estimate: credits, reliefs and treaty details beyond what is modelled here
 * change real bills. The service (server/services/tax.ts) feeds them your data.
 */

export interface Bracket {
  /** Upper bound of the slice (inclusive), or null for the top one. */
  upTo: number | null;
  rate: number;
}

export function progressive(income: number, brackets: Bracket[]): { tax: number; marginal: number; slices: { from: number; to: number; rate: number; tax: number }[] } {
  let prev = 0;
  let tax = 0;
  let marginal = 0;
  const slices: { from: number; to: number; rate: number; tax: number }[] = [];
  for (const b of brackets) {
    if (income <= prev) break;
    const top = b.upTo === null ? income : Math.min(income, b.upTo);
    const part = (top - prev) * b.rate;
    if (top > prev) slices.push({ from: prev, to: top, rate: b.rate, tax: part });
    tax += part;
    marginal = b.rate;
    if (b.upTo === null || income <= b.upTo) break;
    prev = b.upTo;
  }
  return { tax: round2(tax), marginal, slices };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── France ────────────────────────────────────────────────────────────────

/**
 * Barème de l'impôt sur le revenu by income year (CGI art. 197). Income of
 * 2024 is taxed with the 2025 law's barème. Later years fall back to the
 * latest published one (flagged).
 */
export const FR_IR_BAREME: Record<number, Bracket[]> = {
  2023: [
    { upTo: 11_294, rate: 0 },
    { upTo: 28_797, rate: 0.11 },
    { upTo: 82_341, rate: 0.3 },
    { upTo: 177_106, rate: 0.41 },
    { upTo: null, rate: 0.45 },
  ],
  2024: [
    { upTo: 11_497, rate: 0 },
    { upTo: 29_315, rate: 0.11 },
    { upTo: 83_823, rate: 0.3 },
    { upTo: 180_294, rate: 0.41 },
    { upTo: null, rate: 0.45 },
  ],
};

export function frBareme(year: number): { brackets: Bracket[]; year: number; latest: boolean } {
  const years = Object.keys(FR_IR_BAREME).map(Number).sort((a, b) => a - b);
  const y = years.includes(year) ? year : years.filter((x) => x <= year).at(-1) ?? years[0];
  return { brackets: FR_IR_BAREME[y], year: y, latest: y !== year };
}

/** Impôt sur le revenu with the quotient familial (cap on the quotient's benefit not modelled). */
export function frIncomeTax(taxable: number, parts: number, year: number) {
  const { brackets, year: used, latest } = frBareme(year);
  const per = progressive(Math.max(0, taxable) / parts, brackets);
  return { tax: round2(per.tax * parts), marginal: per.marginal, baremeYear: used, approximated: latest };
}

/**
 * A non-resident's French-source income: the barème, but at least 20% up to
 * the top of the 11% slice and 30% above (CGI art. 197 A). The "average rate
 * on worldwide income" option, which can be lower, needs that income declared.
 */
export function frNonResidentTax(taxable: number, parts: number, year: number) {
  const { brackets } = frBareme(year);
  const limit = brackets[1].upTo!;
  const scale = frIncomeTax(taxable, parts, year);
  const minimum = round2(0.2 * Math.min(taxable, limit) + 0.3 * Math.max(0, taxable - limit));
  return { tax: Math.max(scale.tax, minimum), byMinimumRate: minimum > scale.tax, scaleTax: scale.tax, minimumTax: minimum, baremeYear: scale.baremeYear, approximated: scale.approximated };
}

/**
 * Unfurnished rental income (revenus fonciers). Micro-foncier: gross up to
 * 15,000 €, 30% flat allowance (CGI art. 32). Réel: gross minus deductible
 * costs and loan interest (CGI art. 31); a loss is not carried here.
 */
export function frRentalTaxable(gross: number, opts: { regime: "micro" | "reel"; expenses?: number; interest?: number }) {
  if (opts.regime === "micro") {
    if (gross > 15_000) return { taxable: round2(Math.max(0, gross - (opts.expenses ?? 0) - (opts.interest ?? 0))), regime: "reel" as const, note: "Above 15,000 € gross, micro-foncier is not available: régime réel applied." };
    return { taxable: round2(gross * 0.7), regime: "micro" as const, note: "Micro-foncier: 30% flat allowance." };
  }
  const net = gross - (opts.expenses ?? 0) - (opts.interest ?? 0);
  return {
    taxable: round2(Math.max(0, net)),
    regime: "reel" as const,
    note: net < 0 ? `Déficit foncier of ${round2(-net)} € (offsets future rental income; up to 10,700 € a year against other income for residents).` : "Régime réel: costs and loan interest deducted.",
  };
}

/** Prélèvements sociaux on property income: 17.2%, or 7.5% if covered by an EEA/UK/Swiss social security system. */
export const FR_SOCIAL_RATE = { standard: 0.172, eea: 0.075 };

/** Impôt sur la fortune immobilière (CGI art. 977), with the décote between 1.3 M€ and 1.4 M€. */
export const FR_IFI: Bracket[] = [
  { upTo: 800_000, rate: 0 },
  { upTo: 1_300_000, rate: 0.005 },
  { upTo: 2_570_000, rate: 0.007 },
  { upTo: 5_000_000, rate: 0.01 },
  { upTo: 10_000_000, rate: 0.0125 },
  { upTo: null, rate: 0.015 },
];

export function frIfi(netTaxable: number) {
  if (netTaxable < 1_300_000) return { tax: 0, due: false, note: "Below 1,300,000 € of net taxable real estate: no IFI." };
  let tax = progressive(netTaxable, FR_IFI).tax;
  let note = "IFI barème.";
  if (netTaxable < 1_400_000) {
    const decote = 17_500 - 0.0125 * netTaxable;
    tax = Math.max(0, tax - decote);
    note = `Décote of ${round2(decote)} € (between 1.3 M€ and 1.4 M€).`;
  }
  return { tax: round2(tax), due: tax > 0, note };
}

/** Impôt sur les sociétés: 15% up to 42,500 € of profit for an eligible SME, 25% above (CGI art. 219). */
export function frCorporateTax(profit: number, opts: { smeRate?: boolean } = {}) {
  if (profit <= 0) return { tax: 0, note: "No profit, no IS (a loss carries forward)." };
  const sme = opts.smeRate ?? true;
  const tax = sme ? 0.15 * Math.min(profit, 42_500) + 0.25 * Math.max(0, profit - 42_500) : 0.25 * profit;
  return { tax: round2(tax), note: sme ? "15% up to 42,500 €, then 25% (PME rate: revenue under 10 M€, capital held ≥75% by individuals)." : "25%." };
}

// ── United Arab Emirates ──────────────────────────────────────────────────

/**
 * Corporate tax (Federal Decree-Law No. 47 of 2022): 0% up to AED 375,000 of
 * taxable income, 9% above. Small Business Relief (Ministerial Decision
 * No. 73 of 2023): revenue up to AED 3,000,000 can elect to be treated as
 * having no taxable income, for tax periods ending by 31 December 2026. A
 * Qualifying Free Zone Person pays 0% on qualifying income.
 */
export function aeCorporateTax(taxable: number, revenue: number, opts: { year: number; smallBusinessRelief?: boolean; qualifyingFreeZone?: boolean }) {
  const sbrPossible = revenue <= 3_000_000 && opts.year <= 2026;
  if (opts.qualifyingFreeZone) return { tax: 0, note: "Qualifying Free Zone Person: 0% on qualifying income (non-qualifying income is taxed at 9%).", sbrPossible };
  if (opts.smallBusinessRelief && sbrPossible) return { tax: 0, note: "Small Business Relief elected: revenue ≤ AED 3M, treated as no taxable income.", sbrPossible };
  if (taxable <= 0) return { tax: 0, note: "No taxable income.", sbrPossible };
  const tax = 0.09 * Math.max(0, taxable - 375_000);
  return {
    tax: round2(tax),
    note: `0% up to AED 375,000, 9% above.${sbrPossible ? " Revenue is under AED 3M: Small Business Relief could bring this to 0 — it must be elected in the return." : ""}`,
    sbrPossible,
  };
}

/** UAE tax residency for individuals (Cabinet Decision No. 85 of 2022). */
export function aeResidency(daysInUae: number, opts: { homeOrJobInUae?: boolean } = {}) {
  if (daysInUae >= 183) return { resident: true, note: `${daysInUae} days in the UAE: resident (183-day test).` };
  if (daysInUae >= 90 && opts.homeOrJobInUae) return { resident: true, note: `${daysInUae} days with a home or job in the UAE: resident (90-day test).` };
  return { resident: false, note: `${daysInUae} days in the UAE: below the 183-day test${daysInUae >= 90 ? " (90 days is enough with a permanent home or a job in the UAE)" : ""}.` };
}

/** France's own test (CGI art. 4 B): any one of home/main stay, main job, or centre of economic interests. */
export function frResidencyHint(daysInFrance: number) {
  return daysInFrance >= 183
    ? `${daysInFrance} days in France: "séjour principal" there makes you French tax resident (CGI 4 B), whatever other country also claims you — the France–UAE treaty then decides.`
    : `${daysInFrance} days in France. Residency in France also follows from your main job or centre of economic interests being there (CGI 4 B).`;
}
