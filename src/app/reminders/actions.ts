"use server";

import { revalidatePath } from "next/cache";
import {
  acknowledgeReminder,
  createReminder,
  deleteReminder,
  reminderInputSchema,
  setReminderEnabled,
  updateReminder,
  type ReminderInput,
} from "@/server/services/reminders";
import { requireUid } from "@/server/session";

export type SaveReminderResult =
  | { ok: true; id: number; title: string }
  | { ok: false; errors: Record<string, string>; message?: string };

function refresh() {
  revalidatePath("/reminders");
  revalidatePath("/");
}

/** Create (id = null) or update a reminder. Returns field errors from reminderInputSchema. */
export async function saveReminder(id: number | null, input: ReminderInput): Promise<SaveReminderResult> {
  const uid = await requireUid();
  const parsed = reminderInputSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const key = i.path.map(String).join(".") || "form";
      if (errors[key]) continue;
      if (i.code === "too_small" && i.origin === "string") errors[key] = "Required";
      else if (i.code === "too_big" && i.origin === "string") errors[key] = `At most ${Number(i.maximum)} characters`;
      else if (i.code === "too_small" || i.code === "too_big") errors[key] = `Between ${key === "dayOfMonth" ? "1 and 31" : "the allowed range"}`;
      else errors[key] = i.message;
    }
    return { ok: false, errors };
  }
  try {
    const r = id === null ? createReminder(uid, parsed.data) : updateReminder(uid, id, parsed.data);
    refresh();
    return { ok: true, id: r.id, title: r.title };
  } catch (e) {
    return { ok: false, errors: {}, message: e instanceof Error ? e.message : "Could not save" };
  }
}

export async function toggleReminder(id: number, enabled: boolean): Promise<void> {
  const uid = await requireUid();
  setReminderEnabled(uid, id, enabled);
  refresh();
}

/** The ✅ from the web: stops the nagging until the next occurrence. */
export async function markReminderDone(id: number): Promise<void> {
  const uid = await requireUid();
  acknowledgeReminder(uid, id);
  refresh();
}

export async function removeReminder(id: number): Promise<void> {
  const uid = await requireUid();
  deleteReminder(uid, id);
  refresh();
}
