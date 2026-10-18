import { describe, expect, it } from "vitest";
import type { PlanRequest } from "../api/types";
import { decodeTrip, encodeTrip } from "./share";

const req: PlanRequest = {
  origin: { label: "Dallas, Texas, US", lat: 32.7767, lon: -96.797 },
  destination: "Denver, CO",
  departure: "2026-10-20T14:00:00.000Z",
  load_lb: 42000,
  interval_mi: 10,
  hos: false,
  scenario: { wind_add_mph: 15, precip_factor: 2 },
};

describe("shareable trip links", () => {
  it("round-trips a request", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const back = decodeTrip(`?${encodeTrip(req)}`, now)!;
    expect(back.movedDeparture).toBe(false);
    expect(back.request).toEqual(req);
  });

  it("moves a departure that has passed to now", () => {
    const back = decodeTrip(`?${encodeTrip(req)}`, new Date("2026-10-25T12:07:00Z"))!;
    expect(back.movedDeparture).toBe(true);
    expect(new Date(back.request.departure).getTime()).toBeGreaterThan(Date.parse("2026-10-25T12:07:00Z"));
  });

  it("rejects missing or broken links", () => {
    expect(decodeTrip("")).toBeNull();
    expect(decodeTrip("?o=Dallas&d=Denver&t=nope&w=1&i=25")).toBeNull();
    expect(decodeTrip("?o=Dallas&d=Denver&t=2026-10-20T14:00:00Z&w=999999&i=25")).toBeNull();
    expect(decodeTrip("?o=Dallas&d=Denver&t=2026-10-20T14:00:00Z&w=1000&i=15")).toBeNull();
    expect(decodeTrip("?o=95,0,Bad&d=Denver&t=2026-10-20T14:00:00Z&w=1000&i=25")).toBeNull();
  });

  it("ignores out-of-range what-if values", () => {
    const back = decodeTrip("?o=Dallas&d=Denver&t=2099-01-01T00:00:00Z&w=1000&i=25&ww=0&px=1")!;
    expect(back.request.scenario).toBeNull();
  });
});
