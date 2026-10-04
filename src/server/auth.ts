import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Two optional secrets:
 * - WALLET_PASSWORD protects the web UI (cookie session).
 * - WALLET_API_TOKEN protects programmatic access (Authorization: Bearer …)
 *   and is required for the remote MCP / tools endpoints.
 */
export const SESSION_COOKIE = "wallet_session";

export function passwordEnabled(): boolean {
  return Boolean(process.env.WALLET_PASSWORD);
}

export function apiTokenEnabled(): boolean {
  return Boolean(process.env.WALLET_API_TOKEN);
}

/** Session value derived from the password: rotating the password logs everyone out. */
export function sessionValue(): string {
  return createHmac("sha256", process.env.WALLET_PASSWORD ?? "").update("wallet-session-v1").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkPassword(candidate: string): boolean {
  return passwordEnabled() && safeEqual(candidate, process.env.WALLET_PASSWORD!);
}

export function validSession(cookie: string | undefined): boolean {
  if (!passwordEnabled()) return true;
  return !!cookie && safeEqual(cookie, sessionValue());
}

export function validBearer(header: string | null): boolean {
  if (!apiTokenEnabled() || !header) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return !!m && safeEqual(m[1].trim(), process.env.WALLET_API_TOKEN!);
}
