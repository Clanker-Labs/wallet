"use client";

import { useRef, useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { useFormat } from "./format";

/**
 * Click-to-edit amount bound to a server action. Submits a FormData with
 * `amount` plus any `hidden` fields; Enter saves, Escape cancels. With
 * `currencies`, the editor also picks the amount's currency (field `currency`).
 */
export function InlineAmount({
  cents,
  action,
  hidden,
  placeholder = "Set",
  currency,
  currencies,
}: {
  cents: number | null;
  action: (fd: FormData) => Promise<void>;
  hidden: Record<string, string | number>;
  placeholder?: string;
  /** Currency the amount is in (default: the base currency). */
  currency?: string;
  currencies?: string[];
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
        <span className="tabular">{cents === null ? placeholder : f.money(cents, { whole: true, ...(currency ? { currency } : {}) })}</span>
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
        // Leaving for the currency picker of the same form is not "done editing".
        onBlur={(e) => !e.currentTarget.form?.contains(e.relatedTarget as Node | null) && e.currentTarget.form?.requestSubmit()}
        className="tabular h-7 w-24 rounded-md border border-accent bg-surface px-2 text-right text-sm focus:outline-none"
        placeholder="0"
      />
      {currencies && currencies.length > 1 && (
        <select
          name="currency"
          defaultValue={currency ?? f.currency}
          aria-label="Currency"
          onBlur={(e) => !e.currentTarget.form?.contains(e.relatedTarget as Node | null) && e.currentTarget.form?.requestSubmit()}
          className="h-7 rounded-md border border-border bg-surface px-1 text-xs"
        >
          {currencies.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      )}
    </form>
  );
}
