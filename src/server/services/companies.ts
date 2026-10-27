import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, companyFinancials } from "@/server/db/schema";
import { isMonth } from "@/lib/dates";
import { toCents } from "@/lib/money";
import type { CompanyParams } from "@/lib/domain";
import { companyParamsSchema, createAccount, getAccountRow, listAccounts, updateAccount, type AccountWithBalance } from "./accounts";
import { companyMonths, trailingTwelve, type CompanyMonth } from "./company-pnl";
import { today } from "./settings";
import { valuationContext } from "./valuation";
import { audit } from "./audit";

/**
 * Companies you own, as net-worth assets: their value (from their own
 * accounts, or revenue/profit × a multiple, or recorded by hand), your share
 * of it, and their revenue, spending and profit month by month.
 */

export const companyInputSchema = z.object({
  accountId: z.number().int().optional().describe("Existing company to update; omit to add one"),
  name: z.string().trim().min(1).max(120),
  currency: z.string().trim().min(3).max(10).optional().describe("Currency its books are in, e.g. AED"),
  ownershipPct: z.number().min(0).max(100).optional().describe("Your share of the company"),
  params: companyParamsSchema,
  initialValue: z.number().optional().describe("For manual valuation: today's value of 100% of the company"),
  notes: z.string().max(2000).nullish(),
});
export type CompanyInput = z.input<typeof companyInputSchema>;

export interface CompanyView {
  account: AccountWithBalance;
  params: CompanyParams;
  /** Value of 100% of the company, its currency. */
  valueCents: number;
  /** Your share, its currency and the base currency. */
  ownedCents: number;
  baseOwnedCents: number;
  accounts: AccountWithBalance[];
  months: CompanyMonth[];
  ttm: ReturnType<typeof trailingTwelve>;
  marginPct: number | null;
}

export function listCompanies(uid: string): CompanyView[] {
  const all = listAccounts(uid, { includeArchived: false });
  const ctx = valuationContext(uid);
  const t = today(uid);
  return all
    .filter((a) => a.companyParams)
    .map((a) => {
      const months = companyMonths(uid, a, ctx.fx);
      const ttm = trailingTwelve(months, t);
      return {
        account: a,
        params: a.companyParams!,
        valueCents: a.balanceCents,
        ownedCents: a.ownedCents,
        baseOwnedCents: a.baseOwnedCents,
        accounts: all.filter((x) => x.companyId === a.id),
        months,
        ttm,
        marginPct: ttm.revenueCents > 0 ? (ttm.profitCents / ttm.revenueCents) * 100 : null,
      };
    });
}

export function getCompany(uid: string, id: number): CompanyView {
  const c = listCompanies(uid).find((x) => x.account.id === id);
  if (!c) throw new Error(`No company with id ${id}`);
  return c;
}

export function saveCompany(uid: string, raw: CompanyInput): CompanyView {
  const i = companyInputSchema.parse(raw);
  if (i.accountId) {
    const cur = getAccountRow(uid, i.accountId);
    if (!cur.companyParams) throw new Error(`${cur.name} is not a company.`);
    updateAccount(uid, i.accountId, {
      name: i.name,
      ...(i.currency ? { currency: i.currency } : {}),
      ...(i.ownershipPct !== undefined ? { ownershipPct: i.ownershipPct } : {}),
      companyParams: i.params,
      country: i.params.country,
      ...(i.notes !== undefined ? { notes: i.notes } : {}),
    });
    return getCompany(uid, i.accountId);
  }
  const acc = createAccount(uid, {
    name: i.name,
    type: "company",
    currency: i.currency,
    ownershipPct: i.ownershipPct ?? 100,
    companyParams: i.params,
    country: i.params.country,
    notes: i.notes ?? null,
    ...(i.params.valuation === "manual" && i.initialValue !== undefined ? { initialBalance: i.initialValue } : {}),
  });
  return getCompany(uid, acc.id);
}

/** Enter (or clear, with zeros) a month of revenue and expenses for a company. */
export function setCompanyFinancials(uid: string, companyId: number, month: string, revenue: number, expenses: number, note?: string | null) {
  const c = getAccountRow(uid, companyId);
  if (!c.companyParams) throw new Error(`${c.name} is not a company.`);
  if (!isMonth(month)) throw new Error("Expected a month like 2026-10");
  if (!revenue && !expenses) {
    db().delete(companyFinancials).where(and(eq(companyFinancials.companyId, companyId), eq(companyFinancials.month, month))).run();
    return null;
  }
  const values = { userId: uid, companyId, month, revenueCents: toCents(Math.abs(revenue)), expensesCents: toCents(Math.abs(expenses)), note: note ?? null };
  audit(uid, "company", companyId, "financials", `${c.name} ${month}: revenue ${revenue}, expenses ${expenses}`);
  return db()
    .insert(companyFinancials)
    .values(values)
    .onConflictDoUpdate({ target: [companyFinancials.companyId, companyFinancials.month], set: { revenueCents: values.revenueCents, expensesCents: values.expensesCents, note: values.note } })
    .returning()
    .get();
}

/** Attach one of your accounts to a company (or detach it with null). */
export function attachAccount(uid: string, accountId: number, companyId: number | null) {
  updateAccount(uid, accountId, { companyId });
  return db().select().from(accounts).where(eq(accounts.id, accountId)).get();
}
