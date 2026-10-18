"""Builds a trip plan: routes → truck ETAs → checkpoints → weather at ETA → risk → recommendation."""

from __future__ import annotations

import logging
import time
import uuid
from datetime import UTC, datetime

from django.conf import settings
from django.core.cache import cache

from ..domain import geo, hos
from ..domain.recommend import departure_advice, explain, rank, summarize
from ..domain.risk import Level, assess, rules_table
from ..domain.sampling import place_checkpoints, truck_adjusted_durations
from . import corridor, routing, weather
from .http import ProviderError

log = logging.getLogger(__name__)

LABELS = "ABC"
PLAN_TTL_S = 2 * 3600
TRACK_STEP_S = 15 * 60
FORECAST_HORIZON_S = 15 * 24 * 3600  # Open-Meteo serves about 16 days ahead
ADVICE_OFFSETS_H = (3, 6, 12, 24)  # later departures compared for "best time to leave"
MAX_PLAN_CELLS = 250  # forecast locations per plan; with the heatmap's 200 this stays under 600 a minute


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


def _levels_at(cps, stops, departure_ts, series, res, scenario, load_lb) -> list[tuple[float, Level | None]]:
    """(owned miles, level) for each checkpoint if the truck leaves at `departure_ts`."""
    out = []
    for cp in cps:
        s = series.get(weather.cell_of(cp.coord, res))
        wx = scenario.apply(weather.sample(s, departure_ts + hos.elapsed_for(cp.drive_s, stops))) if s else None
        out.append(
            (cp.owned_mi, assess(wx["wind_mph"], wx["rain_in_hr"], wx["snow_in_hr"], load_lb).level if wx else None)
        )
    return out


def _departure_advice(prepared, dep_ts, series, res, scenario, load_lb, summaries) -> dict:
    """Re-score every route for later departures, using the forecasts already downloaded."""
    later = []
    for offset in ADVICE_OFFSETS_H:
        t0 = dep_ts + offset * 3600
        scored = [
            summarize(
                LABELS[i], LABELS[i], r.distance_mi, total, _levels_at(cps, stops, t0, series, res, scenario, load_lb)
            )
            for i, (r, _cum, stops, cps, total) in enumerate(prepared)
        ]
        if any(s.unknown_mi > 0 for s in scored):
            continue  # beyond the forecast: unknown miles would look falsely safe
        later.append((offset, rank(scored)[0]))
    return departure_advice(rank(summaries)[0], later)


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

    last_eta = dep_ts + max(p[4] for p in prepared)
    # The window also covers the later departures checked for advice. Open-Meteo charges per location,
    # not per hour, so the extra day of forecast costs no extra calls.
    start, end = weather.window(dep_ts, last_eta + max(ADVICE_OFFSETS_H) * 3600)
    horizon = weather.hour_floor(time.time() + FORECAST_HORIZON_S)
    if end > horizon:
        end = horizon
        if weather.needed_end(dep_ts, last_eta) > horizon:
            warnings.append("Part of the trip is beyond the 15-day forecast; those miles are shown as Unknown.")
    if start >= end:
        raise ProviderError("Planner", "Departure is beyond the forecast range.", status=400, code="out_of_range")
    points = [cp.coord for p in prepared for cp in p[3]]
    # The grid depends on the roads, not the chosen interval: sized for a checkpoint every 10 miles, so
    # switching between 10, 25 and 50 reuses the same cached forecasts.
    road = [pt for r in routes for pt in geo.sample_points(r.coords, r.cum_mi, 10.0)]
    res = weather.resolution_for(road, MAX_PLAN_CELLS)
    if res != weather.CELL_DEG:
        log.info("long trip: weather grid %.2f° to stay within %d locations", res, MAX_PLAN_CELLS)
    series = weather.fetch([weather.cell_of(c, res) for c in points], start, end)

    out_routes, summaries = [], []
    for idx, (r, cum_drive, stops, cps, total_elapsed) in enumerate(prepared):
        label = LABELS[idx]
        checkpoints, owned = [], []
        for cp in cps:
            elapsed = hos.elapsed_for(cp.drive_s, stops)
            eta = dep_ts + elapsed
            s = series.get(weather.cell_of(cp.coord, res))
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

    advice = _departure_advice(prepared, dep_ts, series, res, scenario, load_lb, summaries)

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
            # simplified lines are plenty for placing heatmap cells and keep the cache small
            "lines": [(line, geo.cumulative_miles(line)) for line in (geo.simplify(r.coords, 0.0005) for r in routes)],
            "res": res,
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
        "forecast_window": {"start": iso(start), "end": iso(end), "grid_deg": res},
        "routes": out_routes,
        "recommendation": explain(summaries),
        "departure_advice": advice,
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
    data = corridor.build(
        ctx["lines"], ctx["departure_ts"], ctx["load_lb"], ctx["window"], ctx.get("scenario"), ctx.get("res", 0.1)
    )
    cache.set(key, data, PLAN_TTL_S)
    return data
