import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, balanceSnapshots, type Account } from "@/server/db/schema";
import {
  ACCOUNT_TYPE_KEYS,
  ASSET_CLASSES,
  assetClassFor,
  isLiability,
  type AccountType,
  type AssetClass,
} from "@/lib/domain";
import { toCents } from "@/lib/money";
import { addDays, isISODate } from "@/lib/dates";
import { loanBalanceOn } from "@/lib/finance/loan";
import { today } from "./settings";

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
  ownershipPct: z.number().min(0).max(100).default(100),
  includeInNetWorth: z.boolean().default(true),
  linkedAccountId: z.number().int().nullish(),
  loanParams: loanParamsSchema.nullish(),
  notes: z.string().max(2000).nullish(),
  initialBalance: z.number().optional().describe("Current balance, recorded as of today"),
});
export type AccountInput = z.input<typeof accountInputSchema>;

export interface AccountWithBalance extends Account {
  /** Full balance (positive = owned for assets / owed for liabilities). */
  balanceCents: number;
  /** Balance × ownership share. */
  ownedCents: number;
  /** Signed contribution to net worth. */
  netCents: number;
  lastUpdated: string | null;
  derivedFromLoan: boolean;
}

export function createAccount(raw: AccountInput): Account {
  const input = accountInputSchema.parse(raw);
  const assetClass: AssetClass = input.assetClass ?? assetClassFor(input.type);
  const account = db()
    .insert(accounts)
    .values({
      name: input.name,
      institution: input.institution ?? null,
      type: input.type,
      assetClass,
      ownershipPct: input.ownershipPct,
      includeInNetWorth: input.includeInNetWorth,
      linkedAccountId: input.linkedAccountId ?? null,
      loanParams: input.loanParams ?? null,
      notes: input.notes ?? null,
    })
    .returning()
    .get();
  if (input.initialBalance !== undefined && !input.loanParams) {
    recordBalance({ accountId: account.id, balance: input.initialBalance, source: "manual" });
  }
  return account;
}

export function updateAccount(id: number, raw: Partial<AccountInput>): Account {
  const input = accountInputSchema.partial().parse(raw);
  const patch: Partial<typeof accounts.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.institution !== undefined) patch.institution = input.institution ?? null;
  if (input.type !== undefined) {
    patch.type = input.type;
    patch.assetClass = input.assetClass ?? assetClassFor(input.type);
  } else if (input.assetClass !== undefined) patch.assetClass = input.assetClass;
  if (input.ownershipPct !== undefined) patch.ownershipPct = input.ownershipPct;
  if (input.includeInNetWorth !== undefined) patch.includeInNetWorth = input.includeInNetWorth;
  if (input.linkedAccountId !== undefined) patch.linkedAccountId = input.linkedAccountId ?? null;
  if (input.loanParams !== undefined) patch.loanParams = input.loanParams ?? null;
  if (input.notes !== undefined) patch.notes = input.notes ?? null;
  const updated = db().update(accounts).set(patch).where(eq(accounts.id, id)).returning().get();
  if (!updated) throw new Error(`Account ${id} not found`);
  return updated;
}

/** Close an account: it keeps its history and drops to zero from today. */
export function archiveAccount(id: number) {
  const date = today();
  db().update(accounts).set({ archivedAt: date }).where(eq(accounts.id, id)).run();
  recordBalance({ accountId: id, balance: 0, date, note: "Account closed", source: "archive" });
}

export function unarchiveAccount(id: number) {
  db().update(accounts).set({ archivedAt: null }).where(eq(accounts.id, id)).run();
}

export function deleteAccount(id: number) {
  db().delete(accounts).where(eq(accounts.id, id)).run();
}

export const recordBalanceSchema = z.object({
  accountId: z.number().int(),
  balance: z.number().describe("Balance in currency units; for loans, the amount still owed"),
  date: z.string().refine(isISODate, "Expected YYYY-MM-DD").optional(),
  note: z.string().max(500).nullish(),
  source: z.string().default("manual"),
});

/** Upsert the balance of an account for a day. */
export function recordBalance(raw: z.input<typeof recordBalanceSchema>) {
  const input = recordBalanceSchema.parse(raw);
  const account = getAccountRow(input.accountId);
  const date = input.date ?? today();
  const balance = isLiability(account.assetClass) ? Math.abs(input.balance) : input.balance;
  const values = {
    accountId: input.accountId,
    date,
    balanceCents: toCents(balance),
    note: input.note ?? null,
    source: input.source,
  };
  db()
    .insert(balanceSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [balanceSnapshots.accountId, balanceSnapshots.date],
      set: { balanceCents: values.balanceCents, note: values.note, source: values.source },
    })
    .run();
  return { account, date, balanceCents: values.balanceCents };
}

export function deleteSnapshot(id: number) {
  db().delete(balanceSnapshots).where(eq(balanceSnapshots.id, id)).run();
}

export function getAccountRow(id: number): Account {
  const row = db().select().from(accounts).where(eq(accounts.id, id)).get();
  if (!row) throw new Error(`Account ${id} not found`);
  return row;
}

export function listSnapshots(accountId: number) {
  return db()
    .select()
    .from(balanceSnapshots)
    .where(eq(balanceSnapshots.accountId, accountId))
    .orderBy(asc(balanceSnapshots.date))
    .all();
}

/** Balance of one account on a date, given its sorted snapshots. */
export function balanceOnDate(
  account: Pick<Account, "loanParams" | "createdAt">,
  snapshots: { date: string; balanceCents: number }[],
  date: string,
): { cents: number; lastUpdated: string | null; derived: boolean } {
  if (account.loanParams) {
    // A closed loan's archive snapshot (0) wins over the schedule.
    const closing = snapshots.findLast((s) => s.date <= date && s.balanceCents === 0);
    if (closing) return { cents: 0, lastUpdated: closing.date, derived: false };
    // Funds are released about a month before the first payment.
    if (date < addDays(account.loanParams.startDate, -31)) return { cents: 0, lastUpdated: null, derived: true };
    return { cents: toCents(loanBalanceOn(account.loanParams, date)), lastUpdated: date, derived: true };
  }
  let found: { date: string; balanceCents: number } | undefined;
  for (const s of snapshots) {
    if (s.date > date) break;
    found = s;
  }
  return { cents: found?.balanceCents ?? 0, lastUpdated: found?.date ?? null, derived: false };
}

export function withBalance(account: Account, snapshots: { date: string; balanceCents: number }[], date: string): AccountWithBalance {
  const b = balanceOnDate(account, snapshots, date);
  const ownedCents = Math.round((b.cents * account.ownershipPct) / 100);
  const sign = isLiability(account.assetClass) ? -1 : 1;
  return {
    ...account,
    balanceCents: b.cents,
    ownedCents,
    netCents: account.includeInNetWorth ? sign * ownedCents : 0,
    lastUpdated: b.lastUpdated,
    derivedFromLoan: b.derived,
  };
}

export function listAccounts(opts: { includeArchived?: boolean; date?: string } = {}): AccountWithBalance[] {
  const date = opts.date ?? today();
  const rows = db()
    .select()
    .from(accounts)
    .where(opts.includeArchived ? undefined : isNull(accounts.archivedAt))
    .orderBy(asc(accounts.assetClass), asc(accounts.name))
    .all();
  const snaps = db().select().from(balanceSnapshots).orderBy(asc(balanceSnapshots.date)).all();
  const byAccount = new Map<number, typeof snaps>();
  for (const s of snaps) {
    const list = byAccount.get(s.accountId) ?? [];
    list.push(s);
    byAccount.set(s.accountId, list);
  }
  return rows.map((a) => withBalance(a, byAccount.get(a.id) ?? [], date));
}

export function getAccount(id: number) {
  const account = getAccountRow(id);
  const snapshots = listSnapshots(id);
  return { account: withBalance(account, snapshots, today()), snapshots };
}

/**
 * Resolve an account from free text ("boursorama", "livret a").
 * Returns all candidates so callers can ask to disambiguate.
 */
export function findAccounts(query: string): Account[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = db().select().from(accounts).where(isNull(accounts.archivedAt)).all();
  const label = (a: Account) => `${a.name} ${a.institution ?? ""}`.toLowerCase();
  const exact = all.filter((a) => a.name.toLowerCase() === q);
  if (exact.length) return exact;
  const starts = all.filter((a) => a.name.toLowerCase().startsWith(q));
  if (starts.length) return starts;
  const words = q.split(/\s+/);
  return all.filter((a) => words.every((w) => label(a).includes(w)));
}

/** Accounts whose balance hasn't been updated for a while (loans excluded). */
export function staleAccounts(days = 35): AccountWithBalance[] {
  const t = today();
  const cutoff = new Date(Date.parse(t) - days * 86_400_000).toISOString().slice(0, 10);
  return listAccounts().filter(
    (a) => !a.derivedFromLoan && a.includeInNetWorth && (a.lastUpdated === null || a.lastUpdated < cutoff),
  );
}

export function recentSnapshots(limit = 10) {
  return db()
    .select({
      id: balanceSnapshots.id,
      accountId: balanceSnapshots.accountId,
      accountName: accounts.name,
      date: balanceSnapshots.date,
      balanceCents: balanceSnapshots.balanceCents,
      source: balanceSnapshots.source,
    })
    .from(balanceSnapshots)
    .innerJoin(accounts, eq(accounts.id, balanceSnapshots.accountId))
    .where(and(isNull(accounts.archivedAt)))
    .orderBy(desc(balanceSnapshots.date), desc(balanceSnapshots.id))
    .limit(limit)
    .all();
}
