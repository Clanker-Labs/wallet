import { describe, expect, it } from "vitest";
import { nextOccurrence } from "@/lib/schedule";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("nextOccurrence", () => {
  it("clamps day 31 to short months", () => {
    const next = nextOccurrence({ frequency: "monthly", dayOfMonth: 31, timeOfDay: "09:00" }, new Date("2026-02-01T00:00:00Z"), "UTC");
    expect(iso(next)).toBe("2026-02-28T09:00:00.000Z");
  });

  it("moves to next month once today's slot passed", () => {
    const next = nextOccurrence({ frequency: "monthly", dayOfMonth: 4, timeOfDay: "09:00" }, new Date("2026-10-04T10:00:00Z"), "UTC");
    expect(iso(next)).toBe("2026-11-04T09:00:00.000Z");
  });

  it("respects the time zone (Paris summer time)", () => {
    const next = nextOccurrence({ frequency: "monthly", dayOfMonth: 1, timeOfDay: "09:00" }, new Date("2026-06-15T00:00:00Z"), "Europe/Paris");
    expect(iso(next)).toBe("2026-07-01T07:00:00.000Z");
  });

  it("handles weekly reminders", () => {
    // 2026-10-04 is a Sunday; next Monday 08:00
    const next = nextOccurrence({ frequency: "weekly", dayOfWeek: 1, timeOfDay: "08:00" }, new Date("2026-10-04T12:00:00Z"), "UTC");
    expect(iso(next)).toBe("2026-10-05T08:00:00.000Z");
  });

  it("anchors quarterly and yearly reminders", () => {
    const q = nextOccurrence({ frequency: "quarterly", dayOfMonth: 10, monthOfYear: 2, timeOfDay: "10:00" }, new Date("2026-03-01T00:00:00Z"), "UTC");
    expect(iso(q)).toBe("2026-05-10T10:00:00.000Z");
    const y = nextOccurrence({ frequency: "yearly", dayOfMonth: 15, monthOfYear: 5, timeOfDay: "10:00" }, new Date("2026-06-01T00:00:00Z"), "UTC");
    expect(iso(y)).toBe("2027-05-15T10:00:00.000Z");
  });

  it("returns null for a past one-off", () => {
    expect(nextOccurrence({ frequency: "once", date: "2026-01-01" }, new Date("2026-02-01T00:00:00Z"), "UTC")).toBeNull();
    expect(iso(nextOccurrence({ frequency: "once", date: "2026-03-01", timeOfDay: "07:30" }, new Date("2026-02-01T00:00:00Z"), "UTC"))).toBe(
      "2026-03-01T07:30:00.000Z",
    );
  });
});
