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
import { loanBalanceOn } from "@/lib/finance/loan";
import { getSettings, today } from "./settings";
import { holdingsValueCents, valuationContext, type ValuationContext } from "./valuation";

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
  /** Value comes from holdings (stocks, ETFs…) × market prices. */
  valuedByHoldings: boolean;
  holdingsCount: number;
}

export function createAccount(uid: string, raw: AccountInput): Account {
  const input = accountInputSchema.parse(raw);
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
      notes: input.notes ?? null,
    })
    .returning()
    .get();
  if (input.initialBalance !== undefined && !input.loanParams) {
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
  account: Pick<Account, "id" | "currency" | "loanParams">,
  snapshots: Snap[],
  date: string,
  ctx: ValuationContext,
): { cents: number; lastUpdated: string | null; derived: "loan" | "holdings" | null } {
  if (account.loanParams) {
    // A closed loan's archive snapshot (0) wins over the schedule.
    const closing = snapshots.findLast((s) => s.date <= date && s.balanceCents === 0);
    if (closing) return { cents: 0, lastUpdated: closing.date, derived: null };
    // Funds are released about a month before the first payment.
    if (date < addDays(account.loanParams.startDate, -31)) return { cents: 0, lastUpdated: null, derived: "loan" };
    return { cents: toCents(loanBalanceOn(account.loanParams, date)), lastUpdated: date, derived: "loan" };
  }
  let found: Snap | undefined;
  for (const s of snapshots) {
    if (s.date > date) break;
    found = s;
  }
  if (ctx.holdingsByAccount.has(account.id)) {
    // Live value today; past days use the daily snapshots (or historical prices).
    if (date >= ctx.today || !found) {
      const v = holdingsValueCents(account, date, ctx);
      return { cents: v.cents, lastUpdated: v.asOf ?? ctx.today, derived: "holdings" };
    }
    return { cents: found.balanceCents, lastUpdated: found.date, derived: "holdings" };
  }
  return { cents: found?.balanceCents ?? 0, lastUpdated: found?.date ?? null, derived: null };
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
    netCents: account.includeInNetWorth ? sign * baseOwnedCents : 0,
    lastUpdated: b.lastUpdated,
    derivedFromLoan: b.derived === "loan",
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
