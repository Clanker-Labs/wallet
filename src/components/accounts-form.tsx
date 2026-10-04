"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import {
  ACCOUNT_TYPES,
  ASSET_CLASSES,
  ASSET_CLASS_LABELS,
  assetClassFor,
  type AccountType,
  type LoanParams,
} from "@/lib/domain";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { createAccountAction, updateAccountAction, type AccountActionState } from "@/app/accounts/actions";
import { Disclosure } from "@/components/accounts-ui";

export interface AccountFormValues {
  id: number;
  name: string;
  institution: string | null;
  type: AccountType;
  ownershipPct: number;
  includeInNetWorth: boolean;
  linkedAccountId: number | null;
  loanParams: LoanParams | null;
  notes: string | null;
}

const TYPES_BY_CLASS = ASSET_CLASSES.map((c) => ({
  assetClass: c,
  label: ASSET_CLASS_LABELS[c],
  types: (Object.keys(ACCOUNT_TYPES) as AccountType[]).filter((t) => ACCOUNT_TYPES[t].assetClass === c),
})).filter((g) => g.types.length > 0);

export function AccountTypeSelect({ value, onChange }: { value: AccountType; onChange: (t: AccountType) => void }) {
  return (
    <Select name="type" value={value} onChange={(e) => onChange(e.target.value as AccountType)}>
      {TYPES_BY_CLASS.map((g) => (
        <optgroup key={g.assetClass} label={g.label}>
          {g.types.map((t) => (
            <option key={t} value={t}>
              {ACCOUNT_TYPES[t].label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

export function FormStatus({ state }: { state: AccountActionState | null }) {
  return (
    <span aria-live="polite" className="text-sm">
      {state &&
        (state.ok ? (
          <span className="inline-flex items-center gap-1 text-good-text">
            <Check size={14} /> {state.message}
          </span>
        ) : (
          <span className="text-critical-text">{state.message}</span>
        ))}
    </span>
  );
}

/**
 * Create (no `account`) or edit an account. Loan fields only appear for
 * mortgages/loans; rarely-used fields sit under "More options" when creating.
 */
export function AccountForm({
  account,
  properties,
  autoFocus = false,
}: {
  account?: AccountFormValues;
  properties: { id: number; name: string }[];
  autoFocus?: boolean;
}) {
  const editing = Boolean(account);
  const [type, setType] = useState<AccountType>(account?.type ?? "checking");
  const [state, setState] = useState<AccountActionState | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, start] = useTransition();

  const liability = assetClassFor(type) === "liabilities";
  const isLoan = type === "mortgage" || type === "loan";
  const loan = account?.loanParams;

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const res = editing ? await updateAccountAction(fd) : await createAccountAction(fd);
      setState(res);
      // Fresh, empty form ready for the next account (the type is kept).
      if (res.ok && !editing) setFormKey((k) => k + 1);
    });
  };

  const extra = (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Your share (%)" hint="e.g. 50 for a property bought as a couple">
        <Input
          name="ownershipPct"
          inputMode="decimal"
          defaultValue={account ? String(account.ownershipPct) : "100"}
          autoComplete="off"
        />
      </Field>
      <Field label="Notes" className="sm:col-span-2">
        <Textarea name="notes" rows={1} defaultValue={account?.notes ?? ""} placeholder="Optional" />
      </Field>
      <label className="flex items-center gap-2 text-sm text-ink-2 sm:col-span-3">
        <input
          type="checkbox"
          name="includeInNetWorth"
          defaultChecked={account ? account.includeInNetWorth : true}
          className="h-4 w-4 accent-accent"
        />
        Count in net worth
      </label>
    </div>
  );

  return (
    <form key={formKey} onSubmit={onSubmit} className="space-y-4 text-sm">
      {account && <input type="hidden" name="id" value={account.id} />}
      <div className={editing ? "grid gap-3 sm:grid-cols-3" : "grid gap-3 sm:grid-cols-2 lg:grid-cols-4"}>
        <Field label="Name">
          <Input
            name="name"
            required
            maxLength={120}
            defaultValue={account?.name ?? ""}
            placeholder="e.g. Livret A"
            autoFocus={autoFocus || formKey > 0}
            autoComplete="off"
          />
        </Field>
        <Field label="Institution">
          <Input
            name="institution"
            maxLength={120}
            defaultValue={account?.institution ?? ""}
            placeholder="Optional"
            autoComplete="off"
          />
        </Field>
        <Field label="Type">
          <AccountTypeSelect value={type} onChange={setType} />
        </Field>
        {!editing && (
          <Field
            label={liability ? "Amount owed today" : "Balance today"}
            hint={isLoan ? "Or fill the loan details below" : undefined}
          >
            <Input name="balance" inputMode="decimal" placeholder="1 234,56" autoComplete="off" />
          </Field>
        )}
      </div>

      {isLoan && (
        <fieldset className="rounded-xl border border-border p-4">
          <legend className="px-1 text-xs font-medium text-ink-2">
            Loan details <span className="font-normal text-muted">· optional — the balance then updates itself monthly</span>
          </legend>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Borrowed">
              <Input
                name="loanPrincipal"
                inputMode="decimal"
                placeholder="250 000"
                defaultValue={loan ? String(loan.principal) : ""}
                autoComplete="off"
              />
            </Field>
            <Field label="Rate (%)">
              <Input
                name="loanRate"
                inputMode="decimal"
                placeholder="3.5"
                defaultValue={loan ? String(loan.annualRatePct) : ""}
                autoComplete="off"
              />
            </Field>
            <Field label="Duration (years)">
              <Input
                name="loanYears"
                inputMode="decimal"
                placeholder="25"
                defaultValue={loan ? String(+(loan.durationMonths / 12).toFixed(2)) : ""}
                autoComplete="off"
              />
            </Field>
            <Field label="First payment">
              <Input name="loanStart" type="date" defaultValue={loan?.startDate ?? ""} />
            </Field>
            <Field label="Insurance (%/yr)">
              <Input
                name="loanInsurance"
                inputMode="decimal"
                placeholder="0.3"
                defaultValue={loan?.insuranceRatePct ? String(loan.insuranceRatePct) : ""}
                autoComplete="off"
              />
            </Field>
          </div>
          {type === "mortgage" && properties.length > 0 && (
            <Field label="Finances property" className="mt-3 sm:max-w-xs">
              <Select name="linkedAccountId" defaultValue={account?.linkedAccountId ? String(account.linkedAccountId) : ""}>
                <option value="">— None —</option>
                {properties
                  .filter((p) => p.id !== account?.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
        </fieldset>
      )}

      {editing ? (
        extra
      ) : (
        <Disclosure
          focusOnOpen={false}
          summary={<span className="text-xs font-medium text-ink-2">More options</span>}
          className="rounded-xl"
        >
          <div className="pt-3">{extra}</div>
        </Disclosure>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : editing ? "Save changes" : "Add account"}
        </Button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
