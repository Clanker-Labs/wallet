"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import {
  createRecurring,
  deleteRecurring,
  reconcileRecurring,
  recordOccurrence,
  suggestRecurring,
  updateRecurring,
  type RecurringInput,
} from "@/server/services/recurring";
import { invalidateSqlSandbox } from "@/server/agent/sql-sandbox";
import { requireUid } from "@/server/session";

export interface RecurringActionState {
  ok: boolean;
  message: string;
}

function done(uid: string) {
  invalidateSqlSandbox(uid);
  revalidatePath("/", "layout");
}

const message = (e: unknown) =>
  e instanceof ZodError ? `${e.issues[0]?.path.join(".") || "Input"}: ${e.issues[0]?.message}` : e instanceof Error ? e.message : "Something went wrong";

export async function saveRecurringAction(id: number | null, input: RecurringInput): Promise<RecurringActionState> {
  const uid = await requireUid();
  try {
    const r = id ? updateRecurring(uid, id, input) : createRecurring(uid, input);
    reconcileRecurring(uid);
    done(uid);
    return { ok: true, message: id ? `Saved ${r.name}.` : `Added ${r.name}.` };
  } catch (e) {
    return { ok: false, message: message(e) };
  }
}

export async function setRecurringStatus(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = Number(fd.get("id"));
  const status = String(fd.get("status")) as "active" | "paused" | "dismissed";
  if (!Number.isInteger(id) || !["active", "paused", "dismissed"].includes(status)) return;
  updateRecurring(uid, id, { status });
  if (status === "active") reconcileRecurring(uid);
  done(uid);
}

export async function deleteRecurringAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = Number(fd.get("id"));
  if (Number.isInteger(id)) deleteRecurring(uid, id);
  done(uid);
}

export async function recordRecurringAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = Number(fd.get("id"));
  if (Number.isInteger(id)) recordOccurrence(uid, id);
  done(uid);
}

export async function detectRecurringAction(): Promise<void> {
  const uid = await requireUid();
  suggestRecurring(uid);
  done(uid);
}
