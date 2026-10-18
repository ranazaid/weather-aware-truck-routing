"""MET Norway Locationforecast: the backup forecast when Open-Meteo is busy or unreachable.

Free, keyless and global, but one request per location, so it is only used for the cells Open-Meteo
could not serve. The forecast is hourly for about 2.5 days and 6-hourly after that; it is turned into
the same hourly `Series` the rest of the app reads, with these conversions:
  * wind m/s -> mph (instantaneous, interpolated between steps; MET gives no gusts here)
  * precipitation mm per period -> in/hr, split into rain or snow by the weather symbol when it
    names the type, otherwise by temperature (0.5 C or below mid-hour); snow uses a 10:1 ratio
"""

from __future__ import annotations

import logging
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from django.conf import settings

from .http import ProviderError, get_json

log = logging.getLogger(__name__)

MPS_TO_MPH = 2.236936
MM_TO_IN = 1 / 25.4
SNOW_RATIO = 10.0
WORKERS = 8

# MET symbol (without _day/_night) -> closest WMO weather code used by the UI.
SYMBOL_WMO = {
    "clearsky": 0,
    "fair": 1,
    "partlycloudy": 2,
    "cloudy": 3,
    "fog": 45,
    "lightrain": 61,
    "rain": 63,
    "heavyrain": 65,
    "lightrainshowers": 80,
    "rainshowers": 81,
    "heavyrainshowers": 82,
    "lightsleet": 66,
    "sleet": 67,
    "heavysleet": 67,
    "lightsnow": 71,
    "snow": 73,
    "heavysnow": 75,
    "lightsnowshowers": 85,
    "snowshowers": 85,
    "heavysnowshowers": 86,
}


def _wmo(symbol: str | None) -> int | None:
    if not symbol:
        return None
    base = symbol.split("_")[0]
    if "thunder" in base:
        return 95
    return SYMBOL_WMO.get(base)


def _frozen(symbol: str | None, temp_c: float | None) -> bool:
    """Snow or sleet? The forecast symbol decides when it names the type; otherwise the temperature."""
    if symbol and ("snow" in symbol or "sleet" in symbol):
        return True
    if symbol and "rain" in symbol:
        return False
    return temp_c is not None and temp_c <= 0.5


def _ts(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def to_series(doc: dict, start: int, end: int):
    """Hourly Series over [start, end] from a Locationforecast document."""
    from .weather import Series  # local import: weather imports this module

    steps = doc["properties"]["timeseries"]
    times = [_ts(s["time"]) for s in steps]
    hours = list(range(start, end + 1, 3600))

    def instant(i, key):
        return steps[i]["data"]["instant"]["details"].get(key)

    def at(t, key):
        """Instant value at t, linearly between forecast steps."""
        j = bisect_right(times, t) - 1
        if j < 0 or t > times[-1]:
            return None
        a = instant(j, key)
        if j + 1 >= len(times) or times[j] == t:
            return a
        b = instant(j + 1, key)
        if a is None or b is None:
            return a if b is None else b
        f = (t - times[j]) / (times[j + 1] - times[j])
        return a + (b - a) * f

    def period(t):
        """(precip rate mm/hr, symbol) for the clock hour ending at t (Open-Meteo convention)."""
        j = bisect_right(times, t - 3600) - 1
        if j < 0:
            return None, None
        data = steps[j]["data"]
        for key, hrs in (("next_1_hours", 1), ("next_6_hours", 6), ("next_12_hours", 12)):
            block = data.get(key)
            if block and "precipitation_amount" in block.get("details", {}):
                if t - 3600 >= times[j] + hrs * 3600:
                    continue  # this block ends before the hour we want: try the longer one
                return block["details"]["precipitation_amount"] / hrs, block.get("summary", {}).get("symbol_code")
        return None, None

    wind, temp, rain, snow, code = [], [], [], [], []
    for t in hours:
        w = at(t, "wind_speed")
        c = at(t, "air_temperature")
        mm, symbol = period(t)
        wind.append(None if w is None else w * MPS_TO_MPH)
        temp.append(None if c is None else c * 9 / 5 + 32)
        code.append(_wmo(symbol))
        if mm is None:
            rain.append(None)
            snow.append(None)
            continue
        frozen = _frozen(symbol, at(t - 1800, "air_temperature"))
        rain.append(0.0 if frozen else mm * MM_TO_IN)
        snow.append(mm * MM_TO_IN * SNOW_RATIO if frozen else 0.0)
    return Series(
        t0=start,
        wind=tuple(wind),
        gust=tuple([None] * len(hours)),
        rain=tuple(rain),
        snow=tuple(snow),
        temp=tuple(temp),
        code=tuple(code),
    )


def fetch(cells, start: int, end: int) -> dict:
    base = settings.PROVIDERS.get("MET_URL")
    if not base:
        raise ProviderError("MET Norway weather", "The backup forecast service is not configured.")

    def one(cell):
        lon, lat = cell
        data, status = get_json("MET Norway weather", base, {"lat": f"{lat:.2f}", "lon": f"{lon:.2f}"})
        if status >= 400 or not isinstance(data, dict) or "properties" not in data:
            raise ProviderError("MET Norway weather", f"MET Norway returned HTTP {status}.")
        return cell, to_series(data, start, end)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        out = dict(pool.map(one, cells))
    log.info("weather: %d cells from MET Norway (backup)", len(out))
    return out
