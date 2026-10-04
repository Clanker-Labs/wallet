"use client";

import clsx from "clsx";
import { Check, Pencil } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { markReminderDone, removeReminder, toggleReminder } from "@/app/reminders/actions";
import { ConfirmButton, Flash, useFlash } from "./settings-kit";

/** Per-row controls: enable switch, mark done (when waiting), edit, delete. */
export function ReminderRowActions({ id, title, enabled, waiting }: { id: number; title: string; enabled: boolean; waiting: boolean }) {
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash();
  const run = (fn: () => Promise<void>, done: string) =>
    startTransition(async () => {
      try {
        await fn();
        showFlash("good", done);
      } catch {
        showFlash("critical", "Something went wrong");
      }
    });

  return (
    <div className={clsx("flex flex-wrap items-center justify-end gap-1", pending && "opacity-60")}>
      <Flash flash={flash} className="mr-1" />
      {waiting && enabled && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => markReminderDone(id), "Marked done")}
          className="inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-2.5 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          <Check size={14} /> Mark done
        </button>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${enabled ? "Pause" : "Enable"} “${title}”`}
        title={enabled ? "Enabled — click to pause" : "Paused — click to enable"}
        disabled={pending}
        onClick={() => run(() => toggleReminder(id, !enabled), enabled ? "Paused" : "Enabled")}
        className="grid h-8 w-11 place-items-center rounded-lg hover:bg-surface-2"
      >
        <span className={clsx("relative h-5 w-9 rounded-full transition", enabled ? "bg-accent" : "bg-surface-2 ring-1 ring-border")}>
          <span
            className={clsx(
              "absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-all",
              enabled ? "left-[1.125rem]" : "left-0.5",
            )}
          />
        </span>
      </button>
      <Link
        href={`/reminders?edit=${id}#reminder-form`}
        aria-label={`Edit “${title}”`}
        title="Edit"
        className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
      >
        <Pencil size={14} />
      </Link>
      <ConfirmButton iconOnly title={`Delete “${title}”`} confirmLabel="Delete?" disabled={pending} onConfirm={() => run(() => removeReminder(id), "Deleted")} />
    </div>
  );
}
