import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount } from "@/server/services/accounts";
import { addTransaction, importTransactions, listTags, listTransactions, setSplits, tagTransactions } from "@/server/services/transactions";
import { applyRulesToUncategorized, findCategory, matchCategory, saveRule, upsertRule } from "@/server/services/categories";
import { budgetStatus } from "@/server/services/budgets";

let uid: string;
const cat = (n: string) => findCategory(uid, n)!.id;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  uid = freshUser();
});

describe("rules with conditions and actions", () => {
  it("lets the more specific rule win, and renames and tags", () => {
    const card = createAccount(uid, { name: "Card", type: "credit_card" });
    upsertRule(uid, "amzn", cat("Shopping"));
    saveRule(uid, { pattern: "amzn", categoryId: cat("Education"), minAmount: 200, renameTo: "Amazon", addTag: "#Work" });
    saveRule(uid, { pattern: "amzn", categoryId: cat("Refunds & other income"), direction: "in" });
    saveRule(uid, { pattern: "uber", categoryId: cat("Transport"), accountId: card.id });

    const small = addTransaction(uid, { date: "2026-10-01", amount: -25, description: "AMZN MKTP FR" });
    const big = addTransaction(uid, { date: "2026-10-02", amount: -450, description: "AMZN MKTP FR" });
    const back = addTransaction(uid, { date: "2026-10-03", amount: 25, description: "AMZN MKTP REFUND" });
    const uberElsewhere = addTransaction(uid, { date: "2026-10-04", amount: -12, description: "UBER TRIP" });
    const uberOnCard = addTransaction(uid, { date: "2026-10-04", amount: -12, accountId: card.id, description: "UBER TRIP" });

    expect(small.categoryId).toBe(cat("Shopping"));
    expect(big).toMatchObject({ categoryId: cat("Education"), payee: "Amazon", tags: ["work"] });
    expect(back.categoryId).toBe(cat("Refunds & other income"));
    expect(uberElsewhere.categoryId).toBeNull();
    expect(uberOnCard.categoryId).toBe(cat("Transport"));
    // Without an amount to check, a conditional rule doesn't apply: the plain one does.
    expect(matchCategory("AMZN MKTP FR", [{ pattern: "amzn", categoryId: 1 }, { pattern: "amzn", categoryId: 2, minAmountCents: 100 }])).toBe(1);
  });

  it("applies the same rules on import and to existing uncategorized rows", () => {
    const a = createAccount(uid, { name: "Checking", type: "checking" });
    importTransactions(uid, [{ date: "2026-10-01", amount: -9.99, description: "SPOTIFY P1234" }], a.id);
    saveRule(uid, { pattern: "spotify", categoryId: cat("Subscriptions"), renameTo: "Spotify", matchType: "starts" });
    expect(applyRulesToUncategorized(uid)).toBe(1);
    expect(listTransactions(uid).rows[0]).toMatchObject({ payee: "Spotify", categoryName: "Subscriptions" });
    const r = importTransactions(uid, [{ date: "2026-10-02", amount: -9.99, description: "SPOTIFY P5678" }], a.id);
    expect(r.categorized).toBe(1);
  });
});

describe("splits", () => {
  it("count each part in its own category, and must add up", () => {
    const tx = addTransaction(uid, { date: "2026-10-05", amount: -120, description: "CARREFOUR", categoryId: cat("Groceries") });
    expect(() => setSplits(uid, tx.id, [{ categoryId: cat("Groceries"), amount: -80 }, { categoryId: cat("Shopping"), amount: -30 }])).toThrow(/add up/);
    setSplits(uid, tx.id, [
      { categoryId: cat("Groceries"), amount: -80 },
      { categoryId: cat("Shopping"), amount: -40, note: "kettle" },
    ]);
    const s = budgetStatus(uid, "2026-10");
    expect(s.lines.find((l) => l.name === "Groceries")!.spentCents).toBe(80_00);
    expect(s.lines.find((l) => l.name === "Shopping")!.spentCents).toBe(40_00);
    expect(s.expensesCents).toBe(120_00);
    expect(listTransactions(uid).rows[0].splitCount).toBe(2);
    setSplits(uid, tx.id, []);
    expect(budgetStatus(uid, "2026-10").lines.find((l) => l.name === "Groceries")!.spentCents).toBe(120_00);
  });
});

describe("tags and search", () => {
  it("filters by tag and treats % in a search literally", () => {
    const a = addTransaction(uid, { date: "2026-10-01", amount: -50, description: "HOTEL KYOTO" });
    addTransaction(uid, { date: "2026-10-02", amount: -5, description: "100% JUICE BAR" });
    addTransaction(uid, { date: "2026-10-03", amount: -6, description: "COFFEE" });
    tagTransactions(uid, [a.id], { add: ["Trip Japan"] });
    expect(listTransactions(uid, { tag: "trip-japan" }).rows.map((r) => r.description)).toEqual(["HOTEL KYOTO"]);
    expect(listTags(uid)).toEqual([{ tag: "trip-japan", count: 1 }]);
    expect(listTransactions(uid, { search: "100%" }).total).toBe(1);
    expect(listTransactions(uid, { search: "%" }).total).toBe(1);
    tagTransactions(uid, [a.id], { remove: ["trip-japan"] });
    expect(listTags(uid)).toEqual([]);
  });
});
