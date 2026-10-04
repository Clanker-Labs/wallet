import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { simulations } from "@/server/db/schema";

export const simulationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(["mortgage", "buy_vs_rent", "projection"]),
  params: z.record(z.string(), z.unknown()),
});

export function listSimulations(uid: string) {
  return db().select().from(simulations).where(eq(simulations.userId, uid)).orderBy(desc(simulations.createdAt)).all();
}

export function getSimulation(uid: string, id: number) {
  return db()
    .select()
    .from(simulations)
    .where(and(eq(simulations.id, id), eq(simulations.userId, uid)))
    .get();
}

export function saveSimulation(uid: string, raw: z.input<typeof simulationInputSchema>) {
  const input = simulationInputSchema.parse(raw);
  return db()
    .insert(simulations)
    .values({ ...input, userId: uid })
    .returning()
    .get();
}

export function deleteSimulation(uid: string, id: number) {
  db()
    .delete(simulations)
    .where(and(eq(simulations.id, id), eq(simulations.userId, uid)))
    .run();
}
