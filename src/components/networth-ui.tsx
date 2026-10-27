"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import { ArrowLeftRight, Briefcase, Building2, Landmark, LineChart, PencilLine } from "lucide-react";
import type { AssetClass } from "@/lib/domain";
import { DailyChangeChart, NetWorthChart } from "./charts";
import { useFormat } from "./format";
import { Delta } from "./ui";
import { Segmented } from "./settings-kit";

type Point = { date: string; netCents: number };
type Range = "1m" | "3m" | "6m" | "1y" | "all";

const RANGES: { value: Range; label: string; days?: number }[] = [
  { value: "1m", label: "1M", days: 30 },
  { value: "3m", label: "3M", days: 91 },
  { value: "6m", label: "6M", days: 182 },
  { value: "1y", label: "1Y", days: 365 },
  { value: "all", label: "All" },
];

/**
 * The hero chart: net worth plotted every day for the last year (month-ends
 * before that), with a range picker and a "daily change" view — one bar per
 * day, green up, red down — for seeing the moves rather than the level.
 */
export function NetWorthPanel({ daily, monthly }: { daily: Point[]; monthly: Point[] }) {
  const f = useFormat();
  const [range, setRange] = useState<Range>(daily.length > 100 ? "3m" : "all");
  const [mode, setMode] = useState<"value" | "change">("value");

  const points = useMemo(() => {
    const r = RANGES.find((x) => x.value === range)!;
    if (r.days) return daily.slice(-(r.days + 1));
    const first = daily[0]?.date;
    return [...monthly.filter((p) => !first || p.date < first), ...daily];
  }, [range, daily, monthly]);

  const changes = useMemo(
    () => points.slice(1).map((p, i) => ({ date: p.date, deltaCents: p.netCents - points[i].netCents })),
    [points],
  );
  const first = points[0];
  const last = points.at(-1);
  const delta = first && last ? last.netCents - first.netCents : 0;
  // Same rule as the server's changePct: no percentage against a near-zero start.
  const pct = first && last && first.netCents !== 0 && Math.abs(first.netCents) * 20 >= Math.abs(last.netCents) ? (delta / Math.abs(first.netCents)) * 100 : null;
  const upDays = changes.filter((c) => c.deltaCents > 0).length;
  const downDays = changes.filter((c) => c.deltaCents < 0).length;
  const best = changes.reduce<(typeof changes)[number] | null>((b, c) => (!b || c.deltaCents > b.deltaCents ? c : b), null);
  const worst = changes.reduce<(typeof changes)[number] | null>((b, c) => (!b || c.deltaCents < b.deltaCents ? c : b), null);
  const daysView = range !== "all" || points.length <= 400;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          {first && (
            <>
              <Delta value={delta}>
                {f.money(delta, { whole: true, signed: true })}
                {pct !== null && ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`}
              </Delta>
              <span className="ml-1.5 text-muted">since {DateTime.fromISO(first.date).toFormat("d LLL yyyy")}</span>
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Segmented
            size="sm"
            ariaLabel="Chart"
            value={mode}
            onChange={setMode}
            options={[
              { value: "value", label: "Value" },
              { value: "change", label: "Daily change" },
            ]}
          />
          <Segmented size="sm" ariaLabel="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
        </div>
      </div>
      {mode === "value" ? (
        <NetWorthChart points={points} dayTicks={range === "1m" || range === "3m"} />
      ) : daysView && changes.length ? (
        <>
          <DailyChangeChart points={changes} />
          <p className="mt-2 text-xs text-muted">
            {upDays} up · {downDays} down · {changes.length - upDays - downDays} flat
            {best && best.deltaCents > 0 && <> · best {DateTime.fromISO(best.date).toFormat("d LLL")} {f.money(best.deltaCents, { whole: true, signed: true })}</>}
            {worst && worst.deltaCents < 0 && <> · worst {DateTime.fromISO(worst.date).toFormat("d LLL")} {f.money(worst.deltaCents, { whole: true, signed: true })}</>}
          </p>
        </>
      ) : (
        <p className="py-16 text-center text-sm text-muted">Daily changes go back one year — pick a shorter range.</p>
      )}
    </div>
  );
}

// ── What moved ───────────────────────────────────────────────────────────

export interface MoveView {
  key: string;
  label: string;
  fromDate: string;
  deltaCents: number;
  deltaPct: number | null;
  movers: { accountId: number; name: string; assetClass: AssetClass; deltaCents: number; driver: "balance" | "market" | "loan" | "job" | "fx" | "company" }[];
}

const DRIVER = {
  market: { icon: LineChart, text: "market" },
  balance: { icon: PencilLine, text: "new balance" },
  loan: { icon: Landmark, text: "loan repaid" },
  job: { icon: Briefcase, text: "gratuity accrued" },
  fx: { icon: ArrowLeftRight, text: "exchange rate" },
  company: { icon: Building2, text: "business value" },
} as const;

/** Which accounts moved net worth, per period, as diverging bars. */
export function MoversCard({ moves }: { moves: MoveView[] }) {
  const f = useFormat();
  const [key, setKey] = useState(moves.find((m) => m.key === "1m" && m.movers.length)?.key ?? moves[0]?.key ?? "1m");
  const move = moves.find((m) => m.key === key) ?? moves[0];
  if (!move) return null;
  const shown = move.movers.slice(0, 8);
  const rest = move.movers.slice(8).reduce((s, m) => s + m.deltaCents, 0);
  const max = Math.max(1, ...shown.map((m) => Math.abs(m.deltaCents)));
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          <Delta value={move.deltaCents}>
            {f.money(move.deltaCents, { whole: true, signed: true })}
            {move.deltaPct !== null && ` (${move.deltaPct >= 0 ? "+" : ""}${move.deltaPct.toFixed(1)}%)`}
          </Delta>
          <span className="ml-1.5 text-muted">since {DateTime.fromISO(move.fromDate).toFormat("d LLL")}</span>
        </span>
        <Segmented size="sm" ariaLabel="Period" value={key} onChange={setKey} options={moves.map((m) => ({ value: m.key, label: m.label }))} />
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-ink-2">Nothing moved over this period.</p>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((m) => {
            const D = DRIVER[m.driver];
            const w = (Math.abs(m.deltaCents) / max) * 50;
            return (
              <li key={m.accountId} className="text-sm">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Link href={`/accounts/${m.accountId}`} className="flex min-w-0 items-center gap-1.5 text-ink-2 hover:text-ink">
                    <D.icon size={13} className="shrink-0 text-muted" aria-label={D.text} />
                    <span className="truncate">{m.name}</span>
                    <span className="hidden shrink-0 text-xs text-muted sm:inline">· {D.text}</span>
                  </Link>
                  <span className={`tabular shrink-0 font-medium ${m.deltaCents >= 0 ? "text-good-text" : "text-critical-text"}`}>
                    {f.money(m.deltaCents, { whole: true, signed: true })}
                  </span>
                </div>
                <div className="relative h-1.5 rounded-full bg-surface-2">
                  <div className="absolute top-0 left-1/2 h-full w-px bg-[var(--border-strong)]" aria-hidden />
                  <div
                    className="absolute top-0 h-full rounded-full"
                    style={{
                      width: `${w}%`,
                      left: m.deltaCents >= 0 ? "50%" : `${50 - w}%`,
                      background: m.deltaCents >= 0 ? "var(--good)" : "var(--critical)",
                    }}
                  />
                </div>
              </li>
            );
          })}
          {rest !== 0 && (
            <li className="flex justify-between text-xs text-muted">
              <span>{move.movers.length - shown.length} more</span>
              <span className="tabular">{f.money(rest, { whole: true, signed: true })}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
