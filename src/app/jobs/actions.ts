"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { saveJob, type JobInput } from "@/server/services/jobs";
import { invalidateSqlSandbox } from "@/server/agent/sql-sandbox";
import { requireUid } from "@/server/session";

export interface JobActionState {
  ok: boolean;
  message: string;
  id?: number;
}

export async function saveJobAction(input: JobInput): Promise<JobActionState> {
  const uid = await requireUid();
  try {
    const job = saveJob(uid, input);
    invalidateSqlSandbox(uid);
    revalidatePath("/", "layout");
    return { ok: true, message: input.accountId ? `Saved ${job.employer}.` : `Added ${job.employer}.`, id: job.accountId };
  } catch (e) {
    if (e instanceof ZodError) {
      const i = e.issues[0];
      return { ok: false, message: i ? `${i.path.join(".") || "Input"}: ${i.message}` : "Invalid input" };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}
