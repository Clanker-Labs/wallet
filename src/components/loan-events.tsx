"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import type { LoanEvent } from "@/lib/domain";
import { saveLoanEventsAction } from "@/app/accounts/actions";
import { useFormat } from "./format";
import { Button, Field, Input, Select } from "./ui";

/** Early repayments and renegotiations of a loan; the schedule (and balance) follow. */
export function LoanEvents({ accountId, events, currency, today }: { accountId: number; events: LoanEvent[]; currency: string; today: string }) {
  const f = useFormat();
  const [type, setType] = useState<LoanEvent["type"]>("prepayment");
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [rate, setRate] = useState("");
  const [keep, setKeep] = useState<"duration" | "payment">("duration");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));

  const save = (next: LoanEvent[]) =>
    start(async () => {
      const r = await saveLoanEventsAction(accountId, next);
      setMsg({ ok: r.ok, text: r.message });
    });

  return (
    <div className="space-y-3 text-sm">
      <div className="text-xs font-medium text-ink-2">Changes to the loan</div>
      {sorted.length === 0 ? (
        <p className="text-xs text-muted">None — the original schedule applies.</p>
      ) : (
        <ul className="space-y-1">
          {sorted.map((e, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span>
                <span className="tabular text-xs text-muted">{e.date}</span>{" "}
                {e.type === "prepayment" ? `Repaid ${f.money(Math.round((e.amount ?? 0) * 100), { currency, whole: true })} early` : `Rate changed to ${e.ratePct}%`}
                <span className="text-xs text-muted"> · {e.keep === "payment" ? "same payment, shorter loan" : "same end date, new payment"}</span>
              </span>
              <Button size="sm" variant="ghost" aria-label="Remove this change" disabled={pending} onClick={() => save(sorted.filter((_, j) => j !== i))}>
                <X size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const ev: LoanEvent =
            type === "prepayment"
              ? { date, type, amount: Number(amount.replace(/[\s,']/g, "")), keep }
              : { date, type, ratePct: Number(rate.replace(",", ".")), keep };
          if ((type === "prepayment" && !(ev.amount! > 0)) || (type === "rate_change" && !Number.isFinite(ev.ratePct))) {
            setMsg({ ok: false, text: type === "prepayment" ? "How much was repaid?" : "What is the new rate?" });
            return;
          }
          save([...sorted, ev]);
          setAmount("");
          setRate("");
        }}
      >
        <Field label="What happened" className="w-44">
          <Select value={type} onChange={(e) => setType(e.target.value as LoanEvent["type"])}>
            <option value="prepayment">Repaid early</option>
            <option value="rate_change">Rate renegotiated</option>
          </Select>
        </Field>
        <Field label="On" className="w-40">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        {type === "prepayment" ? (
          <Field label={`Amount (${currency})`} className="w-32">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20000" />
          </Field>
        ) : (
          <Field label="New rate (%)" className="w-28">
            <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="3.1" />
          </Field>
        )}
        <Field label="Then keep" className="w-52">
          <Select value={keep} onChange={(e) => setKeep(e.target.value as "duration" | "payment")}>
            <option value="duration">the end date (lower payment)</option>
            <option value="payment">the payment (ends sooner)</option>
          </Select>
        </Field>
        <Button type="submit" disabled={pending}>
          Add
        </Button>
        {msg && <span className={msg.ok ? "text-good-text" : "text-critical-text"}>{msg.text}</span>}
      </form>
    </div>
  );
}
