import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@/server/db/schema";
import { apiTokenEnabled, SESSION_COOKIE, validBearer } from "@/server/auth";
import { countUsers, createSession, defaultUser, deleteSession, userForSession } from "@/server/services/users";

/** The signed-in user for this request (cached per request). */
export const currentUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return userForSession(token);
});

/** For pages and server actions: the user, or a redirect to sign in / sign up. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (user) return user;
  redirect(countUsers() === 0 ? "/signup" : "/login");
}

/** Shorthand used by server actions. */
export async function requireUid(): Promise<string> {
  return (await requireUser()).id;
}

/**
 * For API routes: the browser session's user; otherwise (bearer token, or no
 * token configured = local mode) the default user. Null means unauthorized.
 */
export async function apiUser(request: Request): Promise<User | null> {
  const user = await currentUser();
  if (user) return user;
  const authorized = apiTokenEnabled() ? validBearer(request.headers.get("authorization")) : true;
  if (!authorized || countUsers() === 0) return null;
  try {
    return defaultUser();
  } catch {
    return null;
  }
}

export async function isSecureRequest(): Promise<boolean> {
  const h = await headers();
  const proto = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim();
  if (proto) return proto === "https";
  return (process.env.WALLET_PUBLIC_URL ?? "").startsWith("https://");
}

export async function startSession(userId: string) {
  const h = await headers();
  const { token, expiresAt } = createSession(userId, h.get("user-agent"));
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    expires: expiresAt,
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) deleteSession(token);
  jar.delete(SESSION_COOKIE);
}
