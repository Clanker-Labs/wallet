import { timingSafeEqual } from "node:crypto";

/**
 * Programmatic access (MCP over HTTP, /api/tools, /api/agent without a
 * browser session) is open by default because wallet is meant to run
 * locally. Set WALLET_API_TOKEN to require `Authorization: Bearer <token>`.
 */
export const SESSION_COOKIE = "wallet_session";
export const CHALLENGE_COOKIE = "wallet_challenge";

export function apiTokenEnabled(): boolean {
  return Boolean(process.env.WALLET_API_TOKEN);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function validBearer(header: string | null): boolean {
  if (!apiTokenEnabled() || !header) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return !!m && safeEqual(m[1].trim(), process.env.WALLET_API_TOKEN!);
}

/** Sign-ups are open unless WALLET_ALLOW_SIGNUP=false (the first account can always be created). */
export function signupAllowed(existingUsers: number): boolean {
  if (existingUsers === 0) return true;
  return !/^(0|false|no|off)$/i.test(process.env.WALLET_ALLOW_SIGNUP ?? "true");
}
