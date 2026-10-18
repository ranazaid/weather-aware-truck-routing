"""Builds a trip plan: routes → truck ETAs → checkpoints → weather at ETA → risk → recommendation."""

from __future__ import annotations

import logging
import time
import uuid
from datetime import UTC, datetime

from django.conf import settings
from django.core.cache import cache

from ..domain import geo, hos
from ..domain.recommend import explain, summarize
from ..domain.risk import Level, assess, rules_table
from ..domain.sampling import place_checkpoints, truck_adjusted_durations
from . import corridor, routing, weather
from .http import ProviderError

log = logging.getLogger(__name__)

LABELS = "ABC"
PLAN_TTL_S = 2 * 3600
TRACK_STEP_S = 15 * 60
FORECAST_HORIZON_S = 15 * 24 * 3600  # Open-Meteo serves about 16 days ahead


def iso(ts: float) -> str:
    return datetime.fromtimestamp(round(ts), UTC).isoformat().replace("+00:00", "Z")


def _risk_segments(route: routing.Route, checkpoints: list[dict]) -> list[dict]:
    """Merge neighbouring checkpoints with the same level into coloured stretches of road."""
    out: list[dict] = []
    for cp in checkpoints:
        level = cp["risk"]["level"] if cp["risk"] else "unknown"
        if out and out[-1]["level"] == level:
            out[-1]["to_mi"] = cp["owned_to_mi"]
        else:
            out.append({"level": level, "from_mi": cp["owned_from_mi"], "to_mi": cp["owned_to_mi"]})
    for seg in out:
        line = geo.slice_line(route.coords, route.cum_mi, seg["from_mi"], seg["to_mi"])
        seg["coordinates"] = [[round(x, 5), round(y, 5)] for x, y in geo.simplify(line)]
        seg["from_mi"], seg["to_mi"] = round(seg["from_mi"], 1), round(seg["to_mi"], 1)
    return out


def _track(route: routing.Route, cum_drive: list[float], stops: list[hos.Stop], total_elapsed: float) -> list:
    """[elapsed_s, lon, lat] every 15 minutes, so the map can place the truck at any slider time."""
    out = []
    e = 0.0
    while True:
        drive = hos.drive_for(min(e, total_elapsed), stops)
        mile = geo.value_at(cum_drive, route.cum_mi, drive)
        lon, lat = geo.point_at(route.coords, route.cum_mi, mile)
        out.append([round(min(e, total_elapsed)), round(lon, 5), round(lat, 5)])
        if e >= total_elapsed:
            return out
        e += TRACK_STEP_S


def build_plan(
    origin: dict,
    destination: dict,
    departure: datetime,
    load_lb: float,
    interval_mi: int,
    hos_enabled: bool,
    scenario: weather.Scenario | None = None,
) -> dict:
    scenario = scenario or weather.Scenario()
    t_start = time.perf_counter()
    o, d = (origin["lon"], origin["lat"]), (destination["lon"], destination["lat"])
    routes, provider_warnings = routing.get_routes(o, d)
    warnings = list(provider_warnings)
    dep_ts = departure.timestamp()
    cap = settings.TRUCK_SPEED_CAP_MPH

    prepared = []
    for r in routes:
        cum_drive = truck_adjusted_durations(r.seg_mi, r.seg_s, cap)
        stops = hos.schedule(cum_drive[-1]) if hos_enabled else []
        cps = place_checkpoints(r.coords, r.cum_mi, cum_drive, interval_mi)
        prepared.append((r, cum_drive, stops, cps, hos.total_elapsed(cum_drive[-1], stops)))

    start, end = weather.window(dep_ts, dep_ts + max(p[4] for p in prepared))
    horizon = weather.hour_floor(time.time() + FORECAST_HORIZON_S)
    if end > horizon:
        end = horizon
        warnings.append("Part of the trip is beyond the 15-day forecast; those miles are shown as Unknown.")
    if start >= end:
        raise ProviderError("Planner", "departure is beyond the forecast range", status=400, code="out_of_range")
    series = weather.fetch([weather.cell_of(cp.coord) for p in prepared for cp in p[3]], start, end)

    out_routes, summaries = [], []
    for idx, (r, cum_drive, stops, cps, total_elapsed) in enumerate(prepared):
        label = LABELS[idx]
        checkpoints, owned = [], []
        for cp in cps:
            elapsed = hos.elapsed_for(cp.drive_s, stops)
            eta = dep_ts + elapsed
            s = series.get(weather.cell_of(cp.coord))
            wx = scenario.apply(weather.sample(s, eta)) if s else None
            a = assess(wx["wind_mph"], wx["rain_in_hr"], wx["snow_in_hr"], load_lb) if wx else None
            owned.append((cp.owned_mi, a.level if a else None))
            checkpoints.append(
                {
                    "index": cp.index,
                    "mile": round(cp.mile, 1),
                    "lon": round(cp.coord[0], 5),
                    "lat": round(cp.coord[1], 5),
                    "drive_s": round(cp.drive_s),
                    "elapsed_s": round(elapsed),
                    "eta": iso(eta),
                    "owned_from_mi": cp.owned_from_mi,
                    "owned_to_mi": cp.owned_to_mi,
                    "weather": wx,
                    "risk": a.as_dict() if a else None,
                }
            )
        summary = summarize(label, label, r.distance_mi, total_elapsed, owned)
        summaries.append(summary)
        stop_dicts = []
        for st in stops:
            mile = geo.value_at(cum_drive, r.cum_mi, st.at_drive_s)
            lon, lat = geo.point_at(r.coords, r.cum_mi, mile)
            stop_dicts.append(
                {
                    **st.as_dict(),
                    "mile": round(mile, 1),
                    "lon": round(lon, 5),
                    "lat": round(lat, 5),
                    "starts": iso(dep_ts + st.start_elapsed_s),
                    "ends": iso(dep_ts + st.start_elapsed_s + st.duration_s),
                }
            )
        out_routes.append(
            {
                "id": label,
                "label": label,
                "name": "via " + " · ".join(r.roads) if r.roads else f"Route {label}",
                "variant": r.variant,
                "distance_mi": round(r.distance_mi, 1),
                "drive_s": round(cum_drive[-1]),
                "duration_s": round(total_elapsed),
                "provider_duration_s": round(r.provider_duration_s),
                "arrival": iso(dep_ts + total_elapsed),
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[round(x, 5), round(y, 5)] for x, y in geo.simplify(r.coords)],
                },
                "bbox": [round(v, 4) for v in geo.bbox(r.coords)],
                "segments": [],  # filled below, once checkpoints exist
                "checkpoints": checkpoints,
                "stops": stop_dicts,
                "track": _track(r, cum_drive, stops, total_elapsed),
                "summary": summary.as_dict(),
            }
        )
        out_routes[-1]["segments"] = _risk_segments(r, checkpoints)

    if scenario.active:
        warnings.insert(0, f"What-if scenario: forecasts adjusted by {scenario.describe()}. Not real conditions.")
    if any(s.unknown_mi > 0 for s in summaries) and not any("forecast" in w for w in warnings):
        warnings.append("Some checkpoints had no forecast data; those miles are shown as Unknown.")
    if any(s.miles_by_level.get(Level.NO_TRAVEL, 0) > 0 for s in summaries):
        warnings.append("At least one route crosses No Travel conditions at the planned time.")

    plan_id = uuid.uuid4().hex
    cache.set(
        f"plan:{plan_id}",
        {
            "lines": [(r.coords, r.cum_mi) for r in routes],
            "departure_ts": dep_ts,
            "load_lb": load_lb,
            "window": (start, end),
            "scenario": scenario,
        },
        PLAN_TTL_S,
    )
    log.info("plan %s: %d routes in %.2fs", plan_id, len(routes), time.perf_counter() - t_start)
    return {
        "plan_id": plan_id,
        "generated_at": iso(time.time()),
        "request": {
            "origin": origin,
            "destination": destination,
            "departure": iso(dep_ts),
            "load_lb": load_lb,
            "interval_mi": interval_mi,
            "hos": hos_enabled,
            "truck_speed_cap_mph": cap,
            "scenario": scenario.as_dict(),
        },
        "forecast_window": {"start": iso(start), "end": iso(end)},
        "routes": out_routes,
        "recommendation": explain(summaries),
        "warnings": warnings,
        "rules": rules_table(),
    }


def build_heatmap(plan_id: str) -> dict | None:
    key = f"heatmap:{plan_id}"
    hit = cache.get(key)
    if hit is not None:
        return hit
    ctx = cache.get(f"plan:{plan_id}")
    if ctx is None:
        return None
    data = corridor.build(ctx["lines"], ctx["departure_ts"], ctx["load_lb"], ctx["window"], ctx.get("scenario"))
    cache.set(key, data, PLAN_TTL_S)
    return data
