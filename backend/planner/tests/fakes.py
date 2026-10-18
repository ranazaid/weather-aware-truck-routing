"""Deterministic stand-ins for OSRM and Open-Meteo, used with the `responses` library."""

from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, unquote, urlparse, urlsplit

OSRM = re.compile(r"https://router\.project-osrm\.org/route/v1/driving/.*")
METEO = "https://api.open-meteo.com/v1/forecast"


def line(start, end, n=120):
    (x0, y0), (x1, y1) = start, end
    return [[x0 + (x1 - x0) * i / (n - 1), y0 + (y1 - y0) * i / (n - 1)] for i in range(n)]


def osrm_route(coords, seconds_per_segment=60.0, ref="I 99"):
    seg = len(coords) - 1
    return {
        "geometry": {"type": "LineString", "coordinates": coords},
        "duration": seg * seconds_per_segment,
        "distance": 0,
        "legs": [
            {
                "annotation": {"duration": [seconds_per_segment] * seg},
                "steps": [{"ref": ref, "name": "", "distance": 1000.0}],
            }
        ],
    }


def osrm_callback(alternatives: list[list[list[float]]], detour_bulge=0.6):
    """Answers A→B with `alternatives`, and A→via→B with a route bent through the via point."""

    def cb(request):
        path = unquote(urlsplit(request.url).path).split("/driving/")[1]
        pts = [tuple(map(float, p.split(","))) for p in path.split(";")]
        if len(pts) == 2:
            routes = [osrm_route(c, ref=f"I {10 + i}") for i, c in enumerate(alternatives)]
        else:
            a, via, b = pts
            coords = line(a, via, 60) + line(via, b, 60)[1:]
            routes = [osrm_route(coords, seconds_per_segment=62.0, ref=f"US {int(abs(via[1]) * 10)}")]
        return 200, {}, json.dumps({"code": "Ok", "routes": routes})

    return cb


def meteo_callback(wind_for=lambda lon, lat, hour: 10.0, rain=0.0, snow=0.0, calls=None):
    """Hourly series for each requested location; `wind_for` lets a test paint weather on the map."""

    def cb(request):
        q = parse_qs(urlparse(request.url).query)
        lats = [float(v) for v in q["latitude"][0].split(",")]
        lons = [float(v) for v in q["longitude"][0].split(",")]
        from datetime import UTC, datetime

        start = int(datetime.strptime(q["start_hour"][0], "%Y-%m-%dT%H:%M").replace(tzinfo=UTC).timestamp())
        end = int(datetime.strptime(q["end_hour"][0], "%Y-%m-%dT%H:%M").replace(tzinfo=UTC).timestamp())
        hours = list(range(start, end + 1, 3600))
        if calls is not None:
            calls.append(len(lats))
        out = []
        for lat, lon in zip(lats, lons, strict=True):
            out.append(
                {
                    "latitude": lat,
                    "longitude": lon,
                    "hourly": {
                        "time": hours,
                        "wind_speed_10m": [wind_for(lon, lat, (t - start) // 3600) for t in hours],
                        "wind_gusts_10m": [wind_for(lon, lat, (t - start) // 3600) + 8 for t in hours],
                        "rain": [rain] * len(hours),
                        "showers": [0.0] * len(hours),
                        "snowfall": [snow] * len(hours),
                        "temperature_2m": [50.0] * len(hours),
                        "weather_code": [3] * len(hours),
                    },
                }
            )
        body = out if len(out) > 1 else out[0]
        return 200, {}, json.dumps(body)

    return cb
