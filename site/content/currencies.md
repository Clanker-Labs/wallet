---
title: Currencies & exchange rates
nav: Currencies
description: Keep every account, holding and transaction in its own currency. Totals are converted to your base currency with free daily rates for 200+ fiat currencies, crypto and metals.
blurb: Any currency per account; free daily rates, no API key.
section: features
order: 4
---

wallet never forces amounts into one currency. A EUR savings account stays in EUR, a USD brokerage in USD, a Bitcoin wallet in BTC. Only **totals** (net worth, budgets, cash flow, allocation) are converted, into your **base currency**, which is USD by default and set per user in **Settings → Preferences**.

```diagram
currency
```

## What you get

- **Any currency code** on accounts, holdings and transactions: ISO 4217 codes plus crypto and metals (`BTC`, `ETH`, `XAU`…). The pickers offer common ones first (USD, EUR, GBP, CHF, CAD, AUD, JPY, CNY…, BTC, ETH, XAU); any code with a known rate works.
- **Free daily rates, no key.** The primary source is the open [currency-api](https://github.com/fawazahmed0/exchange-api) dataset (200+ fiat currencies, crypto and metals), served from jsDelivr with a Cloudflare Pages mirror; [Frankfurter](https://frankfurter.dev) (European Central Bank reference rates) is the fallback.
- **Historical accuracy.** Every conversion uses the rate of the date it's about: a transaction from March uses March's rate, last year's net worth uses last year's rates.
- **Offline-friendly.** Conversions read only stored rates, so the app works with the last known ones when the sources are unreachable.
- **No silent mixing.** A currency without any rate counts as 0 and is listed under *Needs attention* ("No exchange rate for XYZ yet") until rates arrive.

## Changing the base currency

Switching the base currency in Settings re-expresses every total immediately: nothing is converted or rewritten in the database, because balances are always stored in their own currency. Budgets are amounts in the base currency, so they keep their number but change unit; adjust them after switching.

## Where rates come from

| Trigger | What happens |
|---|---|
| The worker, every hour | Fetches today's rates if the latest stored ones are older than yesterday. |
| **Settings → Exchange rates → Refresh** | Fetches now, whatever the age. |
| The assistant's `convert_currency` tool, the stdio MCP server on start | Same freshness check as the worker. |

Each attempt tries the sources in order and keeps the first that answers with a plausible payload. Without `force`, attempts are throttled to one every 6 hours per process, and a failure is logged, never thrown into a page. **Settings → Exchange rates** shows the date of the latest rates, how many currencies they cover, and the rate of each currency you use against your base currency.

Under the hood: [Multi-currency internals](multi-currency.html).
