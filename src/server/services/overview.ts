import { netWorthChanges } from "./networth";
import { budgetStatus, cashflow } from "./budgets";
import { staleAccounts } from "./accounts";
import { countUncategorized } from "./transactions";
import { pendingReminders, upcomingReminders } from "./reminders";
import { getSettings } from "./settings";

export interface Nudge {
  kind: "stale_balance" | "uncategorized" | "over_budget" | "pending_reminder" | "missing_rate" | "missing_price";
  text: string;
  href: string;
}

/**
 * Everything the dashboard (and the agent's first look) needs in one call,
 * including a short "needs attention" list.
 */
export function getOverview(uid: string) {
  const { current, changes } = netWorthChanges(uid);
  const budget = budgetStatus(uid);
  const flows = cashflow(uid, 6);
  const stale = staleAccounts(uid);
  const uncategorized = countUncategorized(uid);
  const pending = pendingReminders(uid);

  const nudges: Nudge[] = [];
  for (const r of pending)
    nudges.push({ kind: "pending_reminder", text: `Reminder waiting: ${r.title}`, href: "/reminders" });
  for (const a of stale.slice(0, 5))
    nudges.push({
      kind: "stale_balance",
      text: a.lastUpdated ? `${a.name}: balance last updated ${a.lastUpdated}` : `${a.name}: no balance yet`,
      href: `/accounts/${a.id}`,
    });
  if (uncategorized > 0)
    nudges.push({
      kind: "uncategorized",
      text: `${uncategorized} transaction${uncategorized > 1 ? "s" : ""} to categorize`,
      href: "/transactions?category=none",
    });
  for (const l of budget.lines.filter((l) => l.status === "over"))
    nudges.push({ kind: "over_budget", text: `${l.name} is over budget`, href: "/budgets" });

  for (const c of current.missingFx)
    nudges.push({ kind: "missing_rate", text: `No exchange rate for ${c} yet — amounts in ${c} count as 0`, href: "/settings" });
  for (const p of current.missingPrices.slice(0, 3))
    nudges.push({ kind: "missing_price", text: `No price for ${p} — set a manual price or check the symbol`, href: "/investments" });

  return {
    settings: getSettings(uid),
    netWorth: current,
    changes,
    budget,
    cashflow: flows,
    upcoming: upcomingReminders(uid, 5),
    nudges,
  };
}
