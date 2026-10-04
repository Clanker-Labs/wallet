"use client";

import clsx from "clsx";
import { createContext, useCallback, useContext, useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Loader2, Plus, RotateCw, Search, X, Zap } from "lucide-react";
import { addMonths, formatDate, formatMonth, monthBounds } from "@/lib/dates";
import { COMMON_CURRENCIES } from "@/lib/domain";
import { Button, Card, Field, Input, Select } from "@/components/ui";
import { Disclosure } from "@/components/accounts-ui";
import {
  createRuleFromTransaction,
  quickAddTransaction,
  setTransactionCategory,
  type TxActionState,
} from "@/app/transactions/actions";

export interface TxCategory {
  id: number;
  name: string;
  icon: string | null;
  kind: "income" | "expense" | "transfer";
}
export interface TxAccount {
  id: number;
  name: string;
  /** Account currency: new transactions default to it. */
  currency?: string;
}

/** Currencies offered in pickers: the base, the user's account currencies, then the common ones. */
export function currencyChoices(base: string, accounts: { currency?: string }[] = []): string[] {
  const codes = [base, ...accounts.map((a) => a.currency).filter((c): c is string => !!c), ...COMMON_CURRENCIES];
  return [...new Set(codes.map((c) => c.toUpperCase()))];
}

/** `<option>`s for a currency `<select>`. */
export function CurrencyOptions({ codes }: { codes: string[] }) {
  return (
    <>
      {codes.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </>
  );
}

// ── Page-level context: categories (sent once), toasts, progress ─────────

interface Toast {
  id: number;
  text: string;
  tone: "good" | "error";
}

const TxContext = createContext<{
  categories: TxCategory[];
  toast: (text: string, tone?: Toast["tone"]) => void;
  categorized: number;
  bump: (n: number) => void;
  resetProgress: () => void;
} | null>(null);

function useTx() {
  const ctx = useContext(TxContext);
  if (!ctx) throw new Error("TxProvider missing");
  return ctx;
}

export function TxProvider({ categories, children }: { categories: TxCategory[]; children: ReactNode }) {
  const [toastState, setToast] = useState<Toast | null>(null);
  const [categorized, setCategorized] = useState(0);
  const toast = useCallback((text: string, tone: Toast["tone"] = "good") => setToast({ id: Date.now(), text, tone }), []);
  const bump = useCallback((n: number) => setCategorized((c) => Math.max(0, c + n)), []);
  const resetProgress = useCallback(() => setCategorized(0), []);

  useEffect(() => {
    if (!toastState) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toastState]);

  return (
    <TxContext.Provider value={{ categories, toast, categorized, bump, resetProgress }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
        {toastState && (
          <div
            key={toastState.id}
            className="pointer-events-auto flex max-w-lg items-start gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-lg"
          >
            {toastState.tone === "good" ? (
              <Check size={16} className="mt-0.5 shrink-0 text-good-text" />
            ) : (
              <X size={16} className="mt-0.5 shrink-0 text-critical-text" />
            )}
            <span className="text-ink">{toastState.text}</span>
            <button onClick={() => setToast(null)} className="ml-1 shrink-0 text-muted hover:text-ink" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </TxContext.Provider>
  );
}

/** "✓ 4 categorized · Refresh list" — shown while rows were categorized in place. */
export function CategorizeProgress({ hint }: { hint?: ReactNode }) {
  const { categorized, resetProgress } = useTx();
  const router = useRouter();
  const [pending, start] = useTransition();
  if (categorized === 0) return hint ? <p className="text-xs text-muted">{hint}</p> : null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs">
      <span className="inline-flex items-center gap-1 text-good-text">
        <Check size={13} /> {categorized} categorized
      </span>
      <button
        type="button"
        onClick={() =>
          start(() => {
            resetProgress();
            router.refresh();
          })
        }
        className="inline-flex items-center gap-1 text-accent hover:underline"
      >
        <RotateCw size={12} className={pending ? "animate-spin" : ""} /> Refresh list
      </button>
    </p>
  );
}

export function CategoryOptions({ categories }: { categories: TxCategory[] }) {
  const groups: [string, TxCategory["kind"]][] = [
    ["Expenses", "expense"],
    ["Income", "income"],
    ["Transfers & savings", "transfer"],
  ];
  return (
    <>
      {groups.map(([label, kind]) => (
        <optgroup key={kind} label={label}>
          {categories
            .filter((c) => c.kind === kind)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon ? `${c.icon} ` : ""}
                {c.name}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

// ── Category cell: change immediately, then offer a rule ────────────────

export function CategoryCell({ txId, categoryId, pattern }: { txId: number; categoryId: number | null; pattern: string | null }) {
  const { categories, toast, bump } = useTx();
  const [value, setValue] = useState<number | null>(categoryId);
  const [synced, setSynced] = useState(categoryId);
  const [offer, setOffer] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const [rulePending, startRule] = useTransition();

  // A server re-render (e.g. a rule categorized this row) wins over local state.
  if (synced !== categoryId) {
    setSynced(categoryId);
    setValue(categoryId);
  }

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(t);
  }, [saved]);

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value === "" ? null : Number(e.target.value);
    const before = value;
    setValue(next);
    setOffer(null);
    start(async () => {
      const res = await setTransactionCategory(txId, next).catch(() => ({ ok: false }));
      if (!res.ok) {
        setValue(before);
        toast("Couldn't save that category — try again.", "error");
        return;
      }
      setSaved(true);
      if (before === null && next !== null) bump(1);
      else if (before !== null && next === null) bump(-1);
      if (next !== null && pattern) setOffer(next);
    });
  };

  const offerCat = offer !== null ? categories.find((c) => c.id === offer) : undefined;

  const applyRule = () => {
    if (!offerCat || !pattern) return;
    startRule(async () => {
      const res = await createRuleFromTransaction(txId, offerCat.id, pattern).catch(() => ({ ok: false, ruleApplied: 0 }));
      if (!res.ok) {
        toast("Couldn't save the rule.", "error");
        return;
      }
      setOffer(null);
      toast(
        res.ruleApplied > 0
          ? `Rule saved: “${pattern}” → ${offerCat.name}. ${res.ruleApplied} more transaction${res.ruleApplied > 1 ? "s" : ""} categorized.`
          : `Rule saved: “${pattern}” → ${offerCat.name}. No other match yet — future imports will use it.`,
      );
    });
  };

  return (
    <div className="min-w-0 text-xs">
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Category"
          value={value ?? ""}
          onChange={onChange}
          disabled={pending}
          className={clsx(
            "h-8 w-full min-w-0 rounded-lg border bg-surface pr-7 pl-2 text-xs focus:border-accent focus:outline-none",
            value === null ? "border-dashed border-ink-2/40 text-muted" : "border-border text-ink",
          )}
        >
          <option value="">Uncategorized</option>
          <CategoryOptions categories={categories} />
        </select>
        <span className="w-3.5 shrink-0" aria-live="polite">
          {pending ? (
            <Loader2 size={14} className="animate-spin text-muted" aria-label="Saving" />
          ) : saved ? (
            <Check size={14} className="text-good-text" aria-label="Saved" />
          ) : null}
        </span>
      </div>
      {offerCat && pattern && (
        <div className="mt-1.5 flex items-start gap-1">
          <button
            type="button"
            onClick={applyRule}
            disabled={rulePending}
            className="inline-flex min-w-0 items-start gap-1 rounded-lg border border-border bg-surface-2 px-2 py-1 text-left text-xs text-ink-2 hover:border-accent hover:text-ink disabled:opacity-60"
          >
            {rulePending ? (
              <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />
            ) : (
              <Zap size={12} className="mt-0.5 shrink-0 text-accent" />
            )}
            <span>
              Always categorize “<span className="font-medium text-ink">{pattern}</span>” as {offerCat.name}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setOffer(null)}
            className="mt-1 shrink-0 text-muted hover:text-ink"
            aria-label="No rule"
            title="No rule"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Quick add ────────────────────────────────────────────────────────────

export function QuickAdd({
  today,
  accounts,
  defaultAccountId,
  defaultOpen,
  baseCurrency,
}: {
  today: string;
  accounts: TxAccount[];
  defaultAccountId: number | null;
  defaultOpen: boolean;
  baseCurrency: string;
}) {
  const { categories, toast } = useTx();
  const [state, setState] = useState<TxActionState | null>(null);
  const [key, setKey] = useState(0);
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState(defaultAccountId ? String(defaultAccountId) : "");
  // Follows the chosen account's currency until the user picks one explicitly.
  const currencyFor = (id: string) => accounts.find((a) => String(a.id) === id)?.currency ?? baseCurrency;
  const [currency, setCurrency] = useState(() => currencyFor(accountId));
  const [currencyPicked, setCurrencyPicked] = useState(false);
  const currencies = currencyChoices(baseCurrency, accounts);
  const [pending, start] = useTransition();

  return (
    <Card className="py-3">
      <Disclosure
        defaultOpen={defaultOpen}
        summaryClassName="py-1"
        summary={
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Plus size={15} /> Quick add
            <span className="hidden font-normal text-muted sm:inline">· cash spending, a missing transaction…</span>
          </span>
        }
      >
        <form
          key={key}
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            start(async () => {
              const res = await quickAddTransaction(fd);
              setState(res);
              if (res.ok) {
                toast(res.message);
                setDirection("out");
                setCurrency(currencyFor(accountId));
                setCurrencyPicked(false);
                setKey((k) => k + 1);
              }
            });
          }}
          className="grid items-end gap-3 pt-4 text-sm sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_16.5rem] xl:grid-cols-[8.5rem_minmax(7rem,1fr)_16.5rem_9rem_9rem_auto]"
        >
          <Field label="Date">
            <Input type="date" name="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Description">
            <Input
              name="description"
              required
              maxLength={300}
              placeholder="e.g. Bakery"
              autoComplete="off"
              autoFocus={key > 0}
              data-autofocus
            />
          </Field>
          <div className="sm:col-span-2 lg:col-span-1">
            <span className="mb-1 block text-xs font-medium text-ink-2">Amount</span>
            <div className="flex gap-1.5">
              <div role="radiogroup" aria-label="Direction" className="flex shrink-0 rounded-lg border border-border p-0.5">
                {(
                  [
                    ["out", "− Out"],
                    ["in", "+ In"],
                  ] as const
                ).map(([v, label]) => (
                  <label
                    key={v}
                    className={clsx(
                      "flex cursor-pointer items-center rounded-md px-1.5 text-xs font-medium whitespace-nowrap has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                      direction === v ? "bg-surface-2 text-ink" : "text-muted hover:text-ink",
                    )}
                  >
                    <input
                      type="radio"
                      name="direction"
                      value={v}
                      checked={direction === v}
                      onChange={() => setDirection(v)}
                      className="sr-only"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <Input name="amount" inputMode="decimal" required placeholder="12,50" autoComplete="off" className="min-w-0" />
              <select
                name="currency"
                aria-label="Currency"
                title="Currency of this amount"
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setCurrencyPicked(true);
                }}
                className="h-9 w-[4.75rem] shrink-0 rounded-lg border border-border bg-surface pr-1 pl-2 text-sm text-ink focus:border-accent focus:outline-none"
              >
                <CurrencyOptions codes={currencies} />
              </select>
            </div>
          </div>
          <Field label="Category">
            <Select name="categoryId" defaultValue="">
              <option value="">Auto (rules)</option>
              <option value="none">Uncategorized</option>
              <CategoryOptions categories={categories} />
            </Select>
          </Field>
          <Field label="Account">
            <Select
              name="accountId"
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                if (!currencyPicked) setCurrency(currencyFor(e.target.value));
              }}
            >
              <option value="">— None —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.currency && a.currency !== baseCurrency ? ` · ${a.currency}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" disabled={pending} className="sm:col-span-2 lg:col-span-1">
            {pending ? "Adding…" : "Add"}
          </Button>
        </form>
        {state && !state.ok && (
          <p aria-live="polite" className="mt-2 text-sm text-critical-text">
            {state.message}
          </p>
        )}
      </Disclosure>
    </Card>
  );
}

// ── Filters (live in the URL) ────────────────────────────────────────────

export interface TxFilterValues {
  from?: string;
  to?: string;
  category?: string;
  account?: string;
  q?: string;
}

export function TxFilters({
  months,
  current,
  accounts,
  uncategorized,
}: {
  /** YYYY-MM, newest first. */
  months: string[];
  current: TxFilterValues;
  accounts: TxAccount[];
  uncategorized: number;
}) {
  const { categories } = useTx();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(current.q ?? "");

  const exactMonth =
    current.from && current.to && current.from.slice(0, 7) === current.to.slice(0, 7)
      ? (() => {
          const m = current.from!.slice(0, 7);
          const b = monthBounds(m);
          return b.start === current.from && b.end === current.to ? m : null;
        })()
      : null;
  const custom = (current.from || current.to) && !exactMonth;
  const monthValue = exactMonth ?? (custom ? "custom" : "");
  const monthOptions = exactMonth && !months.includes(exactMonth) ? [exactMonth, ...months] : months;

  const go = (patch: Partial<TxFilterValues>) => {
    const next = { ...current, ...patch };
    const p = new URLSearchParams();
    for (const k of ["from", "to", "category", "account", "q"] as const) if (next[k]) p.set(k, next[k]!);
    const qs = p.toString();
    start(() => router.push(`/transactions${qs ? `?${qs}` : ""}`));
  };
  const setMonth = (m: string) => {
    if (!m) return go({ from: undefined, to: undefined });
    const b = monthBounds(m);
    go({ from: b.start, to: b.end });
  };

  const active = Boolean(current.from || current.to || current.category || current.account || current.q);
  const customLabel = custom
    ? `${current.from ? formatDate(current.from) : "…"} – ${current.to ? formatDate(current.to) : "today"}`
    : "";

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        go({ q: q.trim() || undefined });
      }}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <div className="flex w-full items-center gap-1 sm:w-auto">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setMonth(addMonths(exactMonth ?? months[0] ?? "", exactMonth ? -1 : 0))}
          disabled={!months.length}
          className="grid h-9 w-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 disabled:opacity-40"
        >
          <ChevronLeft size={16} />
        </button>
        <Select
          aria-label="Month"
          value={monthValue}
          onChange={(e) => e.target.value !== "custom" && setMonth(e.target.value)}
          className="min-w-0 flex-1 sm:w-40 sm:flex-none"
        >
          <option value="">All time</option>
          {custom && <option value="custom">{customLabel}</option>}
          {monthOptions.map((m) => (
            <option key={m} value={m}>
              {formatMonth(m)}
            </option>
          ))}
        </Select>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => exactMonth && setMonth(addMonths(exactMonth, 1))}
          disabled={!exactMonth || exactMonth >= (months[0] ?? "")}
          className="grid h-9 w-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 disabled:opacity-40"
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <Select
        aria-label="Category"
        value={current.category ?? ""}
        onChange={(e) => go({ category: e.target.value || undefined })}
        className="min-w-0 flex-1 basis-40 sm:w-52 sm:flex-none"
      >
        <option value="">All categories</option>
        <option value="none">Uncategorized{uncategorized ? ` (${uncategorized})` : ""}</option>
        <CategoryOptions categories={categories} />
      </Select>
      <Select
        aria-label="Account"
        value={current.account ?? ""}
        onChange={(e) => go({ account: e.target.value || undefined })}
        className="min-w-0 flex-1 basis-36 sm:w-44 sm:flex-none"
      >
        <option value="">All accounts</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      <div className="relative min-w-0 flex-1 basis-full sm:basis-40">
        <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
        <Input
          type="search"
          name="q"
          aria-label="Search descriptions"
          placeholder="Search… (Enter)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-8"
        />
      </div>
      <span className="flex h-9 items-center gap-2">
        {pending && <Loader2 size={15} className="animate-spin text-muted" aria-label="Loading" />}
        {active && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              start(() => router.push("/transactions"));
            }}
            className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink"
          >
            <X size={13} /> Clear
          </button>
        )}
      </span>
    </form>
  );
}
