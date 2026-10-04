---
title: Accounts
description: Bank accounts, savings, brokerages, retirement plans, crypto wallets, property and loans, each in its own currency, with a balance history.
blurb: Every account in its own currency, loans that amortize themselves.
section: features
order: 2
video: accounts
---

An **account** is anything that holds or owes money. Accounts are grouped by asset class on `/accounts`, with each group's total and share of your assets. Updating a balance takes three keystrokes: click **Update** on the row, type the amount, press Enter.

## Account types

The type sets the asset class (you can override it):

| Asset class | Types |
|---|---|
| Cash & savings | Checking, Savings (Livret A, HYSA…) |
| Investments | Brokerage, PEA, Life insurance (assurance-vie), Employee savings (PEE) |
| Retirement | Retirement (401k, IRA, PER…) |
| Crypto | Crypto |
| Commodities | Precious metals & commodities |
| Real estate | Real estate |
| Other assets | Vehicle, Other asset |
| Liabilities | Mortgage, Loan (consumer, student…), Credit card, Other liability |

Each account also has:

- **Currency**: any ISO code, or a crypto/metal code such as `BTC` or `XAU`. Defaults to your base currency. Balances are stored in this currency and converted for totals ([Currencies](currencies.html)).
- **Ownership %**: your share. A flat bought as a couple is entered at full value with 50%.
- **Include in net worth**: turn it off for an account you track but don't count (a child's savings, a business account).
- **Institution** and **notes**, for your own reference.

## Balances and history

A balance is a **snapshot**: an amount on a date, in the account's currency, with an optional note and its source (`manual`, `telegram`, `agent`, `holdings`…). There is at most one per account per day; recording again on the same day replaces it. An account's balance on any date is its latest snapshot on or before that date, so history needs no interpolation, and you can backfill a past balance from an old statement.

The account page shows a balance chart, every record (newest first, deletable) and a form to record a balance on any date. For liabilities, enter the amount still owed as a positive number; a minus sign is dropped.

Balances also arrive from Telegram (`/balance`, `/update`, or a reply to a reminder) and from the assistant (`record_balance`).

## Loans that amortize themselves

Give a mortgage or loan its **loan terms** (principal, annual rate, duration in months, date of the first payment, and optionally borrower insurance as a % of the initial capital per year) and you never record its balance again. The balance on any date is the remaining principal after the payments made by then, from the standard fixed-rate formula. Before the funds are released (about a month before the first payment) the balance is 0.

Link a mortgage to the **property** it finances and both pages show your equity: the property's value minus what's left to repay.

## Accounts valued from holdings

Brokerage, PEA, retirement, crypto and precious-metal accounts usually hold **positions**. As soon as an account has holdings, its balance is their market value: quantity × price, converted to the account currency. You add positions on [Investments](investments.html) (or from the account page), not a balance.

## Closing an account

- **Archive** keeps the history: the account drops to 0 from today (a 0 snapshot named "Account closed") and disappears from the active list. Unarchiving removes that 0 snapshot, so the last real balance, or the loan schedule, applies again.
- **Delete** removes the account with its snapshots and holdings. Transactions stay, without an account. Loans linked to it lose the link.

## Staleness

An account counts as **stale** when its latest balance is more than 35 days old (accounts valued from a loan schedule or holdings never are). Stale accounts show on the dashboard and in the Telegram `/update` walkthrough, stalest first.
