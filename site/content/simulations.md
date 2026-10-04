---
title: Simulations
description: A mortgage calculator with borrowing capacity, buy vs rent over N years, and a net worth projection with a Monte Carlo band and a financial-independence date, prefilled from your data.
blurb: Mortgage, buy vs rent, and a Monte Carlo net worth projection.
section: features
order: 8
video: simulations
---

`/simulations` has three tabs. Results update as you type, and amount fields accept shortcuts such as `450k` or `1 234,56`. Any scenario can be **saved** under a name and reloaded later; the assistant runs the same calculations through `simulate_mortgage`, `borrowing_capacity`, `simulate_buy_vs_rent` and `project_net_worth`.

## Mortgage

Price, works, down payment, rate, duration and fees in; out come the loan amount, the monthly payment (principal and interest, plus borrower insurance), the total cost of credit, an APR-style effective rate, your debt-to-income ratio with a check against the French HCSF rules (35% including insurance, 25 years at most), and a yearly amortization table showing your equity.

The defaults follow **French** practice, which you can override for anywhere else:

| Input | Default |
|---|---|
| Notary fees | 7.5% of the price (≈2.5% for a new build) |
| Rate | 3.3% per year |
| Borrower insurance | 0.3% of the initial capital per year |
| Duration | 25 years |
| Guarantee (caution) | 1.2% of the loan |
| Bank fees | 1,000 |
| Debt-to-income cap | 35% (the HCSF rule) |
| Property appreciation | 2% per year |

**Borrowing capacity** works backwards from your net monthly income: the largest payment under the debt-to-income cap, the loan it supports, and the property price that fits once fees and your down payment are counted. Your income is prefilled with your average monthly income over the last 6 complete months that have transactions.

## Buy vs rent

Takes the same purchase plus rent, rent increases, property tax, building charges, upkeep (% of value), selling costs, the return on invested savings and the tax on investment gains. Year by year it compares two households:

- the **buyer** pays the loan and ownership costs, and owns the home minus what's left to repay and the selling costs;
- the **renter** invests the down payment instead;
- each month, whichever of the two spends less invests the difference, and both portfolios are taxed on their gains when cashed out.

It reports both net worths per year, the price-to-rent ratio, and the **break-even year**: the year from which the buyer stays ahead until the end of the horizon.

## Net worth projection

Projects your net worth over N years with monthly contributions growing each year, an expected return, inflation, and one-off events (an inheritance, a car, a wedding: positive or negative amounts in a given year). Results are shown in nominal and in today's money.

Prefilled from your data:

| Input | From |
|---|---|
| Starting net worth | Today's net worth |
| Monthly contribution | Average net savings over the last 6 complete months with transactions |
| Return and volatility | Your current allocation, weighting per class: cash 2.5% / 0.5% vol, investments 6% / 15%, retirement 5% / 12%, real estate 2.5% / 6%, crypto 8% / 60%, commodities 3% / 15%, other 0% / 5% |
| Annual expenses | 12 × your average monthly expenses |

**Monte Carlo band**: 400 paths of log-normal monthly returns with the same expected growth (seeded, so results are repeatable) give the 10th, 50th and 90th percentiles per year.

**Financial independence**: with annual expenses set, the target is expenses ÷ withdrawal rate (4% by default, so 25× expenses). The projection reports the first year the inflation-adjusted net worth reaches it, and the share of Monte Carlo paths that get there within the horizon.

> [!NOTE]
> These are estimates under the assumptions you see, not advice. The assistant states its assumptions and how sensitive the result is to them when it runs a simulation for you.
