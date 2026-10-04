---
title: Transactions & CSV import
nav: Transactions
description: Import any bank's CSV export with a column-mapping wizard, re-import safely without duplicates, and categorize with one-click rules. No bank sync required.
blurb: CSV import wizard, duplicate-safe, one-click rules.
section: features
order: 6
video: transactions
---

wallet doesn't connect to your bank. You bring transactions in from the files your bank already gives you: a **CSV export** through the import wizard, or **any statement** (CSV, PDF, screenshot) dropped on the [assistant](assistant.html).

## The transactions list

`/transactions` lists transactions newest first, with the amount in its own currency and, for foreign ones, in your base currency. Filter by date range, account, category (or *Uncategorized*) and a description search; totals in and out follow the filters. From a row you can change the category, turn it into a rule, or delete it. A quick-add form records a single expense or income.

Amounts are **signed**: negative is money out, positive is money in.

## Importing a CSV

**Transactions → Import** is a three-step wizard:

1. **Pick the file.** It's parsed in the browser for the preview. The delimiter (comma, semicolon, tab) is detected, and account-summary lines some banks put above the header are skipped. Files that aren't valid UTF-8 are read as Windows-1252, which is what most bank exports with accents or `€` use.
2. **Map and check.** Choose the date and description columns and either **one signed amount** column or separate **debit / credit** columns. The guesses cover English and French headers (`Date`, `Libellé`, `Montant`, `Débit`, `Crédit`, `Amount`, `Payee`…). Set the date format (auto, day-month-year, month-day-year, year-month-day), **invert signs** for banks that export spending as positive numbers, and pick the account and currency the rows belong to (the account's currency by default). A live preview shows the parsed rows.
3. **Import.** The file is sent gzipped when the browser can (5 MB limit after decompression) and the server **parses it again**: the browser preview is never trusted. The result tells you how many rows were inserted, skipped as duplicates, auto-categorized, skipped as unreadable, and still uncategorized.

Amounts understand `1,234.56`, `1 234,56`, currency symbols, trailing minus signs (`12,00-`) and parentheses for negatives. Rows with an unreadable date or no amount are skipped.

### Re-imports are safe

Each imported row gets a hash of *account, date, amount in cents, lowercased description and occurrence number* (two identical coffees on the same day are two rows). The hash is unique per user, so importing the same file twice, or overlapping months, inserts only what's new.

## Rules: categorize once

A **rule** says "description contains *pattern* → category". Patterns are lowercase; when several rules match, the **longest pattern wins** ("amazon prime" beats "amazon").

- Rules run on every import (wizard, assistant, API) and on single transactions the assistant adds without a category.
- From any transaction, **create a rule** in one click: wallet suggests a pattern from the description (merchant words, without dates and card numbers) and applies it to every other uncategorized transaction that matches.
- **Settings → Categorization rules** lists them and re-applies all rules to uncategorized transactions on demand.

The assistant does the same with `categorize_transactions` and its `rememberPattern` option, which is how it cleans up after an import.

## Other ways in

| From | How |
|---|---|
| Assistant | Drop CSV, PDF or screenshots anywhere in the app. CSVs go through `import_csv_upload` (server-side, any size); PDFs and images are read by the model and imported with `import_transactions`. |
| Telegram | `/spent 12.50 groceries — lunch`, `/earned 2500 salary`, or send the statement file to the bot. |
| API | `POST /api/tools/import_transactions` or `add_transaction` ([Agent tools](tools.html)). |

Bulk imports from every route go through the same service (`importTransactions`), with the same duplicate check and rules.
