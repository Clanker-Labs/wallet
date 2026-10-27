import Link from "next/link";
import { AlertCircle, ArrowRight, Bell, CalendarClock, CheckCircle2, Clock, CircleDollarSign, LineChart, Tag, TrendingUp } from "lucide-react";
import { getOverview } from "@/server/services/overview";
import { listGoals } from "@/server/services/goals";
import { netWorthDaily, netWorthHistory, netWorthMoves } from "@/server/services/networth";
import { serverFormat } from "@/server/format";
import { ASSET_CLASS_LABELS, ASSET_CLASS_SLOT, type AssetClass } from "@/lib/domain";
import { formatMonth } from "@/lib/dates";
import { Badge, ButtonLink, Card, CardHeader, Delta, EmptyState, Meter, SeriesDot, Stat } from "@/components/ui";
import { AllocationDonut, CashflowChart } from "@/components/charts";
import { MoversCard, NetWorthPanel } from "@/components/networth-ui";
import { CountUp } from "@/components/count-up";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

const NUDGE_ICON = {
  stale_balance: Clock,
  uncategorized: Tag,
  over_budget: AlertCircle,
  pending_reminder: Bell,
  missing_rate: CircleDollarSign,
  missing_price: LineChart,
  recurring_late: CalendarClock,
  price_change: TrendingUp,
};

export default async function Dashboard() {
  const uid = (await requireUser()).id;
  const o = getOverview(uid);
  const f = serverFormat(uid);
  const nw = o.netWorth;
  const history = netWorthHistory(uid, 120);
  const daily = netWorthDaily(uid, 365);
  const { moves } = netWorthMoves(uid);
  const goals = listGoals(uid).slice(0, 4);

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
              <ButtonLink href="/assistant">Import a statement</ButtonLink>
            </div>
          }
        >
          Add your accounts (checking, savings, brokerage, crypto, property, mortgage…) with their current balance, in any
          currency. Or drop a bank or broker statement (CSV or PDF) anywhere on this page and the assistant fills things in.
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

  const invested = nw.byClassCents.investments + nw.byClassCents.retirement + nw.byClassCents.crypto + nw.byClassCents.commodities;
  const assetsTotal = Math.max(1, nw.assetsCents);
  const heroStats = [
    { label: "Assets", cents: nw.assetsCents, share: null as number | null, tone: "" },
    { label: "Liabilities", cents: nw.liabilitiesCents ? -nw.liabilitiesCents : 0, share: null, tone: nw.liabilitiesCents ? "text-critical-text" : "" },
    { label: "Cash", cents: nw.byClassCents.cash, share: nw.byClassCents.cash / assetsTotal, tone: "" },
    { label: "Invested", cents: invested, share: invested / assetsTotal, tone: "" },
  ];

  return (
    <div className="space-y-5 md:space-y-6">
      <h1 className="sr-only">Net worth</h1>
      {/* Hero */}
      <Card className="bg-hero relative overflow-hidden p-5 md:p-7">
        <div className="grid gap-6 xl:grid-cols-[1fr_auto] xl:items-end">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-muted">
              <span className="font-medium text-ink-2">Net worth</span>
              <span className="rounded-md border border-border bg-surface/60 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide">{nw.currency}</span>
            </div>
            <div className="display-xl tabular mt-2 truncate">
              <CountUp cents={nw.netCents} opts={{ whole: true }} />
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 xl:gap-x-10">
            {heroStats.map((st) => (
              <div key={st.label} className="min-w-0">
                <dt className="text-xs font-medium text-muted">{st.label}</dt>
                <dd className={`tabular mt-1 truncate text-lg font-semibold tracking-[-0.02em] md:text-xl ${st.tone}`}>{f.money(st.cents, { whole: true, compact: Math.abs(st.cents) >= 10_000_000_00 })}</dd>
                {st.share !== null && (
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                    <div className="animate-grow h-full rounded-full bg-brand-gradient" style={{ width: `${Math.min(100, Math.max(0, st.share * 100))}%` }} />
                  </div>
                )}
              </div>
            ))}
          </dl>
        </div>
        <div className="-mx-1 mt-5 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] md:flex-wrap md:overflow-visible">
          {moves.map((c) => (
            <span key={c.label} className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border bg-surface/70 py-1 pr-1 pl-3 text-xs backdrop-blur">
              <span className="font-medium text-muted">{c.label}</span>
              <Delta value={c.deltaCents} pill>
                {f.money(c.deltaCents, { whole: true, signed: true, compact: Math.abs(c.deltaCents) >= 100_000_00 })}
                {c.deltaPct !== null && <span className="font-medium opacity-80"> {c.deltaPct >= 0 ? "+" : ""}{c.deltaPct.toFixed(1)}%</span>}
              </Delta>
            </span>
          ))}
        </div>
        <div className="mt-6 md:mt-8">
          <NetWorthPanel
            daily={daily.map((p) => ({ date: p.date, netCents: p.netCents }))}
            monthly={history.map((p) => ({ date: p.date, netCents: p.netCents }))}
          />
        </div>
      </Card>

      <div className="grid gap-5 md:gap-6 xl:grid-cols-12">
        {/* What moved */}
        <Card className="xl:col-span-7">
          <CardHeader title="What moved" subtitle="The accounts behind the change, biggest first" />
          <MoversCard moves={moves} />
        </Card>

        {/* Allocation */}
        <Card className="xl:col-span-5">
          <CardHeader title="Allocation" subtitle="Gross assets by class, your share" action={<ButtonLink href="/accounts" size="sm" variant="ghost">Accounts <ArrowRight size={14} /></ButtonLink>} />
          <div className="flex flex-col items-center gap-6 sm:flex-row xl:flex-col 2xl:flex-row">
            <AllocationDonut slices={classes} />
            <ul className="w-full space-y-1 text-sm">
              {classes
                .filter((c) => c.cents > 0)
                .sort((a, b) => b.cents - a.cents)
                .map((c) => {
                  const pct = nw.assetsCents ? (c.cents / nw.assetsCents) * 100 : 0;
                  return (
                    <li key={c.key} className="rounded-xl px-2 py-1.5 hover:bg-surface-2">
                      <div className="flex items-center gap-2">
                        <SeriesDot slot={c.slot} />
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        <span className="tabular text-xs text-muted">{pct.toFixed(1)}%</span>
                        <span className="tabular w-28 text-right font-medium">{f.money(c.cents, { whole: true })}</span>
                      </div>
                      <div className="mt-1.5 ml-4.5 h-1 overflow-hidden rounded-full bg-surface-2">
                        <div className="animate-grow h-full rounded-full" style={{ width: `${pct}%`, background: `var(--series-${c.slot})` }} />
                      </div>
                    </li>
                  );
                })}
              {nw.liabilitiesCents > 0 && (
                <li className="flex items-center gap-2 px-2 py-1.5">
                  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-border-strong" aria-hidden />
                  <span className="flex-1 text-ink-2">Liabilities</span>
                  <span className="tabular w-28 text-right font-medium text-critical-text">{f.money(-nw.liabilitiesCents, { whole: true })}</span>
                </li>
              )}
            </ul>
          </div>
        </Card>

        {/* Cash flow */}
        <Card className="xl:col-span-7">
          <CardHeader title="Cash flow" subtitle="Income vs expenses, last 6 months (transfers excluded)" action={<ButtonLink href="/transactions" size="sm" variant="ghost">Transactions <ArrowRight size={14} /></ButtonLink>} />
          <CashflowChart months={o.cashflow} />
        </Card>

        {/* Needs attention */}
        <Card className="xl:col-span-5">
          <CardHeader title="Needs attention" subtitle={o.nudges.length ? `${o.nudges.length} item${o.nudges.length > 1 ? "s" : ""}` : "All caught up"} />
          {o.nudges.length === 0 ? (
            <div className="flex items-center gap-3 rounded-xl bg-surface-2/60 px-4 py-5 text-sm text-ink-2">
              <CheckCircle2 size={20} className="shrink-0 text-gain" aria-hidden />
              Balances fresh, transactions categorized, budgets on track.
            </div>
          ) : (
            <ul className="-mx-2 space-y-0.5">
              {o.nudges.slice(0, 7).map((n, i) => {
                const Icon = NUDGE_ICON[n.kind];
                const critical = n.kind === "over_budget";
                return (
                  <li key={i}>
                    <Link href={n.href} className="group flex items-center gap-3 rounded-xl px-2 py-2 text-sm transition hover:bg-surface-2">
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${critical ? "bg-[color-mix(in_srgb,var(--loss)_12%,transparent)] text-critical-text" : "bg-surface-2 text-ink-2 group-hover:bg-surface"}`}>
                        <Icon size={15} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">{n.text}</span>
                      <ArrowRight size={14} className="shrink-0 text-muted transition group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* This month */}
        <Card className={goals.length ? "xl:col-span-7" : "xl:col-span-12"}>
          <CardHeader
            title={`Budget · ${formatMonth(budget.month)}`}
            subtitle={`${Math.round(budget.elapsed * 100)}% of the month gone`}
            action={<ButtonLink href="/budgets" size="sm" variant="ghost">Budgets <ArrowRight size={14} /></ButtonLink>}
          />
          <div className="mb-6 grid grid-cols-3 gap-4 rounded-xl bg-surface-2/50 p-4">
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
            <ul className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
              {budgeted.slice(0, 8).map((l) => (
                <li key={l.categoryId}>
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">
                      {l.icon} {l.name}
                      {l.status === "over" && <span className="ml-2"><Badge tone="critical">over</Badge></span>}
                      {l.status === "ahead_of_pace" && <span className="ml-2"><Badge tone="warning">fast</Badge></span>}
                    </span>
                    <span className="tabular shrink-0 text-ink-2">
                      {f.money(l.spentCents, { whole: true, currency: l.currency })} <span className="text-muted">/ {f.money(l.budgetCents!, { whole: true, currency: l.currency })}</span>
                    </span>
                  </div>
                  <Meter pct={l.pct ?? 0} status={l.status === "unbudgeted" ? "ok" : l.status} pace={budget.elapsed} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {goals.length > 0 && (
          <Card className="xl:col-span-5">
            <CardHeader title="Goals" action={<ButtonLink href="/goals" size="sm" variant="ghost">Goals <ArrowRight size={14} /></ButtonLink>} />
            <ul className="space-y-4">
              {goals.map((g) => (
                <li key={g.id}>
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-medium">
                      {g.icon} {g.name}
                      {g.onTrack === false && <span className="ml-2"><Badge tone="warning">behind</Badge></span>}
                    </span>
                    <span className="tabular shrink-0 text-ink-2">
                      {f.money(g.currentCents, { currency: g.currency, whole: true })}
                      <span className="text-muted"> / {f.money(g.targetCents, { currency: g.currency, whole: true })}</span>
                    </span>
                  </div>
                  <Meter pct={g.pct} status={g.onTrack === false ? "ahead_of_pace" : "ok"} />
                </li>
              ))}
            </ul>
          </Card>
        )}

        {o.upcoming.length > 0 && (
          <Card className="xl:col-span-12">
            <CardHeader
              title="Upcoming reminders"
              action={<ButtonLink href="/reminders" size="sm" variant="ghost">Reminders <ArrowRight size={14} /></ButtonLink>}
            />
            <ul className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
              {o.upcoming.map((r) => (
                <li key={r.id} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface-2/50 px-3 py-2.5 text-sm">
                  <Bell size={14} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span className="shrink-0 text-xs text-muted">{r.nextNagAt ? "waiting for ✅" : r.schedule}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
