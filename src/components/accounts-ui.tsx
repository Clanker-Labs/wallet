"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Check, ChevronDown, Trash2 } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import { InlineAmount } from "@/components/inline-amount";
import {
  deleteAccountAction,
  quickRecordBalance,
  recordBalanceAction,
  type AccountActionState,
} from "@/app/accounts/actions";

/** Flip back to false `ms` after being set to true (for "Saved ✓" flashes and armed confirms). */
function useFlash(ms: number): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return [on, setOn];
}

function focusFirstField(root: HTMLElement) {
  const el =
    root.querySelector<HTMLElement>("[data-autofocus]") ??
    root.querySelector<HTMLElement>("input:not([type=hidden]):not([type=radio]), select, textarea");
  el?.focus();
}

/**
 * Native <details> with a styled summary. When opened, focuses the first field
 * inside so you can start typing right away.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  focusOnOpen = true,
  className,
  summaryClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  focusOnOpen?: boolean;
  className?: string;
  summaryClassName?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  // Opened from the URL (e.g. ?add=1): the native toggle event fires before hydration, so focus on mount.
  useEffect(() => {
    if (defaultOpen && focusOnOpen && ref.current?.open) focusFirstField(ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <details
      ref={ref}
      open={defaultOpen || undefined}
      onToggle={(e) => {
        if (focusOnOpen && e.currentTarget.open) focusFirstField(e.currentTarget);
      }}
      className={clsx("group", className)}
    >
      <summary
        className={clsx(
          "flex cursor-pointer list-none items-center gap-2 rounded-lg select-none [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        {summary}
        <ChevronDown size={16} className="ml-auto shrink-0 text-muted transition group-open:rotate-180" aria-hidden />
      </summary>
      {children}
    </details>
  );
}

/** One-click balance update for the accounts list: click "Update", type, Enter. */
export function BalanceUpdater({ accountId, label = "Update" }: { accountId: number; label?: string }) {
  const [saved, setSaved] = useFlash(2500);
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-md border border-border text-sm has-[input]:border-transparent",
        saved && "border-transparent [&_.tabular]:text-good-text",
      )}
    >
      <InlineAmount
        cents={null}
        placeholder={saved ? "Saved ✓" : label}
        hidden={{ accountId }}
        action={async (fd) => {
          if (await quickRecordBalance(fd)) setSaved(true);
        }}
      />
    </span>
  );
}

/** Balance + date + note form on the account page. */
export function RecordBalanceForm({ accountId, today, liability }: { accountId: number; today: string; liability: boolean }) {
  const [state, setState] = useState<AccountActionState | null>(null);
  const [key, setKey] = useState(0);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!state?.ok) return;
    const t = setTimeout(() => setState(null), 4000);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <div>
      <form
        key={key}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          start(async () => {
            const res = await recordBalanceAction(fd);
            setState(res);
            if (res.ok) setKey((k) => k + 1);
          });
        }}
        className="grid items-end gap-3 text-sm sm:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1fr)_auto]"
      >
        <input type="hidden" name="accountId" value={accountId} />
        <Field label={liability ? "Amount still owed" : "New balance"}>
          <Input name="amount" inputMode="decimal" required placeholder="1 234,56" autoComplete="off" />
        </Field>
        <Field label="Date">
          <Input type="date" name="date" defaultValue={today} max={today} required />
        </Field>
        <Field label="Note">
          <Input name="note" placeholder="Optional" maxLength={500} autoComplete="off" />
        </Field>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Save balance"}
        </Button>
      </form>
      <p aria-live="polite" className="mt-2 min-h-5 text-sm">
        {state &&
          (state.ok ? (
            <span className="inline-flex items-center gap-1 text-good-text">
              <Check size={14} /> Balance saved
            </span>
          ) : (
            <span className="text-critical-text">{state.message}</span>
          ))}
      </p>
    </div>
  );
}

/**
 * Two-step delete: the first click arms the button ("Delete?"), the second
 * submits. Disarms itself after a few seconds.
 */
export function ConfirmButton({
  action,
  fields,
  title = "Delete",
  confirmText = "Delete?",
}: {
  action: (fd: FormData) => Promise<unknown>;
  fields: Record<string, string | number>;
  title?: string;
  confirmText?: string;
}) {
  const [armed, setArmed] = useFlash(4000);
  const [pending, start] = useTransition();
  return (
    <form
      action={(fd) =>
        start(async () => {
          await action(fd);
          setArmed(false);
        })
      }
      className="inline-flex"
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {armed || pending ? (
        <button
          key="confirm"
          type="submit"
          autoFocus
          disabled={pending}
          onBlur={() => !pending && setArmed(false)}
          className="h-7 rounded-md bg-surface-2 px-2 text-xs font-medium whitespace-nowrap text-critical-text hover:opacity-80"
        >
          {pending ? "Deleting…" : confirmText}
        </button>
      ) : (
        <button
          key="arm"
          type="button"
          onClick={() => setArmed(true)}
          title={title}
          aria-label={title}
          className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-critical-text"
        >
          <Trash2 size={14} />
        </button>
      )}
    </form>
  );
}

/** Account deletion needs an explicit tick before the button unlocks. */
export function DeleteAccountForm({ id, name, snapshotCount }: { id: number; name: string; snapshotCount: number }) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, start] = useTransition();
  return (
    <form action={(fd) => start(() => deleteAccountAction(fd))} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <label className="flex items-start gap-2 text-sm text-ink-2">
        <input
          type="checkbox"
          name="confirm"
          value="yes"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-accent"
        />
        <span>
          Yes, delete “{name}”
          {snapshotCount > 0 && ` and its ${snapshotCount} balance record${snapshotCount === 1 ? "" : "s"}`}. Its transactions
          are kept, without an account.
        </span>
      </label>
      <Button type="submit" variant="danger" disabled={!confirmed || pending}>
        <Trash2 size={14} /> {pending ? "Deleting…" : "Delete forever"}
      </Button>
    </form>
  );
}
