import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { GlobalDrop } from "@/components/global-drop";
import { FormatProvider } from "@/components/format";
import { DEFAULT_SETTINGS, getSettings } from "@/server/services/settings";
import { currentUser } from "@/server/session";

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

// Apply a stored theme before first paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem("wallet-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const { currency, locale } = user ? getSettings(user.id) : DEFAULT_SETTINGS();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <FormatProvider value={{ currency, locale }}>
          <AppShell user={user ? { name: user.name } : null}>{children}</AppShell>
          {user && <GlobalDrop />}
        </FormatProvider>
      </body>
    </html>
  );
}
