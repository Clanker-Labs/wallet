import Link from "next/link";
import { notFound } from "next/navigation";
import { Archive, ArrowLeft, ArchiveRestore, ArrowRight, Plus } from "lucide-react";
import { balanceOnDate, getAccount, listAccounts } from "@/server/services/accounts";
import { today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import {
  ACCOUNT_TYPES,
  ASSET_CLASS_LABELS,
  ASSET_CLASS_SLOT,
  COMMON_CURRENCIES,
  HOLDING_ACCOUNT_TYPES,
  isLiability,
} from "@/lib/domain";
import { addDays, addMonths, endOfMonth, formatDate, formatMonth, monthRange } from "@/lib/dates";
import { monthlyPayment, paymentsMade } from "@/lib/finance/loan";
import { Badge, Button, ButtonLink, Card, CardHeader, Delta, SeriesDot, Stat } from "@/components/ui";
import { FormatProvider } from "@/components/format";
import {
  HOLDING_TYPE_SLOT,
  formatQuantity,
  holdingTypeLabel,
  moneyIn,
  priceIn,
  priceState,
  relativeDay,
} from "@/components/investments-model";
import { listHoldings } from "@/server/services/holdings";
import { NetWorthChart } from "@/components/charts";
import { AccountForm } from "@/components/accounts-form";
import { ConfirmButton, DeleteAccountForm, Disclosure, RecordBalanceForm } from "@/components/accounts-ui";
import { archiveAccountAction, deleteSnapshotAction, unarchiveAccountAction } from "../actions";
import { requireUser } from "@/server/session";
import { valuationContext } from "@/server/services/valuation";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ all?: string }> };

function load(uid: string, idParam: string) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    return getAccount(uid, id);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props) {
  const data = load((await requireUser()).id, (await params).id);
  return { title: data?.account.name ?? "Account" };
}

const SOURCE_LABELS: Record<string, string> = {
  manual: "manual",
  archive: "closed",
  telegram: "Telegram",
  agent: "assistant",
  demo: "demo",
  holdings: "market prices",
};

const RECORDS_SHOWN = 12;

export default async function AccountPage({ params, searchParams }: Props) {
  const uid = (await requireUser()).id;
  const data = load(uid, (await params).id);
  const showAll = (await searchParams).all === "1";
  if (!data) notFound();
  const { account: a, snapshots } = data;
  const f = serverFormat(uid);
  const t = today(uid);
  const liability = isLiability(a.assetClass);
  const sign = liability ? -1 : 1;
  const partial = a.ownershipPct !== 100;
  const loan = a.loanParams;
  const foreign = a.currency !== f.currency;
  /** Amounts of this account, in its own currency. */
  const native = (cents: number, opts: { whole?: boolean } = {}) => moneyIn(cents, a.currency, f.locale, opts);
  const holdings = a.valuedByHoldings ? listHoldings(uid, { accountId: a.id }) : [];

  // Related accounts: the property a mortgage finances, or the mortgages on a property.
  const others = listAccounts(uid, { includeArchived: true }).filter((x) => x.id !== a.id);
  const properties = others.filter((x) => x.assetClass === "real_estate" && !x.archivedAt).map((x) => ({ id: x.id, name: x.name }));
  const financedProperty = a.type === "mortgage" && a.linkedAccountId ? others.find((x) => x.id === a.linkedAccountId) : undefined;
  const mortgages = a.assetClass === "real_estate" ? others.filter((x) => x.linkedAccountId === a.id && !x.archivedAt) : [];
  const currencies = [...new Set<string>([...COMMON_CURRENCIES, ...others.map((x) => x.currency), a.currency])];

  // Chart: snapshots as recorded, or a monthly series off the amortization schedule for loans.
  let points: { date: string; netCents: number }[];
  if (loan) {
    const from = addDays(loan.startDate, -31);
    const dates = monthRange(from.slice(0, 7), addMonths(t.slice(0, 7), -1)).map(endOfMonth).filter((d) => d >= from);
    dates.push(t);
    const ctx = valuationContext(uid);
    points = dates.map((d) => ({ date: d, netCents: balanceOnDate(a, snapshots, d, ctx).cents }));
  } else {
    points = snapshots.map((s) => ({ date: s.date, netCents: s.balanceCents }));
  }

  const rows = snapshots
    .map((s, i) => ({ ...s, changeCents: i > 0 ? s.balanceCents - snapshots[i - 1].balanceCents : null }))
    .reverse();
  const shownRows = showAll ? rows : rows.slice(0, RECORDS_SHOWN);

  const loanStats = loan
    ? (() => {
        const pmt = monthlyPayment(loan.principal, loan.annualRatePct, loan.durationMonths);
        const insurance = ((loan.insuranceRatePct ?? 0) / 100 / 12) * loan.principal;
        const made = paymentsMade(loan, t);
        return {
          monthlyCents: Math.round((pmt + insurance) * 100),
          insuranceCents: Math.round(insurance * 100),
          made,
          left: loan.durationMonths - made,
          endMonth: addMonths(loan.startDate.slice(0, 7), loan.durationMonths - 1),
        };
      })()
    : null;

  const formValues = {
    id: a.id,
    name: a.name,
    institution: a.institution,
    type: a.type,
    currency: a.currency,
    ownershipPct: a.ownershipPct,
    includeInNetWorth: a.includeInNetWorth,
    linkedAccountId: a.linkedAccountId,
    loanParams: a.loanParams,
    notes: a.notes,
  };

  return (
    <div className="space-y-5">
      <Link href="/accounts" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
        <ArrowLeft size={14} /> Accounts
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words">{a.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-ink-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium">
              {!liability && <SeriesDot slot={ASSET_CLASS_SLOT[a.assetClass as keyof typeof ASSET_CLASS_SLOT]} />}
              {ASSET_CLASS_LABELS[a.assetClass]}
            </span>
            <span>{[a.institution, ACCOUNT_TYPES[a.type].label].filter(Boolean).join(" · ")}</span>
            {a.archivedAt && <Badge tone="warning">closed {formatDate(a.archivedAt)}</Badge>}
            {!a.includeInNetWorth && <Badge>not counted in net worth</Badge>}
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className="tabular text-3xl font-semibold tracking-tight">{native(sign * a.ownedCents)}</div>
          {foreign && (
            <div className="tabular mt-0.5 text-sm text-muted">≈ {f.money(sign * a.baseOwnedCents)}</div>
          )}
          <div className="mt-0.5 text-xs text-muted">
            {partial && (
              <>
                your {+a.ownershipPct.toFixed(2)}% of <span className="tabular">{native(sign * a.balanceCents)}</span> ·{" "}
              </>
            )}
            {a.derivedFromLoan
              ? "from the amortization schedule"
              : a.valuedByHoldings
                ? `market value${a.lastUpdated ? `, prices as of ${formatDate(a.lastUpdated)}` : ""}`
                : a.lastUpdated
                  ? `as of ${formatDate(a.lastUpdated)}`
                  : "no balance yet"}
          </div>
        </div>
      </div>

      {(financedProperty || mortgages.length > 0) && (
        <p className="text-sm text-ink-2">
          {financedProperty ? (
            <>
              Finances <Link href={`/accounts/${financedProperty.id}`} className="font-medium text-ink hover:underline">{financedProperty.name}</Link>{" "}
              · your equity in it:{" "}
              <span className="tabular font-medium text-ink">
                {f.money(financedProperty.baseOwnedCents - a.baseOwnedCents, { whole: true })}
              </span>
            </>
          ) : (
            <>
              Financed by{" "}
              {mortgages.map((m, i) => (
                <span key={m.id}>
                  {i > 0 && ", "}
                  <Link href={`/accounts/${m.id}`} className="font-medium text-ink hover:underline">{m.name}</Link>
                </span>
              ))}{" "}
              · your equity:{" "}
              <span className="tabular font-medium text-ink">
                {f.money(a.baseOwnedCents - mortgages.reduce((s, m) => s + m.baseOwnedCents, 0), { whole: true })}
              </span>
            </>
          )}
        </p>
      )}

      {/* Primary action */}
      {loan && loanStats ? (
        <Card>
          <CardHeader
            title="Loan"
            subtitle="The balance updates itself from the amortization schedule — nothing to record."
          />
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat
              label="Monthly payment"
              value={native(loanStats.monthlyCents)}
              delta={loanStats.insuranceCents > 0 ? <span className="text-muted">incl. {native(loanStats.insuranceCents)} insurance</span> : undefined}
            />
            <Stat label="Borrowed" value={native(Math.round(loan.principal * 100), { whole: true })} delta={<span className="text-muted">at {loan.annualRatePct}%</span>} />
            <Stat label="Payments made" value={`${loanStats.made} / ${loan.durationMonths}`} delta={<span className="text-muted">{loanStats.left} to go</span>} />
            <Stat label="Paid off" value={formatMonth(loanStats.endMonth)} delta={<span className="text-muted">first payment {formatDate(loan.startDate)}</span>} />
          </div>
        </Card>
      ) : a.valuedByHoldings ? (
        <Card>
          <CardHeader
            title="Holdings"
            subtitle={`The balance is the market value of ${holdings.length === 1 ? "this position" : `these ${holdings.length} positions`}: nothing to record.`}
            action={
              <div className="flex shrink-0 gap-1">
                {!a.archivedAt && (
                  <ButtonLink href={`/investments?addTo=${a.id}`} size="sm" variant="ghost" aria-label="Add a holding" title="Add a holding" className="w-8 px-0">
                    <Plus size={15} />
                  </ButtonLink>
                )}
                <ButtonLink href={`/investments?account=${a.id}`} size="sm" variant="ghost">
                  Manage <ArrowRight size={14} />
                </ButtonLink>
              </div>
            }
          />
          <ul className="divide-y divide-border">
            {holdings.map((h) => {
              const state = priceState(h, t);
              return (
                <li key={h.id} className="flex items-start gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium break-words">{h.symbol ?? h.name}</span>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
                        <SeriesDot slot={HOLDING_TYPE_SLOT[h.assetType]} />
                        {holdingTypeLabel(h.assetType)}
                      </span>
                      {state === "manual" && <Badge>manual price</Badge>}
                      {state === "missing" && <Badge tone="warning">no price</Badge>}
                      {state === "stale" && h.priceDate && <Badge tone="warning">price {relativeDay(h.priceDate, t)}</Badge>}
                    </div>
                    <div className="tabular mt-0.5 truncate text-xs text-muted">
                      {formatQuantity(h.quantity, f.locale)} × {h.unitPrice === null ? "—" : priceIn(h.unitPrice, h.currency, f.locale)}
                      {h.symbol && h.name !== h.symbol && <> · {h.name}</>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-sm">
                    <div className="tabular font-semibold">{h.unitPrice === null ? "—" : moneyIn(h.valueCents, h.currency, f.locale)}</div>
                    {h.gainCents !== null && (
                      <div className="text-xs">
                        <Delta value={h.gainCents}>
                          {moneyIn(h.gainCents, h.currency, f.locale, { signed: true, whole: Math.abs(h.gainCents) >= 100_000 })}
                          {h.gainPct !== null && ` (${h.gainPct >= 0 ? "+" : ""}${h.gainPct.toFixed(1)}%)`}
                        </Delta>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : a.archivedAt ? (
        <Card>
          <p className="text-sm text-ink-2">This account is closed. Unarchive it (bottom of the page) to record new balances.</p>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Record a balance"
            subtitle={
              HOLDING_ACCOUNT_TYPES.includes(a.type) ? (
                <>
                  In {a.currency}. Or{" "}
                  <Link href={`/investments?addTo=${a.id}`} className="text-accent hover:underline">
                    add its positions
                  </Link>{" "}
                  and it follows market prices.
                </>
              ) : (
                `In ${a.currency}. Same day twice? The latest one wins.`
              )
            }
          />
          <RecordBalanceForm accountId={a.id} today={t} liability={liability} />
        </Card>
      )}

      {/* History */}
      <Card>
        <CardHeader
          title={liability ? "Amount owed over time" : "Balance over time"}
          subtitle={[partial && "Full balance (100%)", foreign && `In ${a.currency}`].filter(Boolean).join(" · ") || undefined}
        />
        {points.length >= 2 ? (
          // The chart formats with the context currency: this account's own (Intl needs a 3-letter code).
          <FormatProvider value={{ currency: /^[A-Z]{3}$/.test(a.currency) ? a.currency : f.currency, locale: f.locale }}>
            <NetWorthChart points={points} height={240} label={liability ? "Owed" : "Balance"} />
          </FormatProvider>
        ) : (
          <p className="text-sm text-ink-2">Record a balance from time to time (monthly is plenty) and the trend shows up here.</p>
        )}
      </Card>

      {rows.length > 0 && (
        <Card>
          <CardHeader title="Balance records" subtitle={`${rows.length} record${rows.length > 1 ? "s" : ""}, newest first`} />
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 text-right font-medium">Balance</th>
                  <th className="py-2 pr-3 text-right font-medium">Change</th>
                  <th className="hidden py-2 pr-3 font-medium sm:table-cell">Source</th>
                  <th className="w-8 py-2" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shownRows.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {formatDate(s.date)}
                      {s.note && <div className="max-w-[16rem] truncate text-xs text-muted">{s.note}</div>}
                    </td>
                    <td className="tabular py-2 pr-3 text-right font-medium whitespace-nowrap">{native(s.balanceCents)}</td>
                    <td className="py-2 pr-3 text-right text-xs whitespace-nowrap">
                      {s.changeCents === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <Delta value={s.changeCents} invert={liability}>
                          {native(Math.abs(s.changeCents), { whole: Math.abs(s.changeCents) >= 100_000 })}
                        </Delta>
                      )}
                    </td>
                    <td className="hidden py-2 pr-3 text-xs text-muted sm:table-cell">{SOURCE_LABELS[s.source] ?? s.source}</td>
                    <td className="py-1 text-right">
                      <ConfirmButton action={deleteSnapshotAction} fields={{ snapshotId: s.id }} title="Delete this record" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > shownRows.length && (
            <Link href={`/accounts/${a.id}?all=1`} scroll={false} className="mt-3 inline-block text-sm text-accent hover:underline">
              Show all {rows.length} records
            </Link>
          )}
        </Card>
      )}

      {/* Edit */}
      <Card className="py-3">
        <Disclosure summaryClassName="py-1" summary={<span className="text-sm font-semibold">Edit details</span>}>
          <div className="pt-4 pb-2">
            <AccountForm account={formValues} properties={properties} currencies={currencies} baseCurrency={f.currency} />
          </div>
        </Disclosure>
      </Card>

      {/* Archive / delete */}
      <Card>
        <CardHeader title="Close or delete" />
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-3">
            {a.archivedAt ? (
              <>
                <p className="text-sm text-ink-2">Closed on {formatDate(a.archivedAt)}. Bring it back to the accounts list:</p>
                <form action={unarchiveAccountAction}>
                  <input type="hidden" name="id" value={a.id} />
                  <Button type="submit">
                    <ArchiveRestore size={14} /> Unarchive
                  </Button>
                </form>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-2">
                  Closed the account? Archive it: its balance drops to 0 from today and its history stays in your net worth chart.
                </p>
                <form action={archiveAccountAction}>
                  <input type="hidden" name="id" value={a.id} />
                  <Button type="submit">
                    <Archive size={14} /> Archive
                  </Button>
                </form>
              </>
            )}
          </div>
          <div className="space-y-3 border-t border-border pt-5 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-6">
            <p className="text-sm text-ink-2">Added by mistake? Delete it everywhere, history included.</p>
            <DeleteAccountForm id={a.id} name={a.name} snapshotCount={snapshots.length} />
          </div>
        </div>
      </Card>
    </div>
  );
}
