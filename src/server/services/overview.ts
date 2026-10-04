import { netWorthChanges } from "./networth";
import { budgetStatus, cashflow } from "./budgets";
import { staleAccounts } from "./accounts";
import { countUncategorized } from "./transactions";
import { pendingReminders, upcomingReminders } from "./reminders";
import { getSettings } from "./settings";

export interface Nudge {
  kind: "stale_balance" | "uncategorized" | "over_budget" | "pending_reminder";
  text: string;
  href: string;
}

/**
 * Everything the dashboard (and the agent's first look) needs in one call,
 * including a short "needs attention" list.
 */
export function getOverview() {
  const { current, changes } = netWorthChanges();
  const budget = budgetStatus();
  const flows = cashflow(6);
  const stale = staleAccounts();
  const uncategorized = countUncategorized();
  const pending = pendingReminders();

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

  return {
    settings: getSettings(),
    netWorth: current,
    changes,
    budget,
    cashflow: flows,
    upcoming: upcomingReminders(5),
    nudges,
  };
}
