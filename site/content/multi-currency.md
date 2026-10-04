---
title: Multi-currency internals
description: How rates are stored per USD per day, where they come from and how fetching degrades, how the converter picks a rate, what happens when one is missing, and how history is valued.
section: technical
order: 3
---

The code is in [src/server/services/fx.ts](gh:src/server/services/fx.ts). The user-facing view is on [Currencies & exchange rates](currencies.html).

```diagram
currency
```

## Storage: units per USD, per day

`fx_rates` holds one row per `(currency, date)` with `per_usd`, the number of units of that currency worth 1 US dollar on that day (`EUR → 0.92`, `JPY → 147.3`, `BTC → 0.0000158`). USD itself is implicitly 1. Storing everything against one pivot means one row per currency per day covers every pair:

```text
rate(from → to, date) = perUsd(to, date) / perUsd(from, date)
100 EUR → GBP          = 100 × 0.79 / 0.92 = 85.87 GBP
```

Rates are **shared** by all users (they carry no personal data) and written with `INSERT OR REPLACE`, so fetching a day twice is harmless. The date is the one the source reports, which can be the previous business day for ECB-based data.

## Sources and fallback

`fetchRates(date)` tries each source in order and returns the first good answer:

| # | Source | URL |
|---|---|---|
| 1 | currency-api via jsDelivr | `cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date}/v1/currencies/usd.min.json` |
| 2 | currency-api via Cloudflare Pages | `{date}.currency-api.pages.dev/v1/currencies/usd.min.json` |
| 3 | Frankfurter (ECB reference rates, ~30 fiat currencies) | `api.frankfurter.dev/v1/{date}?base=USD` |

`{date}` is `latest` or `YYYY-MM-DD`. Each request has a 15 s timeout. A payload counts as good when it parses and has at least 5 currencies; codes are upper-cased, non-positive values dropped and `USD: 1` added. When all three fail, the error lists each source's reason.

## Refresh policy

`ensureFreshRates({ force? })` is what callers use. It never throws:

| Result | When |
|---|---|
| `fresh` | The latest stored rates are from yesterday (UTC) or later: nothing to do. |
| `throttled` | Stale, but this process already tried in the last 6 hours (skipped with `force`). |
| `updated` | Fetched and stored. |
| `failed` | Every source failed; logged as a warning, and conversions keep using the last stored rates. |

Concurrent calls share one in-flight request. It's called by the worker every hour, by the stdio MCP server on start, by the `convert_currency` tool, and with `force` by **Settings → Exchange rates → Refresh**. `backfillRates(dates)` can fetch specific past days that are missing (one request per date); `npm run db:seed-demo` instead stores synthetic history directly.

## The converter

`fxConverter()` returns a converter bound to the database, built once per request (it's part of the [valuation context](valuation.html#the-valuation-context)):

- `perUsd(currency, date)` is the **latest rate on or before** `date`. If the currency has no rate that early, it falls back to the **earliest** rate known for it. Lookups use two prepared statements and are memoized per `(currency, date)`.
- `rate(from, to, date)`: codes are trimmed and upper-cased; the same currency is always 1; otherwise `perUsd(to) / perUsd(from)`, or `null` when either side has no rate at all.
- `convertCents(cents, from, to, date)` rounds to whole cents; `convert(amount, …)` keeps decimals (used for unit prices).
- Conversions are **synchronous** and read only the database. Nothing in a page render waits on the network.

## Missing rates

A currency with no rate at all is added to the converter's `missing` set and converted as **0**, never at a made-up rate. The callers surface it:

- `netWorthOn()` returns `missingFx`; the dashboard turns each into a *Needs attention* item ("No exchange rate for XYZ yet — amounts in XYZ count as 0") linking to Settings.
- `holdingsSummary()` returns it for the Investments page; **Settings → Exchange rates** flags the currency.
- `convert_currency` fails with "No exchange rate for …" instead of returning 0.

A typo in a currency code shows up the same way, which is how you notice it.

## Where conversion happens

| What | Converted at |
|---|---|
| An account's contribution to net worth | The valuation date (each month-end for history), after applying the ownership share |
| A holding's price quoted in another currency than the holding | The valuation date |
| Holdings into their account's currency, then to the base | The valuation date |
| Transactions in budgets, cash flow and spending by category | Each transaction's own date (grouped by category, currency and date first) |
| A transaction's "base amount" in lists | Its own date |
| Simulations | Not converted: they work in the base currency |

## Historical valuation

History points (month-ends for the net worth chart, the 1M / YTD / 1Y comparisons) are valued with the rates of **their** date. Because the worker stores one day of rates per day from the moment you install wallet, older dates fall back to the earliest rate on file: a balance from 2023 entered in 2026 is valued at your first stored rate unless older days are backfilled. Changing your base currency re-expresses all of this instantly, since nothing is stored converted.

## Currency codes

Any code of 2 to 6 letters or digits is accepted (`/^[A-Z0-9]{2,6}$/` after upper-casing), so new currencies or tokens work as soon as the source publishes a rate for them. The base-currency picker in Settings offers the common codes first, then every other code in the latest rates (`knownCurrencies()`).
