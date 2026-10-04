"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { setSetting, type AppSettings } from "@/server/services/settings";
import {
  applyRulesToUncategorized,
  createCategory,
  deleteCategory,
  deleteRule,
  updateCategory,
  upsertRule,
} from "@/server/services/categories";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string; errors?: Record<string, string> };

// Settings touch every page (currency/locale come from the root layout).
const refreshAll = () => revalidatePath("/", "layout");

function errorText(e: unknown): string {
  if (e instanceof ZodError) return e.issues[0]?.message ?? "Invalid input";
  const msg = e instanceof Error ? e.message : String(e);
  if (/UNIQUE constraint failed: categories\.name/.test(msg)) return "A category with that name already exists";
  return msg;
}

export async function savePreferences(input: AppSettings): Promise<ActionResult> {
  const values: AppSettings = {
    currency: String(input.currency ?? "").trim().toUpperCase(),
    locale: String(input.locale ?? "").trim(),
    timezone: String(input.timezone ?? "").trim(),
  };
  const errors: Record<string, string> = {};
  for (const key of ["currency", "locale", "timezone"] as const) {
    if (!values[key]) errors[key] = "Required";
    else {
      try {
        setSetting(key, values[key]);
      } catch (e) {
        errors[key] = errorText(e);
      }
    }
  }
  refreshAll();
  if (Object.keys(errors).length) return { ok: false, error: "Some values weren't saved", errors };
  return { ok: true, message: "Preferences saved" };
}

export async function addCategory(input: { name: string; kind: string; icon: string }): Promise<ActionResult> {
  try {
    const c = createCategory({
      name: input.name,
      kind: input.kind as "income" | "expense" | "transfer",
      icon: input.icon.trim() || null,
    });
    refreshAll();
    return { ok: true, message: `Added “${c.name}”` };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function editCategory(id: number, input: { name: string; icon: string }): Promise<ActionResult> {
  try {
    updateCategory(id, { name: input.name, icon: input.icon.trim() || null });
    refreshAll();
    return { ok: true, message: "Saved" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function removeCategory(id: number): Promise<ActionResult> {
  deleteCategory(id);
  refreshAll();
  return { ok: true, message: "Deleted" };
}

export async function addRule(input: { pattern: string; categoryId: number }): Promise<ActionResult> {
  if (!Number.isInteger(input.categoryId)) return { ok: false, error: "Pick a category" };
  try {
    upsertRule(input.pattern, input.categoryId);
    refreshAll();
    return { ok: true, message: `Rule “${input.pattern.trim().toLowerCase()}” saved` };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function removeRule(id: number): Promise<ActionResult> {
  deleteRule(id);
  refreshAll();
  return { ok: true, message: "Rule deleted" };
}

export async function applyRules(): Promise<ActionResult> {
  const n = applyRulesToUncategorized();
  refreshAll();
  return { ok: true, message: n ? `Categorized ${n} transaction${n > 1 ? "s" : ""}` : "No uncategorized transaction matched a rule" };
}
