"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CandlestickChart,
  ChevronsLeft,
  LayoutDashboard,
  Landmark,
  Menu,
  Moon,
  Plus,
  ReceiptText,
  Search,
  ShieldCheck,
  Sun,
  X,
} from "lucide-react";
import { LogoMark, Wordmark } from "./brand";
import { CommandPalette, openPalette, type PaletteAccount } from "./command-palette";
import { ALL_NAV, NAV_FOOT, NAV_GROUPS, type NavItem } from "./nav";
import { SignOutButton } from "./passkey-auth";

/** Phone tab bar: the four places you open most, and everything else behind "More". */
const TABS: NavItem[] = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/accounts", label: "Accounts", icon: Landmark },
  { href: "/investments", label: "Invest", icon: CandlestickChart },
  { href: "/transactions", label: "Activity", icon: ReceiptText },
];

/** Routes that render full-screen without the app chrome (auth / onboarding). */
const BARE_PREFIXES = ["/login", "/signup", "/welcome"];

const isActive = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));

function ThemeToggle({ className }: { className?: string }) {
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
    <button onClick={toggle} className={clsx("icon-btn", className)} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

export interface ShellUser {
  name: string;
}

function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-brand-gradient font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

/** Signed-in user: initial, name, account security and sign out. */
function UserBlock({ user }: { user: ShellUser }) {
  return (
    <div className="flex items-center gap-2.5">
      <Avatar name={user.name} />
      <div className="nav-label min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink" title={user.name}>
          {user.name}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Link href="/settings#security" className="inline-flex items-center gap-1 hover:text-ink hover:underline">
            <ShieldCheck size={12} aria-hidden /> Security
          </Link>
          <span aria-hidden>·</span>
          <SignOutButton className="cursor-pointer hover:text-ink hover:underline" />
        </div>
      </div>
    </div>
  );
}

function NavLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={item.label}
      className={clsx("nav-link group", active && "nav-link-active")}
    >
      <Icon size={17} strokeWidth={active ? 2.2 : 1.8} className="shrink-0" aria-hidden />
      <span className="nav-label truncate">{item.label}</span>
    </Link>
  );
}

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-4" aria-label="Main">
      {NAV_GROUPS.map((g, i) => (
        <div key={g.label ?? i} className="flex flex-col gap-0.5">
          {g.label && <div className="nav-group-label">{g.label}</div>}
          {g.items.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </nav>
  );
}

function setRail(rail: boolean) {
  if (rail) document.documentElement.dataset.nav = "rail";
  else delete document.documentElement.dataset.nav;
  try {
    localStorage.setItem("wallet-nav", rail ? "rail" : "full");
  } catch {}
}

export function AppShell({
  children,
  user = null,
  accounts = [],
}: {
  children: React.ReactNode;
  user?: ShellUser | null;
  accounts?: PaletteAccount[];
}) {
  const pathname = usePathname();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [pathname]);

  if (BARE_PREFIXES.some((p) => pathname.startsWith(p))) return <>{children}</>;

  const current = ALL_NAV.find((n) => isActive(pathname, n.href));

  return (
    <div className="shell min-h-dvh">
      <a href="#main" className="sr-only z-50 rounded-lg bg-accent px-3 py-2 text-accent-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>

      {/* Sidebar: full from lg, an icon rail on tablets or when collapsed. */}
      <aside className="sidebar fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-surface/80 backdrop-blur-xl md:flex">
        <div className="flex h-16 shrink-0 items-center justify-between px-4">
          <Link href="/" className="flex items-center" aria-label="wallet — net worth">
            <span className="nav-label">
              <Wordmark size={28} />
            </span>
            <span className="nav-rail-only">
              <LogoMark size={30} />
            </span>
          </Link>
          <button className="icon-btn nav-collapse" onClick={() => setRail(true)} aria-label="Collapse sidebar" title="Collapse sidebar">
            <ChevronsLeft size={16} />
          </button>
        </div>
        <div className="px-3 pb-3">
          <button onClick={openPalette} className="search-pill w-full" aria-label="Search and commands">
            <Search size={15} className="shrink-0" aria-hidden />
            <span className="nav-label flex-1 text-left">Search…</span>
            <kbd className="nav-label kbd">⌘K</kbd>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <NavList pathname={pathname} />
        </div>
        <div className="flex flex-col gap-0.5 border-t border-border px-3 py-3">
          {NAV_FOOT.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </div>
        <div className="border-t border-border p-3">
          {user && (
            <div className="mb-2">
              <UserBlock user={user} />
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="nav-label inline-flex items-center gap-1.5 text-xs text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-gain" aria-hidden />
              self-hosted
            </span>
            <div className="flex items-center gap-0.5">
              <button className="icon-btn nav-expand" onClick={() => setRail(false)} aria-label="Expand sidebar" title="Expand sidebar">
                <ChevronsLeft size={16} className="rotate-180" />
              </button>
              <ThemeToggle />
            </div>
          </div>
        </div>
      </aside>

      <div className="shell-body flex min-h-dvh min-w-0 flex-col">
        {/* Top bar: where you are, search, quick add. Sticky, translucent. */}
        <header className="topbar sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-page/75 px-4 backdrop-blur-xl md:h-16 md:px-6 lg:px-8">
          <Link href="/" className="md:hidden" aria-label="wallet — net worth">
            <Wordmark size={26} />
          </Link>
          <div className="hidden min-w-0 items-center gap-2 text-sm md:flex">
            {current && (
              <>
                <current.icon size={16} className="text-muted" aria-hidden />
                <span className="truncate font-medium text-ink">{current.label}</span>
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={openPalette} className="search-pill hidden w-64 sm:flex xl:w-80" aria-label="Search and commands">
              <Search size={15} className="shrink-0" aria-hidden />
              <span className="flex-1 text-left">Search accounts, pages, actions…</span>
              <kbd className="kbd">⌘K</kbd>
            </button>
            <button onClick={openPalette} className="icon-btn sm:hidden" aria-label="Search">
              <Search size={17} />
            </button>
            <Link href="/transactions#add" className="btn-new hidden sm:inline-flex" title="Add a transaction">
              <Plus size={15} aria-hidden /> New
            </Link>
            <ThemeToggle className="md:hidden" />
          </div>
        </header>

        <main id="main" tabIndex={-1} className="page-enter w-full min-w-0 flex-1 px-4 pt-5 pb-28 outline-none md:px-6 md:pt-7 md:pb-12 lg:px-8 2xl:px-12" key={pathname}>
          {children}
        </main>
      </div>

      {/* Phone tab bar */}
      <nav className="tabbar fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface/90 backdrop-blur-xl md:hidden" aria-label="Main">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} className={clsx("tab", active && "tab-active")}>
              <Icon size={21} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
              {label}
            </Link>
          );
        })}
        <button className={clsx("tab", more && "tab-active")} onClick={() => setMore((m) => !m)} aria-expanded={more} aria-label="More">
          {more ? <X size={21} aria-hidden /> : <Menu size={21} aria-hidden />}
          More
        </button>
      </nav>

      {more && (
        <div className="fixed inset-0 z-20 md:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" aria-hidden />
          <div
            className="sheet absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-3xl border-t border-border bg-surface px-4 pt-3 pb-24 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border-strong" aria-hidden />
            <div className="grid grid-cols-3 gap-2">
              {ALL_NAV.filter((n) => !TABS.some((t) => t.href === n.href)).map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className={clsx(
                    "flex flex-col items-center gap-1.5 rounded-2xl border border-border px-2 py-3 text-xs font-medium",
                    isActive(pathname, href) ? "bg-brand-tint text-accent" : "bg-surface-2/50 text-ink-2",
                  )}
                >
                  <Icon size={20} aria-hidden />
                  {label}
                </Link>
              ))}
            </div>
            {user && (
              <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                <UserBlock user={user} />
                <ThemeToggle />
              </div>
            )}
          </div>
        </div>
      )}

      {user && <CommandPalette accounts={accounts} />}
    </div>
  );
}
