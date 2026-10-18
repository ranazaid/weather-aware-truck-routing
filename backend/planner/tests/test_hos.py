import pytest

from planner.domain import hos

H = hos.HOUR


def test_short_trip_needs_no_stops():
    assert hos.schedule(7.9 * H) == []
    assert hos.schedule(8 * H) == []  # arrives exactly at the 8-hour mark


def test_break_after_eight_hours():
    stops = hos.schedule(10 * H)
    assert [s.kind for s in stops] == ["break"]
    assert stops[0].at_drive_s == pytest.approx(8 * H)
    assert hos.total_elapsed(10 * H, stops) == pytest.approx(10.5 * H)


def test_eleven_hour_limit_forces_reset():
    stops = hos.schedule(12 * H)
    assert [s.kind for s in stops] == ["break", "rest"]
    assert stops[1].at_drive_s == pytest.approx(11 * H)
    assert stops[1].start_elapsed_s == pytest.approx(11.5 * H)
    assert hos.total_elapsed(12 * H, stops) == pytest.approx(22.5 * H)


def test_multi_day_trip_cycles():
    stops = hos.schedule(31 * H)  # last cycle is 9 h: needs its break
    assert [s.kind for s in stops] == ["break", "rest", "break", "rest", "break"]
    rests = [s for s in stops if s.kind == "rest"]
    assert [s.at_drive_s for s in rests] == pytest.approx([11 * H, 22 * H])


def test_elapsed_for_adds_only_earlier_stops():
    stops = hos.schedule(12 * H)
    assert hos.elapsed_for(4 * H, stops) == pytest.approx(4 * H)
    assert hos.elapsed_for(9 * H, stops) == pytest.approx(9.5 * H)
    assert hos.elapsed_for(12 * H, stops) == pytest.approx(22.5 * H)


def test_stop_serialises():
    d = hos.schedule(9 * H)[0].as_dict()
    assert d["label"] == "30-min break" and d["duration_s"] == 1800


@pytest.mark.parametrize("drive_h", [0, 3, 7.99, 8.5, 10.9, 11.2, 15, 21.9, 23])
def test_drive_for_inverts_elapsed_for(drive_h):
    stops = hos.schedule(24 * H)
    elapsed = hos.elapsed_for(drive_h * H, stops)
    assert hos.drive_for(elapsed, stops) == pytest.approx(drive_h * H)


def test_drive_for_is_parked_during_stops():
    stops = hos.schedule(24 * H)
    rest = next(s for s in stops if s.kind == "rest")
    assert hos.drive_for(rest.start_elapsed_s + 5 * H, stops) == pytest.approx(rest.at_drive_s)
    brk = stops[0]
    assert hos.drive_for(brk.start_elapsed_s + 600, stops) == pytest.approx(8 * H)
