import { purchaseInputSchema } from "@/lib/finance/mortgage";
import { buyVsRentInputSchema } from "@/lib/finance/buy-vs-rent";
import { projectionInputSchema } from "@/lib/finance/projection";
import type { Num, NumState } from "./sim-fields";

/** Shared state shapes, defaults and (de)serialization for the simulators. */

export type SimTab = "mortgage" | "rent" | "projection";
export type SimType = "mortgage" | "buy_vs_rent" | "projection";

export const TAB_TYPE: Record<SimTab, SimType> = { mortgage: "mortgage", rent: "buy_vs_rent", projection: "projection" };
export const TYPE_TAB: Record<SimType, SimTab> = { mortgage: "mortgage", buy_vs_rent: "rent", projection: "projection" };
export const TYPE_LABEL: Record<SimType, string> = { mortgage: "Mortgage", buy_vs_rent: "Buy vs rent", projection: "Projection" };

export function isSimTab(s: unknown): s is SimTab {
  return s === "mortgage" || s === "rent" || s === "projection";
}

export interface SavedScenario {
  id: number;
  name: string;
  type: SimType;
  params: Record<string, unknown>;
  createdLabel: string;
}

/** Values computed on the server from the user's own data. */
export interface DataDefaults {
  startingNetWorth: number;
  monthlyContribution: number | null;
  annualReturnPct: number;
  volatilityPct: number;
  annualExpenses: number | null;
  monthlyNetIncome: number | null;
  monthsWithData: number;
}

// Purchase fields are shared by the Mortgage and Buy-vs-rent tabs.
export const PURCHASE_KEYS = [
  "price",
  "downPayment",
  "annualRatePct",
  "durationYears",
  "insuranceRatePct",
  "notaryFeesPct",
  "guaranteeFeesPct",
  "bankFees",
  "agencyFees",
  "renovation",
  "appreciationPct",
] as const;
export const MORTGAGE_KEYS = ["monthlyNetIncome", "otherMonthlyDebts"] as const;
export const RENT_KEYS = [
  "monthlyRent",
  "rentIncreasePct",
  "propertyTaxYearly",
  "coOwnershipMonthly",
  "maintenancePct",
  "sellingCostsPct",
  "investmentReturnPct",
  "portfolioTaxPct",
  "horizonYears",
] as const;
export const PROJECTION_KEYS = [
  "startingNetWorth",
  "monthlyContribution",
  "contributionGrowthPct",
  "annualReturnPct",
  "volatilityPct",
  "inflationPct",
  "horizonYears",
  "annualExpenses",
  "withdrawalRatePct",
] as const;

export type PurchaseKey = (typeof PURCHASE_KEYS)[number];
export type MortgageKey = (typeof MORTGAGE_KEYS)[number];
export type RentKey = (typeof RENT_KEYS)[number];
export type ProjectionKey = (typeof PROJECTION_KEYS)[number];

export type PurchaseState = NumState<PurchaseKey>;
export type MortgageState = NumState<MortgageKey>;
export type RentState = NumState<RentKey>;
export type ProjectionState = NumState<ProjectionKey>;

export interface EventRow {
  id: number;
  year: Num;
  amount: Num;
  label: string;
}

// Schema defaults (single source of truth with the agent tools).
export const PURCHASE_DEFAULTS = purchaseInputSchema.parse({ price: 300_000 });
export const RENT_DEFAULTS = buyVsRentInputSchema.parse({ price: 300_000, monthlyRent: 1_100 });
export const PROJECTION_DEFAULTS = projectionInputSchema.parse({ startingNetWorth: 0 });

/** Field descriptions from the zod schemas, used as hints. */
export const describe = {
  purchase: (k: string) => (purchaseInputSchema.shape as Record<string, { description?: string }>)[k]?.description,
  rent: (k: string) => (buyVsRentInputSchema.shape as Record<string, { description?: string }>)[k]?.description,
  projection: (k: string) => (projectionInputSchema.shape as Record<string, { description?: string }>)[k]?.description,
};

export const NOTARY_EXISTING = 7.5;
export const NOTARY_NEW = 2.5;

export function initialPurchase(): PurchaseState {
  const d = PURCHASE_DEFAULTS;
  return {
    price: 300_000,
    downPayment: 30_000,
    annualRatePct: d.annualRatePct,
    durationYears: d.durationYears,
    insuranceRatePct: d.insuranceRatePct,
    notaryFeesPct: d.notaryFeesPct,
    guaranteeFeesPct: d.guaranteeFeesPct,
    bankFees: d.bankFees,
    agencyFees: d.agencyFees,
    renovation: d.renovation,
    appreciationPct: d.appreciationPct,
  };
}

export function initialMortgage(data: DataDefaults): MortgageState {
  return { monthlyNetIncome: data.monthlyNetIncome ?? undefined, otherMonthlyDebts: 0 };
}

export function initialRent(): RentState {
  const d = RENT_DEFAULTS;
  return {
    monthlyRent: 1_100,
    rentIncreasePct: d.rentIncreasePct,
    propertyTaxYearly: d.propertyTaxYearly,
    coOwnershipMonthly: d.coOwnershipMonthly,
    maintenancePct: d.maintenancePct,
    sellingCostsPct: d.sellingCostsPct,
    investmentReturnPct: d.investmentReturnPct,
    portfolioTaxPct: d.portfolioTaxPct,
    horizonYears: d.horizonYears,
  };
}

export function initialProjection(data: DataDefaults): ProjectionState {
  const d = PROJECTION_DEFAULTS;
  return {
    startingNetWorth: data.startingNetWorth,
    monthlyContribution: data.monthlyContribution ?? d.monthlyContribution,
    contributionGrowthPct: d.contributionGrowthPct,
    annualReturnPct: data.annualReturnPct,
    volatilityPct: data.volatilityPct,
    inflationPct: d.inflationPct,
    horizonYears: d.horizonYears,
    annualExpenses: data.annualExpenses ?? undefined,
    withdrawalRatePct: d.withdrawalRatePct,
  };
}

/** Copy the numeric keys of a saved params object over a base state. */
export function pick<K extends string>(keys: readonly K[], params: Record<string, unknown>, base: NumState<K>): NumState<K> {
  const out = { ...base };
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (k in params && (v === null || v === undefined)) out[k] = undefined;
  }
  return out;
}

export function pickEvents(params: Record<string, unknown>): EventRow[] {
  const raw = Array.isArray(params.events) ? params.events : [];
  return raw.flatMap((e, idx) => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    return [
      {
        id: idx + 1,
        year: typeof o.year === "number" ? o.year : undefined,
        amount: typeof o.amount === "number" ? o.amount : undefined,
        label: typeof o.label === "string" ? o.label : "",
      },
    ];
  });
}

/** Drop undefined values (for saving / passing to zod). */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Events that are complete enough to simulate. */
export function eventsInput(rows: EventRow[]) {
  return rows
    .filter((r) => r.year !== undefined && r.amount !== undefined)
    .map((r) => ({ year: r.year as number, amount: r.amount as number, label: r.label }));
}
