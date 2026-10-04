"use client";

import clsx from "clsx";
import { useMemo, type ReactNode } from "react";
import { buyVsRentInputSchema, simulateBuyVsRent } from "@/lib/finance/buy-vs-rent";
import { Card, CardHeader, Stat } from "./ui";
import { YearLines } from "./charts";
import { useFormat } from "./format";
import { Advanced, Chips, NumField, fmtPct, issuesToErrors, useCurrencySymbol, useLastValid, type Num } from "./sim-fields";
import { PURCHASE_DEFAULTS, RENT_DEFAULTS, describe, type PurchaseKey, type PurchaseState, type RentKey, type RentState } from "./sim-model";

export function RentTab({
  purchase,
  setPurchase,
  rent,
  setRent,
  save,
}: {
  purchase: PurchaseState;
  setPurchase: (k: PurchaseKey, v: Num) => void;
  rent: RentState;
  setRent: (k: RentKey, v: Num) => void;
  save: ReactNode;
}) {
  const f = useFormat();
  const cur = useCurrencySymbol();
  const money = (n: number) => f.units(n, { whole: true });
  const pct = (n: number, d = 1) => fmtPct(f.locale, n, d);

  const parsed = useMemo(() => buyVsRentInputSchema.safeParse({ ...purchase, ...rent }), [purchase, rent]);
  const errors = parsed.success ? {} : issuesToErrors(parsed.error.issues);
  const computed = useMemo(() => (parsed.success ? simulateBuyVsRent(parsed.data) : null), [parsed]);
  const { value: r, stale } = useLastValid(computed);

  const p = (k: PurchaseKey) => ({ value: purchase[k], onChange: (v: Num) => setPurchase(k, v), error: errors[k] });
  const q = (k: RentKey) => ({ value: rent[k], onChange: (v: Num) => setRent(k, v), error: errors[k] });
  const horizon = r?.yearly.length ?? rent.horizonYears ?? RENT_DEFAULTS.horizonYears;
  const ratio = r?.priceToRentRatio ?? 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Card className="self-start">
        <div className="grid grid-cols-2 gap-3">
          <NumField className="col-span-2" label="Rent for the same home" suffix={`${cur}/mo`} group {...q("monthlyRent")} placeholder="e.g. 1 100" />
          <NumField label="Price" suffix={cur} group {...p("price")} />
          <NumField label="Down payment" suffix={cur} group {...p("downPayment")} />
          <NumField label="Compare over" suffix="yrs" {...q("horizonYears")}>
            <Chips options={[10, 20, 30]} value={rent.horizonYears} onPick={(y) => setRent("horizonYears", y)} />
          </NumField>
          <NumField label="Savings return" suffix="%/yr" {...q("investmentReturnPct")} hint="What invested cash earns" placeholder={String(RENT_DEFAULTS.investmentReturnPct)} />
        </div>
        <p className="mt-3 text-xs text-muted">Price, down payment and loan settings are shared with the Mortgage tab.</p>

        <Advanced count={11}>
          <NumField label="Rent increase" suffix="%/yr" {...q("rentIncreasePct")} placeholder={String(RENT_DEFAULTS.rentIncreasePct)} />
          <NumField label="Value growth" suffix="%/yr" {...p("appreciationPct")} placeholder={String(PURCHASE_DEFAULTS.appreciationPct)} />
          <NumField label="Interest rate" suffix="%/yr" {...p("annualRatePct")} placeholder={String(PURCHASE_DEFAULTS.annualRatePct)} />
          <NumField label="Loan duration" suffix="yrs" {...p("durationYears")} placeholder={String(PURCHASE_DEFAULTS.durationYears)} />
          <NumField label="Property tax" suffix={`${cur}/yr`} group {...q("propertyTaxYearly")} hint="Taxe foncière" placeholder={String(RENT_DEFAULTS.propertyTaxYearly)} />
          <NumField label="Building charges" suffix={`${cur}/mo`} group {...q("coOwnershipMonthly")} hint="Copropriété" placeholder={String(RENT_DEFAULTS.coOwnershipMonthly)} />
          <NumField label="Upkeep" suffix="%/yr" {...q("maintenancePct")} hint="Of the home's value" placeholder={String(RENT_DEFAULTS.maintenancePct)} />
          <NumField label="Selling costs" suffix="%" {...q("sellingCostsPct")} hint="Agency etc. at the end" placeholder={String(RENT_DEFAULTS.sellingCostsPct)} />
          <NumField label="Notary fees" suffix="%" {...p("notaryFeesPct")} hint="~7.5% existing, ~2.5% new" placeholder={String(PURCHASE_DEFAULTS.notaryFeesPct)} />
          <NumField className="col-span-2" label="Tax on investment gains" suffix="%" {...q("portfolioTaxPct")} hint={describe.rent("portfolioTaxPct")} placeholder="0">
            <Chips options={[0, 17.2, 30]} value={rent.portfolioTaxPct} onPick={(v) => setRent("portfolioTaxPct", v)} format={(v) => `${v}%`} />
          </NumField>
        </Advanced>
        {save}
      </Card>

      <div className={clsx("min-w-0 space-y-5 transition-opacity", stale && "opacity-50")}>
        {!r ? (
          <Card>
            <p className="text-sm text-ink-2">Enter the rent and the price to compare.</p>
          </Card>
        ) : (
          <>
            <Card>
              <div className="text-sm text-muted">Verdict</div>
              <div className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
                {r.breakEvenYear !== null
                  ? r.breakEvenYear <= 1
                    ? "Buying wins from year 1"
                    : `Buying wins after ${r.breakEvenYear} years`
                  : `Renting stays ahead over ${horizon} years`}
              </div>
              <p className="mt-2 text-sm text-ink-2">
                After {horizon} years the {r.finalDifference >= 0 ? "buyer" : "renter"} is{" "}
                <span className="tabular font-semibold text-ink">
                  {money(Math.abs(r.finalDifference))}
                </span>{" "}
                ahead, after selling costs{(rent.portfolioTaxPct ?? 0) > 0 ? " and tax on gains" : ""}.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Buying costs" value={`${money(r.initialMonthlyCostBuy)}/mo`} delta={<span className="text-muted">loan, tax, charges, upkeep</span>} />
                <Stat label="Renting costs" value={`${money(r.initialMonthlyRent)}/mo`} delta={<span className="text-muted">first year</span>} />
                <Stat
                  label="Price-to-rent"
                  value={ratio.toFixed(1)}
                  delta={<span className="text-muted">{ratio < 15 ? "low: favors buying" : ratio > 20 ? "high: favors renting" : "in between"}</span>}
                />
                <Stat label="Loan" value={money(r.loanAmount)} delta={<span className="text-muted">same as Mortgage tab</span>} />
              </div>
            </Card>

            <Card>
              <CardHeader title="Net worth: buyer vs renter" subtitle="If both sold / cashed out that year" />
              <YearLines
                data={r.yearly.map((y) => ({ year: y.year, buyer: y.buyerNetWorth, renter: y.renterNetWorth }))}
                series={[
                  { key: "buyer", label: "Buyer", slot: 1 },
                  { key: "renter", label: "Renter", slot: 2 },
                ]}
              />
              <p className="mt-3 text-xs text-muted">
                Both start with the same cash. The renter invests the down payment; each month, whoever spends less invests the
                difference at {pct(rent.investmentReturnPct ?? RENT_DEFAULTS.investmentReturnPct)}/yr. The buyer&apos;s line
                is the home&apos;s resale value minus selling costs and the loan left.
              </p>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
