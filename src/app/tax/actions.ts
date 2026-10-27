"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { addPresence, deletePresence, setTaxInput } from "@/server/services/tax";
import { requireUid } from "@/server/session";

const message = (e: unknown) =>
  e instanceof ZodError ? `${e.issues[0]?.path.join(".") || "Input"}: ${e.issues[0]?.message}` : e instanceof Error ? e.message : "Something went wrong";

export async function setTaxInputAction(year: number, key: string, value: string): Promise<{ ok: boolean; message: string }> {
  const uid = await requireUid();
  try {
    setTaxInput(uid, year, key, value);
    revalidatePath("/tax");
    return { ok: true, message: "Saved" };
  } catch (e) {
    return { ok: false, message: message(e) };
  }
}

export async function addStayAction(country: string, fromDate: string, toDate: string): Promise<{ ok: boolean; message: string }> {
  const uid = await requireUid();
  try {
    addPresence(uid, { country, fromDate, toDate });
    revalidatePath("/tax");
    return { ok: true, message: "Stay added" };
  } catch (e) {
    return { ok: false, message: message(e) };
  }
}

export async function deleteStayAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = Number(fd.get("id"));
  if (Number.isInteger(id)) deletePresence(uid, id);
  revalidatePath("/tax");
}
