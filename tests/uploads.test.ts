import { describe, expect, it } from "vitest";
import { importRoute } from "@/lib/uploads";

describe("importRoute", () => {
  it("keeps CSV and plain text exports in the importer", () => {
    expect(importRoute("text/csv", "releve.csv")).toBe("importer");
    expect(importRoute("", "export.TSV")).toBe("importer");
    expect(importRoute("text/plain", "transactions.txt")).toBe("importer");
  });

  it("hands statements, OFX/QIF and screenshots to the assistant", () => {
    expect(importRoute("application/pdf", "statement.pdf")).toBe("assistant");
    expect(importRoute("image/png", "screenshot.png")).toBe("assistant");
    expect(importRoute("application/x-ofx", "bank.ofx")).toBe("assistant");
    expect(importRoute("", "bank.qfx")).toBe("assistant");
    expect(importRoute("text/plain", "money.qif")).toBe("assistant");
  });

  it("asks for a CSV when given a spreadsheet", () => {
    expect(importRoute("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx")).toBe("spreadsheet");
    expect(importRoute("", "budget.numbers")).toBe("spreadsheet");
  });

  it("rejects what nothing can read", () => {
    expect(importRoute("image/heic", "IMG_0001.HEIC")).toBe("unsupported");
    expect(importRoute("application/zip", "export.zip")).toBe("unsupported");
  });
});
