import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { budgetStatus, cashflow, spendingByCategory } from "@/server/services/budgets";
import { listCategories } from "@/server/services/categories";
import { today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { addMonths, formatMonth, isMonth, monthBounds } from "@/lib/dates";
import { Badge, ButtonLink, Card, CardHeader, Meter, PageHeader, Stat } from "@/components/ui";
import { CashflowChart, HBarList } from "@/components/charts";
import { InlineAmount } from "@/components/inline-amount";
import { saveBudget } from "./actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Budgets" };

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const uid = (await requireUser()).id;
  const params = await searchParams;
  const current = today(uid).slice(0, 7);
  const month = params.month && isMonth(params.month) ? params.month : current;
  const status = budgetStatus(uid, month);
  const { start, end } = monthBounds(month);
  const spending = spendingByCategory(uid, start, end);
  const flows = cashflow(uid, 12);
  const f = serverFormat(uid);

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
            <ButtonLink href={`/budgets?month=${addMonths(month, -1)}`} size="sm" variant="ghost" aria-label="Previous month">
              <ChevronLeft size={16} />
            </ButtonLink>
            <span className="min-w-24 text-center text-sm font-medium">{formatMonth(month)}</span>
            <ButtonLink
              href={`/budgets?month=${addMonths(month, 1)}`}
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
                    {l.status === "over" && <Badge tone="critical">over by {f.money(-(l.remainingCents ?? 0), { whole: true })}</Badge>}
                    {l.status === "ahead_of_pace" && <Badge tone="warning">spending fast</Badge>}
                  </span>
                  <span className="flex items-center gap-1 text-ink-2">
                    <span className="tabular font-medium text-ink">{f.money(l.spentCents, { whole: true })}</span>
                    <span className="text-muted">/</span>
                    <InlineAmount cents={l.budgetCents} action={saveBudget} hidden={{ categoryId: l.categoryId! }} />
                  </span>
                </div>
                <Meter pct={l.pct ?? 0} status={l.status === "unbudgeted" ? "ok" : l.status} pace={month === current ? status.elapsed : undefined} />
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
                        <InlineAmount cents={null} action={saveBudget} hidden={{ categoryId: l.categoryId }} placeholder="+ budget" />
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
                    <InlineAmount cents={null} action={saveBudget} hidden={{ categoryId: c.id }} placeholder="+ budget" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Where it went" subtitle={formatMonth(month)} />
          {spending.length ? (
            <HBarList items={spending.map((s) => ({ label: s.name, icon: s.icon, cents: s.spentCents, hint: `${s.sharePct.toFixed(1)}% of spending` }))} />
          ) : (
            <p className="text-sm text-ink-2">No spending recorded this month.</p>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Last 12 months" subtitle="Income vs expenses" />
        <CashflowChart months={flows} height={240} />
      </Card>
    </div>
  );
}
