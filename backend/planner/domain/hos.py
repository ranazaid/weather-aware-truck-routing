"""FMCSA hours-of-service timing for property-carrying drivers (simplified, pure).

Rules applied (49 CFR 395.3):
  * 30-minute break once a driver has driven 8 cumulative hours;
  * 11 hours of driving maximum, then 10 consecutive hours off duty, which resets both clocks.
The 14-hour window never binds here because the planner drives continuously (11 h + 0.5 h < 14 h),
and fuel/inspection stops are not modelled. Weather is sampled at the *elapsed* time these rules give.
"""

from __future__ import annotations

from dataclasses import dataclass

HOUR = 3600.0
DRIVE_LIMIT_S = 11 * HOUR
BREAK_AFTER_S = 8 * HOUR
BREAK_S = 0.5 * HOUR
REST_S = 10 * HOUR


@dataclass(frozen=True)
class Stop:
    kind: str  # "break" | "rest"
    at_drive_s: float  # driving seconds completed when the stop starts
    start_elapsed_s: float
    duration_s: float

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "label": "30-min break" if self.kind == "break" else "10-hr off-duty reset",
            "at_drive_s": round(self.at_drive_s),
            "start_elapsed_s": round(self.start_elapsed_s),
            "duration_s": round(self.duration_s),
        }


def schedule(total_drive_s: float) -> list[Stop]:
    """Stops needed to drive `total_drive_s` seconds. No stop is scheduled at the very end of the trip."""
    stops: list[Stop] = []
    driven = 0.0
    elapsed = 0.0
    cycle_driven = 0.0
    break_taken = False
    eps = 1e-6
    while driven < total_drive_s - eps:
        remaining = total_drive_s - driven
        if not break_taken:
            until_event = min(BREAK_AFTER_S - cycle_driven, DRIVE_LIMIT_S - cycle_driven)
        else:
            until_event = DRIVE_LIMIT_S - cycle_driven
        if remaining <= until_event + eps:
            break  # arrive before the next mandatory stop
        driven += until_event
        elapsed += until_event
        cycle_driven += until_event
        if not break_taken and cycle_driven >= BREAK_AFTER_S - eps and cycle_driven < DRIVE_LIMIT_S - eps:
            stops.append(Stop("break", driven, elapsed, BREAK_S))
            elapsed += BREAK_S
            break_taken = True
        else:
            stops.append(Stop("rest", driven, elapsed, REST_S))
            elapsed += REST_S
            cycle_driven = 0.0
            break_taken = False
    return stops


def elapsed_for(drive_s: float, stops: list[Stop]) -> float:
    """Wall-clock seconds since departure when the truck has driven `drive_s` seconds."""
    return drive_s + sum(s.duration_s for s in stops if s.at_drive_s < drive_s - 1e-6)


def total_elapsed(total_drive_s: float, stops: list[Stop]) -> float:
    return total_drive_s + sum(s.duration_s for s in stops)


def drive_for(elapsed_s: float, stops: list[Stop]) -> float:
    """Inverse of `elapsed_for`: driving seconds completed at a wall-clock offset (parked during stops)."""
    drive = elapsed_s
    for s in stops:
        if elapsed_s <= s.start_elapsed_s:
            break
        if elapsed_s < s.start_elapsed_s + s.duration_s:
            return s.at_drive_s
        drive -= s.duration_s
    return max(0.0, drive)
