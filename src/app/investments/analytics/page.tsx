import { DateTime } from "luxon";
import {
  investmentAnalytics,
  type Slice,
} from "@/server/services/investment-analytics";
import { serverFormat } from "@/server/format";
import {
  INVESTMENT_TABS,
  holdingTypeLabel,
} from "@/components/investments-model";
import type { HoldingType } from "@/lib/domain";
import {
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  SeriesDot,
  Stat,
  ViewTabs,
} from "@/components/ui";
import {
  AllocationDonut,
  DrawdownChart,
  IndexChart,
  MonthlyReturns,
  NetWorthChart,
  Sparkline,
} from "@/components/charts";
import { requireUser } from "@/server/session";
import { CountUp } from "@/components/count-up";

export const dynamic = "force-dynamic";
export const metadata = { title: "Investment analytics" };

const pct = (v: number | null, digits = 1) =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
const tone = (v: number | null) =>
  v === null ? "text-muted" : v >= 0 ? "text-good-text" : "text-critical-text";
const day = (d: string) => DateTime.fromISO(d).toFormat("d LLL yyyy");

function AllocationCard({
  title,
  slices,
  label,
}: {
  title: string;
  slices: Slice[];
  label?: (s: Slice) => string;
}) {
  const f = (s: Slice) => (label ? label(s) : s.label);
  return (
    <Card>
      <CardHeader title={title} />
      <div className="flex flex-col items-center gap-4 sm:flex-row xl:flex-col">
        <AllocationDonut
          size={120}
          slices={slices.map((s, i) => ({
            key: s.key,
            label: f(s),
            cents: s.cents,
            slot: (i % 8) + 1,
          }))}
        />
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
    <div className="space-y-5 md:space-y-6">
      <PageHeader
        title="Investments"
        subtitle="How the portfolio you hold today has done: returns, risk and where it sits"
        actions={
          <ViewTabs
            label="Investments views"
            current="/investments/analytics"
            tabs={INVESTMENT_TABS}
          />
        }
      />

      {a.holdings.length === 0 ? (
        <EmptyState title="No positions yet">
          Add holdings on the Holdings tab; analytics follow from their daily
          prices.
        </EmptyState>
      ) : (
        <>
          {a.broker && a.broker.index.length > 1 && (
            <Card>
              <CardHeader
                title="Your real return"
                subtitle={`From your broker's own history since ${day(a.broker.since)}: time-weighted (deposits and withdrawals taken out), and money-weighted (what your timing earned)`}
              />
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
                <IndexChart points={a.broker.index} />
                <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <div className="rounded-xl bg-surface-2/60 p-4">
                    <div className="text-xs font-medium text-muted">
                      Time-weighted, since {day(a.broker.since)}
                    </div>
                    <div
                      className={`tabular mt-1 text-2xl font-semibold tracking-tight ${tone(a.broker.twrPct)}`}
                    >
                      {pct(a.broker.twrPct)}
                    </div>
                  </div>
                  <div className="rounded-xl bg-surface-2/60 p-4">
                    <div className="text-xs font-medium text-muted">
                      Money-weighted, a year
                    </div>
                    <div
                      className={`tabular mt-1 text-2xl font-semibold tracking-tight ${tone(a.broker.xirrPct)}`}
                    >
                      {pct(a.broker.xirrPct)}
                    </div>
                  </div>
                  <div className="rounded-xl bg-surface-2/60 p-4 sm:col-span-2 xl:col-span-1">
                    <div className="text-xs font-medium text-muted">
                      Money in → worth now
                    </div>
                    <div className="tabular mt-1 text-sm">
                      {f.money(a.broker.depositedCents, { whole: true })} →{" "}
                      <span className="font-semibold">
                        {f.money(a.broker.valueCents, { whole: true })}
                      </span>
                    </div>
                    <div
                      className={`tabular mt-0.5 text-sm font-semibold ${tone(a.broker.gainCents)}`}
                    >
                      {f.money(a.broker.gainCents, {
                        whole: true,
                        signed: true,
                      })}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 sm:col-span-2 xl:col-span-1">
                    {a.broker.periods.map((p) => (
                      <span
                        key={p.key}
                        className="rounded-lg border border-border px-2.5 py-1 text-center"
                      >
                        <span className="block text-[11px] text-muted">
                          {p.label}
                        </span>
                        <span
                          className={`tabular text-xs font-semibold ${tone(p.returnPct)}`}
                        >
                          {pct(p.returnPct)}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}

          <Card className="bg-hero">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-ink-2">
                  Today&apos;s holdings · {a.base}
                </div>
                <div className="display-lg tabular mt-1.5">
                  <CountUp cents={a.totalCents} opts={{ whole: true }} />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {a.periods.map((p) => (
                  <span
                    key={p.key}
                    className="rounded-lg bg-surface/70 px-3 py-1.5 text-center"
                  >
                    <span className="block text-xs text-muted">{p.label}</span>
                    <span
                      className={`tabular text-sm font-semibold ${tone(p.returnPct)}`}
                    >
                      {pct(p.returnPct)}
                    </span>
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
                {a.broker &&
                  "Your real return above comes from your broker's history. "}
                Per-position returns and risk need daily market prices for most
                of today's portfolio, and wallet doesn't have them yet. It is
                fetching a year of prices for{" "}
                {a.excluded.slice(0, 6).join(", ")}
                {a.excluded.length > 6
                  ? ` and ${a.excluded.length - 6} more`
                  : ""}
                ; the figures appear as soon as it has them.
              </p>
            )}
            <p className="mt-2 text-xs text-muted">
              Today&apos;s positions in {a.base} (exchange rates included)
              {a.enoughHistory &&
                `, since ${day(a.since)}, when ${a.coveragePct.toFixed(0)}% of today's portfolio had prices`}
              . It shows what these holdings did, not past trades.
              {a.enoughHistory &&
                a.excluded.length > 0 &&
                ` Not enough price history yet for ${a.excluded.join(", ")}.`}
            </p>
          </Card>

          {a.enoughHistory && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 2xl:grid-cols-6">
              <Card>
                <Stat
                  label="Volatility (annual)"
                  value={
                    a.volatilityPct === null
                      ? "—"
                      : `${a.volatilityPct.toFixed(1)}%`
                  }
                />
              </Card>
              <Card>
                <Stat
                  label="Max drawdown"
                  value={
                    <span className={tone(a.maxDrawdown?.pct ?? null)}>
                      {a.maxDrawdown
                        ? `${a.maxDrawdown.pct.toFixed(1)}%`
                        : "none"}
                    </span>
                  }
                  delta={
                    a.maxDrawdown && (
                      <span className="text-muted">
                        {a.maxDrawdown.recovered
                          ? `recovered ${day(a.maxDrawdown.recovered)}`
                          : "not recovered yet"}
                      </span>
                    )
                  }
                />
              </Card>
              <Card>
                <Stat
                  label="Return / risk"
                  value={a.sharpe === null ? "—" : a.sharpe.toFixed(2)}
                  delta={
                    <span className="text-muted">Sharpe, at 0% risk-free</span>
                  }
                />
              </Card>
              <Card>
                <Stat
                  label="Best day"
                  value={
                    <span className="text-good-text">
                      {a.bestDay ? pct(a.bestDay.pct, 2) : "—"}
                    </span>
                  }
                  delta={
                    a.bestDay && (
                      <span className="text-muted">{day(a.bestDay.date)}</span>
                    )
                  }
                />
              </Card>
              <Card>
                <Stat
                  label="Worst day"
                  value={
                    <span className="text-critical-text">
                      {a.worstDay ? pct(a.worstDay.pct, 2) : "—"}
                    </span>
                  }
                  delta={
                    a.worstDay && (
                      <span className="text-muted">{day(a.worstDay.date)}</span>
                    )
                  }
                />
              </Card>
              <Card>
                <Stat
                  label="Up days"
                  value={
                    a.upDaysPct === null ? "—" : `${a.upDaysPct.toFixed(0)}%`
                  }
                  delta={<span className="text-muted">of trading days</span>}
                />
              </Card>
            </div>
          )}

          <div
            className={
              a.enoughHistory ? "grid gap-5 md:gap-6 lg:grid-cols-2" : "grid"
            }
          >
            {a.enoughHistory && (
              <Card>
                <CardHeader
                  title="Drawdown"
                  subtitle="How far below its last peak, day by day"
                />
                <DrawdownChart points={a.drawdown} />
              </Card>
            )}
            <Card>
              <CardHeader
                title="Value of your investment accounts"
                subtitle="What they were actually worth (deposits and withdrawals included)"
              />
              <NetWorthChart
                points={a.actual}
                label="Value"
                height={a.enoughHistory ? 140 : 220}
              />
            </Card>
          </div>

          {a.monthly.length > 0 && (
            <Card>
              <CardHeader
                title="Month by month"
                subtitle="Return of today's positions in each month"
              />
              <MonthlyReturns months={a.monthly} />
            </Card>
          )}

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
                    <tr
                      key={h.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-2">
                        <div className="font-medium">{h.symbol ?? h.name}</div>
                        <div className="text-xs text-muted">
                          {h.symbol && h.name !== h.symbol
                            ? `${h.name} · `
                            : ""}
                          {holdingTypeLabel(h.assetType as HoldingType)} ·{" "}
                          {h.currency}
                        </div>
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 rounded-full bg-surface-2">
                            <div
                              className="h-full rounded-full bg-series-1"
                              style={{
                                width: `${Math.min(100, h.weightPct)}%`,
                              }}
                            />
                          </div>
                          <span className="tabular text-xs text-muted">
                            {h.weightPct.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      {(["1m", "3m", "ytd", "1y"] as const).map((k) => (
                        <td
                          key={k}
                          className={`tabular py-2 text-right ${tone(h.returns[k])}`}
                        >
                          {pct(h.returns[k])}
                        </td>
                      ))}
                      <td
                        className={`tabular py-2 text-right ${tone(h.contributionCents)}`}
                      >
                        {h.contributionCents === null
                          ? "—"
                          : f.money(h.contributionCents, {
                              whole: true,
                              signed: true,
                            })}
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
            <AllocationCard
              title="By type"
              slices={a.allocation.byType}
              label={(s) => holdingTypeLabel(s.key as HoldingType)}
            />
            <AllocationCard
              title="By currency"
              slices={a.allocation.byCurrency}
            />
            <AllocationCard title="By region" slices={a.allocation.byRegion} />
            <AllocationCard
              title="By account"
              slices={a.allocation.byAccount}
            />
          </div>
        </>
      )}
    </div>
  );
}
