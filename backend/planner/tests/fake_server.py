"""Offline stand-ins for OSRM, Open-Meteo and Photon, for the browser end-to-end tests.

    python -m planner.tests.fake_server --port 8099

Then point Django at it with OSRM_URL, OPEN_METEO_URL and PHOTON_URL (see frontend/playwright.config.ts).

The weather is deterministic: a wind storm sits over the Texas/Oklahoma panhandle (about 36.3 N,
100.9 W) for the first 30 hours, with heavy rain at its core. The straight Dallas-Denver route runs
through it and the detours mostly go around it, so load rules and the ranking have something to do.
A destination east of 170 E has no road route, which exercises the error path.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

STORM = (-100.9, 36.3)
STORM_RADIUS_MI = 75
STORM_HOURS = 30
CITIES = [
    ("Dallas", "Texas", -96.797, 32.7767),
    ("Denton", "Texas", -97.1331, 33.2148),
    ("Denver", "Colorado", -104.9903, 39.7392),
    ("Amarillo", "Texas", -101.8313, 35.222),
    ("Salt Lake City", "Utah", -111.891, 40.7608),
    ("Omaha", "Nebraska", -95.9345, 41.2565),
    ("Seattle", "Washington", -122.3321, 47.6062),
    ("Missoula", "Montana", -113.994, 46.8721),
    ("Atlanta", "Georgia", -84.388, 33.749),
    ("Chicago", "Illinois", -87.6298, 41.8781),
]


def miles(a, b) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 3958.7613 * math.asin(min(1.0, math.sqrt(h)))


def line(a, b, n):
    return [[a[0] + (b[0] - a[0]) * i / (n - 1), a[1] + (b[1] - a[1]) * i / (n - 1)] for i in range(n)]


def osrm(points):
    if points[-1][0] > 170:
        return {"code": "NoRoute", "message": "Impossible route between points"}
    coords = []
    for a, b in zip(points, points[1:], strict=False):
        seg = line(a, b, 80)
        coords.extend(seg if not coords else seg[1:])
    seg_s = [miles(p, q) / 60 * 3600 for p, q in zip(coords, coords[1:], strict=False)]  # 60 mph
    ref = "I 99" if len(points) == 2 else f"US {abs(round(points[1][1] * 10))}"
    route = {
        "geometry": {"type": "LineString", "coordinates": coords},
        "duration": sum(seg_s),
        "distance": 0,
        "legs": [{"annotation": {"duration": seg_s}, "steps": [{"ref": ref, "name": "", "distance": 1000.0}]}],
    }
    return {"code": "Ok", "routes": [route]}


def conditions(lon, lat, hour):
    d = miles((lon, lat), STORM)
    if hour < STORM_HOURS and d < STORM_RADIUS_MI:
        return 40.0, 0.3 if d < 25 else 0.0
    return 12.0, 0.0


def forecast(q):
    lats = [float(v) for v in q["latitude"][0].split(",")]
    lons = [float(v) for v in q["longitude"][0].split(",")]

    def ts(v):
        return int(datetime.strptime(v, "%Y-%m-%dT%H:%M").replace(tzinfo=UTC).timestamp())

    start, end = ts(q["start_hour"][0]), ts(q["end_hour"][0])
    hours = list(range(start, end + 1, 3600))
    out = []
    for lat, lon in zip(lats, lons, strict=True):
        wx = [conditions(lon, lat, (t - start) // 3600) for t in hours]
        out.append(
            {
                "latitude": lat,
                "longitude": lon,
                "hourly": {
                    "time": hours,
                    "wind_speed_10m": [w for w, _ in wx],
                    "wind_gusts_10m": [w + 9 for w, _ in wx],
                    "rain": [r for _, r in wx],
                    "showers": [0.0] * len(hours),
                    "snowfall": [0.0] * len(hours),
                    "temperature_2m": [58.0] * len(hours),
                    "weather_code": [63 if r else 3 for _, r in wx],
                },
            }
        )
    return out if len(out) > 1 else out[0]


def photon(q):
    text = q.get("q", [""])[0].lower()
    features = [
        {
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"name": name, "state": state, "countrycode": "US", "type": "city"},
        }
        for name, state, lon, lat in CITIES
        if text and name.lower().startswith(text[:3])
    ]
    return {"type": "FeatureCollection", "features": features}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (http.server API)
        url = urlsplit(self.path)
        q = parse_qs(url.query)
        path = unquote(url.path)
        if path.startswith("/route/v1/driving/"):
            pts = [tuple(map(float, p.split(","))) for p in path.split("/driving/")[1].split(";")]
            body = osrm(pts)
        elif path.startswith("/v1/forecast"):
            body = forecast(q)
        elif path.startswith("/api"):
            body = photon(q)
        elif path == "/health":
            body = {"ok": True}
        else:
            self.send_error(404)
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # keep test output quiet
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8099)
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
