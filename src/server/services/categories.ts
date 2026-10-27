import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, categories, categoryRules, transactions, type Category } from "@/server/db/schema";
import { toCents } from "@/lib/money";
import { audit } from "./audit";

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["income", "expense", "transfer"]),
  icon: z.string().max(8).nullish(),
});

export function listCategories(uid: string): Category[] {
  return db()
    .select()
    .from(categories)
    .where(eq(categories.userId, uid))
    .orderBy(asc(categories.sortOrder), asc(categories.name))
    .all();
}

export function getCategory(uid: string, id: number): Category | undefined {
  return db()
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.userId, uid)))
    .get();
}

/** A category of this user, or an error. */
export function requireCategory(uid: string, id: number): Category {
  const c = getCategory(uid, id);
  if (!c) throw new Error(`Category ${id} not found`);
  return c;
}

export function createCategory(uid: string, raw: z.input<typeof categoryInputSchema>): Category {
  const input = categoryInputSchema.parse(raw);
  const max = db()
    .select({ m: sql<number>`coalesce(max(${categories.sortOrder}), 0)` })
    .from(categories)
    .where(eq(categories.userId, uid))
    .get();
  return db()
    .insert(categories)
    .values({ ...input, userId: uid, icon: input.icon ?? null, sortOrder: (max?.m ?? 0) + 1 })
    .returning()
    .get();
}

export function updateCategory(uid: string, id: number, raw: Partial<z.input<typeof categoryInputSchema>>) {
  requireCategory(uid, id);
  const input = categoryInputSchema.partial().parse(raw);
  return db().update(categories).set(input).where(eq(categories.id, id)).returning().get();
}

export function deleteCategory(uid: string, id: number) {
  requireCategory(uid, id);
  db().delete(categories).where(eq(categories.id, id)).run();
}

/** Resolve a category from free text (name, case-insensitive, prefix/substring). */
export function findCategory(uid: string, query: string): Category | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const all = listCategories(uid);
  return (
    all.find((c) => c.name.toLowerCase() === q) ??
    all.find((c) => c.name.toLowerCase().startsWith(q)) ??
    all.find((c) => c.name.toLowerCase().includes(q))
  );
}

// ── Rules ────────────────────────────────────────────────────────────────

export function listRules(uid: string) {
  return db()
    .select({
      id: categoryRules.id,
      pattern: categoryRules.pattern,
      categoryId: categoryRules.categoryId,
      categoryName: categories.name,
      matchType: categoryRules.matchType,
      accountId: categoryRules.accountId,
      direction: categoryRules.direction,
      minAmountCents: categoryRules.minAmountCents,
      maxAmountCents: categoryRules.maxAmountCents,
      renameTo: categoryRules.renameTo,
      addTag: categoryRules.addTag,
    })
    .from(categoryRules)
    .innerJoin(categories, eq(categories.id, categoryRules.categoryId))
    .where(eq(categoryRules.userId, uid))
    .orderBy(asc(categoryRules.pattern))
    .all();
}
export type Rule = ReturnType<typeof listRules>[number];

export function normalizePattern(p: string) {
  return p.trim().toLowerCase().replace(/\s+/g, " ");
}

export const ruleInputSchema = z.object({
  pattern: z.string().trim().min(2).max(120).describe("Text to look for in the bank label (case-insensitive)"),
  categoryId: z.number().int(),
  matchType: z.enum(["contains", "starts", "exact"]).default("contains"),
  accountId: z.number().int().nullish().describe("Only for this account"),
  direction: z.enum(["in", "out"]).nullish().describe("Only money in, or only money out"),
  minAmount: z.number().min(0).nullish().describe("Only when the amount (absolute) is at least this"),
  maxAmount: z.number().min(0).nullish().describe("Only when the amount (absolute) is at most this"),
  renameTo: z.string().trim().max(120).nullish().describe("Show the payee under this name"),
  addTag: z.string().trim().max(40).nullish().describe("Add this tag"),
});
export type RuleInput = z.input<typeof ruleInputSchema>;

/**
 * Save a rule. A plain "contains → category" rule replaces the existing one
 * with the same pattern (the old behaviour); a rule with conditions is added
 * alongside, so "amazon" over 200 can go to Electronics while "amazon" stays
 * Shopping.
 */
export function saveRule(uid: string, raw: RuleInput & { id?: number }) {
  const i = ruleInputSchema.parse(raw);
  requireCategory(uid, i.categoryId);
  if (i.accountId) {
    const own = db().select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, i.accountId), eq(accounts.userId, uid))).get();
    if (!own) throw new Error(`Account ${i.accountId} not found`);
  }
  const p = normalizePattern(i.pattern);
  const values = {
    userId: uid,
    pattern: p,
    categoryId: i.categoryId,
    matchType: i.matchType,
    accountId: i.accountId ?? null,
    direction: i.direction ?? null,
    minAmountCents: i.minAmount != null ? toCents(i.minAmount) : null,
    maxAmountCents: i.maxAmount != null ? toCents(i.maxAmount) : null,
    renameTo: i.renameTo || null,
    addTag: i.addTag ? i.addTag.replace(/^#/, "").toLowerCase() : null,
  };
  const plain = !values.accountId && !values.direction && values.minAmountCents === null && values.maxAmountCents === null && values.matchType === "contains";
  const existing = raw.id
    ? db().select({ id: categoryRules.id }).from(categoryRules).where(and(eq(categoryRules.id, raw.id), eq(categoryRules.userId, uid))).get()
    : plain
      ? db()
          .select({ id: categoryRules.id })
          .from(categoryRules)
          .where(
            and(
              eq(categoryRules.userId, uid),
              eq(categoryRules.pattern, p),
              eq(categoryRules.matchType, "contains"),
              isNull(categoryRules.accountId),
              isNull(categoryRules.direction),
              isNull(categoryRules.minAmountCents),
              isNull(categoryRules.maxAmountCents),
            ),
          )
          .get()
      : undefined;
  if (raw.id && !existing) throw new Error(`Rule ${raw.id} not found`);
  audit(uid, "rule", existing?.id ?? null, existing ? "update" : "create", `Rule “${p}” → category ${i.categoryId}`);
  if (existing) return db().update(categoryRules).set(values).where(eq(categoryRules.id, existing.id)).returning().get()!;
  return db().insert(categoryRules).values(values).returning().get();
}

export function upsertRule(uid: string, pattern: string, categoryId: number) {
  if (normalizePattern(pattern).length < 2) throw new Error("Rule pattern must be at least 2 characters");
  saveRule(uid, { pattern, categoryId });
}

export function deleteRule(uid: string, id: number) {
  db()
    .delete(categoryRules)
    .where(and(eq(categoryRules.id, id), eq(categoryRules.userId, uid)))
    .run();
}

export interface RuleTarget {
  description: string;
  amountCents?: number;
  accountId?: number | null;
}

type MatchableRule = Pick<Rule, "pattern" | "categoryId"> & Partial<Omit<Rule, "pattern" | "categoryId">>;

function ruleMatches(r: MatchableRule, t: RuleTarget, label: string): boolean {
  const type = r.matchType ?? "contains";
  if (type === "contains" ? !label.includes(r.pattern) : type === "starts" ? !label.startsWith(r.pattern) : label !== r.pattern) return false;
  // A condition the transaction can't answer (no amount, no account) doesn't match.
  if (r.accountId && t.accountId !== r.accountId) return false;
  if (r.direction || r.minAmountCents != null || r.maxAmountCents != null) {
    if (t.amountCents === undefined) return false;
    if (r.direction === "in" && t.amountCents <= 0) return false;
    if (r.direction === "out" && t.amountCents >= 0) return false;
    const abs = Math.abs(t.amountCents);
    if (r.minAmountCents != null && abs < r.minAmountCents) return false;
    if (r.maxAmountCents != null && abs > r.maxAmountCents) return false;
  }
  return true;
}

const specificity = (r: MatchableRule) =>
  (r.accountId ? 1 : 0) + (r.direction ? 1 : 0) + (r.minAmountCents != null || r.maxAmountCents != null ? 1 : 0) + (r.matchType === "exact" ? 1 : 0);

/** The rule that applies: the most specific one, then the longest pattern ("carrefour city" beats "carrefour"). */
export function matchRule<R extends MatchableRule>(t: RuleTarget, rules: R[]): R | null {
  const label = normalizePattern(t.description);
  let best: R | null = null;
  for (const r of rules) {
    if (!ruleMatches(r, t, label)) continue;
    if (!best || specificity(r) > specificity(best) || (specificity(r) === specificity(best) && r.pattern.length > best.pattern.length)) best = r;
  }
  return best;
}

/** Longest matching pattern wins ("carrefour city" beats "carrefour"). */
export function matchCategory(description: string, rules: MatchableRule[]): number | null {
  return matchRule({ description }, rules)?.categoryId ?? null;
}

/** What a rule does to a transaction: its category, payee name and tags. */
export function ruleEffects(t: RuleTarget & { tags?: string[] | null }, rules: Rule[]) {
  const r = matchRule(t, rules);
  if (!r) return null;
  const tags = r.addTag ? [...new Set([...(t.tags ?? []), r.addTag])] : (t.tags ?? null);
  return { categoryId: r.categoryId, payee: r.renameTo ?? null, tags: tags?.length ? tags : null };
}

/** Categorize every uncategorized transaction a rule matches (and apply its rename/tag). Returns how many changed. */
export function applyRulesToUncategorized(uid: string): number {
  const rules = listRules(uid);
  if (!rules.length) return 0;
  const rows = db()
    .select({ id: transactions.id, description: transactions.description, amountCents: transactions.amountCents, accountId: transactions.accountId, payee: transactions.payee, tags: transactions.tags })
    .from(transactions)
    .where(and(eq(transactions.userId, uid), isNull(transactions.categoryId)))
    .all();
  let changed = 0;
  const stmt = db().$client.prepare("UPDATE transactions SET category_id = ?, payee = coalesce(?, payee), tags = ? WHERE id = ?");
  db().$client.transaction(() => {
    for (const r of rows) {
      const fx = ruleEffects(r, rules);
      if (fx) {
        stmt.run(fx.categoryId, fx.payee, fx.tags ? JSON.stringify(fx.tags) : r.tags ? JSON.stringify(r.tags) : null, r.id);
        changed++;
      }
    }
  })();
  return changed;
}

/**
 * Suggest a rule pattern from a bank label: drop card/date noise
 * ("CB CARREFOUR 12/03 PARIS" → "carrefour").
 */
export function suggestPattern(description: string): string {
  const cleaned = description
    .toLowerCase()
    .replace(/\b(cb|carte|prlv|prelevement|prélèvement|vir|virement|sepa|paiement|achat|card|pos|debit|fact|purchase|ach)\b/g, " ")
    .replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, " ")
    .replace(/[*#]/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => w.length > 1);
  // The pattern must match its own label ("PAYPAL *VINTED" → "paypal", not "paypal vinted").
  const normalized = normalizePattern(description);
  const pair = words.slice(0, 2).join(" ");
  if (pair && normalized.includes(pair)) return pair;
  if (words[0] && normalized.includes(words[0])) return words[0];
  return normalized;
}
