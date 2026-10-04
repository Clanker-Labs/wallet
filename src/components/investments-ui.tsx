"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Check, RefreshCw, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui";
import { refreshPricesAction, type RefreshResult } from "@/app/investments/actions";

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One reason for all failures ("offline") reads better than a list. */
function commonReason(failed: RefreshResult["failed"]): string | null {
  const reasons = new Set(failed.map((f) => f.error));
  return reasons.size === 1 ? [...reasons][0] : null;
}

function ResultLine({ result, onClose }: { result: RefreshResult | { error: string }; onClose: () => void }) {
  let tone: "good" | "warn" = "good";
  let body: ReactNode;
  if ("error" in result) {
    tone = "warn";
    body = <>Couldn’t refresh prices: {result.error}. The last known prices are kept.</>;
  } else if (result.total === 0) {
    body = <>Nothing to refresh: positions without a symbol use their manual price.</>;
  } else if (result.failed.length === 0) {
    body = <>{plural(result.updated.length, "price")} updated just now.</>;
  } else {
    tone = "warn";
    const reason = commonReason(result.failed);
    const lead =
      result.updated.length === 0
        ? `Couldn’t refresh any of your ${plural(result.failed.length, "price")}`
        : `${result.updated.length} updated, ${result.failed.length} couldn’t be refreshed`;
    body = (
      <>
        {lead}
        {reason ? `: ${reason}.` : "."} The last known prices are kept.
        {!reason || result.failed.length <= 4 ? (
          <span className="mt-1 block text-xs text-muted">
            {result.failed.map((f) => (reason ? f.symbol : `${f.symbol} (${f.error})`)).join(" · ")}
          </span>
        ) : (
          <details className="mt-1 text-xs text-muted">
            <summary className="cursor-pointer select-none hover:text-ink-2">Which ones</summary>
            {result.failed.map((f) => f.symbol).join(" · ")}
          </details>
        )}
      </>
    );
  }
  return (
    <div
      role="status"
      className="mt-3 flex items-start gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-ink-2"
    >
      {tone === "good" ? (
        <Check size={16} className="mt-0.5 shrink-0 text-good-text" aria-hidden />
      ) : (
        <TriangleAlert size={16} className="mt-0.5 shrink-0 text-ink" aria-hidden />
      )}
      <div className="min-w-0 flex-1">{body}</div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="-my-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * Price status line + "Refresh prices": fetches every held symbol now and
 * re-values holdings accounts. Offline, it says so and keeps the last prices.
 */
export function PriceRefresh({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<RefreshResult | { error: string } | null>(null);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 text-sm text-ink-2">{children}</div>
        <Button
          size="sm"
          disabled={pending || disabled}
          onClick={() =>
            start(async () => {
              setResult(null);
              try {
                setResult(await refreshPricesAction());
              } catch {
                setResult({ error: "the server didn’t answer" });
              }
            })
          }
        >
          <RefreshCw size={14} className={pending ? "animate-spin" : undefined} aria-hidden />
          {pending ? "Refreshing…" : "Refresh prices"}
        </Button>
      </div>
      {result && <ResultLine result={result} onClose={() => setResult(null)} />}
    </div>
  );
}
