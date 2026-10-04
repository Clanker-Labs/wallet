"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import {
  archiveAccount,
  createAccount,
  deleteAccount,
  deleteSnapshot,
  recordBalance,
  unarchiveAccount,
  updateAccount,
  type AccountInput,
} from "@/server/services/accounts";
import { today } from "@/server/services/settings";
import { ACCOUNT_TYPES, type AccountType, type LoanParams } from "@/lib/domain";
import { parseAmount } from "@/lib/money";
import { isISODate } from "@/lib/dates";
import { requireUid } from "@/server/session";

export interface AccountActionState {
  ok: boolean;
  message: string;
  id?: number;
}

const LOAN_TYPES = new Set<AccountType>(["mortgage", "loan"]);

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** Optional number field: undefined when empty, NaN when unreadable. */
function num(fd: FormData, key: string): number | undefined {
  const s = str(fd, key);
  if (!s) return undefined;
  return parseAmount(s) ?? Number.NaN;
}

function intId(v: FormDataEntryValue | null | number): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function errorMessage(e: unknown): string {
  if (e instanceof ZodError) {
    const i = e.issues[0];
    return i ? `${i.path.join(".") || "Input"}: ${i.message}` : "Invalid input";
  }
  return e instanceof Error ? e.message : "Something went wrong";
}

function refresh() {
  // Balances feed the dashboard, accounts, simulations…: every page is dynamic, so refresh them all.
  revalidatePath("/", "layout");
}

/** Shared parser for the create & edit account forms. */
function parseAccountForm(fd: FormData, mode: "create" | "edit"): { input?: AccountInput; error?: string } {
  const name = str(fd, "name");
  if (!name) return { error: "Give the account a name." };
  const type = str(fd, "type") as AccountType;
  if (!(type in ACCOUNT_TYPES)) return { error: "Pick an account type." };

  const ownership = num(fd, "ownershipPct");
  if (ownership !== undefined && (!Number.isFinite(ownership) || ownership <= 0 || ownership > 100)) {
    return { error: "Ownership must be between 1 and 100%." };
  }

  const input: AccountInput = {
    name,
    type,
    // Validated by the service (3–6 letter code); empty keeps the default / current one.
    currency: str(fd, "currency") || undefined,
    institution: str(fd, "institution") || null,
    ownershipPct: ownership ?? 100,
    includeInNetWorth: fd.get("includeInNetWorth") === "on",
    notes: str(fd, "notes") || null,
    loanParams: null,
    linkedAccountId: null,
  };

  if (mode === "create") {
    const balance = num(fd, "balance");
    if (balance !== undefined && !Number.isFinite(balance)) return { error: "The balance isn't a number (try 1234.56)." };
    if (balance !== undefined) input.initialBalance = balance;
  }

  if (type === "mortgage") input.linkedAccountId = intId(fd.get("linkedAccountId"));

  if (LOAN_TYPES.has(type)) {
    const principal = num(fd, "loanPrincipal");
    const rate = num(fd, "loanRate");
    const years = num(fd, "loanYears");
    const start = str(fd, "loanStart");
    const insurance = num(fd, "loanInsurance");
    const filled = [principal, rate, years].filter((v) => v !== undefined).length + (start ? 1 : 0);
    if (filled > 0 && filled < 4) {
      return { error: "To auto-amortize, fill principal, rate, duration and first payment — or leave them all empty." };
    }
    if (filled === 4) {
      if (!Number.isFinite(principal) || principal! <= 0) return { error: "Loan principal must be a positive amount." };
      if (!Number.isFinite(rate) || rate! < 0 || rate! > 30) return { error: "Interest rate must be between 0 and 30%." };
      if (!Number.isFinite(years) || years! <= 0 || years! > 50) return { error: "Duration must be between 1 month and 50 years." };
      if (!isISODate(start)) return { error: "First payment date must be a valid date." };
      if (insurance !== undefined && (!Number.isFinite(insurance) || insurance < 0 || insurance > 5)) {
        return { error: "Insurance rate must be between 0 and 5%." };
      }
      const loan: LoanParams = {
        principal: principal!,
        annualRatePct: rate!,
        durationMonths: Math.max(1, Math.round(years! * 12)),
        startDate: start,
      };
      if (insurance) loan.insuranceRatePct = insurance;
      input.loanParams = loan;
    }
  }
  return { input };
}

export async function createAccountAction(fd: FormData): Promise<AccountActionState> {
  const uid = await requireUid();
  const { input, error } = parseAccountForm(fd, "create");
  if (!input) return { ok: false, message: error! };
  try {
    const account = createAccount(uid, input);
    refresh();
    return { ok: true, message: `Added “${account.name}”`, id: account.id };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

export async function updateAccountAction(fd: FormData): Promise<AccountActionState> {
  const uid = await requireUid();
  const id = intId(fd.get("id"));
  if (!id) return { ok: false, message: "Unknown account." };
  const { input, error } = parseAccountForm(fd, "edit");
  if (!input) return { ok: false, message: error! };
  if (input.linkedAccountId === id) input.linkedAccountId = null;
  try {
    updateAccount(uid, id, input);
    refresh();
    return { ok: true, message: "Saved", id };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

/** One-field balance update from the accounts list (InlineAmount). Returns whether anything was saved. */
export async function quickRecordBalance(fd: FormData): Promise<boolean> {
  const uid = await requireUid();
  const accountId = intId(fd.get("accountId"));
  const amount = parseAmount(String(fd.get("amount") ?? ""));
  if (!accountId || amount === null) return false;
  recordBalance(uid, { accountId, balance: amount, source: "manual" });
  refresh();
  return true;
}

/** Balance with an optional date & note (account page). */
export async function recordBalanceAction(fd: FormData): Promise<AccountActionState> {
  const uid = await requireUid();
  const accountId = intId(fd.get("accountId"));
  if (!accountId) return { ok: false, message: "Unknown account." };
  const amount = parseAmount(str(fd, "amount"));
  if (amount === null) return { ok: false, message: "Type the balance, e.g. 1234.56" };
  const date = str(fd, "date") || today(uid);
  if (!isISODate(date)) return { ok: false, message: "Pick a valid date." };
  if (date > today(uid)) return { ok: false, message: "That date is in the future." };
  try {
    recordBalance(uid, { accountId, balance: amount, date, note: str(fd, "note") || null, source: "manual" });
    refresh();
    return { ok: true, message: "Saved" };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

export async function deleteSnapshotAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = intId(fd.get("snapshotId"));
  if (!id) return;
  deleteSnapshot(uid, id);
  refresh();
}

export async function archiveAccountAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = intId(fd.get("id"));
  if (!id) return;
  archiveAccount(uid, id);
  refresh();
}

export async function unarchiveAccountAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = intId(fd.get("id"));
  if (!id) return;
  unarchiveAccount(uid, id);
  refresh();
}

export async function deleteAccountAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = intId(fd.get("id"));
  if (!id || fd.get("confirm") !== "yes") return;
  deleteAccount(uid, id);
  refresh();
  redirect("/accounts");
}
