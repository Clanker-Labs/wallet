import Link from "next/link";
import { DateTime } from "luxon";
import { investmentAnalytics, type Slice } from "@/server/services/investment-analytics";
import { serverFormat } from "@/server/format";
import { holdingTypeLabel } from "@/components/investments-model";
import type { HoldingType } from "@/lib/domain";
import { Card, CardHeader, EmptyState, PageHeader, SeriesDot, Stat } from "@/components/ui";
import { AllocationDonut, DrawdownChart, IndexChart, MonthlyReturns, NetWorthChart, Sparkline } from "@/components/charts";
import { requireUser } from "@/server/session";
import { CountUp } from "@/components/count-up";

export const dynamic = "force-dynamic";
export const metadata = { title: "Investment analytics" };

const pct = (v: number | null, digits = 1) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`);
const tone = (v: number | null) => (v === null ? "text-muted" : v >= 0 ? "text-good-text" : "text-critical-text");
const day = (d: string) => DateTime.fromISO(d).toFormat("d LLL yyyy");

function AllocationCard({ title, slices, label }: { title: string; slices: Slice[]; label?: (s: Slice) => string }) {
  const f = (s: Slice) => (label ? label(s) : s.label);
  return (
    <Card>
      <CardHeader title={title} />
      <div className="flex flex-col items-center gap-4 sm:flex-row xl:flex-col">
        <AllocationDonut size={120} slices={slices.map((s, i) => ({ key: s.key, label: f(s), cents: s.cents, slot: (i % 8) + 1 }))} />
        <ul className="w-full min-w-0 flex-1 space-y-1 text-sm">
          {slices.slice(0, 6).map((s, i) => (
            <li key={s.key} className="flex items-center gap-2">
              <SeriesDot slot={(i % 8) + 1} />
              <span className="min-w-0 flex-1 truncate">{f(s)}</span>
              <span className="tabular text-muted">{s.pct.toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export default async function InvestmentAnalyticsPage() {
  const uid = (await requireUser()).id;
  const f = serverFormat(uid);
  const a = investmentAnalytics(uid, { days: 365 });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Investments"
        subtitle="How the portfolio you hold today has done: returns, risk and where it sits"
        actions={
          <nav className="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5 text-sm" aria-label="Investments views">
            <Link href="/investments" className="rounded-md px-3 py-1 text-ink-2 hover:text-ink">
              Holdings
            </Link>
            <span className="rounded-md bg-surface px-3 py-1 font-medium text-ink shadow-sm" aria-current="page">
              Analytics
            </span>
          </nav>
        }
      />

      {a.holdings.length === 0 ? (
        <EmptyState title="No positions yet">Add holdings on the Holdings tab; analytics follow from their daily prices.</EmptyState>
      ) : (
        <>
          <Card className="bg-hero">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-sm text-muted">Portfolio · {a.base}</div>
                <div className="tabular text-4xl font-semibold tracking-tight">
                  <CountUp cents={a.totalCents} opts={{ whole: true }} />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {a.periods.map((p) => (
                  <span key={p.key} className="rounded-lg bg-surface/70 px-3 py-1.5 text-center">
                    <span className="block text-xs text-muted">{p.label}</span>
                    <span className={`tabular text-sm font-semibold ${tone(p.returnPct)}`}>{pct(p.returnPct)}</span>
                  </span>
                ))}
              </div>
            </div>
            {a.enoughHistory ? (
              <div className="mt-5">
                <IndexChart points={a.index} />
              </div>
            ) : (
              <p className="mt-5 rounded-lg bg-surface/70 px-4 py-6 text-center text-sm text-ink-2">
                Not enough price history yet for most of your portfolio to measure returns and risk honestly. wallet is fetching a year of prices
                for {a.excluded.slice(0, 6).join(", ")}
                {a.excluded.length > 6 ? ` and ${a.excluded.length - 6} more` : ""}; the figures appear as soon as it has them.
              </p>
            )}
            <p className="mt-2 text-xs text-muted">
              Today&apos;s positions in {a.base} (exchange rates included){a.enoughHistory && `, since ${day(a.since)}, when ${a.coveragePct.toFixed(0)}% of today's portfolio had prices`}.
              It shows what these holdings did, not past trades.
              {a.enoughHistory && a.excluded.length > 0 && ` Not enough price history yet for ${a.excluded.join(", ")}.`}
            </p>
          </Card>

          <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-6">
            <Card>
              <Stat label="Volatility (annual)" value={a.volatilityPct === null ? "—" : `${a.volatilityPct.toFixed(1)}%`} />
            </Card>
            <Card>
              <Stat
                label="Max drawdown"
                value={<span className={tone(a.maxDrawdown?.pct ?? null)}>{a.maxDrawdown ? `${a.maxDrawdown.pct.toFixed(1)}%` : "none"}</span>}
                delta={a.maxDrawdown && <span className="text-muted">{a.maxDrawdown.recovered ? `recovered ${day(a.maxDrawdown.recovered)}` : "not recovered yet"}</span>}
              />
            </Card>
            <Card>
              <Stat label="Return / risk" value={a.sharpe === null ? "—" : a.sharpe.toFixed(2)} delta={<span className="text-muted">Sharpe, at 0% risk-free</span>} />
            </Card>
            <Card>
              <Stat label="Best day" value={<span className="text-good-text">{a.bestDay ? pct(a.bestDay.pct, 2) : "—"}</span>} delta={a.bestDay && <span className="text-muted">{day(a.bestDay.date)}</span>} />
            </Card>
            <Card>
              <Stat label="Worst day" value={<span className="text-critical-text">{a.worstDay ? pct(a.worstDay.pct, 2) : "—"}</span>} delta={a.worstDay && <span className="text-muted">{day(a.worstDay.date)}</span>} />
            </Card>
            <Card>
              <Stat label="Up days" value={a.upDaysPct === null ? "—" : `${a.upDaysPct.toFixed(0)}%`} delta={<span className="text-muted">of trading days</span>} />
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Drawdown" subtitle="How far below its last peak, day by day" />
              <DrawdownChart points={a.drawdown} />
            </Card>
            <Card>
              <CardHeader title="Value of your investment accounts" subtitle="What they were actually worth (deposits and withdrawals included)" />
              <NetWorthChart points={a.actual} label="Value" height={140} />
            </Card>
          </div>

          <Card>
            <CardHeader title="Month by month" subtitle="Return of today's positions in each month" />
            {a.monthly.length ? <MonthlyReturns months={a.monthly} /> : <p className="text-sm text-ink-2">A month of prices is needed.</p>}
          </Card>

          <Card>
            <CardHeader
              title="Positions"
              subtitle={
                a.concentration
                  ? `Largest ${a.concentration.top1Pct.toFixed(0)}% · top 5 ${a.concentration.top5Pct.toFixed(0)}% · as diversified as ${a.concentration.effectiveHoldings} equal positions`
                  : undefined
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-border">
                    <th className="py-2 text-left font-normal">Position</th>
                    <th className="py-2 text-left font-normal">Weight</th>
                    <th className="py-2 text-right font-normal">1M</th>
                    <th className="py-2 text-right font-normal">3M</th>
                    <th className="py-2 text-right font-normal">YTD</th>
                    <th className="py-2 text-right font-normal">1Y</th>
                    <th className="py-2 text-right font-normal">1Y change</th>
                    <th className="py-2 pl-4 text-left font-normal">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {a.holdings.map((h) => (
                    <tr key={h.id} className="border-b border-border last:border-0">
                      <td className="py-2">
                        <div className="font-medium">{h.symbol ?? h.name}</div>
                        <div className="text-xs text-muted">
                          {h.symbol && h.name !== h.symbol ? `${h.name} · ` : ""}
                          {holdingTypeLabel(h.assetType as HoldingType)} · {h.currency}
                        </div>
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 rounded-full bg-surface-2">
                            <div className="h-full rounded-full bg-series-1" style={{ width: `${Math.min(100, h.weightPct)}%` }} />
                          </div>
                          <span className="tabular text-xs text-muted">{h.weightPct.toFixed(1)}%</span>
                        </div>
                      </td>
                      {(["1m", "3m", "ytd", "1y"] as const).map((k) => (
                        <td key={k} className={`tabular py-2 text-right ${tone(h.returns[k])}`}>
                          {pct(h.returns[k])}
                        </td>
                      ))}
                      <td className={`tabular py-2 text-right ${tone(h.contributionCents)}`}>
                        {h.contributionCents === null ? "—" : f.money(h.contributionCents, { whole: true, signed: true })}
                      </td>
                      <td className="py-2 pl-4">
                        <Sparkline values={h.spark} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <AllocationCard title="By type" slices={a.allocation.byType} label={(s) => holdingTypeLabel(s.key as HoldingType)} />
            <AllocationCard title="By currency" slices={a.allocation.byCurrency} />
            <AllocationCard title="By region" slices={a.allocation.byRegion} />
            <AllocationCard title="By account" slices={a.allocation.byAccount} />
          </div>
        </>
      )}
    </div>
  );
}
