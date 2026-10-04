import { DateTime } from "luxon";
import { getSimulation, listSimulations } from "@/server/services/simulations";
import { netWorthOn } from "@/server/services/networth";
import { averageMonthlySavings } from "@/server/services/budgets";
import { getSettings } from "@/server/services/settings";
import { blendedAssumptions } from "@/lib/finance/projection";
import { PageHeader } from "@/components/ui";
import { SimWorkspace } from "@/components/sim-workspace";
import { isSimTab, type DataDefaults, type SavedScenario } from "@/components/sim-model";
import type { Simulation } from "@/server/db/schema";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Simulations" };

export default async function SimulationsPage({ searchParams }: { searchParams: Promise<{ tab?: string; load?: string }> }) {
  const uid = (await requireUser()).id;
  const sp = await searchParams;
  const { timezone, locale } = getSettings(uid);

  const toSaved = (s: Simulation): SavedScenario => ({
    id: s.id,
    name: s.name,
    type: s.type,
    params: s.params ?? {},
    createdLabel: DateTime.fromJSDate(s.createdAt).setZone(timezone).setLocale(locale).toFormat("d LLL yyyy"),
  });
  const saved = listSimulations(uid).map(toSaved);
  const loadId = Number(sp.load);
  const loadedRow = Number.isInteger(loadId) && loadId > 0 ? getSimulation(uid, loadId) : undefined;

  // Prefill the projection (and the mortgage income) from the user's own data.
  const nw = netWorthOn(uid);
  const savings = averageMonthlySavings(uid, 6);
  const blend = blendedAssumptions(nw.byClassCents);
  const hasFlows = savings.monthsWithData > 0;
  const data: DataDefaults = {
    startingNetWorth: Math.round(nw.netCents / 100),
    monthlyContribution: hasFlows ? Math.max(0, Math.round(savings.netCents / 100)) : null,
    annualReturnPct: blend.returnPct,
    volatilityPct: blend.volatilityPct,
    annualExpenses: hasFlows && savings.expensesCents > 0 ? Math.round((savings.expensesCents * 12) / 100) : null,
    monthlyNetIncome: hasFlows && savings.incomeCents > 0 ? Math.round(savings.incomeCents / 100) : null,
    monthsWithData: savings.monthsWithData,
  };

  return (
    <div>
      <PageHeader
        title="Simulations"
        subtitle="Results update as you type. Amounts accept shortcuts like 450k or 1 234,56."
      />
      <SimWorkspace initialTab={isSimTab(sp.tab) ? sp.tab : "mortgage"} saved={saved} data={data} loaded={loadedRow ? toSaved(loadedRow) : null} />
    </div>
  );
}
