"use server";

import { revalidatePath } from "next/cache";
import { deleteSimulation, saveSimulation } from "@/server/services/simulations";
import { purchaseInputSchema } from "@/lib/finance/mortgage";
import { buyVsRentInputSchema } from "@/lib/finance/buy-vs-rent";
import { projectionInputSchema } from "@/lib/finance/projection";
import { requireUid } from "@/server/session";

const SCHEMAS = {
  mortgage: purchaseInputSchema,
  buy_vs_rent: buyVsRentInputSchema,
  projection: projectionInputSchema,
} as const;

export type SaveScenarioResult = { ok: true; id: number; name: string } | { ok: false; error: string };

/** Save the current simulator inputs as a named scenario (validated against the simulator's schema). */
export async function saveScenario(input: { name: string; type: string; params: Record<string, unknown> }): Promise<SaveScenarioResult> {
  const uid = await requireUid();
  if (!Object.hasOwn(SCHEMAS, input.type)) return { ok: false, error: "Unknown simulation type" };
  const type = input.type as keyof typeof SCHEMAS;
  const schema = SCHEMAS[type];
  const name = String(input.name ?? "").trim().slice(0, 120);
  if (!name) return { ok: false, error: "Give it a name" };
  const parsed = schema.safeParse(input.params);
  if (!parsed.success) return { ok: false, error: "Fix the highlighted fields first" };
  // Drop Monte Carlo internals: they're simulator settings, not scenario inputs.
  const { simulations: _s, seed: _seed, ...params } = parsed.data as Record<string, unknown>;
  try {
    const row = saveSimulation(uid, { name, type, params });
    revalidatePath("/simulations");
    return { ok: true, id: row.id, name: row.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save" };
  }
}

export async function deleteScenario(id: number): Promise<void> {
  const uid = await requireUid();
  if (!Number.isInteger(id)) return;
  deleteSimulation(uid, id);
  revalidatePath("/simulations");
}
