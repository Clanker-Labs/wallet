import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { PasskeySignIn } from "@/components/passkey-auth";
import { signupAllowed } from "@/server/auth";
import { countUsers } from "@/server/services/users";
import { currentUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  if (await currentUser()) redirect(safeNext);
  const users = countUsers();
  if (users === 0) redirect("/signup");
  return (
    <AuthShell
      title="Welcome back"
      subtitle="No password: use the passkey on this device, or your iPhone."
      footer={
        signupAllowed(users) ? (
          <>
            New here?{" "}
            <Link href="/signup" className="font-medium text-accent hover:underline">
              Create an account
            </Link>
          </>
        ) : null
      }
    >
      <PasskeySignIn next={safeNext} />
    </AuthShell>
  );
}
