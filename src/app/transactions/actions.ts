"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { addTransaction, categorizeTransactions, deleteTransaction, listSplits, listTransactions, setSplits, tagTransactions } from "@/server/services/transactions";
import { getCategory } from "@/server/services/categories";
import { matchTransfers } from "@/server/services/transfers";
import { parseAmount } from "@/lib/money";
import { isISODate } from "@/lib/dates";
import { requireUid } from "@/server/session";
import { getSettings } from "@/server/services/settings";

export interface TxActionState {
  ok: boolean;
  message: string;
}

const isId = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

function refresh() {
  revalidatePath("/", "layout");
}

/**
 * Change one transaction's category. Deliberately does NOT revalidate: the
 * row stays where it is (even in the "Uncategorized" view) so focus isn't lost
 * and the "always categorize" chip can still be offered next to it.
 */
export async function setTransactionCategory(id: number, categoryId: number | null): Promise<{ ok: boolean }> {
  const uid = await requireUid();
  if (!isId(id) || (categoryId !== null && !isId(categoryId))) return { ok: false };
  if (categoryId !== null && !getCategory(uid, categoryId)) return { ok: false };
  categorizeTransactions(uid, [id], categoryId);
  return { ok: true };
}

/** Categorize the transaction AND remember "description contains <pattern> → category" for the others. */
export async function createRuleFromTransaction(
  id: number,
  categoryId: number,
  pattern: string,
): Promise<{ ok: boolean; ruleApplied: number; message?: string }> {
  const uid = await requireUid();
  const p = pattern.trim();
  if (!isId(id) || !isId(categoryId) || p.length < 2 || p.length > 100) {
    return { ok: false, ruleApplied: 0, message: "Invalid rule" };
  }
  if (!getCategory(uid, categoryId)) return { ok: false, ruleApplied: 0, message: "Unknown category" };
  const { ruleApplied } = categorizeTransactions(uid, [id], categoryId, p);
  refresh();
  return { ok: true, ruleApplied };
}

export async function quickAddTransaction(fd: FormData): Promise<TxActionState> {
  const uid = await requireUid();
  const s = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const description = s("description");
  if (!description) return { ok: false, message: "Add a description." };
  const raw = parseAmount(s("amount"), getSettings(uid).locale);
  if (raw === null || raw === 0) return { ok: false, message: "Type an amount, e.g. 12.50" };
  const amount = s("direction") === "in" ? Math.abs(raw) : -Math.abs(raw);
  const date = s("date");
  if (date && !isISODate(date)) return { ok: false, message: "Pick a valid date." };
  const category = s("categoryId");
  const account = Number(s("accountId"));
  // "" = the account's currency (or the base currency without an account).
  const currency = s("currency").toUpperCase() || undefined;
  try {
    addTransaction(uid, {
      date: date || undefined,
      description,
      amount,
      currency,
      // "" = let the rules pick (service matches when undefined), "none" = leave uncategorized.
      categoryId: category === "" ? undefined : category === "none" ? null : Number(category),
      accountId: isId(account) ? account : null,
      source: "manual",
    });
  } catch (e) {
    const msg = e instanceof ZodError ? e.issues[0]?.message : e instanceof Error ? e.message : null;
    return { ok: false, message: msg ?? "Couldn't add it." };
  }
  refresh();
  return { ok: true, message: `Added “${description}”` };
}

export async function deleteTransactionAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = Number(fd.get("id"));
  if (!isId(id)) return;
  deleteTransaction(uid, id);
  refresh();
}

/** File every detected pair of moves between your own accounts under Transfers. */
export async function matchTransfersAction(): Promise<void> {
  const uid = await requireUid();
  matchTransfers(uid);
  refresh();
}

/** Replace a transaction's tags. */
export async function saveTagsAction(id: number, tags: string[]): Promise<TxActionState> {
  const uid = await requireUid();
  try {
    const current = listTransactions(uid, { limit: 1, offset: 0, ids: [id] }).rows[0]?.tags ?? [];
    tagTransactions(uid, [id], { remove: current, add: tags });
    refresh();
    return { ok: true, message: "Tags saved" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}

/** Split a transaction over several categories (an empty list removes the split). */
export async function saveSplitsAction(id: number, parts: { categoryId: number | null; amount: number; note?: string | null }[]): Promise<TxActionState> {
  const uid = await requireUid();
  try {
    setSplits(uid, id, parts);
    refresh();
    return { ok: true, message: parts.length ? "Split saved" : "Split removed" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}

export async function loadSplitsAction(id: number) {
  const uid = await requireUid();
  return listSplits(uid, id).map((s) => ({ categoryId: s.categoryId, amount: s.amountCents / 100, note: s.note }));
}
