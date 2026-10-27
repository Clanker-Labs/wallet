"use client";

import { useState, useTransition } from "react";
import { saveGoalAction } from "@/app/goals/actions";
import { Button, Field, Input, Select } from "./ui";

export interface GoalFormValues {
  id?: number;
  name: string;
  icon: string | null;
  target: number;
  currency: string;
  targetDate: string | null;
  accountIds: number[];
  monthly: number | null;
}

/** Add or edit a goal: an amount, maybe a date, and what counts towards it. */
export function GoalForm({ value, accounts, currencies, baseCurrency }: { value?: GoalFormValues; accounts: { id: number; name: string }[]; currencies: string[]; baseCurrency: string }) {
  const [name, setName] = useState(value?.name ?? "");
  const [icon, setIcon] = useState(value?.icon ?? "🎯");
  const [target, setTarget] = useState(value ? String(value.target) : "");
  const [currency, setCurrency] = useState(value?.currency ?? baseCurrency);
  const [date, setDate] = useState(value?.targetDate ?? "");
  const [ids, setIds] = useState<number[]>(value?.accountIds ?? []);
  const [monthly, setMonthly] = useState(value?.monthly != null ? String(value.monthly) : "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const n = (s: string) => Number(s.replace(/[\s,']/g, ""));
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveGoalAction(value?.id ?? null, {
            name,
            icon: icon || null,
            target: n(target),
            currency,
            targetDate: date || null,
            accountIds: ids,
            monthly: monthly ? n(monthly) : null,
          });
          setMsg({ ok: r.ok, text: r.message });
          if (r.ok && !value) {
            setName("");
            setTarget("");
          }
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Goal" className="sm:col-span-2">
          <div className="flex gap-2">
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} className="w-14 text-center" aria-label="Icon" maxLength={8} />
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Flat deposit" required maxLength={120} className="min-w-0 flex-1" />
          </div>
        </Field>
        <Field label="Amount">
          <Input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="60000" required />
        </Field>
        <Field label="Currency">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {[...new Set([currency, ...currencies])].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="By (optional)">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Planned monthly (optional)" hint="Empty: your average savings">
          <Input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="1500" />
        </Field>
        <Field label="Counts" className="sm:col-span-2" hint="The accounts that hold it, or nothing for your whole net worth">
          <div className="flex flex-wrap gap-1.5">
            {accounts.map((a) => {
              const on = ids.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setIds(on ? ids.filter((x) => x !== a.id) : [...ids, a.id])}
                  className={`rounded-full border px-2.5 py-1 text-xs transition ${on ? "border-accent bg-accent text-accent-ink" : "border-border text-ink-2 hover:text-ink"}`}
                >
                  {a.name}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending || !name || !target}>
          {value ? "Save goal" : "Add goal"}
        </Button>
        {msg && <span className={msg.ok ? "text-good-text" : "text-critical-text"}>{msg.text}</span>}
      </div>
    </form>
  );
}
