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

export type SaveReminderResult =
  | { ok: true; id: number; title: string }
  | { ok: false; errors: Record<string, string>; message?: string };

function refresh() {
  revalidatePath("/reminders");
  revalidatePath("/");
}

/** Create (id = null) or update a reminder. Returns field errors from reminderInputSchema. */
export async function saveReminder(id: number | null, input: ReminderInput): Promise<SaveReminderResult> {
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
    const r = id === null ? createReminder(parsed.data) : updateReminder(id, parsed.data);
    refresh();
    return { ok: true, id: r.id, title: r.title };
  } catch (e) {
    return { ok: false, errors: {}, message: e instanceof Error ? e.message : "Could not save" };
  }
}

export async function toggleReminder(id: number, enabled: boolean): Promise<void> {
  setReminderEnabled(id, enabled);
  refresh();
}

/** The ✅ from the web: stops the nagging until the next occurrence. */
export async function markReminderDone(id: number): Promise<void> {
  acknowledgeReminder(id);
  refresh();
}

export async function removeReminder(id: number): Promise<void> {
  deleteReminder(id);
  refresh();
}
