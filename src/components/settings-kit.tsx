"use client";

import clsx from "clsx";
import { Check, Copy, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/*
 * Small client widgets shared by the simulations, reminders and settings pages:
 * a segmented control, a two-step delete button, a copy button and a flash line.
 */

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={clsx("inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-surface-2 p-0.5", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={clsx(
              "rounded-md font-medium transition",
              size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm",
              active ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Delete-style button that asks for a second click ("Sure?") before acting. */
export function ConfirmButton({
  onConfirm,
  label = "Delete",
  confirmLabel = "Click again to delete",
  disabled,
  iconOnly = false,
  title,
}: {
  onConfirm: () => void;
  label?: string;
  confirmLabel?: string;
  disabled?: boolean;
  iconOnly?: boolean;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      disabled={disabled}
      title={armed ? undefined : (title ?? label)}
      aria-label={armed ? confirmLabel : (title ?? label)}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      onBlur={() => setArmed(false)}
      className={clsx(
        "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50",
        armed
          ? "border border-critical bg-surface px-2.5 text-critical-text"
          : clsx("text-muted hover:bg-surface-2 hover:text-critical-text", iconOnly ? "w-8" : "px-2.5"),
      )}
    >
      <Trash2 size={14} aria-hidden />
      {armed ? confirmLabel : iconOnly ? null : label}
    </button>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // Clipboard blocked (http, permissions): select-and-copy still works.
        }
      }}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-2 hover:bg-surface hover:text-ink"
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <Check size={13} className="text-good-text" /> : <Copy size={13} />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** A code snippet with a copy button. */
export function Snippet({ code, label }: { code: string; label?: string }) {
  return (
    <div className="min-w-0">
      {label && <div className="mb-1 text-xs font-medium text-ink-2">{label}</div>}
      <div className="flex items-start gap-1 rounded-lg bg-surface-2 py-1 pr-1 pl-3">
        <pre className="min-w-0 flex-1 py-1 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{code}</pre>
        <CopyButton text={code} />
      </div>
    </div>
  );
}

export interface FlashMessage {
  tone: "good" | "critical";
  text: string;
}

/** Short-lived confirmation line ("Saved ✓"). */
export function useFlash(ms = 3500) {
  const [flash, setFlash] = useState<FlashMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(
    (tone: FlashMessage["tone"], text: string) => {
      if (timer.current) clearTimeout(timer.current);
      setFlash({ tone, text });
      timer.current = setTimeout(() => setFlash(null), ms);
    },
    [ms],
  );
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return [flash, show] as const;
}

export function Flash({ flash, className }: { flash: FlashMessage | null; className?: string }) {
  return (
    <span role="status" aria-live="polite" className={clsx("text-xs font-medium", className)}>
      {flash && (
        <span className={flash.tone === "good" ? "text-good-text" : "text-critical-text"}>
          {flash.tone === "good" ? "✓ " : "⚠ "}
          {flash.text}
        </span>
      )}
    </span>
  );
}
