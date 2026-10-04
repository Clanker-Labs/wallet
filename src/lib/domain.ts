/**
 * Shared domain vocabulary. Pure module: safe to import from client components,
 * server code, the MCP server and the Telegram worker.
 */

export const ASSET_CLASSES = [
  "cash",
  "investments",
  "retirement",
  "real_estate",
  "crypto",
  "commodities",
  "other",
  "liabilities",
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  cash: "Cash & savings",
  investments: "Investments",
  retirement: "Retirement",
  real_estate: "Real estate",
  crypto: "Crypto",
  commodities: "Commodities",
  other: "Other assets",
  liabilities: "Liabilities",
};

/**
 * Categorical slot per asset class, in a fixed order (color follows the entity,
 * never its rank). Slots map to CSS variables --series-1 … --series-7.
 */
export const ASSET_CLASS_SLOT: Record<Exclude<AssetClass, "liabilities">, number> = {
  cash: 1,
  investments: 2,
  retirement: 3,
  real_estate: 4,
  crypto: 5,
  commodities: 6,
  other: 7,
};

export const ACCOUNT_TYPES = {
  checking: { label: "Checking account", assetClass: "cash" },
  savings: { label: "Savings (Livret A, HYSA…)", assetClass: "cash" },
  brokerage: { label: "Brokerage", assetClass: "investments" },
  pea: { label: "PEA", assetClass: "investments" },
  life_insurance: { label: "Life insurance (assurance-vie)", assetClass: "investments" },
  employee_savings: { label: "Employee savings (PEE)", assetClass: "investments" },
  retirement: { label: "Retirement (401k, IRA, PER…)", assetClass: "retirement" },
  crypto: { label: "Crypto", assetClass: "crypto" },
  precious_metals: { label: "Precious metals & commodities", assetClass: "commodities" },
  real_estate: { label: "Real estate", assetClass: "real_estate" },
  vehicle: { label: "Vehicle", assetClass: "other" },
  other_asset: { label: "Other asset", assetClass: "other" },
  mortgage: { label: "Mortgage", assetClass: "liabilities" },
  loan: { label: "Loan (consumer, student…)", assetClass: "liabilities" },
  credit_card: { label: "Credit card", assetClass: "liabilities" },
  other_liability: { label: "Other liability", assetClass: "liabilities" },
} as const satisfies Record<string, { label: string; assetClass: AssetClass }>;

export type AccountType = keyof typeof ACCOUNT_TYPES;
export const ACCOUNT_TYPE_KEYS = Object.keys(ACCOUNT_TYPES) as AccountType[];

export function assetClassFor(type: AccountType): AssetClass {
  return ACCOUNT_TYPES[type].assetClass;
}

export function isLiability(assetClass: AssetClass): boolean {
  return assetClass === "liabilities";
}

/** Kinds of positions an account can hold. */
export const HOLDING_TYPES = {
  stock: "Stock",
  etf: "ETF",
  fund: "Fund",
  bond: "Bond",
  crypto: "Crypto",
  commodity: "Commodity",
  cash: "Cash",
  other: "Other",
} as const;
export type HoldingType = keyof typeof HOLDING_TYPES;
export const HOLDING_TYPE_KEYS = Object.keys(HOLDING_TYPES) as HoldingType[];

/** Account types whose value usually comes from holdings. */
export const HOLDING_ACCOUNT_TYPES: AccountType[] = [
  "brokerage",
  "pea",
  "life_insurance",
  "employee_savings",
  "retirement",
  "crypto",
  "precious_metals",
];

/** Currencies offered first in pickers; any code with a known FX rate works. */
export const COMMON_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CHF",
  "CAD",
  "AUD",
  "JPY",
  "CNY",
  "HKD",
  "SGD",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "INR",
  "BRL",
  "MXN",
  "AED",
  "BTC",
  "ETH",
  "XAU",
] as const;

export function normalizeCurrency(code: string): string {
  return code.trim().toUpperCase();
}

export function isCurrencyCode(code: string): boolean {
  return /^[A-Z0-9]{2,6}$/.test(normalizeCurrency(code));
}

/** Fixed-rate amortizing loan. Amounts are in currency units (not cents). */
export interface LoanParams {
  principal: number;
  annualRatePct: number;
  durationMonths: number;
  /** Date of the first monthly payment (YYYY-MM-DD). */
  startDate: string;
  /** Borrower insurance, % of initial principal per year (French style). */
  insuranceRatePct?: number;
}

export type CategoryKind = "income" | "expense" | "transfer";

export const DEFAULT_CATEGORIES: { name: string; kind: CategoryKind; icon: string }[] = [
  { name: "Salary", kind: "income", icon: "💼" },
  { name: "Freelance & side income", kind: "income", icon: "🧑‍💻" },
  { name: "Investment income", kind: "income", icon: "📈" },
  { name: "Refunds & other income", kind: "income", icon: "↩️" },
  { name: "Housing", kind: "expense", icon: "🏠" },
  { name: "Utilities & internet", kind: "expense", icon: "💡" },
  { name: "Groceries", kind: "expense", icon: "🛒" },
  { name: "Restaurants & bars", kind: "expense", icon: "🍽️" },
  { name: "Transport", kind: "expense", icon: "🚇" },
  { name: "Health", kind: "expense", icon: "🩺" },
  { name: "Insurance", kind: "expense", icon: "🛡️" },
  { name: "Subscriptions", kind: "expense", icon: "🔁" },
  { name: "Shopping", kind: "expense", icon: "🛍️" },
  { name: "Leisure", kind: "expense", icon: "🎟️" },
  { name: "Travel", kind: "expense", icon: "✈️" },
  { name: "Education", kind: "expense", icon: "📚" },
  { name: "Gifts & donations", kind: "expense", icon: "🎁" },
  { name: "Taxes", kind: "expense", icon: "🧾" },
  { name: "Bank fees", kind: "expense", icon: "🏦" },
  { name: "Loan repayments", kind: "expense", icon: "🏛️" },
  { name: "Other expenses", kind: "expense", icon: "📦" },
  { name: "Transfers", kind: "transfer", icon: "🔀" },
  { name: "Savings & investing", kind: "transfer", icon: "🐖" },
];
