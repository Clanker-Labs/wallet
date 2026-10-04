"use client";

import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { projectNetWorth, projectionInputSchema } from "@/lib/finance/projection";
import { Button, Card, CardHeader, Stat } from "./ui";
import { ProjectionChart } from "./charts";
import { useFormat } from "./format";
import {
  Advanced,
  Chips,
  DataHint,
  NumField,
  NumberInput,
  fmtPct,
  issuesToErrors,
  useCurrencySymbol,
  useDebounced,
  useLastValid,
  type Num,
} from "./sim-fields";
import {
  PROJECTION_DEFAULTS,
  eventsInput,
  type DataDefaults,
  type EventRow,
  type ProjectionKey,
  type ProjectionState,
} from "./sim-model";

const CURRENT_YEAR = new Date().getFullYear();

export function ProjectionTab({
  state,
  setField,
  events,
  setEvents,
  data,
  save,
}: {
  state: ProjectionState;
  setField: (k: ProjectionKey, v: Num) => void;
  events: EventRow[];
  setEvents: (rows: EventRow[]) => void;
  data: DataDefaults;
  save: ReactNode;
}) {
  const f = useFormat();
  const cur = useCurrencySymbol();
  const money = (n: number) => f.units(n, { whole: true });
  const compactMoney = (n: number) => f.units(n, { compact: true });
  const pct = (n: number, d = 1) => fmtPct(f.locale, n, d);

  const input = useMemo(() => ({ ...state, events: eventsInput(events) }), [state, events]);
  const parsed = useMemo(() => projectionInputSchema.safeParse(input), [input]);
  const errors = parsed.success ? {} : issuesToErrors(parsed.error.issues);

  // Deterministic path: instant. Monte Carlo (400 paths): on a debounced copy.
  const quick = useMemo(() => (parsed.success ? projectNetWorth({ ...parsed.data, simulations: 0 }) : null), [parsed]);
  const debounced = useDebounced(input, 250);
  const monteCarlo = useMemo(() => {
    const p = projectionInputSchema.safeParse(debounced);
    return p.success ? projectNetWorth(p.data) : null;
  }, [debounced]);
  const simulating = debounced !== input;
  const { value: r, stale } = useLastValid(quick);
  const { value: mc } = useLastValid(monteCarlo);

  const points = useMemo(() => {
    if (!r) return [];
    const band = mc && mc.yearly.length === r.yearly.length ? mc.yearly : null;
    return r.yearly.map((y, i) => ({ year: y.year, nominal: y.nominal, real: y.real, p10: band?.[i].p10, p90: band?.[i].p90 }));
  }, [r, mc]);

  const field = (k: ProjectionKey) => ({ value: state[k], onChange: (v: Num) => setField(k, v), error: errors[k] });
  const dataHint = (k: ProjectionKey, value: number | null, format: (n: number) => string) =>
    value === null ? undefined : <DataHint current={state[k]} data={value} onReset={() => setField(k, value)} format={format} />;
  const horizon = r?.yearly.at(-1)?.year ?? state.horizonYears ?? PROJECTION_DEFAULTS.horizonYears;
  const eventsTotal = eventsInput(events).reduce((s, e) => s + e.amount, 0);
  const nextId = () => Math.max(0, ...events.map((e) => e.id)) + 1;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Card className="self-start">
        <div className="grid grid-cols-2 gap-3">
          <NumField
            className="col-span-2"
            label="Net worth today"
            suffix={cur}
            group
            {...field("startingNetWorth")}
            aside={dataHint("startingNetWorth", data.startingNetWorth, compactMoney)}
          />
          <NumField
            className="col-span-2"
            label="Saved per month"
            suffix={cur}
            group
            {...field("monthlyContribution")}
            hint={data.monthlyContribution !== null ? `Average of your last ${data.monthsWithData} months` : undefined}
            aside={dataHint("monthlyContribution", data.monthlyContribution, money)}
          />
          <NumField
            label="Return"
            suffix="%/yr"
            {...field("annualReturnPct")}
            aside={dataHint("annualReturnPct", data.annualReturnPct, (n) => pct(n))}
            hint="Blended, from your allocation"
          />
          <NumField label="Horizon" suffix="yrs" {...field("horizonYears")}>
            <Chips options={[10, 20, 30]} value={state.horizonYears} onPick={(y) => setField("horizonYears", y)} />
          </NumField>
          <NumField
            className="col-span-2"
            label="Yearly spending (for FI)"
            suffix={cur}
            group
            {...field("annualExpenses")}
            placeholder="Leave empty to skip"
            hint="In today's money — sets your financial-independence target"
            aside={dataHint("annualExpenses", data.annualExpenses, compactMoney)}
          />
        </div>

        <Advanced count={4}>
          <NumField
            label="Volatility"
            suffix="%/yr"
            {...field("volatilityPct")}
            aside={dataHint("volatilityPct", data.volatilityPct, (n) => pct(n))}
            hint="Width of the band; 0 = none"
          />
          <NumField label="Inflation" suffix="%/yr" {...field("inflationPct")} placeholder={String(PROJECTION_DEFAULTS.inflationPct)} />
          <NumField label="Savings growth" suffix="%/yr" {...field("contributionGrowthPct")} hint="Raise per year" placeholder={String(PROJECTION_DEFAULTS.contributionGrowthPct)} />
          <NumField label="Withdrawal rate" suffix="%" {...field("withdrawalRatePct")} hint="4% rule → 25× spending" placeholder={String(PROJECTION_DEFAULTS.withdrawalRatePct)} />
        </Advanced>

        {/* One-off events */}
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-ink-2">One-off events</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEvents([...events, { id: nextId(), year: 5, amount: undefined, label: "" }])}
            >
              <Plus size={14} /> Add
            </Button>
          </div>
          {events.length === 0 ? (
            <p className="text-xs text-muted">Inheritance, bonus, wedding, car… + for money in, − for money out.</p>
          ) : (
            <ul className="space-y-2">
              {events.map((e, idx) => {
                const update = (patch: Partial<EventRow>) => setEvents(events.map((x) => (x.id === e.id ? { ...x, ...patch } : x)));
                const complete = e.year !== undefined && e.amount !== undefined;
                const err = complete ? errors[`events.${eventsInput(events.slice(0, idx + 1)).length - 1}.year`] : undefined;
                return (
                  <li key={e.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)_2rem] gap-1.5">
                    <NumberInput value={e.year} onChange={(v) => update({ year: v })} suffix="yr" ariaLabel="In how many years" placeholder="yr" invalid={!!err} />
                    <NumberInput value={e.amount} onChange={(v) => update({ amount: v })} suffix={cur} group ariaLabel="Amount" placeholder="−20k / 50k" />
                    <button
                      type="button"
                      aria-label="Remove event"
                      onClick={() => setEvents(events.filter((x) => x.id !== e.id))}
                      className="grid h-9 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-critical-text"
                    >
                      <X size={14} />
                    </button>
                    <input
                      value={e.label}
                      onChange={(ev) => update({ label: ev.target.value })}
                      placeholder="Label (optional)"
                      aria-label="Event label"
                      className="col-span-2 h-8 rounded-lg border border-border bg-surface px-3 text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none"
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">Year = years from now (0 = this year).</p>
        </div>
        {save}
      </Card>

      <div className={clsx("min-w-0 space-y-5 transition-opacity", stale && "opacity-50")}>
        {!r ? (
          <Card>
            <p className="text-sm text-ink-2">Fill in your net worth today to project it.</p>
          </Card>
        ) : (
          <>
            <Card>
              <div className="text-sm text-muted">
                In {horizon} years ({CURRENT_YEAR + horizon})
              </div>
              <div className="mt-1 tabular text-4xl font-semibold tracking-tight sm:text-5xl">{money(r.finalNominal)}</div>
              <p className="mt-1 text-sm text-ink-2">
                ≈ <span className="tabular font-medium text-ink">{money(r.finalReal)}</span> in today&apos;s money (
                {pct(state.inflationPct ?? PROJECTION_DEFAULTS.inflationPct)} inflation)
              </p>
              <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Stat label="You put in" value={money(r.totalContributions)} delta={<span className="text-muted">monthly savings</span>} />
                <Stat label="Growth" value={money(r.totalGrowth)} delta={<span className="text-muted">returns on top</span>} />
                {eventsTotal !== 0 && (
                  <Stat label="One-off events" value={f.units(eventsTotal, { whole: true, signed: true })} delta={<span className="text-muted">{events.length} event{events.length > 1 ? "s" : ""}</span>} />
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Financial independence" subtitle="When investments could cover your spending" />
              {r.fiTarget === null ? (
                <p className="text-sm text-ink-2">Add your yearly spending to see your FI target.</p>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Stat
                    label="FI target"
                    value={money(r.fiTarget)}
                    delta={<span className="text-muted">{Math.round(100 / (state.withdrawalRatePct ?? PROJECTION_DEFAULTS.withdrawalRatePct))}× yearly spending</span>}
                  />
                  <Stat
                    label="Reached"
                    value={r.fiYear === null ? "Not yet" : r.fiYear === 0 ? "Already 🎉" : `In ${r.fiYear} years`}
                    delta={
                      <span className="text-muted">
                        {r.fiYear === null ? `beyond ${horizon} years` : r.fiYear === 0 ? "today" : `around ${CURRENT_YEAR + r.fiYear}, expected case`}
                      </span>
                    }
                  />
                  <Stat
                    label={`Chance in ${horizon} yrs`}
                    value={mc?.fiProbability != null ? `${Math.round(mc.fiProbability * 100)}%` : "—"}
                    delta={
                      <span className="text-muted">
                        {mc?.fiProbability != null ? `of ${PROJECTION_DEFAULTS.simulations} simulated markets` : "set a volatility above 0"}
                      </span>
                    }
                  />
                </div>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Projection"
                subtitle={
                  <>
                    Shaded: 10–90% of {PROJECTION_DEFAULTS.simulations} simulated markets
                    {simulating && <span className="ml-1 text-muted">· updating…</span>}
                  </>
                }
              />
              <ProjectionChart points={points} fiTarget={r.fiTarget} />
              <p className="mt-3 text-xs text-muted">
                Monthly compounding at {pct(state.annualReturnPct ?? PROJECTION_DEFAULTS.annualReturnPct)}/yr, savings growing{" "}
                {pct(state.contributionGrowthPct ?? PROJECTION_DEFAULTS.contributionGrowthPct)}/yr. The FI target is in today&apos;s
                money — compare it with the &quot;today&apos;s money&quot; line. Not financial advice.
              </p>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
