"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { setSetting, type AppSettings } from "@/server/services/settings";
import { deletePasskey, listPasskeys, renamePasskey } from "@/server/services/passkeys";
import { ensureFreshRates, latestFxDate } from "@/server/services/fx";
import { createTelegramLinkCode } from "@/server/services/telegram-link";
import { linkTelegramChat } from "@/server/services/users";
import {
  applyRulesToUncategorized,
  createCategory,
  deleteCategory,
  deleteRule,
  updateCategory,
  upsertRule,
} from "@/server/services/categories";
import { requireUid } from "@/server/session";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string; errors?: Record<string, string> };

// Settings touch every page (currency/locale come from the root layout).
const refreshAll = () => revalidatePath("/", "layout");
const refreshSettings = () => revalidatePath("/settings");

function errorText(e: unknown): string {
  if (e instanceof ZodError) return e.issues[0]?.message ?? "Invalid input";
  const msg = e instanceof Error ? e.message : String(e);
  if (/UNIQUE constraint failed: categories\.name/.test(msg)) return "A category with that name already exists";
  return msg;
}

export async function savePreferences(input: AppSettings): Promise<ActionResult> {
  const uid = await requireUid();
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
        setSetting(uid, key, values[key]);
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
  const uid = await requireUid();
  try {
    const c = createCategory(uid, {
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
  const uid = await requireUid();
  try {
    updateCategory(uid, id, { name: input.name, icon: input.icon.trim() || null });
    refreshAll();
    return { ok: true, message: "Saved" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function removeCategory(id: number): Promise<ActionResult> {
  const uid = await requireUid();
  deleteCategory(uid, id);
  refreshAll();
  return { ok: true, message: "Deleted" };
}

export async function addRule(input: { pattern: string; categoryId: number }): Promise<ActionResult> {
  const uid = await requireUid();
  if (!Number.isInteger(input.categoryId)) return { ok: false, error: "Pick a category" };
  try {
    upsertRule(uid, input.pattern, input.categoryId);
    refreshAll();
    return { ok: true, message: `Rule “${input.pattern.trim().toLowerCase()}” saved` };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function removeRule(id: number): Promise<ActionResult> {
  const uid = await requireUid();
  deleteRule(uid, id);
  refreshAll();
  return { ok: true, message: "Rule deleted" };
}

export async function applyRules(): Promise<ActionResult> {
  const uid = await requireUid();
  const n = applyRulesToUncategorized(uid);
  refreshAll();
  return { ok: true, message: n ? `Categorized ${n} transaction${n > 1 ? "s" : ""}` : "No uncategorized transaction matched a rule" };
}

// ── Security: passkeys ───────────────────────────────────────────────────

export async function renamePasskeyAction(id: string, name: string): Promise<ActionResult> {
  const uid = await requireUid();
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return { ok: false, error: "Give it a name, e.g. “iPhone” or “MacBook”" };
  if (!listPasskeys(uid).some((p) => p.id === id)) return { ok: false, error: "That passkey doesn't exist anymore" };
  renamePasskey(uid, id, trimmed);
  refreshSettings();
  return { ok: true, message: "Renamed" };
}

export async function deletePasskeyAction(id: string): Promise<ActionResult> {
  const uid = await requireUid();
  try {
    deletePasskey(uid, id);
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
  refreshSettings();
  return { ok: true, message: "Passkey removed" };
}

// ── Currency: exchange rates ─────────────────────────────────────────────

export type RefreshRatesResult =
  | { ok: true; message: string; date: string | null }
  | { ok: false; error: string; details?: string; date: string | null };

/** Force a rates download now and say how it went (stored rates are kept on failure). */
export async function refreshRatesAction(): Promise<RefreshRatesResult> {
  await requireUid();
  const before = latestFxDate();
  const r = await ensureFreshRates({ force: true });
  if (r.status === "failed") {
    return {
      ok: false,
      error: r.date
        ? "Couldn't reach the exchange-rate providers. Conversions keep using the last rates you have."
        : "Couldn't reach the exchange-rate providers, and no rates are stored yet.",
      details: r.error?.replace(/^Could not fetch exchange rates \((.*)\)$/, "$1").replaceAll("; ", " · "),
      date: r.date,
    };
  }
  refreshAll();
  return { ok: true, message: r.date !== before ? `Rates updated to ${r.date}` : "Rates are up to date", date: r.date };
}

// ── Telegram ─────────────────────────────────────────────────────────────

export async function createTelegramCodeAction(): Promise<{ ok: true; code: string; expiresAt: string }> {
  const uid = await requireUid();
  const { code, expiresAt } = createTelegramLinkCode(uid);
  return { ok: true, code, expiresAt: expiresAt.toISOString() };
}

export async function unlinkTelegramAction(): Promise<ActionResult> {
  const uid = await requireUid();
  linkTelegramChat(uid, null);
  refreshSettings();
  return { ok: true, message: "Telegram unlinked" };
}
