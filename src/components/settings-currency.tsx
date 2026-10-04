"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { refreshRatesAction, type RefreshRatesResult } from "@/app/settings/actions";
import { Button } from "./ui";

/** "Refresh rates now": downloads today's rates, and says so plainly when the providers can't be reached. */
export function RefreshRatesButton() {
  const [result, setResult] = useState<RefreshRatesResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="min-w-0 space-y-2">
      <Button
        size="sm"
        onClick={() =>
          start(async () => {
            setResult(null);
            try {
              setResult(await refreshRatesAction());
            } catch {
              setResult({ ok: false, error: "The refresh request failed — is the app still running?", date: null });
            }
          })
        }
        disabled={pending}
      >
        <RefreshCw size={14} className={pending ? "animate-spin" : undefined} aria-hidden />
        {pending ? "Refreshing…" : "Refresh rates now"}
      </Button>
      <div role="status" aria-live="polite">
        {result?.ok && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-good-text">
            <Check size={13} aria-hidden /> {result.message}
          </p>
        )}
        {result && !result.ok && (
          <div className="flex max-w-xl gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
            <AlertTriangle size={14} className="mt-px shrink-0 text-critical-text" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium text-ink">{result.error}</p>
              {result.details && <p className="mt-0.5 [overflow-wrap:anywhere] text-muted">{result.details}</p>}
              <p className="mt-0.5 text-ink-2">Nothing breaks: amounts keep converting with the stored rates. Try again once you’re online.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
