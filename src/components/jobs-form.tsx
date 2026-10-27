"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { DateTime } from "luxon";
import {
  GRATUITY_COUNTRIES,
  GRATUITY_COUNTRY_KEYS,
  gratuityOn,
  gratuityParamsSchema,
  type ExitScenario,
  type GratuityCountry,
  type GratuityParams,
} from "@/lib/finance/gratuity";
import { saveJobAction } from "@/app/jobs/actions";
import { useFormat } from "./format";
import { Button, Field, Input, Select } from "./ui";
import { Segmented } from "./settings-kit";

const COUNTRY_CURRENCY: Partial<Record<GratuityCountry, string>> = { AE: "AED", AE_DIFC: "AED", SA: "SAR", QA: "QAR", FR: "EUR" };

export interface JobFormValues {
  accountId?: number;
  employer: string;
  currency: string;
  includeInNetWorth: boolean;
  params: GratuityParams;
}

/**
 * Add or edit a job. The gratuity is previewed live with the same rules the
 * server uses, so the number you see before saving is the one you get.
 */
export function JobForm({
  job,
  today,
  currencies,
  baseCurrency,
  onDone,
}: {
  job?: JobFormValues;
  today: string;
  currencies: string[];
  baseCurrency: string;
  onDone?: () => void;
}) {
  const f = useFormat();
  const p = job?.params;
  const [employer, setEmployer] = useState(job?.employer ?? "");
  const [role, setRole] = useState(p?.role ?? "");
  const [country, setCountry] = useState<GratuityCountry>(p?.country ?? "AE");
  const [currency, setCurrency] = useState(job?.currency ?? COUNTRY_CURRENCY.AE ?? baseCurrency);
  const [startDate, setStartDate] = useState(p?.startDate ?? "");
  const [endDate, setEndDate] = useState(p?.endDate ?? "");
  const [salaries, setSalaries] = useState<{ from: string; monthly: string }[]>(
    p?.salaries.map((s) => ({ from: s.from, monthly: String(s.monthly) })) ?? [{ from: "", monthly: "" }],
  );
  const [scenario, setScenario] = useState<ExitScenario>(p?.scenario ?? "resignation");
  const [includeInNetWorth, setInclude] = useState(job?.includeInNetWorth ?? true);
  const [days, setDays] = useState(String(p?.custom?.daysPerYear ?? 30));
  const [minYears, setMinYears] = useState(String(p?.custom?.minYears ?? 1));
  const [capMonths, setCapMonths] = useState(p?.custom?.capMonths ? String(p.custom.capMonths) : "");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const rule = GRATUITY_COUNTRIES[country];

  const params = useMemo(() => {
    const steps = salaries
      .map((s, i) => ({ from: i === 0 ? startDate : s.from, monthly: Number(s.monthly.replace(/[\s,']/g, "")) }))
      .filter((s) => s.from && Number.isFinite(s.monthly) && s.monthly > 0);
    const parsed = gratuityParamsSchema.safeParse({
      country,
      role: role || null,
      startDate,
      endDate: endDate || null,
      salaries: steps,
      scenario,
      custom: country === "CUSTOM" ? { daysPerYear: Number(days), minYears: Number(minYears), capMonths: capMonths ? Number(capMonths) : null } : null,
    });
    return parsed.success ? parsed.data : null;
  }, [country, role, startDate, endDate, salaries, scenario, days, minYears, capMonths]);

  const preview = params ? { resign: gratuityOn(params, today, "resignation"), fired: gratuityOn(params, today, "termination") } : null;
  const money = (v: number) => f.units(v, { currency, whole: true });

  const submit = () =>
    start(async () => {
      if (!params) return setMessage({ ok: false, text: "Fill in the employer, start date and salary." });
      const res = await saveJobAction({
        accountId: job?.accountId,
        employer,
        role: role || null,
        country,
        startDate: params.startDate,
        endDate: params.endDate ?? null,
        currency,
        salaries: params.salaries,
        scenario,
        custom: params.custom ?? null,
        includeInNetWorth,
      });
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) onDone?.();
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employer">
          <Input value={employer} onChange={(e) => setEmployer(e.target.value)} placeholder="Acme LLC" required maxLength={120} />
        </Field>
        <Field label="Role (optional)">
          <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Engineer" maxLength={120} />
        </Field>
        <Field label="Country (labour law)" className="sm:col-span-2" hint={rule.summary}>
          <Select
            value={country}
            onChange={(e) => {
              const c = e.target.value as GratuityCountry;
              setCountry(c);
              if (!job && COUNTRY_CURRENCY[c]) setCurrency(COUNTRY_CURRENCY[c]!);
            }}
          >
            {GRATUITY_COUNTRY_KEYS.map((k) => (
              <option key={k} value={k}>
                {GRATUITY_COUNTRIES[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Start date">
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required max={today} />
        </Field>
        <Field label="Last day (if it ended)">
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate || undefined} />
        </Field>
      </div>

      {country === "CUSTOM" && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Days' pay a year">
            <Input inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Field label="From (years)">
            <Input inputMode="decimal" value={minYears} onChange={(e) => setMinYears(e.target.value)} />
          </Field>
          <Field label="Cap (months' pay)">
            <Input inputMode="decimal" value={capMonths} onChange={(e) => setCapMonths(e.target.value)} placeholder="none" />
          </Field>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-end gap-3">
          <Field label={rule.salary} className="flex-1">
            <Input
              inputMode="decimal"
              value={salaries[0].monthly}
              onChange={(e) => setSalaries([{ ...salaries[0], monthly: e.target.value }, ...salaries.slice(1)])}
              placeholder="12000"
              required
            />
          </Field>
          <Field label="Currency" className="w-28">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {[...new Set([currency, ...currencies])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
        {salaries.slice(1).map((s, i) => (
          <div key={i} className="flex items-end gap-3">
            <Field label="Raise from" className="w-44">
              <Input type="date" value={s.from} min={startDate || undefined} onChange={(e) => setSalaries(salaries.map((x, j) => (j === i + 1 ? { ...x, from: e.target.value } : x)))} />
            </Field>
            <Field label="New monthly salary" className="flex-1">
              <Input inputMode="decimal" value={s.monthly} onChange={(e) => setSalaries(salaries.map((x, j) => (j === i + 1 ? { ...x, monthly: e.target.value } : x)))} />
            </Field>
            <Button type="button" variant="ghost" aria-label="Remove this raise" onClick={() => setSalaries(salaries.filter((_, j) => j !== i + 1))}>
              <X size={14} />
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="ghost" onClick={() => setSalaries([...salaries, { from: today, monthly: "" }])}>
          <Plus size={14} /> Add a raise
        </Button>
      </div>

      {(country === "SA" || country === "FR") && (
        <Field label="Count in net worth as if you…" hint="The law pays differently depending on how the job ends. Both are shown on the job either way.">
          <Segmented
            ariaLabel="Exit scenario"
            value={scenario}
            onChange={setScenario}
            options={[
              { value: "resignation", label: "Resign" },
              { value: "termination", label: country === "FR" ? "Are dismissed" : "Are let go" },
            ]}
          />
        </Field>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={includeInNetWorth} onChange={(e) => setInclude(e.target.checked)} />
        Count the accrued gratuity in net worth
      </label>

      {preview && (
        <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm">
          <div className="text-xs text-muted">
            {DateTime.fromISO(today).toFormat("d LLL yyyy")} · {preview.resign.years.toFixed(2)} years of service
          </div>
          <div className="mt-1 text-2xl font-semibold">{money(scenario === "termination" ? preview.fired.amount : preview.resign.amount)}</div>
          {preview.resign.amount !== preview.fired.amount && (
            <div className="text-xs text-ink-2">
              Resign: {money(preview.resign.amount)} · {country === "FR" ? "Dismissed" : "Let go"}: {money(preview.fired.amount)}
            </div>
          )}
          <div className="mt-1 text-xs text-ink-2">{(scenario === "termination" ? preview.fired : preview.resign).formula}</div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending || !employer || !params}>
          {job ? "Save job" : "Add job"}
        </Button>
        {onDone && job && (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
        {message && <span className={message.ok ? "text-sm text-good-text" : "text-sm text-critical-text"}>{message.text}</span>}
      </div>
    </form>
  );
}
