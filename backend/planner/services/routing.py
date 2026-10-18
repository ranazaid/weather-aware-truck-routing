"""Road routes from OSRM, with a guarantee of three meaningfully different options.

OSRM's `alternatives` often returns fewer than three routes (Dallas→Denver gives two). When it does,
we ask for routes forced through detour points placed to either side of the fastest route, drop
anything that mostly overlaps a route we already have or is unreasonably slow, and keep the best.
"""

from __future__ import annotations

import hashlib
import logging
import math
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from django.conf import settings
from django.core.cache import cache

from ..domain import geo
from .http import ProviderError, get_json

log = logging.getLogger(__name__)

WANTED = 3
MAX_OVERLAP = 0.80  # a new option must share less than 80% of its length with every existing one
MAX_SLOWDOWN = 1.5  # ...and be at most 50% slower than the fastest route
RELAXED_SLOWDOWN = 2.0
CACHE_S = 30 * 60
OSRM_ERRORS = {
    "NoRoute": ("No drivable road route connects these places.", 422, "no_route"),
    "NoSegment": ("One of the places is too far from any road.", 422, "no_road_nearby"),
    "TooBig": ("This trip is too large for the routing service.", 422, "too_big"),
}


@dataclass
class Route:
    coords: list[geo.Coord]
    seg_s: list[float]  # provider driving seconds per segment (len = len(coords) - 1)
    provider_duration_s: float
    roads: list[str] = field(default_factory=list)
    variant: str = "fastest"  # fastest | alternative | detour
    via: geo.Coord | None = None

    def __post_init__(self):
        self.cum_mi = geo.cumulative_miles(self.coords)
        self.seg_mi = [b - a for a, b in zip(self.cum_mi, self.cum_mi[1:], strict=False)]

    @property
    def distance_mi(self) -> float:
        return self.cum_mi[-1]


# ---------------------------------------------------------------------------- parsing


def _road_names(legs: list[dict], top: int = 2) -> list[str]:
    """Roads carrying the most distance, preferring route numbers ("I 25") over street names."""
    by_road: dict[str, float] = defaultdict(float)
    for leg in legs:
        for step in leg.get("steps", []):
            name = (step.get("ref") or "").split(";")[0].strip() or (step.get("name") or "").strip()
            if name:
                by_road[name] += step.get("distance", 0.0)
    return [name for name, _ in sorted(by_road.items(), key=lambda kv: -kv[1])[:top]]


def remove_loops(coords: list[geo.Coord], seg_s: list[float]) -> tuple[list[geo.Coord], list[float]]:
    """Cut out any stretch that returns to a vertex already visited (out-and-back spurs to a via point)."""
    out_c: list[geo.Coord] = []
    out_s: list[float] = []
    pos: dict[tuple[float, float], int] = {}
    for i, c in enumerate(coords):
        k = (round(c[0], 5), round(c[1], 5))
        if k in pos:
            j = pos[k]
            for dropped in out_c[j + 1 :]:
                pos.pop((round(dropped[0], 5), round(dropped[1], 5)), None)
            out_c, out_s = out_c[: j + 1], out_s[:j]
            continue
        if i > 0:
            out_s.append(seg_s[i - 1])
        pos[k] = len(out_c)
        out_c.append(c)
    return out_c, out_s


def parse_osrm_route(rt: dict, variant: str, via: geo.Coord | None = None) -> Route:
    coords = [(float(x), float(y)) for x, y in rt["geometry"]["coordinates"]]
    seg_s = [float(s) for leg in rt["legs"] for s in leg.get("annotation", {}).get("duration", [])]
    if len(seg_s) != len(coords) - 1:
        # Annotation missing or misaligned: spread the route duration over segments by length.
        cum = geo.cumulative_miles(coords)
        total = cum[-1] or 1.0
        seg_s = [(b - a) / total * float(rt["duration"]) for a, b in zip(cum, cum[1:], strict=False)]
    if variant == "detour":
        coords, seg_s = remove_loops(coords, seg_s)
    return Route(coords, seg_s, sum(seg_s), _road_names(rt.get("legs", [])), variant, via)


def _osrm(points: list[geo.Coord], alternatives: int | bool) -> list[dict]:
    path = ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat in points)
    url = f"{settings.PROVIDERS['OSRM_URL'].rstrip('/')}/route/v1/driving/{path}"
    params = {
        "alternatives": str(alternatives).lower(),
        "overview": "full",
        "geometries": "geojson",
        "annotations": "duration",
        "steps": "true",
    }
    data, _status = get_json("OSRM routing", url, params)
    code = data.get("code") if isinstance(data, dict) else None
    if code != "Ok":
        detail = data.get("message") if isinstance(data, dict) else None
        fallback = (
            f"The routing service could not build a route ({detail or code or 'unknown error'}).",
            502,
            "routing",
        )
        msg, status, err = OSRM_ERRORS.get(code, fallback)
        raise ProviderError("OSRM routing", msg, status=status, code=err)
    return data.get("routes", [])


# ---------------------------------------------------------------------------- distinctness


def _cells(points: list[geo.Coord], size: float = 0.02) -> set[tuple[int, int]]:
    return {(math.floor(lon / size), math.floor(lat / size)) for lon, lat in points}


def overlap(candidate: Route, existing: Route) -> float:
    """Share of `candidate`'s length that runs within roughly a mile of `existing`."""
    near = _cells(geo.sample_points(existing.coords, existing.cum_mi, 0.5))
    pts = geo.sample_points(candidate.coords, candidate.cum_mi, 1.0)
    hit = 0
    for lon, lat in pts:
        cx, cy = math.floor(lon / 0.02), math.floor(lat / 0.02)
        if any((cx + dx, cy + dy) in near for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
            hit += 1
    return hit / len(pts)


def _accept(candidate: Route, chosen: list[Route], slowdown: float) -> bool:
    fastest = chosen[0].provider_duration_s
    if candidate.provider_duration_s > fastest * slowdown:
        return False
    return all(overlap(candidate, r) < MAX_OVERLAP for r in chosen)


def detour_points(base: Route, origin: geo.Coord, destination: geo.Coord) -> list[geo.Coord]:
    """Via points either side of the fastest route, middle first, then the thirds."""
    straight = geo.haversine_mi(origin, destination)
    offset = min(90.0, max(8.0, 0.12 * straight))
    total = base.distance_mi
    out = []
    for frac, side in ((0.5, 1), (0.5, -1), (1 / 3, 1), (2 / 3, -1), (1 / 3, -1), (2 / 3, 1)):
        at = geo.point_at(base.coords, base.cum_mi, total * frac)
        a = geo.point_at(base.coords, base.cum_mi, total * max(0.0, frac - 0.05))
        b = geo.point_at(base.coords, base.cum_mi, total * min(1.0, frac + 0.05))
        out.append(geo.offset_perpendicular(a, b, at, side * offset))
    return out


def _fetch_detour(origin: geo.Coord, via: geo.Coord, destination: geo.Coord) -> Route | None:
    try:
        routes = _osrm([origin, via, destination], alternatives=False)
    except ProviderError as e:
        log.info("detour via %s rejected: %s", via, e)
        return None
    return parse_osrm_route(routes[0], "detour", via) if routes else None


# ---------------------------------------------------------------------------- public


def get_routes(origin: geo.Coord, destination: geo.Coord) -> tuple[list[Route], list[str]]:
    """Up to three distinct routes (fastest first) and any warnings for the user."""
    raw_key = f"{origin[0]:.4f},{origin[1]:.4f};{destination[0]:.4f},{destination[1]:.4f}"
    key = "route:" + hashlib.sha1(raw_key.encode()).hexdigest()
    hit = cache.get(key)
    if hit is not None:
        return hit

    raw = _osrm([origin, destination], alternatives=WANTED)
    if not raw:
        raise ProviderError("OSRM routing", "The routing service returned no routes.", status=422, code="no_route")
    chosen = [parse_osrm_route(raw[0], "fastest")]
    for rt in raw[1:]:
        r = parse_osrm_route(rt, "alternative")
        if len(chosen) < WANTED and _accept(r, chosen, MAX_SLOWDOWN):
            chosen.append(r)

    rejected: list[Route] = []
    if len(chosen) < WANTED:
        vias = detour_points(chosen[0], origin, destination)
        with ThreadPoolExecutor(max_workers=2) as pool:
            for i in range(0, len(vias), 2):
                batch = list(pool.map(lambda v: _fetch_detour(origin, v, destination), vias[i : i + 2]))
                for r in batch:
                    if r is None:
                        continue
                    if len(chosen) < WANTED and _accept(r, chosen, MAX_SLOWDOWN):
                        chosen.append(r)
                    else:
                        rejected.append(r)
                if len(chosen) >= WANTED:
                    break

    if len(chosen) < WANTED and rejected:
        # Relax: take the most distinct remaining options that are not absurdly slow.
        fastest = chosen[0].provider_duration_s
        pool_ = [r for r in rejected if r.provider_duration_s <= fastest * RELAXED_SLOWDOWN]
        pool_.sort(key=lambda r: max(overlap(r, c) for c in chosen))
        for r in pool_:
            if len(chosen) >= WANTED:
                break
            if max(overlap(r, c) for c in chosen) < 0.97:
                chosen.append(r)

    warnings = []
    if len(chosen) < WANTED:
        warnings.append(
            f"Only {len(chosen)} distinct road route{'s' if len(chosen) != 1 else ''} exist between these places."
        )
    result = (chosen, warnings)
    cache.set(key, result, CACHE_S)
    return result
