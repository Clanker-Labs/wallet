import { and, asc, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db } from "@/server/db/client";
import { goals } from "@/server/db/schema";
import { isCurrencyCode, isLiability, normalizeCurrency } from "@/lib/domain";
import { addMonths, endOfMonth, isISODate, monthRange } from "@/lib/dates";
import { toCents } from "@/lib/money";
import { getAccountRow } from "./accounts";
import { averageMonthlySavings } from "./budgets";
import { netWorthOn } from "./networth";
import { getSettings, today } from "./settings";
import { valuationContext } from "./valuation";
import { audit } from "./audit";

/**
 * Goals: an amount to reach, by a date or not, measured on some accounts (a
 * deposit fund on a savings account) or on the whole net worth. wallet says
 * where you are, what each month needs, and when you'll get there at the pace
 * you plan — or the pace you actually save at.
 */

export type Goal = typeof goals.$inferSelect;

export const goalInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  icon: z.string().max(8).nullish(),
  target: z.number().positive(),
  currency: z.string().optional(),
  targetDate: z.string().refine(isISODate, "Expected YYYY-MM-DD").nullish(),
  accountIds: z.array(z.number().int()).max(50).default([]).describe("Accounts that count towards it; empty = the whole net worth"),
  monthly: z.number().min(0).nullish().describe("Planned monthly contribution; empty = your average savings"),
});
export type GoalInput = z.input<typeof goalInputSchema>;

export interface GoalView extends Goal {
  currentCents: number;
  pct: number;
  remainingCents: number;
  monthsLeft: number | null;
  /** Needed per month to arrive on the target date. */
  neededMonthlyCents: number | null;
  /** The pace used for the projection, and where it comes from. */
  paceCents: number;
  paceSource: "plan" | "savings" | "none";
  projectedDate: string | null;
  onTrack: boolean | null;
  history: { date: string; netCents: number }[];
}

function requireGoal(uid: string, id: number): Goal {
  const g = db().select().from(goals).where(and(eq(goals.id, id), eq(goals.userId, uid))).get();
  if (!g) throw new Error(`No goal with id ${id}`);
  return g;
}

export function saveGoal(uid: string, raw: GoalInput & { id?: number }): Goal {
  const i = goalInputSchema.parse(raw);
  for (const a of i.accountIds) getAccountRow(uid, a);
  const currency = i.currency ? normalizeCurrency(i.currency) : getSettings(uid).currency;
  if (!isCurrencyCode(currency)) throw new Error(`Unknown currency "${i.currency}"`);
  const values = {
    userId: uid,
    name: i.name,
    icon: i.icon ?? null,
    targetCents: toCents(i.target),
    currency,
    targetDate: i.targetDate ?? null,
    accountIds: i.accountIds,
    monthlyCents: i.monthly != null ? toCents(i.monthly) : null,
  };
  audit(uid, "goal", raw.id ?? null, raw.id ? "update" : "create", `Goal “${values.name}”: ${i.target} ${currency}${values.targetDate ? ` by ${values.targetDate}` : ""}`);
  if (raw.id) {
    requireGoal(uid, raw.id);
    return db().update(goals).set(values).where(eq(goals.id, raw.id)).returning().get()!;
  }
  return db().insert(goals).values(values).returning().get();
}

export function deleteGoal(uid: string, id: number) {
  requireGoal(uid, id);
  db().delete(goals).where(eq(goals.id, id)).run();
}

export function archiveGoal(uid: string, id: number, archived = true) {
  requireGoal(uid, id);
  db().update(goals).set({ archivedAt: archived ? today(uid) : null }).where(eq(goals.id, id)).run();
}

/** What the goal's accounts (or the net worth) amount to on a date, in its currency. */
function progressOn(uid: string, g: Goal, date: string, ctx: ReturnType<typeof valuationContext>): number {
  const nw = netWorthOn(uid, date, ctx);
  const cents = g.accountIds.length
    ? // A linked account counts its own balance (a debt negatively), even one that belongs to a company.
      nw.accounts.filter((a) => g.accountIds.includes(a.id)).reduce((s, a) => s + (isLiability(a.assetClass) ? -1 : 1) * a.baseOwnedCents, 0)
    : nw.netCents;
  return ctx.fx.convertCents(cents, nw.currency, g.currency, date);
}

export function listGoals(uid: string, opts: { includeArchived?: boolean } = {}): GoalView[] {
  const rows = db()
    .select()
    .from(goals)
    .where(opts.includeArchived ? eq(goals.userId, uid) : and(eq(goals.userId, uid), isNull(goals.archivedAt)))
    .orderBy(asc(goals.targetDate), asc(goals.createdAt))
    .all();
  if (!rows.length) return [];
  const ctx = valuationContext(uid);
  const t = today(uid);
  const savings = averageMonthlySavings(uid, 6);
  const base = getSettings(uid).currency;
  return rows.map((g) => {
    const current = progressOn(uid, g, t, ctx);
    const remaining = Math.max(0, g.targetCents - current);
    const monthsLeft = g.targetDate ? Math.max(0, Math.round(DateTime.fromISO(g.targetDate).diff(DateTime.fromISO(t), "months").months * 10) / 10) : null;
    const pace = g.monthlyCents ?? (savings.monthsWithData ? Math.max(0, ctx.fx.convertCents(savings.netCents, base, g.currency, t)) : 0);
    const paceSource: GoalView["paceSource"] = g.monthlyCents != null ? "plan" : savings.monthsWithData ? "savings" : "none";
    const projectedDate = remaining === 0 ? t : pace > 0 ? DateTime.fromISO(t).plus({ months: Math.ceil(remaining / pace) }).toISODate()! : null;
    const startMonth = DateTime.fromMillis(Number(g.createdAt)).minus({ months: 6 }).toISODate()!.slice(0, 7);
    const months = monthRange(startMonth < addMonths(t.slice(0, 7), -24) ? addMonths(t.slice(0, 7), -24) : startMonth, addMonths(t.slice(0, 7), -1));
    const history = [...months.map(endOfMonth), t].map((d) => ({ date: d, netCents: progressOn(uid, g, d, ctx) }));
    return {
      ...g,
      currentCents: current,
      pct: g.targetCents ? Math.min(100, (current / g.targetCents) * 100) : 0,
      remainingCents: remaining,
      monthsLeft,
      neededMonthlyCents: monthsLeft !== null ? (monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining) : null,
      paceCents: pace,
      paceSource,
      projectedDate,
      onTrack: g.targetDate ? (remaining === 0 ? true : projectedDate !== null && projectedDate <= g.targetDate) : null,
      history,
    };
  });
}
