"use client";

import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, File as FileIcon, FileImage, FileSpreadsheet, FileText, Loader2, X } from "lucide-react";

/**
 * Client side of assistant uploads (POST /api/uploads): uploading with
 * progress, the attachment chips shown in the composer and in sent messages,
 * and window-level file drag tracking shared by the chat and <GlobalDrop>.
 */

import { MAX_UPLOAD_BYTES, uploadKind, type UploadKind } from "@/lib/uploads";

export { MAX_UPLOAD_BYTES, type UploadKind };

/** What POST /api/uploads returns for each stored file. */
export interface UploadedFile {
  id: string;
  filename: string;
  size: number;
  kind: UploadKind | null;
}

/** POST /api/agent accepts at most this many attachments per message. */
export const MAX_ATTACHMENTS = 10;
export const UPLOAD_ACCEPT = ".csv,.tsv,.txt,.pdf,image/*,.ofx,.qif";

/** Upload kind from a name and type, by the same rules as the server. */
export function guessKind(filename: string, mimeType = ""): UploadKind | null {
  return uploadKind(mimeType, filename);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Upload one file; resolves with its stored metadata or rejects with the server's message. */
export function uploadFile(file: File, opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}) {
  return new Promise<UploadedFile>((resolve, reject) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      reject(new Error(`Too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as UploadedFile[] | { error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && Array.isArray(body) && body[0]) resolve(body[0]);
      else if (xhr.status === 401) reject(new Error("Your session expired: sign in again"));
      else if (xhr.status === 413) reject(new Error(`Too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`));
      else reject(new Error((body && !Array.isArray(body) && body.error) || `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error: upload failed"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    if (opts.signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Pasted screenshots all arrive as "image.png": give them a recognizable, unique name. */
export function namePastedFile(file: File): File {
  if (!/^image\.\w+$/.test(file.name)) return file;
  const ext = file.name.split(".").pop();
  const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type, lastModified: file.lastModified });
}

/**
 * Files from a paste, or [] to let the browser paste normally. Spreadsheets put
 * the copied cells on the clipboard as text *and* as a picture: prefer the text.
 */
export function pastedFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  if (!files.length) return [];
  const hasText = data.types.includes("text/plain") && data.getData("text/plain").trim() !== "";
  if (hasText && files.every((f) => f.type.startsWith("image/"))) return [];
  return files.map(namePastedFile);
}

// ── Attachments being prepared for a message ─────────────────────────────────

export interface Attachment {
  key: string;
  /** Upload id, once stored. */
  id?: string;
  filename: string;
  size: number;
  kind: UploadKind | null;
  status: "uploading" | "done" | "error";
  /** 0–1 while uploading. */
  progress: number;
  error?: string;
  /** The local file (for image previews), when picked in this session. */
  file?: File;
}

let seq = 0;
const nextKey = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`;

export function attachmentFromUpload(u: UploadedFile): Attachment {
  return { key: nextKey(), id: u.id, filename: u.filename, size: u.size, kind: u.kind, status: "done", progress: 1 };
}

/** Composer attachments: uploads start as soon as files are added. */
export function useAttachments(initial: UploadedFile[] = []) {
  const [items, setItems] = useState<Attachment[]>(() => initial.map(attachmentFromUpload));
  const [announcement, setAnnouncement] = useState("");
  const itemsRef = useRef(items);
  const controllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    itemsRef.current = items;
  });
  useEffect(() => {
    const map = controllers.current;
    return () => map.forEach((c) => c.abort());
  }, []);

  const patch = (key: string, p: Partial<Attachment>) =>
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const add = useCallback((files: File[]) => {
    if (!files.length) return;
    const room = Math.max(0, MAX_ATTACHMENTS - itemsRef.current.filter((x) => x.status !== "error").length);
    const added: Attachment[] = files.map((file, i) => ({
      key: nextKey(),
      filename: file.name || "upload",
      size: file.size,
      kind: guessKind(file.name, file.type),
      file,
      ...(i < room
        ? { status: "uploading" as const, progress: 0 }
        : { status: "error" as const, progress: 0, error: `Up to ${MAX_ATTACHMENTS} files per message` }),
    }));
    itemsRef.current = [...itemsRef.current, ...added];
    setItems((xs) => [...xs, ...added]);
    setAnnouncement(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}`);

    for (const a of added) {
      if (a.status !== "uploading") continue;
      const controller = new AbortController();
      controllers.current.set(a.key, controller);
      uploadFile(a.file!, {
        signal: controller.signal,
        onProgress: (progress) => patch(a.key, { progress }),
      })
        .then((u) => {
          patch(a.key, { id: u.id, kind: u.kind ?? a.kind, size: u.size, status: "done", progress: 1 });
          setAnnouncement(`${a.filename} uploaded`);
        })
        .catch((e: unknown) => {
          if (isAbort(e)) return;
          const error = e instanceof Error ? e.message : String(e);
          patch(a.key, { status: "error", error });
          setAnnouncement(`${a.filename} could not be uploaded: ${error}`);
        })
        .finally(() => controllers.current.delete(a.key));
    }
  }, []);

  const remove = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    itemsRef.current = itemsRef.current.filter((x) => x.key !== key);
    setItems((xs) => xs.filter((x) => x.key !== key));
  }, []);

  const clear = useCallback(() => {
    controllers.current.forEach((c) => c.abort());
    itemsRef.current = [];
    setItems([]);
  }, []);

  return {
    items,
    add,
    remove,
    clear,
    announcement,
    uploading: items.some((x) => x.status === "uploading"),
    done: items.filter((x): x is Attachment & { id: string } => x.status === "done" && !!x.id),
  };
}

// ── Chips ────────────────────────────────────────────────────────────────────

export function KindIcon({ kind, size = 15, className }: { kind: UploadKind | null; size?: number; className?: string }) {
  const Icon = kind === "csv" ? FileSpreadsheet : kind === "image" ? FileImage : kind === "pdf" || kind === "text" ? FileText : FileIcon;
  return <Icon size={size} className={className} aria-hidden />;
}

const KIND_LABEL: Record<UploadKind, string> = { csv: "CSV", text: "Text", pdf: "PDF", image: "Image" };

/** Local thumbnail for an image picked or pasted in this session. */
function useObjectUrl(file?: File) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [file]);
  return url;
}

/** A file in the composer: kind icon or preview, name, size, progress or error, remove. */
export function AttachmentChip({ item, onRemove }: { item: Attachment; onRemove: () => void }) {
  const preview = useObjectUrl(item.status === "error" ? undefined : item.file);
  const error = item.status === "error";
  return (
    <li
      className={clsx(
        "relative flex w-[15rem] shrink-0 items-center gap-2 overflow-hidden rounded-xl border bg-surface py-1.5 pr-1 pl-1.5 text-xs sm:w-auto sm:max-w-[18rem] sm:shrink",
        error ? "border-critical/40" : "border-border",
      )}
    >
      <span
        className={clsx(
          "grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg",
          error ? "bg-surface-2 text-critical-text" : "bg-brand-tint text-accent",
        )}
      >
        {error ? (
          <CircleAlert size={15} aria-hidden />
        ) : item.status === "uploading" ? (
          <Loader2 size={15} className="animate-spin" aria-hidden />
        ) : preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <KindIcon kind={item.kind} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink" title={item.filename}>
          {item.filename}
        </span>
        <span className={clsx("block", error ? "line-clamp-3 text-critical-text" : "truncate text-muted")}>
          {error
            ? item.error
            : item.status === "uploading"
              ? `Uploading… ${Math.round(item.progress * 100)}%`
              : [item.kind && KIND_LABEL[item.kind], formatBytes(item.size)].filter(Boolean).join(" · ")}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-offset-[-2px]"
        aria-label={`Remove ${item.filename}`}
        title="Remove"
      >
        <X size={14} />
      </button>
      {item.status === "uploading" && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-2" aria-hidden>
          <span className="block h-full bg-accent transition-[width]" style={{ width: `${Math.max(4, item.progress * 100)}%` }} />
        </span>
      )}
    </li>
  );
}

/** A file attached to a sent message (inside or above a chat bubble). */
export function FileChip({ name, size, kind }: { name: string; size?: number; kind?: UploadKind | null }) {
  const k = kind === undefined ? guessKind(name) : kind;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-ink-2">
      <KindIcon kind={k} size={13} className="shrink-0 text-accent" />
      <span className="truncate text-ink" title={name}>
        {name}
      </span>
      {size !== undefined && <span className="shrink-0 text-muted">{formatBytes(size)}</span>}
    </span>
  );
}

// ── Drag tracking ────────────────────────────────────────────────────────────

const carriesFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

/**
 * Tracks files dragged over the window and receives the drop. Returns whether
 * the overlay should show. Only drags carrying files from outside the page
 * count (not text or images dragged within it); an element that handles the
 * drag itself (calls preventDefault, like the CSV import wizard's drop zone)
 * keeps it. dragenter/dragleave are counted so moving across child elements
 * doesn't flicker; a watchdog clears a drag whose dragleave never came.
 */
export function useWindowFileDrop(onFiles: (files: File[]) => void, enabled = true): boolean {
  const [active, setActive] = useState(false);
  const callback = useRef(onFiles);
  useEffect(() => {
    callback.current = onFiles;
  });

  useEffect(() => {
    if (!enabled) {
      setActive(false);
      return;
    }
    let depth = 0;
    let internal = false;
    let watchdog: number | undefined;
    const reset = () => {
      depth = 0;
      window.clearTimeout(watchdog);
      setActive(false);
    };
    const relevant = (e: DragEvent) => !internal && carriesFiles(e);

    const onDragStart = () => {
      internal = true;
    };
    const onDragEnd = () => {
      internal = false;
      reset();
    };
    const onEnter = (e: DragEvent) => {
      if (relevant(e)) depth += 1;
    };
    const onLeave = (e: DragEvent) => {
      if (!relevant(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) reset();
    };
    const onOver = (e: DragEvent) => {
      if (!relevant(e)) return;
      // Browsers fire dragover continuously during a drag, even when the pointer rests.
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(reset, 2500);
      if (e.defaultPrevented) return setActive(false); // a local drop zone has it
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
      depth = Math.max(depth, 1);
      setActive(true);
    };
    const onDrop = (e: DragEvent) => {
      const wasInternal = internal;
      internal = false;
      reset();
      if (wasInternal || !carriesFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer!.files);
      if (files.length) callback.current(files);
    };

    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.clearTimeout(watchdog);
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [enabled]);

  return active;
}
