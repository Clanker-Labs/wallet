---
title: Data model
description: Every table and column in the SQLite database, with types, nullability, defaults, foreign keys and indexes. Generated from the drizzle schema at build time.
section: reference
order: 3
generate: data-model
---

The whole wallet is one SQLite file (`./data/wallet.db` by default, `WALLET_DB_PATH` to move it). The schema is defined with drizzle in [src/server/db/schema.ts](gh:src/server/db/schema.ts). Migrations in [drizzle/](gh:drizzle) are applied automatically when a process opens the database, with WAL journaling, foreign keys on and a 5 s busy timeout.

## Conventions

- **Money is integer cents** in the row's own currency (`balance_cents`, `amount_cents`), always next to a `currency` column (ISO 4217, or a crypto/metal code such as `BTC` or `XAU`). Conversion to the base currency happens at read time ([Multi-currency internals](multi-currency.html)).
- **Dates are ISO text**: `YYYY-MM-DD` for days, `YYYY-MM` for months. Timestamps (`created_at`, `expires_at`…) are integer milliseconds since the epoch.
- **Ownership:** every user-owned table has a `user_id` that references `users.id` with `ON DELETE CASCADE`, and every service query filters on it. Snapshots and agent messages are owned through their account or conversation. `prices` and `fx_rates` are shared market data.
- **Liabilities** store the amount owed as a positive balance; net worth subtracts them.
- **Imports are idempotent:** `transactions.import_hash` is unique per user, so re-importing the same statement inserts nothing.
- `agent_messages` is **append-only** (see [Agent internals](agent.html#append-only-transcripts)).

After editing the schema, run `npm run db:generate` and commit the generated files in `drizzle/`.
