import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { categories, categoryRules, transactions, type Category } from "@/server/db/schema";

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["income", "expense", "transfer"]),
  icon: z.string().max(8).nullish(),
});

export function listCategories(): Category[] {
  return db().select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.name)).all();
}

export function getCategory(id: number): Category | undefined {
  return db().select().from(categories).where(eq(categories.id, id)).get();
}

export function createCategory(raw: z.input<typeof categoryInputSchema>): Category {
  const input = categoryInputSchema.parse(raw);
  const max = db().select({ m: sql<number>`coalesce(max(${categories.sortOrder}), 0)` }).from(categories).get();
  return db()
    .insert(categories)
    .values({ ...input, icon: input.icon ?? null, sortOrder: (max?.m ?? 0) + 1 })
    .returning()
    .get();
}

export function updateCategory(id: number, raw: Partial<z.input<typeof categoryInputSchema>>) {
  const input = categoryInputSchema.partial().parse(raw);
  return db().update(categories).set(input).where(eq(categories.id, id)).returning().get();
}

export function deleteCategory(id: number) {
  db().delete(categories).where(eq(categories.id, id)).run();
}

/** Resolve a category from free text (name, case-insensitive, prefix/substring). */
export function findCategory(query: string): Category | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const all = listCategories();
  return (
    all.find((c) => c.name.toLowerCase() === q) ??
    all.find((c) => c.name.toLowerCase().startsWith(q)) ??
    all.find((c) => c.name.toLowerCase().includes(q))
  );
}

// ── Rules ────────────────────────────────────────────────────────────────

export function listRules() {
  return db()
    .select({
      id: categoryRules.id,
      pattern: categoryRules.pattern,
      categoryId: categoryRules.categoryId,
      categoryName: categories.name,
    })
    .from(categoryRules)
    .innerJoin(categories, eq(categories.id, categoryRules.categoryId))
    .orderBy(asc(categoryRules.pattern))
    .all();
}

export function normalizePattern(p: string) {
  return p.trim().toLowerCase().replace(/\s+/g, " ");
}

export function upsertRule(pattern: string, categoryId: number) {
  const p = normalizePattern(pattern);
  if (p.length < 2) throw new Error("Rule pattern must be at least 2 characters");
  db()
    .insert(categoryRules)
    .values({ pattern: p, categoryId })
    .onConflictDoUpdate({ target: categoryRules.pattern, set: { categoryId } })
    .run();
}

export function deleteRule(id: number) {
  db().delete(categoryRules).where(eq(categoryRules.id, id)).run();
}

/** Longest matching pattern wins ("carrefour city" beats "carrefour"). */
export function matchCategory(
  description: string,
  rules: { pattern: string; categoryId: number }[] = listRules(),
): number | null {
  const d = description.toLowerCase().replace(/\s+/g, " ");
  let best: { len: number; id: number } | null = null;
  for (const r of rules) {
    if (d.includes(r.pattern) && (!best || r.pattern.length > best.len)) best = { len: r.pattern.length, id: r.categoryId };
  }
  return best?.id ?? null;
}

/** Categorize every uncategorized transaction a rule matches. Returns how many changed. */
export function applyRulesToUncategorized(): number {
  const rules = listRules();
  if (!rules.length) return 0;
  const rows = db()
    .select({ id: transactions.id, description: transactions.description })
    .from(transactions)
    .where(and(isNull(transactions.categoryId)))
    .all();
  let changed = 0;
  const stmt = db().$client.prepare("UPDATE transactions SET category_id = ? WHERE id = ?");
  db().$client.transaction(() => {
    for (const r of rows) {
      const id = matchCategory(r.description, rules);
      if (id) {
        stmt.run(id, r.id);
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
    .replace(/\b(cb|carte|prlv|prelevement|prélèvement|vir|virement|sepa|paiement|achat|card|pos|debit|fact)\b/g, " ")
    .replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, " ")
    .replace(/[*#]/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => w.length > 1);
  return words.slice(0, 2).join(" ") || description.toLowerCase().trim();
}
