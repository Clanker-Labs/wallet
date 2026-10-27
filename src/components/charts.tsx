"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useId } from "react";
import { DateTime } from "luxon";
import { useFormat } from "./format";

/*
 * Chart conventions: 2px lines, ~10% area wash, hairline solid grid, thin bars
 * (≤24px) with rounded data-ends, a legend for ≥2 series, values-first tooltips.
 * Colors come from CSS variables so dark mode uses its own validated steps.
 */

/** Charts draw in once (650 ms), unless the system asks for reduced motion. */
const motion = () => ({
  isAnimationActive: typeof window !== "undefined" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  animationDuration: 650,
  animationEasing: "ease-out" as const,
});

const AXIS = { stroke: "var(--axis)", tick: { fill: "var(--muted)", fontSize: 11 }, tickLine: false } as const;

interface TooltipRow {
  label: string;
  value: string;
  color: string;
  kind?: "line" | "rect";
}

function TooltipBox({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-muted">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 py-0.5">
          <span
            className={r.kind === "rect" ? "h-2.5 w-2.5 rounded-sm" : "h-0.5 w-3 rounded"}
            style={{ background: r.color }}
            aria-hidden
          />
          <span className="tabular font-semibold text-ink">{r.value}</span>
          <span className="text-ink-2">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; kind?: "line" | "rect" }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span
            className={i.kind === "line" ? "h-0.5 w-3 rounded" : "h-2.5 w-2.5 rounded-sm"}
            style={{ background: i.color }}
            aria-hidden
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

const shortMonth = (iso: string) => DateTime.fromISO(iso).toFormat("LLL yy");
const shortDay = (iso: string) => DateTime.fromISO(iso).toFormat("d LLL");

// ── Net worth over time ──────────────────────────────────────────────────

export function NetWorthChart({
  points,
  height = 260,
  label = "Net worth",
  dayTicks = false,
}: {
  points: { date: string; netCents: number }[];
  height?: number;
  /** Series name in the tooltip (e.g. "Balance" on an account page). */
  label?: string;
  /** Label the axis with days ("12 Oct") instead of months, for short ranges. */
  dayTicks?: boolean;
}) {
  const f = useFormat();
  const fillId = `nw-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const data = points.map((p) => ({ date: p.date, net: p.netCents / 100 }));
  // A flat series (e.g. a single balance) would get identical ticks: pad the axis around it.
  const values = data.map((d) => d.net);
  const flat = values.length > 0 && Math.max(...values) === Math.min(...values);
  const pad = flat ? Math.max(Math.abs(values[0]) * 0.2, 100) : 0;
  // On a narrow range, compact labels ("$2.5K") collide: show whole amounts instead.
  const spread = values.length ? Math.max(...values) - Math.min(...values) : 0;
  const peak = values.length ? Math.max(...values.map(Math.abs)) : 0;
  const compact = flat || spread >= peak * 0.25;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="3 4" />
        <XAxis dataKey="date" {...AXIS} tickFormatter={dayTicks ? shortDay : shortMonth} minTickGap={24} />
        <YAxis
          {...AXIS}
          axisLine={false}
          width={compact ? 64 : 80}
          tickFormatter={(v) => (compact ? f.units(v, { compact: true }) : f.units(v, { whole: true }))}
          domain={flat ? [Math.max(0, values[0] - pad), values[0] + pad] : ["auto", "auto"]}
        />
        <Tooltip
          cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                title={DateTime.fromISO(String(payload[0].payload.date)).toFormat("d LLL yyyy")}
                rows={[{ label, value: f.units(Number(payload[0].value), { whole: true }), color: "var(--series-1)" }]}
              />
            ) : null
          }
        />
        <Area
          type="monotone"
          dataKey="net"
          stroke="var(--series-1)"
          strokeWidth={2.25}
          fill={`url(#${fillId})`}
          activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2.5 }}
          {...motion()}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Allocation donut ─────────────────────────────────────────────────────

export interface Slice {
  key: string;
  label: string;
  cents: number;
  slot: number;
}

export function AllocationDonut({ slices, size = 180 }: { slices: Slice[]; size?: number }) {
  const f = useFormat();
  const data = slices.filter((s) => s.cents > 0);
  const total = data.reduce((s, x) => s + x.cents, 0);
  if (!total) return null;
  return (
    <div style={{ width: size, height: size }} className="shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="cents"
            nameKey="label"
            innerRadius="68%"
            outerRadius="100%"
            paddingAngle={data.length > 1 ? 1.5 : 0}
            stroke="var(--surface)"
            strokeWidth={data.length > 1 ? 2 : 0}
            {...motion()}
          >
            {data.map((s) => (
              <Cell key={s.key} fill={`var(--series-${s.slot})`} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={String(payload[0].name)}
                  rows={[
                    {
                      label: `${((Number(payload[0].value) / total) * 100).toFixed(1)}%`,
                      value: f.money(Number(payload[0].value), { whole: true }),
                      color: `var(--series-${(payload[0].payload as Slice).slot})`,
                      kind: "rect",
                    },
                  ]}
                />
              ) : null
            }
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Cash flow (income vs expenses) ───────────────────────────────────────

export function CashflowChart({
  months,
  height = 220,
  currency,
}: {
  months: { month: string; incomeCents: number; expensesCents: number }[];
  height?: number;
  /** Currency the amounts are in (default: the base currency). */
  currency?: string;
}) {
  const base = useFormat();
  const f = { ...base, units: (v: number, o: Parameters<typeof base.units>[1] = {}) => base.units(v, { ...(currency ? { currency } : {}), ...o }) };
  const data = months.map((m) => ({ month: m.month, income: m.incomeCents / 100, expenses: m.expensesCents / 100 }));
  return (
    <div>
      <Legend
        items={[
          { label: "Income", color: "var(--series-1)" },
          { label: "Expenses", color: "var(--series-2)" },
        ]}
      />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 12, right: 4, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="month" {...AXIS} tickFormatter={(m) => DateTime.fromISO(`${m}-01`).toFormat("LLL")} />
          <YAxis {...AXIS} axisLine={false} width={56} tickFormatter={(v) => f.units(v, { compact: true })} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={DateTime.fromISO(`${label}-01`).toFormat("LLLL yyyy")}
                  rows={[
                    { label: "Income", value: f.units(Number(payload[0].payload.income), { whole: true }), color: "var(--series-1)", kind: "rect" },
                    { label: "Expenses", value: f.units(Number(payload[0].payload.expenses), { whole: true }), color: "var(--series-2)", kind: "rect" },
                    {
                      label: "Saved",
                      value: f.units(Number(payload[0].payload.income) - Number(payload[0].payload.expenses), { whole: true, signed: true }),
                      color: "transparent",
                    },
                  ]}
                />
              ) : null
            }
          />
          <Bar dataKey="income" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={20} {...motion()} />
          <Bar dataKey="expenses" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={20} {...motion()} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Generic multi-line chart over years (simulations) ────────────────────

export interface LineSeries {
  key: string;
  label: string;
  slot: number;
}

export function YearLines({
  data,
  series,
  height = 280,
  xLabel = (x: number) => `Y${x}`,
  referenceY,
}: {
  data: Record<string, number>[];
  series: LineSeries[];
  height?: number;
  xLabel?: (x: number) => string;
  referenceY?: { value: number; label: string };
}) {
  const f = useFormat();
  return (
    <div>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.label, color: `var(--series-${s.slot})`, kind: "line" }))} />}
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="year" {...AXIS} tickFormatter={xLabel} minTickGap={16} />
          <YAxis {...AXIS} axisLine={false} width={64} tickFormatter={(v) => f.units(v, { compact: true })} />
          {referenceY && (
            <ReferenceLine
              y={referenceY.value}
              stroke="var(--muted)"
              strokeDasharray="4 4"
              label={{ value: referenceY.label, fill: "var(--muted)", fontSize: 11, position: "insideTopLeft" }}
            />
          )}
          <Tooltip
            cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={xLabel(Number(label))}
                  rows={series.map((s) => ({
                    label: s.label,
                    value: f.units(Number(payload[0].payload[s.key] ?? 0), { whole: true }),
                    color: `var(--series-${s.slot})`,
                  }))}
                />
              ) : null
            }
          />
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={`var(--series-${s.slot})`}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
              {...motion()}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Projection with Monte Carlo band ─────────────────────────────────────

export function ProjectionChart({
  points,
  fiTarget,
  height = 300,
}: {
  points: { year: number; nominal: number; real: number; p10?: number; p90?: number }[];
  fiTarget?: number | null;
  height?: number;
}) {
  const f = useFormat();
  const hasBand = points.some((p) => p.p10 !== undefined);
  const data = points.map((p) => ({ ...p, band: hasBand ? [p.p10 ?? p.nominal, p.p90 ?? p.nominal] : undefined }));
  return (
    <div>
      <Legend
        items={[
          { label: "Expected", color: "var(--series-1)", kind: "line" },
          { label: "In today's money", color: "var(--series-3)", kind: "line" },
          ...(hasBand ? [{ label: "10–90% range", color: "color-mix(in srgb, var(--series-1) 25%, transparent)" }] : []),
        ]}
      />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="year" {...AXIS} tickFormatter={(y) => `+${y}y`} minTickGap={16} />
          <YAxis {...AXIS} axisLine={false} width={64} tickFormatter={(v) => f.units(v, { compact: true })} />
          {fiTarget ? (
            <ReferenceLine
              y={fiTarget}
              stroke="var(--muted)"
              strokeDasharray="4 4"
              label={{ value: "FI target", fill: "var(--muted)", fontSize: 11, position: "insideTopLeft" }}
            />
          ) : null}
          <Tooltip
            cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as (typeof data)[number];
              const rows: TooltipRow[] = [
                { label: "Expected", value: f.units(p.nominal, { whole: true }), color: "var(--series-1)" },
                { label: "Today's money", value: f.units(p.real, { whole: true }), color: "var(--series-3)" },
              ];
              if (p.p10 !== undefined && p.p90 !== undefined) {
                rows.push({ label: "Pessimistic (p10)", value: f.units(p.p10, { whole: true }), color: "transparent" });
                rows.push({ label: "Optimistic (p90)", value: f.units(p.p90, { whole: true }), color: "transparent" });
              }
              return <TooltipBox title={`In ${label} years`} rows={rows} />;
            }}
          />
          {hasBand && <Area dataKey="band" stroke="none" fill="var(--series-1)" fillOpacity={0.12} {...motion()} />}
          <Line type="monotone" dataKey="nominal" stroke="var(--series-1)" strokeWidth={2} dot={false} {...motion()} />
          <Line type="monotone" dataKey="real" stroke="var(--series-3)" strokeWidth={2} dot={false} {...motion()} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Stacked yearly bars (e.g. principal vs interest) ─────────────────────

export function StackedYears({
  data,
  series,
  height = 240,
}: {
  data: Record<string, number>[];
  series: LineSeries[];
  height?: number;
}) {
  const f = useFormat();
  return (
    <div>
      <Legend items={series.map((s) => ({ label: s.label, color: `var(--series-${s.slot})` }))} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 12, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="year" {...AXIS} tickFormatter={(y) => `Y${y}`} minTickGap={12} />
          <YAxis {...AXIS} axisLine={false} width={56} tickFormatter={(v) => f.units(v, { compact: true })} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={`Year ${label}`}
                  rows={series.map((s) => ({
                    label: s.label,
                    value: f.units(Number(payload[0].payload[s.key] ?? 0), { whole: true }),
                    color: `var(--series-${s.slot})`,
                    kind: "rect",
                  }))}
                />
              ) : null
            }
          />
          {series.map((s, idx) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="a"
              fill={`var(--series-${s.slot})`}
              stroke="var(--surface)"
              strokeWidth={1}
              maxBarSize={24}
              radius={idx === series.length - 1 ? [4, 4, 0, 0] : undefined}
              {...motion()}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal bars as plain HTML (one series, one color), value at the tip. */
export function HBarList({ items, currency }: { items: { label: string; icon?: string | null; cents: number; hint?: string }[]; currency?: string }) {
  const base = useFormat();
  const f = { ...base, money: (c: number, o: Parameters<typeof base.money>[1] = {}) => base.money(c, { ...(currency ? { currency } : {}), ...o }) };
  const max = Math.max(...items.map((i) => i.cents), 1);
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.label} className="text-sm" title={i.hint}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate text-ink-2">
              {i.icon && <span className="mr-1.5">{i.icon}</span>}
              {i.label}
            </span>
            <span className="tabular shrink-0 font-medium">{f.money(i.cents, { whole: true })}</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${(i.cents / max) * 100}%`, background: "var(--series-1)" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Daily change (net worth moves, one bar per day) ──────────────────────

export function DailyChangeChart({ points, height = 260 }: { points: { date: string; deltaCents: number }[]; height?: number }) {
  const f = useFormat();
  const data = points.map((p) => ({ date: p.date, delta: p.deltaCents / 100 }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="12%">
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="date" {...AXIS} tickFormatter={shortDay} minTickGap={24} />
        <YAxis {...AXIS} axisLine={false} width={64} tickFormatter={(v) => f.units(v, { compact: true })} />
        <ReferenceLine y={0} stroke="var(--axis)" />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                title={DateTime.fromISO(String(payload[0].payload.date)).toFormat("cccc d LLL yyyy")}
                rows={[
                  {
                    label: "that day",
                    value: f.units(Number(payload[0].value), { whole: true, signed: true }),
                    color: Number(payload[0].value) >= 0 ? "var(--good)" : "var(--critical)",
                    kind: "rect",
                  },
                ]}
              />
            ) : null
          }
        />
        <Bar dataKey="delta" maxBarSize={14} radius={[2, 2, 2, 2]} {...motion()}>
          {data.map((d) => (
            <Cell key={d.date} fill={d.delta >= 0 ? "var(--good)" : "var(--critical)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Gratuity accrual (accrued so far, projected if you stay) ─────────────

export function AccrualChart({
  points,
  currency,
  height = 200,
}: {
  points: { date: string; accrued?: number; projected?: number }[];
  /** The job's own currency (gratuity is owed in it). */
  currency: string;
  height?: number;
}) {
  const f = useFormat();
  const fmt = (v: number, compact = false) => f.units(v, { currency, whole: true, compact });
  const hasProjection = points.some((p) => p.projected !== undefined);
  return (
    <div>
      {hasProjection && (
        <Legend
          items={[
            { label: "Accrued", color: "var(--series-3)", kind: "line" },
            { label: "If you stay", color: "color-mix(in srgb, var(--series-3) 55%, transparent)", kind: "line" },
          ]}
        />
      )}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="date" {...AXIS} tickFormatter={shortMonth} minTickGap={32} />
          <YAxis {...AXIS} axisLine={false} width={64} tickFormatter={(v) => fmt(v, true)} />
          <Tooltip
            cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as (typeof points)[number];
              const rows: TooltipRow[] = [];
              if (p.accrued !== undefined) rows.push({ label: "accrued", value: fmt(p.accrued), color: "var(--series-3)" });
              else if (p.projected !== undefined) rows.push({ label: "if you stay", value: fmt(p.projected), color: "var(--series-3)" });
              return <TooltipBox title={DateTime.fromISO(p.date).toFormat("d LLL yyyy")} rows={rows} />;
            }}
          />
          <Area type="linear" dataKey="accrued" stroke="var(--series-3)" strokeWidth={2} fill="var(--series-3)" fillOpacity={0.1} dot={false} {...motion()} />
          {hasProjection && (
            <Line type="linear" dataKey="projected" stroke="var(--series-3)" strokeOpacity={0.55} strokeWidth={2} strokeDasharray="5 4" dot={false} {...motion()} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Performance index (rebased to 100) and drawdown ──────────────────────

/** A rebased index (100 = start): the axis reads as a % change. */
export function IndexChart({ points, height = 240 }: { points: { date: string; value: number }[]; height?: number }) {
  const up = (points.at(-1)?.value ?? 100) >= 100;
  const color = up ? "var(--good)" : "var(--critical)";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="date" {...AXIS} tickFormatter={shortMonth} minTickGap={32} />
        <YAxis {...AXIS} axisLine={false} width={48} domain={["auto", "auto"]} tickFormatter={(v) => `${v - 100 >= 0 ? "+" : ""}${Math.round(v - 100)}%`} />
        <ReferenceLine y={100} stroke="var(--axis)" strokeDasharray="3 3" />
        <Tooltip
          cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                title={DateTime.fromISO(String(payload[0].payload.date)).toFormat("d LLL yyyy")}
                rows={[{ label: "since start", value: `${Number(payload[0].value) - 100 >= 0 ? "+" : ""}${(Number(payload[0].value) - 100).toFixed(2)}%`, color }]}
              />
            ) : null
          }
        />
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={color} fillOpacity={0.08} dot={false} {...motion()} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function DrawdownChart({ points, height = 140 }: { points: { date: string; pct: number }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="date" {...AXIS} tickFormatter={shortMonth} minTickGap={32} />
        <YAxis {...AXIS} axisLine={false} width={48} domain={["dataMin", 0]} tickFormatter={(v) => `${Math.round(v)}%`} />
        <Tooltip
          cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                title={DateTime.fromISO(String(payload[0].payload.date)).toFormat("d LLL yyyy")}
                rows={[{ label: "below the peak", value: `${Number(payload[0].value).toFixed(2)}%`, color: "var(--critical)" }]}
              />
            ) : null
          }
        />
        <Area type="monotone" dataKey="pct" stroke="var(--critical)" strokeWidth={1.5} fill="var(--critical)" fillOpacity={0.15} dot={false} {...motion()} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Tiny trend line for a table row. Gaps (no price yet) are skipped. */
export function Sparkline({ values, width = 88, height = 24 }: { values: number[]; width?: number; height?: number }) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return <span className="text-xs text-muted">—</span>;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1)) * width},${height - 2 - ((x - min) / span) * (height - 4)}`).join(" ");
  const up = v.at(-1)! >= v[0];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Trend ${up ? "up" : "down"} ${(((v.at(-1)! - v[0]) / v[0]) * 100).toFixed(1)}%`}>
      <polyline points={pts} fill="none" stroke={up ? "var(--good)" : "var(--critical)"} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Months × years grid of returns, coloured by size (capped at ±10%). */
export function MonthlyReturns({ months }: { months: { month: string; pct: number }[] }) {
  const years = [...new Set(months.map((m) => m.month.slice(0, 4)))].sort();
  const byKey = new Map(months.map((m) => [m.month, m.pct]));
  const names = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  const cell = (pct: number | undefined) => {
    if (pct === undefined) return { background: "var(--surface-2)" };
    const a = Math.min(1, Math.abs(pct) / 10) * 0.85 + 0.1;
    return { background: `color-mix(in srgb, ${pct >= 0 ? "var(--good)" : "var(--critical)"} ${Math.round(a * 100)}%, var(--surface))` };
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-xs">
        <thead>
          <tr>
            <th />
            {names.map((n, i) => (
              <th key={i} className="font-normal text-muted">
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((y) => (
            <tr key={y}>
              <th className="pr-1 text-left font-normal text-muted">{y}</th>
              {names.map((_, i) => {
                const k = `${y}-${String(i + 1).padStart(2, "0")}`;
                const pct = byKey.get(k);
                return (
                  <td key={k} className="tabular h-8 min-w-9 rounded-md text-center text-ink" style={cell(pct)} title={pct === undefined ? undefined : `${k}: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}>
                    {pct === undefined ? "" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
