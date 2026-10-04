"use client";

import clsx from "clsx";
import { Calculator, Home, Save, TrendingUp } from "lucide-react";
import { useCallback, useState, useTransition } from "react";
import { deleteScenario, saveScenario } from "@/app/simulations/actions";
import { Badge, Button, Card, CardHeader } from "./ui";
import { useFormat } from "./format";
import { ConfirmButton, Flash, useFlash } from "./settings-kit";
import type { Num } from "./sim-fields";
import {
  MORTGAGE_KEYS,
  PROJECTION_KEYS,
  PURCHASE_KEYS,
  RENT_KEYS,
  TAB_TYPE,
  TYPE_LABEL,
  TYPE_TAB,
  compact,
  eventsInput,
  initialMortgage,
  initialProjection,
  initialPurchase,
  initialRent,
  pick,
  pickEvents,
  type DataDefaults,
  type EventRow,
  type MortgageState,
  type ProjectionState,
  type PurchaseState,
  type RentState,
  type SavedScenario,
  type SimTab,
  type SimType,
} from "./sim-model";
import { MortgageTab } from "./sim-mortgage";
import { RentTab } from "./sim-rent";
import { ProjectionTab } from "./sim-projection";

const TABS: { id: SimTab; label: string; icon: typeof Home }[] = [
  { id: "mortgage", label: "Mortgage", icon: Calculator },
  { id: "rent", label: "Buy vs rent", icon: Home },
  { id: "projection", label: "Projection", icon: TrendingUp },
];

function setUrl(tab: SimTab, loadId: number | null) {
  const qs = new URLSearchParams({ tab });
  if (loadId !== null) qs.set("load", String(loadId));
  window.history.replaceState(null, "", `?${qs}`);
}

/**
 * Client side of /simulations: holds every simulator's inputs (so switching
 * tabs keeps them, and Buy-vs-rent shares the purchase with Mortgage).
 */
export function SimWorkspace({
  initialTab,
  saved,
  data,
  loaded,
}: {
  initialTab: SimTab;
  saved: SavedScenario[];
  data: DataDefaults;
  loaded: SavedScenario | null;
}) {
  const f = useFormat();
  const [tab, setTab] = useState<SimTab>(loaded ? TYPE_TAB[loaded.type] : initialTab);
  const [purchase, setPurchaseState] = useState<PurchaseState>(() =>
    loaded && loaded.type !== "projection" ? pick(PURCHASE_KEYS, loaded.params, initialPurchase()) : initialPurchase(),
  );
  const [mortgage, setMortgageState] = useState<MortgageState>(() =>
    loaded?.type === "mortgage" ? pick(MORTGAGE_KEYS, loaded.params, initialMortgage(data)) : initialMortgage(data),
  );
  const [rent, setRentState] = useState<RentState>(() =>
    loaded?.type === "buy_vs_rent" ? pick(RENT_KEYS, loaded.params, initialRent()) : initialRent(),
  );
  const [projection, setProjectionState] = useState<ProjectionState>(() =>
    loaded?.type === "projection" ? pick(PROJECTION_KEYS, loaded.params, initialProjection(data)) : initialProjection(data),
  );
  const [events, setEvents] = useState<EventRow[]>(() => (loaded?.type === "projection" ? pickEvents(loaded.params) : []));
  const [activeId, setActiveId] = useState<number | null>(loaded?.id ?? null);
  const [flash, showFlash] = useFlash();
  const [pending, startTransition] = useTransition();

  const setPurchase = useCallback((k: keyof PurchaseState, v: Num) => setPurchaseState((s) => ({ ...s, [k]: v })), []);
  const setMortgage = useCallback((k: keyof MortgageState, v: Num) => setMortgageState((s) => ({ ...s, [k]: v })), []);
  const setRent = useCallback((k: keyof RentState, v: Num) => setRentState((s) => ({ ...s, [k]: v })), []);
  const setProjection = useCallback((k: keyof ProjectionState, v: Num) => setProjectionState((s) => ({ ...s, [k]: v })), []);

  const switchTab = (t: SimTab) => {
    setTab(t);
    setUrl(t, null);
  };

  const load = (s: SavedScenario) => {
    if (s.type === "mortgage") {
      setPurchaseState(pick(PURCHASE_KEYS, s.params, initialPurchase()));
      setMortgageState(pick(MORTGAGE_KEYS, s.params, initialMortgage(data)));
    } else if (s.type === "buy_vs_rent") {
      setPurchaseState(pick(PURCHASE_KEYS, s.params, initialPurchase()));
      setRentState(pick(RENT_KEYS, s.params, initialRent()));
    } else {
      setProjectionState(pick(PROJECTION_KEYS, s.params, initialProjection(data)));
      setEvents(pickEvents(s.params));
    }
    const t = TYPE_TAB[s.type];
    setTab(t);
    setActiveId(s.id);
    setUrl(t, s.id);
    showFlash("good", `Loaded “${s.name}”`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const remove = (s: SavedScenario) =>
    startTransition(async () => {
      await deleteScenario(s.id);
      if (activeId === s.id) setActiveId(null);
      showFlash("good", `Deleted “${s.name}”`);
    });

  const compactMoney = (n: number | undefined) => (n === undefined ? "?" : f.units(n, { compact: true }));
  const type = TAB_TYPE[tab];
  const params: Record<string, unknown> =
    tab === "mortgage"
      ? compact({ ...purchase, ...mortgage })
      : tab === "rent"
        ? compact({ ...purchase, ...rent })
        : { ...compact(projection), events: eventsInput(events) };
  const suggested =
    tab === "mortgage"
      ? `${compactMoney(purchase.price)} · ${purchase.durationYears ?? "?"} yrs · ${purchase.annualRatePct ?? "?"}%`
      : tab === "rent"
        ? `Buy ${compactMoney(purchase.price)} vs rent ${compactMoney(rent.monthlyRent)}/mo`
        : `${projection.horizonYears ?? "?"} yrs · ${compactMoney(projection.monthlyContribution)}/mo`;

  const save = (
    <SaveScenario
      key={tab}
      type={type}
      params={params}
      suggested={suggested}
      onSaved={(id) => {
        setActiveId(id);
        setUrl(tab, id);
      }}
    />
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="tablist" aria-label="Simulator" className="grid w-full grid-cols-3 gap-0.5 rounded-xl bg-surface-2 p-1 sm:inline-grid sm:w-auto">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = id === tab;
            return (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => switchTab(id)}
                className={clsx(
                  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium whitespace-nowrap transition sm:px-4",
                  active ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink",
                )}
              >
                <Icon size={15} className="hidden sm:block" aria-hidden />
                {label}
              </button>
            );
          })}
        </div>
        <Flash flash={flash} />
      </div>

      <div role="tabpanel">
        {tab === "mortgage" && (
          <MortgageTab purchase={purchase} setPurchase={setPurchase} extra={mortgage} setExtra={setMortgage} data={data} save={save} />
        )}
        {tab === "rent" && <RentTab purchase={purchase} setPurchase={setPurchase} rent={rent} setRent={setRent} save={save} />}
        {tab === "projection" && (
          <ProjectionTab state={projection} setField={setProjection} events={events} setEvents={setEvents} data={data} save={save} />
        )}
      </div>

      <Card>
        <CardHeader title="Saved scenarios" subtitle={saved.length ? "Click one to load it into its simulator" : undefined} />
        {saved.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing saved yet — use “Save” under the inputs to keep a scenario for later.</p>
        ) : (
          <ul className={clsx("divide-y divide-border", pending && "opacity-60")}>
            {saved.map((s) => (
              <li key={s.id} className="flex items-center gap-1 py-1">
                <button
                  type="button"
                  onClick={() => load(s)}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <span className="min-w-0 truncate text-sm font-medium">{s.name}</span>
                  <Badge tone={s.type === type ? "accent" : "neutral"}>{TYPE_LABEL[s.type]}</Badge>
                  {s.id === activeId && <Badge tone="good">loaded</Badge>}
                  <span className="ml-auto shrink-0 text-xs text-muted">{s.createdLabel}</span>
                </button>
                <ConfirmButton iconOnly title={`Delete “${s.name}”`} confirmLabel="Delete?" onConfirm={() => remove(s)} disabled={pending} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function SaveScenario({
  type,
  params,
  suggested,
  onSaved,
}: {
  type: SimType;
  params: Record<string, unknown>;
  suggested: string;
  onSaved: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash(5000);
  return (
    <form
      className="mt-4 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const res = await saveScenario({ name: name.trim() || suggested, type, params });
          if (res.ok) {
            setName("");
            onSaved(res.id);
            showFlash("good", `Saved “${res.name}”`);
          } else showFlash("critical", res.error);
        });
      }}
    >
      <label htmlFor={`save-${type}`} className="mb-1 block text-xs font-medium text-ink-2">
        Save this scenario
      </label>
      <div className="flex gap-2">
        <input
          id={`save-${type}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={suggested}
          maxLength={120}
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <Button type="submit" variant="primary" disabled={pending}>
          <Save size={14} /> {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      <div className="mt-1 min-h-4">
        <Flash flash={flash} />
      </div>
    </form>
  );
}
