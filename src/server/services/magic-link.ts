import { eq, lt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "@/server/db/client";
import { authChallenges, type User } from "@/server/db/schema";
import { getUser } from "./users";

/**
 * One-time sign-in links, minted from the command line by someone with shell
 * access (`npm run auth:link`): first login of a seeded account, or recovery
 * after losing every passkey. Valid 15 minutes, single use.
 */
const TTL_MS = 15 * 60_000;

export function createMagicLink(userId: string): { code: string; expiresAt: Date } {
  db().delete(authChallenges).where(lt(authChallenges.expiresAt, new Date())).run();
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_MS);
  db().insert(authChallenges).values({ id: `ml-${code}`, kind: "magic_link", challenge: code, userId, expiresAt }).run();
  return { code, expiresAt };
}

export function redeemMagicLink(code: string): User | null {
  const id = `ml-${code}`;
  const row = db().select().from(authChallenges).where(eq(authChallenges.id, id)).get();
  db().delete(authChallenges).where(eq(authChallenges.id, id)).run();
  if (!row || row.kind !== "magic_link" || !row.userId || row.expiresAt.getTime() < Date.now()) return null;
  return getUser(row.userId) ?? null;
}
