import { and, asc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, presence, taxInputs, type Account } from "@/server/db/schema";
import { COUNTRIES, isLiability } from "@/lib/domain";
import { isISODate } from "@/lib/dates";
import { interestBetween } from "@/lib/finance/loan";
import {
  FR_SOCIAL_RATE,
  aeCorporateTax,
  aeResidency,
  frCorporateTax,
  frIfi,
  frIncomeTax,
  frNonResidentTax,
  frRentalTaxable,
  frResidencyHint,
} from "@/lib/finance/tax";
import { balanceOnDate, snapshotsByAccount } from "./accounts";
import { companyMonths } from "./company-pnl";
import { fxConverter } from "./fx";
import { getSettings, today } from "./settings";
import { valuationContext } from "./valuation";

/**
 * A yearly tax estimate from what wallet knows: where you live, where each
 * account is (accounts.country), what came in and from where, your French
 * property and its loans, your companies' profit. Every input it can't infer,
 * and every figure it computes, can be set by hand (tax_inputs).
 *
 * Input keys: residence (ISO country) · homeOrJobInUae (true/false) ·
 * fr.parts · fr.rental.regime (micro|reel) · fr.rental.gross ·
 * fr.rental.expenses · fr.rental.interest · fr.socialRate (standard|eea) ·
 * fr.otherIncome · ifi.base · company.<id>.sbr · company.<id>.qfzp ·
 * company.<id>.rate (%) · company.<id>.profit · other.<CC>.rate (%).
 */

export type IncomeKind = "salary" | "rental" | "investment" | "freelance" | "other";

export interface TaxLine {
  id: string;
  country: string;
  title: string;
  currency: string;
  /** What the tax is computed on. */
  base: number;
  tax: number;
  detail: string;
  law: string;
}

export interface TaxReport {
  year: number;
  residence: string | null;
  days: { country: string; days: number }[];
  unloggedDays: number;
  residencyNotes: string[];
  income: { country: string | null; kind: IncomeKind; amount: number; currency: string }[];
  lines: TaxLine[];
  totals: { currency: string; tax: number }[];
  totalBaseCents: number;
  baseCurrency: string;
  notes: string[];
  inputs: Record<string, string>;
}

const COUNTRY_NAME = new Map(COUNTRIES.map((c) => [c.code, c.name]));
export const countryName = (cc: string | null) => (cc ? (COUNTRY_NAME.get(cc) ?? cc) : "Unknown country");

// ── Inputs and presence ────────────────────────────────────────────────────

export function getTaxInputs(uid: string, year: number): Record<string, string> {
  const rows = db().select().from(taxInputs).where(eq(taxInputs.userId, uid)).all();
  const out: Record<string, string> = {};
  for (const r of rows.filter((x) => x.year === 0)) out[r.key] = r.value;
  for (const r of rows.filter((x) => x.year === year)) out[r.key] = r.value;
  return out;
}

/** Set (or clear, with an empty value) an input for a year; year 0 applies to every year. */
export function setTaxInput(uid: string, year: number, key: string, value: string | null) {
  if (!/^[a-zA-Z0-9_.]{2,60}$/.test(key)) throw new Error(`Bad input key "${key}"`);
  if (value === null || value === "") {
    db().delete(taxInputs).where(and(eq(taxInputs.userId, uid), eq(taxInputs.year, year), eq(taxInputs.key, key))).run();
    return null;
  }
  return db()
    .insert(taxInputs)
    .values({ userId: uid, year, key, value: String(value).slice(0, 200) })
    .onConflictDoUpdate({ target: [taxInputs.userId, taxInputs.year, taxInputs.key], set: { value: String(value).slice(0, 200) } })
    .returning()
    .get();
}

const isoDate = z.string().refine(isISODate, "Expected YYYY-MM-DD");
export const presenceInputSchema = z.object({
  country: z.string().trim().length(2).transform((s) => s.toUpperCase()),
  fromDate: isoDate,
  toDate: isoDate,
  note: z.string().max(200).nullish(),
});

export function addPresence(uid: string, raw: z.input<typeof presenceInputSchema>) {
  const i = presenceInputSchema.parse(raw);
  if (i.toDate < i.fromDate) throw new Error("The stay ends before it starts.");
  return db().insert(presence).values({ userId: uid, ...i, note: i.note ?? null }).returning().get();
}

export function deletePresence(uid: string, id: number) {
  db().delete(presence).where(and(eq(presence.id, id), eq(presence.userId, uid))).run();
}

export function listPresence(uid: string, year?: number) {
  const rows = db().select().from(presence).where(eq(presence.userId, uid)).orderBy(asc(presence.fromDate)).all();
  return year ? rows.filter((r) => r.toDate >= `${year}-01-01` && r.fromDate <= `${year}-12-31`) : rows;
}

/** Days per country within [from, to], counting each logged day once (overlaps: the later stay wins). */
export function daysByCountry(uid: string, from: string, to: string) {
  const byDay = new Map<string, string>();
  for (const r of listPresence(uid)) {
    let d = DateTime.fromISO(r.fromDate < from ? from : r.fromDate);
    const end = DateTime.fromISO(r.toDate > to ? to : r.toDate);
    for (; d <= end; d = d.plus({ days: 1 })) byDay.set(d.toISODate()!, r.country);
  }
  const counts = new Map<string, number>();
  for (const c of byDay.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
  const total = Math.max(0, Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days) + 1);
  return { days: [...counts].map(([country, days]) => ({ country, days })).sort((a, b) => b.days - a.days), unlogged: total - byDay.size };
}

// ── Income ─────────────────────────────────────────────────────────────────

export function incomeKind(categoryName: string | null): IncomeKind {
  const n = (categoryName ?? "").toLowerCase();
  if (/salar|payroll|wage|paie/.test(n)) return "salary";
  if (/rent|loyer|rental|locat|airbnb/.test(n)) return "rental";
  if (/invest|dividend|interest|intér|coupon/.test(n)) return "investment";
  if (/freelanc|side income|consult|honorair/.test(n)) return "freelance";
  return "other";
}

const currencyOf = (cc: string | null, base: string) => (cc === "FR" ? "EUR" : cc === "AE" ? "AED" : base);

/** Personal income in a year by source country and kind (company accounts excluded: that's the company's). */
function incomeFor(uid: string, year: number, base: string) {
  const fx = fxConverter();
  const rows = db()
    .$client.prepare(
      `SELECT t.date AS date, t.currency AS currency, coalesce(p.amount_cents, t.amount_cents) AS cents, c.name AS category, a.country AS country
       FROM transactions t
       LEFT JOIN transaction_splits p ON p.transaction_id = t.id
       LEFT JOIN categories c ON c.id = coalesce(p.category_id, t.category_id)
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = @uid AND t.date BETWEEN @from AND @to AND c.kind = 'income' AND a.company_id IS NULL`,
    )
    .all({ uid, from: `${year}-01-01`, to: `${year}-12-31` }) as { date: string; currency: string; cents: number; category: string | null; country: string | null }[];
  const sums = new Map<string, { country: string | null; kind: IncomeKind; amount: number; currency: string }>();
  for (const r of rows) {
    const kind = incomeKind(r.category);
    const cur = currencyOf(r.country, base);
    const key = `${r.country ?? "-"}|${kind}`;
    const s = sums.get(key) ?? { country: r.country, kind, amount: 0, currency: cur };
    s.amount += fx.convertCents(r.cents, r.currency, cur, r.date) / 100;
    sums.set(key, s);
  }
  return [...sums.values()].map((s) => ({ ...s, amount: Math.round(s.amount * 100) / 100 }));
}

/** French property: value on 1 January (IFI date), debts on it, and the year's loan interest. EUR. */
function frenchProperty(uid: string, year: number, includeAllCountries: boolean) {
  const ctx = valuationContext(uid);
  const all = db().select().from(accounts).where(eq(accounts.userId, uid)).all();
  const props = all.filter((a) => a.assetClass === "real_estate" && !a.companyId && (includeAllCountries || a.country === "FR"));
  const snaps = snapshotsByAccount(uid, all.map((a) => a.id));
  const jan1 = `${year}-01-01`;
  const eur = (cents: number, cur: string, date: string) => ctx.fx.convertCents(cents, cur, "EUR", date) / 100;
  let value = 0;
  let debts = 0;
  let interest = 0;
  const mortgages = (p: Account) => all.filter((m) => isLiability(m.assetClass) && (m.linkedAccountId === p.id));
  for (const p of props) {
    const b = balanceOnDate(p, snaps.get(p.id) ?? [], jan1, ctx);
    value += eur(Math.round((b.cents * p.ownershipPct) / 100), p.currency, jan1);
    for (const m of mortgages(p)) {
      const mb = balanceOnDate(m, snaps.get(m.id) ?? [], jan1, ctx);
      debts += eur(Math.round((mb.cents * m.ownershipPct) / 100), m.currency, jan1);
      if (m.loanParams) interest += eur(Math.round(interestBetween(m.loanParams, `${year}-01-01`, `${year}-12-31`) * m.ownershipPct), m.currency, `${year}-12-31`);
    }
  }
  return { count: props.length, value: Math.round(value), debts: Math.round(debts), interest: Math.round(interest * 100) / 100 };
}

// ── The report ─────────────────────────────────────────────────────────────

const num = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const yes = (v: string | undefined) => v === "true" || v === "1" || v === "yes";

export function taxReport(uid: string, year: number): TaxReport {
  const input = getTaxInputs(uid, year);
  const base = getSettings(uid).currency;
  const t = today(uid);
  const fx = fxConverter();
  const residence = input.residence ?? null;
  const yearEnd = `${year}-12-31` < t ? `${year}-12-31` : t;
  const { days, unlogged } = daysByCountry(uid, `${year}-01-01`, yearEnd);
  const dayCount = (cc: string) => days.find((d) => d.country === cc)?.days ?? 0;
  const lines: TaxLine[] = [];
  const notes: string[] = [];
  const residencyNotes: string[] = [];

  residencyNotes.push(aeResidency(dayCount("AE"), { homeOrJobInUae: yes(input.homeOrJobInUae) }).note);
  if (dayCount("FR") || residence === "FR") residencyNotes.push(frResidencyHint(dayCount("FR")));
  if (unlogged > 0) residencyNotes.push(`${unlogged} day${unlogged > 1 ? "s" : ""} of ${year} not logged — add your stays to make the count exact.`);
  if (!residence) notes.push("Set your tax residence to get the personal income tax estimate.");

  const income = incomeFor(uid, year, base);
  const sum = (pred: (i: (typeof income)[number]) => boolean) => income.filter(pred).reduce((s, i) => s + i.amount, 0);
  const uncountried = income.filter((i) => !i.country);
  if (uncountried.length) notes.push(`Income on accounts with no country (${uncountried.map((i) => i.kind).join(", ")}): set each account's country so its income is placed.`);

  // France: rental income (property in France), and the rest of French-source income.
  const prop = frenchProperty(uid, year, residence === "FR");
  const frRentalGross = num(input["fr.rental.gross"]) ?? sum((i) => i.country === "FR" && i.kind === "rental");
  const frOther = num(input["fr.otherIncome"]) ?? sum((i) => i.country === "FR" && i.kind !== "rental" && i.kind !== "investment");
  const parts = num(input["fr.parts"]) ?? 1;
  const socialRate = input["fr.socialRate"] === "eea" ? FR_SOCIAL_RATE.eea : FR_SOCIAL_RATE.standard;
  const rental = frRentalTaxable(frRentalGross, {
    regime: input["fr.rental.regime"] === "reel" ? "reel" : "micro",
    expenses: num(input["fr.rental.expenses"]),
    interest: num(input["fr.rental.interest"]) ?? prop.interest,
  });

  if (residence && residence !== "FR" && (frRentalGross > 0 || frOther > 0)) {
    const taxable = rental.taxable + frOther;
    const ir = frNonResidentTax(taxable, parts, year);
    lines.push({
      id: "fr.ir.nonresident",
      country: "FR",
      title: "French income tax (non-resident)",
      currency: "EUR",
      base: taxable,
      tax: ir.tax,
      detail: `${rental.note} ${ir.byMinimumRate ? "The 20% / 30% minimum rate applies" : "The barème applies"} (barème ${ir.baremeYear}${ir.approximated ? ", latest published" : ""}). The average-rate option on worldwide income can be lower — it needs that income declared.`,
      law: "CGI art. 197 A, 32, 31",
    });
    if (rental.taxable > 0)
      lines.push({
        id: "fr.ps",
        country: "FR",
        title: "French social charges on rental income",
        currency: "EUR",
        base: rental.taxable,
        tax: Math.round(rental.taxable * socialRate * 100) / 100,
        detail: socialRate === FR_SOCIAL_RATE.eea ? "7.5% (covered by an EEA/UK/Swiss social security system)." : "17.2% (not covered by an EEA/UK/Swiss social security system — a UAE resident usually isn't).",
        law: "CSS L136-6, CGI 1600-0 S",
      });
  }

  if (residence === "FR") {
    const salary = sum((i) => i.kind === "salary") ;
    const salaryNet = salary - Math.min(Math.max(salary * 0.1, 504), 14_171);
    const freelance = sum((i) => i.kind === "freelance") * 0.66;
    const otherIncome = sum((i) => i.kind === "other");
    const taxable = Math.max(0, salaryNet) + freelance + otherIncome + rental.taxable;
    const ir = frIncomeTax(taxable, parts, year);
    lines.push({
      id: "fr.ir",
      country: "FR",
      title: "French income tax (resident, worldwide income)",
      currency: "EUR",
      base: Math.round(taxable),
      tax: ir.tax,
      detail: `Salary after the 10% allowance, freelance after the 34% micro-BNC allowance, rental (${rental.note.toLowerCase()}), ${parts} part${parts > 1 ? "s" : ""}, barème ${ir.baremeYear}. Foreign income taxed abroad may give a credit under the treaty — not deducted here.`,
      law: "CGI art. 4 B, 83, 102 ter, 197",
    });
    const investment = sum((i) => i.kind === "investment");
    if (investment > 0)
      lines.push({ id: "fr.pfu", country: "FR", title: "Flat tax on investment income", currency: "EUR", base: investment, tax: Math.round(investment * 0.3 * 100) / 100, detail: "12.8% income tax + 17.2% social charges (PFU).", law: "CGI art. 200 A" });
    if (rental.taxable > 0)
      lines.push({ id: "fr.ps", country: "FR", title: "Social charges on rental income", currency: "EUR", base: rental.taxable, tax: Math.round(rental.taxable * 0.172 * 100) / 100, detail: "17.2%.", law: "CSS L136-6" });
  }

  if (residence === "AE") {
    const aeIncome = sum((i) => i.country === "AE");
    lines.push({ id: "ae.pit", country: "AE", title: "UAE personal income tax", currency: "AED", base: Math.round(aeIncome), tax: 0, detail: "The UAE has no personal income tax on salary, rent or investment income.", law: "—" });
  }

  // Income from other countries, at a rate you give.
  for (const cc of [...new Set(income.map((i) => i.country).filter((c): c is string => !!c && c !== "FR" && c !== "AE"))]) {
    const amount = sum((i) => i.country === cc);
    const rate = num(input[`other.${cc}.rate`]);
    lines.push({
      id: `other.${cc}`,
      country: cc,
      title: `${countryName(cc)}: income tax`,
      currency: currencyOf(cc, base),
      base: Math.round(amount),
      tax: rate !== undefined ? Math.round(amount * rate) / 100 : 0,
      detail: rate !== undefined ? `At the ${rate}% rate you set.` : `No rules for ${countryName(cc)} yet: set an effective rate (input other.${cc}.rate) to include it.`,
      law: "—",
    });
  }

  // IFI: French real estate (a resident: all real estate), net of its loans, on 1 January.
  const ifiBase = num(input["ifi.base"]) ?? Math.max(0, prop.value - prop.debts);
  if (prop.count || input["ifi.base"]) {
    const ifi = frIfi(ifiBase);
    lines.push({
      id: "fr.ifi",
      country: "FR",
      title: "Impôt sur la fortune immobilière",
      currency: "EUR",
      base: ifiBase,
      tax: ifi.tax,
      detail: `${residence === "FR" ? "All your real estate" : "Your French real estate"} on 1 January ${year}: ${Math.round(prop.value).toLocaleString("en")} € minus ${Math.round(prop.debts).toLocaleString("en")} € of loans. ${ifi.note}${residence === "FR" ? " The main home gets a 30% allowance (not applied here)." : ""}`,
      law: "CGI art. 964–983",
    });
  }

  // Companies: corporate tax where each one is.
  const ctx = valuationContext(uid);
  for (const c of db().select().from(accounts).where(eq(accounts.userId, uid)).all().filter((a) => a.companyParams && !a.archivedAt)) {
    const p = c.companyParams!;
    const start = p.fiscalYearStartMonth ?? 1;
    const from = `${year}-${String(start).padStart(2, "0")}`;
    const toY = start === 1 ? year : year + 1;
    const to = `${toY}-${String(start === 1 ? 12 : start - 1).padStart(2, "0")}`;
    const months = companyMonths(uid, c, ctx.fx).filter((m) => m.month >= from && m.month <= to);
    const revenue = months.reduce((s, m) => s + m.revenueCents, 0) / 100;
    const profit = num(input[`company.${c.id}.profit`]) ?? months.reduce((s, m) => s + m.profitCents, 0) / 100;
    const share = c.ownershipPct !== 100 ? ` (you own ${+c.ownershipPct.toFixed(2)}%: the company pays it, your share is ${c.ownershipPct}% of the cost)` : "";
    const fy = start === 1 ? `${year}` : `${from} to ${to}`;
    if (p.country === "AE") {
      const toAed = (v: number) => fx.convert(v, c.currency, "AED", `${toY}-12-31`);
      const r = aeCorporateTax(toAed(profit), toAed(revenue), { year: toY, smallBusinessRelief: yes(input[`company.${c.id}.sbr`]), qualifyingFreeZone: yes(input[`company.${c.id}.qfzp`]) });
      lines.push({ id: `company.${c.id}`, country: "AE", title: `${c.name}: UAE corporate tax`, currency: "AED", base: Math.round(toAed(profit)), tax: r.tax, detail: `Financial year ${fy}. ${r.note}${share}`, law: "Federal Decree-Law No. 47 of 2022" });
    } else if (p.country === "FR") {
      const eur = fx.convert(profit, c.currency, "EUR", `${toY}-12-31`);
      const r = frCorporateTax(eur);
      lines.push({ id: `company.${c.id}`, country: "FR", title: `${c.name}: impôt sur les sociétés`, currency: "EUR", base: Math.round(eur), tax: r.tax, detail: `Financial year ${fy}. ${r.note}${share}`, law: "CGI art. 219" });
    } else {
      const rate = num(input[`company.${c.id}.rate`]);
      lines.push({
        id: `company.${c.id}`,
        country: p.country,
        title: `${c.name}: corporate tax`,
        currency: c.currency,
        base: Math.round(profit),
        tax: rate !== undefined && profit > 0 ? Math.round(profit * rate) / 100 : 0,
        detail: rate !== undefined ? `At the ${rate}% rate you set. Financial year ${fy}.` : `No rules for ${countryName(p.country)} yet: set its rate (input company.${c.id}.rate).`,
        law: "—",
      });
    }
  }

  const totals = new Map<string, number>();
  for (const l of lines) totals.set(l.currency, (totals.get(l.currency) ?? 0) + l.tax);
  const totalBaseCents = [...totals].reduce((s, [cur, tax]) => s + fx.convertCents(Math.round(tax * 100), cur, base, yearEnd), 0);
  notes.push("Estimates from the rules cited on each line. Credits, reliefs, treaty details and deadlines beyond them aren't modelled — check with a tax adviser before filing.");
  return {
    year,
    residence,
    days,
    unloggedDays: unlogged,
    residencyNotes,
    income,
    lines,
    totals: [...totals].map(([currency, tax]) => ({ currency, tax: Math.round(tax * 100) / 100 })),
    totalBaseCents,
    baseCurrency: base,
    notes,
    inputs: input,
  };
}
