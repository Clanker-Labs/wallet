"use server";

import { revalidatePath } from "next/cache";
import { setBudget } from "@/server/services/budgets";
import { parseAmount } from "@/lib/money";

/** Set (or clear, with an empty/0 amount) a category's monthly budget. */
export async function saveBudget(formData: FormData) {
  const categoryId = Number(formData.get("categoryId"));
  const amount = parseAmount(String(formData.get("amount") ?? ""));
  if (!Number.isInteger(categoryId)) return;
  setBudget(categoryId, amount);
  revalidatePath("/budgets");
  revalidatePath("/");
}
