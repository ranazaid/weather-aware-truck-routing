"""Corridor heatmap: a grid of forecast cells along and either side of every route, for hours 0-48.

All 49 hourly frames are computed on the server and sent at once, so the slider in the browser only
swaps numbers on the GPU layer: no request, no recomputation, no stutter while scrubbing or playing.
The risk value is the continuous score from `risk.continuous_score`, whose integer part equals the
checkpoint level, so heatmap colours and checkpoint badges always agree.
"""

from __future__ import annotations

import math

from ..domain import geo
from ..domain.risk import continuous_score
from . import weather

HOURS = 48
OFFSETS_MI = (-40.0, -20.0, 0.0, 20.0, 40.0)
MAX_CELLS = 360
START_SPACING_MI = 12.0


def corridor_cells(lines: list[tuple[list[geo.Coord], list[float]]]) -> list[weather.Cell]:
    """Unique 0.1° cells covering a band about 40 miles either side of each route, capped at MAX_CELLS."""
    spacing = START_SPACING_MI
    while True:
        cells: dict[weather.Cell, None] = {}
        for coords, cum in lines:
            total = cum[-1]
            n = max(1, math.ceil(total / spacing))
            for k in range(n + 1):
                m = total * k / n
                at = geo.point_at(coords, cum, m)
                a = geo.point_at(coords, cum, max(0.0, m - 3))
                b = geo.point_at(coords, cum, min(total, m + 3))
                for off in OFFSETS_MI:
                    p = at if off == 0 or a == b else geo.offset_perpendicular(a, b, at, off)
                    cells[weather.cell_of(p)] = None
        if len(cells) <= MAX_CELLS or spacing > 400:
            return list(cells)
        spacing *= 1.35


def _r(v, nd):
    return None if v is None else round(v, nd)


def build(lines, departure_ts: float, load_lb: float, win: tuple[int, int]) -> dict:
    cells = corridor_cells(lines)
    series = weather.fetch(cells, *win)
    metrics: dict[str, list[list[float | None]]] = {"risk": [], "wind": [], "rain": [], "snow": []}
    for h in range(HOURS + 1):
        ts = departure_ts + h * 3600
        row = {k: [] for k in metrics}
        for c in cells:
            s = weather.sample(series[c], ts) if c in series else None
            if s is None:
                for k in row:
                    row[k].append(None)
                continue
            row["risk"].append(round(continuous_score(s["wind_mph"], s["rain_in_hr"], s["snow_in_hr"], load_lb), 2))
            row["wind"].append(_r(s["wind_mph"], 0))
            row["rain"].append(_r(s["rain_in_hr"], 2))
            row["snow"].append(_r(s["snow_in_hr"], 2))
        for k in metrics:
            metrics[k].append(row[k])

    def peak(k):
        vals = [v for frame in metrics[k] for v in frame if v is not None]
        return max(vals) if vals else 0

    return {
        "hours": HOURS,
        "step_s": 3600,
        "departure_ts": int(departure_ts),
        "points": [[lon, lat] for lon, lat in cells],
        "metrics": metrics,
        "peak": {k: peak(k) for k in metrics},
    }
