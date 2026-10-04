import { asc, count, eq, lt } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "@/server/db/client";
import { categories, sessions, users, type User } from "@/server/db/schema";
import { DEFAULT_CATEGORIES } from "@/lib/domain";

const SESSION_DAYS = 90;

export function countUsers(): number {
  return db().select({ n: count() }).from(users).get()?.n ?? 0;
}

export function listUsers(): User[] {
  return db().select().from(users).orderBy(asc(users.createdAt)).all();
}

export function getUser(id: string): User | undefined {
  return db().select().from(users).where(eq(users.id, id)).get();
}

/** Create a user with their own default categories. The first user becomes the owner. */
export function createUser(name: string, id: string = randomUUID()): User {
  const trimmed = name.trim().slice(0, 60) || "Me";
  return db().transaction((tx) => {
    const isFirst = (tx.select({ n: count() }).from(users).get()?.n ?? 0) === 0;
    const user = tx
      .insert(users)
      .values({ id, name: trimmed, role: isFirst ? "owner" : "member" })
      .returning()
      .get();
    tx.insert(categories)
      .values(DEFAULT_CATEGORIES.map((c, idx) => ({ ...c, userId: user.id, sortOrder: idx })))
      .run();
    return user;
  });
}

export function renameUser(id: string, name: string) {
  db().update(users).set({ name: name.trim().slice(0, 60) }).where(eq(users.id, id)).run();
}

export function deleteUser(id: string) {
  db().delete(users).where(eq(users.id, id)).run();
}

/**
 * The user that local, token-less access (MCP stdio, /api/mcp, scripts) acts
 * as: WALLET_USER_ID if set, otherwise the owner (first account created).
 */
export function defaultUser(): User {
  const configured = process.env.WALLET_USER_ID?.trim();
  if (configured) {
    const u = getUser(configured);
    if (!u) throw new Error(`WALLET_USER_ID=${configured} does not match any user`);
    return u;
  }
  const owner = db().select().from(users).orderBy(asc(users.createdAt)).limit(1).get();
  if (!owner) throw new Error("No user yet: open the web app and create your account first.");
  return owner;
}

// ── Sessions ─────────────────────────────────────────────────────────────

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Start a session; returns the opaque token for the cookie. */
export function createSession(userId: string, userAgent?: string | null): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  db()
    .insert(sessions)
    .values({ id: hash(token), userId, expiresAt, userAgent: userAgent?.slice(0, 200) ?? null })
    .run();
  return { token, expiresAt };
}

export function userForSession(token: string | undefined | null): User | null {
  if (!token) return null;
  const row = db()
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, hash(token)))
    .get();
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return row.user;
}

export function deleteSession(token: string) {
  db().delete(sessions).where(eq(sessions.id, hash(token))).run();
}

export function purgeExpiredSessions() {
  db().delete(sessions).where(lt(sessions.expiresAt, new Date())).run();
}

// ── Telegram ─────────────────────────────────────────────────────────────

export function userByTelegramChat(chatId: number): User | undefined {
  return db().select().from(users).where(eq(users.telegramChatId, chatId)).get();
}

export function linkTelegramChat(userId: string, chatId: number | null) {
  if (chatId !== null) {
    // A chat belongs to one user at a time.
    db().update(users).set({ telegramChatId: null }).where(eq(users.telegramChatId, chatId)).run();
  }
  db().update(users).set({ telegramChatId: chatId }).where(eq(users.id, userId)).run();
}
