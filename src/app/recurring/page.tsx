import { DateTime } from "luxon";
import { AlertTriangle, Check, Pause, Play, Plus, Search, X } from "lucide-react";
import {
  CADENCES,
  forecastCash,
  listRecurring,
  recurringNudges,
  recurringSummary,
  upcoming,
} from "@/server/services/recurring";
import { listAccounts } from "@/server/services/accounts";
import { listCategories } from "@/server/services/categories";
import { getSettings, today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { COMMON_CURRENCIES } from "@/lib/domain";
import { formatDate } from "@/lib/dates";
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { NetWorthChart } from "@/components/charts";
import { Disclosure } from "@/components/accounts-ui";
import { RecurringForm } from "@/components/recurring-form";
import { deleteRecurringAction, detectRecurringAction, recordRecurringAction, setRecurringStatus } from "./actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recurring" };

export default async function RecurringPage() {
  const uid = (await requireUser()).id;
  const f = serverFormat(uid);
  const t = today(uid);
  const base = getSettings(uid).currency;
  const items = listRecurring(uid, { status: ["active", "paused"] });
  const suggestions = listRecurring(uid, { status: ["suggested"] });
  const next = upcoming(uid, 30);
  const summary = recurringSummary(uid);
  const attention = recurringNudges(uid);
  const forecast = forecastCash(uid, 90);
  const accounts = listAccounts(uid).map((a) => ({ id: a.id, name: a.name, currency: a.currency }));
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const categories = listCategories(uid).map((c) => ({ id: c.id, name: c.name, icon: c.icon, kind: c.kind }));
  const currencies = [...new Set<string>([base, "AED", "EUR", "USD", ...COMMON_CURRENCIES.slice(0, 6)])];
  const native = (cents: number, currency: string) => f.money(cents, { currency, whole: Math.abs(cents) >= 100_00 });
  const days = (d: string) => Math.round(DateTime.fromISO(d).diff(DateTime.fromISO(t), "days").days);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Recurring"
        subtitle="Salary, rent and subscriptions as expectations. Statements are matched to them, so nothing is counted twice."
        actions={
          <form action={detectRecurringAction}>
            <Button type="submit" size="sm">
              <Search size={14} /> Find in my history
            </Button>
          </form>
        }
      />

      <Card>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat label="Comes in monthly" value={f.money(summary.monthlyIncomeCents, { whole: true })} />
          <Stat label="Goes out monthly" value={f.money(summary.monthlyFixedCents, { whole: true })} delta={summary.monthlySubscriptionsCents ? <span className="text-muted">{f.money(summary.monthlySubscriptionsCents, { whole: true })} subscriptions</span> : undefined} />
          <Stat label="Left after fixed costs" value={<span className={summary.freeCents < 0 ? "text-critical-text" : ""}>{f.money(summary.freeCents, { whole: true, signed: true })}</span>} />
          <Stat
            label="Cash in 90 days"
            value={f.money(forecast.points.at(-1)?.cents ?? 0, { whole: true })}
            delta={forecast.low.cents < (forecast.points[0]?.cents ?? 0) ? <span className="text-muted">lowest {f.money(forecast.low.cents, { whole: true })} on {formatDate(forecast.low.date)}</span> : undefined}
          />
        </div>
      </Card>

      {attention.length > 0 && (
        <Card>
          <ul className="space-y-1.5 text-sm">
            {attention.map((a, i) => (
              <li key={i} className="flex items-center gap-2">
                <AlertTriangle size={14} className={a.kind === "late" ? "text-warning" : "text-muted"} />
                {a.text}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {suggestions.length > 0 && (
        <Card>
          <CardHeader title="Found in your history" subtitle="Payments that repeat. Keep the ones that are really recurring." />
          <ul className="divide-y divide-border">
            {suggestions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{s.name}</span>{" "}
                  <span className="text-muted">
                    · {CADENCES[s.cadence].label.toLowerCase()} · {native(s.amountCents, s.currency)}
                    {s.accountId && ` · ${accountName.get(s.accountId) ?? ""}`} · next {formatDate(s.nextDate)}
                  </span>
                </span>
                <span className="flex gap-1">
                  <form action={setRecurringStatus}>
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="status" value="active" />
                    <Button type="submit" size="sm" variant="primary">
                      <Check size={14} /> Keep
                    </Button>
                  </form>
                  <form action={setRecurringStatus}>
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="status" value="dismissed" />
                    <Button type="submit" size="sm" variant="ghost" aria-label={`Dismiss ${s.name}`}>
                      <X size={14} />
                    </Button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader title="Next 30 days" subtitle={next.length ? `${next.length} expected payment${next.length > 1 ? "s" : ""}` : "Nothing expected"} />
          <ul className="space-y-1.5 text-sm">
            {next.map((o, i) => (
              <li key={`${o.recurringId}-${o.date}-${i}`} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="tabular mr-2 text-xs text-muted">{DateTime.fromISO(o.date).toFormat("d LLL")}</span>
                  {o.name}
                  {o.status === "late" && (
                    <span className="ml-2">
                      <Badge tone="warning">late {-days(o.date)}d</Badge>
                    </span>
                  )}
                </span>
                <span className={`tabular shrink-0 ${o.amountCents > 0 ? "text-good-text" : ""}`}>{native(o.amountCents, o.currency)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="lg:col-span-3">
          <CardHeader title="Cash forecast" subtitle="Today's cash and savings, plus everything expected over 90 days" />
          <NetWorthChart points={forecast.points.map((p) => ({ date: p.date, netCents: p.cents }))} label="Cash" dayTicks height={220} />
        </Card>
      </div>

      <Card>
        <CardHeader title="Your recurring items" subtitle={items.length ? undefined : "None yet"} />
        {items.length === 0 ? (
          <EmptyState title="Nothing scheduled yet">
            Add your salary and rent below, or let wallet find them in your history. Each one is matched to the real payment when a statement
            comes in; if one is late, you&apos;ll see it here and on the dashboard.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{r.name}</span>
                    {r.status === "paused" && (
                      <span className="ml-2">
                        <Badge>paused</Badge>
                      </span>
                    )}
                    <span className="block text-xs text-muted">
                      {CADENCES[r.cadence].label} · next {formatDate(r.nextDate)}
                      {r.accountId && ` · ${accountName.get(r.accountId) ?? ""}`}
                      {r.lastMatchedDate ? ` · last paid ${formatDate(r.lastMatchedDate)}` : " · not matched yet"}
                      {r.lastChangePct ? ` · ${r.lastChangePct > 0 ? "+" : ""}${r.lastChangePct}% last time` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className={`tabular mr-2 font-semibold ${r.amountCents > 0 ? "text-good-text" : ""}`}>{native(r.amountCents, r.currency)}</span>
                    <form action={recordRecurringAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <Button type="submit" size="sm" variant="ghost" title="Record this payment now (for one no statement will bring)">
                        <Plus size={14} /> Record
                      </Button>
                    </form>
                    <form action={setRecurringStatus}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value={r.status === "paused" ? "active" : "paused"} />
                      <Button type="submit" size="sm" variant="ghost" aria-label={r.status === "paused" ? `Resume ${r.name}` : `Pause ${r.name}`}>
                        {r.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                      </Button>
                    </form>
                    <form action={deleteRecurringAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <Button type="submit" size="sm" variant="ghost" aria-label={`Delete ${r.name}`}>
                        <X size={14} />
                      </Button>
                    </form>
                  </span>
                </div>
                <Disclosure className="mt-1" summaryClassName="text-xs text-muted" summary="Edit" focusOnOpen={false}>
                  <div className="pt-3">
                    <RecurringForm
                      value={{ id: r.id, name: r.name, pattern: r.pattern, amount: r.amountCents / 100, currency: r.currency, cadence: r.cadence, nextDate: r.nextDate, accountId: r.accountId, categoryId: r.categoryId }}
                      accounts={accounts}
                      categories={categories}
                      currencies={currencies}
                      baseCurrency={base}
                      today={t}
                    />
                  </div>
                </Disclosure>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <Disclosure defaultOpen={items.length === 0} focusOnOpen={false} summary={<span className="inline-flex items-center gap-1.5 font-medium"><Plus size={15} /> Add a recurring payment</span>}>
          <div className="pt-4">
            <RecurringForm accounts={accounts} categories={categories} currencies={currencies} baseCurrency={base} today={t} />
          </div>
        </Disclosure>
      </Card>
    </div>
  );
}
