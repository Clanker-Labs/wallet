import clsx from "clsx";
import { useId } from "react";

/**
 * wallet brand mark: an indigo rounded square holding a "w" whose last stroke
 * climbs past the first and ends in a gold point — a letter and a rising line
 * in one. Fixed colors (not theme tokens) so the mark is identical everywhere,
 * like public/icon.svg. Below 24px the stroke thickens and the sheen drops so
 * it still reads at favicon size.
 */

/** Mark geometry shared with public/icon.svg and the PNG app icons (64×64 grid). */
export const MARK = {
  path: "M14 23 L22.5 42 L32 28 L41.5 42 L50 19",
  dot: { cx: 50, cy: 19, r: 4.6 },
  from: "#7f75ff",
  mid: "#5b4fe9",
  to: "#3b30c4",
  gold: "#f5c451",
} as const;

export function LogoMark({ size = 28, className, title }: { size?: number; className?: string; title?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const small = size < 24;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={clsx("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="6" y1="2" x2="58" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={MARK.from} />
          <stop offset="0.55" stopColor={MARK.mid} />
          <stop offset="1" stopColor={MARK.to} />
        </linearGradient>
        {!small && (
          <radialGradient id={`${id}-sheen`} cx="14" cy="4" r="46" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.26" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        )}
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id}-bg)`} />
      {!small && <rect width="64" height="64" rx="15" fill={`url(#${id}-sheen)`} />}
      <path
        d={MARK.path}
        fill="none"
        stroke="#ffffff"
        strokeWidth={small ? 7.6 : 6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={MARK.dot.cx} cy={MARK.dot.cy} r={small ? MARK.dot.r + 0.8 : MARK.dot.r} fill={MARK.gold} />
    </svg>
  );
}

/** Mark + lowercase "wallet". `size` is the mark size; the text scales with it. */
export function Wordmark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center font-semibold tracking-tight text-ink", className)} style={{ gap: size * 0.32 }}>
      <LogoMark size={size} />
      <span style={{ fontSize: Math.round(size * 0.64), lineHeight: 1, letterSpacing: "-0.025em" }}>wallet</span>
    </span>
  );
}
