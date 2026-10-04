"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { DateTime } from "luxon";
import { formatMoney } from "@/lib/money";
import { savePreferences } from "@/app/settings/actions";
import { Button, Input } from "./ui";
import { Flash, useFlash } from "./settings-kit";

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "CAD", "AUD", "JPY", "SEK", "NOK", "DKK", "PLN"];
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

export function PreferencesForm({ initial, timezones }: { initial: Prefs; timezones: string[] }) {
  const [values, setValues] = useState<Prefs>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash(5000);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const ids = { currency: useId(), locale: useId(), timezone: useId(), lc: useId(), ll: useId(), lt: useId() };

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
        <PrefField label="Currency" htmlFor={ids.currency} hint="ISO code, e.g. EUR" error={errors.currency}>
          <Input
            id={ids.currency}
            list={ids.lc}
            value={values.currency}
            onChange={(e) => set("currency", e.target.value.toUpperCase())}
            maxLength={3}
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id={ids.lc}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
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
