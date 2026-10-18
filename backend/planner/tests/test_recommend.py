import pytest

from planner.domain.recommend import explain, rank, summarize
from planner.domain.risk import Level

L, M, H, S, N = Level.LOW, Level.MODERATE, Level.HIGH, Level.SEVERE, Level.NO_TRAVEL


def route(label, segments, duration_h=10.0):
    dist = sum(m for m, _ in segments)
    return summarize(f"r{label}", label, dist, duration_h * 3600, segments)


def test_summarize_totals_and_average():
    s = route("A", [(50, L), (30, H), (20, S), (10, None)])
    assert s.miles_by_level == {L: 50, H: 30, S: 20}
    assert s.unknown_mi == 10
    assert s.avg_risk == pytest.approx((0 * 50 + 2 * 30 + 3 * 20) / 100)
    assert s.max_level is S
    d = s.as_dict()
    assert d["miles_by_level"]["no_travel"] == 0 and d["max_level"] == "severe"


def test_fewest_severe_wins_even_if_more_high_and_slower():
    a = route("A", [(80, L), (20, S)], duration_h=8)
    b = route("B", [(10, L), (90, H)], duration_h=12)
    assert rank([a, b])[0] is b
    rec = explain([a, b])
    assert rec["label"] == "B"
    assert rec["comparisons"][0]["criterion"] == "Severe miles"


def test_high_miles_break_severe_tie():
    a = route("A", [(90, L), (10, S), (40, H)])
    b = route("B", [(90, L), (10, S), (20, H)])
    rec = explain([a, b])
    assert rec["label"] == "B" and rec["comparisons"][0]["criterion"] == "High miles"


def test_average_risk_breaks_high_tie():
    a = route("A", [(50, M), (50, L)])
    b = route("B", [(10, M), (90, L)])
    rec = explain([a, b])
    assert rec["label"] == "B" and rec["comparisons"][0]["criterion"] == "average risk"


def test_travel_time_is_last_tie_break():
    a = route("A", [(100, L)], duration_h=9)
    b = route("B", [(100, L)], duration_h=8)
    rec = explain([a, b])
    assert rec["label"] == "B" and rec["comparisons"][0]["criterion"] == "travel time"
    assert "8h 00m" in rec["comparisons"][0]["text"]


def test_no_travel_miles_rank_before_severe():
    a = route("A", [(1, N), (99, L)])
    b = route("B", [(50, S), (50, L)])
    assert explain([a, b])["label"] == "B"


def test_floating_noise_does_not_decide():
    a = route("A", [(10.00001, S), (90, L)], duration_h=8)
    b = route("B", [(10.0, S), (90, L)], duration_h=9)
    assert explain([a, b])["label"] == "A"  # equal Severe at 0.1 mi; faster wins


def test_identical_routes_are_deterministic():
    a = route("A", [(100, L)])
    b = route("B", [(100, L)])
    rec = explain([b, a])
    assert rec["label"] == "A"
    assert "equivalent" in rec["comparisons"][0]["text"]


def test_headlines():
    assert "No High or Severe" in explain([route("A", [(100, L)])])["headline"]
    assert "High-risk" in explain([route("A", [(20, H), (80, L)])])["headline"]
    assert "Severe" in explain([route("A", [(20, S), (80, L)])])["headline"]
    assert "No Travel" in explain([route("A", [(20, N), (80, L)])])["headline"]


def test_three_routes_ordered():
    a = route("A", [(30, S), (70, L)])
    b = route("B", [(10, S), (90, L)])
    c = route("C", [(100, L)])
    rec = explain([a, b, c])
    assert rec["order"] == ["rC", "rB", "rA"]
    assert len(rec["comparisons"]) == 2


def test_explain_requires_routes():
    with pytest.raises(ValueError):
        explain([])


def test_departure_advice_suggests_the_earliest_safer_time():
    from planner.domain.recommend import departure_advice

    now = route("A", [(40, S), (60, L)])
    later = [(3, route("A", [(20, S), (80, L)])), (6, route("B", [(100, L)])), (12, route("A", [(100, L)]))]
    advice = departure_advice(now, later)
    assert advice["best_offset_h"] == 6
    assert advice["text"] == "Leaving 6 h later is safer: Route B cuts Severe miles from 40.0 mi to 0.0 mi."
    assert [o["offset_h"] for o in advice["options"]] == [0, 3, 6, 12]
    assert advice["options"][0]["severe_mi"] == 40


def test_departure_advice_stays_quiet_when_now_is_already_safest():
    from planner.domain.recommend import departure_advice

    now = route("A", [(100, L)], duration_h=8)
    advice = departure_advice(now, [(3, route("A", [(100, L)], duration_h=7)), (6, route("A", [(50, H), (50, L)]))])
    assert advice["best_offset_h"] == 0 and advice["text"] is None
