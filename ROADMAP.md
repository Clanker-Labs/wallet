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

## Next, in order

Sizes: S is up to half a day, M is 1–3 days, L is a week or more.

1. **Recurring and subscription detection (M).** Same payee at a regular interval with the amount within ±10%. Shows upcoming bills and the monthly total of subscriptions, and sends a Telegram alert when a price rises. Fixed costs are the first thing anyone asks about. *New `services/recurring.ts`, a tool, a section on Budgets.*
2. **FX-aware gains on investments (M).** Store each holding's cost in base currency, or its purchase date. A USD ETF bought at 3.67 AED/USD is reported with its currency effect separated out. *`holdings.ts`, schema.*
3. **Backups and restore (M).** A scheduled `VACUUM INTO` with retention, restore from Settings, and import of the JSON export. A finance app without a restore path isn't trustworthy. *New `services/backup.ts`, settings page, background loop.*
4. **Loan events (M).** Early repayments, rate renegotiations and payment holidays as a list of events, with the schedule recomputed per segment. This covers French mortgages (renégociation, remboursement anticipé). Now that recorded balances are refused, this is how a loan's real balance gets corrected. *`lib/finance/loan.ts`, `accounts.ts`, form.*
5. **Bank presets for statements (S–M).** Saved column mappings per bank (Emirates NBD, ADCB, Mashreq, BoursoBank, Revolut, Wise), recognised from the file's headers, plus a PDF-to-rows prompt for UAE banks, which have no open-banking API. *`csv-import.ts`, `agent/attachments.ts`.*
6. **EU bank sync with GoCardless Bank Account Data (L).** A free tier that covers BoursoBank, BNP, Revolut and Wise. It needs a transactions connector type next to today's positions-only one. *`connectors/`, `connections.ts`.*
7. **Account currency changes (S).** Changing an account's currency today re-reads all its history in the new currency. Ask whether it's a relabel or a conversion, and convert snapshots at their dates. *`accounts.ts`, form.*
8. **Rules beyond "contains" (M).** Conditions on amount and account, payee renaming, splits, and tags. *`categories.ts`, schema, transactions UI.*
9. **Cross-border tax view (M).** Per year: French-source income for a non-resident (20% minimum rate, 7.5% vs 17.2% social charges), an IFI estimate above €1.3M of French property, a UAE day counter for tax residency, and a yearly CSV/PDF. *New `services/tax.ts`, `app/reports`.*
10. **Goals and sinking funds (M).** Target, date and linked accounts, a monthly amount needed, and a projection from cash flow. *New service, dashboard card.*
11. **Household sharing and an audit log (L).** Accounts shared with a partner, each with an owner and percentage, and a `changes` table written by the services. Users are fully isolated today. *Schema, every write path.*
12. **PWA offline mode and an accessibility pass (M).** The manifest exists but there's no service worker. Do a keyboard and screen-reader audit of the charts and inline editors.

Small items to pick up along the way:
- Reschedule reminders when the time zone changes.
- Purge expired sessions and old uploads.
- Escape `%` and `_` in transaction search.
- `parseAmount("1.500")` should read 1500 when the locale says so.
- The month list on the transactions page should use the user's time zone.
- Telegram alert when an envelope goes over.
