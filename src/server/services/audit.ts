import { db } from "@/server/db/client";
import { changes } from "@/server/db/schema";

/**
 * The audit trail: who changed what, when. DB-only so any service can call it
 * without an import cycle. Never throws into the change it records — losing a
 * log line is better than failing the user's action.
 */
export function audit(uid: string, entity: string, entityId: string | number | null, action: string, summary: string, actorId: string = uid) {
  try {
    db()
      .insert(changes)
      .values({ userId: uid, actorId, entity, entityId: entityId === null ? null : String(entityId), action, summary: summary.slice(0, 300) })
      .run();
  } catch (e) {
    console.warn("[audit]", e);
  }
}

export function listChanges(uid: string, limit = 100) {
  return db()
    .$client.prepare(
      `SELECT c.id, c.at, c.entity, c.entity_id AS entityId, c.action, c.summary, c.actor_id AS actorId, u.name AS actorName
       FROM changes c LEFT JOIN users u ON u.id = c.actor_id
       WHERE c.user_id = ? ORDER BY c.at DESC, c.id DESC LIMIT ?`,
    )
    .all(uid, limit) as { id: number; at: number; entity: string; entityId: string | null; action: string; summary: string; actorId: string | null; actorName: string | null }[];
}

