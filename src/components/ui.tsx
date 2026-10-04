import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * Small, server-safe UI primitives. Visual language: quiet surfaces, hairline
 * borders, one accent color; data is the only loud thing on the page.
 */

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section className={clsx("rounded-2xl border border-border bg-surface p-5 shadow-card", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const buttonStyles = {
  primary: "bg-accent text-accent-ink hover:opacity-90",
  secondary: "border border-border bg-surface hover:bg-surface-2",
  ghost: "hover:bg-surface-2 text-ink-2",
  danger: "border border-border text-critical-text hover:bg-surface-2",
} as const;

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ComponentProps<"button"> & { variant?: keyof typeof buttonStyles; size?: "sm" | "md" }) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        buttonStyles[variant],
        className,
      )}
      {...rest}
    />
  );
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: keyof typeof buttonStyles; size?: "sm" | "md" }) {
  return (
    <Link
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        buttonStyles[variant],
        className,
      )}
      {...rest}
    />
  );
}

const fieldBase =
  "h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={clsx(fieldBase, className)} {...rest} />;
}

export function Select({ className, ...rest }: ComponentProps<"select">) {
  return <select className={clsx(fieldBase, "pr-8", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={clsx(fieldBase, "h-auto py-2", className)} {...rest} />;
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warning" | "critical" | "accent"; children: ReactNode }) {
  const tones = {
    neutral: "bg-surface-2 text-ink-2",
    good: "bg-surface-2 text-good-text",
    warning: "bg-surface-2 text-ink",
    critical: "bg-surface-2 text-critical-text",
    accent: "bg-surface-2 text-accent",
  };
  const dot = { neutral: null, good: "bg-good", warning: "bg-warning", critical: "bg-critical", accent: "bg-accent" }[tone];
  return (
    <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>
      {dot && <span className={clsx("h-1.5 w-1.5 rounded-full", dot)} aria-hidden />}
      {children}
    </span>
  );
}

/** Stat tile: label · value · optional delta line. */
export function Stat({ label, value, delta, className }: { label: string; value: ReactNode; delta?: ReactNode; className?: string }) {
  return (
    <div className={clsx("min-w-0", className)}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 truncate text-xl font-semibold">{value}</div>
      {delta && <div className="mt-0.5 text-xs">{delta}</div>}
    </div>
  );
}

/** Signed change with direction arrow; up is good unless `invert`. */
export function Delta({ value, children, invert = false }: { value: number; children: ReactNode; invert?: boolean }) {
  const good = invert ? value < 0 : value > 0;
  const tone = value === 0 ? "text-muted" : good ? "text-good-text" : "text-critical-text";
  return (
    <span className={clsx("tabular font-medium", tone)}>
      {value > 0 ? "▲" : value < 0 ? "▼" : "•"} {children}
    </span>
  );
}

/**
 * Meter: the fill carries severity; the track is a lighter step of the same hue.
 * `pace` (0–1) draws a hairline marking where spending "should" be today.
 */
export function Meter({ pct, status, pace }: { pct: number; status: "ok" | "ahead_of_pace" | "over"; pace?: number }) {
  const fill = status === "over" ? "var(--critical)" : status === "ahead_of_pace" ? "var(--warning)" : "var(--accent)";
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--series-1-track)" }}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: fill }} />
      {pace !== undefined && pace > 0 && pace < 1 && (
        <div className="absolute top-0 h-full w-px bg-ink opacity-50" style={{ left: `${pace * 100}%` }} title="Today" />
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function SeriesDot({ slot }: { slot: number }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: `var(--series-${slot})` }} aria-hidden />;
}
