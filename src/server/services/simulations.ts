import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { simulations } from "@/server/db/schema";

export const simulationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(["mortgage", "buy_vs_rent", "projection"]),
  params: z.record(z.string(), z.unknown()),
});

export function listSimulations() {
  return db().select().from(simulations).orderBy(desc(simulations.createdAt)).all();
}

export function getSimulation(id: number) {
  return db().select().from(simulations).where(eq(simulations.id, id)).get();
}

export function saveSimulation(raw: z.input<typeof simulationInputSchema>) {
  const input = simulationInputSchema.parse(raw);
  return db().insert(simulations).values(input).returning().get();
}

export function deleteSimulation(id: number) {
  db().delete(simulations).where(eq(simulations.id, id)).run();
}
