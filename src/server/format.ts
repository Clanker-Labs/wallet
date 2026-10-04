import "server-only";
import { formatMoney, type MoneyFormat } from "@/lib/money";
import { getSettings } from "@/server/services/settings";

/** Money formatting for server components, using the user's currency & locale. */
export function serverFormat() {
  const s = getSettings();
  return {
    ...s,
    money: (cents: number, opts: MoneyFormat = {}) => formatMoney(cents, { currency: s.currency, locale: s.locale, ...opts }),
  };
}
