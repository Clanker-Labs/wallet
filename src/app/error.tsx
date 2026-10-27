"use client";

import { useEffect } from "react";
import { RotateCcw } from "lucide-react";

/**
 * Shown when a page throws: the app's own shell and words instead of the
 * framework's default screen. The digest matches the server log line.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-md pt-20 text-center">
      <h1 className="text-lg font-semibold">This page hit a problem</h1>
      <p className="mt-2 text-sm text-ink-2">
        Your data is fine — nothing was saved halfway. Try again; if it keeps happening, the server log has the details
        {error.digest ? (
          <>
            {" "}
            under <code className="rounded bg-surface-2 px-1">{error.digest}</code>
          </>
        ) : null}
        .
      </p>
      <button
        onClick={reset}
        className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-ink"
      >
        <RotateCcw size={14} /> Try again
      </button>
    </div>
  );
}
