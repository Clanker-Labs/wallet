import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * Small, server-safe UI primitives. Visual language: quiet surfaces, hairline
 * borders, one accent color; data is the only loud thing on the page.
 */

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: string; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 md:mb-8">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">{eyebrow}</div>}
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.025em] md:text-[2rem]">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-3xl text-sm text-ink-2 md:text-[0.9375rem]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section className={clsx("rounded-2xl border border-border bg-surface p-5 shadow-card md:p-6", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[0.9375rem] font-semibold tracking-[-0.01em]">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted md:text-[0.8125rem]">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const buttonStyles = {
  primary: "bg-brand-gradient text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_6px_16px_-8px_var(--glow)] hover:brightness-105 active:translate-y-px",
  secondary: "border border-border bg-surface shadow-[0_1px_2px_rgba(16,24,48,0.04)] hover:border-border-strong hover:bg-surface-2",
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
        "inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm",
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
        "inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition",
        size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm",
        buttonStyles[variant],
        className,
      )}
      {...rest}
    />
  );
}

const fieldBase =
  "h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-ink shadow-[0_1px_2px_rgba(16,24,48,0.03)] transition placeholder:text-muted hover:border-border-strong focus:border-accent focus:ring-4 focus:ring-[var(--brand-tint)] focus:outline-none";

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
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="tabular mt-1 truncate text-xl font-semibold tracking-[-0.02em] md:text-2xl">{value}</div>
      {delta && <div className="mt-1 text-xs">{delta}</div>}
    </div>
  );
}

/** Signed change with direction arrow; up is good unless `invert`. `pill` sets it on a tinted wash. */
export function Delta({ value, children, invert = false, pill = false }: { value: number; children: ReactNode; invert?: boolean; pill?: boolean }) {
  const good = invert ? value < 0 : value > 0;
  if (pill) {
    return (
      <span className={value === 0 ? "pill-flat" : good ? "pill-gain" : "pill-loss"}>
        <span aria-hidden className="text-[0.7em]">{value > 0 ? "▲" : value < 0 ? "▼" : "•"}</span> {children}
      </span>
    );
  }
  const tone = value === 0 ? "text-muted" : good ? "text-good-text" : "text-critical-text";
  return (
    <span className={clsx("tabular font-medium", tone)}>
      {value > 0 ? "▲" : value < 0 ? "▼" : "•"} {children}
    </span>
  );
}

/** A compact metric tile: icon, label, big figure, an optional foot (delta, sparkline). */
export function KpiTile({ icon, label, value, foot, href, className }: { icon?: ReactNode; label: string; value: ReactNode; foot?: ReactNode; href?: string; className?: string }) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        {icon && <span className="grid h-6 w-6 place-items-center rounded-lg bg-surface-2 text-ink-2">{icon}</span>}
        {label}
      </div>
      <div className="tabular mt-2.5 truncate text-xl font-semibold tracking-[-0.02em] md:text-[1.375rem]">{value}</div>
      {foot && <div className="mt-1.5 min-h-5 text-xs">{foot}</div>}
    </>
  );
  const cls = clsx("block min-w-0 rounded-2xl border border-border bg-surface p-4 shadow-card md:p-5", href && "card-link", className);
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
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
      <div
        className="animate-grow h-full rounded-full"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: fill }}
      />
      {pace !== undefined && pace > 0 && pace < 1 && (
        <div className="absolute top-0 h-full w-px bg-ink opacity-50" style={{ left: `${pace * 100}%` }} title="Today" />
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface/50 px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function SeriesDot({ slot }: { slot: number }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: `var(--series-${slot})` }} aria-hidden />;
}

/** Sub-page tabs (Holdings · Analytics · Activity): links, the current one marked. */
export function ViewTabs({ tabs, current, label }: { tabs: { href: string; label: string }[]; current: string; label: string }) {
  return (
    <nav className="inline-flex gap-0.5 rounded-xl border border-border bg-surface-2/70 p-0.5 text-sm" aria-label={label}>
      {tabs.map((t) =>
        t.href === current ? (
          <span key={t.href} className="rounded-[0.6rem] bg-surface px-3.5 py-1.5 font-medium text-ink shadow-[0_1px_2px_rgba(16,24,48,0.08)]" aria-current="page">
            {t.label}
          </span>
        ) : (
          <Link key={t.href} href={t.href} className="rounded-[0.6rem] px-3.5 py-1.5 text-muted transition hover:text-ink">
            {t.label}
          </Link>
        ),
      )}
    </nav>
  );
}
