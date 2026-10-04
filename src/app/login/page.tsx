import { redirect } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { passwordEnabled } from "@/server/auth";
import { Button, Card } from "@/components/ui";
import { login } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  if (!passwordEnabled()) redirect("/");
  const { next = "/", error } = await searchParams;

  return (
    <main className="grid min-h-screen place-items-center bg-page px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold tracking-tight">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-ink">w</span>
          wallet
        </div>
        <Card className="p-6">
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <LockKeyhole size={16} className="text-muted" aria-hidden />
            Enter your password
          </h1>
          <form action={login} className="mt-4 space-y-3">
            <input type="hidden" name="next" value={next} />
            <label htmlFor="password" className="sr-only">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              placeholder="Password"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
            {error && (
              <p id="login-error" role="alert" className="text-sm text-critical-text">
                Wrong password — try again.
              </p>
            )}
            <Button type="submit" variant="primary" className="h-10 w-full">
              Unlock
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-xs text-muted">Stays signed in for 90 days on this device.</p>
      </div>
    </main>
  );
}
