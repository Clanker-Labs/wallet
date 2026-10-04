import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { FormatProvider } from "@/components/format";
import { getSettings } from "@/server/services/settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Wallet", template: "%s · Wallet" },
  description: "Net worth, budgets and simulations — self-hosted.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0d" },
  ],
};

// Apply a stored theme before first paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem("wallet-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { currency, locale } = getSettings();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <FormatProvider value={{ currency, locale }}>
          <AppShell>{children}</AppShell>
        </FormatProvider>
      </body>
    </html>
  );
}
