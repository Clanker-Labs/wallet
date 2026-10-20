import { and, asc, eq, isNotNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, brokerConnections, holdings, type BrokerConnection } from "@/server/db/schema";
import { CONNECTORS, ConnectorError, getConnector, type BrokerSnapshot, type FetchLike } from "@/server/connectors";
import { decryptSecret, encryptSecret } from "@/server/secrets";
import { createAccount, getAccountRow, snapshotHoldingAccounts } from "./accounts";
import { refreshPrices, storePrices } from "./prices";
import { today } from "./settings";
import { listUsers } from "./users";

/**
 * Brokerage connections: credentials (encrypted) + the wallet account a
 * broker's positions are mirrored into. A sync REPLACES that account's synced
 * holdings with the broker's — new positions are added, sold ones removed, a
 * "Cash" line tracks uninvested cash — then records today's account value.
 * Holdings added by hand to the same account are left alone.
 */

/** Pseudo-instrument id of the cash line. */
const CASH_ID = "__cash__";
/** Below this, "Sync now" answers from the last sync instead of calling the broker again. */
const MIN_SYNC_INTERVAL_MS = 30_000;
/** Background syncs (worker hourly, web every 30 min) skip connections fresher than this. */
const STALE_AFTER_MS = 50 * 60_000;

export const createConnectionSchema = z.object({
  provider: z.string(),
  environment: z.string(),
  credentials: z.record(z.string(), z.string()),
  /** Existing account to sync into; omitted = create a brokerage account. */
  accountId: z.number().int().nullish(),
  accountName: z.string().trim().max(120).optional(),
});

export interface ConnectionView {
  id: number;
  provider: string;
  providerName: string;
  environment: string;
  environmentLabel: string;
  accountId: number;
  accountName: string;
  accountCurrency: string;
  externalAccountId: string | null;
  holdingsCount: number;
  lastSyncAt: Date | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  createdAt: Date | null;
}

export interface SyncResult {
  ok: boolean;
  connectionId: number;
  accountId: number;
  positions: number;
  added: number;
  removed: number;
  cash: number;
  currency: string;
  warnings: string[];
  error?: string;
  /** True when the call was answered from a sync a few seconds old. */
  skipped?: boolean;
}

function connectionRow(uid: string, id: number): BrokerConnection {
  const row = db()
    .select()
    .from(brokerConnections)
    .where(and(eq(brokerConnections.id, id), eq(brokerConnections.userId, uid)))
    .get();
  if (!row) throw new Error(`Connection ${id} not found`);
  return row;
}

export function listConnections(uid: string): ConnectionView[] {
  const rows = db()
    .select({ c: brokerConnections, accountName: accounts.name, accountCurrency: accounts.currency })
    .from(brokerConnections)
    .innerJoin(accounts, eq(accounts.id, brokerConnections.accountId))
    .where(eq(brokerConnections.userId, uid))
    .orderBy(asc(brokerConnections.id))
    .all();
  const counts = db()
    .$client.prepare(
      "SELECT connection_id AS id, COUNT(*) AS n FROM holdings WHERE user_id = ? AND connection_id IS NOT NULL AND external_id <> ? GROUP BY connection_id",
    )
    .all(uid, CASH_ID) as { id: number; n: number }[];
  const countById = new Map(counts.map((c) => [c.id, c.n]));
  return rows.map(({ c, accountName, accountCurrency }) => {
    const connector = CONNECTORS.find((x) => x.id === c.provider);
    return {
      id: c.id,
      provider: c.provider,
      providerName: connector?.name ?? c.provider,
      environment: c.environment,
      environmentLabel: connector?.environments.find((e) => e.id === c.environment)?.label ?? c.environment,
      accountId: c.accountId,
      accountName,
      accountCurrency,
      externalAccountId: c.externalAccountId,
      holdingsCount: countById.get(c.id) ?? 0,
      lastSyncAt: c.lastSyncAt,
      lastSyncOk: c.lastSyncOk,
      lastError: c.lastError,
      createdAt: c.createdAt,
    };
  });
}

/** Account id → connection, for marking synced accounts in the UI. */
export function connectionsByAccount(uid: string): Map<number, ConnectionView> {
  return new Map(listConnections(uid).map((c) => [c.accountId, c]));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Validate the credentials against the broker, then store them and run the
 * first sync. Nothing is saved when the broker rejects them.
 */
export async function createConnection(
  uid: string,
  raw: z.input<typeof createConnectionSchema>,
  opts: { fetchImpl?: FetchLike; fetchPrices?: boolean } = {},
): Promise<{ connection: ConnectionView; sync: SyncResult }> {
  const input = createConnectionSchema.parse(raw);
  const connector = getConnector(input.provider);
  if (!connector.environments.some((e) => e.id === input.environment)) {
    throw new Error(`Unknown ${connector.name} environment “${input.environment}”`);
  }
  const credentials: Record<string, string> = {};
  for (const f of connector.credentialFields) {
    const v = input.credentials[f.key]?.trim();
    if (!v) throw new Error(`${f.label} is required`);
    credentials[f.key] = v;
  }

  // The broker call doubles as validation: wrong key, wrong environment, missing scope.
  const snapshot = await connector.fetchSnapshot({ credentials, environment: input.environment, fetchImpl: opts.fetchImpl });

  if (snapshot.externalAccountId) {
    const dupe = db()
      .select({ id: brokerConnections.id })
      .from(brokerConnections)
      .where(
        and(
          eq(brokerConnections.userId, uid),
          eq(brokerConnections.provider, connector.id),
          eq(brokerConnections.environment, input.environment),
          eq(brokerConnections.externalAccountId, snapshot.externalAccountId),
        ),
      )
      .get();
    if (dupe) throw new Error(`This ${connector.name} account is already connected`);
  }

  let accountId: number;
  if (input.accountId) {
    const account = getAccountRow(uid, input.accountId);
    const taken = db().select({ id: brokerConnections.id }).from(brokerConnections).where(eq(brokerConnections.accountId, account.id)).get();
    if (taken) throw new Error(`“${account.name}” is already synced from another connection`);
    accountId = account.id;
  } else {
    const demo = input.environment === "demo";
    accountId = createAccount(uid, {
      name: input.accountName || `${connector.name}${demo ? " (practice)" : ""}`,
      institution: connector.name,
      type: "brokerage",
      currency: snapshot.currency,
      // Practice money is not money.
      includeInNetWorth: !demo,
    }).id;
  }

  const row = db()
    .insert(brokerConnections)
    .values({
      userId: uid,
      provider: connector.id,
      environment: input.environment,
      accountId,
      externalAccountId: snapshot.externalAccountId,
      credentials: encryptSecret(JSON.stringify(credentials)),
    })
    .returning()
    .get();

  const sync = await applySnapshot(uid, row, snapshot, opts);
  return { connection: listConnections(uid).find((c) => c.id === row.id)!, sync };
}

/** Replace the stored credentials (rotated key) after checking them against the broker. */
export async function updateConnectionCredentials(
  uid: string,
  id: number,
  credentialsIn: Record<string, string>,
  opts: { fetchImpl?: FetchLike; fetchPrices?: boolean } = {},
): Promise<SyncResult> {
  const row = connectionRow(uid, id);
  const connector = getConnector(row.provider);
  const credentials: Record<string, string> = {};
  for (const f of connector.credentialFields) {
    const v = credentialsIn[f.key]?.trim();
    if (!v) throw new Error(`${f.label} is required`);
    credentials[f.key] = v;
  }
  const snapshot = await connector.fetchSnapshot({ credentials, environment: row.environment, fetchImpl: opts.fetchImpl });
  if (row.externalAccountId && snapshot.externalAccountId && row.externalAccountId !== snapshot.externalAccountId) {
    throw new Error(`These credentials belong to a different ${connector.name} account`);
  }
  db()
    .update(brokerConnections)
    .set({ credentials: encryptSecret(JSON.stringify(credentials)), externalAccountId: snapshot.externalAccountId ?? row.externalAccountId })
    .where(eq(brokerConnections.id, row.id))
    .run();
  return applySnapshot(uid, connectionRow(uid, id), snapshot, opts);
}

/**
 * Pull the broker's current state into the account. Broker problems (bad key,
 * rate limit, outage) come back as `ok: false` and are kept on the connection;
 * only an unknown connection id throws.
 */
export async function syncConnection(
  uid: string,
  id: number,
  opts: { fetchImpl?: FetchLike; fetchPrices?: boolean; force?: boolean } = {},
): Promise<SyncResult> {
  const row = connectionRow(uid, id);
  const base: SyncResult = {
    ok: false,
    connectionId: row.id,
    accountId: row.accountId,
    positions: 0,
    added: 0,
    removed: 0,
    cash: 0,
    currency: "",
    warnings: [],
  };
  if (!opts.force && row.lastSyncOk && row.lastSyncAt && Date.now() - row.lastSyncAt.getTime() < MIN_SYNC_INTERVAL_MS) {
    return { ...base, ok: true, skipped: true, positions: listConnections(uid).find((c) => c.id === id)?.holdingsCount ?? 0 };
  }
  try {
    const connector = getConnector(row.provider);
    const credentials = JSON.parse(decryptSecret(row.credentials)) as Record<string, string>;
    const snapshot = await connector.fetchSnapshot({ credentials, environment: row.environment, fetchImpl: opts.fetchImpl });
    return await applySnapshot(uid, row, snapshot, opts);
  } catch (e) {
    const error = errorText(e);
    db()
      .update(brokerConnections)
      .set({ lastSyncAt: new Date(), lastSyncOk: false, lastError: error })
      .where(eq(brokerConnections.id, row.id))
      .run();
    if (!(e instanceof ConnectorError)) console.warn(`[connections] sync ${row.id}: ${error}`);
    return { ...base, error };
  }
}

/** Stop syncing. The account and its positions stay, as ordinary manual holdings; the credentials are deleted. */
export function deleteConnection(uid: string, id: number) {
  const row = connectionRow(uid, id);
  db().transaction((tx) => {
    // The cash line is meaningless once nothing updates it… but it is still the
    // last known cash, so it stays too, just unlinked like the positions.
    tx.update(holdings).set({ connectionId: null, externalId: null }).where(eq(holdings.connectionId, row.id)).run();
    tx.delete(brokerConnections).where(eq(brokerConnections.id, row.id)).run();
  });
}

async function applySnapshot(
  uid: string,
  row: BrokerConnection,
  snapshot: BrokerSnapshot,
  opts: { fetchImpl?: FetchLike; fetchPrices?: boolean },
): Promise<SyncResult> {
  const account = getAccountRow(uid, row.accountId);
  const date = today(uid);
  const lines = [
    ...snapshot.positions,
    {
      externalId: CASH_ID,
      symbol: null,
      name: "Cash",
      assetType: "cash" as const,
      quantity: Math.round(snapshot.cash * 100) / 100,
      currency: snapshot.currency,
      averagePrice: null,
      price: 1,
    },
  ];

  const existing = db()
    .select({ id: holdings.id, externalId: holdings.externalId, symbol: holdings.symbol })
    .from(holdings)
    .where(eq(holdings.connectionId, row.id))
    .all();
  const known = new Map(existing.map((h) => [h.externalId, h]));
  const newSymbols: string[] = [];
  let added = 0;

  db().transaction((tx) => {
    for (const p of lines) {
      const symbol = p.symbol ? p.symbol.toUpperCase() : null;
      const values = {
        userId: uid,
        accountId: account.id,
        connectionId: row.id,
        externalId: p.externalId,
        symbol,
        name: p.name,
        assetType: p.assetType,
        quantity: p.quantity,
        currency: p.currency,
        costBasis: p.averagePrice,
        // No market symbol (or the cash line): the broker's price is the only price.
        manualPrice: symbol ? null : p.price,
      };
      const prev = known.get(p.externalId);
      if (prev) tx.update(holdings).set(values).where(eq(holdings.id, prev.id)).run();
      else {
        tx.insert(holdings).values(values).run();
        if (p.externalId !== CASH_ID) added++;
      }
      if (symbol && !prev?.symbol) newSymbols.push(symbol);
    }
    tx.delete(holdings)
      .where(
        and(
          eq(holdings.connectionId, row.id),
          isNotNull(holdings.externalId),
          notInArray(
            holdings.externalId,
            lines.map((l) => l.externalId),
          ),
        ),
      )
      .run();
    tx.update(brokerConnections)
      .set({ lastSyncAt: new Date(), lastSyncOk: true, lastError: snapshot.warnings.length ? snapshot.warnings.join("; ") : null })
      .where(eq(brokerConnections.id, row.id))
      .run();
  });
  const removed = existing.filter((h) => !lines.some((l) => l.externalId === h.externalId)).length;


  // A year of history for positions seen for the first time, so charts have a past…
  if (newSymbols.length && opts.fetchPrices !== false) {
    await refreshPrices({ symbols: newSymbols, range: "1y", fetchImpl: opts.fetchImpl });
  }
  // …and the broker's own price for today, which wins over a delayed quote and
  // values positions whose symbol the market data source doesn't know.
  for (const p of snapshot.positions) {
    if (!p.symbol || p.price === null) continue;
    storePrices({ symbol: p.symbol, name: null, currency: p.currency, assetType: p.assetType, closes: [{ date, close: p.price }] });
  }
  snapshotHoldingAccounts(uid);

  return {
    ok: true,
    connectionId: row.id,
    accountId: account.id,
    positions: snapshot.positions.length,
    added,
    removed,
    cash: snapshot.cash,
    currency: snapshot.currency,
    warnings: snapshot.warnings,
  };
}

/**
 * Every user's connections that haven't synced recently. For the worker and the
 * web app's background refresh. Never throws.
 */
export async function syncStaleConnections(opts: { fetchImpl?: FetchLike; now?: number } = {}): Promise<{ log: string[] }> {
  const log: string[] = [];
  const now = opts.now ?? Date.now();
  for (const u of listUsers()) {
    let rows: BrokerConnection[] = [];
    try {
      rows = db().select().from(brokerConnections).where(eq(brokerConnections.userId, u.id)).all();
    } catch (e) {
      log.push(`⚠️ connections: ${errorText(e)}`);
      continue;
    }
    for (const row of rows) {
      if (row.lastSyncAt && now - row.lastSyncAt.getTime() < STALE_AFTER_MS) continue;
      const r = await syncConnection(u.id, row.id, { fetchImpl: opts.fetchImpl, force: true });
      if (r.ok) log.push(`🔄 ${row.provider} #${row.id} synced: ${r.positions} positions`);
      else log.push(`⚠️ ${row.provider} #${row.id}: ${r.error}`);
    }
  }
  return { log };
}
