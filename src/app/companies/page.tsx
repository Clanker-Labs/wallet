import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { listCompanies } from "@/server/services/companies";
import { getSettings, today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { COMMON_CURRENCIES, COUNTRIES, isLiability } from "@/lib/domain";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { CashflowChart } from "@/components/charts";
import { Disclosure } from "@/components/accounts-ui";
import { CompanyForm, FinancialsForm } from "@/components/companies-form";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Companies" };

const VALUATION_LABEL = { book: "book value", revenue_multiple: "revenue ×", profit_multiple: "profit ×", manual: "recorded value" } as const;

export default async function CompaniesPage() {
  const uid = (await requireUser()).id;
  const f = serverFormat(uid);
  const t = today(uid);
  const base = getSettings(uid).currency;
  const companies = listCompanies(uid);
  const total = companies.reduce((s, c) => s + (c.account.includeInNetWorth ? c.baseOwnedCents : 0), 0);
  const currencies = [...new Set<string>([base, "AED", "EUR", "USD", ...COMMON_CURRENCIES.slice(0, 6)])];
  const countryName = new Map(COUNTRIES.map((c) => [c.code, c.name]));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Companies"
        subtitle={companies.length ? `Your share: ${f.money(total, { whole: true })} in net worth` : "Businesses you own, as assets: value, revenue, spending and profit"}
      />

      {companies.length === 0 && (
        <EmptyState title="No companies yet">
          Add a company you own (all or part of). Value it from its own accounts, from its revenue or profit, or enter a valuation. Its bank
          and loans are counted through it — never twice — and its profit feeds the tax view.
        </EmptyState>
      )}

      {companies.map((c) => {
        const cur = c.account.currency;
        const native = (cents: number) => f.money(cents, { currency: cur, whole: true });
        const last = c.months.slice(-12);
        return (
          <Card key={c.account.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <Link href={`/accounts/${c.account.id}`} className="inline-flex items-center gap-2 text-lg font-semibold hover:underline">
                  <Building2 size={18} className="text-muted" /> {c.account.name}
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-ink-2">
                  {c.params.legalForm && <span>{c.params.legalForm} ·</span>}
                  <span>{countryName.get(c.params.country) ?? c.params.country}</span>
                  <span className="text-muted">
                    · valued at {VALUATION_LABEL[c.params.valuation]}
                    {c.params.multiple && c.params.valuation !== "book" && c.params.valuation !== "manual" ? ` ${c.params.multiple}` : ""}
                  </span>
                  {c.account.ownershipPct !== 100 && <Badge>{+c.account.ownershipPct.toFixed(2)}% yours</Badge>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-3xl font-semibold tracking-tight">{native(c.ownedCents)}</div>
                <div className="text-xs text-muted">
                  your share{c.account.ownershipPct !== 100 && ` of ${native(c.valueCents)}`}
                  {cur !== base && ` · ${f.money(c.baseOwnedCents, { whole: true })}`}
                </div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Revenue, 12 months" value={native(c.ttm.revenueCents)} />
              <Stat label="Spending, 12 months" value={native(c.ttm.expensesCents)} />
              <Stat label="Profit, 12 months" value={<span className={c.ttm.profitCents < 0 ? "text-critical-text" : ""}>{native(c.ttm.profitCents)}</span>} />
              <Stat label="Margin" value={c.marginPct === null ? "—" : `${c.marginPct.toFixed(0)}%`} />
            </div>

            {last.length > 0 ? (
              <div className="mt-5">
                <CashflowChart months={last.map((m) => ({ month: m.month, incomeCents: m.revenueCents, expensesCents: m.expensesCents }))} currency={cur} height={200} />
              </div>
            ) : (
              <p className="mt-4 text-sm text-ink-2">
                No figures yet: attach its bank account (its transactions become revenue and spending) or enter months below.
              </p>
            )}

            <div className="mt-5 border-t border-border pt-4">
              <CardHeader
                title="Its accounts"
                subtitle={c.params.valuation === "book" ? "Their net value is the company's value" : "Counted through the company, not in your own net worth"}
                action={
                  <ButtonLink href={`/accounts?new=1&company=${c.account.id}`} size="sm" variant="ghost">
                    <Plus size={14} /> Add one
                  </ButtonLink>
                }
              />
              {c.accounts.length === 0 ? (
                <p className="text-sm text-ink-2">None attached yet.</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {c.accounts.map((a) => (
                    <li key={a.id} className="flex items-center justify-between py-1.5">
                      <Link href={`/accounts/${a.id}`} className="hover:underline">
                        {a.name}
                      </Link>
                      <span className={`tabular ${isLiability(a.assetClass) ? "text-critical-text" : ""}`}>
                        {f.money((isLiability(a.assetClass) ? -1 : 1) * a.balanceCents, { currency: a.currency, whole: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
              <Disclosure summary="Enter a month of revenue and spending" focusOnOpen={false} summaryClassName="text-sm">
                <div className="pt-3">
                  <FinancialsForm companyId={c.account.id} currency={cur} month={t.slice(0, 7)} />
                </div>
              </Disclosure>
              <Disclosure summary="Edit company" focusOnOpen={false} summaryClassName="text-sm">
                <div className="pt-3">
                  <CompanyForm
                    value={{ accountId: c.account.id, name: c.account.name, currency: cur, ownershipPct: c.account.ownershipPct, params: c.params }}
                    currencies={currencies}
                    baseCurrency={base}
                  />
                </div>
              </Disclosure>
            </div>
          </Card>
        );
      })}

      <Card>
        <Disclosure defaultOpen={companies.length === 0} focusOnOpen={false} summary={<span className="inline-flex items-center gap-1.5 font-medium"><Plus size={15} /> Add a company</span>}>
          <div className="pt-4">
            <CompanyForm currencies={currencies} baseCurrency={base} />
          </div>
        </Disclosure>
      </Card>
    </div>
  );
}
