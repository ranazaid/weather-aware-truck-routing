"""Hourly forecasts from Open-Meteo, batched per grid cell and read at the truck's ETA.

* Points are snapped to a grid cell, 0.1° (about 7 miles) by default, so three overlapping routes and
  the corridor heatmap share one download per cell. Open-Meteo's free tier allows 600 locations a
  minute, so very long trips get a coarser grid that keeps a plan within budget (see `resolution_for`).
  Every checkpoint is still read at its own ETA.
* Wind speed is an instantaneous hourly value: it is interpolated linearly between hours.
* Rain, showers and snowfall are totals for the preceding hour, i.e. a rate in in/hr. The truck is
  given the rate of the clock hour it is driving in: an ETA of 13:20 uses the 13:00-14:00 total.
"""

from __future__ import annotations

import logging
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime

from django.conf import settings
from django.core.cache import cache

from ..domain import geo
from .http import ProviderError, get_json

log = logging.getLogger(__name__)

CELL_DEG = 0.1
RESOLUTIONS = (0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1.0)
BATCH = 50
CACHE_S = 30 * 60
HOURLY = "wind_speed_10m,wind_gusts_10m,rain,showers,snowfall,temperature_2m,weather_code"
Cell = tuple[float, float]  # (lon, lat), rounded


def cell_of(coord: geo.Coord, res: float = CELL_DEG) -> Cell:
    lon, lat = coord
    return (round(round(lon / res) * res, 2), round(round(lat / res) * res, 2))


def resolution_for(coords, max_cells: int) -> float:
    """The finest grid on which these points need at most `max_cells` forecast locations."""
    for res in RESOLUTIONS:
        if len({cell_of(c, res) for c in coords}) <= max_cells:
            return res
    return RESOLUTIONS[-1]


def hour_floor(ts: float) -> int:
    return int(ts // 3600 * 3600)


@dataclass(frozen=True)
class Series:
    t0: int  # unix seconds of the first hour
    wind: tuple[float | None, ...]
    gust: tuple[float | None, ...]
    rain: tuple[float | None, ...]  # rain + showers, in/hr
    snow: tuple[float | None, ...]  # in/hr
    temp: tuple[float | None, ...]
    code: tuple[int | None, ...]

    @property
    def t_end(self) -> int:
        return self.t0 + (len(self.wind) - 1) * 3600


def _sum(a, b):
    if a is None and b is None:
        return None
    return (a or 0.0) + (b or 0.0)


def parse_location(loc: dict) -> Series:
    h = loc["hourly"]
    rain = tuple(_sum(r, s) for r, s in zip(h["rain"], h["showers"], strict=True))
    return Series(
        t0=int(h["time"][0]),
        wind=tuple(h["wind_speed_10m"]),
        gust=tuple(h["wind_gusts_10m"]),
        rain=rain,
        snow=tuple(h["snowfall"]),
        temp=tuple(h["temperature_2m"]),
        code=tuple(h["weather_code"]),
    )


def _iso_hour(ts: int) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M")


def _download(cells: list[Cell], start: int, end: int) -> list[Series]:
    params = {
        "latitude": ",".join(f"{lat:.2f}" for _, lat in cells),
        "longitude": ",".join(f"{lon:.2f}" for lon, _ in cells),
        "hourly": HOURLY,
        "wind_speed_unit": "mph",
        "precipitation_unit": "inch",
        "temperature_unit": "fahrenheit",
        "timezone": "UTC",
        "timeformat": "unixtime",
        "start_hour": _iso_hour(start),
        "end_hour": _iso_hour(end),
    }
    data, status = get_json("Open-Meteo weather", settings.PROVIDERS["OPEN_METEO_URL"], params)
    if isinstance(data, dict) and data.get("error"):
        reason = data.get("reason") or "no reason given"
        raise ProviderError("Open-Meteo weather", f"Open-Meteo rejected the forecast request: {reason}", status=502)
    if status >= 400:
        raise ProviderError("Open-Meteo weather", f"Open-Meteo returned HTTP {status}.")
    locations = data if isinstance(data, list) else [data]
    if len(locations) != len(cells):
        raise ProviderError("Open-Meteo weather", "Open-Meteo returned the wrong number of locations.")
    return [parse_location(loc) for loc in locations]


def _key(cell: Cell, start: int, end: int) -> str:
    return f"wx:{cell[0]:.2f},{cell[1]:.2f}:{start}:{end}"


def fetch(cells, start: int, end: int) -> dict[Cell, Series]:
    """Hourly series for every cell over [start, end] (unix seconds on the hour), cached per cell."""
    unique = list(dict.fromkeys(cells))
    found = cache.get_many([_key(c, start, end) for c in unique])
    out: dict[Cell, Series] = {}
    missing: list[Cell] = []
    for c in unique:
        s = found.get(_key(c, start, end))
        if s is None:
            missing.append(c)
        else:
            out[c] = s
    batches = [missing[i : i + BATCH] for i in range(0, len(missing), BATCH)]
    if batches:
        with ThreadPoolExecutor(max_workers=3) as pool:
            for batch, series in zip(batches, pool.map(lambda b: _download(b, start, end), batches), strict=True):
                for c, s in zip(batch, series, strict=True):
                    out[c] = s
                cache.set_many({_key(c, start, end): s for c, s in zip(batch, series, strict=True)}, CACHE_S)
    log.info("weather: %d cells (%d downloaded in %d requests)", len(unique), len(missing), len(batches))
    return out


def _lerp(values, i: int, t: float) -> float | None:
    a = values[i]
    b = values[min(i + 1, len(values) - 1)]
    if a is None or b is None:
        return a if t < 0.5 else b
    return a + (b - a) * t


def sample(series: Series, ts: float) -> dict | None:
    """Conditions at unix time `ts`, or None when the forecast does not cover it."""
    x = (ts - series.t0) / 3600.0
    n = len(series.wind)
    if x < 0 or x > n - 1:
        return None
    i = min(int(math.floor(x)), n - 1)
    t = x - i
    hour = min(i + 1, n - 1)  # the period total stamped at the end of the clock hour we are in
    wind = _lerp(series.wind, i, t)
    if wind is None:
        return None
    return {
        "wind_mph": round(wind, 1),
        "gust_mph": None if _lerp(series.gust, i, t) is None else round(_lerp(series.gust, i, t), 1),
        "rain_in_hr": round(series.rain[hour] or 0.0, 3),
        "snow_in_hr": round(series.snow[hour] or 0.0, 3),
        "temp_f": None if _lerp(series.temp, i, t) is None else round(_lerp(series.temp, i, t)),
        "weather_code": series.code[hour],
    }


@dataclass(frozen=True)
class Scenario:
    """A clearly labelled what-if: adds wind and scales precipitation on top of the real forecast.

    Lets a dispatcher (or a reviewer) see how the load rules and ranking react to worse weather when
    the real forecast happens to be calm. Every response that uses it says so.
    """

    wind_add_mph: float = 0.0
    precip_factor: float = 1.0

    @property
    def active(self) -> bool:
        return self.wind_add_mph != 0 or self.precip_factor != 1

    def apply(self, wx: dict | None) -> dict | None:
        if wx is None or not self.active:
            return wx
        out = dict(wx)
        out["wind_mph"] = round(wx["wind_mph"] + self.wind_add_mph, 1)
        if wx.get("gust_mph") is not None:
            out["gust_mph"] = round(wx["gust_mph"] + self.wind_add_mph, 1)
        out["rain_in_hr"] = round(wx["rain_in_hr"] * self.precip_factor, 3)
        out["snow_in_hr"] = round(wx["snow_in_hr"] * self.precip_factor, 3)
        return out

    def describe(self) -> str:
        bits = []
        if self.wind_add_mph:
            bits.append(f"+{self.wind_add_mph:g} mph wind")
        if self.precip_factor != 1:
            bits.append(f"×{self.precip_factor:g} rain and snow")
        return " and ".join(bits)

    def as_dict(self) -> dict | None:
        if not self.active:
            return None
        return {"wind_add_mph": self.wind_add_mph, "precip_factor": self.precip_factor, "text": self.describe()}


def needed_end(departure_ts: float, last_eta_ts: float, heatmap_hours: int = 48) -> int:
    """Last forecast hour the trip and the heatmap slider need, padded so interpolation never runs out."""
    return hour_floor(max(departure_ts + heatmap_hours * 3600, last_eta_ts)) + 2 * 3600


def window(departure_ts: float, last_eta_ts: float, heatmap_hours: int = 48) -> tuple[int, int]:
    """Forecast window from the departure hour, rounded up to whole days.

    Rounding means re-planning the same trip with another load, interval or HOS setting asks for the
    same window, so the cached forecasts are reused instead of downloaded again.
    """
    start = hour_floor(departure_ts)
    days = math.ceil((needed_end(departure_ts, last_eta_ts, heatmap_hours) - start) / 86400)
    return start, start + days * 86400
