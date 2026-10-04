import Link from "next/link";
import { notFound } from "next/navigation";
import { Archive, ArrowLeft, ArchiveRestore } from "lucide-react";
import { balanceOnDate, getAccount, listAccounts } from "@/server/services/accounts";
import { today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { ACCOUNT_TYPES, ASSET_CLASS_LABELS, ASSET_CLASS_SLOT, isLiability } from "@/lib/domain";
import { addDays, addMonths, endOfMonth, formatDate, formatMonth, monthRange } from "@/lib/dates";
import { monthlyPayment, paymentsMade } from "@/lib/finance/loan";
import { Badge, Button, Card, CardHeader, Delta, SeriesDot, Stat } from "@/components/ui";
import { NetWorthChart } from "@/components/charts";
import { AccountForm } from "@/components/accounts-form";
import { ConfirmButton, DeleteAccountForm, Disclosure, RecordBalanceForm } from "@/components/accounts-ui";
import { archiveAccountAction, deleteSnapshotAction, unarchiveAccountAction } from "../actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ all?: string }> };

function load(idParam: string) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    return getAccount(id);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props) {
  const data = load((await params).id);
  return { title: data?.account.name ?? "Account" };
}

const SOURCE_LABELS: Record<string, string> = {
  manual: "manual",
  archive: "closed",
  telegram: "Telegram",
  agent: "assistant",
  demo: "demo",
};

const RECORDS_SHOWN = 12;

export default async function AccountPage({ params, searchParams }: Props) {
  const data = load((await params).id);
  const showAll = (await searchParams).all === "1";
  if (!data) notFound();
  const { account: a, snapshots } = data;
  const f = serverFormat();
  const t = today();
  const liability = isLiability(a.assetClass);
  const sign = liability ? -1 : 1;
  const partial = a.ownershipPct !== 100;
  const loan = a.loanParams;

  // Related accounts: the property a mortgage finances, or the mortgages on a property.
  const others = listAccounts({ includeArchived: true }).filter((x) => x.id !== a.id);
  const properties = others.filter((x) => x.assetClass === "real_estate" && !x.archivedAt).map((x) => ({ id: x.id, name: x.name }));
  const financedProperty = a.type === "mortgage" && a.linkedAccountId ? others.find((x) => x.id === a.linkedAccountId) : undefined;
  const mortgages = a.assetClass === "real_estate" ? others.filter((x) => x.linkedAccountId === a.id && !x.archivedAt) : [];

  // Chart: snapshots as recorded, or a monthly series off the amortization schedule for loans.
  let points: { date: string; netCents: number }[];
  if (loan) {
    const from = addDays(loan.startDate, -31);
    const dates = monthRange(from.slice(0, 7), addMonths(t.slice(0, 7), -1)).map(endOfMonth).filter((d) => d >= from);
    dates.push(t);
    points = dates.map((d) => ({ date: d, netCents: balanceOnDate(a, snapshots, d).cents }));
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
          <div className="tabular text-3xl font-semibold tracking-tight">{f.money(sign * a.ownedCents)}</div>
          <div className="mt-0.5 text-xs text-muted">
            {partial && (
              <>
                your {+a.ownershipPct.toFixed(2)}% of <span className="tabular">{f.money(sign * a.balanceCents)}</span> ·{" "}
              </>
            )}
            {a.derivedFromLoan
              ? "from the amortization schedule"
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
              <span className="tabular font-medium text-ink">{f.money(financedProperty.ownedCents - a.ownedCents, { whole: true })}</span>
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
                {f.money(a.ownedCents - mortgages.reduce((s, m) => s + m.ownedCents, 0), { whole: true })}
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
              value={f.money(loanStats.monthlyCents)}
              delta={loanStats.insuranceCents > 0 ? <span className="text-muted">incl. {f.money(loanStats.insuranceCents)} insurance</span> : undefined}
            />
            <Stat label="Borrowed" value={f.money(Math.round(loan.principal * 100), { whole: true })} delta={<span className="text-muted">at {loan.annualRatePct}%</span>} />
            <Stat label="Payments made" value={`${loanStats.made} / ${loan.durationMonths}`} delta={<span className="text-muted">{loanStats.left} to go</span>} />
            <Stat label="Paid off" value={formatMonth(loanStats.endMonth)} delta={<span className="text-muted">first payment {formatDate(loan.startDate)}</span>} />
          </div>
        </Card>
      ) : a.archivedAt ? (
        <Card>
          <p className="text-sm text-ink-2">This account is closed. Unarchive it (bottom of the page) to record new balances.</p>
        </Card>
      ) : (
        <Card>
          <CardHeader title="Record a balance" subtitle="Same day twice? The latest one wins." />
          <RecordBalanceForm accountId={a.id} today={t} liability={liability} />
        </Card>
      )}

      {/* History */}
      <Card>
        <CardHeader title={liability ? "Amount owed over time" : "Balance over time"} subtitle={partial ? "Full balance (100%)" : undefined} />
        {points.length >= 2 ? (
          <NetWorthChart points={points} height={240} />
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
                    <td className="tabular py-2 pr-3 text-right font-medium whitespace-nowrap">{f.money(s.balanceCents)}</td>
                    <td className="py-2 pr-3 text-right text-xs whitespace-nowrap">
                      {s.changeCents === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <Delta value={s.changeCents} invert={liability}>
                          {f.money(Math.abs(s.changeCents), { whole: Math.abs(s.changeCents) >= 100_000 })}
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
            <AccountForm account={formValues} properties={properties} />
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
