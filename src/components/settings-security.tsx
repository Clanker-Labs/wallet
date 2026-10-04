"use client";

import { useState, useTransition } from "react";
import { Check, Cloud, KeyRound, Loader2, Pencil, X } from "lucide-react";
import { deletePasskeyAction, renamePasskeyAction } from "@/app/settings/actions";
import { Badge, Input } from "./ui";
import { ConfirmButton, Flash, useFlash } from "./settings-kit";

export interface PasskeyItem {
  id: string;
  name: string;
  /** "multiDevice" (synced, e.g. iCloud Keychain) or "singleDevice" (security key, some laptops). */
  deviceType: string | null;
  backedUp: boolean;
  /** Pre-formatted on the server, in the user's time zone. */
  created: string;
  lastUsed: string | null;
}

/** The signed-in user's passkeys: rename inline, delete with a second click (never the last one). */
export function PasskeyList({ passkeys }: { passkeys: PasskeyItem[] }) {
  const [flash, showFlash] = useFlash(4000);
  const only = passkeys.length <= 1;
  return (
    <div>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {passkeys.map((p) => (
          <PasskeyRow key={p.id} passkey={p} only={only} onResult={showFlash} />
        ))}
      </ul>
      <Flash flash={flash} className="block [&:not(:empty)]:mt-2" />
      {only && (
        <p className="mt-2 text-xs text-muted">
          This is your only passkey, so it can’t be removed. Add a second one (your phone, say) so losing a device doesn’t lock
          you out.
        </p>
      )}
    </div>
  );
}

function PasskeyRow({
  passkey: p,
  only,
  onResult,
}: {
  passkey: PasskeyItem;
  only: boolean;
  onResult: (tone: "good" | "critical", text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [pending, start] = useTransition();
  const synced = p.deviceType === "multiDevice";

  const save = () => {
    const next = name.trim();
    if (!next || next === p.name) {
      setName(p.name);
      setEditing(false);
      return;
    }
    start(async () => {
      const res = await renamePasskeyAction(p.id, next);
      if (res.ok) setEditing(false);
      else onResult("critical", res.error);
    });
  };

  const remove = () =>
    start(async () => {
      const res = await deletePasskeyAction(p.id);
      onResult(res.ok ? "good" : "critical", res.ok ? `Removed “${p.name}”` : res.error);
    });

  return (
    <li className="flex items-start gap-3 px-3.5 py-3 sm:px-4">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-tint text-accent" aria-hidden>
        {synced ? <Cloud size={16} /> : <KeyRound size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setName(p.name);
                  setEditing(false);
                }
              }}
              maxLength={60}
              autoFocus
              aria-label="Passkey name"
              className="h-8 max-w-64 min-w-0"
            />
            <button
              type="submit"
              disabled={pending}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-good-text hover:bg-surface-2"
              aria-label="Save name"
            >
              {pending ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            </button>
            <button
              type="button"
              onClick={() => {
                setName(p.name);
                setEditing(false);
              }}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
              aria-label="Cancel"
            >
              <X size={15} />
            </button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium [overflow-wrap:anywhere] text-ink">{p.name}</span>
            <Badge tone={p.backedUp ? "good" : "neutral"}>{p.backedUp ? "Backed up" : "Not backed up"}</Badge>
          </div>
        )}
        <p className="mt-0.5 text-xs text-muted">
          {synced ? "Synced passkey" : p.deviceType === "singleDevice" ? "This device only" : "Passkey"}
          <span aria-hidden> · </span>
          Added {p.created}
          <span aria-hidden> · </span>
          {p.lastUsed ? `Last used ${p.lastUsed}` : "Never used"}
        </p>
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={pending}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
            aria-label={`Rename ${p.name}`}
            title="Rename"
          >
            <Pencil size={14} />
          </button>
          <ConfirmButton
            iconOnly
            onConfirm={remove}
            disabled={only || pending}
            title={only ? "Your only passkey: add another one before removing it" : `Remove ${p.name}`}
            confirmLabel="Remove?"
          />
        </div>
      )}
    </li>
  );
}
