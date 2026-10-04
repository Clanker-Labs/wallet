import Link from "next/link";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { listAccounts } from "@/server/services/accounts";
import { getSettings } from "@/server/services/settings";
import { agentStatus } from "@/server/agent/runner";
import { ButtonLink, PageHeader } from "@/components/ui";
import { ImportWizard } from "@/components/transactions-import-wizard";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import CSV" };

export default async function ImportPage() {
  const uid = (await requireUser()).id;
  const accounts = listAccounts(uid);
  const base = getSettings(uid).currency;
  const assistantReady = agentStatus().ready;
  // Bank exports almost always come from a checking account: preselect it when there's only one.
  const checking = accounts.filter((a) => a.type === "checking");
  return (
    <div className="space-y-5">
      <Link href="/transactions" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
        <ArrowLeft size={14} /> Transactions
      </Link>
      <PageHeader
        title="Import a bank CSV"
        subtitle="Export transactions from your bank’s website, drop the file here. Re-importing the same file is safe: duplicates are skipped."
      />

      <aside className="flex flex-col gap-3 rounded-2xl border border-border bg-brand-tint px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-card" aria-hidden>
          <Sparkles size={17} />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-ink">Got a PDF statement or a messy CSV? Drop it on the assistant.</p>
          <p className="mt-0.5 text-ink-2">
            It reads CSV and PDF uploads, works out the columns, and imports the transactions into the right account for you.
            {!assistantReady && (
              <>
                {" "}
                First,{" "}
                <Link href="/settings#integrations" className="font-medium text-accent hover:underline">
                  set up the assistant
                </Link>
                .
              </>
            )}
          </p>
        </div>
        <ButtonLink href="/assistant" size="sm" className="shrink-0 self-start sm:self-auto">
          Open the assistant <ArrowRight size={14} />
        </ButtonLink>
      </aside>

      <ImportWizard
        accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
        defaultAccountId={checking.length === 1 ? checking[0].id : null}
        baseCurrency={base}
      />
    </div>
  );
}
