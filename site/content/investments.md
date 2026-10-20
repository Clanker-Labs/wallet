---
title: Investments & prices
nav: Investments
description: Stocks, ETFs, funds, bonds, crypto and gold, valued at daily market prices with no API key, plus manual prices for anything without a market.
blurb: Holdings at daily market prices, gains vs cost, allocation.
section: features
order: 3
video: investments
---

`/investments` lists every position across your accounts with its quantity, latest price, market value and gain, plus totals **by asset type** and **by currency** (in your base currency).

## Adding a position

1. **Find the symbol.** Type a name, ticker or ISIN ("Apple", "MSCI World Amundi", "gold"). Results come from Yahoo Finance's public search: `AAPL`, `CW8.PA` (Paris), `VWCE.DE` (Xetra), `BTC-USD`, `GC=F` (gold futures).
2. **Quantity**: shares, units, coins or ounces.
3. **Total cost** (optional): what you paid in all, in the quote currency. It's stored as an average cost per unit and drives the gain column.
4. **Account**: the brokerage, PEA, wallet… that holds it. The quote currency defaults to the account's.

When you add a symbol, its last year of daily closes is fetched right away (so history charts have something to show), then the account's value is recorded for today. Adding a symbol the account already holds **replaces** its quantity rather than adding to it; to buy more, enter the new total.

**Physical or unlisted assets** (gold coins, a watch, unlisted shares) take a **manual price** per unit instead of a symbol. A manual price also overrides a symbol's market price when both are set.

Asset types: stock, ETF, fund, bond, crypto, commodity, cash, other.

## Prices

Prices come from Yahoo Finance's public chart endpoint, without a key, and are stored daily in the shared `prices` table. Valuations only read that table, so pages stay fast and work offline with the last known prices.

| When | What is refreshed |
|---|---|
| Any page load (web app) | In the background after the response, at most every 30 minutes per server process: exchange rates, then symbols not fetched in the last 6 hours, then every user's holdings accounts get today's value snapshot. |
| The worker, hourly | The same refresh. |
| **Refresh prices** (or the `refresh_prices` tool) | Every held symbol, now. |
| Adding a position, or changing its symbol | That symbol: a year of history for a new one, the last 5 days for one the account already holds. |

London quotes in pence (`GBp`) and other minor units are converted to the major currency. A quote in a different currency than the holding's is converted with that day's rate. A symbol that can't be priced shows in *Needs attention* with a hint to fix the symbol or set a manual price. More in [Holdings & valuation](valuation.html).

## Gains

Gain = market value − quantity × average cost, in the quote currency, with the percentage. The total gain at the top only counts positions that have a cost basis. Removing the last position of an account sets the account to 0 for today instead of freezing its previous value.

## Brokerage sync

**Settings → Brokerage connections** links a broker account so its positions keep themselves up to date. Trading 212 is the first connector (Invest and ISA accounts, live or practice).

1. In the Trading 212 app: **Settings → API (Beta) → Generate API key**. Grant only the read permissions: *Account data*, *Portfolio* and *Metadata*. wallet never calls an order endpoint, so leave *Orders* off and a leaked key still can't trade.
2. Paste the key and the secret, pick live or practice, and choose an investment account to sync into, or let wallet create one in the broker's currency. Practice accounts are created outside net worth.
3. The key is checked against Trading 212 before anything is saved, then stored encrypted ([Security](security.html#broker-credentials)).

Every sync **replaces** the account's synced positions with the broker's: new positions appear, sold ones disappear, quantities and average prices follow, and a *Cash* line holds uninvested cash (free + pie cash + cash reserved for pending orders). Holdings you add by hand to the same account are left alone. Synced rows carry a *synced* badge and can't be edited here; change them at the broker.

Tickers are mapped to Yahoo symbols (`AAPL_US_EQ` → `AAPL`, `VUSAl_EQ` → `VUSA.L`, `SAPd_EQ` → `SAP.DE`) so new positions get a year of price history; the broker's own price is stored as today's price, so a position is valued even when Yahoo doesn't know its symbol.

| When | What syncs |
|---|---|
| Connecting | Immediately. |
| Background (web every 30 min, worker hourly) | Connections not synced in the last 50 minutes, after the price refresh. |
| **Sync now** (or the `sync_connection` tool) | That connection, at most every 30 seconds. |

A failed sync (revoked key, rate limit, outage) keeps the last positions and shows the error on the connection. **New key** swaps the credentials for the same broker account. **Disconnect** deletes the key; the positions stay as ordinary manual holdings.

## From statements

Drop a broker statement or a screenshot of your broker's app on the [assistant](assistant.html): it looks up each line with `search_symbol` (ISINs work) and adds it with `upsert_holding`.
