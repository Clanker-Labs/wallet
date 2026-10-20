import { trading212 } from "./trading212";
import type { BrokerConnector } from "./types";

export * from "./types";

/** Every brokerage wallet can sync from. Add a connector here once; the UI, tools and sync pick it up. */
export const CONNECTORS: readonly BrokerConnector[] = [trading212];

export function getConnector(id: string): BrokerConnector {
  const c = CONNECTORS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown brokerage “${id}”`);
  return c;
}
