"use server";

import { createBackup, restoreBackup } from "@/server/services/backup";
import { importExport } from "@/server/services/export";
import { audit } from "@/server/services/audit";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { getSettings, setSetting, type AppSettings } from "@/server/services/settings";
import { rescheduleReminders } from "@/server/services/reminders";
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
  saveRule,
  type RuleInput,
} from "@/server/services/categories";
import {
  createConnection,
  deleteConnection,
  syncConnection,
  updateConnectionCredentials,
  type SyncResult,
} from "@/server/services/connections";
import { invalidateSqlSandbox } from "@/server/agent/sql-sandbox";
import { requireUid, requireUser } from "@/server/session";

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
  const timezoneBefore = getSettings(uid).timezone;
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
  // Reminders are "9:00 where you are": a new time zone moves them.
  if (!errors.timezone && values.timezone !== timezoneBefore) rescheduleReminders(uid);
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

export async function addRule(input: RuleInput): Promise<ActionResult> {
  const uid = await requireUid();
  if (!Number.isInteger(input.categoryId)) return { ok: false, error: "Pick a category" };
  try {
    saveRule(uid, input);
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

// ── Brokerage connections ────────────────────────────────────────────────

function syncMessage(r: SyncResult): string {
  if (r.skipped) return "Synced a moment ago — already up to date";
  const parts = [`${r.positions} position${r.positions === 1 ? "" : "s"}`];
  if (r.added) parts.push(`${r.added} new`);
  if (r.removed) parts.push(`${r.removed} removed`);
  return `Synced: ${parts.join(", ")}${r.warnings.length ? ` · ${r.warnings.length} skipped` : ""}`;
}

export async function connectBrokerAction(input: {
  provider: string;
  environment: string;
  credentials: Record<string, string>;
  accountId: number | null;
}): Promise<ActionResult> {
  const uid = await requireUid();
  try {
    const { connection, sync } = await createConnection(uid, input);
    invalidateSqlSandbox(uid);
    refreshAll();
    return { ok: true, message: `Connected ${connection.providerName} to “${connection.accountName}”. ${syncMessage(sync)}` };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function syncBrokerAction(id: number): Promise<ActionResult> {
  const uid = await requireUid();
  try {
    const r = await syncConnection(uid, id);
    invalidateSqlSandbox(uid);
    refreshAll();
    return r.ok ? { ok: true, message: syncMessage(r) } : { ok: false, error: r.error ?? "Sync failed" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function updateBrokerCredentialsAction(id: number, credentials: Record<string, string>): Promise<ActionResult> {
  const uid = await requireUid();
  try {
    const r = await updateConnectionCredentials(uid, id, credentials);
    invalidateSqlSandbox(uid);
    refreshAll();
    return { ok: true, message: `New key saved. ${syncMessage(r)}` };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function disconnectBrokerAction(id: number): Promise<ActionResult> {
  const uid = await requireUid();
  try {
    deleteConnection(uid, id);
    invalidateSqlSandbox(uid);
    refreshAll();
    return { ok: true, message: "Disconnected — the key is deleted, positions stay as manual holdings" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

// ── Backups & import ─────────────────────────────────────────────────────

async function requireOwner() {
  const user = await requireUser();
  if (user.role !== "owner") throw new Error("Only the owner can manage backups: they hold every user's data.");
  return user;
}

export async function backupNowAction(): Promise<ActionResult> {
  try {
    await requireOwner();
    const b = createBackup("manual");
    refreshAll();
    return { ok: true, message: `Backed up (${Math.round(b.bytes / 1024)} KB)` };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function restoreBackupAction(name: string): Promise<ActionResult> {
  try {
    const owner = await requireOwner();
    const r = restoreBackup(name);
    audit(owner.id, "backup", name, "restore", `Restored the backup ${name} (state before kept as ${r.safety})`);
    invalidateSqlSandbox();
    refreshAll();
    return { ok: true, message: `Restored ${r.tables} tables from ${name}. The state before is kept as ${r.safety}.` };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function importExportAction(fd: FormData): Promise<ActionResult> {
  const uid = await requireUid();
  try {
    const file = fd.get("file");
    if (!(file instanceof File)) return { ok: false, error: "Choose a wallet export (.json)." };
    if (file.size > 50 * 1024 * 1024) return { ok: false, error: "That file is over 50 MB." };
    const counts = importExport(uid, JSON.parse(await file.text()));
    audit(uid, "import", null, "import", `Imported a wallet export: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
    invalidateSqlSandbox(uid);
    refreshAll();
    const n = (k: string) => counts[k] ?? 0;
    return { ok: true, message: `Imported ${n("accounts")} accounts, ${n("transactions")} transactions, ${n("balance_snapshots")} balances.` };
  } catch (e) {
    return { ok: false, error: e instanceof SyntaxError ? "That file isn't valid JSON." : errorText(e) };
  }
}
