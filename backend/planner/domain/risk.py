"""Weather risk classification (pure, no I/O).

Implements the thresholds and load rules from the assessment exactly:

    Condition  Low        Moderate    High        Severe      No Travel
    Wind       < 25 mph   25-34       35-44       45-54       >= 55 mph
    Rain       < 0.10     0.10-0.25   0.25-0.50   0.50-1.00   > 1.00 in/hr
    Snow       < 0.5      0.5-1.0     1.0-2.0     2.0-3.0     > 3.0 in/hr

    Load rules: >= 55 mph -> No Travel for any load
                45-54 mph and > 30,000 lb -> No Travel
                35-44 mph and > 40,000 lb -> Severe

Boundary interpretation (the table's ranges touch at their ends, so one side must win):
    * wind: each band's lower bound is inclusive (25 is Moderate, 35 High, 45 Severe, 55 No Travel);
    * rain/snow: each band's lower bound is inclusive and the upper bound of Severe is inclusive,
      because No Travel is written as strictly "> 1.00" / "> 3.0".
A checkpoint's level is the worst of its wind, rain and snow levels after the load rules.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum


class Level(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4

    @property
    def label(self) -> str:
        return LABELS[self]

    @property
    def key(self) -> str:
        return self.name.lower()


LABELS = {
    Level.LOW: "Low",
    Level.MODERATE: "Moderate",
    Level.HIGH: "High",
    Level.SEVERE: "Severe",
    Level.NO_TRAVEL: "No Travel",
}

# Lower bounds (inclusive) for Moderate, High, Severe, and the No Travel bound per condition.
WIND_BANDS_MPH = (25.0, 35.0, 45.0, 55.0)  # No Travel at >= 55
RAIN_BANDS_IN_HR = (0.10, 0.25, 0.50, 1.00)  # No Travel at > 1.00
SNOW_BANDS_IN_HR = (0.5, 1.0, 2.0, 3.0)  # No Travel at > 3.0

LOAD_NO_TRAVEL_WIND_MPH = (45.0, 55.0)
LOAD_NO_TRAVEL_MIN_LB = 30_000
LOAD_SEVERE_WIND_MPH = (35.0, 45.0)
LOAD_SEVERE_MIN_LB = 40_000


def _banded(value: float, bands: tuple[float, float, float, float], no_travel_inclusive: bool) -> Level:
    moderate, high, severe, no_travel = bands
    if (value >= no_travel) if no_travel_inclusive else (value > no_travel):
        return Level.NO_TRAVEL
    if value >= severe:
        return Level.SEVERE
    if value >= high:
        return Level.HIGH
    if value >= moderate:
        return Level.MODERATE
    return Level.LOW


def classify_wind(mph: float) -> Level:
    return _banded(mph, WIND_BANDS_MPH, no_travel_inclusive=True)


def classify_rain(in_per_hr: float) -> Level:
    return _banded(in_per_hr, RAIN_BANDS_IN_HR, no_travel_inclusive=False)


def classify_snow(in_per_hr: float) -> Level:
    return _banded(in_per_hr, SNOW_BANDS_IN_HR, no_travel_inclusive=False)


def wind_level_for_load(mph: float, load_lb: float) -> tuple[Level, str | None]:
    """Wind level after load rules. Returns (level, rule_text_if_a_load_rule_raised_it)."""
    base = classify_wind(mph)
    lo, hi = LOAD_NO_TRAVEL_WIND_MPH
    if lo <= mph < hi and load_lb > LOAD_NO_TRAVEL_MIN_LB:
        return Level.NO_TRAVEL, f"45–54 mph wind with load over {LOAD_NO_TRAVEL_MIN_LB:,} lb → No Travel"
    lo, hi = LOAD_SEVERE_WIND_MPH
    if lo <= mph < hi and load_lb > LOAD_SEVERE_MIN_LB:
        return Level.SEVERE, f"35–44 mph wind with load over {LOAD_SEVERE_MIN_LB:,} lb → Severe"
    return base, None


@dataclass(frozen=True)
class Factor:
    name: str  # "wind" | "rain" | "snow"
    value: float
    unit: str
    level: Level
    rule: str | None = None

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "value": round(self.value, 3),
            "unit": self.unit,
            "level": self.level.key,
            "rule": self.rule,
        }


@dataclass(frozen=True)
class Assessment:
    level: Level
    factors: tuple[Factor, ...] = field(default_factory=tuple)

    @property
    def drivers(self) -> list[Factor]:
        """Factors responsible for the final level (ties included), worst first."""
        return [f for f in self.factors if f.level == self.level and self.level > Level.LOW]

    def as_dict(self) -> dict:
        return {
            "level": self.level.key,
            "label": self.level.label,
            "score": int(self.level),
            "factors": [f.as_dict() for f in self.factors],
            "drivers": [f.name for f in self.drivers],
        }


def assess(wind_mph: float, rain_in_hr: float, snow_in_hr: float, load_lb: float) -> Assessment:
    """Classify one checkpoint. Negative or missing precipitation is treated as zero."""
    wind_mph = max(0.0, float(wind_mph or 0.0))
    rain_in_hr = max(0.0, float(rain_in_hr or 0.0))
    snow_in_hr = max(0.0, float(snow_in_hr or 0.0))

    wind_level, wind_rule = wind_level_for_load(wind_mph, load_lb)
    factors = (
        Factor("wind", wind_mph, "mph", wind_level, wind_rule),
        Factor("rain", rain_in_hr, "in/hr", classify_rain(rain_in_hr)),
        Factor("snow", snow_in_hr, "in/hr", classify_snow(snow_in_hr)),
    )
    return Assessment(max(f.level for f in factors), factors)


# ---------------------------------------------------------------------------
# Continuous score for the corridor heatmap.
# floor(score) always equals the discrete level, so colours on the heatmap and the
# checkpoint chips agree; the fraction only makes the heatmap blend smoothly.
# ---------------------------------------------------------------------------


def _continuous(value: float, bands: tuple[float, float, float, float]) -> float:
    edges = (0.0, *bands)
    for i in range(4):
        lo, hi = edges[i], edges[i + 1]
        if value < hi:
            return i + (value - lo) / (hi - lo) * 0.999
    return 4.0


def continuous_score(wind_mph: float, rain_in_hr: float, snow_in_hr: float, load_lb: float) -> float:
    a = assess(wind_mph, rain_in_hr, snow_in_hr, load_lb)
    raw = max(
        _continuous(max(0.0, wind_mph or 0.0), WIND_BANDS_MPH),
        _continuous(max(0.0, rain_in_hr or 0.0), RAIN_BANDS_IN_HR),
        _continuous(max(0.0, snow_in_hr or 0.0), SNOW_BANDS_IN_HR),
    )
    # Load rules can raise the discrete level above the raw value: keep the score inside that level.
    if raw < a.level:
        return float(a.level)
    return min(raw, float(a.level) + 0.999) if a.level < Level.NO_TRAVEL else 4.0


def rules_table() -> dict:
    """The thresholds as data, so the UI legend is generated from the same constants the classifier uses."""

    def bands(b, unit, nt_inclusive, fmt):
        # Same wording as the assessment table: integer wind bands end one below the next band
        # ("25-34"); rain/snow bands share their edges ("0.10-0.25") and No Travel is strictly ">".
        m, h, s, n = b
        top = (lambda v: fmt(v - 1)) if nt_inclusive else fmt
        return [
            {"level": "low", "text": f"< {fmt(m)} {unit}"},
            {"level": "moderate", "text": f"{fmt(m)}–{top(h)} {unit}"},
            {"level": "high", "text": f"{fmt(h)}–{top(s)} {unit}"},
            {"level": "severe", "text": f"{fmt(s)}–{top(n)} {unit}"},
            {"level": "no_travel", "text": f"{'≥' if nt_inclusive else '>'} {fmt(n)} {unit}"},
        ]

    def whole(v):
        return f"{v:.0f}"

    def two(v):
        return f"{v:.2f}"

    def one(v):
        return f"{v:.1f}"

    return {
        "levels": [{"key": lvl.key, "label": lvl.label, "score": int(lvl)} for lvl in Level],
        "conditions": [
            {"name": "wind", "unit": "mph", "bands": bands(WIND_BANDS_MPH, "mph", True, whole)},
            {"name": "rain", "unit": "in/hr", "bands": bands(RAIN_BANDS_IN_HR, "in/hr", False, two)},
            {"name": "snow", "unit": "in/hr", "bands": bands(SNOW_BANDS_IN_HR, "in/hr", False, one)},
        ],
        "load_rules": [
            {"text": f"Wind ≥ {WIND_BANDS_MPH[3]:g} mph → No Travel for any load", "level": "no_travel"},
            {
                "text": f"Wind {LOAD_NO_TRAVEL_WIND_MPH[0]:g}–{LOAD_NO_TRAVEL_WIND_MPH[1] - 1:g} mph and load "
                f"> {LOAD_NO_TRAVEL_MIN_LB:,} lb → No Travel",
                "level": "no_travel",
            },
            {
                "text": f"Wind {LOAD_SEVERE_WIND_MPH[0]:g}–{LOAD_SEVERE_WIND_MPH[1] - 1:g} mph and load "
                f"> {LOAD_SEVERE_MIN_LB:,} lb → Severe",
                "level": "severe",
            },
        ],
    }
