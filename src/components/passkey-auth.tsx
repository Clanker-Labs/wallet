"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint, Loader2, QrCode, Smartphone } from "lucide-react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Button, Input } from "./ui";

type Mode = "device" | "phone";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

/** Human message for WebAuthn failures (cancel, insecure context, unsupported). */
function explain(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") return "Cancelled — no worries, try again when ready.";
  if (name === "InvalidStateError") return "This device already has a passkey for this wallet. Sign in instead.";
  if (name === "SecurityError")
    return "Passkeys need a secure address: open wallet via https:// or http://localhost (not a raw IP).";
  return e instanceof Error ? e.message : String(e);
}

function supportCheck(): string | null {
  if (typeof window === "undefined") return null;
  if (!browserSupportsWebAuthn()) return "This browser doesn't support passkeys.";
  if (!window.isSecureContext) return "Passkeys need https:// or http://localhost — open wallet with one of those.";
  return null;
}

function PhoneHint() {
  return (
    <p className="text-xs leading-relaxed text-muted">
      <QrCode size={12} className="mr-1 inline align-[-1px]" />
      On a computer, choose <b>iPhone</b> to get a QR code: scan it with your iPhone camera and the passkey is saved in
      iCloud Keychain — sign in anywhere with Face ID.
    </p>
  );
}

export function PasskeySignIn({ next }: { next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (mode: Mode) => {
    const unsupported = supportCheck();
    if (unsupported) return setError(unsupported);
    setBusy(mode);
    setError(null);
    try {
      const optionsJSON = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/login/options", { mode });
      const response = await startAuthentication({ optionsJSON });
      await post("/api/auth/login/verify", { response });
      router.replace(next);
      router.refresh();
    } catch (e) {
      setError(explain(e));
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <Button variant="primary" className="h-11 w-full text-base" onClick={() => signIn("device")} disabled={!!busy} autoFocus>
        {busy === "device" ? <Loader2 size={18} className="animate-spin" /> : <Fingerprint size={18} />}
        Sign in with a passkey
      </Button>
      <Button className="h-11 w-full" onClick={() => signIn("phone")} disabled={!!busy}>
        {busy === "phone" ? <Loader2 size={16} className="animate-spin" /> : <Smartphone size={16} />}
        Use my iPhone (QR code)
      </Button>
      {error && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-critical-text">{error}</p>}
      <PhoneHint />
    </div>
  );
}

export function PasskeySignUp() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (mode: Mode) => {
    if (!name.trim()) return setError("What should we call you?");
    const unsupported = supportCheck();
    if (unsupported) return setError(unsupported);
    setBusy(mode);
    setError(null);
    try {
      const optionsJSON = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/register/options", {
        name,
        mode,
      });
      const response = await startRegistration({ optionsJSON });
      await post("/api/auth/register/verify", { response, label: mode === "phone" ? "iPhone" : undefined });
      router.replace("/");
      router.refresh();
    } catch (e) {
      setError(explain(e));
      setBusy(null);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        create("device");
      }}
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-2">Your name</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alex"
          autoComplete="name"
          autoFocus
          maxLength={60}
          className="h-11 text-base"
        />
      </label>
      <Button type="submit" variant="primary" className="h-11 w-full text-base" disabled={!!busy}>
        {busy === "device" ? <Loader2 size={18} className="animate-spin" /> : <Fingerprint size={18} />}
        Create my passkey
      </Button>
      <Button type="button" className="h-11 w-full" onClick={() => create("phone")} disabled={!!busy}>
        {busy === "phone" ? <Loader2 size={16} className="animate-spin" /> : <Smartphone size={16} />}
        Save it on my iPhone (QR code)
      </Button>
      {error && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-critical-text">{error}</p>}
      <PhoneHint />
    </form>
  );
}

/** Settings: register one more passkey for the signed-in user. */
export function AddPasskey() {
  const router = useRouter();
  const [busy, setBusy] = useState<Mode | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const add = async (mode: Mode) => {
    const unsupported = supportCheck();
    if (unsupported) return setMessage({ ok: false, text: unsupported });
    setBusy(mode);
    setMessage(null);
    try {
      const optionsJSON = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/register/options", { mode });
      const response = await startRegistration({ optionsJSON });
      await post("/api/auth/register/verify", { response, label: mode === "phone" ? "iPhone" : undefined });
      setMessage({ ok: true, text: "Passkey added ✓" });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: explain(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => add("device")} disabled={!!busy}>
        {busy === "device" ? <Loader2 size={14} className="animate-spin" /> : <Fingerprint size={14} />} Add this device
      </Button>
      <Button size="sm" onClick={() => add("phone")} disabled={!!busy}>
        {busy === "phone" ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />} Add an iPhone (QR)
      </Button>
      {message && <span className={message.ok ? "text-xs text-good-text" : "text-xs text-critical-text"}>{message.text}</span>}
    </div>
  );
}

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      className={className}
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
