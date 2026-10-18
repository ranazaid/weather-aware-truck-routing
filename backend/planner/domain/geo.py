"""Small, dependency-free geometry helpers. Coordinates are (lon, lat) like GeoJSON."""

from __future__ import annotations

import math
from bisect import bisect_left
from collections.abc import Sequence

EARTH_RADIUS_MI = 3958.7613
METERS_PER_MILE = 1609.344

Coord = tuple[float, float]  # (lon, lat)


def haversine_mi(a: Coord, b: Coord) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(h)))


def cumulative_miles(coords: Sequence[Coord]) -> list[float]:
    out = [0.0]
    for i in range(1, len(coords)):
        out.append(out[-1] + haversine_mi(coords[i - 1], coords[i]))
    return out


def lerp_coord(a: Coord, b: Coord, t: float) -> Coord:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def locate(cum: Sequence[float], target: float) -> tuple[int, float]:
    """Index i and fraction t so that target lies between cum[i] and cum[i+1]."""
    if target <= cum[0]:
        return 0, 0.0
    if target >= cum[-1]:
        return max(0, len(cum) - 2), 1.0
    j = bisect_left(cum, target)
    i = max(0, j - 1)
    span = cum[i + 1] - cum[i]
    return i, 0.0 if span <= 0 else (target - cum[i]) / span


def point_at(coords: Sequence[Coord], cum: Sequence[float], mile: float) -> Coord:
    if len(coords) == 1:
        return coords[0]
    i, t = locate(cum, mile)
    return lerp_coord(coords[i], coords[i + 1], t)


def value_at(cum: Sequence[float], values: Sequence[float], mile: float) -> float:
    """Linearly interpolate a per-vertex series (e.g. cumulative seconds) at a mileage."""
    if len(values) == 1:
        return values[0]
    i, t = locate(cum, mile)
    return values[i] + (values[i + 1] - values[i]) * t


def bearing_deg(a: Coord, b: Coord) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(origin: Coord, bearing: float, distance_mi: float) -> Coord:
    lon1, lat1 = map(math.radians, origin)
    brg = math.radians(bearing)
    d = distance_mi / EARTH_RADIUS_MI
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brg))
    lon2 = lon1 + math.atan2(
        math.sin(brg) * math.sin(d) * math.cos(lat1),
        math.cos(d) - math.sin(lat1) * math.sin(lat2),
    )
    return (((math.degrees(lon2) + 540) % 360) - 180, math.degrees(lat2))


def offset_perpendicular(a: Coord, b: Coord, at: Coord, distance_mi: float) -> Coord:
    """Point `distance_mi` to the right (positive) or left (negative) of the a→b direction at `at`."""
    brg = bearing_deg(a, b) + (90 if distance_mi >= 0 else -90)
    return destination(at, brg, abs(distance_mi))


def _perp_distance_deg(p: Coord, a: Coord, b: Coord) -> float:
    # Planar distance in degrees with longitude scaled by cos(lat): fine for simplification tolerance.
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    px, py, ax, ay, bx, by = p[0] * k, p[1], a[0] * k, a[1], b[0] * k, b[1]
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def thin_indices(coords: Sequence[Coord], min_step_deg: float = 0.0005) -> list[int]:
    """Indices of points at least `min_step_deg` (≈55 m) apart: a linear pre-pass before Douglas–Peucker."""
    if len(coords) <= 2:
        return list(range(len(coords)))
    keep = [0]
    lx, ly = coords[0]
    k = math.cos(math.radians(coords[0][1]))
    for i in range(1, len(coords) - 1):
        x, y = coords[i]
        if ((x - lx) * k) ** 2 + (y - ly) ** 2 >= min_step_deg * min_step_deg:
            keep.append(i)
            lx, ly = x, y
    keep.append(len(coords) - 1)
    return keep


def display_indices(coords: Sequence[Coord], tolerance_deg: float = 0.0008) -> list[int]:
    """Indices of the vertices to draw: thinned, then Douglas–Peucker. Fast on 30,000-point routes."""
    thin = thin_indices(coords)
    sub = [coords[i] for i in thin]
    return [thin[i] for i in simplify_indices(sub, tolerance_deg)]


def simplify(coords: Sequence[Coord], tolerance_deg: float = 0.0008) -> list[Coord]:
    """Iterative Douglas–Peucker (≈90 m tolerance by default). Keeps first and last points."""
    return [coords[i] for i in simplify_indices(coords, tolerance_deg)]


def simplify_indices(coords: Sequence[Coord], tolerance_deg: float = 0.0008) -> list[int]:
    n = len(coords)
    if n <= 2:
        return list(range(n))
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    tol2 = tolerance_deg * tolerance_deg
    while stack:
        s, e = stack.pop()
        # Same maths as _perp_distance_deg, inlined with the per-segment terms hoisted: this loop is hot.
        (ax, ay), (bx, by) = coords[s], coords[e]
        k = math.cos(math.radians((ay + by) / 2))
        ax, bx = ax * k, bx * k
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        best, idx = 0.0, -1
        for i in range(s + 1, e):
            px, py = coords[i][0] * k, coords[i][1]
            if len2 == 0:
                qx, qy = px - ax, py - ay
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / len2
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                qx, qy = px - (ax + t * dx), py - (ay + t * dy)
            d2 = qx * qx + qy * qy
            if d2 > best:
                best, idx = d2, i
        if idx != -1 and best > tol2:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return [i for i, k in enumerate(keep) if k]


def bbox(coords: Sequence[Coord]) -> tuple[float, float, float, float]:
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return (min(xs), min(ys), max(xs), max(ys))


def sample_points(coords: Sequence[Coord], cum: Sequence[float], step_mi: float) -> list[Coord]:
    """Points every `step_mi` along the line, always including both ends."""
    total = cum[-1]
    if total <= 0 or step_mi <= 0:
        return [coords[0]]
    n = max(1, math.ceil(total / step_mi))
    return [point_at(coords, cum, total * k / n) for k in range(n + 1)]


def slice_line(coords: Sequence[Coord], cum: Sequence[float], from_mi: float, to_mi: float) -> list[Coord]:
    """Sub-line between two mileages, with interpolated end points (at least two points)."""
    from_mi, to_mi = max(0.0, from_mi), min(cum[-1], to_mi)
    start = point_at(coords, cum, from_mi)
    end = point_at(coords, cum, to_mi)
    lo = bisect_left(cum, from_mi + 1e-9)
    hi = bisect_left(cum, to_mi - 1e-9)
    return [start, *coords[lo:hi], end]
