import "server-only";
import { formatMoney, type MoneyFormat } from "@/lib/money";
import { getSettings } from "@/server/services/settings";

/** Money formatting for server components, using the user's base currency & locale. */
export function serverFormat(uid: string) {
  const s = getSettings(uid);
  return {
    ...s,
    /** Format cents in the base currency (or another currency via opts.currency). */
    money: (cents: number, opts: MoneyFormat = {}) => formatMoney(cents, { currency: s.currency, locale: s.locale, ...opts }),
  };
}
