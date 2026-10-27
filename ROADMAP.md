# Roadmap: from tracker to daily driver

Written after a full review of the code (October 2026). The bar is a product
someone relies on every day, with money in several currencies across countries
(salary in AED, property in EUR, investments in USD and GBP), measured against
Monarch, Copilot, YNAB, Lunch Money, Finary, Kubera and Wealthfolio.

wallet's edge is what those apps don't do together: it's self-hosted and
private, multi-currency at its core, has an assistant that can actually
operate the data (40 MCP tools), Telegram, gratuity tracking, and French and
UAE specifics. What it lacks is mostly the boring backbone: correct history,
automatic data in, and money that doesn't get double-counted.

## Done in this round

| | What | Why it mattered |
|---|---|---|
| ✅ | **Multi-currency budgets.** Each envelope has its own currency, spending in other currencies is converted at each transaction's date, the page has a display-currency switcher, and missing rates are reported. | Rent is in EUR, groceries in AED: one base currency made one of them always wrong. |
| ✅ | **Account ownership enforced on every transaction write.** | A user could attach rows to another user's account by passing a currency, which skipped the check. |
| ✅ | **Historical exchange rates.** ECB daily via Frankfurter (one call per year), plus month-ends from currency-api for AED, SAR and crypto. | Every past EUR or GBP figure was converted at the install-day rate, and the 1-year FX mover never moved. |
| ✅ | **CSV date order decided per file.** US exports read month-first throughout, ambiguous files are flagged, and the assistant gets a warning back. | Rows of one file were read in two different date orders without any warning, and the dedupe then doubled them on re-import. |
| ✅ | **Transfer matching.** Opposite sides on two of your accounts within 3 days and ~2% after FX are filed as Transfers: automatically after imports, from a banner, or with the `match_transfers` tool. | An AED → EUR move counted as both spending and income, distorting the savings rate. |
| ✅ | **Honest history.** Investment accounts have no value before they were added, archived brokerages leave the monthly chart, and a loan refuses balances its schedule would ignore. | The 1y chart showed invented gains, and the dashboard counted closed accounts. |
| ✅ | **An error page in the app's own words.** | Any service error used to show the framework's default screen. |

Earlier in October: a daily net-worth chart with "what moved" (balance, market,
loan, job or FX), end-of-service gratuity for jobs, and the assistant running
on Claude Code.

## Done in the second round

| | What |
|---|---|
| ✅ | **Recurring payments**: salary, rent and subscriptions are expectations, matched to the real payment when a statement comes in (nothing created on a schedule, nothing counted twice). Late payments, price changes, detection from history, a 90-day cash forecast. Payments recorded by hand are adopted by the statement row instead of duplicated. |
| ✅ | **FX-aware gains**: a purchase date per holding; gains in your currency split into price and exchange rate. |
| ✅ | **Investment analytics**: daily index of today's positions, returns by period, volatility, drawdown, Sharpe, monthly heatmap, allocation by type/currency/region/account, concentration. |
| ✅ | **Backups and restore**: daily `VACUUM INTO`, 14 days + 8 weeks, restore from Settings (safety copy first, sessions kept), import of a JSON export into an empty wallet. |
| ✅ | **Loan events**: early repayments and renegotiated rates, the schedule replayed. |
| ✅ | **Account currency changes**: relabel or convert, asked explicitly. |
| ✅ | **Rules**: starts with / exactly, account, direction, amount range; rename the payee, add a tag. **Splits** and **tags** on transactions. |
| ✅ | **Tax by country**: UAE (no PIT, corporate 9% with SBR and QFZP, residency test), France (barème with parts, non-resident minimum rate, micro-foncier or réel with loan interest, social charges, IFI, IS), a rate for other countries, stays per country. |
| ✅ | **Companies** as net-worth assets: book / revenue × / profit × / manual valuation, their own accounts counted through them, revenue, spending and profit by month. |
| ✅ | **Goals** with what each month needs and the date at your pace. |
| ✅ | **Sharing** an account with a partner at their share, view or edit; an **audit trail** of every change. |
| ✅ | **Offline** reading (service worker), gentle motion, skip link and focus rings; reminders follow time-zone changes; sessions and old uploads purged; amounts read in your locale. |

## Still to do

1. **Bank presets for statements** (Emirates NBD, ADCB, Mashreq, BoursoBank, Revolut, Wise) and a PDF-to-rows prompt for UAE banks.
2. **EU bank sync with GoCardless Bank Account Data**: a transactions connector next to today's positions-only one.
3. **Trades and dividends** for investments, so returns can be money-weighted (today: positions only).
4. **Tax**: plafonnement du quotient familial, the average-rate option for non-residents, treaty credits, more countries.
5. **Shared transactions** between partners (today: shared balances, private transactions).

