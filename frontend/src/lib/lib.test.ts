import { describe, expect, it } from "vitest";
import { makePlan } from "../test/fixtures";
import { formatDuration, formatHours, fromLocalInput, nextQuarterHour, toLocalInput } from "./format";
import { metricLevel, weatherText } from "./risk";
import { checkpointAt, positionAt, truckState, unionBbox } from "./track";

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(47 * 60)).toBe("47m");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3h 05m");
    expect(formatDuration(26 * 3600 + 60)).toBe("1d 2h 01m");
    expect(formatHours(26 * 3600 + 60)).toBe("26h 01m");
  });

  it("round-trips datetime-local values", () => {
    const d = new Date(2026, 9, 20, 6, 30);
    expect(toLocalInput(d)).toBe("2026-10-20T06:30");
    expect(fromLocalInput("2026-10-20T06:30")?.getTime()).toBe(d.getTime());
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("not a date")).toBeNull();
  });

  it("rounds up to the next quarter hour", () => {
    const d = nextQuarterHour(new Date(2026, 9, 20, 6, 7, 30));
    expect([d.getHours(), d.getMinutes()]).toEqual([6, 15]);
    const e = nextQuarterHour(new Date(2026, 9, 20, 6, 59));
    expect([e.getHours(), e.getMinutes()]).toEqual([7, 0]);
  });
});

describe("metricLevel mirrors the backend thresholds", () => {
  it.each([
    [24.9, "low"],
    [25, "moderate"],
    [34.9, "moderate"],
    [35, "high"],
    [45, "severe"],
    [54.9, "severe"],
    [55, "no_travel"],
  ])("wind %s mph → %s", (v, lvl) => expect(metricLevel("wind", v)).toBe(lvl));

  it.each([
    [0.099, "low"],
    [0.1, "moderate"],
    [0.25, "high"],
    [0.5, "severe"],
    [1.0, "severe"],
    [1.0001, "no_travel"],
  ])("rain %s in/hr → %s", (v, lvl) => expect(metricLevel("rain", v)).toBe(lvl));

  it.each([
    [0.49, "low"],
    [0.5, "moderate"],
    [2.0, "severe"],
    [3.0, "severe"],
    [3.01, "no_travel"],
  ])("snow %s in/hr → %s", (v, lvl) => expect(metricLevel("snow", v)).toBe(lvl));

  it("risk score floors to its level", () => {
    expect(metricLevel("risk", 0.99)).toBe("low");
    expect(metricLevel("risk", 2.5)).toBe("high");
    expect(metricLevel("risk", 4)).toBe("no_travel");
  });

  it("describes WMO weather codes", () => {
    expect(weatherText(0)).toBe("Clear");
    expect(weatherText(75)).toBe("Snow");
    expect(weatherText(null)).toBe("—");
  });
});

describe("track", () => {
  const track: [number, number, number][] = [
    [0, 0, 0],
    [100, 10, 0],
    [200, 10, 10],
  ];

  it("interpolates and clamps", () => {
    expect(positionAt(track, 50)).toEqual([5, 0]);
    expect(positionAt(track, 150)).toEqual([10, 5]);
    expect(positionAt(track, -10)).toEqual([0, 0]);
    expect(positionAt(track, 999)).toEqual([10, 10]);
    expect(positionAt([], 5)).toBeNull();
  });

  it("knows when the truck is parked or has arrived", () => {
    const r = makePlan().routes[0]!;
    expect(truckState(r, 10)?.status).toBe("driving");
    expect(truckState(r, 40)?.status).toBe("parked"); // inside the 30-min break at 30 s
    expect(truckState(r, r.duration_s + 1)?.status).toBe("arrived");
  });

  it("finds the nearest checkpoint and union bbox", () => {
    const plan = makePlan();
    expect(checkpointAt(plan.routes[0]!, 1490)).toBe(1);
    expect(unionBbox(plan.routes)).toEqual([-100, 35, -98, 35]);
    expect(unionBbox([])).toBeNull();
  });
});
