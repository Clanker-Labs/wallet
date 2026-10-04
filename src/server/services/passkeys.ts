import { and, eq, lt } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { db } from "@/server/db/client";
import { authChallenges, passkeys, type User } from "@/server/db/schema";
import { createUser, getUser } from "./users";

/**
 * Passkey (WebAuthn) ceremonies. "Phone" mode adds the `hybrid` hint so the
 * browser goes straight to its QR code: scan it with an iPhone and the
 * passkey lives in iCloud Keychain. No passwords, no OAuth.
 */

export interface RelyingParty {
  /** e.g. "localhost" or "wallet.example.com" — must match the page's host. */
  rpID: string;
  /** e.g. "http://localhost:3000" or "https://wallet.example.com". */
  origin: string;
}

export type CeremonyMode = "device" | "phone";

const RP_NAME = "wallet";
const CHALLENGE_TTL_MS = 5 * 60_000;

function saveChallenge(row: Omit<typeof authChallenges.$inferInsert, "id" | "expiresAt">): string {
  const id = randomBytes(18).toString("base64url");
  db().delete(authChallenges).where(lt(authChallenges.expiresAt, new Date())).run();
  db()
    .insert(authChallenges)
    .values({ ...row, id, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) })
    .run();
  return id;
}

/** Fetch and consume a challenge (single use). */
function takeChallenge(id: string | undefined, kind: (typeof authChallenges.$inferSelect)["kind"]) {
  if (!id) throw new Error("Sign-in session expired, please try again.");
  const row = db()
    .select()
    .from(authChallenges)
    .where(and(eq(authChallenges.id, id), eq(authChallenges.kind, kind)))
    .get();
  db().delete(authChallenges).where(eq(authChallenges.id, id)).run();
  if (!row || row.expiresAt.getTime() < Date.now()) throw new Error("Sign-in session expired, please try again.");
  return row;
}

const hintsFor = (mode: CeremonyMode) => (mode === "phone" ? (["hybrid"] as const) : undefined);

// ── Registration (sign up, or add a passkey to a signed-in user) ─────────

export async function beginRegistration(
  rp: RelyingParty,
  opts: { mode: CeremonyMode; name?: string; user?: User },
): Promise<{ challengeId: string; options: Awaited<ReturnType<typeof generateRegistrationOptions>> }> {
  const userId = opts.user?.id ?? randomUUID();
  const displayName = (opts.user?.name ?? opts.name ?? "").trim().slice(0, 60) || "Me";
  const existing = opts.user
    ? db().select({ id: passkeys.id, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.userId, userId)).all()
    : [];
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: displayName,
    userDisplayName: displayName,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ?? undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    preferredAuthenticatorType: opts.mode === "phone" ? "remoteDevice" : undefined,
  });
  const hints = hintsFor(opts.mode);
  const challengeId = saveChallenge({
    kind: opts.user ? "add_passkey" : "register",
    challenge: options.challenge,
    userId: opts.user?.id ?? null,
    pendingName: opts.user ? null : JSON.stringify({ name: displayName, userId }),
  });
  return { challengeId, options: hints ? { ...options, hints: [...hints] } : options };
}

/** Verify a new passkey. Creates the user on sign-up. Returns the user. */
export async function finishRegistration(
  rp: RelyingParty,
  challengeId: string | undefined,
  response: RegistrationResponseJSON,
  opts: { label?: string; signedInUser?: User } = {},
): Promise<User> {
  const challenge = takeChallenge(challengeId, opts.signedInUser ? "add_passkey" : "register");
  if (opts.signedInUser && challenge.userId !== opts.signedInUser.id) throw new Error("Session mismatch");
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
  });
  if (!verification.verified) throw new Error("Passkey could not be verified");
  const info = verification.registrationInfo;

  let user: User;
  if (opts.signedInUser) user = opts.signedInUser;
  else {
    const pending = JSON.parse(challenge.pendingName ?? "{}") as { name?: string; userId?: string };
    user = createUser(pending.name ?? "Me", pending.userId);
  }
  db()
    .insert(passkeys)
    .values({
      id: info.credential.id,
      userId: user.id,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? null,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      name: opts.label?.slice(0, 60) || guessLabel(info.credential.transports),
      lastUsedAt: new Date(),
    })
    .run();
  return user;
}

function guessLabel(transports: string[] | undefined): string {
  if (transports?.includes("hybrid")) return "Phone";
  if (transports?.includes("internal")) return "This device";
  if (transports?.includes("usb") || transports?.includes("nfc")) return "Security key";
  return "Passkey";
}

// ── Authentication ───────────────────────────────────────────────────────

export async function beginLogin(rp: RelyingParty, mode: CeremonyMode) {
  // Discoverable credentials: no allow-list, the authenticator picks the account.
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred" });
  const challengeId = saveChallenge({ kind: "login", challenge: options.challenge });
  const hints = hintsFor(mode);
  return { challengeId, options: hints ? { ...options, hints: [...hints] } : options };
}

export async function finishLogin(
  rp: RelyingParty,
  challengeId: string | undefined,
  response: AuthenticationResponseJSON,
): Promise<User> {
  const challenge = takeChallenge(challengeId, "login");
  const credential = db().select().from(passkeys).where(eq(passkeys.id, response.id)).get();
  if (!credential) throw new Error("Unknown passkey — create an account first, or use the device you signed up with.");
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: credential.id,
      publicKey: new Uint8Array(credential.publicKey),
      counter: credential.counter,
      transports: (credential.transports ?? undefined) as never,
    },
    requireUserVerification: false,
  });
  if (!verification.verified) throw new Error("Passkey could not be verified");
  db()
    .update(passkeys)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
    .where(eq(passkeys.id, credential.id))
    .run();
  const user = getUser(credential.userId);
  if (!user) throw new Error("Account not found");
  return user;
}

// ── Management ───────────────────────────────────────────────────────────

export function listPasskeys(uid: string) {
  return db()
    .select({
      id: passkeys.id,
      name: passkeys.name,
      deviceType: passkeys.deviceType,
      backedUp: passkeys.backedUp,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, uid))
    .all();
}

export function renamePasskey(uid: string, id: string, name: string) {
  db()
    .update(passkeys)
    .set({ name: name.trim().slice(0, 60) })
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, uid)))
    .run();
}

/** Remove a passkey — never the last one, or the user would be locked out. */
export function deletePasskey(uid: string, id: string) {
  if (listPasskeys(uid).length <= 1) throw new Error("Keep at least one passkey, or you won't be able to sign in.");
  db()
    .delete(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, uid)))
    .run();
}

/** RP settings from the request (or WALLET_PUBLIC_URL / WALLET_RP_ID). */
export function relyingParty(requestUrl: string, headers: Headers): RelyingParty {
  const configured = process.env.WALLET_PUBLIC_URL?.replace(/\/+$/, "");
  let origin: string;
  if (configured) origin = configured;
  else {
    const url = new URL(requestUrl);
    const proto = (headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")).split(",")[0].trim();
    const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? url.host).split(",")[0].trim();
    origin = `${proto}://${host}`;
  }
  const rpID = process.env.WALLET_RP_ID || new URL(origin).hostname;
  return { rpID, origin };
}
