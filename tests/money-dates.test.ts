import { describe, expect, it } from "vitest";
import { formatMoney, parseAmount, toCents } from "@/lib/money";
import { addMonths, monthRange, monthsBetween, parseDate } from "@/lib/dates";

describe("parseAmount", () => {
  it.each([
    ["1234.56", 1234.56],
    ["1 234,56", 1234.56],
    ["1 234,56 €", 1234.56],
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["-12,5", -12.5],
    ["−42", -42],
    ["(15.00)", -15],
    ["12,00-", -12],
    ["12.5k", 12500],
    ["€ 3k", 3000],
    ["1,234", 1234],
    ["+7", 7],
  ])("%s → %d", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it("rejects garbage", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe("money formatting", () => {
  it("formats cents", () => {
    expect(formatMoney(123456, { currency: "EUR", locale: "en-IE" })).toBe("€1,234.56");
    expect(formatMoney(-50, { currency: "EUR", locale: "en-IE", signed: true })).toBe("-€0.50");
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
});

describe("dates", () => {
  it("parses bank date formats", () => {
    expect(parseDate("2026-03-05")).toBe("2026-03-05");
    expect(parseDate("05/03/2026")).toBe("2026-03-05");
    expect(parseDate("05.03.26")).toBe("2026-03-05");
    expect(parseDate("03/25/2026")).toBe("2026-03-25");
    expect(parseDate("03/05/2026", "mdy")).toBe("2026-03-05");
    expect(parseDate("31/02/2026")).toBeNull();
  });

  it("does month arithmetic", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthRange("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthsBetween("2026-01-05", "2026-03-04")).toBe(1);
    expect(monthsBetween("2026-01-05", "2026-03-05")).toBe(2);
  });
});

describe("CSV date order, decided per column", () => {
  it("reads a US file month-first throughout, even rows that look day-first", async () => {
    const { applyMapping, detectDateFormat, parseCsv, guessMapping } = await import("@/lib/csv-import");
    const parsed = parseCsv("Date,Description,Amount\n01/05/2026,Coffee,-3\n01/13/2026,Lunch,-12\n");
    const r = applyMapping(parsed.rows, guessMapping(parsed.headers));
    expect(r.ok.map((x) => x.date)).toEqual(["2026-01-05", "2026-01-13"]);
    expect(r.dateFormat).toMatchObject({ format: "mdy", ambiguous: false, detected: true });
    expect(detectDateFormat(["31/01/2026", "01/02/2026"])).toEqual({ format: "dmy", ambiguous: false, mixed: false });
    expect(detectDateFormat(["2026-01-31"])).toEqual({ format: "ymd", ambiguous: false, mixed: false });
  });

  it("flags a file it cannot decide, and one that contradicts itself", async () => {
    const { detectDateFormat } = await import("@/lib/csv-import");
    expect(detectDateFormat(["03/04/2026", "05/06/2026"])).toEqual({ format: "dmy", ambiguous: true, mixed: false });
    expect(detectDateFormat(["13/01/2026", "01/13/2026"]).mixed).toBe(true);
  });
});
