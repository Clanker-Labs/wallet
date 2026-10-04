import clsx from "clsx";
import Link from "next/link";
import { after } from "next/server";
import { Bot, Pencil, Plus, X } from "lucide-react";
import { holdingsSummary, type HoldingRow } from "@/server/services/holdings";
import { listAccounts, type AccountWithBalance } from "@/server/services/accounts";
import { ensureFreshPrices } from "@/server/services/prices";
import { today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { ACCOUNT_TYPES, COMMON_CURRENCIES, HOLDING_ACCOUNT_TYPES } from "@/lib/domain";
import { Badge, ButtonLink, Card, CardHeader, Delta, EmptyState, PageHeader, SeriesDot, Stat } from "@/components/ui";
import { AllocationDonut } from "@/components/charts";
import { ConfirmButton } from "@/components/accounts-ui";
import { HoldingForm, type HoldingAccountOption } from "@/components/investments-form";
import { PriceRefresh } from "@/components/investments-ui";
import {
  HOLDING_TYPE_SLOT,
  formatQuantity,
  holdingTypeLabel,
  moneyIn,
  priceIn,
  priceState,
  relativeDay,
  summarize,
} from "@/components/investments-model";
import { deleteHoldingAction } from "./actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Investments" };

type Params = { account?: string; add?: string; addTo?: string; edit?: string };

/** /investments URL keeping the account filter. */
function hrefFor(account: number | null, extra: Record<string, string | number> = {}) {
  const q = new URLSearchParams();
  if (account) q.set("account", String(account));
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  const s = q.toString();
  return s ? `/investments?${s}` : "/investments";
}

function positiveInt(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Desktop column template, shared by the header row and every holding row. */
const COLS = "lg:grid lg:grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_9rem_8.5rem_4rem] lg:items-center lg:gap-4";

export default async function InvestmentsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const uid = (await requireUser()).id;
  const params = await searchParams;
  const f = serverFormat(uid);
  const t = today(uid);
  // Keep prices fresh in the background (throttled, never throws); the next view shows them.
  after(() => ensureFreshPrices());

  const summary = holdingsSummary(uid);
  const base = summary.base;
  const all = listAccounts(uid, { includeArchived: true });
  const accountsById = new Map(all.map((a) => [a.id, a]));

  // Accounts that hold positions, in the service's order (account name).
  const heldIn = [...new Set(summary.rows.map((r) => r.accountId))].map((id) => accountsById.get(id)!).filter(Boolean);
  const filterId = positiveInt(params.account);
  const filter = filterId ? (accountsById.get(filterId) ?? null) : null;
  const rows = filter ? summary.rows.filter((r) => r.accountId === filter.id) : summary.rows;
  const s = summarize(rows, t);

  // Form inputs: accounts that usually hold positions (or already do), currencies in use first-class.
  const pickable: HoldingAccountOption[] = all
    .filter((a) => !a.archivedAt && (HOLDING_ACCOUNT_TYPES.includes(a.type) || a.holdingsCount > 0))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency, type: a.type }));
  const currencies = [
    ...new Set<string>([...COMMON_CURRENCIES, ...all.map((a) => a.currency), ...summary.rows.map((r) => r.currency)]),
  ];

  const addTo = positiveInt(params.addTo);
  const adding = params.add === "1" || addTo !== null;
  const editId = positiveInt(params.edit);
  const closeHref = hrefFor(filter?.id ?? null);
  const defaultAccountId = addTo ?? (filter && pickable.some((a) => a.id === filter.id) ? filter.id : undefined);

  const addCard = adding && (
    <Card>
      <CardHeader
        title="Add a holding"
        subtitle="Already hold that symbol in the account? Its quantity is replaced, not added."
        action={
          <ButtonLink href={closeHref} scroll={false} size="sm" variant="ghost" aria-label="Close">
            <X size={16} />
          </ButtonLink>
        }
      />
      <HoldingForm accounts={pickable} currencies={currencies} defaultAccountId={defaultAccountId} autoFocus />
    </Card>
  );

  const header = (
    <PageHeader
      title="Investments"
      subtitle="Stocks, ETFs, funds, bonds, crypto and gold, valued at market prices."
      actions={
        !adding &&
        summary.rows.length > 0 && (
          <ButtonLink href={hrefFor(filter?.id ?? null, { add: 1 })} scroll={false} variant="primary">
            <Plus size={15} /> Add holding
          </ButtonLink>
        )
      }
    />
  );

  // ── Nothing held yet ──
  if (summary.rows.length === 0) {
    return (
      <div className="space-y-5">
        {header}
        {addCard}
        {!adding && (
          <EmptyState
            title="Track what you invest in"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {pickable.length > 0 && (
                  <ButtonLink href="/investments?add=1" scroll={false} variant="primary">
                    <Plus size={15} /> Add a holding
                  </ButtonLink>
                )}
                <ButtonLink href="/accounts?new=1&type=brokerage" variant={pickable.length ? "secondary" : "primary"}>
                  Brokerage account
                </ButtonLink>
                <ButtonLink href="/accounts?new=1&type=crypto">Crypto wallet</ButtonLink>
                <ButtonLink href="/accounts?new=1&type=precious_metals">Precious metals</ButtonLink>
              </div>
            }
          >
            <p>
              Add the positions you hold (stocks, ETFs, funds, bonds, crypto, gold) and wallet values them at market
              prices, each in its own currency, converted to {base}. Positions live in an account: a brokerage, a
              crypto wallet or a precious-metals stash.
            </p>
            <p className="mt-3">
              <Bot size={14} className="mr-1 inline align-[-2px] text-muted" aria-hidden />
              Have a broker statement? The{" "}
              <Link href="/assistant" className="font-medium text-accent hover:underline">
                assistant
              </Link>{" "}
              can import it for you.
            </p>
          </EmptyState>
        )}
      </div>
    );
  }

  const slices = s.groups.map((g) => ({ key: g.key, label: g.label, cents: g.cents, slot: g.slot }));
  const legend = s.groups.filter((g) => g.cents > 0).sort((a, b) => b.cents - a.cents);
  const groups = (filter ? [filter] : heldIn).map((a) => ({
    account: a,
    rows: rows.filter((r) => r.accountId === a.id),
  }));
  const symbolCount = new Set(rows.filter((r) => r.symbol).map((r) => r.symbol)).size;
  const missingFx = summary.missingFx.filter((c) => rows.some((r) => r.currency === c) || c === base);

  return (
    <div className="space-y-5">
      {header}

      {heldIn.length > 1 && (
        <nav aria-label="Filter by account" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
          <FilterPill href="/investments" active={!filter}>
            All accounts
          </FilterPill>
          {heldIn.map((a) => (
            <FilterPill key={a.id} href={hrefFor(a.id)} active={filter?.id === a.id}>
              {a.name}
            </FilterPill>
          ))}
        </nav>
      )}

      {addCard}

      {rows.length === 0 ? (
        <EmptyState
          title={filter ? `No positions in ${filter.name} yet` : "No positions"}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {filter && pickable.some((a) => a.id === filter.id) && (
                <ButtonLink href={hrefFor(filter.id, { addTo: filter.id })} scroll={false} variant="primary">
                  <Plus size={15} /> Add a holding
                </ButtonLink>
              )}
              <ButtonLink href="/investments">All investments</ButtonLink>
            </div>
          }
        >
          {filter && !pickable.some((a) => a.id === filter.id)
            ? "Positions go in brokerage, retirement, crypto or precious-metals accounts."
            : "Add what it holds and its balance follows market prices, no more manual updates."}
        </EmptyState>
      ) : (
        <>
          {/* Hero */}
          <Card className="bg-hero p-6">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="min-w-0">
                <div className="text-sm text-muted">
                  {filter ? `${filter.name} · ` : ""}Holdings value · {base}
                </div>
                <div className="tabular mt-1 text-4xl font-semibold tracking-tight sm:text-5xl">
                  {f.money(s.totalCents, { whole: true })}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  {s.gainCents !== null ? (
                    <>
                      <Delta value={s.gainCents}>
                        {f.money(s.gainCents, { whole: true, signed: true })}
                        {s.gainPct !== null && ` (${s.gainPct >= 0 ? "+" : ""}${s.gainPct.toFixed(1)}%)`}
                      </Delta>
                      <span className="text-muted">
                        unrealized
                        {s.withCost < rows.length && ` · on the ${s.withCost} of ${rows.length} positions with a known cost`}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">Add what you paid (total cost) to a position to see your gain.</span>
                  )}
                </div>
              </div>
              <div className="flex gap-8">
                <Stat
                  label="Positions"
                  value={rows.length}
                  delta={
                    <span className="text-muted">
                      in {groups.length} account{groups.length === 1 ? "" : "s"}
                    </span>
                  }
                />
                {s.gainCents !== null && (
                  <Stat
                    label="Cost basis"
                    value={f.money(s.costCents, { whole: true })}
                    delta={<span className="text-muted">what you paid</span>}
                  />
                )}
              </div>
            </div>
            <div className="mt-6 border-t border-border pt-4">
              <PriceRefresh disabled={symbolCount === 0}>
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    {s.latestQuote ? (
                      <>
                        Prices as of <span className="font-medium text-ink">{relativeDay(s.latestQuote, t)}</span>
                      </>
                    ) : (
                      "No market prices yet"
                    )}
                    <span className="text-muted">
                      {" "}
                      · {symbolCount} symbol{symbolCount === 1 ? "" : "s"}
                    </span>
                  </span>
                  {s.missing > 0 && <Badge tone="warning">{s.missing} without a price</Badge>}
                  {s.stale > 0 && <Badge tone="warning">{s.stale} stale</Badge>}
                </span>
              </PriceRefresh>
            </div>
          </Card>

          <div className="grid gap-5 lg:grid-cols-5">
            {/* Allocation by type */}
            <Card className="lg:col-span-3">
              <CardHeader title="Allocation" subtitle={`By type, in ${base}`} />
              <div className="flex flex-col items-center gap-6 sm:flex-row">
                <AllocationDonut slices={slices} size={168} />
                <table className="w-full text-sm">
                  <caption className="sr-only">Holdings value by type</caption>
                  <tbody>
                    {legend.map((g) => (
                      <tr key={g.key} className="border-b border-border last:border-0">
                        <td className="py-2">
                          <span className="inline-flex items-center gap-2">
                            <SeriesDot slot={g.slot} />
                            {g.label}
                          </span>
                        </td>
                        <td className="tabular py-2 text-right text-muted">{pct(g.cents, s.totalCents)}</td>
                        <td className="tabular py-2 pl-4 text-right font-medium">{f.money(g.cents, { whole: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* By currency */}
            <Card className="lg:col-span-2">
              <CardHeader title="By currency" subtitle={`What positions are priced in, converted to ${base}`} />
              <ul className="space-y-3">
                {s.currencies.map((c) => (
                  <li key={c.currency} className="text-sm">
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="font-medium">
                        {c.currency}
                        {c.currency === base && <span className="ml-1.5 text-xs font-normal text-muted">base</span>}
                      </span>
                      <span className="tabular shrink-0">
                        <span className="mr-3 text-muted">{pct(c.cents, s.totalCents)}</span>
                        <span className="font-medium">{f.money(c.cents, { whole: true })}</span>
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-muted"
                        style={{ width: `${s.totalCents > 0 ? Math.max(1, (c.cents / s.totalCents) * 100) : 0}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              {missingFx.length > 0 && (
                <p className="mt-4 text-xs text-ink-2">
                  <Badge tone="warning">No exchange rate</Badge> for {missingFx.join(", ")}: counted as 0 until rates
                  are fetched.
                </p>
              )}
            </Card>
          </div>

          {/* Holdings, by account */}
          {groups.map(({ account: a, rows: list }) => (
            <AccountHoldings
              key={a.id}
              account={a}
              rows={list}
              base={base}
              locale={f.locale}
              today={t}
              editId={editId}
              filterId={filter?.id ?? null}
              pickable={pickable}
              currencies={currencies}
            />
          ))}
        </>
      )}
    </div>
  );
}

function pct(part: number, total: number) {
  return `${total > 0 ? ((part / total) * 100).toFixed(1) : "0.0"}%`;
}

function FilterPill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-sm whitespace-nowrap transition-colors",
        active
          ? "border-transparent bg-brand-tint font-medium text-ink"
          : "border-border bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}

function AccountHoldings({
  account: a,
  rows,
  base,
  locale,
  today,
  editId,
  filterId,
  pickable,
  currencies,
}: {
  account: AccountWithBalance;
  rows: HoldingRow[];
  base: string;
  locale: string;
  today: string;
  editId: number | null;
  filterId: number | null;
  pickable: HoldingAccountOption[];
  currencies: string[];
}) {
  const baseCents = rows.reduce((sum, r) => sum + r.baseValueCents, 0);
  const meta = [a.institution, ACCOUNT_TYPES[a.type].label.replace(/\s*\(.*\)$/, ""), a.currency].filter(Boolean).join(" · ");
  const canAdd = pickable.some((p) => p.id === a.id);
  return (
    <Card className="pb-2">
      <div className="flex items-center gap-3 border-b border-border pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <Link href={`/accounts/${a.id}`} className="truncate hover:underline">
              {a.name}
            </Link>
            <span className="font-normal text-muted">{rows.length}</span>
            {a.archivedAt && <Badge>closed</Badge>}
          </h2>
          <div className="mt-0.5 truncate text-xs text-muted">{meta}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="tabular font-semibold">{moneyIn(a.balanceCents, a.currency, locale, { whole: true })}</div>
          {a.currency !== base && (
            <div className="tabular text-xs text-muted">{moneyIn(baseCents, base, locale, { whole: true })}</div>
          )}
        </div>
        {canAdd && (
          <ButtonLink
            href={hrefFor(filterId, { addTo: a.id })}
            scroll={false}
            size="sm"
            variant="ghost"
            aria-label={`Add a holding to ${a.name}`}
            title={`Add a holding to ${a.name}`}
            className="w-8 px-0"
          >
            <Plus size={16} />
          </ButtonLink>
        )}
      </div>

      <div role="table" aria-label={`Holdings in ${a.name}`}>
        <div role="row" className={clsx("hidden border-b border-border py-2 text-xs text-muted", COLS)}>
          <span role="columnheader">Holding</span>
          <span role="columnheader" className="text-right">
            Quantity
          </span>
          <span role="columnheader" className="text-right">
            Price
          </span>
          <span role="columnheader" className="text-right">
            Value
          </span>
          <span role="columnheader" className="text-right">
            Gain
          </span>
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
        <div role="rowgroup" className="divide-y divide-border">
          {rows.map((r) => (
            <HoldingRowView
              key={r.id}
              r={r}
              base={base}
              locale={locale}
              today={today}
              editing={editId === r.id}
              filterId={filterId}
              pickable={pickable}
              currencies={currencies}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

function HoldingRowView({
  r,
  base,
  locale,
  today,
  editing,
  filterId,
  pickable,
  currencies,
}: {
  r: HoldingRow;
  base: string;
  locale: string;
  today: string;
  editing: boolean;
  filterId: number | null;
  pickable: HoldingAccountOption[];
  currencies: string[];
}) {
  const state = priceState(r, today);
  const title = r.symbol ?? r.name;
  const qty = formatQuantity(r.quantity, locale);
  const price = r.unitPrice === null ? "—" : priceIn(r.unitPrice, r.currency, locale);
  const value = r.unitPrice === null ? "—" : moneyIn(r.valueCents, r.currency, locale);
  const showBase = r.currency !== base && r.unitPrice !== null;
  const gain =
    r.gainCents === null ? null : (
      <>
        <Delta value={r.gainCents}>
          {moneyIn(r.gainCents, r.currency, locale, { signed: true, whole: Math.abs(r.gainCents) >= 100_000 })}
        </Delta>
        {r.gainPct !== null && (
          <span className={clsx("tabular ml-1.5 lg:ml-0 lg:block lg:text-xs", r.gainCents >= 0 ? "text-gain-text" : "text-loss-text")}>
            {r.gainPct >= 0 ? "+" : ""}
            {r.gainPct.toFixed(1)}%
          </span>
        )}
      </>
    );
  const formValues = {
    id: r.id,
    accountId: r.accountId,
    symbol: r.symbol,
    name: r.name,
    assetType: r.assetType,
    quantity: r.quantity,
    currency: r.currency,
    costTotal: r.costBasis === null ? null : r.costBasis * r.quantity,
    manualPrice: r.manualPrice,
  };

  return (
    <div role="row" className={clsx("py-3", editing && "bg-surface")}>
      <div className={clsx("flex items-start gap-3", COLS)}>
        {/* Holding: symbol, type, flags, name (+ qty × price on small screens) */}
        <div role="cell" className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 font-medium break-words">{title}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
              <SeriesDot slot={HOLDING_TYPE_SLOT[r.assetType]} />
              {holdingTypeLabel(r.assetType)}
            </span>
            {state === "manual" && <Badge>manual price</Badge>}
            {state === "missing" && (
              <span title={r.symbol ? "No price fetched for this symbol yet: refresh, check the symbol, or set a manual price" : "Set a manual price"}>
                <Badge tone="warning">no price</Badge>
              </span>
            )}
            {state === "stale" && r.priceDate && (
              <span title={`Last market price from ${r.priceDate}`}>
                <Badge tone="warning">price {relativeDay(r.priceDate, today)}</Badge>
              </span>
            )}
          </div>
          {r.symbol && r.name !== r.symbol && <div className="mt-0.5 truncate text-xs text-muted">{r.name}</div>}
          <div className="tabular mt-0.5 text-xs text-muted lg:hidden">
            {qty} × {price}
          </div>
        </div>

        <div role="cell" className="tabular hidden text-right text-sm lg:block">
          {qty}
        </div>
        <div role="cell" className="tabular hidden text-right text-sm lg:block">
          {price}
        </div>

        {/* Value (native, then base) — on small screens the gain sits under it */}
        <div role="cell" className="shrink-0 text-right">
          <div className="tabular text-sm font-semibold">{value}</div>
          {showBase && <div className="tabular text-xs text-muted">{moneyIn(r.baseValueCents, base, locale)}</div>}
          {gain && <div className="mt-0.5 text-xs lg:hidden">{gain}</div>}
        </div>

        <div role="cell" className="hidden text-right text-sm lg:block">
          {gain ?? (
            <span className="text-muted" title="Add the total cost to see the gain">
              —
            </span>
          )}
        </div>

        <div role="cell" className="flex shrink-0 flex-col items-end gap-1 lg:flex-row lg:justify-end">
          {editing ? (
            <Link
              href={hrefFor(filterId)}
              scroll={false}
              aria-label={`Stop editing ${title}`}
              title="Close"
              className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"
            >
              <X size={14} />
            </Link>
          ) : (
            <Link
              href={hrefFor(filterId, { edit: r.id })}
              scroll={false}
              aria-label={`Edit ${title}`}
              title="Edit"
              className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"
            >
              <Pencil size={14} />
            </Link>
          )}
          <ConfirmButton action={deleteHoldingAction} fields={{ id: r.id }} title={`Delete ${title}`} />
        </div>
      </div>

      {editing && (
        <div className="mt-3 rounded-xl border border-border bg-surface-2/50 p-4">
          <HoldingForm
            accounts={pickable.some((p) => p.id === r.accountId) ? pickable : [...pickable, ...accountOption(r)]}
            currencies={currencies}
            holding={formValues}
            closeHref={hrefFor(filterId)}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}

/** The row's own account, when it isn't offered for new holdings (closed, or not an investment type). */
function accountOption(r: HoldingRow): HoldingAccountOption[] {
  return [{ id: r.accountId, name: r.accountName, currency: r.accountCurrency, type: "other_asset" }];
}
