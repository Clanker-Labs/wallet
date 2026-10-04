"use client";

import clsx from "clsx";
import { AlertTriangle } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import {
  HCSF_MAX_DEBT_RATIO,
  borrowingCapacity,
  capacityInputSchema,
  purchaseInputSchema,
  simulatePurchase,
} from "@/lib/finance/mortgage";
import { Card, CardHeader, Stat } from "./ui";
import { StackedYears, YearLines } from "./charts";
import { useFormat } from "./format";
import { Segmented } from "./settings-kit";
import { Advanced, Chips, DataHint, NumField, fmtPct, issuesToErrors, useCurrencySymbol, useLastValid, type Num } from "./sim-fields";
import {
  NOTARY_EXISTING,
  NOTARY_NEW,
  PURCHASE_DEFAULTS,
  describe,
  type DataDefaults,
  type MortgageKey,
  type MortgageState,
  type PurchaseKey,
  type PurchaseState,
} from "./sim-model";

export function MortgageTab({
  purchase,
  setPurchase,
  extra,
  setExtra,
  data,
  save,
}: {
  purchase: PurchaseState;
  setPurchase: (k: PurchaseKey, v: Num) => void;
  extra: MortgageState;
  setExtra: (k: MortgageKey, v: Num) => void;
  data: DataDefaults;
  save: ReactNode;
}) {
  const f = useFormat();
  const cur = useCurrencySymbol();
  const money = (n: number) => f.units(n, { whole: true });
  const pct = (n: number, d = 1) => fmtPct(f.locale, n, d);

  const parsed = useMemo(() => purchaseInputSchema.safeParse({ ...purchase, ...extra }), [purchase, extra]);
  const errors = parsed.success ? {} : issuesToErrors(parsed.error.issues);
  const computed = useMemo(() => (parsed.success ? simulatePurchase(parsed.data) : null), [parsed]);
  const { value: r, stale } = useLastValid(computed);

  const capacity = useMemo(() => {
    const income = extra.monthlyNetIncome;
    if (!income || income <= 0) return null;
    const p = capacityInputSchema.safeParse({
      monthlyNetIncome: income,
      otherMonthlyDebts: extra.otherMonthlyDebts,
      annualRatePct: purchase.annualRatePct,
      insuranceRatePct: purchase.insuranceRatePct,
      durationYears: purchase.durationYears,
      downPayment: purchase.downPayment,
      notaryFeesPct: purchase.notaryFeesPct,
      guaranteeFeesPct: purchase.guaranteeFeesPct,
    });
    return p.success ? borrowingCapacity(p.data) : null;
  }, [purchase, extra]);

  const notary = purchase.notaryFeesPct;
  const propertyType = notary === NOTARY_NEW ? "new" : notary === NOTARY_EXISTING ? "existing" : "custom";
  const field = (k: PurchaseKey) => ({ value: purchase[k], onChange: (v: Num) => setPurchase(k, v), error: errors[k] });
  const price = purchase.price ?? 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      {/* Inputs */}
      <Card className="self-start">
        <div className="mb-4">
          <div className="mb-1 text-xs font-medium text-ink-2">Property</div>
          <Segmented
            ariaLabel="Property type"
            value={propertyType}
            onChange={(v) => setPurchase("notaryFeesPct", v === "new" ? NOTARY_NEW : NOTARY_EXISTING)}
            options={[
              { value: "existing", label: "Existing" },
              { value: "new", label: "New build" },
            ]}
          />
          <p className="mt-1 text-xs text-muted">
            Notary fees {notary !== undefined ? pct(notary) : "—"} of the price
            {propertyType === "custom" ? " (custom)" : ""}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Price" suffix={cur} group {...field("price")} placeholder="e.g. 300k" />
          <NumField label="Down payment" suffix={cur} group {...field("downPayment")}>
            {price > 0 && (
              <Chips
                options={[10, 20]}
                value={purchase.downPayment !== undefined ? Math.round((purchase.downPayment / price) * 100) : null}
                onPick={(p) => setPurchase("downPayment", Math.round((price * p) / 100))}
                format={(p) => `${p}%`}
              />
            )}
          </NumField>
          <NumField label="Interest rate" suffix="%/yr" {...field("annualRatePct")} placeholder={String(PURCHASE_DEFAULTS.annualRatePct)} />
          <NumField label="Duration" suffix="yrs" {...field("durationYears")} placeholder="25">
            <Chips options={[15, 20, 25]} value={purchase.durationYears} onPick={(y) => setPurchase("durationYears", y)} />
          </NumField>
          <NumField
            className="col-span-2"
            label="Net monthly income"
            suffix={cur}
            group
            value={extra.monthlyNetIncome}
            onChange={(v) => setExtra("monthlyNetIncome", v)}
            error={errors.monthlyNetIncome}
            placeholder="Household, after tax"
            hint="Household, after tax — for the debt-to-income check"
            aside={
              data.monthlyNetIncome ? (
                <DataHint
                  current={extra.monthlyNetIncome}
                  data={data.monthlyNetIncome}
                  onReset={() => setExtra("monthlyNetIncome", data.monthlyNetIncome ?? undefined)}
                  format={money}
                />
              ) : undefined
            }
          />
        </div>

        <Advanced count={8}>
          <NumField label="Insurance" suffix="%/yr" {...field("insuranceRatePct")} hint={describe.purchase("insuranceRatePct")} placeholder={String(PURCHASE_DEFAULTS.insuranceRatePct)} />
          <NumField label="Notary fees" suffix="%" {...field("notaryFeesPct")} hint="~7.5% existing, ~2.5% new" placeholder={String(PURCHASE_DEFAULTS.notaryFeesPct)} />
          <NumField label="Guarantee" suffix="%" {...field("guaranteeFeesPct")} hint="Caution / mortgage, % of loan" placeholder={String(PURCHASE_DEFAULTS.guaranteeFeesPct)} />
          <NumField label="Bank fees" suffix={cur} group {...field("bankFees")} hint="Frais de dossier" placeholder={String(PURCHASE_DEFAULTS.bankFees)} />
          <NumField label="Agency fees" suffix={cur} group {...field("agencyFees")} hint="If not in the price" placeholder="0" />
          <NumField label="Renovation" suffix={cur} group {...field("renovation")} hint="Works financed by the loan" placeholder="0" />
          <NumField
            label="Other loans"
            suffix={`${cur}/mo`}
            group
            value={extra.otherMonthlyDebts}
            onChange={(v) => setExtra("otherMonthlyDebts", v)}
            error={errors.otherMonthlyDebts}
            hint="Monthly payments"
            placeholder="0"
          />
          <NumField label="Value growth" suffix="%/yr" {...field("appreciationPct")} hint="Property price trend" placeholder={String(PURCHASE_DEFAULTS.appreciationPct)} />
        </Advanced>
        {save}
      </Card>

      {/* Results */}
      <div className={clsx("min-w-0 space-y-5 transition-opacity", stale && "opacity-50")}>
        {!r ? (
          <Card>
            <p className="text-sm text-ink-2">Enter a price to see your monthly payment.</p>
          </Card>
        ) : (
          <>
            <Card>
              <div className="text-sm text-muted">Monthly payment</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className="tabular text-4xl font-semibold tracking-tight sm:text-5xl">{money(r.monthlyTotal)}</span>
                <span className="text-sm text-muted">/ month</span>
              </div>
              <p className="mt-1 text-sm text-ink-2">
                {money(r.monthlyPayment)} loan + {money(r.monthlyInsurance)} insurance, for {r.yearly.length} years
              </p>
              <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Loan amount" value={money(r.loanAmount)} delta={<span className="text-muted">{pct(r.downPaymentPct)} down</span>} />
                <Stat label="Total credit cost" value={money(r.totalCreditCost)} delta={<span className="text-muted">interest, insurance, fees</span>} />
                <Stat label="APR (TAEG)" value={pct(r.aprPct, 2)} delta={<span className="text-muted">all costs included</span>} />
                <Stat
                  label="Debt-to-income"
                  value={r.debtRatioPct === null ? "—" : `${r.debtRatioPct <= HCSF_MAX_DEBT_RATIO ? "🟢" : "🔴"} ${pct(r.debtRatioPct)}`}
                  delta={
                    r.debtRatioPct === null ? (
                      <span className="text-muted">add your income</span>
                    ) : r.debtRatioPct <= HCSF_MAX_DEBT_RATIO ? (
                      <span className="text-good-text">under the {HCSF_MAX_DEBT_RATIO}% cap</span>
                    ) : (
                      <span className="text-critical-text">over the {HCSF_MAX_DEBT_RATIO}% HCSF cap</span>
                    )
                  }
                />
              </div>
              {r.warnings.length > 0 && (
                <ul className="mt-5 space-y-1.5 border-t border-border pt-4">
                  {r.warnings.map((w) => (
                    <li key={w} className="flex gap-2 text-sm text-ink">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-critical-text" aria-hidden />
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Card>
                <CardHeader title="Project cost" subtitle="What the bank finances" />
                <table className="w-full text-sm">
                  <tbody className="[&_td]:py-1">
                    <Row label="Price" value={money(price)} />
                    <Row label={`Notary fees (${pct(notary ?? PURCHASE_DEFAULTS.notaryFeesPct)})`} value={money(r.notaryFees)} />
                    <Row label="Loan guarantee" value={money(r.guaranteeFees)} />
                    <Row label="Bank fees" value={money(purchase.bankFees ?? PURCHASE_DEFAULTS.bankFees)} />
                    {(purchase.agencyFees ?? 0) > 0 && <Row label="Agency fees" value={money(purchase.agencyFees!)} />}
                    {(purchase.renovation ?? 0) > 0 && <Row label="Renovation" value={money(purchase.renovation!)} />}
                    <Row label="Total project" value={money(r.totalProjectCost)} strong border />
                    <Row label="− Down payment" value={money(-(purchase.downPayment ?? 0))} muted />
                    <Row label="= Loan" value={money(r.loanAmount)} strong />
                  </tbody>
                </table>
              </Card>

              <Card>
                <CardHeader title="Borrowing capacity" subtitle={`At ${HCSF_MAX_DEBT_RATIO}% of income, same rate & duration`} />
                {!capacity ? (
                  <p className="text-sm text-ink-2">Add your net monthly income to see how much you could borrow.</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <Stat label="Max loan" value={money(capacity.maxLoan)} delta={<span className="text-muted">{money(capacity.maxMonthlyPayment)}/mo max</span>} />
                      <Stat label="Max price" value={money(capacity.maxPropertyPrice)} delta={<span className="text-muted">with your down payment</span>} />
                    </div>
                    {price > 0 && (
                      <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-sm">
                        {price <= capacity.maxPropertyPrice ? (
                          <>
                            🟢 This price fits, with <span className="tabular font-medium">{money(capacity.maxPropertyPrice - price)}</span> to spare.
                          </>
                        ) : (
                          <>
                            🔴 <span className="tabular font-medium">{money(price - capacity.maxPropertyPrice)}</span> above what you can borrow for.
                          </>
                        )}
                      </p>
                    )}
                  </>
                )}
              </Card>
            </div>

            <Card>
              <CardHeader title="Where your payments go" subtitle="Per year — early payments are mostly interest" />
              <StackedYears
                data={r.yearly.map((y) => ({ year: y.year, principal: y.principal, interest: y.interest }))}
                series={[
                  { key: "principal", label: "Principal", slot: 1 },
                  { key: "interest", label: "Interest", slot: 2 },
                ]}
              />
            </Card>

            <Card>
              <CardHeader
                title="Property value vs loan"
                subtitle={`Equity is the gap · value grows ${pct(purchase.appreciationPct ?? PURCHASE_DEFAULTS.appreciationPct)}/yr`}
              />
              <YearLines
                data={[
                  { year: 0, value: price, balance: r.loanAmount, equity: price - r.loanAmount },
                  ...r.yearly.map((y) => ({ year: y.year, value: y.propertyValue, balance: y.balanceEnd, equity: y.equity })),
                ]}
                series={[
                  { key: "value", label: "Property value", slot: 1 },
                  { key: "balance", label: "Loan left", slot: 2 },
                  { key: "equity", label: "Your equity", slot: 3 },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong, muted, border }: { label: string; value: string; strong?: boolean; muted?: boolean; border?: boolean }) {
  return (
    <tr className={clsx(border && "border-t border-border")}>
      <td className={clsx(muted ? "text-muted" : "text-ink-2", strong && "font-medium text-ink")}>{label}</td>
      <td className={clsx("tabular text-right", strong && "font-semibold", muted && "text-muted")}>{value}</td>
    </tr>
  );
}
