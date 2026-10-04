import { ChevronLeft, ChevronRight, Tag, Upload } from "lucide-react";
import { countUncategorized, firstTransactionMonth, listTransactions, transactionTotals } from "@/server/services/transactions";
import { listCategories, normalizePattern, suggestPattern } from "@/server/services/categories";
import { listAccounts } from "@/server/services/accounts";
import { today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { currentMonth, formatDate, isISODate, monthRange } from "@/lib/dates";
import { ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { ConfirmButton } from "@/components/accounts-ui";
import { CategorizeProgress, CategoryCell, QuickAdd, TxFilters, TxProvider, type TxFilterValues } from "@/components/transactions-ui";
import { deleteTransactionAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Transactions" };

const PAGE_SIZE = 50;

type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const posInt = (v: string | undefined) => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * Rule pattern to offer for a bank label. `suggestPattern` can produce a
 * pattern that doesn't match its own label ("PAYPAL *VINTED" → "paypal vinted"),
 * so fall back to the whole normalized label in that case.
 */
function rulePattern(description: string): string | null {
  const label = normalizePattern(description);
  const p = normalizePattern(suggestPattern(description));
  if (p.length >= 2 && label.includes(p)) return p;
  return label.length >= 2 && label.length <= 100 ? label : null;
}

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const from = one(sp.from);
  const to = one(sp.to);
  const categoryParam = one(sp.category);
  const filters: TxFilterValues = {
    from: from && isISODate(from) ? from : undefined,
    to: to && isISODate(to) ? to : undefined,
    category: categoryParam === "none" ? "none" : posInt(categoryParam) ? String(posInt(categoryParam)) : undefined,
    account: posInt(one(sp.account)) ? String(posInt(one(sp.account))) : undefined,
    q: one(sp.q)?.trim().slice(0, 100) || undefined,
  };
  let page = posInt(one(sp.page)) ?? 1;

  const query = {
    from: filters.from,
    to: filters.to,
    categoryId: filters.category === "none" ? ("none" as const) : filters.category ? Number(filters.category) : undefined,
    accountId: filters.account ? Number(filters.account) : undefined,
    search: filters.q,
  };
  let { rows, total } = listTransactions({ ...query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  if (rows.length === 0 && total > 0) {
    // Past the last page (e.g. after categorizing in the "Uncategorized" view): show the last one.
    page = Math.ceil(total / PAGE_SIZE);
    ({ rows, total } = listTransactions({ ...query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }));
  }
  const totals = transactionTotals(query);
  const uncategorized = countUncategorized();
  const categories = listCategories().map((c) => ({ id: c.id, name: c.name, icon: c.icon, kind: c.kind }));
  const allAccounts = listAccounts({ includeArchived: true });
  const activeAccounts = allAccounts.filter((a) => !a.archivedAt);
  const defaultAccount = activeAccounts.find((a) => a.type === "checking") ?? null;
  const t = today();
  const first = firstTransactionMonth();
  const months = first ? monthRange(first, currentMonth()).reverse() : [];
  const f = serverFormat();

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/transactions${qs ? `?${qs}` : ""}`;
  };
  const shortDate = (d: string) => (d.slice(0, 4) === t.slice(0, 4) ? formatDate(d).replace(/ \d{4}$/, "") : formatDate(d));
  const anyFilter = Object.values(filters).some(Boolean);
  const onlyUncategorized = filters.category === "none";

  return (
    <TxProvider categories={categories}>
      <div className="space-y-5">
        <PageHeader
          title="Transactions"
          subtitle={
            uncategorized > 0
              ? `${uncategorized} transaction${uncategorized > 1 ? "s" : ""} without a category — budgets only see categorized ones.`
              : "Everything is categorized. ✨"
          }
          actions={
            <>
              <ButtonLink href="/transactions/import">
                <Upload size={15} /> Import CSV
              </ButtonLink>
              {uncategorized > 0 && !onlyUncategorized && (
                <ButtonLink href="/transactions?category=none" variant="primary">
                  <Tag size={15} /> Categorize {uncategorized}
                </ButtonLink>
              )}
            </>
          }
        />

        <QuickAdd
          today={t}
          accounts={activeAccounts.map((a) => ({ id: a.id, name: a.name }))}
          defaultAccountId={defaultAccount?.id ?? null}
          defaultOpen={one(sp.add) === "1"}
        />

        <Card className="px-0 pb-2 sm:px-0">
          <div className="space-y-3 border-b border-border px-5 pb-4">
            <TxFilters
              key={filters.q ?? ""}
              months={months}
              current={filters}
              accounts={allAccounts.map((a) => ({ id: a.id, name: a.archivedAt ? `${a.name} (closed)` : a.name }))}
              uncategorized={uncategorized}
            />
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-sm text-ink-2">
                <span className="whitespace-nowrap">
                  <span className="font-medium text-ink">{totals.count.toLocaleString(f.locale)}</span> transaction
                  {totals.count === 1 ? "" : "s"}
                </span>
                <span className="text-muted"> · </span>
                <span className="whitespace-nowrap">
                  in <span className="tabular font-medium text-good-text">{f.money(totals.inCents, { signed: true })}</span>
                </span>
                <span className="text-muted"> · </span>
                <span className="whitespace-nowrap">
                  out <span className="tabular font-medium text-ink">{f.money(totals.outCents, { signed: true })}</span>
                </span>
              </p>
              <CategorizeProgress
                hint={
                  onlyUncategorized && total > 0
                    ? "Pick a category — then click ⚡ to auto-categorize the same merchant everywhere."
                    : undefined
                }
              />
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="p-5">
              {onlyUncategorized && !filters.q && !filters.account ? (
                <EmptyState title="Nothing left to categorize 🎉" action={<ButtonLink href="/transactions">All transactions</ButtonLink>}>
                  Your budgets see every transaction.
                </EmptyState>
              ) : anyFilter ? (
                <EmptyState title="No transactions match" action={<ButtonLink href="/transactions">Clear filters</ButtonLink>} />
              ) : (
                <EmptyState
                  title="No transactions yet"
                  action={
                    <ButtonLink href="/transactions/import" variant="primary">
                      <Upload size={15} /> Import a bank CSV
                    </ButtonLink>
                  }
                >
                  Export a CSV from your bank and import it — or use Quick add above.
                </EmptyState>
              )}
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[5.5rem_minmax(0,1fr)_9rem_15rem_7.5rem_2rem] gap-3 border-b border-border px-5 py-2 text-xs text-muted md:grid">
                <span>Date</span>
                <span>Description</span>
                <span>Account</span>
                <span>Category</span>
                <span className="text-right">Amount</span>
                <span />
              </div>
              <ul className="divide-y divide-border">
                {rows.map((r) => (
                  <li
                    key={r.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-5 py-3 md:grid-cols-[5.5rem_minmax(0,1fr)_9rem_15rem_7.5rem_2rem] md:items-start md:gap-y-0 md:py-2.5"
                  >
                    <div className="col-start-1 row-start-2 text-xs text-muted md:row-start-1 md:pt-1.5 md:text-sm md:text-ink-2">
                      <span className="whitespace-nowrap">{shortDate(r.date)}</span>
                      {r.accountName && <span className="md:hidden"> · {r.accountName}</span>}
                    </div>
                    <div className="col-start-1 row-start-1 min-w-0 md:col-start-2 md:pt-1.5">
                      <div className="text-sm break-words text-ink">{r.description}</div>
                      {r.notes && <div className="text-xs break-words text-muted">{r.notes}</div>}
                    </div>
                    <div className="hidden truncate pt-1.5 text-sm text-ink-2 md:col-start-3 md:row-start-1 md:block">
                      {r.accountName ?? <span className="text-muted">—</span>}
                    </div>
                    <div className="col-start-1 row-start-3 md:col-start-4 md:row-start-1">
                      <CategoryCell txId={r.id} categoryId={r.categoryId} pattern={rulePattern(r.description)} />
                    </div>
                    <div
                      className={`tabular col-start-2 row-start-1 text-right text-sm font-medium whitespace-nowrap md:col-start-5 md:pt-1.5 ${
                        r.amountCents > 0 ? "text-good-text" : "text-ink"
                      }`}
                    >
                      {f.money(r.amountCents, { signed: true })}
                    </div>
                    <div className="col-start-2 row-start-3 flex justify-end md:col-start-6 md:row-start-1 md:pt-0.5">
                      <ConfirmButton action={deleteTransactionAction} fields={{ id: r.id }} title="Delete transaction" />
                    </div>
                  </li>
                ))}
              </ul>

              {pages > 1 && (
                <nav className="flex items-center justify-between gap-3 border-t border-border px-5 pt-3 pb-1 text-sm" aria-label="Pages">
                  <span className="text-xs text-muted">
                    {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString(f.locale)}
                  </span>
                  <span className="flex items-center gap-1">
                    {page > 1 ? (
                      <ButtonLink href={pageHref(page - 1)} size="sm" variant="ghost">
                        <ChevronLeft size={14} /> Newer
                      </ButtonLink>
                    ) : null}
                    <span className="px-1 text-xs text-muted">
                      {page} / {pages}
                    </span>
                    {page < pages ? (
                      <ButtonLink href={pageHref(page + 1)} size="sm" variant="ghost">
                        Older <ChevronRight size={14} />
                      </ButtonLink>
                    ) : null}
                  </span>
                </nav>
              )}
            </>
          )}
        </Card>

      </div>
    </TxProvider>
  );
}
