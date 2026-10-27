"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { shareAccountAction, unshareAccountAction } from "@/app/accounts/actions";
import { Button, Field, Input, Select } from "./ui";

/** Who an account is shared with, and with what share; add or remove a member. */
export function AccountSharing({
  accountId,
  shares,
  members,
}: {
  accountId: number;
  shares: { userId: string; name: string; role: "view" | "edit"; sharePct: number }[];
  members: { id: string; name: string }[];
}) {
  const available = members.filter((m) => !shares.some((s) => s.userId === m.id));
  const [member, setMember] = useState(available[0]?.id ?? "");
  const [role, setRole] = useState<"view" | "edit">("view");
  const [pct, setPct] = useState("50");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  if (!members.length) return <p className="text-sm text-ink-2">Nobody else uses this wallet yet. Members you add in Settings can be given a share of it.</p>;
  return (
    <div className="space-y-3 text-sm">
      {shares.length > 0 && (
        <ul className="divide-y divide-border">
          {shares.map((s) => (
            <li key={s.userId} className="flex items-center justify-between py-1.5">
              <span>
                {s.name} <span className="text-muted">· their share {+s.sharePct.toFixed(2)}% · {s.role === "edit" ? "can record balances" : "view only"}</span>
              </span>
              <Button size="sm" variant="ghost" aria-label={`Stop sharing with ${s.name}`} disabled={pending} onClick={() => start(async () => setMsg(await unshareAccountAction(accountId, s.userId).then((r) => ({ ok: r.ok, text: r.message }))))}>
                <X size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await shareAccountAction(accountId, member, role, Number(pct));
              setMsg({ ok: r.ok, text: r.message });
            });
          }}
        >
          <Field label="With" className="w-40">
            <Select value={member} onChange={(e) => setMember(e.target.value)}>
              {available.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Their share (%)" className="w-28">
            <Input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
          </Field>
          <Field label="They can" className="w-44">
            <Select value={role} onChange={(e) => setRole(e.target.value as "view" | "edit")}>
              <option value="view">see it</option>
              <option value="edit">see it and record balances</option>
            </Select>
          </Field>
          <Button type="submit" disabled={pending || !member}>
            Share
          </Button>
        </form>
      )}
      {msg && <p className={msg.ok ? "text-good-text" : "text-critical-text"}>{msg.text}</p>}
    </div>
  );
}
