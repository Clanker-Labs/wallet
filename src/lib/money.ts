/** Money helpers. Amounts are stored as integer cents everywhere. */

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export interface MoneyFormat {
  currency?: string;
  locale?: string;
  /** 1.2K / 3.4M style. */
  compact?: boolean;
  /** Always show + / − sign. */
  signed?: boolean;
  /** Drop decimals (rounded). */
  whole?: boolean;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

export function formatMoney(cents: number, opts: MoneyFormat = {}): string {
  const currency = opts.currency ?? "EUR";
  const locale = opts.locale ?? "en-IE";
  const key = `${locale}|${currency}|${opts.compact}|${opts.signed}|${opts.whole}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: opts.compact ? "compact" : "standard",
      maximumFractionDigits: opts.compact ? 1 : opts.whole ? 0 : 2,
      minimumFractionDigits: opts.compact || opts.whole ? 0 : 2,
      signDisplay: opts.signed ? "exceptZero" : "auto",
    });
    formatterCache.set(key, fmt);
  }
  return fmt.format(cents / 100);
}

export function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/**
 * Parse a human / bank-export amount: "1 234,56", "1,234.56", "-12.5", "€ 42",
 * "(15.00)" (accounting negative), "12,5k". Returns null when unparseable.
 */
export function parseAmount(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  let s = input.trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Unicode minus & trailing minus ("12,00-")
  s = s.replace(/−/g, "-");
  if (/-\s*$/.test(s)) {
    negative = !negative;
    s = s.replace(/-\s*$/, "");
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  let multiplier = 1;
  const suffix = s.match(/([kKmM])\s*$/);
  if (suffix) {
    multiplier = suffix[1].toLowerCase() === "k" ? 1_000 : 1_000_000;
    s = s.slice(0, suffix.index);
  }

  // Strip currency symbols, letters, spaces (incl. NBSP / narrow NBSP) and apostrophes.
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever comes last is the decimal separator.
    normalized =
      lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    const commaCount = (s.match(/,/g) ?? []).length;
    normalized =
      commaCount === 1 && decimals > 0 && decimals <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const dotCount = (s.match(/\./g) ?? []).length;
    normalized = dotCount > 1 ? s.replace(/\./g, "") : s;
  } else {
    normalized = s;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const result = value * multiplier * (negative ? -1 : 1);
  return Math.round(result * 100) / 100;
}
