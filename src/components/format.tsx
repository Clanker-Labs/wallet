"use client";

import { createContext, useContext, useMemo } from "react";
import { formatMoney, type MoneyFormat } from "@/lib/money";

/** Currency/locale for client components, provided once by the root layout. */
export interface FormatSettings {
  currency: string;
  locale: string;
}

const FormatContext = createContext<FormatSettings>({ currency: "EUR", locale: "en-IE" });

export function FormatProvider({ value, children }: { value: FormatSettings; children: React.ReactNode }) {
  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

export function useFormat() {
  const s = useContext(FormatContext);
  return useMemo(
    () => ({
      ...s,
      /** Format integer cents. */
      money: (cents: number, opts: MoneyFormat = {}) => formatMoney(cents, { ...s, ...opts }),
      /** Format currency units (simulators work in units). */
      units: (amount: number, opts: MoneyFormat = {}) => formatMoney(Math.round(amount * 100), { ...s, ...opts }),
    }),
    [s],
  );
}
