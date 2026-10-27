import type { Metadata, Viewport } from "next";
import { after } from "next/server";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { GlobalDrop } from "@/components/global-drop";
import { Pwa } from "@/components/pwa";
import { FormatProvider } from "@/components/format";
import { DEFAULT_SETTINGS, getSettings } from "@/server/services/settings";
import { currentUser } from "@/server/session";
import { refreshMarketDataInBackground } from "@/server/services/market";
import { visibleAccounts } from "@/server/services/accounts";
import { ACCOUNT_TYPES, ASSET_CLASS_LABELS } from "@/lib/domain";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "wallet", template: "%s · wallet" },
  description: "Your net worth, budgets and investments — private, on your own machine.",
  applicationName: "wallet",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "wallet", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

// Matches --page in globals.css so the browser chrome / iOS status bar blends in.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6fa" },
    { media: "(prefers-color-scheme: dark)", color: "#070b14" },
  ],
  colorScheme: "light dark",
};

// Apply a stored theme and sidebar state before first paint to avoid a flash.
const themeScript = `try{var d=document.documentElement,t=localStorage.getItem("wallet-theme");if(t)d.dataset.theme=t;if(localStorage.getItem("wallet-nav")==="rail")d.dataset.nav="rail"}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const { currency, locale } = user ? getSettings(user.id) : DEFAULT_SETTINGS();
  // Rates, prices and holdings snapshots stay current without the Telegram worker (throttled, never blocks).
  if (user) after(() => refreshMarketDataInBackground());
  // For the command palette: jump to any account by name.
  const accounts = user
    ? visibleAccounts(user.id).map((a) => ({ id: a.id, name: a.name, hint: [a.institution, ASSET_CLASS_LABELS[ACCOUNT_TYPES[a.type].assetClass]].filter(Boolean).join(" · ") }))
    : [];
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <FormatProvider value={{ currency, locale }}>
          <AppShell user={user ? { name: user.name } : null} accounts={accounts}>{children}</AppShell>
          {user && <GlobalDrop />}
          <Pwa />
        </FormatProvider>
      </body>
    </html>
  );
}
