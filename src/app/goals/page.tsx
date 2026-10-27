import { Archive, CheckCircle2, Plus, X } from "lucide-react";
import { listGoals } from "@/server/services/goals";
import { listAccounts } from "@/server/services/accounts";
import { getSettings } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { COMMON_CURRENCIES } from "@/lib/domain";
import { formatDate } from "@/lib/dates";
import { Badge, Button, Card, EmptyState, Meter, PageHeader, Stat } from "@/components/ui";
import { NetWorthChart } from "@/components/charts";
import { Disclosure } from "@/components/accounts-ui";
import { GoalForm } from "@/components/goal-form";
import { goalStatusAction } from "./actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Goals" };

export default async function GoalsPage() {
  const uid = (await requireUser()).id;
  const f = serverFormat(uid);
  const base = getSettings(uid).currency;
  const goals = listGoals(uid);
  const accounts = listAccounts(uid).map((a) => ({ id: a.id, name: a.name }));
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const currencies = [...new Set<string>([base, "AED", "EUR", "USD", ...COMMON_CURRENCIES.slice(0, 6)])];

  return (
    <div className="space-y-5">
      <PageHeader title="Goals" subtitle="What you're saving for, where you are, and when you'll get there at your pace" />
      {goals.length === 0 && (
        <EmptyState title="No goals yet">
          A flat deposit by next summer, an emergency fund of six months, a first million: set the amount, link the accounts that hold it (or none,
          for your whole net worth) and see what each month needs.
        </EmptyState>
      )}
      {goals.map((g) => {
        const m = (c: number) => f.money(c, { currency: g.currency, whole: true });
        return (
          <Card key={g.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-lg font-semibold">
                  {g.icon} {g.name}
                </div>
                <div className="text-sm text-ink-2">
                  {g.accountIds.length ? g.accountIds.map((id) => accountName.get(id) ?? "?").join(", ") : "Your whole net worth"}
                  {g.targetDate && <span className="text-muted"> · by {formatDate(g.targetDate)}</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="tabular text-2xl font-semibold">
                  {m(g.currentCents)} <span className="text-base font-normal text-muted">/ {m(g.targetCents)}</span>
                </div>
                {g.remainingCents === 0 ? (
                  <Badge tone="good">reached</Badge>
                ) : g.onTrack === true ? (
                  <Badge tone="good">on track</Badge>
                ) : g.onTrack === false ? (
                  <Badge tone="warning">behind</Badge>
                ) : null}
              </div>
            </div>
            <div className="mt-4">
              <Meter pct={g.pct} status={g.onTrack === false ? "ahead_of_pace" : "ok"} />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Done" value={`${g.pct.toFixed(0)}%`} />
              <Stat label="Still to go" value={m(g.remainingCents)} />
              <Stat
                label="Needed monthly"
                value={g.neededMonthlyCents === null ? "—" : m(g.neededMonthlyCents)}
                delta={g.monthsLeft !== null ? <span className="text-muted">{g.monthsLeft} months left</span> : <span className="text-muted">no date set</span>}
              />
              <Stat
                label="At your pace"
                value={g.remainingCents === 0 ? "done" : g.projectedDate ? formatDate(g.projectedDate) : "—"}
                delta={
                  <span className="text-muted">
                    {g.paceSource === "plan" ? `${m(g.paceCents)} a month planned` : g.paceSource === "savings" ? `${m(g.paceCents)} a month, your average savings` : "no savings history yet"}
                  </span>
                }
              />
            </div>
            {g.history.length > 1 && (
              <div className="mt-4">
                <NetWorthChart points={g.history} label="Progress" height={140} />
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-start gap-2 border-t border-border pt-3">
              <Disclosure className="min-w-0 flex-1" summary="Edit goal" summaryClassName="text-sm" focusOnOpen={false}>
                <div className="pt-3">
                  <GoalForm
                    value={{ id: g.id, name: g.name, icon: g.icon, target: g.targetCents / 100, currency: g.currency, targetDate: g.targetDate, accountIds: g.accountIds, monthly: g.monthlyCents === null ? null : g.monthlyCents / 100 }}
                    accounts={accounts}
                    currencies={currencies}
                    baseCurrency={base}
                  />
                </div>
              </Disclosure>
              <form action={goalStatusAction}>
                <input type="hidden" name="id" value={g.id} />
                <input type="hidden" name="what" value="archive" />
                <Button type="submit" size="sm" variant="ghost" title="Done with it: hide it, keep it in the list of archived goals">
                  {g.remainingCents === 0 ? <CheckCircle2 size={14} /> : <Archive size={14} />} Archive
                </Button>
              </form>
              <form action={goalStatusAction}>
                <input type="hidden" name="id" value={g.id} />
                <input type="hidden" name="what" value="delete" />
                <Button type="submit" size="sm" variant="ghost" aria-label={`Delete ${g.name}`}>
                  <X size={14} />
                </Button>
              </form>
            </div>
          </Card>
        );
      })}
      <Card>
        <Disclosure defaultOpen={goals.length === 0} focusOnOpen={false} summary={<span className="inline-flex items-center gap-1.5 font-medium"><Plus size={15} /> Add a goal</span>}>
          <div className="pt-4">
            <GoalForm accounts={accounts} currencies={currencies} baseCurrency={base} />
          </div>
        </Disclosure>
      </Card>
    </div>
  );
}
