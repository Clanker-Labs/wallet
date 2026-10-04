import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import {
  beginLogin,
  beginRegistration,
  deletePasskey,
  finishLogin,
  finishRegistration,
  listPasskeys,
  relyingParty,
} from "@/server/services/passkeys";
import { countUsers, createSession, getUser, userForSession } from "@/server/services/users";

/**
 * A minimal software authenticator ("none" attestation, ES256), enough to run
 * real WebAuthn ceremonies against @simplewebauthn/server without a browser.
 */

// ── Tiny CBOR encoder (maps, ints, text, bytes) ──────────────────────────
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

const b64url = (b: Buffer) => b.toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

class SoftAuthenticator {
  private keys = new Map<string, { privateKey: KeyObject; userHandle: string; counter: number }>();
  constructor(private rp: { rpID: string; origin: string }) {}

  register(options: { challenge: string; user: { id: string } }) {
    const credId = randomBytes(16);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(credId.length);
    const authData = Buffer.concat([
      sha256(this.rp.rpID),
      Buffer.from([0x45]), // UP | UV | AT
      Buffer.alloc(4), // sign count 0
      Buffer.alloc(16), // aaguid
      lenBuf,
      credId,
      cbor(cose),
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.rp.origin, crossOrigin: false }),
    );
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    this.keys.set(b64url(credId), { privateKey, userHandle: options.user.id, counter: 0 });
    return {
      id: b64url(credId),
      rawId: b64url(credId),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["hybrid" as const],
      },
      clientExtensionResults: {},
    };
  }

  /** Discoverable login: picks the first (or given) credential, like a phone would. */
  login(options: { challenge: string }, credentialId = [...this.keys.keys()][0], origin = this.rp.origin) {
    const key = this.keys.get(credentialId)!;
    key.counter++;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(key.counter);
    const authData = Buffer.concat([sha256(this.rp.rpID), Buffer.from([0x05]), counter]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin }));
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), key.privateKey);
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: key.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

const rp = { rpID: "localhost", origin: "http://localhost:3000" };

beforeEach(() => {
  freshDb();
});

describe("passkeys", () => {
  it("signs up with a phone passkey (QR / hybrid), then signs in with it", async () => {
    const phone = new SoftAuthenticator(rp);
    const reg = await beginRegistration(rp, { mode: "phone", name: "Alex" });
    expect(reg.options).toMatchObject({ hints: ["hybrid"], authenticatorSelection: { residentKey: "required" } });

    const user = await finishRegistration(rp, reg.challengeId, phone.register(reg.options));
    expect(user).toMatchObject({ name: "Alex", role: "owner" });
    expect(listPasskeys(user.id)).toEqual([expect.objectContaining({ name: "Phone" })]);

    const login = await beginLogin(rp, "phone");
    expect(login.options).toMatchObject({ hints: ["hybrid"], rpId: "localhost" });
    expect((await finishLogin(rp, login.challengeId, phone.login(login.options))).id).toBe(user.id);

    // Sessions resolve to the user and are stored hashed.
    const { token } = createSession(user.id, "test");
    expect(userForSession(token)?.id).toBe(user.id);
    expect(userForSession("forged")).toBeNull();
  });

  it("rejects replayed or expired challenges, wrong origins and unknown keys", async () => {
    const laptop = new SoftAuthenticator(rp);
    const reg = await beginRegistration(rp, { mode: "device", name: "Alex" });
    expect((reg.options as { hints?: string[] }).hints ?? []).toEqual([]);
    const response = laptop.register(reg.options);
    await finishRegistration(rp, reg.challengeId, response);
    // Challenges are single use: the same response can't create a second account.
    await expect(finishRegistration(rp, reg.challengeId, response)).rejects.toThrow(/expired/);
    expect(countUsers()).toBe(1);

    const phishing = await beginLogin(rp, "device");
    await expect(
      finishLogin(rp, phishing.challengeId, laptop.login(phishing.options, undefined, "https://evil.example")),
    ).rejects.toThrow();

    const stranger = new SoftAuthenticator(rp);
    const otherReg = await beginRegistration(rp, { mode: "device", name: "Mallory" });
    stranger.register(otherReg.options); // never sent to the server
    const unknown = await beginLogin(rp, "device");
    await expect(finishLogin(rp, unknown.challengeId, stranger.login(unknown.options))).rejects.toThrow(/Unknown passkey/);

    vi.useFakeTimers({ toFake: ["Date"] });
    const late = await beginLogin(rp, "device");
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
    await expect(finishLogin(rp, late.challengeId, laptop.login(late.options))).rejects.toThrow(/expired/);
    vi.useRealTimers();
  });

  it("adds a second passkey to a signed-in user and always keeps one", async () => {
    const laptop = new SoftAuthenticator(rp);
    const reg = await beginRegistration(rp, { mode: "device", name: "Alex" });
    const user = await finishRegistration(rp, reg.challengeId, laptop.register(reg.options));

    const phone = new SoftAuthenticator(rp);
    const add = await beginRegistration(rp, { mode: "phone", user });
    expect(add.options.excludeCredentials).toHaveLength(1);
    // A sign-up challenge can't be used to add a key (and vice versa).
    await expect(finishRegistration(rp, reg.challengeId, phone.register(add.options), { signedInUser: user })).rejects.toThrow();
    const again = await beginRegistration(rp, { mode: "phone", user });
    const iphone = phone.register(again.options);
    await finishRegistration(rp, again.challengeId, iphone, { signedInUser: user, label: "iPhone" });
    const keys = listPasskeys(user.id);
    expect(keys.map((k) => k.name).sort()).toEqual(["Phone", "iPhone"].sort());
    expect(getUser(user.id)!.name).toBe("Alex");

    const login = await beginLogin(rp, "phone");
    expect((await finishLogin(rp, login.challengeId, phone.login(login.options, iphone.id))).id).toBe(user.id);

    deletePasskey(user.id, keys[0].id);
    expect(() => deletePasskey(user.id, keys[1].id)).toThrow();
    expect(listPasskeys(user.id)).toHaveLength(1);
  });

  it("derives the relying party from the public URL or the request", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(relyingParty("http://localhost:3000/api/auth/login/options", h({ host: "localhost:3000" }))).toEqual({
      rpID: "localhost",
      origin: "http://localhost:3000",
    });
    expect(
      relyingParty("http://10.0.0.2:3000/x", h({ host: "10.0.0.2:3000", "x-forwarded-host": "wallet.example.com", "x-forwarded-proto": "https" })),
    ).toEqual({ rpID: "wallet.example.com", origin: "https://wallet.example.com" });
    process.env.WALLET_PUBLIC_URL = "https://money.example.org/";
    expect(relyingParty("http://localhost:3000/x", h({ host: "localhost:3000" }))).toEqual({
      rpID: "money.example.org",
      origin: "https://money.example.org",
    });
    delete process.env.WALLET_PUBLIC_URL;
  });
});
