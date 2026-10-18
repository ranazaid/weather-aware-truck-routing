import type { Place, PlanRequest } from "../api/types";
import { nextQuarterHour } from "./format";

/*
 * A trip in the URL, readable on purpose:
 *   ?o=32.7767,-96.797,Dallas&d=39.7392,-104.9903,Denver&t=2026-10-20T14:00:00.000Z&w=42000&i=25&h=1
 * Places typed as free text are kept as text (o=Dallas%2C%20TX) and geocoded by the server.
 */

function placeParam(p: Place | string): string {
  if (typeof p === "string") return p;
  return `${p.lat.toFixed(5)},${p.lon.toFixed(5)},${p.label}`;
}

function parsePlace(v: string | null): Place | string | null {
  if (!v) return null;
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(.*)$/.exec(v);
  if (!m) return v.trim().length >= 2 ? v.trim() : null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat, lon, label: m[3]!.trim() || `${lat}, ${lon}` };
}

export function encodeTrip(req: PlanRequest): string {
  const q = new URLSearchParams({
    o: placeParam(req.origin),
    d: placeParam(req.destination),
    t: req.departure,
    w: String(req.load_lb),
    i: String(req.interval_mi),
    h: req.hos ? "1" : "0",
  });
  if (req.scenario) {
    q.set("ww", String(req.scenario.wind_add_mph));
    q.set("px", String(req.scenario.precip_factor));
  }
  return q.toString();
}

/** The trip in a URL query, or null if it is missing or malformed. A past departure moves to now. */
export function decodeTrip(search: string, now = new Date()): { request: PlanRequest; movedDeparture: boolean } | null {
  const q = new URLSearchParams(search);
  const origin = parsePlace(q.get("o"));
  const destination = parsePlace(q.get("d"));
  const load = Number(q.get("w"));
  const interval = Number(q.get("i"));
  let departure = new Date(q.get("t") ?? "");
  if (!origin || !destination || !Number.isFinite(load) || load < 0 || load > 80_000) return null;
  if (![10, 25, 50].includes(interval) || Number.isNaN(departure.getTime())) return null;
  const movedDeparture = departure.getTime() < now.getTime() - 3600_000;
  if (movedDeparture) departure = nextQuarterHour(now);
  const wind = Number(q.get("ww") ?? 0);
  const precip = Number(q.get("px") ?? 1);
  const scenario =
    (wind > 0 && wind <= 40) || (precip > 1 && precip <= 5)
      ? { wind_add_mph: Math.min(40, Math.max(0, wind)), precip_factor: Math.min(5, Math.max(1, precip)) }
      : null;
  return {
    request: {
      origin,
      destination,
      departure: departure.toISOString(),
      load_lb: load,
      interval_mi: interval as 10 | 25 | 50,
      hos: q.get("h") !== "0",
      scenario,
    },
    movedDeparture,
  };
}
