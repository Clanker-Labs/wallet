import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dbPath } from "@/server/db/client";

/**
 * Encryption at rest for third-party credentials (broker API keys).
 *
 * AES-256-GCM. The key is `WALLET_SECRET_KEY` (any string, hashed to 32 bytes)
 * or, when unset, a random key generated once into `secret.key` next to the
 * database (mode 0600). Set the variable when the data directory is backed up
 * somewhere you trust less than the machine: with the key file, a copy of the
 * data directory carries everything needed to decrypt it.
 *
 * Changing or losing the key makes stored credentials unreadable; the
 * connections then report an error and must be reconnected. Nothing else in
 * the database depends on it.
 */

const VERSION = "v1";
let cachedKey: Buffer | null = null;

function keyFile(): string {
  return path.join(path.dirname(path.resolve(dbPath())), "secret.key");
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.WALLET_SECRET_KEY?.trim();
  if (fromEnv) {
    cachedKey = crypto.createHash("sha256").update(fromEnv).digest();
    return cachedKey;
  }
  // An in-memory database (tests) gets an in-memory key.
  if (dbPath() === ":memory:") {
    cachedKey = crypto.randomBytes(32);
    return cachedKey;
  }
  const file = keyFile();
  try {
    cachedKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fresh = crypto.randomBytes(32);
    // `wx`: never overwrite a key another process wrote first.
    try {
      fs.writeFileSync(file, fresh.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
      cachedKey = fresh;
    } catch {
      cachedKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
    }
  }
  if (cachedKey.length !== 32) throw new Error(`${file} is not a 32-byte hex key`);
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || !data) throw new Error("Unrecognized secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Stored credentials can't be decrypted (WALLET_SECRET_KEY or secret.key changed) — reconnect");
  }
}

/** Test hook: forget the loaded key. */
export function resetSecretKeyForTests() {
  cachedKey = null;
}
