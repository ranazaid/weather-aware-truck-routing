"""Route summaries and recommendation (pure).

Ranking key, compared in order (the brief's order, with a No Travel guard in front):
  0. fewest No Travel miles        - a route that must not be driven is never "safest"
  1. fewest Severe miles
  2. fewest High miles
  3. lowest average risk           - distance-weighted mean of Low=0 ... No Travel=4
  4. shortest travel time          - door-to-door, including mandatory HOS stops when enabled
Miles are compared at 0.1-mile and average risk at 0.01 resolution so floating-point noise never
decides between two routes that a driver would consider identical.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .risk import Level

LEVEL_ORDER = [Level.LOW, Level.MODERATE, Level.HIGH, Level.SEVERE, Level.NO_TRAVEL]


@dataclass
class RouteSummary:
    route_id: str
    label: str
    distance_mi: float
    duration_s: float
    miles_by_level: dict[Level, float] = field(default_factory=dict)
    unknown_mi: float = 0.0
    avg_risk: float = 0.0
    max_level: Level = Level.LOW

    def key(self) -> tuple:
        m = self.miles_by_level
        return (
            round(m.get(Level.NO_TRAVEL, 0.0), 1),
            round(m.get(Level.SEVERE, 0.0), 1),
            round(m.get(Level.HIGH, 0.0), 1),
            round(self.avg_risk, 2),
            round(self.duration_s),
            self.label,  # deterministic final tie-break
        )

    def as_dict(self) -> dict:
        return {
            "distance_mi": round(self.distance_mi, 1),
            "duration_s": round(self.duration_s),
            "miles_by_level": {lvl.key: round(self.miles_by_level.get(lvl, 0.0), 1) for lvl in LEVEL_ORDER},
            "unknown_mi": round(self.unknown_mi, 1),
            "avg_risk": round(self.avg_risk, 2),
            "max_level": self.max_level.key,
        }


def summarize(
    route_id: str,
    label: str,
    distance_mi: float,
    duration_s: float,
    segments: list[tuple[float, Level | None]],
) -> RouteSummary:
    """`segments` = (owned miles, level or None when no forecast covers that time)."""
    s = RouteSummary(route_id, label, distance_mi, duration_s)
    weighted = 0.0
    known = 0.0
    for miles, level in segments:
        if level is None:
            s.unknown_mi += miles
            continue
        s.miles_by_level[level] = s.miles_by_level.get(level, 0.0) + miles
        weighted += miles * int(level)
        known += miles
        s.max_level = max(s.max_level, level)
    s.avg_risk = weighted / known if known > 0 else 0.0
    return s


CRITERIA = [
    ("No Travel miles", lambda s: round(s.miles_by_level.get(Level.NO_TRAVEL, 0.0), 1), "mi"),
    ("Severe miles", lambda s: round(s.miles_by_level.get(Level.SEVERE, 0.0), 1), "mi"),
    ("High miles", lambda s: round(s.miles_by_level.get(Level.HIGH, 0.0), 1), "mi"),
    ("average risk", lambda s: round(s.avg_risk, 2), ""),
    ("travel time", lambda s: round(s.duration_s), "s"),
]


def _fmt(value: float, unit: str) -> str:
    if unit == "mi":
        return f"{value:,.1f} mi"
    if unit == "s":
        h, rem = divmod(int(value), 3600)
        return f"{h}h {rem // 60:02d}m"
    return f"{value:.2f}"


def decisive_criterion(best: RouteSummary, other: RouteSummary) -> dict | None:
    """First criterion where `best` beats `other`, with both values, for a human explanation."""
    for name, get, unit in CRITERIA:
        a, b = get(best), get(other)
        if a != b:
            return {"criterion": name, "best": _fmt(a, unit), "other": _fmt(b, unit), "best_value": a, "other_value": b}
    return None


def rank(summaries: list[RouteSummary]) -> list[RouteSummary]:
    return sorted(summaries, key=lambda s: s.key())


def explain(summaries: list[RouteSummary]) -> dict:
    """Pick the best route and say, for every other route, the first rule that separated them."""
    if not summaries:
        raise ValueError("at least one route is required")
    ordered = rank(summaries)
    best = ordered[0]
    comparisons = []
    for other in ordered[1:]:
        d = decisive_criterion(best, other)
        if d is None:
            text = (
                f"Route {best.label} and Route {other.label} are equivalent on every rule; "
                f"{best.label} is listed first."
            )
        else:
            text = f"Route {best.label} beats Route {other.label} on {d['criterion']}: {d['best']} vs {d['other']}."
        comparisons.append({"route_id": other.route_id, "label": other.label, "text": text, **(d or {})})

    headline_bits = []
    m = best.miles_by_level
    if m.get(Level.NO_TRAVEL, 0) > 0:
        headline_bits.append("Every option crosses No Travel conditions; delay departure if you can.")
    elif m.get(Level.SEVERE, 0) > 0:
        headline_bits.append(f"Least exposure available, but still {m[Level.SEVERE]:,.1f} Severe miles.")
    elif m.get(Level.HIGH, 0) > 0:
        headline_bits.append(f"No Severe weather; {m[Level.HIGH]:,.1f} High-risk miles.")
    else:
        headline_bits.append("No High or Severe weather on this route at the expected arrival times.")
    return {
        "route_id": best.route_id,
        "label": best.label,
        "headline": headline_bits[0],
        "order": [s.route_id for s in ordered],
        "comparisons": comparisons,
    }


def _risk_key(s: RouteSummary) -> tuple:
    return s.key()[:4]  # No Travel, Severe, High, average risk: travel time is the same at any departure


def departure_advice(now: RouteSummary, later: list[tuple[int, RouteSummary]]) -> dict:
    """Would leaving later be safer? `now` and `later` hold the best route for each departure.

    Only risk counts here (travel time barely changes with the clock). The earliest of the safest
    departures is suggested, and only when it is strictly safer than leaving as planned.
    """

    def row(offset_h: int, s: RouteSummary) -> dict:
        m = s.miles_by_level
        return {
            "offset_h": offset_h,
            "route_id": s.route_id,
            "label": s.label,
            "no_travel_mi": round(m.get(Level.NO_TRAVEL, 0.0), 1),
            "severe_mi": round(m.get(Level.SEVERE, 0.0), 1),
            "high_mi": round(m.get(Level.HIGH, 0.0), 1),
            "avg_risk": round(s.avg_risk, 2),
            "duration_s": round(s.duration_s),
        }

    options = [row(0, now)] + [row(h, s) for h, s in later]
    best_h, best = min([(0, now), *later], key=lambda o: (_risk_key(o[1]), o[0]))
    text = None
    if best_h > 0 and _risk_key(best) < _risk_key(now):
        d = decisive_criterion(best, now)
        assert d is not None  # the risk keys differ, so some criterion separates them
        text = (
            f"Leaving {best_h} h later is safer: Route {best.label} cuts {d['criterion']} "
            f"from {d['other']} to {d['best']}."
        )
    else:
        best_h = 0
    return {"options": options, "best_offset_h": best_h, "text": text}
