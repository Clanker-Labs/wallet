import { DateTime } from "luxon";
import { CheckCircle2, ChevronRight, CircleAlert } from "lucide-react";
import { listReminders } from "@/server/services/reminders";
import { listAccounts } from "@/server/services/accounts";
import { getSettings } from "@/server/services/settings";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { ReminderForm } from "@/components/reminders-form";
import { KIND_LABELS, type ReminderKind, type ReminderValues } from "@/components/reminders-model";
import { ReminderRowActions } from "@/components/reminders-actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reminders" };

const COMMANDS: [string, string][] = [
  ["/networth", "net worth & recent change"],
  ["/budget", "this month's envelopes"],
  ["/balance <account> <amount>", "record a balance"],
  ["/spent <amount> <category>", "log an expense"],
  ["/reminders", "what's due or waiting"],
  ["/ask <question>", "ask the assistant"],
];

export default async function RemindersPage({ searchParams }: { searchParams: Promise<{ edit?: string; saved?: string }> }) {
  const uid = (await requireUser()).id;
  const sp = await searchParams;
  const { timezone, locale } = getSettings(uid);
  const reminders = listReminders(uid);
  const accounts = listAccounts(uid).map((a) => ({ id: a.id, name: a.name }));

  const editId = Number(sp.edit);
  const editRow = Number.isInteger(editId) ? reminders.find((r) => r.id === editId) : undefined;
  const editing: ({ id: number } & ReminderValues) | null = editRow
    ? {
        id: editRow.id,
        title: editRow.title,
        message: editRow.message ?? "",
        kind: editRow.kind as ReminderKind,
        accountId: editRow.accountId,
        frequency: editRow.frequency,
        dayOfMonth: editRow.dayOfMonth ?? 1,
        dayOfWeek: editRow.dayOfWeek ?? 1,
        monthOfYear: editRow.monthOfYear ?? 1,
        date: editRow.date ?? "",
        timeOfDay: editRow.timeOfDay,
        nagEveryHours: editRow.nagEveryHours,
        enabled: editRow.enabled,
      }
    : null;
  const savedId = Number(sp.saved);

  const tokenSet = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const chatCount = (process.env.TELEGRAM_CHAT_ID ?? "").split(",").filter((s) => s.trim()).length;
  const ready = tokenSet && chatCount > 0;

  const when = (d: Date) => {
    const dt = DateTime.fromJSDate(d).setZone(timezone).setLocale(locale);
    return `${dt.toFormat("ccc d LLL, HH:mm")} (${dt.toRelative()})`;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reminders"
        subtitle="Telegram nudges for the monthly chores, so balances and budgets stay fresh."
        actions={
          <ButtonLink href="#reminder-form" variant="secondary" className="lg:hidden">
            New reminder
          </ButtonLink>
        }
      />

      {/* Telegram status */}
      <Card>
        <CardHeader
          title="Telegram"
          subtitle={ready ? "Bot configured — keep the worker running to receive reminders." : "Set up the bot once to receive reminders on your phone."}
          action={
            <span className="shrink-0 whitespace-nowrap">
              <Badge tone={ready ? "good" : "warning"}>{ready ? "ready" : "not set up"}</Badge>
            </span>
          }
        />
        <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
          <Status ok={tokenSet} label="TELEGRAM_BOT_TOKEN" detail={tokenSet ? "set" : "missing"} />
          <Status ok={chatCount > 0} label="TELEGRAM_CHAT_ID" detail={chatCount > 0 ? `${chatCount} chat${chatCount > 1 ? "s" : ""} allowed` : "missing"} />
        </div>

        <details className="group mt-4 border-t border-border pt-3" open={!ready}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-ink-2 select-none hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight size={15} className="transition group-open:rotate-90" />
            Setup guide & bot commands
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ol className="space-y-2.5 text-sm">
              <Step n={1}>
                In Telegram, talk to <b>@BotFather</b> → <Code>/newbot</Code> → copy the token it gives you.
              </Step>
              <Step n={2}>
                Put it in <Code>.env</Code>: <Code>TELEGRAM_BOT_TOKEN=123456:ABC…</Code>
              </Step>
              <Step n={3}>
                Send <Code>/start</Code> to your bot, then run <Code>npm run worker</Code> — it prints
                the chat ids that wrote to the bot.
              </Step>
              <Step n={4}>
                Add yours: <Code>TELEGRAM_CHAT_ID=123456789</Code>, then start <Code>npm run worker</Code>{" "}
                again and keep it running (test with <Code>npm run worker -- --test</Code>).
              </Step>
            </ol>
            <div>
              <div className="mb-2 text-xs font-medium text-muted">Bot commands</div>
              <ul className="space-y-1.5 text-sm">
                {COMMANDS.map(([cmd, what]) => (
                  <li key={cmd} className="flex flex-wrap items-baseline gap-x-2">
                    <Code>{cmd}</Code>
                    <span className="text-xs text-muted">{what}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Or just type a question — the assistant answers.</p>
            </div>
          </div>
        </details>
      </Card>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-5">
        {/* List */}
        <Card className="lg:col-span-3">
          <CardHeader
            title="Your reminders"
            subtitle={
              reminders.length
                ? `${reminders.filter((r) => r.enabled).length} active · times in ${timezone}`
                : undefined
            }
          />
          {reminders.length === 0 ? (
            <EmptyState title="No reminders yet">Pick a preset in the form — two clicks and you&apos;re set.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {reminders.map((r) => {
                const waiting = r.enabled && r.nextNagAt !== null;
                return (
                  <li key={r.id} className={`flex flex-col gap-2 py-3 sm:flex-row sm:items-start ${r.enabled ? "" : "opacity-60"}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.title}</span>
                        <Badge tone="neutral">{KIND_LABELS[r.kind as ReminderKind] ?? r.kind}</Badge>
                        {waiting && <Badge tone="warning">waiting for ✅</Badge>}
                        {!r.enabled && <Badge tone="neutral">paused</Badge>}
                        {r.id === savedId && <Badge tone="good">saved</Badge>}
                      </div>
                      <div className="mt-0.5 text-sm text-ink-2">{r.schedule}</div>
                      <div className="mt-0.5 text-xs text-muted">
                        {waiting && r.nextNagAt
                          ? `Sent — next nudge ${when(r.nextNagAt)}`
                          : r.enabled && r.nextRunAt
                            ? `Next: ${when(r.nextRunAt)}`
                            : r.enabled
                              ? "No upcoming date"
                              : "Paused"}
                        {r.accountName && ` · 🏦 ${r.accountName}`}
                        {" · "}
                        {r.nagEveryHours > 0 ? `re-sends every ${r.nagEveryHours}h until done` : "sent once"}
                      </div>
                      {r.message && <p className="mt-1 line-clamp-2 text-xs text-muted">“{r.message}”</p>}
                    </div>
                    <ReminderRowActions id={r.id} title={r.title} enabled={r.enabled} waiting={waiting} />
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Form */}
        <div className="lg:col-span-2">
          <ReminderForm key={editing?.id ?? "new"} editing={editing} accounts={accounts} timezone={timezone} locale={locale} />
        </div>
      </div>
    </div>
  );
}

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {ok ? <CheckCircle2 size={15} className="text-good-text" /> : <CircleAlert size={15} className="text-critical-text" />}
      <code className="text-xs">{label}</code>
      <span className="text-ink-2">{detail}</span>
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-ink [overflow-wrap:anywhere]">{children}</code>;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-ink-2">{n}</span>
      <span className="min-w-0 text-ink-2">{children}</span>
    </li>
  );
}
