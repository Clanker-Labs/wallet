/**
 * Fill a wallet with ~2 years of realistic demo data: "Alex", base currency
 * USD, living in Lyon (EUR salary and spending, a flat with a mortgage), with
 * a US brokerage and 401(k), a PEA, crypto and some gold. Synthetic FX rates
 * and prices are stored too, so the demo works offline.
 *
 *   npm run db:seed-demo [-- --force]
 *
 * Adds to the owner account (creates "Alex" if there is none yet); then run
 * `npm run auth:link` to sign in and add a passkey.
 */
import { DateTime } from "luxon";
import { db, dbPath } from "@/server/db/client";
import { createAccount, recordBalance } from "@/server/services/accounts";
import { importTransactions } from "@/server/services/transactions";
import { findCategory, upsertRule } from "@/server/services/categories";
import { setBudget } from "@/server/services/budgets";
import { createReminder } from "@/server/services/reminders";
import { saveSimulation } from "@/server/services/simulations";
import { upsertHolding } from "@/server/services/holdings";
import { storeRates } from "@/server/services/fx";
import { storePrices } from "@/server/services/prices";
import { holdingsValueCents, valuationContext } from "@/server/services/valuation";
import { countUsers, createUser, defaultUser } from "@/server/services/users";
import { today } from "@/server/services/settings";
import { endOfMonth, monthRange } from "@/lib/dates";
import type { ImportTransactionRow } from "@/server/services/transactions";

const force = process.argv.includes("--force");
const user = countUsers() === 0 ? createUser("Alex") : defaultUser();
const uid = user.id;
const existing = db().$client.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?").get(uid) as { n: number };
if (existing.n > 0 && !force) {
  console.error(`${user.name} already has accounts in ${dbPath()}. Re-run with --force to add demo data anyway.`);
  process.exit(1);
}

let seed = 1234;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const jitter = (base: number, pct: number) => base * (1 + (rand() * 2 - 1) * pct);
const round2 = (n: number) => Math.round(n * 100) / 100;

const end = DateTime.fromISO(today(uid));
const months = 24;
const start = end.minus({ months }).startOf("month");
const monthEnds = monthRange(start.toFormat("yyyy-MM"), end.minus({ months: 1 }).toFormat("yyyy-MM")).map(endOfMonth);
const dates = [...monthEnds, end.toISODate()!];
/** Smooth path from `from` to `to` over the timeline, with noise. */
const path = (from: number, to: number, noise: number) =>
  dates.map((_, i) => (from + ((to - from) * i) / (dates.length - 1)) * (1 + (rand() * 2 - 1) * noise));

// ── Market data (synthetic, so the demo works offline) ───────────────────
const eur = path(0.93, 0.9, 0.015);
const gbp = path(0.8, 0.77, 0.015);
const btcUsd = path(29_000, 64_000, 0.08);
const ethUsd = path(1_800, 3_100, 0.08);
const goldUsd = path(1_950, 2_620, 0.02);
dates.forEach((date, i) =>
  storeRates({
    date,
    perUsd: { USD: 1, EUR: eur[i], GBP: gbp[i], CHF: 0.88, JPY: 150, CAD: 1.36, BTC: 1 / btcUsd[i], ETH: 1 / ethUsd[i], XAU: 1 / goldUsd[i] },
  }),
);
const series = (symbol: string, currency: string, values: number[]) =>
  storePrices({ symbol, name: symbol, currency, assetType: "other", closes: dates.map((date, i) => ({ date, close: round2(values[i]) })) }, symbol);
series("VTI", "USD", path(215, 292, 0.03));
series("VXUS", "USD", path(54, 64, 0.03));
series("AAPL", "USD", path(172, 228, 0.05));
series("FXAIX", "USD", path(158, 212, 0.03));
series("CW8.PA", "EUR", path(415, 545, 0.03));
series("BTC-USD", "USD", btcUsd);
series("ETH-USD", "USD", ethUsd);
series("GC=F", "USD", goldUsd);

// ── Accounts ─────────────────────────────────────────────────────────────
const checking = createAccount(uid, { name: "Compte courant", institution: "BoursoBank", type: "checking", currency: "EUR" });
const livretA = createAccount(uid, { name: "Livret A", institution: "BoursoBank", type: "savings", currency: "EUR" });
const chase = createAccount(uid, { name: "Chase Checking", institution: "Chase", type: "checking", currency: "USD" });
const fidelity = createAccount(uid, { name: "Brokerage", institution: "Fidelity", type: "brokerage", currency: "USD" });
const k401 = createAccount(uid, { name: "401(k)", institution: "Fidelity", type: "retirement", currency: "USD" });
const pea = createAccount(uid, { name: "PEA", institution: "Boursorama", type: "pea", currency: "EUR" });
const coinbase = createAccount(uid, { name: "Crypto", institution: "Coinbase", type: "crypto", currency: "USD" });
const gold = createAccount(uid, { name: "Gold coins", institution: "Home safe", type: "precious_metals", currency: "USD" });
const flat = createAccount(uid, {
  name: "Apartment Lyon 7e",
  type: "real_estate",
  currency: "EUR",
  ownershipPct: 50,
  notes: "T3, 62 m², bought with partner",
});
// Bought ~18 months before tracking started, so history has no purchase jump.
const loanStart = start.minus({ months: 18 }).set({ day: 5 }).toISODate()!;
createAccount(uid, {
  name: "Mortgage Lyon 7e",
  institution: "Crédit Mutuel",
  type: "mortgage",
  currency: "EUR",
  ownershipPct: 50,
  linkedAccountId: flat.id,
  loanParams: { principal: 268_000, annualRatePct: 3.45, durationMonths: 300, startDate: loanStart, insuranceRatePct: 0.3 },
});
const car = createAccount(uid, { name: "Car (Zoe)", type: "vehicle", currency: "EUR" });

// Balance history for manually tracked accounts.
let livret = 16_000;
dates.forEach((date, m) => {
  livret = Math.min(22_950, livret * 1.0025 + 300);
  recordBalance(uid, { accountId: checking.id, balance: round2(jitter(2_900, 0.25)), date, source: "demo" });
  recordBalance(uid, { accountId: livretA.id, balance: round2(livret), date, source: "demo" });
  recordBalance(uid, { accountId: chase.id, balance: round2(jitter(1_800, 0.2)), date, source: "demo" });
  if (m % 3 === 0 || m === dates.length - 1) {
    recordBalance(uid, { accountId: car.id, balance: Math.round(12_500 * Math.pow(0.99, m)), date, source: "demo" });
  }
  if (m % 6 === 0 || m === dates.length - 1) {
    recordBalance(uid, { accountId: flat.id, balance: Math.round(340_000 * Math.pow(1.0015, m)), date, source: "demo" });
  }
});

// ── Holdings (valued daily from prices) ──────────────────────────────────
const positions: [number, string, string, "stock" | "etf" | "fund" | "crypto" | "commodity", number, string, number][] = [
  [fidelity.id, "VTI", "Vanguard Total Stock Market ETF", "etf", 85, "USD", 221.4],
  [fidelity.id, "VXUS", "Vanguard Total International Stock ETF", "etf", 120, "USD", 55.1],
  [fidelity.id, "AAPL", "Apple Inc.", "stock", 40, "USD", 168.2],
  [k401.id, "FXAIX", "Fidelity 500 Index Fund", "fund", 310, "USD", 150.3],
  [pea.id, "CW8.PA", "Amundi MSCI World UCITS ETF", "etf", 72, "EUR", 431.5],
  [coinbase.id, "BTC-USD", "Bitcoin", "crypto", 0.35, "USD", 31_200],
  [coinbase.id, "ETH-USD", "Ethereum", "crypto", 4.2, "USD", 1_950],
  [gold.id, "GC=F", "Gold (troy ounce)", "commodity", 5, "USD", 1_980],
];
for (const [accountId, symbol, name, assetType, quantity, currency, costBasis] of positions) {
  await upsertHolding(uid, { accountId, symbol, name, assetType, quantity, currency, costBasis }, { fetchPrice: false });
}
// Back-fill month-end values of holdings accounts so the history chart is continuous.
const ctx = valuationContext(uid);
for (const account of [fidelity, k401, pea, coinbase, gold]) {
  for (const date of monthEnds) {
    recordBalance(uid, { accountId: account.id, balance: holdingsValueCents(account, date, ctx).cents / 100, date, source: "holdings" });
  }
}

// ── Rules & budgets ──────────────────────────────────────────────────────
const cat = (name: string) => {
  const c = findCategory(uid, name);
  if (!c) throw new Error(`Missing category ${name}`);
  return c.id;
};
const rules: [string, string][] = [
  ["salaire", "Salary"],
  ["carrefour", "Groceries"],
  ["monoprix", "Groceries"],
  ["picard", "Groceries"],
  ["biocoop", "Groceries"],
  ["navigo", "Transport"],
  ["sncf", "Travel"],
  ["airbnb", "Travel"],
  ["edf", "Utilities & internet"],
  ["free mobile", "Utilities & internet"],
  ["freebox", "Utilities & internet"],
  ["netflix", "Subscriptions"],
  ["spotify", "Subscriptions"],
  ["github", "Subscriptions"],
  ["amazon", "Shopping"],
  ["fnac", "Shopping"],
  ["pharmacie", "Health"],
  ["credit immo", "Loan repayments"],
  ["vir pea", "Savings & investing"],
  ["vir livret", "Savings & investing"],
  ["maif", "Insurance"],
  ["ugc", "Leisure"],
  ["deliveroo", "Restaurants & bars"],
  ["uber eats", "Restaurants & bars"],
  ["copropriete", "Housing"],
];
for (const [p, c] of rules) upsertRule(uid, p, cat(c));

// Monthly envelopes in the base currency (USD).
const budgets: [string, number][] = [
  ["Groceries", 500],
  ["Restaurants & bars", 280],
  ["Transport", 100],
  ["Shopping", 220],
  ["Leisure", 130],
  ["Subscriptions", 60],
  ["Travel", 280],
  ["Utilities & internet", 120],
  ["Health", 70],
];
for (const [c, amount] of budgets) setBudget(uid, cat(c), amount);

// ── Transactions (EUR day-to-day + a few USD subscriptions) ──────────────
const eurRows: ImportTransactionRow[] = [];
const usdRows: ImportTransactionRow[] = [];
const push = (rows: ImportTransactionRow[], d: DateTime, amount: number, description: string) => {
  if (d > end) return;
  rows.push({ date: d.toISODate()!, amount: round2(amount), description });
};
for (let m = 6; m <= months; m++) {
  const month = start.plus({ months: m });
  const day = (n: number) => month.set({ day: Math.min(n, month.daysInMonth ?? 28) });
  const any = () => day(1 + Math.floor(rand() * 27));
  push(eurRows, day(27), jitter(3950, 0.02), "VIR SALAIRE ACME SAS");
  if (rand() < 0.3) push(eurRows, day(15), jitter(600, 0.4), "VIR CLIENT FREELANCE");
  push(eurRows, day(5), -704.5, "PRLV CREDIT IMMO CM 0012345");
  push(eurRows, day(3), -86.4, "PRLV NAVIGO ANNUEL");
  push(eurRows, day(8), -jitter(62, 0.2), "PRLV EDF CLIENTS PARTICULIERS");
  push(eurRows, day(10), -29.99, "PRLV FREEBOX");
  push(eurRows, day(12), -15.99, "PRLV FREE MOBILE");
  push(eurRows, day(14), -13.49, "NETFLIX.COM");
  push(eurRows, day(14), -11.12, "SPOTIFY P1A2B3");
  push(eurRows, day(20), -jitter(135, 0.05), "PRLV SYNDIC COPROPRIETE");
  push(eurRows, day(2), -jitter(28, 0.1), "PRLV MAIF ASSURANCE");
  push(eurRows, day(28), -500, "VIR PEA BOURSORAMA");
  push(eurRows, day(28), -300, "VIR LIVRET A");
  for (let g = 6 + Math.floor(rand() * 4); g > 0; g--) {
    const shop = ["CB CARREFOUR CITY LYON", "CB MONOPRIX LYON 7", "CB PICARD SURGELES", "CB BIOCOOP GERLAND"][Math.floor(rand() * 4)];
    push(eurRows, any(), -jitter(55, 0.5), shop);
  }
  for (let r = 3 + Math.floor(rand() * 5); r > 0; r--) {
    const place = ["CB LE BOUCHON DES FILLES", "CB DELIVEROO", "CB BAR LA MAISON", "CB PRAIRIAL", "CB UBER EATS"][Math.floor(rand() * 5)];
    push(eurRows, any(), -jitter(38, 0.5), place);
  }
  if (rand() < 0.7) push(eurRows, any(), -jitter(70, 0.8), "CB AMAZON EU SARL");
  if (rand() < 0.3) push(eurRows, any(), -jitter(90, 0.6), "CB FNAC BELLECOUR");
  if (rand() < 0.5) push(eurRows, any(), -jitter(22, 0.4), "CB PHARMACIE DU RHONE");
  if (rand() < 0.4) push(eurRows, any(), -jitter(25, 0.3), "CB UGC CINE CITE");
  if (rand() < 0.25) push(eurRows, any(), -jitter(180, 0.5), "CB SNCF CONNECT");
  if (m % 6 === 2) push(eurRows, day(18), -jitter(420, 0.3), "CB AIRBNB * HM4K2");
  if (rand() < 0.35) push(eurRows, any(), -jitter(45, 0.6), "CB LECLERC DRIVE");
  if (rand() < 0.3) push(eurRows, any(), -jitter(30, 0.5), "PAYPAL *VINTED");
  push(usdRows, day(4), -4, "GITHUB INC");
  if (m % 12 === 7) push(usdRows, day(9), -139, "AMAZON PRIME ANNUAL");
}
const res = importTransactions(uid, eurRows, checking.id, { source: "demo" });
importTransactions(uid, usdRows, chase.id, { source: "demo" });

// ── Reminders & a saved scenario ─────────────────────────────────────────
createReminder(uid, {
  title: "Update your balances",
  message: "Grab the numbers from your banking apps — one reply per account.",
  kind: "balance_update",
  frequency: "monthly",
  dayOfMonth: 1,
  timeOfDay: "09:00",
  nagEveryHours: 24,
});
createReminder(uid, {
  title: "Import last month's bank statement",
  message: "Download the CSV or PDF from BoursoBank and drop it into the assistant.",
  kind: "statement",
  frequency: "monthly",
  dayOfMonth: 3,
  timeOfDay: "19:00",
  nagEveryHours: 24,
});
createReminder(uid, { title: "Monthly money report", kind: "monthly_report", frequency: "monthly", dayOfMonth: 1, timeOfDay: "08:30" });
createReminder(uid, {
  title: "Check the mortgage statement",
  message: "Compare the bank's remaining principal with wallet's amortization estimate.",
  kind: "custom",
  frequency: "yearly",
  dayOfMonth: 15,
  monthOfYear: 1,
  timeOfDay: "10:00",
});
saveSimulation(uid, {
  name: "Bigger flat in Lyon 6e",
  type: "mortgage",
  params: { price: 520_000, downPayment: 90_000, annualRatePct: 3.2, durationYears: 25, monthlyNetIncome: 7200 },
});

console.log(
  `Seeded demo data for ${user.name} into ${dbPath()}: ${res.inserted + usdRows.length} transactions, 12 accounts, ${positions.length} holdings.`,
);
console.log("Sign in: npm run auth:link");
