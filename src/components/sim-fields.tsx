"use client";

import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { z } from "zod";
import { parseAmount } from "@/lib/money";
import { useFormat } from "./format";

/*
 * Input building blocks for the simulators. Numbers are typed as free text
 * ("450k", "1 234,56") and parsed with parseAmount; the parent only ever sees
 * numbers (or undefined while the field is empty).
 */

export type Num = number | undefined;
export type NumState<K extends string> = Record<K, Num>;
export type FieldErrors = Record<string, string>;

function parseText(text: string): Num {
  const n = parseAmount(text);
  return n === null ? undefined : n;
}

/** Locale-formatted number, but only if it parses back to the same value. */
function display(value: Num, locale: string, group: boolean): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  try {
    const s = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, useGrouping: group }).format(value);
    if (parseAmount(s) === value) return s;
  } catch {}
  return String(value);
}

export function NumberInput({
  id,
  value,
  onChange,
  suffix,
  group = false,
  invalid,
  placeholder,
  className,
  ariaLabel,
}: {
  id?: string;
  value: Num;
  onChange: (v: Num) => void;
  suffix?: string;
  /** Money: thousands separators when not focused. */
  group?: boolean;
  invalid?: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const { locale } = useFormat();
  const [text, setText] = useState(() => display(value, locale, group));
  const [prev, setPrev] = useState(value);
  // Value changed from outside (loaded scenario, preset): show it.
  if (value !== prev) {
    setPrev(value);
    if (parseText(text) !== value) setText(display(value, locale, group));
  }
  return (
    <div className={clsx("relative", className)}>
      <input
        id={id}
        aria-label={ariaLabel}
        inputMode="decimal"
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseText(e.target.value);
          setPrev(v);
          onChange(v);
        }}
        onBlur={() => value !== undefined && setText(display(value, locale, group))}
        onFocus={(e) => e.currentTarget.select()}
        className={clsx(
          "tabular h-9 w-full rounded-lg border bg-surface px-3 text-sm text-ink placeholder:text-muted focus:outline-none",
          suffix && "pr-11",
          invalid ? "border-critical focus:border-critical" : "border-border focus:border-accent",
        )}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">{suffix}</span>
      )}
    </div>
  );
}

export function NumField({
  label,
  value,
  onChange,
  suffix,
  group,
  hint,
  error,
  aside,
  placeholder,
  className,
  children,
}: {
  label: string;
  value: Num;
  onChange: (v: Num) => void;
  suffix?: string;
  group?: boolean;
  hint?: ReactNode;
  error?: string;
  /** Right of the label (e.g. "from your data"). */
  aside?: ReactNode;
  placeholder?: string;
  className?: string;
  /** Extra controls under the input (quick-pick chips). */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={clsx("min-w-0", className)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={id} className="truncate text-xs font-medium text-ink-2">
          {label}
        </label>
        {aside}
      </div>
      <NumberInput id={id} value={value} onChange={onChange} suffix={suffix} group={group} invalid={!!error} placeholder={placeholder} />
      {children}
      {error ? (
        <p className="mt-1 text-xs text-critical-text">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** Row of tiny quick-pick buttons under a field. */
export function Chips<T extends number | string>({
  options,
  value,
  onPick,
  format = (v) => String(v),
}: {
  options: T[];
  value: unknown;
  onPick: (v: T) => void;
  format?: (v: T) => string;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          onClick={() => onPick(o)}
          className={clsx(
            "h-6 rounded-md px-2 text-xs font-medium transition",
            o === value ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2 hover:text-ink",
          )}
        >
          {format(o)}
        </button>
      ))}
    </div>
  );
}

/** "from your data" marker, with a one-click reset when the value was changed. */
export function DataHint({ current, data, onReset, format }: { current: Num; data: number; onReset: () => void; format: (n: number) => string }) {
  const same = current !== undefined && Math.abs(current - data) < 0.005;
  if (same) return <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-px text-[11px] font-medium text-accent">from your data</span>;
  return (
    <button type="button" onClick={onReset} className="shrink-0 text-[11px] font-medium text-accent hover:underline" title="Use the value computed from your data">
      use mine: {format(data)}
    </button>
  );
}

/** Collapsible "Advanced" block (native <details>, keyboard friendly). */
export function Advanced({ children, count, open }: { children: ReactNode; count?: number; open?: boolean }) {
  return (
    <details className="group mt-4 border-t border-border pt-3" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-2 select-none hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} className="transition group-open:rotate-90" />
        Advanced{count ? <span className="text-muted"> · {count} settings</span> : null}
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-3">{children}</div>
    </details>
  );
}

/** Field-level messages from a zod issue list, in plain words. */
export function issuesToErrors(issues: z.core.$ZodIssue[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const key = i.path.map(String).join(".");
    if (out[key]) continue;
    let msg = i.message;
    if (i.code === "too_small") {
      const min = Number(i.minimum);
      msg = i.inclusive ? `At least ${min}` : min === 0 ? "Must be above 0" : `Must be above ${min}`;
    } else if (i.code === "too_big") msg = `At most ${Number(i.maximum)}`;
    else if (i.code === "invalid_type") msg = i.expected === "int" ? "Whole number" : "Required";
    out[key] = msg;
  }
  return out;
}

/** Debounced copy of a value (Monte Carlo runs on this, typing stays smooth). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Keep showing the last valid result while an input is temporarily invalid. */
export function useLastValid<T>(value: T | null): { value: T | null; stale: boolean } {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return { value: value ?? last, stale: value === null && last !== null };
}

/** The user's currency symbol ("€", "$", "CHF"). */
export function useCurrencySymbol(): string {
  const { locale, currency } = useFormat();
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

/** "3.3 %" in the user's locale. */
export function fmtPct(locale: string, value: number, digits = 1): string {
  try {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits }).format(value / 100);
  } catch {
    return `${value.toFixed(digits)}%`;
  }
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">{children}</div>;
}
