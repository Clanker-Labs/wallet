import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, balanceSnapshots, type Account } from "@/server/db/schema";
import {
  ACCOUNT_TYPE_KEYS,
  ASSET_CLASSES,
  assetClassFor,
  isCurrencyCode,
  isLiability,
  normalizeCurrency,
  type AccountType,
  type AssetClass,
} from "@/lib/domain";
import { toCents } from "@/lib/money";
import { addDays, isISODate } from "@/lib/dates";
import { scheduleBalanceOn } from "@/lib/finance/loan";
import { gratuityOn, gratuityParamsSchema } from "@/lib/finance/gratuity";
import { getSettings, today } from "./settings";
import { holdingsValueCents, valuationContext, type ValuationContext } from "./valuation";
import { companyMonths, trailingTwelve, type CompanyMonth } from "./company-pnl";

export const currencySchema = z
  .string()
  .trim()
  .transform(normalizeCurrency)
  .refine(isCurrencyCode, "Expected a currency code like USD, EUR or BTC");

export const loanParamsSchema = z.object({
  principal: z.number().positive(),
  annualRatePct: z.number().min(0).max(30),
  durationMonths: z.number().int().min(1).max(600),
  startDate: z.string().refine(isISODate, "Expected YYYY-MM-DD"),
  insuranceRatePct: z.number().min(0).max(5).optional(),
  events: z
    .array(
      z.object({
        date: z.string().refine(isISODate, "Expected YYYY-MM-DD"),
        type: z.enum(["prepayment", "rate_change"]),
        amount: z.number().positive().optional(),
        ratePct: z.number().min(0).max(30).optional(),
        keep: z.enum(["duration", "payment"]).optional(),
      }),
    )
    .max(100)
    .optional()
    .describe("Early repayments and rate renegotiations since the start"),
});

export const companyParamsSchema = z.object({
  country: z
    .string()
    .trim()
    .length(2)
    .transform((s) => s.toUpperCase()),
  legalForm: z.string().trim().max(60).nullish(),
  valuation: z.enum(["book", "revenue_multiple", "profit_multiple", "manual"]).default("book"),
  multiple: z.number().min(0).max(100).nullish(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).nullish(),
});

export const accountInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  institution: z.string().trim().max(120).nullish(),
  type: z.enum(ACCOUNT_TYPE_KEYS as [AccountType, ...AccountType[]]),
  assetClass: z.enum(ASSET_CLASSES).optional().describe("Override the class implied by the type"),
  currency: currencySchema.optional().describe("Account currency (default: your base currency)"),
  ownershipPct: z.number().min(0).max(100).default(100),
  includeInNetWorth: z.boolean().default(true),
  linkedAccountId: z.number().int().nullish(),
  loanParams: loanParamsSchema.nullish(),
  gratuityParams: gratuityParamsSchema.nullish().describe("For a job (type end_of_service): country, dates and salary the gratuity is computed from"),
  companyParams: companyParamsSchema.nullish().describe("For a company (type company): its country, legal form and how to value it"),
  companyId: z.number().int().nullish().describe("The company this account belongs to (its bank, brokerage, loan)"),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((s) => s.toUpperCase())
    .nullish()
    .describe("ISO country the account is in (FR for a French flat): decides where its income is taxed"),
  notes: z.string().max(2000).nullish(),
  initialBalance: z.number().optional().describe("Current balance in the account currency, recorded as of today"),
});
export type AccountInput = z.input<typeof accountInputSchema>;

export interface AccountWithBalance extends Account {
  /** Full balance in the account currency (positive = owned / owed for liabilities). */
  balanceCents: number;
  /** Balance × ownership share, account currency. */
  ownedCents: number;
  /** Owned share converted to the base currency. */
  baseOwnedCents: number;
  /** Signed contribution to net worth, base currency. */
  netCents: number;
  lastUpdated: string | null;
  derivedFromLoan: boolean;
  /** A job: the balance is the end-of-service gratuity accrued under its country's law. */
  derivedFromJob: boolean;
  /** A company valued from its accounts or its revenue/profit. */
  derivedFromCompany: boolean;
  /** Value comes from holdings (stocks, ETFs…) × market prices. */
  valuedByHoldings: boolean;
  holdingsCount: number;
}

/** The company an account is attached to must be one of yours, and companies don't nest. */
function requireCompany(uid: string, companyId: number, childIsCompany: boolean) {
  const c = getAccountRow(uid, companyId);
  if (!c.companyParams) throw new Error(`${c.name} is not a company.`);
  if (childIsCompany) throw new Error("A company can't belong to another company here — add it as a separate company.");
}

export function createAccount(uid: string, raw: AccountInput): Account {
  const input = accountInputSchema.parse(raw);
  if (input.type === "end_of_service" && !input.gratuityParams) throw new Error("A job needs its country, start date and salary (gratuityParams).");
  if (input.type === "company" && !input.companyParams) throw new Error("A company needs its country and how to value it (companyParams).");
  if (input.companyId) requireCompany(uid, input.companyId, input.type === "company");
  const assetClass: AssetClass = input.assetClass ?? assetClassFor(input.type);
  if (input.linkedAccountId) getAccountRow(uid, input.linkedAccountId);
  const account = db()
    .insert(accounts)
    .values({
      userId: uid,
      name: input.name,
      institution: input.institution ?? null,
      type: input.type,
      assetClass,
      currency: input.currency ?? getSettings(uid).currency,
      ownershipPct: input.ownershipPct,
      includeInNetWorth: input.includeInNetWorth,
      linkedAccountId: input.linkedAccountId ?? null,
      loanParams: input.loanParams ?? null,
      gratuityParams: input.gratuityParams ?? null,
      companyParams: input.companyParams ?? null,
      companyId: input.companyId ?? null,
      country: input.country ?? input.companyParams?.country ?? null,
      notes: input.notes ?? null,
    })
    .returning()
    .get();
  if (input.initialBalance !== undefined && !input.loanParams && !input.gratuityParams && (!input.companyParams || input.companyParams.valuation === "manual")) {
    recordBalance(uid, { accountId: account.id, balance: input.initialBalance, source: "manual" });
  }
  return account;
}

export function updateAccount(uid: string, id: number, raw: Partial<AccountInput>): Account {
  getAccountRow(uid, id);
  const input = accountInputSchema.partial().parse(raw);
  const patch: Partial<typeof accounts.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.institution !== undefined) patch.institution = input.institution ?? null;
  if (input.type !== undefined) {
    patch.type = input.type;
    patch.assetClass = input.assetClass ?? assetClassFor(input.type);
  } else if (input.assetClass !== undefined) patch.assetClass = input.assetClass;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.ownershipPct !== undefined) patch.ownershipPct = input.ownershipPct;
  if (input.includeInNetWorth !== undefined) patch.includeInNetWorth = input.includeInNetWorth;
  if (input.linkedAccountId !== undefined) {
    if (input.linkedAccountId) getAccountRow(uid, input.linkedAccountId);
    patch.linkedAccountId = input.linkedAccountId ?? null;
  }
  if (input.loanParams !== undefined) patch.loanParams = input.loanParams ?? null;
  if (input.gratuityParams !== undefined) patch.gratuityParams = input.gratuityParams ?? null;
  if (input.companyParams !== undefined) patch.companyParams = input.companyParams ?? null;
  if (input.country !== undefined) patch.country = input.country ?? null;
  if (input.companyId !== undefined) {
    if (input.companyId) {
      if (input.companyId === id) throw new Error("An account can't belong to itself.");
      requireCompany(uid, input.companyId, !!getAccountRow(uid, id).companyParams);
    }
    patch.companyId = input.companyId ?? null;
  }
  if (input.notes !== undefined) patch.notes = input.notes ?? null;
  return db()
    .update(accounts)
    .set(patch)
    .where(and(eq(accounts.id, id), eq(accounts.userId, uid)))
    .returning()
    .get()!;
}

/** Close an account: it keeps its history and drops to zero from today. */
export function archiveAccount(uid: string, id: number) {
  getAccountRow(uid, id);
  const date = today(uid);
  db().update(accounts).set({ archivedAt: date }).where(eq(accounts.id, id)).run();
  writeSnapshot(id, date, 0, "Account closed", "archive");
}

/** Reopen an account. Drops the 0 "closed" snapshot so its last real balance (or loan schedule) applies again. */
export function unarchiveAccount(uid: string, id: number) {
  const account = getAccountRow(uid, id);
  if (account.archivedAt) {
    db()
      .delete(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.accountId, id),
          eq(balanceSnapshots.date, account.archivedAt),
          eq(balanceSnapshots.source, "archive"),
          eq(balanceSnapshots.balanceCents, 0),
        ),
      )
      .run();
  }
  db().update(accounts).set({ archivedAt: null }).where(eq(accounts.id, id)).run();
}

export function deleteAccount(uid: string, id: number) {
  getAccountRow(uid, id);
  // Loans pointing at this account would keep a dangling link.
  db()
    .update(accounts)
    .set({ linkedAccountId: null })
    .where(and(eq(accounts.userId, uid), eq(accounts.linkedAccountId, id)))
    .run();
  db().delete(accounts).where(eq(accounts.id, id)).run();
}

export const recordBalanceSchema = z.object({
  accountId: z.number().int(),
  balance: z.number().describe("Balance in the account's currency; for loans, the amount still owed"),
  date: z.string().refine(isISODate, "Expected YYYY-MM-DD").optional(),
  note: z.string().max(500).nullish(),
  source: z.string().default("manual"),
});

function writeSnapshot(accountId: number, date: string, cents: number, note: string | null, source: string) {
  db()
    .insert(balanceSnapshots)
    .values({ accountId, date, balanceCents: cents, note, source })
    .onConflictDoUpdate({
      target: [balanceSnapshots.accountId, balanceSnapshots.date],
      set: { balanceCents: cents, note, source },
    })
    .run();
}

/** Upsert the balance of an account for a day. */
export function recordBalance(uid: string, raw: z.input<typeof recordBalanceSchema>) {
  const input = recordBalanceSchema.parse(raw);
  const account = getAccountRow(uid, input.accountId);
  if (account.companyParams && account.companyParams.valuation !== "manual" && input.balance !== 0)
    throw new Error(`${account.name} is valued from ${account.companyParams.valuation === "book" ? "its accounts" : "its revenue or profit"}. Switch its valuation to manual to record a value.`);
  if (account.loanParams && input.balance !== 0)
    throw new Error(`${account.name} follows its amortization schedule, so a recorded balance would be ignored. Change its loan terms instead (edit the account), or archive it once repaid.`);
  if (account.gratuityParams && input.balance !== 0)
    throw new Error(`${account.name} is a job: its balance is the gratuity computed from its salary and dates. Edit the job instead, or archive it once the gratuity is paid out.`);
  const date = input.date ?? today(uid);
  const balance = isLiability(account.assetClass) ? Math.abs(input.balance) : input.balance;
  const balanceCents = toCents(balance);
  writeSnapshot(account.id, date, balanceCents, input.note ?? null, input.source);
  return { account, date, balanceCents };
}

/** Record today's value of every account valued from holdings (keeps history charts accurate). */
export function snapshotHoldingAccounts(uid: string) {
  const ctx = valuationContext(uid);
  let n = 0;
  for (const accountId of ctx.holdingsByAccount.keys()) {
    const account = db().select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account || account.archivedAt) continue;
    writeSnapshot(account.id, ctx.today, holdingsValueCents(account, ctx.today, ctx).cents, null, "holdings");
    n++;
  }
  return n;
}

export function deleteSnapshot(uid: string, id: number) {
  const row = db()
    .select({ id: balanceSnapshots.id })
    .from(balanceSnapshots)
    .innerJoin(accounts, eq(accounts.id, balanceSnapshots.accountId))
    .where(and(eq(balanceSnapshots.id, id), eq(accounts.userId, uid)))
    .get();
  if (row) db().delete(balanceSnapshots).where(eq(balanceSnapshots.id, id)).run();
}

/** An account of this user, or an error (never another user's account). */
export function getAccountRow(uid: string, id: number): Account {
  const row = db()
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, uid)))
    .get();
  if (!row) throw new Error(`Account ${id} not found`);
  return row;
}

export function listSnapshots(uid: string, accountId: number) {
  getAccountRow(uid, accountId);
  return db()
    .select()
    .from(balanceSnapshots)
    .where(eq(balanceSnapshots.accountId, accountId))
    .orderBy(asc(balanceSnapshots.date))
    .all();
}

type Snap = { date: string; balanceCents: number };

/** Balance of one account on a date, in its own currency. */
export function balanceOnDate(
  account: Pick<Account, "id" | "currency" | "loanParams"> & Partial<Pick<Account, "gratuityParams" | "archivedAt" | "createdAt" | "companyParams">>,
  snapshots: Snap[],
  date: string,
  ctx: ValuationContext,
): { cents: number; lastUpdated: string | null; derived: "loan" | "job" | "holdings" | "company" | null } {
  if (account.companyParams && account.companyParams.valuation !== "manual") {
    if (account.archivedAt && date >= account.archivedAt) return { cents: 0, lastUpdated: account.archivedAt, derived: null };
    return { cents: companyValueCents(account as Account, date, ctx), lastUpdated: date, derived: "company" };
  }
  if (account.gratuityParams) {
    // Paid out: a zero snapshot (archiving records one) ends the accrual.
    const paid = snapshots.findLast((s) => s.date <= date && s.balanceCents === 0);
    if (paid) return { cents: 0, lastUpdated: paid.date, derived: null };
    if (date < account.gratuityParams.startDate) return { cents: 0, lastUpdated: null, derived: "job" };
    return { cents: toCents(gratuityOn(account.gratuityParams, date).amount), lastUpdated: date, derived: "job" };
  }
  if (account.loanParams) {
    // A closed loan's archive snapshot (0) wins over the schedule.
    const closing = snapshots.findLast((s) => s.date <= date && s.balanceCents === 0);
    if (closing) return { cents: 0, lastUpdated: closing.date, derived: null };
    // Funds are released about a month before the first payment.
    if (date < addDays(account.loanParams.startDate, -31)) return { cents: 0, lastUpdated: null, derived: "loan" };
    return { cents: toCents(scheduleBalanceOn(account.loanParams, date)), lastUpdated: date, derived: "loan" };
  }
  let found: Snap | undefined;
  for (const s of snapshots) {
    if (s.date > date) break;
    found = s;
  }
  if (ctx.holdingsByAccount.has(account.id)) {
    // Closed: its archive zero wins, even over today's live value of positions left in it.
    if (account.archivedAt && date >= account.archivedAt) return { cents: 0, lastUpdated: account.archivedAt, derived: null };
    // Before the account existed in wallet and before any snapshot, there is no history to show:
    // valuing today's positions at last year's prices would invent a year of gains.
    const created = account.createdAt ? new Date(account.createdAt).toISOString().slice(0, 10) : null;
    if (!found && date < ctx.today && created && date < created) return { cents: 0, lastUpdated: null, derived: "holdings" };
    // Live value today; past days use the daily snapshots (or historical prices since the account was added).
    if (date >= ctx.today || !found) {
      const v = holdingsValueCents(account, date, ctx);
      return { cents: v.cents, lastUpdated: v.asOf ?? ctx.today, derived: "holdings" };
    }
    return { cents: found.balanceCents, lastUpdated: found.date, derived: "holdings" };
  }
  return { cents: found?.balanceCents ?? 0, lastUpdated: found?.date ?? null, derived: null };
}

/**
 * What a company is worth on a date, in its currency, before your ownership
 * share: its accounts' net value (book), or trailing-12-month revenue or
 * profit times a multiple.
 */
export function companyValueCents(company: Account, date: string, ctx: ValuationContext): number {
  const p = company.companyParams!;
  if (p.valuation === "book") {
    const key = `company-children:${company.id}`;
    let kids = ctx.cache.get(key) as { accounts: Account[]; snaps: Map<number, Snap[]> } | undefined;
    if (!kids) {
      const accounts_ = db()
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, ctx.uid), eq(accounts.companyId, company.id)))
        .all()
        .filter((a) => !a.companyParams); // no companies inside companies
      kids = { accounts: accounts_, snaps: snapshotsByAccount(ctx.uid, accounts_.map((a) => a.id)) };
      ctx.cache.set(key, kids);
    }
    let total = 0;
    for (const k of kids.accounts) {
      if (k.archivedAt && k.archivedAt <= date) continue;
      const b = balanceOnDate(k, kids.snaps.get(k.id) ?? [], date, ctx);
      const owned = Math.round((b.cents * k.ownershipPct) / 100);
      total += (isLiability(k.assetClass) ? -1 : 1) * ctx.fx.convertCents(owned, k.currency, company.currency, date);
    }
    return total;
  }
  const key = `company-pnl:${company.id}`;
  let months = ctx.cache.get(key) as CompanyMonth[] | undefined;
  if (!months) {
    months = companyMonths(ctx.uid, company, ctx.fx);
    ctx.cache.set(key, months);
  }
  const ttm = trailingTwelve(months, date);
  const multiple = p.multiple ?? (p.valuation === "revenue_multiple" ? 1 : 5);
  return Math.round((p.valuation === "revenue_multiple" ? ttm.revenueCents : Math.max(0, ttm.profitCents)) * multiple);
}

export function withBalance(account: Account, snapshots: Snap[], date: string, ctx: ValuationContext): AccountWithBalance {
  const b = balanceOnDate(account, snapshots, date, ctx);
  const ownedCents = Math.round((b.cents * account.ownershipPct) / 100);
  const baseOwnedCents = ctx.fx.convertCents(ownedCents, account.currency, ctx.base, date);
  const sign = isLiability(account.assetClass) ? -1 : 1;
  return {
    ...account,
    balanceCents: b.cents,
    ownedCents,
    baseOwnedCents,
    // A company's own accounts are counted through the company, not again on their own.
    netCents: account.includeInNetWorth && !account.companyId ? sign * baseOwnedCents : 0,
    lastUpdated: b.lastUpdated,
    derivedFromLoan: b.derived === "loan",
    derivedFromJob: b.derived === "job",
    derivedFromCompany: b.derived === "company",
    valuedByHoldings: b.derived === "holdings",
    holdingsCount: ctx.holdingsByAccount.get(account.id)?.length ?? 0,
  };
}

/** All snapshots of a user's accounts, grouped by account and sorted by date. */
export function snapshotsByAccount(uid: string, accountIds?: number[]): Map<number, Snap[]> {
  const ids =
    accountIds ??
    db()
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, uid))
      .all()
      .map((a) => a.id);
  const byAccount = new Map<number, Snap[]>();
  if (!ids.length) return byAccount;
  const snaps = db()
    .select({ accountId: balanceSnapshots.accountId, date: balanceSnapshots.date, balanceCents: balanceSnapshots.balanceCents })
    .from(balanceSnapshots)
    .where(inArray(balanceSnapshots.accountId, ids))
    .orderBy(asc(balanceSnapshots.date))
    .all();
  for (const s of snaps) {
    const list = byAccount.get(s.accountId) ?? [];
    list.push(s);
    byAccount.set(s.accountId, list);
  }
  return byAccount;
}

export function listAccounts(
  uid: string,
  opts: { includeArchived?: boolean; date?: string; ctx?: ValuationContext } = {},
): AccountWithBalance[] {
  const ctx = opts.ctx ?? valuationContext(uid);
  const date = opts.date ?? ctx.today;
  const rows = db()
    .select()
    .from(accounts)
    .where(opts.includeArchived ? eq(accounts.userId, uid) : and(eq(accounts.userId, uid), isNull(accounts.archivedAt)))
    .orderBy(asc(accounts.assetClass), asc(accounts.name))
    .all();
  const byAccount = snapshotsByAccount(
    uid,
    rows.map((r) => r.id),
  );
  return rows.map((a) => withBalance(a, byAccount.get(a.id) ?? [], date, ctx));
}

export function getAccount(uid: string, id: number) {
  const account = getAccountRow(uid, id);
  const snapshots = listSnapshots(uid, id);
  const ctx = valuationContext(uid);
  return { account: withBalance(account, snapshots, ctx.today, ctx), snapshots, missingFx: [...ctx.fx.missing] };
}

/**
 * Resolve an account from free text ("boursorama", "livret a").
 * Returns all candidates so callers can ask to disambiguate.
 */
export function findAccounts(uid: string, query: string): Account[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = db()
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, uid), isNull(accounts.archivedAt)))
    .all();
  const label = (a: Account) => `${a.name} ${a.institution ?? ""}`.toLowerCase();
  const exact = all.filter((a) => a.name.toLowerCase() === q);
  if (exact.length) return exact;
  const starts = all.filter((a) => a.name.toLowerCase().startsWith(q));
  if (starts.length) return starts;
  const words = q.split(/\s+/);
  return all.filter((a) => words.every((w) => label(a).includes(w)));
}

/** Accounts whose balance hasn't been updated for a while (loans and holdings excluded). */
export function staleAccounts(uid: string, days = 35): AccountWithBalance[] {
  const t = today(uid);
  const cutoff = new Date(Date.parse(t) - days * 86_400_000).toISOString().slice(0, 10);
  return listAccounts(uid).filter(
    (a) =>
      !a.derivedFromLoan &&
      !a.derivedFromJob &&
      !a.derivedFromCompany &&
      !a.valuedByHoldings &&
      a.includeInNetWorth &&
      (a.lastUpdated === null || a.lastUpdated < cutoff),
  );
}

export function recentSnapshots(uid: string, limit = 10) {
  return db()
    .select({
      id: balanceSnapshots.id,
      accountId: balanceSnapshots.accountId,
      accountName: accounts.name,
      currency: accounts.currency,
      date: balanceSnapshots.date,
      balanceCents: balanceSnapshots.balanceCents,
      source: balanceSnapshots.source,
    })
    .from(balanceSnapshots)
    .innerJoin(accounts, eq(accounts.id, balanceSnapshots.accountId))
    .where(and(eq(accounts.userId, uid), isNull(accounts.archivedAt)))
    .orderBy(desc(balanceSnapshots.date), desc(balanceSnapshots.id))
    .limit(limit)
    .all();
}
