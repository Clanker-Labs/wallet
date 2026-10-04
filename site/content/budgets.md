---
title: Budgets
description: A monthly envelope per spending category, a "spending too fast" pace marker, income, expenses and savings rate, and 12 months of cash flow.
blurb: Monthly envelopes with a pace marker and savings rate.
section: features
order: 5
video: budgets
---

`/budgets` shows one month at a time: the current one by default, with arrows to step back through past months. Budgets are **envelopes**: a monthly amount per expense category, in your base currency, the same every month.

## The page

- **Summary**: income, expenses, net savings and **savings rate** (net ÷ income) for the month.
- **Envelopes**: each budgeted category with spent vs budget, what's left, and a status.
- **Where it went**: spending by category, including categories without a budget and *Uncategorized*.
- **Last 12 months**: income vs expenses per month.

Click an amount to edit it, or **+ budget** on an unbudgeted category; 0 removes the budget. Budgets can also be set by the assistant (`set_budget`) and are read by `get_budget_status`.

## Statuses and the pace marker

| Status | When |
|---|---|
| **Over** | Spent more than the budget. |
| **Ahead of pace** | The share spent is more than 10 points ahead of the share of the month elapsed (e.g. 70% spent on the 15th of a 30-day month: 70% > 50% + 10%), **and** the category has more than one transaction. A single fixed charge early in the month (a transit pass, a subscription) doesn't trigger it. |
| **OK** | Neither. |
| **Unbudgeted** | Spending in a category without a budget. |

Past months count as fully elapsed. In the current month, a tick on each envelope's bar marks today, so you can compare spending with the calendar at a glance; *spending fast* flags the categories ahead of pace.

## How amounts are counted

Every transaction is converted to the base currency **at its own date's rate**, then grouped by category kind:

- **Expense** categories: money out minus money in. A refund in *Shopping* reduces Shopping's spending instead of counting as income.
- **Income** categories: money in minus money out.
- **Transfer** categories (*Transfers*, *Savings & investing*) are ignored: moving money to your brokerage is neither spending nor income.
- **Uncategorized** rows count by their sign: positive as income, negative as spending.

Cash flow uses the same rules for each of the last 12 months. The projection simulator and the assistant reuse them for your average monthly savings over the last 6 months.

## Categories

New users start with 23 categories: 4 income (Salary, Freelance & side income, Investment income, Refunds & other income), 17 expense (Housing, Groceries, Restaurants & bars, Transport, Subscriptions, Taxes…) and 2 transfer (Transfers, Savings & investing). Add, rename or delete them in **Settings → Categories**; the kind (income, expense or transfer) decides how a category counts.
