import Link from "next/link";
import { AlertCircle, ArrowRight, Bell, Clock, CircleDollarSign, LineChart, Tag } from "lucide-react";
import { getOverview } from "@/server/services/overview";
import { netWorthHistory } from "@/server/services/networth";
import { serverFormat } from "@/server/format";
import { ASSET_CLASS_LABELS, ASSET_CLASS_SLOT, type AssetClass } from "@/lib/domain";
import { formatMonth } from "@/lib/dates";
import { Badge, ButtonLink, Card, CardHeader, Delta, EmptyState, Meter, SeriesDot, Stat } from "@/components/ui";
import { AllocationDonut, CashflowChart, NetWorthChart } from "@/components/charts";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

const NUDGE_ICON = {
  stale_balance: Clock,
  uncategorized: Tag,
  over_budget: AlertCircle,
  pending_reminder: Bell,
  missing_rate: CircleDollarSign,
  missing_price: LineChart,
};

export default async function Dashboard() {
  const uid = (await requireUser()).id;
  const o = getOverview(uid);
  const f = serverFormat(uid);
  const nw = o.netWorth;
  const history = netWorthHistory(uid, 24);

  if (nw.accounts.length === 0) {
    return (
      <div className="mx-auto max-w-xl pt-16">
        <EmptyState
          title="Welcome to Wallet 👋"
          action={
            <div className="flex gap-2">
              <ButtonLink href="/accounts?new=1" variant="primary">
                Add your first account
              </ButtonLink>
              <ButtonLink href="/transactions/import">Import a bank CSV</ButtonLink>
            </div>
          }
        >
          Start by adding your accounts (bank, savings, PEA, property, mortgage…) with their current balance. Your net
          worth builds up from there. Tip: <code>npm run db:seed-demo</code> loads demo data.
        </EmptyState>
      </div>
    );
  }

  const classes = (Object.keys(ASSET_CLASS_SLOT) as Exclude<AssetClass, "liabilities">[]).map((c) => ({
    key: c,
    label: ASSET_CLASS_LABELS[c],
    cents: nw.byClassCents[c],
    slot: ASSET_CLASS_SLOT[c],
  }));
  const budget = o.budget;
  const budgeted = budget.lines.filter((l) => l.budgetCents !== null);

  return (
    <div className="space-y-5">
      {/* Hero */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="text-sm text-muted">Net worth</div>
            <div className="mt-1 text-5xl font-semibold tracking-tight">{f.money(nw.netCents, { whole: true })}</div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
              {o.changes.map((c) => (
                <span key={c.label} className="inline-flex items-center gap-1.5">
                  <Delta value={c.deltaCents}>
                    {f.money(c.deltaCents, { whole: true, signed: true })}
                    {c.deltaPct !== null && ` (${c.deltaPct >= 0 ? "+" : ""}${c.deltaPct.toFixed(1)}%)`}
                  </Delta>
                  <span className="text-muted">{c.label}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="flex gap-8">
            <Stat label="Assets" value={f.money(nw.assetsCents, { whole: true })} />
            <Stat label="Liabilities" value={f.money(-nw.liabilitiesCents, { whole: true })} />
          </div>
        </div>
        <div className="mt-6">
          <NetWorthChart points={history} />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Allocation */}
        <Card className="lg:col-span-3">
          <CardHeader title="Allocation" subtitle="Gross assets by class, your share" action={<ButtonLink href="/accounts" size="sm" variant="ghost">Accounts <ArrowRight size={14} /></ButtonLink>} />
          <div className="flex flex-col items-center gap-6 sm:flex-row">
            <AllocationDonut slices={classes} />
            <table className="w-full text-sm">
              <tbody>
                {classes
                  .filter((c) => c.cents > 0)
                  .sort((a, b) => b.cents - a.cents)
                  .map((c) => (
                    <tr key={c.key} className="border-b border-border last:border-0">
                      <td className="py-2">
                        <span className="inline-flex items-center gap-2">
                          <SeriesDot slot={c.slot} />
                          {c.label}
                        </span>
                      </td>
                      <td className="tabular py-2 text-right text-muted">
                        {nw.assetsCents ? ((c.cents / nw.assetsCents) * 100).toFixed(1) : "0"}%
                      </td>
                      <td className="tabular py-2 pl-4 text-right font-medium">{f.money(c.cents, { whole: true })}</td>
                    </tr>
                  ))}
                {nw.liabilitiesCents > 0 && (
                  <tr>
                    <td className="py-2 text-ink-2">Liabilities</td>
                    <td />
                    <td className="tabular py-2 pl-4 text-right font-medium text-critical-text">
                      {f.money(-nw.liabilitiesCents, { whole: true })}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Needs attention */}
        <Card className="lg:col-span-2">
          <CardHeader title="Needs attention" subtitle={o.nudges.length ? `${o.nudges.length} item${o.nudges.length > 1 ? "s" : ""}` : "All caught up"} />
          {o.nudges.length === 0 ? (
            <p className="text-sm text-ink-2">✨ Balances fresh, transactions categorized, budgets on track.</p>
          ) : (
            <ul className="space-y-1">
              {o.nudges.slice(0, 7).map((n, i) => {
                const Icon = NUDGE_ICON[n.kind];
                return (
                  <li key={i}>
                    <Link href={n.href} className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-surface-2">
                      <Icon size={15} className={n.kind === "over_budget" ? "text-critical-text" : "text-muted"} />
                      <span className="flex-1">{n.text}</span>
                      <ArrowRight size={14} className="text-muted" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* This month */}
        <Card>
          <CardHeader
            title={`Budget · ${formatMonth(budget.month)}`}
            subtitle={`${Math.round(budget.elapsed * 100)}% of the month gone`}
            action={<ButtonLink href="/budgets" size="sm" variant="ghost">Budgets <ArrowRight size={14} /></ButtonLink>}
          />
          <div className="mb-5 grid grid-cols-3 gap-4">
            <Stat label="Income" value={f.money(budget.incomeCents, { whole: true })} />
            <Stat label="Spent" value={f.money(budget.expensesCents, { whole: true })} />
            <Stat
              label="Savings rate"
              value={budget.savingsRatePct === null ? "—" : `${budget.savingsRatePct.toFixed(0)}%`}
            />
          </div>
          {budgeted.length === 0 ? (
            <p className="text-sm text-ink-2">
              No budgets yet. <Link className="text-accent" href="/budgets">Set monthly envelopes</Link> per category.
            </p>
          ) : (
            <ul className="space-y-3">
              {budgeted.slice(0, 6).map((l) => (
                <li key={l.categoryId}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span>
                      {l.icon} {l.name}
                      {l.status === "over" && <span className="ml-2"><Badge tone="critical">over</Badge></span>}
                      {l.status === "ahead_of_pace" && <span className="ml-2"><Badge tone="warning">fast</Badge></span>}
                    </span>
                    <span className="tabular text-ink-2">
                      {f.money(l.spentCents, { whole: true })} <span className="text-muted">/ {f.money(l.budgetCents!, { whole: true })}</span>
                    </span>
                  </div>
                  <Meter pct={l.pct ?? 0} status={l.status === "unbudgeted" ? "ok" : l.status} pace={budget.elapsed} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Cash flow */}
        <Card>
          <CardHeader title="Cash flow" subtitle="Income vs expenses, last 6 months (transfers excluded)" />
          <CashflowChart months={o.cashflow} />
        </Card>
      </div>

      {o.upcoming.length > 0 && (
        <Card>
          <CardHeader
            title="Upcoming reminders"
            action={<ButtonLink href="/reminders" size="sm" variant="ghost">Reminders <ArrowRight size={14} /></ButtonLink>}
          />
          <ul className="grid gap-2 sm:grid-cols-2">
            {o.upcoming.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">
                <Bell size={14} className="text-muted" />
                <span className="flex-1 truncate">{r.title}</span>
                <span className="text-xs text-muted">{r.nextNagAt ? "waiting for ✅" : r.schedule}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
