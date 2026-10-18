import pytest

from planner.domain import geo

DALLAS = (-96.797, 32.7767)
DENVER = (-104.9903, 39.7392)


def test_haversine_known_distance():
    # Great-circle Dallas-Denver is about 663 miles.
    assert geo.haversine_mi(DALLAS, DENVER) == pytest.approx(663, abs=5)
    assert geo.haversine_mi(DALLAS, DALLAS) == 0


def test_cumulative_and_point_at():
    coords = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)]
    cum = geo.cumulative_miles(coords)
    assert cum[0] == 0 and cum[1] == pytest.approx(cum[2] / 2)
    mid = geo.point_at(coords, cum, cum[-1] / 2)
    assert mid == pytest.approx((1.0, 0.0))
    quarter = geo.point_at(coords, cum, cum[-1] / 4)
    assert quarter == pytest.approx((0.5, 0.0))


def test_point_at_clamps_outside_the_line():
    coords = [(0.0, 0.0), (1.0, 0.0)]
    cum = geo.cumulative_miles(coords)
    assert geo.point_at(coords, cum, -5) == (0.0, 0.0)
    assert geo.point_at(coords, cum, cum[-1] + 5) == pytest.approx((1.0, 0.0))


def test_locate_handles_duplicate_vertices():
    cum = [0.0, 10.0, 10.0, 20.0]
    i, t = geo.locate(cum, 10.0)
    assert 0 <= t <= 1
    assert cum[i] <= 10.0 <= cum[i + 1]


def test_value_at_interpolates():
    cum = [0.0, 100.0]
    assert geo.value_at(cum, [0.0, 3600.0], 25) == pytest.approx(900.0)


def test_bearing_and_destination_round_trip():
    assert geo.bearing_deg((0, 0), (0, 1)) == pytest.approx(0, abs=1e-6)
    assert geo.bearing_deg((0, 0), (1, 0)) == pytest.approx(90, abs=1e-6)
    p = geo.destination(DALLAS, 45, 100)
    assert geo.haversine_mi(DALLAS, p) == pytest.approx(100, rel=1e-6)


def test_offset_perpendicular_sides():
    a, b = (0.0, 0.0), (0.0, 1.0)  # heading north
    right = geo.offset_perpendicular(a, b, a, 10)
    left = geo.offset_perpendicular(a, b, a, -10)
    assert right[0] > 0 > left[0]  # east is right of north
    assert geo.haversine_mi(a, right) == pytest.approx(10, rel=1e-6)


def test_simplify_keeps_shape_and_endpoints():
    line = [(x / 100, 0.0) for x in range(101)] + [(1.0, 0.5)]
    out = geo.simplify(line)
    assert out[0] == line[0] and out[-1] == line[-1]
    assert (1.0, 0.0) in out  # the corner survives
    assert len(out) == 3


def test_simplify_short_lines_untouched():
    assert geo.simplify([(0, 0)]) == [(0, 0)]
    assert geo.simplify([(0, 0), (1, 1)]) == [(0, 0), (1, 1)]


def test_bbox():
    assert geo.bbox([DALLAS, DENVER]) == (DENVER[0], DALLAS[1], DALLAS[0], DENVER[1])


def test_sample_points_spacing_and_ends():
    coords = [(0.0, 0.0), (1.0, 0.0)]
    cum = geo.cumulative_miles(coords)
    pts = geo.sample_points(coords, cum, cum[-1] / 4)
    assert len(pts) == 5
    assert pts[0] == coords[0] and pts[-1] == pytest.approx(coords[-1])


def test_slice_line_interpolates_and_keeps_inner_vertices():
    coords = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0)]
    cum = geo.cumulative_miles(coords)
    seg = geo.slice_line(coords, cum, cum[1] / 2, cum[2] + cum[1] / 2)
    assert seg[0] == pytest.approx((0.5, 0.0))
    assert seg[1:-1] == [(1.0, 0.0), (2.0, 0.0)]
    assert seg[-1] == pytest.approx((2.5, 0.0))


def test_slice_line_on_vertex_boundaries_has_no_duplicates():
    coords = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)]
    cum = geo.cumulative_miles(coords)
    seg = geo.slice_line(coords, cum, cum[1], cum[2])
    assert seg == pytest.approx([(1.0, 0.0), (2.0, 0.0)])
