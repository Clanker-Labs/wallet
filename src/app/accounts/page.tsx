import Link from "next/link";
import { Archive, Plus, X } from "lucide-react";
import { listAccounts, type AccountWithBalance } from "@/server/services/accounts";
import { today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { ACCOUNT_TYPES, ASSET_CLASSES, ASSET_CLASS_LABELS, ASSET_CLASS_SLOT, isLiability } from "@/lib/domain";
import { formatDate } from "@/lib/dates";
import { Badge, Button, ButtonLink, Card, CardHeader, EmptyState, PageHeader, SeriesDot } from "@/components/ui";
import { AccountForm } from "@/components/accounts-form";
import { BalanceUpdater, Disclosure } from "@/components/accounts-ui";
import { unarchiveAccountAction } from "./actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accounts" };

const STALE_DAYS = 35;

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function updatedLabel(days: number | null) {
  if (days === null) return "never updated";
  if (days <= 0) return "updated today";
  if (days === 1) return "updated yesterday";
  if (days < 60) return `updated ${days} days ago`;
  return `updated ${Math.round(days / 30)} months ago`;
}

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const uid = (await requireUser()).id;
  const params = await searchParams;
  const f = serverFormat(uid);
  const t = today(uid);
  const all = listAccounts(uid, { includeArchived: true });
  const active = all.filter((a) => !a.archivedAt);
  const archived = all.filter((a) => a.archivedAt);
  const properties = active.filter((a) => a.assetClass === "real_estate").map((a) => ({ id: a.id, name: a.name }));
  const adding = params.new === "1" || active.length === 0;

  const counted = active.filter((a) => a.includeInNetWorth);
  const assetsCents = counted.filter((a) => !isLiability(a.assetClass)).reduce((s, a) => s + a.ownedCents, 0);
  const liabilitiesCents = counted.filter((a) => isLiability(a.assetClass)).reduce((s, a) => s + a.ownedCents, 0);
  const netCents = assetsCents - liabilitiesCents;

  const groups = ASSET_CLASSES.map((c) => {
    const accounts = active.filter((a) => a.assetClass === c);
    const totalCents = accounts.filter((a) => a.includeInNetWorth).reduce((s, a) => s + a.ownedCents, 0);
    return { key: c, label: ASSET_CLASS_LABELS[c], accounts, totalCents };
  }).filter((g) => g.accounts.length > 0);

  const staleCount = active.filter((a) => isStale(a, t)).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Accounts"
        subtitle={
          staleCount > 0
            ? `${staleCount} balance${staleCount > 1 ? "s" : ""} to refresh — click “Update”, type the amount, press Enter.`
            : "All balances are fresh. Click “Update” on a row to record a new balance."
        }
        actions={
          !adding && (
            <ButtonLink href="/accounts?new=1" scroll={false}>
              <Plus size={15} /> Add account
            </ButtonLink>
          )
        }
      />

      {adding && (
        <Card>
          <CardHeader
            title="Add account"
            subtitle="Bank, savings, investments, property, loan…"
            action={
              active.length > 0 && (
                <ButtonLink href="/accounts" scroll={false} size="sm" variant="ghost" aria-label="Close">
                  <X size={16} />
                </ButtonLink>
              )
            }
          />
          <AccountForm properties={properties} autoFocus />
        </Card>
      )}

      {active.length === 0 ? (
        <EmptyState title="No accounts yet">
          Add your bank account, savings, investments, property or loans with today’s balance — your net worth builds up from
          there.
        </EmptyState>
      ) : (
        <>
          {groups.map((g) => {
            const liability = isLiability(g.key);
            const pct = assetsCents > 0 ? (g.totalCents / assetsCents) * 100 : 0;
            return (
              <Card key={g.key} className="pb-2">
                <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                  <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    {!liability && <SeriesDot slot={ASSET_CLASS_SLOT[g.key as keyof typeof ASSET_CLASS_SLOT]} />}
                    <span className="truncate">{g.label}</span>
                    <span className="font-normal text-muted">{g.accounts.length}</span>
                  </h2>
                  <div className="flex shrink-0 items-baseline gap-3">
                    <span
                      className="tabular text-xs text-muted"
                      title={liability ? "Debt as a share of gross assets" : "Share of gross assets"}
                    >
                      {pct.toFixed(1)}%
                    </span>
                    <span className={liability ? "tabular font-semibold text-critical-text" : "tabular font-semibold"}>
                      {f.money(liability ? -g.totalCents : g.totalCents, { whole: true })}
                    </span>
                  </div>
                </div>
                <ul className="divide-y divide-border">
                  {g.accounts.map((a) => (
                    <AccountRow key={a.id} a={a} t={t} money={f.money} />
                  ))}
                </ul>
              </Card>
            );
          })}

          <Card>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-sm text-muted">Net worth</div>
                <div className="tabular mt-1 text-3xl font-semibold tracking-tight">{f.money(netCents, { whole: true })}</div>
              </div>
              <div className="flex gap-6 text-sm">
                <div>
                  <div className="text-xs text-muted">Assets</div>
                  <div className="tabular font-medium">{f.money(assetsCents, { whole: true })}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Liabilities</div>
                  <div className="tabular font-medium">{f.money(-liabilitiesCents, { whole: true })}</div>
                </div>
              </div>
            </div>
          </Card>
        </>
      )}

      {archived.length > 0 && (
        <Card className="py-3">
          <Disclosure
            focusOnOpen={false}
            summaryClassName="py-1"
            summary={
              <span className="flex items-center gap-2 text-sm font-medium text-ink-2">
                <Archive size={15} className="text-muted" /> Archived <span className="font-normal text-muted">{archived.length}</span>
              </span>
            }
          >
            <ul className="mt-2 divide-y divide-border">
              {archived.map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/accounts/${a.id}`} className="block truncate text-sm font-medium hover:underline">
                      {a.name}
                    </Link>
                    <div className="truncate text-xs text-muted">
                      {[a.institution, shortTypeLabel(a.type), `closed ${formatDate(a.archivedAt!)}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <form action={unarchiveAccountAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <Button type="submit" size="sm">
                      Unarchive
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          </Disclosure>
        </Card>
      )}
    </div>
  );
}

/** "Savings (Livret A, LDDS…)" → "Savings" for compact rows. */
function shortTypeLabel(type: AccountWithBalance["type"]) {
  return ACCOUNT_TYPES[type].label.replace(/\s*\(.*\)$/, "");
}

function isStale(a: AccountWithBalance, t: string) {
  if (a.derivedFromLoan || !a.includeInNetWorth) return false;
  return a.lastUpdated === null || daysBetween(a.lastUpdated, t) > STALE_DAYS;
}

function AccountRow({
  a,
  t,
  money,
}: {
  a: AccountWithBalance;
  t: string;
  money: ReturnType<typeof serverFormat>["money"];
}) {
  const liability = isLiability(a.assetClass);
  const sign = liability ? -1 : 1;
  const days = a.lastUpdated ? daysBetween(a.lastUpdated, t) : null;
  const stale = isStale(a, t);
  const partial = a.ownershipPct !== 100;
  const meta = [a.institution, shortTypeLabel(a.type)].filter(Boolean).join(" · ");

  return (
    <li className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link href={`/accounts/${a.id}`} className="min-w-0 font-medium break-words hover:underline">
            {a.name}
          </Link>
          {partial && <Badge>{+a.ownershipPct.toFixed(2)}%</Badge>}
          {!a.includeInNetWorth && <Badge>not counted</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
          {meta && <span>{meta}</span>}
          {meta && !a.derivedFromLoan && <span aria-hidden>·</span>}
          {a.derivedFromLoan ? null : stale ? (
            <Badge tone="warning">{updatedLabel(days)}</Badge>
          ) : (
            <span>{updatedLabel(days)}</span>
          )}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="tabular font-semibold">{money(sign * a.ownedCents, { whole: true })}</div>
        {partial && <div className="tabular text-xs text-muted">of {money(sign * a.balanceCents, { whole: true })}</div>}
      </div>
      <div className="flex w-[5.5rem] shrink-0 justify-end sm:w-28">
        {a.derivedFromLoan ? (
          <span className="text-right text-xs text-muted" title="The balance follows the amortization schedule">
            auto · amortizing
          </span>
        ) : (
          <BalanceUpdater accountId={a.id} />
        )}
      </div>
    </li>
  );
}
