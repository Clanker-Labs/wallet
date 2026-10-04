"use client";

import { useRef, useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { useFormat } from "./format";

/**
 * Click-to-edit amount bound to a server action. Submits a FormData with
 * `amount` plus any `hidden` fields; Enter saves, Escape cancels.
 */
export function InlineAmount({
  cents,
  action,
  hidden,
  placeholder = "Set",
}: {
  cents: number | null;
  action: (fd: FormData) => Promise<void>;
  hidden: Record<string, string | number>;
  placeholder?: string;
}) {
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink"
        disabled={pending}
      >
        <span className="tabular">{cents === null ? placeholder : f.money(cents, { whole: true })}</span>
        <Pencil size={12} className="opacity-0 transition group-hover:opacity-100" />
      </button>
    );
  }
  return (
    <form
      action={(fd) => {
        for (const [k, v] of Object.entries(hidden)) fd.set(k, String(v));
        start(async () => {
          await action(fd);
          setEditing(false);
        });
      }}
      className="inline-flex items-center gap-1"
    >
      <input
        ref={ref}
        name="amount"
        autoFocus
        inputMode="decimal"
        defaultValue={cents === null ? "" : String(cents / 100)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        onBlur={(e) => e.currentTarget.form?.requestSubmit()}
        className="tabular h-7 w-24 rounded-md border border-accent bg-surface px-2 text-right text-sm focus:outline-none"
        placeholder="0"
      />
    </form>
  );
}
