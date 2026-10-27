"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Bot, CornerDownLeft, FileUp, Landmark, Plus, Search, type LucideIcon } from "lucide-react";
import { ALL_NAV } from "./nav";

export interface PaletteAccount {
  id: number;
  name: string;
  hint: string;
}

interface Command {
  id: string;
  group: "Go to" | "Accounts" | "Actions";
  label: string;
  hint?: string;
  icon: LucideIcon;
  href: string;
  keywords?: string;
}

const ACTIONS: Command[] = [
  { id: "a:tx", group: "Actions", label: "Add a transaction", icon: Plus, href: "/transactions#add", keywords: "new expense income spend" },
  { id: "a:account", group: "Actions", label: "Add an account", icon: Landmark, href: "/accounts?new=1", keywords: "new bank broker property loan" },
  { id: "a:import", group: "Actions", label: "Import a statement", icon: FileUp, href: "/assistant", keywords: "csv pdf upload bank" },
  { id: "a:job", group: "Actions", label: "Add a job", icon: Plus, href: "/jobs?add=1", keywords: "gratuity employment" },
  { id: "a:ask", group: "Actions", label: "Ask the assistant", icon: Bot, href: "/assistant", keywords: "ai question chat" },
];

const OPEN_EVENT = "wallet:palette";

/** Open the palette from anywhere (a search button, a shortcut). */
export function openPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Lower is better; null when it doesn't match. Prefix > word start > substring > in keywords. */
function score(c: Command, q: string): number | null {
  if (!q) return 0;
  const label = c.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 1;
  if (label.includes(q)) return 2;
  if ((c.hint ?? "").toLowerCase().includes(q) || (c.keywords ?? "").includes(q)) return 3;
  return null;
}

/**
 * ⌘K / Ctrl+K (or "/" outside a field): jump to any page or account, or start
 * an action, from the keyboard. Arrow keys move, Enter opens, Esc closes.
 */
export function CommandPalette({ accounts }: { accounts: PaletteAccount[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(
    () => [
      ...ALL_NAV.map((n) => ({ id: `n:${n.href}`, group: "Go to" as const, label: n.label, icon: n.icon, href: n.href, keywords: n.keywords })),
      ...accounts.map((a) => ({ id: `acc:${a.id}`, group: "Accounts" as const, label: a.name, hint: a.hint, icon: Landmark, href: `/accounts/${a.id}` })),
      ...ACTIONS,
    ],
    [accounts],
  );

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const scored = commands
      .map((c, i) => ({ c, s: score(c, needle), i }))
      .filter((x): x is { c: Command; s: number; i: number } => x.s !== null)
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.c);
    // Without a query: pages and actions, a few accounts.
    if (!needle) return [...scored.filter((c) => c.group === "Go to"), ...scored.filter((c) => c.group === "Accounts").slice(0, 5), ...scored.filter((c) => c.group === "Actions")];
    return scored.slice(0, 30);
  }, [q, commands]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const go = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    router.push(c.href);
  };

  // Group headings in result order.
  let lastGroup = "";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search and commands">
      <div className="palette-backdrop absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} aria-hidden />
      <div className="palette relative w-full max-w-xl overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-pop">
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search size={18} className="shrink-0 text-muted" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(results.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(results[sel]);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Search accounts, pages, actions…"
            className="h-14 w-full bg-transparent text-base text-ink placeholder:text-muted focus:outline-none"
            aria-label="Search"
            aria-controls="palette-results"
            aria-activedescendant={results[sel] ? `pal-${results[sel].id}` : undefined}
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <ul ref={list} id="palette-results" role="listbox" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">Nothing matches “{q}”.</li>}
          {results.map((c, i) => {
            const heading = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            const Icon = c.icon;
            return (
              <li key={c.id} role="presentation">
                {heading && <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{heading}</div>}
                <button
                  id={`pal-${c.id}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  onMouseMove={() => setSel(i)}
                  onClick={() => go(c)}
                  className={clsx("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm", i === sel ? "bg-brand-tint text-ink" : "text-ink-2")}
                >
                  <span className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-lg", i === sel ? "bg-accent text-accent-ink" : "bg-surface-2 text-muted")}>
                    <Icon size={16} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{c.label}</span>
                  {c.hint && <span className="shrink-0 truncate text-xs text-muted">{c.hint}</span>}
                  {i === sel ? <CornerDownLeft size={14} className="shrink-0 text-muted" aria-hidden /> : <ArrowRight size={14} className="shrink-0 text-transparent" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted">
          <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move</span>
          <span><kbd className="kbd">↵</kbd> open</span>
          <span className="ml-auto">wallet</span>
        </div>
      </div>
    </div>
  );
}
