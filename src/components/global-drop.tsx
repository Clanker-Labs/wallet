"use client";

import clsx from "clsx";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, CloudUpload, Loader2, X } from "lucide-react";
import {
  formatBytes,
  guessKind,
  isAbort,
  KindIcon,
  MAX_ATTACHMENTS,
  type UploadedFile,
  type UploadKind,
  uploadFile,
  useWindowFileDrop,
} from "./assistant-uploads";

/**
 * App-wide drop target: files dragged anywhere in the app are uploaded and
 * handed to the assistant (/assistant?attach=<ids>), which starts importing
 * them right away. The assistant page has its own drop zone; auth pages have none.
 */

const SKIP_PREFIXES = ["/assistant", "/login", "/signup", "/welcome"];

interface JobFile {
  name: string;
  size: number;
  kind: UploadKind | null;
  status: "uploading" | "done" | "error";
  progress: number;
  error?: string;
}

interface Notice {
  failed: { name: string; error: string }[];
  attached: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function GlobalDrop() {
  const pathname = usePathname();
  const router = useRouter();
  const skip = SKIP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const [job, setJob] = useState<JobFile[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [status, setStatus] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const onFiles = useCallback(
    async (files: File[]) => {
      if (abortRef.current) return; // already uploading a batch
      const controller = new AbortController();
      abortRef.current = controller;
      setNotice(null);
      setJob(
        files.map((f, i) => ({
          name: f.name,
          size: f.size,
          kind: guessKind(f.name, f.type),
          progress: 0,
          ...(i < MAX_ATTACHMENTS
            ? { status: "uploading" as const }
            : { status: "error" as const, error: `Up to ${MAX_ATTACHMENTS} files at a time` }),
        })),
      );
      setStatus(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}`);
      const update = (i: number, p: Partial<JobFile>) =>
        setJob((j) => j && j.map((f, k) => (k === i ? { ...f, ...p } : f)));

      const results = await Promise.allSettled(
        files.map((file, i) =>
          i >= MAX_ATTACHMENTS
            ? Promise.reject(new Error(`Up to ${MAX_ATTACHMENTS} files at a time`))
            : uploadFile(file, { signal: controller.signal, onProgress: (progress) => update(i, { progress }) }).then(
                (u) => {
                  update(i, { status: "done", progress: 1 });
                  return u;
                },
                (e: unknown) => {
                  update(i, { status: "error", error: message(e) });
                  throw e;
                },
              ),
        ),
      );
      abortRef.current = null;
      setJob(null);
      if (controller.signal.aborted) {
        setStatus("Upload cancelled");
        return;
      }

      const uploaded = results.flatMap((r) => (r.status === "fulfilled" ? [r.value as UploadedFile] : []));
      const failed = results.flatMap((r, i) =>
        r.status === "rejected" && !isAbort(r.reason) ? [{ name: files[i].name, error: message(r.reason) }] : [],
      );
      if (failed.length) setNotice({ failed, attached: uploaded.length });
      if (uploaded.length) {
        setStatus("Opening the assistant");
        router.push(`/assistant?attach=${uploaded.map((u) => encodeURIComponent(u.id)).join(",")}`);
      } else {
        setStatus(`Upload failed: ${failed.map((f) => `${f.name}: ${f.error}`).join("; ")}`);
      }
    },
    [router],
  );

  const dragging = useWindowFileDrop(onFiles, !skip);

  // Escape cancels a running upload.
  useEffect(() => {
    if (!job) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") abortRef.current?.abort();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [job]);

  // Errors stay a while, then go.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 12_000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const uploading = job?.filter((f) => f.status !== "error").length ?? 0;

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>

      {(dragging || job) && (
        <div
          className={clsx(
            "fixed inset-0 z-50 flex items-center justify-center bg-page/70 p-4 backdrop-blur-sm",
            job ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          <div
            className="pointer-events-none absolute inset-3 rounded-3xl border-2 border-dashed border-accent/60 bg-brand-tint sm:inset-5"
            aria-hidden
          />
          {job ? (
            <div
              className="relative w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-pop"
              role="dialog"
              aria-label="Uploading files"
            >
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-gradient text-white">
                  <Loader2 size={17} className="animate-spin" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">
                    Uploading {uploading === 1 ? "1 file" : `${uploading} files`}…
                  </p>
                  <p className="text-xs text-muted">The assistant opens when it&apos;s done</p>
                </div>
              </div>
              <ul className="mt-4 space-y-2.5">
                {job.map((f, i) => (
                  <li key={i} className="text-xs">
                    <div className="flex items-center gap-2">
                      <KindIcon kind={f.kind} size={14} className="shrink-0 text-accent" />
                      <span className="min-w-0 flex-1 truncate text-ink" title={f.name}>
                        {f.name}
                      </span>
                      {f.status === "error" ? (
                        <CircleAlert size={14} className="shrink-0 text-critical-text" aria-label="Failed" />
                      ) : f.status === "done" ? (
                        <Check size={14} className="shrink-0 text-good-text" aria-label="Uploaded" />
                      ) : (
                        <span className="shrink-0 text-muted tabular">{formatBytes(f.size)}</span>
                      )}
                    </div>
                    {f.status === "error" ? (
                      <p className="mt-0.5 pl-[22px] text-critical-text">{f.error}</p>
                    ) : (
                      <div className="mt-1 ml-[22px] h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                        <div
                          className="h-full rounded-full bg-accent transition-[width]"
                          style={{ width: `${Math.max(3, f.progress * 100)}%` }}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="h-8 rounded-lg border border-border px-3 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="relative max-w-sm text-center" aria-hidden>
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-gradient text-white shadow-pop">
                <CloudUpload size={26} />
              </span>
              <p className="mt-4 text-lg font-semibold text-ink">Drop to import with the assistant</p>
              <p className="mt-1.5 text-sm text-ink-2">
                Bank CSV or OFX/QIF exports, PDF statements, screenshots. It creates accounts, records balances and
                imports transactions.
              </p>
              <p className="mt-3 text-xs text-muted">Up to {MAX_ATTACHMENTS} files · 15 MB each</p>
            </div>
          )}
        </div>
      )}

      {notice && (
        <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4 md:top-4">
          <div className="pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-pop">
            <CircleAlert size={16} className="mt-0.5 shrink-0 text-critical-text" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">
                {notice.failed.length === 1 ? "1 file wasn't uploaded" : `${notice.failed.length} files weren't uploaded`}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
                {notice.failed.map((f, i) => (
                  <li key={i} className="break-words">
                    <span className="font-medium text-ink">{f.name}</span>: {f.error}
                  </li>
                ))}
              </ul>
              {notice.attached > 0 && (
                <p className="mt-1 text-xs text-muted">
                  The other {notice.attached === 1 ? "file was" : `${notice.attached} files were`} sent to the assistant.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="-mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
