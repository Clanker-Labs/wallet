import type { ReactNode } from "react";
import { Wordmark } from "./brand";

/** Faint hairline grid behind the card, fading out from the top glow. */
const GRID_STYLE = {
  backgroundImage: "linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px)",
  backgroundSize: "44px 44px",
  backgroundPosition: "center -1px",
  maskImage: "radial-gradient(70% 55% at 50% 0%, #000 0%, transparent 100%)",
  WebkitMaskImage: "radial-gradient(70% 55% at 50% 0%, #000 0%, transparent 100%)",
} as const;

/**
 * Full-screen branded layout for sign-in / sign-up / onboarding pages (rendered
 * outside the app chrome — see BARE_PREFIXES in app-shell). Mobile-first: the
 * card sits near the top on phones and centers vertically from `sm` up.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="relative isolate flex min-h-dvh flex-col items-center overflow-hidden bg-auth px-4 pt-[max(3.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:justify-center sm:py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 opacity-70" style={GRID_STYLE} />

      <div className="w-full max-w-[400px]">
        <header className="mb-8 flex flex-col items-center text-center">
          <Wordmark size={40} />
          <p className="mt-4 max-w-[34ch] text-sm leading-relaxed text-balance text-ink-2">
            Your net worth, budgets and investments{"\u00a0"}— private, on your own machine.
          </p>
        </header>

        <section className="relative rounded-2xl border border-border bg-surface p-6 shadow-pop sm:p-7">
          <div
            aria-hidden
            className="absolute inset-x-8 -top-px h-px"
            style={{ background: "linear-gradient(90deg, transparent, var(--brand), var(--brand-2), transparent)" }}
          />
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <div className="mt-1.5 text-sm leading-relaxed text-ink-2">{subtitle}</div>}
          <div className="mt-6">{children}</div>
        </section>

        {footer && <div className="mt-6 text-center text-sm text-ink-2">{footer}</div>}
      </div>
    </main>
  );
}
