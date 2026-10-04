import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { PasskeySignUp } from "@/components/passkey-auth";
import { signupAllowed } from "@/server/auth";
import { countUsers } from "@/server/services/users";
import { currentUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create your wallet" };

export default async function SignupPage() {
  if (await currentUser()) redirect("/");
  const users = countUsers();
  const first = users === 0;
  if (!signupAllowed(users)) {
    return (
      <AuthShell title="Sign-ups are closed" subtitle="Ask the owner of this wallet to open them (WALLET_ALLOW_SIGNUP).">
        <Link href="/login" className="block text-center text-sm font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title={first ? "Set up your wallet" : "Create your account"}
      subtitle={
        first
          ? "You'll be the owner. Your sign-in is a passkey — Face ID, Touch ID or your phone. No password to remember."
          : "Your own private wallet on this server, secured with a passkey."
      }
      footer={
        first ? null : (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-accent hover:underline">
              Sign in
            </Link>
          </>
        )
      }
    >
      <PasskeySignUp />
    </AuthShell>
  );
}
