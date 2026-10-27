"use client";

import { useEffect, useRef, useState } from "react";
import { useFormat } from "./format";
import type { MoneyFormat } from "@/lib/money";

/**
 * A money figure that counts up to its value once, when it first appears
 * (600 ms, easing out). Screen readers and reduced-motion users get the final
 * value straight away.
 */
export function CountUp({ cents, opts = {}, className }: { cents: number; opts?: MoneyFormat; className?: string }) {
  const f = useFormat();
  const [shown, setShown] = useState(cents);
  const first = useRef(true);
  useEffect(() => {
    if (!first.current || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(cents);
      return;
    }
    first.current = false;
    const start = performance.now();
    const from = cents * 0.92;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 600);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(from + (cents - from) * eased));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [cents]);
  return (
    <span className={className}>
      <span aria-hidden>{f.money(shown, opts)}</span>
      <span className="sr-only">{f.money(cents, opts)}</span>
    </span>
  );
}
