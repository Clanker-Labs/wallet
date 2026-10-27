import clsx from "clsx";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Banknote, Coins, History, Percent, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { historyStatus, investmentActivity, investmentIncome } from "@/server/services/broker-history";
import { listConnections } from "@/server/services/connections";
import { serverFormat } from "@/server/format";
import { formatDate } from "@/lib/dates";
import type { BrokerActivityKind } from "@/server/db/schema";
import { Badge, Button, Card, CardHeader, EmptyState, KpiTile, PageHeader, ViewTabs } from "@/components/ui";
import { IncomeChart } from "@/components/charts";
import { INVESTMENT_TABS, formatQuantity, moneyIn, priceIn } from "@/components/investments-model";
import { importHistoryAction } from "../actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Investment activity" };

const PAGE = 50;

const KINDS: { value: BrokerActivityKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "trade", label: "Trades" },
  { value: "dividend", label: "Dividends" },
  { value: "deposit", label: "Deposits" },
  { value: "withdrawal", label: "Withdrawals" },
  { value: "interest", label: "Interest" },
  { value: "fee", label: "Fees" },
];

const KIND_LABEL: Record<BrokerActivityKind, string> = {
  trade: "Trade",
  dividend: "Dividend",
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  interest: "Interest",
  fee: "Fee",
  other: "Other",
};

function href(kind: string, page: number, account: number | null) {
  const q = new URLSearchParams();
  if (kind !== "all") q.set("kind", kind);
  if (page > 1) q.set("page", String(page));
  if (account) q.set("account", String(account));
  const s = q.toString();
  return s ? `/investments/activity?${s}` : "/investments/activity";
}

function statusText(s: { historyStatus: string | null; running: boolean; historySyncedAt: Date | null }) {
  if (s.running || s.historyStatus === "running") return "Importing…";
  if (!s.historySyncedAt) return s.historyStatus ? s.historyStatus : "Not imported yet";
  if (s.historyStatus === "incomplete") return "Partly imported — the broker's rate limit stopped it; it carries on at the next run";
  if (s.historyStatus && s.historyStatus !== "ok") return s.historyStatus;
  return null;
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ kind?: string; page?: string; account?: string }> }) {
  const user = await requireUser();
  const uid = user.id;
  const sp = await searchParams;
  const f = serverFormat(uid);
  const kind = (KINDS.find((k) => k.value === sp.kind)?.value ?? "all") as BrokerActivityKind | "all";
  const page = Math.max(1, Number(sp.page) || 1);
  const account = Number(sp.account) > 0 ? Number(sp.account) : null;

  const activity = investmentActivity(uid, { kind: kind === "all" ? undefined : kind, accountId: account ?? undefined, limit: PAGE, offset: (page - 1) * PAGE });
  const everything = kind === "all" && !account ? activity : investmentActivity(uid, { limit: 1 });
  const income = investmentIncome(uid, { months: 12 });
  const statuses = historyStatus(uid);
  const connections = new Map(listConnections(uid).map((c) => [c.id, c]));
  const T = everything.totals;
  const pages = Math.max(1, Math.ceil(activity.total / PAGE));
  const anyIncome = income.months.some((m) => m.dividendsCents || m.interestCents);

  return (
    <div className="space-y-5 md:space-y-6">
      <PageHeader
        title="Activity"
        subtitle="Every trade, dividend, deposit and interest payment your brokers report, imported and kept here."
        actions={<ViewTabs label="Investments views" current="/investments/activity" tabs={INVESTMENT_TABS} />}
      />

      {statuses.length === 0 ? (
        <EmptyState title="No broker connected">
          Connect a Trading 212 account in <Link href="/settings#connections" className="font-medium text-accent hover:underline">Settings → Connections</Link>: its
          positions sync hourly, and its whole history of trades, dividends and deposits is imported here.
        </EmptyState>
      ) : (
        <>
          {/* Import status, one line per connection */}
          <Card className="py-4 md:py-4">
            <ul className="divide-y divide-border">
              {statuses.map((s) => {
                const c = connections.get(s.id);
                const note = statusText(s);
                const busy = s.running || s.historyStatus === "running";
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-tint text-accent">
                      <History size={17} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">
                        {c?.accountName ?? "Brokerage"}
                        {(c?.providerName ?? s.provider) !== c?.accountName && <span className="font-normal text-muted"> · {c?.providerName ?? s.provider}</span>}
                      </div>
                      <div className="text-xs text-muted">
                        {s.events.toLocaleString(f.locale)} events imported
                        {s.historySyncedAt && <> · last import {formatDate(s.historySyncedAt.toISOString().slice(0, 10))}</>}
                        {note && <> · <span className={busy ? "text-accent" : "text-ink-2"}>{note}</span></>}
                      </div>
                    </div>
                    <form action={importHistoryAction}>
                      <input type="hidden" name="connectionId" value={s.id} />
                      <Button type="submit" size="sm" disabled={busy}>
                        <RefreshCw size={13} className={busy ? "animate-spin" : undefined} aria-hidden /> {busy ? "Importing" : "Import again"}
                      </Button>
                    </form>
                  </li>
                );
              })}
            </ul>
          </Card>

          {everything.total > 0 && (
            <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-3 2xl:grid-cols-6">
              <KpiTile icon={<ArrowDownLeft size={14} />} label="Deposited" value={f.money(T.depositedCents - T.withdrawnCents, { whole: true })} foot={T.withdrawnCents ? <span className="text-muted">{f.money(T.withdrawnCents, { whole: true })} withdrawn</span> : <span className="text-muted">net of withdrawals</span>} />
              <KpiTile icon={<TrendingUp size={14} />} label="Bought" value={f.money(T.boughtCents, { whole: true })} />
              <KpiTile icon={<TrendingDown size={14} />} label="Sold" value={f.money(T.soldCents, { whole: true })} />
              <KpiTile
                icon={<ArrowUpRight size={14} />}
                label="Realised gains"
                value={<span className={T.realizedCents < 0 ? "text-critical-text" : T.realizedCents > 0 ? "text-good-text" : ""}>{f.money(T.realizedCents, { whole: true, signed: true })}</span>}
                foot={<span className="text-muted">{f.money(income.ytd.realizedCents, { whole: true, signed: true })} this year</span>}
              />
              <KpiTile icon={<Coins size={14} />} label="Dividends" value={f.money(T.dividendsCents)} foot={<span className="text-muted">{f.money(income.ytd.dividendsCents)} this year</span>} />
              <KpiTile icon={<Percent size={14} />} label="Interest on cash" value={f.money(T.interestCents)} foot={<span className="text-muted">{f.money(income.ytd.interestCents)} this year</span>} />
            </div>
          )}

          {anyIncome && (
            <Card>
              <CardHeader title="Passive income" subtitle={`Dividends and interest per month, last 12 months, in ${income.base}`} />
              <IncomeChart months={income.months} />
            </Card>
          )}

          <Card className="p-0 md:p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 md:px-6">
              <h2 className="text-[0.9375rem] font-semibold">
                History <span className="ml-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">{activity.total.toLocaleString(f.locale)}</span>
              </h2>
              <nav className="-mx-1 flex gap-1.5 overflow-x-auto px-1" aria-label="Filter by type">
                {KINDS.map((k) => (
                  <Link
                    key={k.value}
                    href={href(k.value, 1, account)}
                    scroll={false}
                    aria-current={k.value === kind ? "page" : undefined}
                    className={clsx(
                      "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-medium whitespace-nowrap transition",
                      k.value === kind ? "border-transparent bg-brand-tint text-ink" : "border-border text-ink-2 hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    {k.label}
                  </Link>
                ))}
              </nav>
            </div>

            {activity.rows.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm text-muted">{everything.total ? "Nothing of this type." : "No history imported yet."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted">
                      <th className="py-2.5 pr-3 pl-5 font-medium md:pl-6">Date</th>
                      <th className="px-3 py-2.5 font-medium">Type</th>
                      <th className="px-3 py-2.5 font-medium">Instrument</th>
                      <th className="px-3 py-2.5 text-right font-medium">Quantity</th>
                      <th className="px-3 py-2.5 text-right font-medium">Price</th>
                      <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                      <th className="py-2.5 pr-5 pl-3 text-right font-medium md:pr-6">Realised</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {activity.rows.map((r) => {
                      const side = r.kind === "trade" ? (r.quantity !== null && r.quantity < 0 ? "Sell" : "Buy") : KIND_LABEL[r.kind];
                      const tone = r.kind === "trade" ? (side === "Buy" ? "accent" : "neutral") : r.kind === "dividend" || r.kind === "interest" ? "good" : r.kind === "fee" || r.kind === "withdrawal" ? "warning" : "neutral";
                      return (
                        <tr key={r.id} className="transition-colors hover:bg-surface-2/60">
                          <td className="tabular py-2.5 pr-3 pl-5 whitespace-nowrap text-ink-2 md:pl-6">{formatDate(r.date)}</td>
                          <td className="px-3 py-2.5">
                            <Badge tone={tone}>{side}</Badge>
                          </td>
                          <td className="max-w-[18rem] px-3 py-2.5">
                            {r.name || r.ticker ? (
                              <>
                                <div className="truncate font-medium" title={r.name ?? undefined}>{r.name ?? r.ticker}</div>
                                {r.symbol && <div className="truncate text-xs text-muted">{r.symbol}</div>}
                              </>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-ink-2">
                                <Banknote size={14} className="text-muted" aria-hidden /> Cash
                              </span>
                            )}
                          </td>
                          <td className="tabular px-3 py-2.5 text-right text-ink-2">{r.quantity !== null ? formatQuantity(Math.abs(r.quantity), f.locale) : ""}</td>
                          <td className="tabular px-3 py-2.5 text-right text-ink-2">{r.price !== null && r.priceCurrency ? priceIn(r.price, r.priceCurrency, f.locale) : ""}</td>
                          <td className={clsx("tabular px-3 py-2.5 text-right font-medium", r.cashCents > 0 ? "text-good-text" : "")}>
                            {moneyIn(r.cashCents, r.currency, f.locale, { signed: true })}
                          </td>
                          <td className={clsx("tabular py-2.5 pr-5 pl-3 text-right md:pr-6", r.realizedCents ? (r.realizedCents < 0 ? "text-critical-text" : "text-good-text") : "")}>
                            {r.realizedCents ? moneyIn(r.realizedCents, r.currency, f.locale, { signed: true }) : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {pages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm md:px-6">
                <span className="text-muted">
                  Page {page} of {pages}
                </span>
                <div className="flex gap-2">
                  {page > 1 && (
                    <Link href={href(kind, page - 1, account)} scroll={false} className="rounded-xl border border-border px-3 py-1.5 hover:bg-surface-2">
                      Newer
                    </Link>
                  )}
                  {page < pages && (
                    <Link href={href(kind, page + 1, account)} scroll={false} className="rounded-xl border border-border px-3 py-1.5 hover:bg-surface-2">
                      Older
                    </Link>
                  )}
                </div>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
