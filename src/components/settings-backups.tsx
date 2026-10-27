"use client";

import { useState, useTransition } from "react";
import { Download, HardDriveDownload, RotateCcw, Upload } from "lucide-react";
import { backupNowAction, importExportAction, restoreBackupAction } from "@/app/settings/actions";
import { Button } from "./ui";

export interface BackupItem {
  name: string;
  bytes: number;
  createdAt: string;
  reason: string;
}

const REASON = { daily: "daily", manual: "by hand", "before-restore": "before a restore" } as Record<string, string>;

/** Backups (owner) and importing a wallet export (anyone with an empty wallet). */
export function BackupsPanel({ backups, isOwner, canImport, dir }: { backups: BackupItem[]; isOwner: boolean; canImport: boolean; dir: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const say = (r: { ok: boolean; message?: string; error?: string }) => setMsg({ ok: r.ok, text: (r.ok ? r.message : r.error) ?? "" });

  return (
    <div className="space-y-4 text-sm">
      {isOwner && (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={pending} onClick={() => start(async () => say(await backupNowAction()))}>
              <HardDriveDownload size={14} /> Back up now
            </Button>
            <span className="text-xs text-muted">
              Every day on its own, kept 14 days plus 8 weekly copies, in <code className="rounded bg-surface-2 px-1">{dir}</code>.
            </span>
          </div>
          {backups.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {backups.slice(0, 12).map((b) => (
                <li key={b.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="tabular">{new Date(b.createdAt).toLocaleString()}</span>
                    <span className="text-xs text-muted">
                      {" "}
                      · {REASON[b.reason] ?? b.reason} · {Math.max(1, Math.round(b.bytes / 1024))} KB
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <a href={`/api/backups/${b.name}`} download className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink">
                      <Download size={13} /> Download
                    </a>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      className={armed === b.name ? "border border-critical text-critical-text" : ""}
                      onClick={() => {
                        if (armed !== b.name) {
                          setArmed(b.name);
                          setTimeout(() => setArmed((x) => (x === b.name ? null : x)), 5000);
                          return;
                        }
                        setArmed(null);
                        start(async () => say(await restoreBackupAction(b.name)));
                      }}
                    >
                      <RotateCcw size={13} /> {armed === b.name ? "Replace everything with this?" : "Restore"}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">
            Restoring replaces every user&apos;s data with the backup&apos;s; a copy of the current state is taken first. Who is signed in stays signed
            in.
          </p>
        </div>
      )}
      {canImport && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            start(async () => say(await importExportAction(fd)));
          }}
        >
          <input type="file" name="file" accept="application/json,.json" required className="text-xs" aria-label="Wallet export file" />
          <Button size="sm" type="submit" disabled={pending}>
            <Upload size={14} /> Import a wallet export
          </Button>
          <span className="text-xs text-muted">Into this empty wallet: accounts, history, transactions, budgets, goals…</span>
        </form>
      )}
      {msg && <p className={msg.ok ? "text-good-text" : "text-critical-text"}>{msg.text}</p>}
    </div>
  );
}
