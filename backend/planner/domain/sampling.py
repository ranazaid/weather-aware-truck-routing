"""Place weather checkpoints along a route (pure).

A checkpoint is placed at mile 0, every `interval_mi` miles, and at the destination. Each checkpoint
"owns" the distance halfway to its neighbours, so owned miles add up to the route length exactly and
a checkpoint's weather is applied to the stretch of road it is closest to.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from . import geo

ALLOWED_INTERVALS_MI = (10, 25, 50)


@dataclass(frozen=True)
class RawCheckpoint:
    index: int
    mile: float
    coord: geo.Coord
    drive_s: float  # driving seconds from departure (no rest stops)
    owned_from_mi: float
    owned_to_mi: float

    @property
    def owned_mi(self) -> float:
        return self.owned_to_mi - self.owned_from_mi


def checkpoint_miles(total_mi: float, interval_mi: float) -> list[float]:
    if interval_mi <= 0:
        raise ValueError("interval must be positive")
    miles = [0.0]
    k = 1
    while k * interval_mi < total_mi - 1e-6:
        miles.append(k * interval_mi)
        k += 1
    if total_mi > 0:
        miles.append(total_mi)
    return miles


def place_checkpoints(
    coords: Sequence[geo.Coord],
    cum_mi: Sequence[float],
    cum_drive_s: Sequence[float],
    interval_mi: float,
) -> list[RawCheckpoint]:
    if len(coords) != len(cum_mi) or len(coords) != len(cum_drive_s):
        raise ValueError("coords, cum_mi and cum_drive_s must have equal length")
    total = cum_mi[-1]
    miles = checkpoint_miles(total, interval_mi)
    out: list[RawCheckpoint] = []
    for i, m in enumerate(miles):
        prev_mid = 0.0 if i == 0 else (miles[i - 1] + m) / 2
        next_mid = total if i == len(miles) - 1 else (m + miles[i + 1]) / 2
        out.append(
            RawCheckpoint(
                index=i,
                mile=m,
                coord=geo.point_at(coords, cum_mi, m),
                drive_s=geo.value_at(cum_mi, cum_drive_s, m),
                owned_from_mi=prev_mid,
                owned_to_mi=next_mid,
            )
        )
    return out


def truck_adjusted_durations(
    seg_miles: Sequence[float], seg_seconds: Sequence[float], speed_cap_mph: float | None
) -> list[float]:
    """Cumulative driving seconds per vertex, never faster than `speed_cap_mph` on any segment."""
    cum = [0.0]
    for d_mi, t_s in zip(seg_miles, seg_seconds, strict=True):
        t = max(0.0, float(t_s))
        if speed_cap_mph and d_mi > 0:
            t = max(t, d_mi / speed_cap_mph * 3600.0)
        cum.append(cum[-1] + t)
    return cum
