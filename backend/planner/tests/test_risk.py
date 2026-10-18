import math

import pytest

from planner.domain.risk import (
    Level,
    assess,
    classify_rain,
    classify_snow,
    classify_wind,
    continuous_score,
    wind_level_for_load,
)

L, M, H, S, N = Level.LOW, Level.MODERATE, Level.HIGH, Level.SEVERE, Level.NO_TRAVEL


@pytest.mark.parametrize(
    "mph, expected",
    [
        (0, L), (24.9, L),
        (25, M), (34.9, M),
        (35, H), (44.9, H),
        (45, S), (54.9, S),
        (55, N), (80, N),
    ],
)
def test_wind_bands(mph, expected):
    assert classify_wind(mph) is expected


@pytest.mark.parametrize(
    "rate, expected",
    [
        (0, L), (0.099, L),
        (0.10, M), (0.249, M),
        (0.25, H), (0.499, H),
        (0.50, S), (1.00, S),  # "> 1.00" is No Travel, so exactly 1.00 is still Severe
        (1.001, N), (3, N),
    ],
)
def test_rain_bands(rate, expected):
    assert classify_rain(rate) is expected


@pytest.mark.parametrize(
    "rate, expected",
    [
        (0, L), (0.49, L),
        (0.5, M), (0.99, M),
        (1.0, H), (1.99, H),
        (2.0, S), (3.0, S),  # "> 3.0" is No Travel
        (3.01, N),
    ],
)
def test_snow_bands(rate, expected):
    assert classify_snow(rate) is expected


@pytest.mark.parametrize(
    "mph, load, expected, raised",
    [
        # >= 55 mph: No Travel for any load
        (55, 0, N, False),
        (60, 80_000, N, False),
        # 45-54 mph: No Travel only above 30,000 lb
        (45, 30_000, S, False),
        (45, 30_001, N, True),
        (54.9, 45_000, N, True),
        # 35-44 mph: Severe only above 40,000 lb
        (35, 40_000, H, False),
        (35, 40_001, S, True),
        (44.9, 80_000, S, True),
        # below 35 mph no load rule applies
        (34.9, 80_000, M, False),
        (10, 80_000, L, False),
    ],
)
def test_load_rules(mph, load, expected, raised):
    level, rule = wind_level_for_load(mph, load)
    assert level is expected
    assert (rule is not None) is raised


def test_assess_takes_worst_factor_and_names_drivers():
    a = assess(wind_mph=20, rain_in_hr=0.3, snow_in_hr=0.6, load_lb=10_000)
    assert a.level is H
    assert [f.name for f in a.drivers] == ["rain"]


def test_assess_ties_list_every_driver():
    a = assess(wind_mph=40, rain_in_hr=0.3, snow_in_hr=0, load_lb=10_000)
    assert a.level is H
    assert {f.name for f in a.drivers} == {"wind", "rain"}


def test_assess_load_rule_is_reported():
    a = assess(wind_mph=40, rain_in_hr=0, snow_in_hr=0, load_lb=42_000)
    assert a.level is S
    wind = a.factors[0]
    assert wind.rule and "40,000" in wind.rule
    assert a.as_dict()["drivers"] == ["wind"]


def test_assess_calm_has_no_drivers_and_clamps_bad_input():
    a = assess(wind_mph=-3, rain_in_hr=None, snow_in_hr=-0.1, load_lb=0)
    assert a.level is L
    assert a.drivers == []
    assert all(f.value >= 0 for f in a.factors)


@pytest.mark.parametrize(
    "wind, rain, snow, load",
    [
        (0, 0, 0, 0),
        (24.99, 0, 0, 0),
        (25, 0, 0, 0),
        (40, 0, 0, 45_000),  # load raises High -> Severe
        (50, 0, 0, 35_000),  # load raises Severe -> No Travel
        (0, 1.0, 0, 0),
        (0, 1.0001, 0, 0),
        (0, 0, 3.0, 0),
        (30, 0.2, 1.5, 20_000),
        (70, 2, 4, 80_000),
    ],
)
def test_continuous_score_floor_matches_discrete_level(wind, rain, snow, load):
    score = continuous_score(wind, rain, snow, load)
    assert 0 <= score <= 4
    assert math.floor(score) == int(assess(wind, rain, snow, load).level)


def test_continuous_score_is_monotonic_in_wind():
    scores = [continuous_score(w, 0, 0, 0) for w in range(0, 70)]
    assert scores == sorted(scores)


def test_rules_table_matches_the_assessment_wording():
    from planner.domain.risk import rules_table

    t = rules_table()
    text = {c["name"]: [b["text"] for b in c["bands"]] for c in t["conditions"]}
    assert text["wind"] == ["< 25 mph", "25–34 mph", "35–44 mph", "45–54 mph", "≥ 55 mph"]
    assert text["rain"] == ["< 0.10 in/hr", "0.10–0.25 in/hr", "0.25–0.50 in/hr", "0.50–1.00 in/hr", "> 1.00 in/hr"]
    assert text["snow"] == ["< 0.5 in/hr", "0.5–1.0 in/hr", "1.0–2.0 in/hr", "2.0–3.0 in/hr", "> 3.0 in/hr"]
    assert [r["text"] for r in t["load_rules"]] == [
        "Wind ≥ 55 mph → No Travel for any load",
        "Wind 45–54 mph and load > 30,000 lb → No Travel",
        "Wind 35–44 mph and load > 40,000 lb → Severe",
    ]
