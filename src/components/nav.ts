import {
  Bell,
  Bot,
  Briefcase,
  Building2,
  Calculator,
  CandlestickChart,
  LayoutDashboard,
  Landmark,
  PiggyBank,
  ReceiptText,
  Repeat,
  Scale,
  Settings,
  Target,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Words the command palette also matches. */
  keywords?: string;
}

/** Navigation, grouped the way you think about money: what you have, what flows, what you build, what's ahead. */
export const NAV_GROUPS: { label: string | null; items: NavItem[] }[] = [
  {
    label: null,
    items: [
      { href: "/", label: "Net worth", icon: LayoutDashboard, keywords: "home dashboard overview" },
      { href: "/accounts", label: "Accounts", icon: Landmark, keywords: "balances banks" },
      { href: "/investments", label: "Investments", icon: CandlestickChart, keywords: "portfolio stocks holdings trading" },
    ],
  },
  {
    label: "Money",
    items: [
      { href: "/transactions", label: "Transactions", icon: ReceiptText, keywords: "spending activity statement" },
      { href: "/budgets", label: "Budgets", icon: PiggyBank, keywords: "envelopes spending" },
      { href: "/recurring", label: "Recurring", icon: Repeat, keywords: "salary rent subscriptions bills" },
    ],
  },
  {
    label: "Wealth",
    items: [
      { href: "/goals", label: "Goals", icon: Target, keywords: "savings targets" },
      { href: "/jobs", label: "Jobs", icon: Briefcase, keywords: "gratuity eosb salary employment" },
      { href: "/companies", label: "Companies", icon: Building2, keywords: "business equity" },
    ],
  },
  {
    label: "Plan",
    items: [
      { href: "/tax", label: "Tax", icon: Scale, keywords: "income tax residency" },
      { href: "/simulations", label: "Simulations", icon: Calculator, keywords: "mortgage fire projection what if" },
      { href: "/reminders", label: "Reminders", icon: Bell, keywords: "nag notify" },
    ],
  },
];

export const NAV_FOOT: NavItem[] = [
  { href: "/assistant", label: "Assistant", icon: Bot, keywords: "ai chat ask import" },
  { href: "/settings", label: "Settings", icon: Settings, keywords: "preferences security backups categories rules" },
];

export const ALL_NAV: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), ...NAV_FOOT];

