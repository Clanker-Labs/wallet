"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Info, Loader2, Search } from "lucide-react";
import { HOLDING_TYPES, HOLDING_TYPE_KEYS, type AccountType, type HoldingType } from "@/lib/domain";
import { Button, ButtonLink, Field, Input, Select } from "@/components/ui";
import { saveHoldingAction, searchSymbolsAction, type HoldingActionState } from "@/app/investments/actions";
import type { SymbolMatch } from "@/server/services/prices";

export interface HoldingAccountOption {
  id: number;
  name: string;
  currency: string;
  type: AccountType;
}

export interface HoldingFormValues {
  id: number;
  accountId: number;
  symbol: string | null;
  name: string;
  assetType: HoldingType;
  quantity: number;
  currency: string;
  /** Total paid (cost per unit × quantity), quote currency. */
  costTotal: number | null;
  manualPrice: number | null;
}

/** Sensible type for a new position, from the account it goes in. */
function typeForAccount(type: AccountType | undefined): HoldingType {
  if (type === "crypto") return "crypto";
  if (type === "precious_metals") return "commodity";
  return "stock";
}

/** Exchange suffix → quote currency (Yahoo style: CW8.PA, VWCE.DE, VOD.L, BTC-EUR). */
const SUFFIX_CURRENCY: Record<string, string> = {
  PA: "EUR", AS: "EUR", DE: "EUR", F: "EUR", MI: "EUR", MC: "EUR", BR: "EUR", LS: "EUR", VI: "EUR", HE: "EUR", IR: "EUR",
  L: "GBP", SW: "CHF", TO: "CAD", V: "CAD", AX: "AUD", T: "JPY", HK: "HKD", SI: "SGD", ST: "SEK", OL: "NOK", CO: "DKK",
  WA: "PLN", NS: "INR", BO: "INR", SA: "BRL", MX: "MXN",
};

function guessCurrency(symbol: string): string | null {
  const pair = symbol.match(/-([A-Z]{3})$/);
  if (pair) return pair[1];
  const suffix = symbol.match(/\.([A-Z]{1,2})$/);
  if (suffix) return SUFFIX_CURRENCY[suffix[1]] ?? null;
  if (/=F$/.test(symbol) || /^[A-Z]{1,5}$/.test(symbol)) return "USD";
  return null;
}

/** Number → editable text without float noise ("110.64705882352941" → "110.647059"). */
function numText(n: number | null | undefined, digits = 8): string {
  if (n === null || n === undefined) return "";
  return String(+n.toFixed(digits));
}

type SearchState = { status: "idle" | "loading" | "done" | "error"; query: string; matches: SymbolMatch[] };

/**
 * Symbol field doubling as a search box: type a name or ticker, pick a match
 * (fills name, type and currency). When search is unavailable (offline, rate
 * limited) the text typed is simply used as the symbol.
 */
function SymbolCombobox({
  value,
  onChange,
  onPick,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (m: SymbolMatch) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [search, setSearch] = useState<SearchState>({ status: "idle", query: "", matches: [] });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [failed, setFailed] = useState(false);
  // The symbol already chosen (or loaded for editing) isn't searched again.
  const picked = useRef<string | null>(value || null);
  const latest = useRef(0);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2 || q === picked.current) return;
    const ticket = ++latest.current;
    const t = setTimeout(async () => {
      setSearch((s) => ({ ...s, status: "loading", query: q }));
      let res: Awaited<ReturnType<typeof searchSymbolsAction>>;
      try {
        res = await searchSymbolsAction(q);
      } catch (e) {
        res = { ok: false, message: e instanceof Error ? e.message : "unreachable" };
      }
      if (ticket !== latest.current) return; // a newer keystroke won
      if (res.ok) {
        setFailed(false);
        setSearch({ status: "done", query: q, matches: res.matches });
        setActive(res.matches.length ? 0 : -1);
      } else {
        setFailed(true);
        setSearch({ status: "error", query: q, matches: [] });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [value]);

  const pick = (m: SymbolMatch) => {
    picked.current = m.symbol;
    latest.current++;
    setOpen(false);
    setSearch({ status: "idle", query: "", matches: [] });
    onPick(m);
  };

  const showList = open && search.status === "done" && search.query === value.trim() && value.trim().length >= 2;

  return (
    <div className="relative">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
        <Input
          name="symbol"
          value={value}
          onChange={(e) => {
            picked.current = null;
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (!showList || !search.matches.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => (i + 1) % search.matches.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i <= 0 ? search.matches.length - 1 : i - 1));
            } else if (e.key === "Enter" && active >= 0) {
              e.preventDefault();
              pick(search.matches[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          placeholder="Apple, MSCI World, BTC-USD…"
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="pl-8"
        />
        {search.status === "loading" && (
          <Loader2 size={14} className="absolute top-1/2 right-2.5 -translate-y-1/2 animate-spin text-muted" aria-label="Searching" />
        )}
      </div>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-pop"
        >
          {search.matches.length === 0 ? (
            <li className="px-2.5 py-2 text-xs text-muted">
              No match for “{search.query}”. You can still use it as the symbol.
            </li>
          ) : (
            search.matches.map((m, i) => (
              <li
                key={`${m.symbol}-${i}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(m)}
                className={clsx("cursor-pointer rounded-lg px-2.5 py-1.5", i === active && "bg-surface-2")}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{m.symbol}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {[HOLDING_TYPES[m.assetType], m.exchange].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <div className="truncate text-xs text-ink-2">{m.name}</div>
              </li>
            ))
          )}
        </ul>
      )}
      <span className="mt-1 block text-xs text-muted" aria-live="polite">
        {failed ? (
          <>Search is unavailable right now. Type the ticker yourself (AAPL, CW8.PA, BTC-USD, GC=F).</>
        ) : (
          <>Search by name or ticker, or leave empty for gold coins, private funds…</>
        )}
      </span>
    </div>
  );
}

/**
 * Add (no `holding`) or edit a position. Cost is entered as the total paid
 * (the service stores it per unit); a manual price covers assets without a ticker.
 */
export function HoldingForm({
  accounts,
  currencies,
  holding,
  defaultAccountId,
  closeHref,
  autoFocus = false,
}: {
  accounts: HoldingAccountOption[];
  currencies: string[];
  holding?: HoldingFormValues;
  defaultAccountId?: number;
  /** Edit mode: where to go after saving or cancelling. */
  closeHref?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const editing = Boolean(holding);
  const initialAccount =
    accounts.find((a) => a.id === (holding?.accountId ?? defaultAccountId)) ?? (accounts.length === 1 ? accounts[0] : undefined);

  const [accountId, setAccountId] = useState<string>(initialAccount ? String(initialAccount.id) : "");
  const account = accounts.find((a) => String(a.id) === accountId);
  const [symbol, setSymbol] = useState(holding?.symbol ?? "");
  const [name, setName] = useState(holding?.name ?? "");
  const [nameAuto, setNameAuto] = useState(false);
  const [type, setType] = useState<HoldingType>(holding?.assetType ?? typeForAccount(initialAccount?.type));
  const [typeTouched, setTypeTouched] = useState(editing);
  const [currency, setCurrency] = useState(holding?.currency ?? initialAccount?.currency ?? currencies[0] ?? "USD");
  const [currencyTouched, setCurrencyTouched] = useState(editing);
  const [state, setState] = useState<HoldingActionState | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!state?.ok || state.warning) return;
    const t = setTimeout(() => setState(null), 5000);
    return () => clearTimeout(t);
  }, [state]);

  const currencyOptions = currencies.includes(currency) ? currencies : [currency, ...currencies];

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        Positions live in an account. First{" "}
        <Link href="/accounts?new=1&type=brokerage" className="font-medium text-accent hover:underline">
          add a brokerage, crypto or precious-metals account
        </Link>
        , then come back to add what it holds.
      </p>
    );
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const res = await saveHoldingAction(fd);
      setState(res);
      if (!res.ok) return;
      if (editing) {
        if (!res.warning && closeHref) router.replace(closeHref, { scroll: false });
        return;
      }
      // Ready for the next position in the same account.
      setSymbol("");
      setName("");
      setNameAuto(false);
      setTypeTouched(false);
      setType(typeForAccount(account?.type));
      setFormKey((k) => k + 1);
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4 text-sm">
      {holding && <input type="hidden" name="id" value={holding.id} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="Account"
          hint={
            <Link href="/accounts?new=1&type=brokerage" className="hover:text-ink hover:underline">
              New account…
            </Link>
          }
        >
          <Select
            name="accountId"
            required
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              const next = accounts.find((a) => String(a.id) === e.target.value);
              if (next && !currencyTouched) setCurrency(next.currency);
              if (next && !typeTouched) setType(typeForAccount(next.type));
            }}
          >
            {!account && <option value="">Choose…</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </Select>
        </Field>
        <div className="block">
          <span className="mb-1 block text-xs font-medium text-ink-2">Symbol</span>
          <SymbolCombobox
            value={symbol}
            onChange={setSymbol}
            autoFocus={autoFocus || formKey > 0}
            onPick={(m) => {
              setSymbol(m.symbol);
              if (!name || nameAuto) {
                setName(m.name);
                setNameAuto(true);
              }
              setType(m.assetType === "other" && typeTouched ? type : m.assetType);
              const guess = guessCurrency(m.symbol);
              if (guess && !currencyTouched && currencies.includes(guess)) setCurrency(guess);
            }}
          />
        </div>
        <Field label="Name" className="sm:col-span-2" hint={symbol ? "Defaults to the symbol" : undefined}>
          <Input
            name="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameAuto(false);
            }}
            maxLength={120}
            placeholder="e.g. Apple Inc. or 1 oz Krugerrand"
            autoComplete="off"
          />
        </Field>
      </div>

      <div key={formKey} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Type">
          <Select
            name="assetType"
            value={type}
            onChange={(e) => {
              setType(e.target.value as HoldingType);
              setTypeTouched(true);
            }}
          >
            {HOLDING_TYPE_KEYS.map((t) => (
              <option key={t} value={t}>
                {HOLDING_TYPES[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quantity" hint="Shares, units, coins or ounces">
          <Input
            name="quantity"
            inputMode="decimal"
            required
            defaultValue={numText(holding?.quantity)}
            placeholder="12 or 0.35"
            autoComplete="off"
          />
        </Field>
        <Field label="Currency" hint="The one it's priced in">
          <Select
            name="currency"
            value={currency}
            onChange={(e) => {
              setCurrency(e.target.value);
              setCurrencyTouched(true);
            }}
          >
            {currencyOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Total cost (optional)" hint={`What you paid in all, in ${currency}`}>
          <Input
            name="costTotal"
            inputMode="decimal"
            defaultValue={numText(holding?.costTotal, 2)}
            placeholder="1 234,56"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Manual price per unit (optional)"
          hint="For assets without a ticker; overrides the market price"
          className="sm:col-span-2"
        >
          <Input
            name="manualPrice"
            inputMode="decimal"
            defaultValue={numText(holding?.manualPrice)}
            placeholder={symbol ? "Leave empty to use the market price" : "Required without a symbol"}
            autoComplete="off"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending || !accountId}>
          {pending ? (symbol ? "Saving & fetching price…" : "Saving…") : editing ? "Save changes" : "Add holding"}
        </Button>
        {closeHref && (
          <ButtonLink href={closeHref} scroll={false} variant="ghost">
            {editing && state?.ok ? "Close" : "Cancel"}
          </ButtonLink>
        )}
        <span aria-live="polite" className="min-w-0 text-sm">
          {state &&
            (state.ok ? (
              <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="inline-flex items-center gap-1 text-good-text">
                  <Check size={14} /> {state.message}
                </span>
                {state.warning && (
                  <span className="inline-flex items-start gap-1 text-ink-2">
                    <Info size={14} className="mt-0.5 shrink-0 text-muted" /> {state.warning}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-critical-text">{state.message}</span>
            ))}
        </span>
      </div>
    </form>
  );
}
