"use client";

import { useState, useTransition } from "react";
import { saveRecurringAction } from "@/app/recurring/actions";
import type { RecurringCadence } from "@/server/db/schema";
import { Button, Field, Input, Select } from "./ui";
import { Segmented } from "./settings-kit";

export interface RecurringFormValues {
  id?: number;
  name: string;
  pattern: string;
  amount: number;
  currency: string;
  cadence: RecurringCadence;
  nextDate: string;
  accountId: number | null;
  categoryId: number | null;
}

const CADENCE_LABELS: Record<RecurringCadence, string> = {
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Every month",
  quarterly: "Every quarter",
  yearly: "Every year",
};

/** Add or edit a recurring item: salary in, rent or a subscription out. */
export function RecurringForm({
  value,
  accounts,
  categories,
  currencies,
  baseCurrency,
  today,
}: {
  value?: RecurringFormValues;
  accounts: { id: number; name: string; currency: string }[];
  categories: { id: number; name: string; icon: string | null; kind: string }[];
  currencies: string[];
  baseCurrency: string;
  today: string;
}) {
  const [name, setName] = useState(value?.name ?? "");
  const [pattern, setPattern] = useState(value?.pattern ?? "");
  const [direction, setDirection] = useState<"out" | "in">(value && value.amount > 0 ? "in" : "out");
  const [amount, setAmount] = useState(value ? String(Math.abs(value.amount)) : "");
  const [accountId, setAccountId] = useState(value?.accountId ? String(value.accountId) : "");
  const [currency, setCurrency] = useState(value?.currency ?? baseCurrency);
  const [cadence, setCadence] = useState<RecurringCadence>(value?.cadence ?? "monthly");
  const [nextDate, setNextDate] = useState(value?.nextDate ?? today);
  const [categoryId, setCategoryId] = useState(value?.categoryId ? String(value.categoryId) : "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      const n = Number(amount.replace(/[\s,']/g, ""));
      if (!name || !Number.isFinite(n) || n <= 0) return setMsg({ ok: false, text: "Give it a name and an amount." });
      const res = await saveRecurringAction(value?.id ?? null, {
        name,
        pattern: pattern || undefined,
        amount: direction === "out" ? -n : n,
        currency,
        cadence,
        nextDate,
        accountId: accountId ? Number(accountId) : null,
        categoryId: categoryId ? Number(categoryId) : null,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok && !value) {
        setName("");
        setPattern("");
        setAmount("");
      }
    });

  const kinds = direction === "in" ? ["income"] : ["expense", "transfer"];
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Segmented
        ariaLabel="Direction"
        value={direction}
        onChange={setDirection}
        options={[
          { value: "out", label: "Money out (rent, a bill)" },
          { value: "in", label: "Money in (salary)" },
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={direction === "in" ? "Salary" : "Rent"} required maxLength={120} />
        </Field>
        <Field label="Bank label contains" hint="How to recognise it on a statement. Default: the name.">
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={direction === "in" ? "acme llc" : "loyer"} maxLength={120} />
        </Field>
        <div className="flex items-end gap-2">
          <Field label="Amount" className="flex-1">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1500" required />
          </Field>
          <Field label="Currency" className="w-24">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {[...new Set([currency, ...currencies])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="How often">
          <Select value={cadence} onChange={(e) => setCadence(e.target.value as RecurringCadence)}>
            {Object.entries(CADENCE_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Next expected">
          <Input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} required />
        </Field>
        <Field label="Account">
          <Select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              const a = accounts.find((x) => String(x.id) === e.target.value);
              if (a) setCurrency(a.currency);
            }}
          >
            <option value="">Any account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">None</option>
            {categories
              .filter((c) => kinds.includes(c.kind))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon} {c.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {value ? "Save" : "Add"}
        </Button>
        {msg && <span className={msg.ok ? "text-sm text-good-text" : "text-sm text-critical-text"}>{msg.text}</span>}
      </div>
    </form>
  );
}
