import Link from "next/link";
import { DateTime } from "luxon";
import { Archive, ArrowRight, CalendarClock, Plus } from "lucide-react";
import { accrualSeries, listJobs } from "@/server/services/jobs";
import { getSettings, today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { COMMON_CURRENCIES } from "@/lib/domain";
import { formatDate } from "@/lib/dates";
import { Badge, Button, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { AccrualChart } from "@/components/charts";
import { Disclosure } from "@/components/accounts-ui";
import { JobForm } from "@/components/jobs-form";
import { moneyIn } from "@/components/investments-model";
import { archiveAccountAction } from "../accounts/actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs" };

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ add?: string }> }) {
  const uid = (await requireUser()).id;
  const add = (await searchParams).add === "1";
  const f = serverFormat(uid);
  const t = today(uid);
  const base = getSettings(uid).currency;
  const jobs = listJobs(uid);
  const active = jobs.filter((j) => !j.archived);
  const paid = jobs.filter((j) => j.archived);
  const countedBase = active.filter((j) => j.includeInNetWorth).reduce((s, j) => s + j.account.baseOwnedCents, 0);
  const currencies = [...new Set<string>(["AED", "SAR", "QAR", ...COMMON_CURRENCIES, base])];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Jobs"
        subtitle={
          active.length
            ? `End-of-service gratuity accrued: ${f.money(countedBase, { whole: true })} counted in net worth`
            : "End-of-service gratuity, accrued every day under the law of the country each job is in"
        }
      />

      {active.length === 0 && !add && (
        <EmptyState title="No jobs yet">
          In the UAE, Saudi Arabia, Qatar and elsewhere, your employer owes you a gratuity when you leave, and it grows every day you
          stay. Add your job and wallet tracks it as an asset, using the country&apos;s labour law.
        </EmptyState>
      )}

      {active.map((j) => {
        const native = (n: number) => moneyIn(Math.round(n * 100), j.currency, f.locale, { whole: true });
        const differ = j.now.resignation.amount !== j.now.termination.amount;
        const series = accrualSeries(j.params, t);
        return (
          <Card key={j.accountId}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <Link href={`/accounts/${j.accountId}`} className="text-lg font-semibold hover:underline">
                  {j.employer}
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-ink-2">
                  {j.role && <span>{j.role} ·</span>}
                  <span>{j.rule.label}</span>
                  <span className="text-muted">· since {formatDate(j.params.startDate)}</span>
                  {j.params.endDate && <Badge tone="warning">ended {formatDate(j.params.endDate)}</Badge>}
                  {!j.includeInNetWorth && <Badge>not in net worth</Badge>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-3xl font-semibold tracking-tight">{native(j.counted.amount)}</div>
                <div className="text-xs text-muted">
                  {j.params.scenario === "termination" ? "if let go today" : "if you left today"}
                  {j.currency !== base && ` · ${f.money(j.account.baseOwnedCents, { whole: true })}`}
                </div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Service" value={`${j.counted.years.toFixed(2)} years`} />
              <Stat label="Accruing" value={j.params.endDate ? "stopped" : `${native(j.perDay)} / day`} />
              {differ ? (
                <>
                  <Stat label="If you resign" value={native(j.now.resignation.amount)} />
                  <Stat label={j.params.country === "FR" ? "If dismissed" : "If let go"} value={native(j.now.termination.amount)} />
                </>
              ) : (
                <Stat label="Monthly salary used" value={native(j.counted.salary)} className="sm:col-span-2" />
              )}
            </div>

            {j.counted.next && (
              <p className="mt-4 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
                <CalendarClock size={15} className="mt-0.5 shrink-0 text-muted" />
                <span>
                  <span className="font-medium">{DateTime.fromISO(j.counted.next.date).toFormat("d LLL yyyy")}</span> — {j.counted.next.text}
                </span>
              </p>
            )}

            <div className="mt-5">
              <AccrualChart points={series} currency={j.currency} />
            </div>
            <p className="mt-2 text-xs text-muted">
              {j.counted.formula} {j.rule.law}. A statutory minimum and an estimate: your contract may pay more, and unpaid leave
              can reduce the service counted.
            </p>

            <div className="mt-4 flex flex-wrap items-start gap-3 border-t border-border pt-4">
              <Disclosure className="min-w-0 flex-1" summary="Edit job">
                <div className="pt-4">
                  <JobForm
                    job={{ accountId: j.accountId, employer: j.employer, currency: j.currency, includeInNetWorth: j.includeInNetWorth, params: j.params }}
                    today={t}
                    currencies={currencies}
                    baseCurrency={base}
                  />
                </div>
              </Disclosure>
              <form action={archiveAccountAction}>
                <input type="hidden" name="id" value={j.accountId} />
                <Button type="submit" size="sm" variant="ghost" title="The gratuity was paid: it leaves net worth from today, its history stays">
                  <Archive size={14} /> Paid out
                </Button>
              </form>
            </div>
          </Card>
        );
      })}

      <Card>
        <Disclosure defaultOpen={add || jobs.length === 0} summary={<span className="inline-flex items-center gap-1.5 font-medium"><Plus size={15} /> Add a job</span>}>
          <div className="pt-4">
            <JobForm today={t} currencies={currencies} baseCurrency={base} />
          </div>
        </Disclosure>
      </Card>

      {paid.length > 0 && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Paid out</h2>
          <ul className="divide-y divide-border text-sm">
            {paid.map((j) => (
              <li key={j.accountId} className="flex items-center justify-between py-2">
                <span>
                  {j.employer} <span className="text-muted">· {j.rule.label}</span>
                </span>
                <Link href={`/accounts/${j.accountId}`} className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">
                  History <ArrowRight size={13} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
