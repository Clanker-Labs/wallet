"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { DateTime } from "luxon";
import { describeRule, nextOccurrence, type ScheduleRule } from "@/lib/schedule";
import { saveReminder } from "@/app/reminders/actions";
import type { ReminderInput } from "@/server/services/reminders";
import { Button, ButtonLink, Card, CardHeader, Input, Select, Textarea } from "./ui";
import { Flash, Segmented, useFlash } from "./settings-kit";
import type { ReminderValues } from "./reminders-model";

const BLANK: ReminderValues = {
  title: "",
  message: "",
  kind: "custom",
  accountId: null,
  frequency: "monthly",
  dayOfMonth: 1,
  dayOfWeek: 1,
  monthOfYear: 1,
  date: "",
  timeOfDay: "09:00",
  nagEveryHours: 0,
  enabled: true,
};

const PRESETS: { label: string; values: Partial<ReminderValues> }[] = [
  {
    label: "Monthly: update balances (1st, 09:00, nag 24h)",
    values: { title: "Update account balances", kind: "balance_update", frequency: "monthly", dayOfMonth: 1, timeOfDay: "09:00", nagEveryHours: 24 },
  },
  {
    label: "Monthly: import bank statement (3rd, 19:00, nag 24h)",
    values: { title: "Import bank statement", kind: "statement", frequency: "monthly", dayOfMonth: 3, timeOfDay: "19:00", nagEveryHours: 24 },
  },
  {
    label: "Monthly report (1st, 08:30)",
    values: { title: "Monthly report", kind: "monthly_report", frequency: "monthly", dayOfMonth: 1, timeOfDay: "08:30", nagEveryHours: 0 },
  },
  {
    label: "Yearly: tax return (May 15)",
    values: {
      title: "File the tax return",
      kind: "custom",
      frequency: "yearly",
      monthOfYear: 5,
      dayOfMonth: 15,
      timeOfDay: "09:00",
      nagEveryHours: 0,
      message: "Tax return season — check the deadline for your area and file it.",
    },
  },
];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = Array.from({ length: 12 }, (_, i) => DateTime.fromObject({ month: i + 1 }).toFormat("LLLL"));

/** Only the fields the chosen frequency uses; the rest are null. */
export function toInput(v: ReminderValues): ReminderInput {
  const f = v.frequency;
  return {
    title: v.title,
    message: v.message.trim() || null,
    kind: v.kind,
    accountId: v.kind === "balance_update" || v.kind === "statement" ? v.accountId : null,
    frequency: f,
    date: f === "once" ? v.date || null : null,
    dayOfWeek: f === "weekly" ? v.dayOfWeek : null,
    dayOfMonth: f === "monthly" || f === "quarterly" || f === "yearly" ? v.dayOfMonth : null,
    monthOfYear: f === "quarterly" || f === "yearly" ? v.monthOfYear : null,
    timeOfDay: v.timeOfDay,
    nagEveryHours: v.nagEveryHours,
    enabled: v.enabled,
  };
}

export function ReminderForm({
  editing,
  accounts,
  timezone,
  locale,
}: {
  editing: ({ id: number } & ReminderValues) | null;
  accounts: { id: number; name: string }[];
  timezone: string;
  locale: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ReminderValues>(() => (editing ? { ...BLANK, ...editing } : BLANK));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash(5000);
  const [now, setNow] = useState<Date | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const ids = { title: useId(), account: useId(), date: useId(), dom: useId(), moy: useId(), time: useId(), message: useId() };
  useEffect(() => setNow(new Date()), []);

  const set = <K extends keyof ReminderValues>(k: K, v: ReminderValues[K]) => {
    setValues((s) => ({ ...s, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: "" }));
  };
  const input = toInput(values);
  const rule: ScheduleRule = input;
  const preview = values.frequency === "once" && !values.date ? "Pick a date" : describeRule(rule);
  const next = now && (values.frequency !== "once" || values.date) ? nextOccurrence(rule, now, timezone) : null;
  const nagOptions = [0, 3, 12, 24].includes(values.nagEveryHours) ? [0, 3, 12, 24] : [0, 3, 12, 24, values.nagEveryHours].sort((a, b) => a - b);
  const showAccount = values.kind === "balance_update" || values.kind === "statement";

  const submit = () =>
    startTransition(async () => {
      const res = await saveReminder(editing?.id ?? null, input);
      if (!res.ok) {
        setErrors(res.errors);
        showFlash("critical", res.message ?? "Check the highlighted fields");
        return;
      }
      setErrors({});
      showFlash("good", editing ? `Saved “${res.title}”` : `Created “${res.title}”`);
      if (!editing) setValues(BLANK);
      router.replace(`/reminders?saved=${res.id}`, { scroll: false });
    });

  return (
    <Card id="reminder-form" className="scroll-mt-20">
      <CardHeader
        title={editing ? "Edit reminder" : "New reminder"}
        subtitle={editing ? editing.title : "Start from a preset or fill it in"}
        action={
          editing ? (
            <ButtonLink href="/reminders" size="sm" variant="ghost" scroll={false}>
              Cancel
            </ButtonLink>
          ) : undefined
        }
      />

      {!editing && (
        <div className="mb-5 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setValues({ ...BLANK, ...p.values });
                setErrors({});
                titleRef.current?.focus();
              }}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Row label="Title" htmlFor={ids.title} error={errors.title}>
          <Input
            ref={titleRef}
            id={ids.title}
            value={values.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="e.g. Update account balances"
            maxLength={120}
            aria-invalid={!!errors.title || undefined}
          />
        </Row>

        <Row label="Kind">
          <Segmented
            ariaLabel="Kind"
            size="sm"
            value={values.kind}
            onChange={(k) => set("kind", k)}
            options={[
              { value: "balance_update", label: "Balances" },
              { value: "statement", label: "Statement" },
              { value: "monthly_report", label: "Report" },
              { value: "custom", label: "Custom" },
            ]}
          />
          <p className="mt-1 text-xs text-muted">
            {values.kind === "balance_update"
              ? "Asks for fresh balances — reply to the Telegram message with the amount."
              : values.kind === "statement"
                ? "Reminds you to import the bank CSV."
                : values.kind === "monthly_report"
                  ? "Sends last month's income, spending and net worth."
                  : "Just your message."}
          </p>
        </Row>

        {showAccount && (
          <Row label="Account" htmlFor={ids.account} error={errors.accountId}>
            <Select id={ids.account} value={values.accountId ?? ""} onChange={(e) => set("accountId", e.target.value ? Number(e.target.value) : null)}>
              <option value="">{values.kind === "balance_update" ? "All accounts not updated lately" : "Any account"}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Row>
        )}

        <Row label="Repeats">
          <Segmented
            ariaLabel="Frequency"
            size="sm"
            value={values.frequency}
            onChange={(f) => set("frequency", f)}
            options={[
              { value: "once", label: "Once" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
              { value: "quarterly", label: "Quarterly" },
              { value: "yearly", label: "Yearly" },
            ]}
          />
        </Row>

        <div className="grid grid-cols-2 gap-3">
          {values.frequency === "once" && (
            <Row label="Date" htmlFor={ids.date} error={errors.date}>
              <Input id={ids.date} type="date" value={values.date} onChange={(e) => set("date", e.target.value)} aria-invalid={!!errors.date || undefined} />
            </Row>
          )}
          {values.frequency === "weekly" && (
            <Row label="Day" className="col-span-2" error={errors.dayOfWeek}>
              <Segmented
                ariaLabel="Day of week"
                size="sm"
                value={values.dayOfWeek}
                onChange={(d) => set("dayOfWeek", d)}
                options={WEEKDAYS.map((label, i) => ({ value: i + 1, label }))}
              />
            </Row>
          )}
          {(values.frequency === "quarterly" || values.frequency === "yearly") && (
            <Row label={values.frequency === "yearly" ? "Month" : "Starting month"} htmlFor={ids.moy} error={errors.monthOfYear}>
              <Select id={ids.moy} value={values.monthOfYear} onChange={(e) => set("monthOfYear", Number(e.target.value))}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
            </Row>
          )}
          {(values.frequency === "monthly" || values.frequency === "quarterly" || values.frequency === "yearly") && (
            <Row label="Day of month" htmlFor={ids.dom} error={errors.dayOfMonth}>
              <Select id={ids.dom} value={values.dayOfMonth} onChange={(e) => set("dayOfMonth", Number(e.target.value))}>
                {Array.from({ length: 31 }, (_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}
                    {i >= 28 ? " (or last day)" : ""}
                  </option>
                ))}
              </Select>
            </Row>
          )}
          <Row label="Time" htmlFor={ids.time} error={errors.timeOfDay}>
            <Input id={ids.time} type="time" value={values.timeOfDay} onChange={(e) => set("timeOfDay", e.target.value)} required />
          </Row>
        </div>

        <Row label="Nag until done" error={errors.nagEveryHours}>
          <Segmented
            ariaLabel="Nag until done"
            size="sm"
            value={values.nagEveryHours}
            onChange={(h) => set("nagEveryHours", h)}
            options={nagOptions.map((h) => ({ value: h, label: h === 0 ? "Off" : `${h}h` }))}
          />
          <p className="mt-1 text-xs text-muted">
            {values.nagEveryHours > 0
              ? `Re-sends every ${values.nagEveryHours}h until you tap ✅ in Telegram (or “Mark done” here).`
              : "Sent once per occurrence."}
          </p>
        </Row>

        <Row label="Message (optional)" htmlFor={ids.message} error={errors.message}>
          <Textarea id={ids.message} rows={2} value={values.message} onChange={(e) => set("message", e.target.value)} maxLength={1000} placeholder="Extra note sent with the reminder" />
        </Row>

        <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <div className="text-ink">{preview}</div>
          <div className="text-xs text-muted">
            {next
              ? `Next: ${DateTime.fromJSDate(next).setZone(timezone).setLocale(locale).toFormat("ccc d LLL yyyy, HH:mm")} (${timezone})`
              : values.frequency === "once" && values.date
                ? "That date is in the past"
                : " "}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : editing ? "Save changes" : "Create reminder"}
          </Button>
          <label className="inline-flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={values.enabled} onChange={(e) => set("enabled", e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            Enabled
          </label>
          <Flash flash={flash} />
        </div>
      </form>
    </Card>
  );
}

function Row({ label, htmlFor, error, className, children }: { label: string; htmlFor?: string; error?: string; className?: string; children: ReactNode }) {
  return (
    <div className={clsx("min-w-0", className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-ink-2">
          {label}
        </label>
      ) : (
        <div className="mb-1 text-xs font-medium text-ink-2">{label}</div>
      )}
      {children}
      {error && <p className="mt-1 text-xs text-critical-text">{error}</p>}
    </div>
  );
}
