import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { budgetStatus, cashflow, spendingByCategory } from "@/server/services/budgets";
import { listCategories } from "@/server/services/categories";
import { getSettings, today } from "@/server/services/settings";
import { COMMON_CURRENCIES, isCurrencyCode, normalizeCurrency } from "@/lib/domain";
import { serverFormat } from "@/server/format";
import { addMonths, formatMonth, isMonth, monthBounds } from "@/lib/dates";
import { Badge, ButtonLink, Card, CardHeader, Meter, PageHeader, Stat } from "@/components/ui";
import { CashflowChart, HBarList } from "@/components/charts";
import { InlineAmount } from "@/components/inline-amount";
import { saveBudget } from "./actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Budgets" };

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<{ month?: string; currency?: string }> }) {
  const uid = (await requireUser()).id;
  const params = await searchParams;
  const current = today(uid).slice(0, 7);
  const month = params.month && isMonth(params.month) ? params.month : current;
  const base = getSettings(uid).currency;
  const wanted = params.currency ? normalizeCurrency(params.currency) : base;
  const display = isCurrencyCode(wanted) ? wanted : base;
  const status = budgetStatus(uid, month, { currency: display });
  const { start, end } = monthBounds(month);
  const spending = spendingByCategory(uid, start, end, display);
  const flows = cashflow(uid, 12, display);
  const sf = serverFormat(uid);
  /** Amounts in the display currency unless told otherwise. */
  const f = { ...sf, money: (cents: number, opts: Parameters<typeof sf.money>[1] = {}) => sf.money(cents, { currency: display, ...opts }) };
  const envelopeCurrencies = [...new Set([...status.currencies, ...COMMON_CURRENCIES.slice(0, 6)])];
  const qs = (m: string, c = display) => `/budgets?month=${m}${c !== base ? `&currency=${c}` : ""}`;

  const budgeted = status.lines.filter((l) => l.budgetCents !== null);
  const unbudgeted = status.lines.filter((l) => l.budgetCents === null);
  const budgetedIds = new Set(budgeted.map((l) => l.categoryId));
  const spare = listCategories(uid).filter((c) => c.kind === "expense" && !budgetedIds.has(c.id) && !unbudgeted.some((u) => u.categoryId === c.id));
  const leftCents = status.totalBudgetCents - status.totalSpentInBudgetsCents;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Budgets"
        subtitle="Monthly envelopes per category. Transfers between your own accounts don't count."
        actions={
          <div className="flex items-center gap-1">
            {status.currencies.length > 1 && (
              <div role="radiogroup" aria-label="Show amounts in" className="mr-2 inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5">
                {status.currencies.map((c) => (
                  <Link
                    key={c}
                    href={qs(month, c)}
                    role="radio"
                    aria-checked={c === display}
                    className={`rounded-md px-2 py-1 text-xs font-medium ${c === display ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
                  >
                    {c}
                  </Link>
                ))}
              </div>
            )}
            <ButtonLink href={qs(addMonths(month, -1))} size="sm" variant="ghost" aria-label="Previous month">
              <ChevronLeft size={16} />
            </ButtonLink>
            <span className="min-w-24 text-center text-sm font-medium">{formatMonth(month)}</span>
            <ButtonLink
              href={qs(addMonths(month, 1))}
              size="sm"
              variant="ghost"
              aria-label="Next month"
              className={month >= current ? "pointer-events-none opacity-40" : ""}
            >
              <ChevronRight size={16} />
            </ButtonLink>
          </div>
        }
      />

      {status.missingFx.length > 0 && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">
          No exchange rate yet for {status.missingFx.join(", ")}: amounts that need one count as 0 until the next rate refresh.
        </p>
      )}

      <Card>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat label="Income" value={f.money(status.incomeCents, { whole: true })} />
          <Stat label="Spent" value={f.money(status.expensesCents, { whole: true })} />
          <Stat
            label="Saved"
            value={<span className={status.netCents < 0 ? "text-critical-text" : ""}>{f.money(status.netCents, { whole: true, signed: true })}</span>}
            delta={status.savingsRatePct !== null ? <span className="text-muted">{status.savingsRatePct.toFixed(0)}% savings rate</span> : undefined}
          />
          <Stat
            label="Left in budgets"
            value={<span className={leftCents < 0 ? "text-critical-text" : ""}>{f.money(leftCents, { whole: true })}</span>}
            delta={<span className="text-muted">of {f.money(status.totalBudgetCents, { whole: true })}</span>}
          />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader
            title="Envelopes"
            subtitle={month === current ? `The tick marks today (${Math.round(status.elapsed * 100)}% of the month)` : "Click an amount to edit it"}
          />
          {budgeted.length === 0 && <p className="mb-4 text-sm text-ink-2">No budgets yet — set one on any category below.</p>}
          <ul className="space-y-4">
            {budgeted.map((l) => (
              <li key={l.categoryId}>
                <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span>{l.icon}</span>
                    <Link href={`/transactions?category=${l.categoryId}&from=${start}&to=${end}`} className="hover:underline">
                      {l.name}
                    </Link>
                    {l.status === "over" && <Badge tone="critical">over by {f.money(-(l.remainingCents ?? 0), { whole: true, currency: l.currency })}</Badge>}
                    {l.status === "ahead_of_pace" && <Badge tone="warning">spending fast</Badge>}
                  </span>
                  <span className="flex items-center gap-1 text-ink-2">
                    <span className="tabular font-medium text-ink">{f.money(l.spentCents, { whole: true, currency: l.currency })}</span>
                    <span className="text-muted">/</span>
                    <InlineAmount
                      cents={l.budgetCents}
                      currency={l.currency}
                      currencies={envelopeCurrencies}
                      action={saveBudget}
                      hidden={{ categoryId: l.categoryId! }}
                    />
                  </span>
                </div>
                <Meter pct={l.pct ?? 0} status={l.status === "unbudgeted" ? "ok" : l.status} pace={month === current ? status.elapsed : undefined} />
                {(l.currency !== display || l.spentByCurrency.length > 0) && (
                  <p className="tabular mt-1 text-xs text-muted">
                    {l.spentByCurrency.length > 0 && <>Spent {l.spentByCurrency.map((s) => f.money(s.cents, { whole: true, currency: s.currency })).join(" + ")}</>}
                    {l.spentByCurrency.length > 0 && l.currency !== display && " · "}
                    {l.currency !== display && (
                      <>
                        ≈ {f.money(l.displaySpentCents, { whole: true })} / {f.money(l.displayBudgetCents ?? 0, { whole: true })}
                      </>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>

          {(unbudgeted.length > 0 || spare.length > 0) && (
            <div className="mt-6 border-t border-border pt-4">
              <h3 className="mb-2 text-xs font-medium text-muted">No budget yet</h3>
              <ul className="divide-y divide-border text-sm">
                {unbudgeted.map((l) => (
                  <li key={l.categoryId ?? "none"} className="flex items-center justify-between py-1.5">
                    <span>
                      {l.icon} {l.name}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular">{f.money(l.spentCents, { whole: true })}</span>
                      {l.categoryId !== null ? (
                        <InlineAmount cents={null} currency={display} currencies={envelopeCurrencies} action={saveBudget} hidden={{ categoryId: l.categoryId }} placeholder="+ budget" />
                      ) : (
                        <Link href="/transactions?category=none" className="text-xs text-accent">
                          categorize →
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
                {spare.map((c) => (
                  <li key={c.id} className="flex items-center justify-between py-1.5 text-ink-2">
                    <span>
                      {c.icon} {c.name}
                    </span>
                    <InlineAmount cents={null} currency={display} currencies={envelopeCurrencies} action={saveBudget} hidden={{ categoryId: c.id }} placeholder="+ budget" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Where it went" subtitle={formatMonth(month)} />
          {spending.length ? (
            <HBarList items={spending.map((s) => ({ label: s.name, icon: s.icon, cents: s.spentCents, hint: `${s.sharePct.toFixed(1)}% of spending` }))} currency={display} />
          ) : (
            <p className="text-sm text-ink-2">No spending recorded this month.</p>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Last 12 months" subtitle="Income vs expenses" />
        <CashflowChart months={flows} height={240} currency={display} />
      </Card>
    </div>
  );
}
