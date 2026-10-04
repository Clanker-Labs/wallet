---
title: Holdings & valuation
description: How positions are priced from Yahoo's chart API, how pence and other minor units are handled, why accounts are snapshotted daily, and how manual prices and loans fit in.
section: technical
order: 4
---

Code: [prices.ts](gh:src/server/services/prices.ts), [valuation.ts](gh:src/server/services/valuation.ts), [holdings.ts](gh:src/server/services/holdings.ts) and `balanceOnDate()` in [accounts.ts](gh:src/server/services/accounts.ts). User-facing view: [Investments & prices](investments.html).

## Price source: Yahoo's chart API

No key, no account. Two public endpoints are used, with a browser user agent:

| Use | Endpoint |
|---|---|
| Daily closes | `query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5d&interval=1d` (15 s timeout; `range=1y` for a newly added symbol) |
| Symbol search | `query2.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=8&newsCount=0` (names, tickers, ISINs) |

`parseYahooChart()` reads the series and normalizes it:

- **Dates** are taken in the exchange's own time zone (`timestamp + meta.gmtoffset`), so a Tokyo close isn't filed under the previous UTC day.
- **The live price wins for today**: during market hours `meta.regularMarketPrice` replaces the last daily bar of its day.
- **Minor units are converted** to the major currency: London quotes in pence (`GBp`, `GBX`) are divided by 100 and stored as `GBP`, likewise `ZAc` → `ZAR` and `ILA` → `ILS`. Without this a UK ETF would read 100× too high.
- **Type** comes from `instrumentType` / `quoteType`: `EQUITY` → stock, `ETF` → etf, `MUTUALFUND` → fund, `CRYPTOCURRENCY` → crypto, `FUTURE`/`COMMODITY` → commodity, `BOND` → bond, anything else → other.
- Null closes (holidays, halts) are skipped.

Closes go into `prices(symbol, date)` with `INSERT OR REPLACE`, upper-cased symbol, the quote currency and `fetched_at`. The table is **shared**: two users holding `VOO` share one series and one fetch.

## Refreshing

`refreshPrices({ symbols?, maxAgeHours = 6, range = "5d" })` fetches either the given symbols or every symbol anyone holds whose last fetch is older than `maxAgeHours`. It goes symbol by symbol, never throws, and returns `{ updated, failed }`.

| Caller | Call |
|---|---|
| Worker, every hour | `refreshMarketData()`: `ensureFreshRates()`, `refreshPrices()`, then `snapshotHoldingAccounts()` for every user |
| Any signed-in page load | `refreshMarketDataInBackground()` from the root layout via `after()`: the same work, at most every 30 minutes per process, never blocking the response |
| Opening **Investments** | Also `ensureFreshPrices()` after the response is sent: at most every 30 minutes per process |
| **Refresh prices**, `refresh_prices` tool | `refreshPrices({ maxAgeHours: 0 })`, then a snapshot |
| `upsert_holding` / adding a position | That symbol (`1y` when new to the account, `5d` otherwise), then a snapshot |

## The valuation context

Every page or tool that values things builds one `valuationContext(uid)`: the user's today (in their time zone), base currency, an [FX converter](multi-currency.html#the-converter), a **price reader** (latest close on or before a date, memoized), the user's holdings grouped by account, and a `missingPrices` set. It reads only the database.

`valueHolding(holding, date)` decides a unit price:

1. A **manual price** wins if set (physical gold, unlisted shares, or an override).
2. No symbol and no manual price → listed in `missingPrices` by name, valued 0.
3. Otherwise the latest close on or before `date`. None → listed by symbol, valued 0.
4. A close quoted in another currency than the holding's is converted at that date.

`holdingsValueCents(account, date)` sums quantity × unit price over the account's holdings, converted to the **account** currency, and reports the most recent price date used. Net worth then converts the account to the base currency like any other.

## Why accounts are snapshotted

Quantities change: you sell half a position, or move a fund to another account. Valuing last March with *today's* quantities would rewrite history. So `snapshotHoldingAccounts(uid)` records each holdings-based account's value for today as an ordinary balance snapshot (`source = "holdings"`, one per day, upserted). The worker does it hourly for everyone, the web app does it in the background (at most every 30 minutes), and every holding change does it too.

`balanceOnDate()` for an account with holdings:

| Date | Value |
|---|---|
| Today or later | Live: current quantities × latest prices |
| Past, with a snapshot on or before it | That snapshot |
| Past, before the first snapshot | Current quantities × that day's prices (the year of history fetched when the symbol was added) |

Removing the last position records a 0 balance for today, so the account doesn't freeze at its old value. Archived accounts aren't snapshotted.

## Gains

A holding stores its average **cost per unit** in the quote currency (the UI asks for the total paid and divides). Gain = value − quantity × cost, also in the quote currency; totals are converted to the base currency and only include positions with a cost basis. Re-adding a symbol the account already holds replaces the quantity and keeps the old cost basis unless a new one is given.

## Loans

Accounts with `loan_params` don't use snapshots at all (except the 0 written when archived). `loanBalanceOn(params, date)` counts payments made by that date (one per month from the first payment date, inclusive) and returns the remaining principal of a fixed-rate amortizing loan; borrower insurance doesn't affect the balance. Before about a month ahead of the first payment, the balance is 0. See [Accounts](accounts.html#loans-that-amortize-themselves).
