"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bell,
  Bot,
  Calculator,
  LayoutDashboard,
  Landmark,
  Menu,
  Moon,
  PiggyBank,
  ReceiptText,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { Wordmark } from "./brand";

const NAV = [
  { href: "/", label: "Net worth", icon: LayoutDashboard },
  { href: "/accounts", label: "Accounts", icon: Landmark },
  { href: "/budgets", label: "Budgets", icon: PiggyBank },
  { href: "/transactions", label: "Transactions", icon: ReceiptText },
  { href: "/simulations", label: "Simulations", icon: Calculator },
  { href: "/reminders", label: "Reminders", icon: Bell },
  { href: "/assistant", label: "Assistant", icon: Bot },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Routes that render full-screen without the app chrome (auth / onboarding). */
const BARE_PREFIXES = ["/login", "/signup", "/welcome"];

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    const stored = document.documentElement.dataset.theme as "light" | "dark" | undefined;
    setTheme(stored ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("wallet-theme", next);
    } catch {}
    setTheme(next);
  };
  return (
    <button
      onClick={toggle}
      className="grid h-8 w-8 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
      aria-label="Toggle theme"
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  if (BARE_PREFIXES.some((p) => pathname.startsWith(p))) return <>{children}</>;

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
              active ? "bg-brand-tint font-medium text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            <Icon
              size={16}
              strokeWidth={active ? 2.2 : 1.8}
              className={active ? "text-accent" : "text-muted transition-colors group-hover:text-ink-2"}
              aria-hidden
            />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen md:flex">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-surface px-3 py-5 md:flex">
        <Link href="/" className="mb-7 flex items-center px-2.5" aria-label="wallet — net worth">
          <Wordmark size={28} />
        </Link>
        {nav}
        <div className="mt-auto flex items-center justify-between border-t border-border px-1 pt-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-gain" aria-hidden />
            self-hosted
          </span>
          <ThemeToggle />
        </div>
      </aside>

      <div className="sticky top-0 z-20 md:hidden">
        <header className="flex items-center justify-between border-b border-border bg-page/85 px-4 py-2.5 backdrop-blur-md">
          <Link href="/" className="flex items-center" aria-label="wallet — net worth">
            <Wordmark size={26} />
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <button
              className="grid h-8 w-8 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              onClick={() => setOpen((o) => !o)}
              aria-label="Menu"
              aria-expanded={open}
            >
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </header>
        {open && (
          <div className="absolute inset-x-0 top-full border-b border-border bg-surface p-3 shadow-pop">{nav}</div>
        )}
      </div>

      <main className="mx-auto w-full max-w-6xl min-w-0 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
