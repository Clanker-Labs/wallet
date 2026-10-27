"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { saveCompany, setCompanyFinancials, type CompanyInput } from "@/server/services/companies";
import { invalidateSqlSandbox } from "@/server/agent/sql-sandbox";
import { requireUid } from "@/server/session";

export interface CompanyActionState {
  ok: boolean;
  message: string;
}

const message = (e: unknown) =>
  e instanceof ZodError ? `${e.issues[0]?.path.join(".") || "Input"}: ${e.issues[0]?.message}` : e instanceof Error ? e.message : "Something went wrong";

export async function saveCompanyAction(input: CompanyInput): Promise<CompanyActionState> {
  const uid = await requireUid();
  try {
    const c = saveCompany(uid, input);
    invalidateSqlSandbox(uid);
    revalidatePath("/", "layout");
    return { ok: true, message: input.accountId ? `Saved ${c.account.name}.` : `Added ${c.account.name}.` };
  } catch (e) {
    return { ok: false, message: message(e) };
  }
}

export async function saveFinancialsAction(companyId: number, month: string, revenue: number, expenses: number): Promise<CompanyActionState> {
  const uid = await requireUid();
  try {
    setCompanyFinancials(uid, companyId, month, revenue, expenses);
    invalidateSqlSandbox(uid);
    revalidatePath("/", "layout");
    return { ok: true, message: revenue || expenses ? `Saved ${month}.` : `Cleared ${month}.` };
  } catch (e) {
    return { ok: false, message: message(e) };
  }
}
