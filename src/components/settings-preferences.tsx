"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { DateTime } from "luxon";
import { formatMoney } from "@/lib/money";
import { savePreferences } from "@/app/settings/actions";
import { COMMON_CURRENCIES } from "@/lib/domain";
import { Button, Input, Select } from "./ui";
import { Flash, useFlash } from "./settings-kit";

const LOCALES = ["fr-FR", "en-IE", "en-GB", "en-US", "de-DE", "es-ES", "it-IT", "nl-NL", "pt-PT", "fr-CH", "de-CH", "fr-BE"];

interface Prefs {
  currency: string;
  locale: string;
  timezone: string;
}

/** A formatted sample amount, or null while the currency/locale is invalid. */
function sample(p: Prefs): string | null {
  try {
    return formatMoney(123456789, { currency: p.currency.toUpperCase(), locale: p.locale });
  } catch {
    return null;
  }
}

/** Label for a currency code in the picker: "EUR · Euro". */
function currencyLabel(code: string, names: Record<string, string>) {
  const name = names[code];
  return name && name !== code ? `${code} · ${name}` : code;
}

export function PreferencesForm({
  initial,
  timezones,
  otherCurrencies = [],
  currencyNames = {},
}: {
  initial: Prefs;
  timezones: string[];
  /** Codes with a known exchange rate beyond COMMON_CURRENCIES. */
  otherCurrencies?: string[];
  currencyNames?: Record<string, string>;
}) {
  const [values, setValues] = useState<Prefs>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash(5000);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const ids = { currency: useId(), locale: useId(), timezone: useId(), ll: useId(), lt: useId() };
  const common: string[] = [...COMMON_CURRENCIES];
  if (!common.includes(initial.currency) && !otherCurrencies.includes(initial.currency)) common.unshift(initial.currency);
  const others = otherCurrencies.filter((c) => !common.includes(c));

  const set = (k: keyof Prefs, v: string) => {
    setValues((s) => ({ ...s, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: "" }));
  };
  const s = sample(values);
  let localTime = "";
  if (now) {
    const dt = DateTime.fromJSDate(now).setZone(values.timezone).setLocale(values.locale || "en");
    localTime = dt.isValid ? dt.toFormat("ccc d LLL yyyy, HH:mm") : "unknown time zone";
  }
  const changed = values.currency !== initial.currency || values.locale !== initial.locale || values.timezone !== initial.timezone;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const res = await savePreferences(values);
          if (res.ok) {
            setErrors({});
            showFlash("good", res.message ?? "Saved");
          } else {
            setErrors(res.errors ?? {});
            showFlash("critical", res.error);
          }
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <PrefField
          label="Base currency"
          htmlFor={ids.currency}
          hint={
            values.currency !== initial.currency
              ? `Totals, net worth and budgets will show in ${values.currency}`
              : "Totals and net worth; accounts keep their own"
          }
          error={errors.currency}
        >
          <Select id={ids.currency} value={values.currency} onChange={(e) => set("currency", e.target.value)}>
            <optgroup label="Common">
              {common.map((c) => (
                <option key={c} value={c}>
                  {currencyLabel(c, currencyNames)}
                </option>
              ))}
            </optgroup>
            {others.length > 0 && (
              <optgroup label="All currencies with rates">
                {others.map((c) => (
                  <option key={c} value={c}>
                    {currencyLabel(c, currencyNames)}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </PrefField>
        <PrefField label="Number format" htmlFor={ids.locale} hint="Locale, e.g. fr-FR or en-IE" error={errors.locale}>
          <Input id={ids.locale} list={ids.ll} value={values.locale} onChange={(e) => set("locale", e.target.value)} autoComplete="off" spellCheck={false} />
          <datalist id={ids.ll}>
            {LOCALES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </PrefField>
        <PrefField label="Time zone" htmlFor={ids.timezone} hint="For reminders and “today”" error={errors.timezone}>
          <Input id={ids.timezone} list={ids.lt} value={values.timezone} onChange={(e) => set("timezone", e.target.value)} autoComplete="off" spellCheck={false} />
          <datalist id={ids.lt}>
            {timezones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </PrefField>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm">
        <span>
          <span className="text-muted">Amounts: </span>
          <span className="tabular font-semibold">{s ?? "—"}</span>
        </span>
        <span>
          <span className="text-muted">Now: </span>
          <span className="tabular">{localTime || "…"}</span>
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending || !changed}>
          {pending ? "Saving…" : "Save preferences"}
        </Button>
        <Flash flash={flash} />
      </div>
    </form>
  );
}

function PrefField({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {error ? <p className="mt-1 text-xs text-critical-text">{error}</p> : <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
