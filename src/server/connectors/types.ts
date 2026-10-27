import type { HoldingType } from "@/lib/domain";

/**
 * A brokerage connector: turns credentials into a snapshot of one broker
 * account (cash + positions). Connectors are READ-ONLY by contract — they never
 * call an endpoint that places, changes or cancels anything — so the worst a
 * leaked or buggy connection can do is report a wrong number.
 */

export type FetchLike = typeof fetch;

export interface CredentialField {
  key: string;
  label: string;
  /** Shown as a password input and never sent back to the browser. */
  secret: boolean;
  placeholder?: string;
}

export interface BrokerPosition {
  /** The broker's id for the instrument (unique within the account). */
  externalId: string;
  /** Yahoo Finance symbol when one could be derived, for price history. */
  symbol: string | null;
  name: string;
  assetType: HoldingType;
  quantity: number;
  /** Currency the prices below are quoted in (major unit: GBP, not pence). */
  currency: string;
  /** Average cost per unit. */
  averagePrice: number | null;
  /** Latest price per unit, as the broker values it. */
  price: number | null;
}

export interface BrokerSnapshot {
  /** The broker's id for the account, when it has one. */
  externalAccountId: string | null;
  /** Currency the account (and `cash`) is denominated in. */
  currency: string;
  /** Uninvested cash, in `currency`. */
  cash: number;
  positions: BrokerPosition[];
  /** Things the user should know but that did not fail the sync. */
  warnings: string[];
}

export type BrokerActivityKind = "trade" | "dividend" | "deposit" | "withdrawal" | "interest" | "fee" | "other";

/** One past event at the broker: a fill, a dividend, a deposit… */
export interface BrokerActivity {
  kind: BrokerActivityKind;
  /** The broker's id for the event (fill id, dividend or transaction reference). */
  externalId: string;
  /** ISO timestamp. */
  at: string;
  ticker: string | null;
  symbol: string | null;
  name: string | null;
  /** Trades only: units, negative for a sale. */
  quantity: number | null;
  /** Trades only: price per unit in `priceCurrency` (major unit). */
  price: number | null;
  priceCurrency: string | null;
  /** Signed effect on the account's cash, in `currency` (a buy is negative). */
  cash: number;
  currency: string;
  /** Realised profit or loss of a sale, in `currency`. */
  realized: number | null;
}

export interface BrokerHistory {
  activities: BrokerActivity[];
  /** True when paging stopped early (rate limit, error): the rest comes next time. */
  incomplete: boolean;
  warnings: string[];
}

export interface FetchHistoryInput {
  credentials: Record<string, string>;
  environment: string;
  fetchImpl?: FetchLike;
  /** Already stored? Paging an endpoint stops at the first page made only of known events. */
  isKnown?: (kind: BrokerActivityKind, externalId: string) => boolean;
  /** Pause between two requests to the same endpoint (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface BrokerConnector {
  id: string;
  name: string;
  /** One line for the connect form. */
  description: string;
  /** Where the user creates credentials, and which permissions to grant. */
  setupHint: string;
  docsUrl: string;
  environments: { id: string; label: string }[];
  credentialFields: CredentialField[];
  fetchSnapshot(input: {
    credentials: Record<string, string>;
    environment: string;
    fetchImpl?: FetchLike;
  }): Promise<BrokerSnapshot>;
  /** Past trades, dividends and cash movements, newest first. Optional: not every broker exposes them. */
  fetchHistory?(input: FetchHistoryInput): Promise<BrokerHistory>;
}

/** A failure worth showing to the user as-is (bad key, missing scope, rate limit). */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
