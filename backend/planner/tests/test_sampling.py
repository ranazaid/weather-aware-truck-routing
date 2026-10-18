import pytest

from planner.domain import geo
from planner.domain.sampling import checkpoint_miles, place_checkpoints, truck_adjusted_durations


@pytest.mark.parametrize(
    "total, interval, expected",
    [
        (100, 25, [0, 25, 50, 75, 100]),
        (110, 25, [0, 25, 50, 75, 100, 110]),
        (10, 50, [0, 10]),
        (50, 50, [0, 50]),  # destination not duplicated when it lands on the interval
        (0, 10, [0]),
    ],
)
def test_checkpoint_miles(total, interval, expected):
    assert checkpoint_miles(total, interval) == pytest.approx(expected)


def test_checkpoint_miles_rejects_bad_interval():
    with pytest.raises(ValueError):
        checkpoint_miles(100, 0)


def _straight_route(n=200):
    coords = [(-100.0 + i * 0.02, 35.0) for i in range(n)]
    cum = geo.cumulative_miles(coords)
    drive = [m / 60 * 3600 for m in cum]  # 60 mph
    return coords, cum, drive


@pytest.mark.parametrize("interval", [10, 25, 50])
def test_owned_miles_sum_to_route_length(interval):
    coords, cum, drive = _straight_route()
    cps = place_checkpoints(coords, cum, drive, interval)
    assert sum(c.owned_mi for c in cps) == pytest.approx(cum[-1])
    assert cps[0].mile == 0 and cps[-1].mile == pytest.approx(cum[-1])
    # contiguous, non-overlapping ownership
    for a, b in zip(cps, cps[1:], strict=False):
        assert a.owned_to_mi == pytest.approx(b.owned_from_mi)
    # ETAs follow the drive-time series
    assert cps[1].drive_s == pytest.approx(cps[1].mile * 60)


def test_place_checkpoints_validates_lengths():
    with pytest.raises(ValueError):
        place_checkpoints([(0, 0), (1, 0)], [0, 1], [0], 10)


def test_truck_speed_cap_slows_fast_segments_only():
    seg_mi = [70.0, 30.0]
    seg_s = [3600.0, 3600.0]  # 70 mph then 30 mph
    cum = truck_adjusted_durations(seg_mi, seg_s, 65)
    assert cum[1] == pytest.approx(70 / 65 * 3600)
    assert cum[2] - cum[1] == pytest.approx(3600.0)


def test_truck_speed_cap_disabled():
    assert truck_adjusted_durations([70.0], [3600.0], None) == [0.0, 3600.0]
