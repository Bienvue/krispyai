import { describe, expect, test } from "bun:test";
import {
  availabilityAt,
  availabilityBlock,
  availabilityConfigError,
  formatInZone,
  nextOpening,
  type AvailabilityConfig,
} from "../src/availability";
import { buildSystemPrompt, HANDOFF_INSTRUCTION } from "../src/system-prompt";

// Mon-Fri 9-5 Denver, with Monday 12 October 2026 as a holiday.
const C: AvailabilityConfig = {
  timezone: "America/Denver",
  hours: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
  holidays: ["2026-10-12"],
};
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("availabilityAt, from the hours", () => {
  test("inside hours: online until 17:00", () => {
    const a = availabilityAt(C, null, at("2026-10-05T16:00:00Z")); // Mon 10:00 MDT
    expect(a).toMatchObject({ online: true, source: "hours", nextOnlineAt: null });
    expect(iso(a.changesAt)).toBe("2026-10-05T23:00:00.000Z");
  });
  test("09:00 is open, 08:59 is not", () => {
    expect(availabilityAt(C, null, at("2026-10-05T15:00:00Z")).online).toBe(true);
    const early = availabilityAt(C, null, at("2026-10-05T14:59:00Z"));
    expect(early.online).toBe(false);
    expect(iso(early.nextOnlineAt)).toBe("2026-10-05T15:00:00.000Z");
  });
  test("17:00 is closed (end is exclusive); next is Tuesday 09:00", () => {
    const a = availabilityAt(C, null, at("2026-10-05T23:00:00Z"));
    expect(a.online).toBe(false);
    expect(iso(a.nextOnlineAt)).toBe("2026-10-06T15:00:00.000Z");
  });
  test("a weekend, then a Monday holiday: next is Tuesday", () => {
    const a = availabilityAt(C, null, at("2026-10-10T18:00:00Z")); // Sat
    expect(a.online).toBe(false);
    expect(iso(a.nextOnlineAt)).toBe("2026-10-13T15:00:00.000Z");
  });
  test("closed all day on a holiday", () => {
    expect(availabilityAt(C, null, at("2026-10-12T16:00:00Z")).online).toBe(false);
  });
  test("fall back: Monday after the November change opens at 09:00 MST", () => {
    const a = availabilityAt(C, null, at("2026-10-30T23:30:00Z")); // Fri 17:30 MDT
    expect(iso(a.nextOnlineAt)).toBe("2026-11-02T16:00:00.000Z");
  });
  test("spring forward: Monday after the March change opens at 09:00 MDT", () => {
    const a = availabilityAt(C, null, at("2026-03-07T00:30:00Z")); // Fri 17:30 MST
    expect(iso(a.nextOnlineAt)).toBe("2026-03-09T15:00:00.000Z");
  });
});

describe("availabilityAt, with the toggle", () => {
  test("on outside hours wins until it expires", () => {
    const until = at("2026-10-10T22:00:00Z");
    const a = availabilityAt(C, { online: true, until }, at("2026-10-10T18:00:00Z"));
    expect(a).toEqual({ online: true, source: "toggle", nextOnlineAt: null, changesAt: until });
  });
  test("off inside hours: offline, back at the toggle's end", () => {
    const until = at("2026-10-06T15:00:00Z");
    const a = availabilityAt(C, { online: false, until }, at("2026-10-05T16:00:00Z"));
    expect(a).toEqual({ online: false, source: "toggle", nextOnlineAt: until, changesAt: until });
  });
  test("an expired toggle is ignored", () => {
    const a = availabilityAt(
      C,
      { online: true, until: at("2026-10-10T17:00:00Z") },
      at("2026-10-10T18:00:00Z"),
    );
    expect(a.source).toBe("hours");
    expect(a.online).toBe(false);
  });
});

describe("nextOpening", () => {
  test("during hours, the next opening is tomorrow's", () => {
    expect(iso(nextOpening(C, at("2026-10-05T16:00:00Z")))).toBe("2026-10-06T15:00:00.000Z");
  });
  test("null when nothing opens within 14 days", () => {
    expect(nextOpening({ timezone: "America/Denver", hours: [] }, Date.now())).toBeNull();
  });
});

describe("availabilityConfigError", () => {
  test("accepts a good config", () => {
    expect(availabilityConfigError(C)).toBeNull();
  });
  test("refuses a bad timezone, reversed hours, bad days and bad dates", () => {
    const bad = [
      null,
      [],
      { ...C, timezone: "Mars/Olympus" },
      { ...C, timezone: 7 },
      { ...C, hours: "9-5" },
      { ...C, hours: [{ days: [1], start: "17:00", end: "09:00" }] },
      { ...C, hours: [{ days: [7], start: "09:00", end: "17:00" }] },
      { ...C, hours: [{ days: [], start: "09:00", end: "17:00" }] },
      { ...C, hours: [{ days: [1], start: "9:00", end: "17:00" }] },
      { ...C, holidays: ["12/10/2026"] },
    ];
    for (const v of bad) expect(availabilityConfigError(v)).toBe("invalid_availability");
  });
});

describe("formatInZone", () => {
  test("says the day, time and zone in the configured timezone", () => {
    expect(formatInZone(at("2026-10-05T15:00:00Z"), "America/Denver")).toBe(
      "Monday, 9:00 AM Mountain Time",
    );
    expect(formatInZone(at("2026-10-05T21:40:00Z"), "America/Denver", false)).toBe(
      "3:40 PM Mountain Time",
    );
  });
});

describe("availabilityBlock", () => {
  test("empty without config", () => {
    expect(availabilityBlock(undefined, null, Date.now())).toBe("");
  });
  test("online: reply here, no email form", () => {
    const b = availabilityBlock(C, null, at("2026-10-05T16:00:00Z"));
    expect(b).toContain("A teammate is online now.");
    expect(b).toContain("Don't offer email or contact forms.");
  });
  test("offline: says when, offers the form", () => {
    const b = availabilityBlock(C, null, at("2026-10-10T18:00:00Z"));
    expect(b).toContain("No teammate is online right now.");
    expect(b).toContain("Tuesday, 9:00 AM Mountain Time");
    expect(b).toContain("offer the email form if one is configured");
  });
  test("goes into the prompt before the handoff rules", () => {
    const b = availabilityBlock(C, null, at("2026-10-05T16:00:00Z"));
    const prompt = buildSystemPrompt("Base.", undefined, undefined, undefined, b);
    expect(prompt).toContain(b);
    expect(prompt.indexOf(b)).toBeLessThan(prompt.indexOf(HANDOFF_INSTRUCTION));
    expect(buildSystemPrompt("Base.")).not.toContain("teammate is online");
  });
});
