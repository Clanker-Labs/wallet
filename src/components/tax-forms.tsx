"use client";

import { useState, useTransition } from "react";
import { addStayAction, setTaxInputAction } from "@/app/tax/actions";
import { COUNTRIES } from "@/lib/domain";
import { Button, Field, Input, Select } from "./ui";

/** The few answers the estimate needs, saved as you change them. */
export function TaxSettings({ year, inputs, hasFrance, companies }: { year: number; inputs: Record<string, string>; hasFrance: boolean; companies: { id: number; name: string; country: string }[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (y: number, key: string, value: string) =>
    start(async () => {
      const r = await setTaxInputAction(y, key, value);
      setMsg(r.ok ? "Saved" : r.message);
    });
  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Tax residence" hint="Where you live for tax (all years)">
        <Select defaultValue={inputs.residence ?? ""} onChange={(e) => save(0, "residence", e.target.value)} disabled={pending}>
          <option value="">Not set</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Home or job in the UAE" hint="Lowers the UAE residency test to 90 days">
        <Select defaultValue={inputs.homeOrJobInUae ?? ""} onChange={(e) => save(0, "homeOrJobInUae", e.target.value)} disabled={pending}>
          <option value="">No / not sure</option>
          <option value="true">Yes</option>
        </Select>
      </Field>
      {(hasFrance || inputs.residence === "FR") && (
        <>
          <Field label="French family parts" hint={`${year}: 1 single, 2 a couple, +0.5 per child (×2 from the 3rd)`}>
            <Input type="number" step="0.5" min="1" defaultValue={inputs["fr.parts"] ?? "1"} onBlur={(e) => save(year, "fr.parts", e.target.value)} />
          </Field>
          <Field label="French rental regime" hint="Micro: 30% flat allowance up to 15,000 € gross. Réel: costs and loan interest.">
            <Select defaultValue={inputs["fr.rental.regime"] ?? "micro"} onChange={(e) => save(year, "fr.rental.regime", e.target.value)} disabled={pending}>
              <option value="micro">Micro-foncier</option>
              <option value="reel">Régime réel</option>
            </Select>
          </Field>
          {inputs["fr.rental.regime"] === "reel" && (
            <Field label="Rental costs in the year (€)" hint="Charges, works, insurance, property tax; loan interest is added from the schedule">
              <Input inputMode="decimal" defaultValue={inputs["fr.rental.expenses"] ?? ""} onBlur={(e) => save(year, "fr.rental.expenses", e.target.value)} />
            </Field>
          )}
          <Field label="Social security" hint="Decides 17.2% or 7.5% social charges on French rent">
            <Select defaultValue={inputs["fr.socialRate"] ?? "standard"} onChange={(e) => save(0, "fr.socialRate", e.target.value)} disabled={pending}>
              <option value="standard">Not in the EEA/UK/Switzerland (17.2%)</option>
              <option value="eea">Covered in the EEA/UK/Switzerland (7.5%)</option>
            </Select>
          </Field>
        </>
      )}
      {companies
        .filter((c) => c.country === "AE")
        .map((c) => (
          <Field key={c.id} label={`${c.name}: UAE reliefs`} hint="Small Business Relief needs revenue ≤ AED 3M and must be elected">
            <Select
              defaultValue={inputs[`company.${c.id}.qfzp`] === "true" ? "qfzp" : inputs[`company.${c.id}.sbr`] === "true" ? "sbr" : ""}
              onChange={(e) => {
                save(year, `company.${c.id}.sbr`, e.target.value === "sbr" ? "true" : "");
                save(year, `company.${c.id}.qfzp`, e.target.value === "qfzp" ? "true" : "");
              }}
              disabled={pending}
            >
              <option value="">Standard (9% above AED 375k)</option>
              <option value="sbr">Small Business Relief elected</option>
              <option value="qfzp">Qualifying Free Zone Person</option>
            </Select>
          </Field>
        ))}
      {msg && <p className="text-xs text-muted sm:col-span-full">{msg}</p>}
    </div>
  );
}

export function StayForm({ year }: { year: number }) {
  const [country, setCountry] = useState("AE");
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-01-01`);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addStayAction(country, from, to);
          setMsg({ ok: r.ok, text: r.message });
        });
      }}
    >
      <Field label="Country" className="w-48">
        <Select value={country} onChange={(e) => setCountry(e.target.value)}>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="From" className="w-40">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
      </Field>
      <Field label="To (included)" className="w-40">
        <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
      </Field>
      <Button type="submit" disabled={pending}>
        Add stay
      </Button>
      {msg && <span className={msg.ok ? "text-good-text" : "text-critical-text"}>{msg.text}</span>}
    </form>
  );
}
