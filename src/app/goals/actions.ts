"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { archiveGoal, deleteGoal, saveGoal, type GoalInput } from "@/server/services/goals";
import { invalidateSqlSandbox } from "@/server/agent/sql-sandbox";
import { requireUid } from "@/server/session";

const message = (e: unknown) =>
  e instanceof ZodError ? `${e.issues[0]?.path.join(".") || "Input"}: ${e.issues[0]?.message}` : e instanceof Error ? e.message : "Something went wrong";

export async function saveGoalAction(id: number | null, input: GoalInput): Promise<{ ok: boolean; message: string }> {
  const uid = await requireUid();
  try {
    const g = saveGoal(uid, { ...input, ...(id ? { id } : {}) });
    invalidateSqlSandbox(uid);
    revalidatePath("/", "layout");
    return { ok: true, message: id ? `Saved ${g.name}.` : `Added ${g.name}.` };
  } catch (e) {
    return { ok: false, message: message(e) };
  }
}

export async function goalStatusAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = Number(fd.get("id"));
  const what = String(fd.get("what"));
  if (!Number.isInteger(id)) return;
  if (what === "delete") deleteGoal(uid, id);
  else archiveGoal(uid, id, what === "archive");
  invalidateSqlSandbox(uid);
  revalidatePath("/", "layout");
}
