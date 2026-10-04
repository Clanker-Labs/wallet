"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { deleteHolding, listHoldings, updateHolding, upsertHolding, type HoldingInput } from "@/server/services/holdings";
import { refreshPrices, searchSymbols, type SymbolMatch } from "@/server/services/prices";
import { snapshotHoldingAccounts } from "@/server/services/accounts";
import { HOLDING_TYPES, type HoldingType } from "@/lib/domain";
import { requireUid } from "@/server/session";

export interface HoldingActionState {
  ok: boolean;
  message: string;
  /** Saved, but the market price couldn't be fetched. */
  warning?: string;
}

export type SymbolSearchResult = { ok: true; matches: SymbolMatch[] } | { ok: false; message: string };

export interface RefreshResult {
  /** Symbols of this user's holdings. */
  total: number;
  updated: string[];
  failed: { symbol: string; error: string }[];
}

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Decimal without the 2-decimal rounding of parseAmount: quantities (0.00012
 * BTC) and unit prices need full precision. Accepts "1 234,5678", "1,234.56",
 * "0,125". Undefined when empty, NaN when unreadable.
 */
function decimal(fd: FormData, key: string): number | undefined {
  let s = str(fd, key).replace(/[\s  '’_]/g, "");
  if (!s) return undefined;
  s = s.replace(/[^\d.,-]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "1,234" / "12,345,678" read as thousands; any other single comma is a decimal comma.
    s = /^-?[1-9]\d{0,2}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  }
  if (!/^-?\d*\.?\d+$/.test(s) && !/^-?\d+\.$/.test(s)) return Number.NaN;
  return Number(s);
}

function intId(v: FormDataEntryValue | null): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function errorMessage(e: unknown): string {
  if (e instanceof ZodError) {
    const i = e.issues[0];
    return i ? `${i.path.join(".") || "Input"}: ${i.message}` : "Invalid input";
  }
  return e instanceof Error ? e.message : "Something went wrong";
}

/** Holdings feed the dashboard, accounts and investments pages. */
function refresh() {
  revalidatePath("/", "layout");
}

/** "AAPL: HTTP 403" / "fetch failed" → why, in words. */
function friendlyPriceError(error: string): string {
  if (/HTTP 404|no price data/i.test(error)) return "the price service doesn't know this symbol";
  if (/HTTP \d+|fetch failed|ENOTFOUND|ECONN|timeout|aborted|network/i.test(error)) {
    return "the price service couldn't be reached (offline?)";
  }
  return error.replace(/^[^:]+:\s*/, "");
}

/** Warning after saving a position whose price couldn't be fetched. */
function noPriceWarning(symbol: string, error: string): string {
  const reason = friendlyPriceError(error);
  const advice = /know this symbol/.test(reason) ? "Check the symbol, or set a manual price." : "Refresh prices later, or set a manual price.";
  return `No price for ${symbol} yet: ${reason}. ${advice}`;
}

function parseHoldingForm(fd: FormData): { input?: HoldingInput; error?: string } {
  const accountId = intId(fd.get("accountId"));
  if (!accountId) return { error: "Pick the account that holds this position." };
  const symbol = str(fd, "symbol").toUpperCase();
  if (symbol && !/^[A-Z0-9.=^\-_:]{1,30}$/.test(symbol)) {
    return { error: "A symbol is letters, digits and . - = ^ only (AAPL, CW8.PA, BTC-USD, GC=F)." };
  }
  const name = str(fd, "name");
  if (!symbol && !name) return { error: "Give it a symbol or a name." };
  const type = str(fd, "assetType") as HoldingType;
  if (!(type in HOLDING_TYPES)) return { error: "Pick a type." };

  const quantity = decimal(fd, "quantity");
  if (quantity === undefined) return { error: "How many units do you hold?" };
  if (!Number.isFinite(quantity) || quantity < 0) return { error: "The quantity must be a positive number (e.g. 12 or 0.35)." };

  const totalCost = decimal(fd, "costTotal");
  if (totalCost !== undefined && (!Number.isFinite(totalCost) || totalCost < 0)) {
    return { error: "The total cost must be a positive amount, or empty." };
  }
  if (totalCost !== undefined && quantity === 0) return { error: "Set a quantity above 0 to record what you paid." };

  const manualPrice = decimal(fd, "manualPrice");
  if (manualPrice !== undefined && (!Number.isFinite(manualPrice) || manualPrice < 0)) {
    return { error: "The manual price must be a positive amount, or empty." };
  }
  if (!symbol && manualPrice === undefined) {
    return { error: "Without a symbol there's no market price — set a manual price per unit." };
  }

  return {
    input: {
      accountId,
      symbol: symbol || null,
      name: name || undefined,
      assetType: type,
      quantity,
      currency: str(fd, "currency") || undefined,
      // The form asks for the total paid; the service stores the average cost per unit.
      costBasis: totalCost === undefined ? null : totalCost / quantity,
      manualPrice: manualPrice ?? null,
    },
  };
}

/** Add (no id) or edit (id) a holding. */
export async function saveHoldingAction(fd: FormData): Promise<HoldingActionState> {
  const uid = await requireUid();
  const { input, error } = parseHoldingForm(fd);
  if (!input) return { ok: false, message: error! };
  const id = intId(fd.get("id"));
  const label = input.symbol || input.name || "Holding";
  try {
    if (id) {
      const current = listHoldings(uid).find((h) => h.id === id);
      if (!current) return { ok: false, message: "That holding no longer exists." };
      let warning: string | undefined;
      // A new symbol needs prices before the account is re-valued (updateHolding snapshots it).
      if (input.symbol && input.symbol !== current.symbol) {
        const r = await refreshPrices({ symbols: [input.symbol], range: "1y" });
        if (r.failed[0] && input.manualPrice === null) warning = noPriceWarning(input.symbol, r.failed[0].error);
      }
      updateHolding(uid, id, { ...input, name: input.name ?? input.symbol ?? current.name });
      refresh();
      return { ok: true, message: `Saved ${label}`, warning };
    }
    // Adding a symbol the account already holds updates it: an empty cost field keeps its cost basis.
    const r = await upsertHolding(uid, { ...input, costBasis: input.costBasis ?? undefined }, { fetchPrice: true });
    refresh();
    const warning = r.priceError && input.manualPrice === null && input.symbol ? noPriceWarning(input.symbol, r.priceError) : undefined;
    return {
      ok: true,
      message: r.updated ? `Updated your existing ${label} position` : `Added ${label}`,
      warning,
    };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

export async function deleteHoldingAction(fd: FormData): Promise<void> {
  const uid = await requireUid();
  const id = intId(fd.get("id"));
  if (!id) return;
  try {
    deleteHolding(uid, id);
  } catch {
    // Already gone (double click, other tab): nothing to do.
  }
  refresh();
}

/** Symbol lookup for the holding form. Never throws: the form falls back to free typing. */
export async function searchSymbolsAction(query: string): Promise<SymbolSearchResult> {
  await requireUid();
  const q = String(query ?? "").trim().slice(0, 60);
  if (q.length < 2) return { ok: true, matches: [] };
  try {
    return { ok: true, matches: (await searchSymbols(q)).slice(0, 8) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** "Refresh prices": fetch every held symbol now, then re-value holdings accounts for today. */
export async function refreshPricesAction(): Promise<RefreshResult> {
  const uid = await requireUid();
  const r = await refreshPrices({ maxAgeHours: 0 });
  snapshotHoldingAccounts(uid);
  refresh();
  // refreshPrices covers every user's symbols: only report this user's.
  const mine = new Set(listHoldings(uid).flatMap((h) => (h.symbol ? [h.symbol.toUpperCase()] : [])));
  return {
    total: mine.size,
    updated: r.updated.filter((s) => mine.has(s)),
    failed: r.failed.filter((f) => mine.has(f.symbol)).map((f) => ({ symbol: f.symbol, error: friendlyPriceError(f.error) })),
  };
}
