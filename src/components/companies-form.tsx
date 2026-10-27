"use client";

import { useState, useTransition } from "react";
import { saveCompanyAction, saveFinancialsAction } from "@/app/companies/actions";
import { COUNTRIES, type CompanyParams } from "@/lib/domain";
import { Button, Field, Input, Select } from "./ui";

const VALUATIONS: { value: CompanyParams["valuation"]; label: string; hint: string }[] = [
  { value: "book", label: "Book value", hint: "What its own accounts hold, minus its debts. Attach its bank and loans to it." },
  { value: "profit_multiple", label: "Profit × multiple", hint: "Last 12 months' profit times a multiple (small service businesses: 2–5)." },
  { value: "revenue_multiple", label: "Revenue × multiple", hint: "Last 12 months' revenue times a multiple (SaaS: 3–10, agencies: ~1)." },
  { value: "manual", label: "I'll enter its value", hint: "A valuation from a funding round or an offer; record new ones on its page." },
];

export interface CompanyFormValues {
  accountId?: number;
  name: string;
  currency: string;
  ownershipPct: number;
  params: CompanyParams;
}

export function CompanyForm({ value, currencies, baseCurrency }: { value?: CompanyFormValues; currencies: string[]; baseCurrency: string }) {
  const [name, setName] = useState(value?.name ?? "");
  const [country, setCountry] = useState(value?.params.country ?? "AE");
  const [legalForm, setLegalForm] = useState(value?.params.legalForm ?? "");
  const [currency, setCurrency] = useState(value?.currency ?? (country === "AE" ? "AED" : baseCurrency));
  const [ownership, setOwnership] = useState(String(value?.ownershipPct ?? 100));
  const [valuation, setValuation] = useState<CompanyParams["valuation"]>(value?.params.valuation ?? "book");
  const [multiple, setMultiple] = useState(value?.params.multiple ? String(value.params.multiple) : "");
  const [initial, setInitial] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const v = VALUATIONS.find((x) => x.value === valuation)!;

  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await saveCompanyAction({
            accountId: value?.accountId,
            name,
            currency,
            ownershipPct: Number(ownership) || 100,
            params: { country, legalForm: legalForm || null, valuation, multiple: multiple ? Number(multiple) : null },
            ...(valuation === "manual" && initial ? { initialValue: Number(initial.replace(/[\s,']/g, "")) } : {}),
          });
          setMsg({ ok: res.ok, text: res.message });
          if (res.ok && !value) setName("");
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Company name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Acme FZ-LLC" />
        </Field>
        <Field label="Country" hint="Where it is taxed">
          <Select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Legal form (optional)">
          <Input value={legalForm} onChange={(e) => setLegalForm(e.target.value)} placeholder={country === "FR" ? "SAS, SARL, EURL…" : country === "AE" ? "FZ-LLC, LLC…" : "LLC, Ltd…"} maxLength={60} />
        </Field>
        <Field label="Its books are in">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {[...new Set([currency, ...currencies])].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Your share (%)">
          <Input inputMode="decimal" value={ownership} onChange={(e) => setOwnership(e.target.value)} />
        </Field>
        <Field label="How to value it" hint={v.hint}>
          <Select value={valuation} onChange={(e) => setValuation(e.target.value as CompanyParams["valuation"])}>
            {VALUATIONS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </Select>
        </Field>
        {(valuation === "revenue_multiple" || valuation === "profit_multiple") && (
          <Field label="Multiple">
            <Input inputMode="decimal" value={multiple} onChange={(e) => setMultiple(e.target.value)} placeholder={valuation === "revenue_multiple" ? "1" : "5"} />
          </Field>
        )}
        {valuation === "manual" && !value && (
          <Field label="Value of 100% today">
            <Input inputMode="decimal" value={initial} onChange={(e) => setInitial(e.target.value)} placeholder="1000000" />
          </Field>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending || !name}>
          {value ? "Save company" : "Add company"}
        </Button>
        {msg && <span className={msg.ok ? "text-good-text" : "text-critical-text"}>{msg.text}</span>}
      </div>
    </form>
  );
}

/** One month of revenue and expenses, for figures that don't come from an imported bank. */
export function FinancialsForm({ companyId, currency, month }: { companyId: number; currency: string; month: string }) {
  const [m, setM] = useState(month);
  const [revenue, setRevenue] = useState("");
  const [expenses, setExpenses] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveFinancialsAction(companyId, m, Number(revenue.replace(/[\s,']/g, "")) || 0, Number(expenses.replace(/[\s,']/g, "")) || 0);
          setMsg({ ok: r.ok, text: r.message });
          if (r.ok) {
            setRevenue("");
            setExpenses("");
          }
        });
      }}
    >
      <Field label="Month" className="w-36">
        <Input type="month" value={m} onChange={(e) => setM(e.target.value)} required />
      </Field>
      <Field label={`Revenue (${currency})`} className="w-36">
        <Input inputMode="decimal" value={revenue} onChange={(e) => setRevenue(e.target.value)} placeholder="0" />
      </Field>
      <Field label={`Expenses (${currency})`} className="w-36">
        <Input inputMode="decimal" value={expenses} onChange={(e) => setExpenses(e.target.value)} placeholder="0" />
      </Field>
      <Button type="submit" disabled={pending}>
        Save month
      </Button>
      {msg && <span className={msg.ok ? "text-good-text" : "text-critical-text"}>{msg.text}</span>}
    </form>
  );
}
