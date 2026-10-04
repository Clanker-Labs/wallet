/**
 * Fill the database with ~2 years of realistic demo data (a couple in Lyon
 * with a mortgage, PEA, assurance-vie…). Refuses to run on a non-empty DB
 * unless --force is passed.
 *
 *   npm run db:seed-demo [-- --force]
 */
import { DateTime } from "luxon";
import { db, dbPath } from "@/server/db/client";
import { createAccount, recordBalance } from "@/server/services/accounts";
import { importTransactions } from "@/server/services/transactions";
import { findCategory, upsertRule } from "@/server/services/categories";
import { setBudget } from "@/server/services/budgets";
import { createReminder } from "@/server/services/reminders";
import { saveSimulation } from "@/server/services/simulations";
import { today } from "@/server/services/settings";
import type { ImportRow } from "@/lib/csv-import";

const force = process.argv.includes("--force");
const existing = db().$client.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
if (existing.n > 0 && !force) {
  console.error(`Database ${dbPath()} already has accounts. Re-run with --force to add demo data anyway.`);
  process.exit(1);
}

let seed = 1234;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const jitter = (base: number, pct: number) => base * (1 + (rand() * 2 - 1) * pct);
const round2 = (n: number) => Math.round(n * 100) / 100;

const end = DateTime.fromISO(today());
const months = 24;
const start = end.minus({ months }).startOf("month");

// ── Accounts & balance history ──────────────────────────────────────────
const checking = createAccount({ name: "Compte courant", institution: "BoursoBank", type: "checking" });
const livretA = createAccount({ name: "Livret A", institution: "BoursoBank", type: "savings" });
const ldds = createAccount({ name: "LDDS", institution: "Crédit Agricole", type: "savings" });
const pea = createAccount({ name: "PEA", institution: "Boursorama", type: "pea" });
const av = createAccount({ name: "Assurance-vie", institution: "Linxea", type: "life_insurance" });
const per = createAccount({ name: "PER", institution: "Linxea", type: "retirement" });
const crypto = createAccount({ name: "Crypto wallet", institution: "Ledger", type: "crypto" });
const flat = createAccount({
  name: "Apartment Lyon 7e",
  type: "real_estate",
  ownershipPct: 50,
  notes: "T3, 62 m², bought with partner",
});
// Bought ~18 months before tracking started, so history has no purchase jump.
const loanStart = start.minus({ months: 18 }).set({ day: 5 }).toISODate()!;
createAccount({
  name: "Mortgage Lyon 7e",
  institution: "Crédit Mutuel",
  type: "mortgage",
  ownershipPct: 50,
  linkedAccountId: flat.id,
  loanParams: { principal: 268_000, annualRatePct: 3.45, durationMonths: 300, startDate: loanStart, insuranceRatePct: 0.3 },
});
const car = createAccount({ name: "Car (Zoe)", type: "vehicle" });

let v = { checking: 2800, livretA: 16000, ldds: 9000, pea: 26000, av: 21000, per: 5000, crypto: 3000, car: 12500 };
for (let m = 0; m <= months; m++) {
  const date = m === months ? end.toISODate()! : start.plus({ months: m }).endOf("month").toISODate()!;
  v = {
    checking: jitter(2900, 0.25),
    livretA: Math.min(22950, v.livretA * 1.0025 + 300),
    ldds: Math.min(12000, v.ldds * 1.0025 + 120),
    pea: v.pea * (1 + (rand() - 0.42) * 0.06) + 500,
    av: v.av * (1 + (rand() - 0.4) * 0.025) + 150,
    per: v.per * (1 + (rand() - 0.42) * 0.04) + 100,
    crypto: Math.max(500, v.crypto * (1 + (rand() - 0.45) * 0.25)),
    car: v.car * 0.99,
  };
  recordBalance({ accountId: checking.id, balance: round2(v.checking), date, source: "demo" });
  recordBalance({ accountId: livretA.id, balance: round2(v.livretA), date, source: "demo" });
  recordBalance({ accountId: ldds.id, balance: round2(v.ldds), date, source: "demo" });
  recordBalance({ accountId: pea.id, balance: round2(v.pea), date, source: "demo" });
  recordBalance({ accountId: av.id, balance: round2(v.av), date, source: "demo" });
  recordBalance({ accountId: per.id, balance: round2(v.per), date, source: "demo" });
  recordBalance({ accountId: crypto.id, balance: round2(v.crypto), date, source: "demo" });
  if (m % 3 === 0) recordBalance({ accountId: car.id, balance: Math.round(v.car), date, source: "demo" });
  if (m % 6 === 0 || m === months) {
    recordBalance({ accountId: flat.id, balance: Math.round(340_000 * Math.pow(1.0015, m)), date, source: "demo" });
  }
}

// ── Rules, budgets ──────────────────────────────────────────────────────
const cat = (name: string) => {
  const c = findCategory(name);
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
  ["tcl", "Transport"],
  ["sncf", "Travel"],
  ["air france", "Travel"],
  ["airbnb", "Travel"],
  ["edf", "Utilities & internet"],
  ["free mobile", "Utilities & internet"],
  ["freebox", "Utilities & internet"],
  ["netflix", "Subscriptions"],
  ["spotify", "Subscriptions"],
  ["amazon", "Shopping"],
  ["fnac", "Shopping"],
  ["pharmacie", "Health"],
  ["doctolib", "Health"],
  ["credit immo", "Loan repayments"],
  ["vir pea", "Savings & investing"],
  ["vir livret", "Savings & investing"],
  ["maif", "Insurance"],
  ["ugc", "Leisure"],
  ["deliveroo", "Restaurants & bars"],
  ["uber eats", "Restaurants & bars"],
  ["copropriete", "Housing"],
];
for (const [p, c] of rules) upsertRule(p, cat(c));

const budgets: [string, number][] = [
  ["Groceries", 450],
  ["Restaurants & bars", 250],
  ["Transport", 90],
  ["Shopping", 200],
  ["Leisure", 120],
  ["Subscriptions", 40],
  ["Travel", 250],
  ["Utilities & internet", 110],
  ["Health", 60],
];
for (const [c, amount] of budgets) setBudget(cat(c), amount);

// ── Transactions ────────────────────────────────────────────────────────
const rows: ImportRow[] = [];
const push = (d: DateTime, amount: number, description: string) => {
  if (d > end) return;
  rows.push({ date: d.toISODate()!, amount: round2(amount), description });
};
for (let m = 6; m <= months; m++) {
  const month = start.plus({ months: m });
  const day = (n: number) => month.set({ day: Math.min(n, month.daysInMonth ?? 28) });
  push(day(27), jitter(3950, 0.02), "VIR SALAIRE ACME SAS");
  if (rand() < 0.3) push(day(15), jitter(600, 0.4), "VIR CLIENT FREELANCE");
  push(day(5), -704.5, "PRLV CREDIT IMMO CM 0012345");
  push(day(3), -86.4, "PRLV NAVIGO ANNUEL");
  push(day(8), -jitter(62, 0.2), "PRLV EDF CLIENTS PARTICULIERS");
  push(day(10), -29.99, "PRLV FREEBOX");
  push(day(12), -15.99, "PRLV FREE MOBILE");
  push(day(14), -13.49, "NETFLIX.COM");
  push(day(14), -11.12, "SPOTIFY P1A2B3");
  push(day(20), -jitter(135, 0.05), "PRLV SYNDIC COPROPRIETE");
  push(day(2), -jitter(28, 0.1), "PRLV MAIF ASSURANCE");
  push(day(28), -500, "VIR PEA BOURSORAMA");
  push(day(28), -300, "VIR LIVRET A");
  const groceries = 6 + Math.floor(rand() * 4);
  for (let g = 0; g < groceries; g++) {
    const shop = ["CB CARREFOUR CITY LYON", "CB MONOPRIX LYON 7", "CB PICARD SURGELES", "CB BIOCOOP GERLAND"][Math.floor(rand() * 4)];
    push(day(1 + Math.floor(rand() * 27)), -jitter(55, 0.5), shop);
  }
  const restaurants = 3 + Math.floor(rand() * 5);
  for (let r = 0; r < restaurants; r++) {
    const place = ["CB LE BOUCHON DES FILLES", "CB DELIVEROO", "CB BAR LA MAISON", "CB PRAIRIAL", "CB UBER EATS"][Math.floor(rand() * 5)];
    push(day(1 + Math.floor(rand() * 27)), -jitter(38, 0.5), place);
  }
  if (rand() < 0.7) push(day(1 + Math.floor(rand() * 27)), -jitter(70, 0.8), "CB AMAZON EU SARL");
  if (rand() < 0.3) push(day(1 + Math.floor(rand() * 27)), -jitter(90, 0.6), "CB FNAC BELLECOUR");
  if (rand() < 0.5) push(day(1 + Math.floor(rand() * 27)), -jitter(22, 0.4), "CB PHARMACIE DU RHONE");
  if (rand() < 0.4) push(day(1 + Math.floor(rand() * 27)), -jitter(25, 0.3), "CB UGC CINE CITE");
  if (rand() < 0.25) push(day(1 + Math.floor(rand() * 27)), -jitter(180, 0.5), "CB SNCF CONNECT");
  if (m % 6 === 2) push(day(18), -jitter(420, 0.3), "CB AIRBNB * HM4K2");
  if (rand() < 0.35) push(day(1 + Math.floor(rand() * 27)), -jitter(45, 0.6), "CB LECLERC DRIVE");
  if (rand() < 0.3) push(day(1 + Math.floor(rand() * 27)), -jitter(30, 0.5), "PAYPAL *VINTED");
}
const res = importTransactions(rows, checking.id);

// ── Reminders & a saved scenario ────────────────────────────────────────
createReminder({
  title: "Update your balances",
  message: "Grab the numbers from your banking apps — one reply per account.",
  kind: "balance_update",
  frequency: "monthly",
  dayOfMonth: 1,
  timeOfDay: "09:00",
  nagEveryHours: 24,
});
createReminder({
  title: "Import last month's bank statement",
  message: "Export the CSV from BoursoBank and drop it in Transactions → Import.",
  kind: "statement",
  frequency: "monthly",
  dayOfMonth: 3,
  timeOfDay: "19:00",
  nagEveryHours: 24,
});
createReminder({ title: "Monthly money report", kind: "monthly_report", frequency: "monthly", dayOfMonth: 1, timeOfDay: "08:30" });
createReminder({
  title: "Check the mortgage statement",
  message: "Compare the bank's remaining principal with Wallet's amortization estimate.",
  kind: "custom",
  frequency: "yearly",
  dayOfMonth: 15,
  monthOfYear: 1,
  timeOfDay: "10:00",
});
saveSimulation({
  name: "Bigger flat in Lyon 6e",
  type: "mortgage",
  params: { price: 520_000, downPayment: 90_000, annualRatePct: 3.2, durationYears: 25, monthlyNetIncome: 7200 },
});

console.log(`Seeded demo data into ${dbPath()}: ${res.inserted} transactions, 10 accounts, ${budgets.length} budgets.`);
