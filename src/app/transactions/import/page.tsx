import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { listAccounts } from "@/server/services/accounts";
import { PageHeader } from "@/components/ui";
import { ImportWizard } from "@/components/transactions-import-wizard";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import CSV" };

export default async function ImportPage() {
  const uid = (await requireUser()).id;
  const accounts = listAccounts(uid);
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
      <ImportWizard
        accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        defaultAccountId={checking.length === 1 ? checking[0].id : null}
      />
    </div>
  );
}
