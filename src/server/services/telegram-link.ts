import { and, eq, lt } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { db } from "@/server/db/client";
import { authChallenges, type User } from "@/server/db/schema";
import { getUser, linkTelegramChat } from "./users";

/** One-time codes that link a Telegram chat to a wallet user ("/start CODE"). */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const TTL_MS = 30 * 60_000;

export function createTelegramLinkCode(uid: string): { code: string; expiresAt: Date } {
  db().delete(authChallenges).where(lt(authChallenges.expiresAt, new Date())).run();
  db()
    .delete(authChallenges)
    .where(and(eq(authChallenges.kind, "telegram_link"), eq(authChallenges.userId, uid)))
    .run();
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const expiresAt = new Date(Date.now() + TTL_MS);
  db().insert(authChallenges).values({ id: `tg-${code}`, kind: "telegram_link", challenge: code, userId: uid, expiresAt }).run();
  return { code, expiresAt };
}

/** Link the chat to the code's owner; returns the user, or null for an unknown/expired code. */
export function redeemTelegramLinkCode(code: string, chatId: number): User | null {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const row = db().select().from(authChallenges).where(eq(authChallenges.id, `tg-${normalized}`)).get();
  if (!row || row.kind !== "telegram_link" || !row.userId || row.expiresAt.getTime() < Date.now()) return null;
  db().delete(authChallenges).where(eq(authChallenges.id, row.id)).run();
  linkTelegramChat(row.userId, chatId);
  return getUser(row.userId) ?? null;
}
