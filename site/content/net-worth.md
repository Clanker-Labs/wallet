---
title: Net worth
description: Every account in one number, in your base currency, with monthly history, change over 1 month, YTD and 1 year, and allocation by asset class.
blurb: Every account in one number, with history and allocation.
section: features
order: 1
video: net-worth
---

The dashboard (`/`) is the page you open once a month. It answers three questions: what am I worth, how did it move, and what needs updating.

## What you see

- **Net worth** in your base currency, with assets and liabilities, and the change over **1 month**, **year to date** and **1 year** (amount and percent).
- **History**: net worth at each month-end for the last 24 months (from your first balance on), plus today.
- **Allocation**: gross assets by class (your share): cash & savings, investments, retirement, real estate, crypto, commodities, other. Colors follow the class, never its rank, so "crypto" is the same color on every chart.
- **Needs attention**: balances not updated for 35 days, uncategorized transactions, budgets over their limit, reminders waiting for a ✅, and currencies or symbols without a rate or price.
- **This month's budgets**, **cash flow** for the last 6 months, and **upcoming reminders**.

With no accounts yet, the page shows a welcome card with two ways in: add your first account, or drop a statement for the assistant to import.

## How it's computed

Net worth on any date is the sum over accounts of:

```text
contribution = sign × convert(balance × ownership %, account currency → base currency, date)
sign         = −1 for liabilities, +1 otherwise; 0 when "include in net worth" is off
```

The **balance** of an account on a date depends on its kind ([Holdings & valuation](valuation.html)):

| Account | Balance on a date |
|---|---|
| Manual (bank, savings, property…) | Its latest balance snapshot on or before that date. |
| Loan with loan terms | Remaining principal from the amortization schedule; nothing to record. |
| Holds investments | Today: quantity × latest price for each holding. Past dates: the value snapshot of that day or earlier (recorded hourly by the worker and on every change), else today's quantities × that day's prices. |
| Archived | Its last balance until the archive date, then 0. |

Each amount is converted with the exchange rate **of that date** (the latest stored rate on or before it), so last year's EUR savings are valued at last year's EUR rate ([Multi-currency internals](multi-currency.html)). The 1M / YTD / 1Y changes compare today with the same computation on the reference date (YTD uses December 31 of last year).

All of this reads only the database: rates and prices are fetched in the background, never while the page renders.

## Things that keep it accurate

- **Ownership share**: a flat bought 50/50 is entered at full value with 50%, so the chart shows your half and the account page shows the whole.
- **Liabilities** are entered as the positive amount owed. A mortgage can point at the property it finances, and both pages show your equity.
- **Missing data is visible, not guessed**: an account in a currency with no known rate counts as 0 and is listed under *Needs attention* with a link to Settings. The same goes for a holding without a price.

The same numbers are available to the assistant and over the API through `get_overview`, `get_net_worth` and `get_net_worth_history` ([Agent tools](tools.html)).
