import type { Coord, PlannedRoute } from "../api/types";

export type TruckState = { coord: Coord; status: "driving" | "parked" | "arrived" | "not_departed" };

/** Where the truck is `elapsed` seconds after departure, from the server's 15-minute track. */
export function positionAt(track: PlannedRoute["track"], elapsed: number): Coord | null {
  if (track.length === 0) return null;
  const first = track[0]!;
  const last = track[track.length - 1]!;
  if (elapsed <= first[0]) return [first[1], first[2]];
  if (elapsed >= last[0]) return [last[1], last[2]];
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid]![0] <= elapsed) lo = mid;
    else hi = mid;
  }
  const a = track[lo]!;
  const b = track[hi]!;
  const t = b[0] === a[0] ? 0 : (elapsed - a[0]) / (b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function truckState(route: PlannedRoute, elapsed: number): TruckState | null {
  const coord = positionAt(route.track, elapsed);
  if (!coord) return null;
  if (elapsed < 0) return { coord, status: "not_departed" };
  if (elapsed >= route.duration_s) return { coord, status: "arrived" };
  const parked = route.stops.some((s) => elapsed >= s.start_elapsed_s && elapsed < s.start_elapsed_s + s.duration_s);
  return { coord, status: parked ? "parked" : "driving" };
}

/** The checkpoint the truck reaches closest to `elapsed` (for highlighting during playback). */
export function checkpointAt(route: PlannedRoute, elapsed: number): number {
  let best = 0;
  let bestDiff = Infinity;
  route.checkpoints.forEach((cp, i) => {
    const d = Math.abs(cp.elapsed_s - elapsed);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  });
  return best;
}

export function unionBbox(routes: PlannedRoute[]): [number, number, number, number] | null {
  if (routes.length === 0) return null;
  return routes.reduce<[number, number, number, number]>(
    (acc, r) => [
      Math.min(acc[0], r.bbox[0]),
      Math.min(acc[1], r.bbox[1]),
      Math.max(acc[2], r.bbox[2]),
      Math.max(acc[3], r.bbox[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}
