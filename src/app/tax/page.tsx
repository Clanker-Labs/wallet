import Link from "next/link";
import { ChevronLeft, ChevronRight, Info, X } from "lucide-react";
import { countryName, listPresence, taxReport } from "@/server/services/tax";
import { listAccounts } from "@/server/services/accounts";
import { today } from "@/server/services/settings";
import { serverFormat } from "@/server/format";
import { formatDate } from "@/lib/dates";
import { Button, ButtonLink, Card, CardHeader, PageHeader, Stat } from "@/components/ui";
import { StayForm, TaxSettings } from "@/components/tax-forms";
import { deleteStayAction } from "./actions";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tax" };

const KIND_LABEL = { salary: "Salary", rental: "Rent", investment: "Investment income", freelance: "Freelance", other: "Other income" } as const;

export default async function TaxPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const uid = (await requireUser()).id;
  const f = serverFormat(uid);
  const t = today(uid);
  const thisYear = Number(t.slice(0, 4));
  const y = Number((await searchParams).year);
  const year = Number.isInteger(y) && y > 1990 && y <= thisYear ? y : thisYear - 1;
  const r = taxReport(uid, year);
  const stays = listPresence(uid, year);
  const accs = listAccounts(uid);
  const hasFrance = accs.some((a) => a.country === "FR");
  const companies = accs.filter((a) => a.companyParams).map((a) => ({ id: a.id, name: a.name, country: a.companyParams!.country }));
  const money = (v: number, currency: string) => f.money(Math.round(v * 100), { currency, whole: true });
  const byCountry = [...new Set(r.lines.map((l) => l.country))];

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Tax · ${year}`}
        subtitle="An estimate from your accounts, income and companies, country by country — not a filing."
        actions={
          <div className="flex items-center gap-1">
            <ButtonLink href={`/tax?year=${year - 1}`} size="sm" variant="ghost" aria-label="Previous year">
              <ChevronLeft size={16} />
            </ButtonLink>
            <span className="min-w-12 text-center text-sm font-medium">{year}</span>
            <ButtonLink href={`/tax?year=${year + 1}`} size="sm" variant="ghost" aria-label="Next year" className={year >= thisYear ? "pointer-events-none opacity-40" : ""}>
              <ChevronRight size={16} />
            </ButtonLink>
          </div>
        }
      />

      <Card>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat label="Estimated tax" value={f.money(r.totalBaseCents, { whole: true })} delta={<span className="text-muted">{r.totals.map((x) => money(x.tax, x.currency)).join(" + ") || "nothing due"}</span>} />
          <Stat label="Residence" value={r.residence ? countryName(r.residence) : "Not set"} />
          <Stat label="Days logged" value={String(r.days.reduce((s, d) => s + d.days, 0))} delta={<span className="text-muted">{r.days.map((d) => `${d.country} ${d.days}`).join(" · ") || "none"}</span>} />
          <Stat label="Income seen" value={String(r.income.length ? r.income.length : 0)} delta={<span className="text-muted">sources</span>} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Your situation" subtitle="Saved as you change it" />
        <TaxSettings year={year} inputs={r.inputs} hasFrance={hasFrance} companies={companies} />
      </Card>

      {byCountry.map((cc) => (
        <Card key={cc}>
          <CardHeader title={countryName(cc)} />
          <ul className="divide-y divide-border">
            {r.lines
              .filter((l) => l.country === cc)
              .map((l) => (
                <li key={l.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{l.title}</span>
                    <span className="tabular text-lg font-semibold">{money(l.tax, l.currency)}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    on {money(l.base, l.currency)} · {l.law}
                  </div>
                  <p className="mt-1 text-sm text-ink-2">{l.detail}</p>
                </li>
              ))}
          </ul>
        </Card>
      ))}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Income by source" subtitle="Categorized income on your own accounts, placed by each account's country" />
          {r.income.length === 0 ? (
            <p className="text-sm text-ink-2">No categorized income in {year}.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {r.income.map((i, n) => (
                <li key={n} className="flex justify-between py-1.5">
                  <span>
                    {KIND_LABEL[i.kind]} <span className="text-muted">· {countryName(i.country)}</span>
                  </span>
                  <span className="tabular">{money(i.amount, i.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Days per country" subtitle="For the residency tests" />
          <ul className="mb-3 space-y-1 text-sm">
            {r.residencyNotes.map((n, i) => (
              <li key={i} className="flex gap-2 text-ink-2">
                <Info size={14} className="mt-0.5 shrink-0 text-muted" /> {n}
              </li>
            ))}
          </ul>
          {stays.length > 0 && (
            <ul className="mb-3 divide-y divide-border text-sm">
              {stays.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-1">
                  <span>
                    {countryName(s.country)} <span className="text-muted">· {formatDate(s.fromDate)} → {formatDate(s.toDate)}</span>
                  </span>
                  <form action={deleteStayAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <Button type="submit" size="sm" variant="ghost" aria-label="Remove this stay">
                      <X size={14} />
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <StayForm year={year} />
        </Card>
      </div>

      <div className="space-y-1 text-xs text-muted">
        {r.notes.map((n, i) => (
          <p key={i}>{n}</p>
        ))}
        <p>
          Income is placed by the country of the account it arrived on — set it on each account (
          <Link href="/accounts" className="text-accent hover:underline">
            Accounts
          </Link>
          ).
        </p>
      </div>
    </div>
  );
}
