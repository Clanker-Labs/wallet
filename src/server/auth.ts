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

/** The first account can always be created; more only when WALLET_ALLOW_SIGNUP=1. */
export function signupAllowed(existingUsers: number): boolean {
  if (existingUsers === 0) return true;
  return /^(1|true|yes|on)$/i.test(process.env.WALLET_ALLOW_SIGNUP ?? "");
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostnameOf(hostOrUrl: string): string | null {
  try {
    return new URL(hostOrUrl.includes("://") ? hostOrUrl : `http://${hostOrUrl}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function localHost(hostname: string | null): boolean {
  if (!hostname) return false;
  if (LOOPBACK.has(hostname) || hostname.endsWith(".localhost")) return true;
  const extra = (process.env.WALLET_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase());
  return extra.includes(hostname);
}

/**
 * Without WALLET_API_TOKEN, sessionless API calls act as the owner. Only
 * accept them for this machine: a loopback Host (and X-Forwarded-Host, which
 * a reverse proxy sets to the public name) defeats DNS rebinding, and no
 * foreign Origin means a web page you visit can't call localhost on your
 * behalf. This protects against browsers, not against someone who can reach
 * the port directly: exposing the app on a network needs a token.
 * WALLET_ALLOWED_HOSTS adds hostnames (e.g. a LAN name) on purpose.
 */
export function tokenlessAccess(headers: Headers): { ok: true } | { ok: false; reason: string } {
  const hosts = [headers.get("host") ?? "", ...(headers.get("x-forwarded-host") ?? "").split(",")]
    .map((h) => h.trim())
    .filter(Boolean);
  if (!hosts.length || !hosts.every((h) => localHost(hostnameOf(h)))) {
    return {
      ok: false,
      reason: "Token-less API access only works on localhost: set WALLET_API_TOKEN and send it as a Bearer token",
    };
  }
  const origin = headers.get("origin");
  if (origin === "null" || (origin && !localHost(hostnameOf(origin))) || headers.get("sec-fetch-site") === "cross-site") {
    return { ok: false, reason: "Cross-site request blocked" };
  }
  return { ok: true };
}
