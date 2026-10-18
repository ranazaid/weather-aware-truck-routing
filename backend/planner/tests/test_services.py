import json

import pytest
import responses

from planner.domain import geo
from planner.services import corridor, geocoding, routing, weather
from planner.services.http import ProviderError

from . import fakes

A, B = (-100.0, 35.0), (-96.0, 35.0)


# ------------------------------------------------------------------------------ routing


@responses.activate
def test_three_routes_from_osrm_alternatives():
    alts = [
        fakes.line(A, B),
        fakes.line(A, (-98, 36.0), 60) + fakes.line((-98, 36.0), B, 60)[1:],
        fakes.line(A, (-98, 34.0), 60) + fakes.line((-98, 34.0), B, 60)[1:],
    ]
    responses.add_callback(responses.GET, fakes.OSRM, callback=fakes.osrm_callback(alts))
    routes, warnings = routing.get_routes(A, B)
    assert [r.variant for r in routes] == ["fastest", "alternative", "alternative"]
    assert warnings == []
    assert len(responses.calls) == 1  # no detours needed


@responses.activate
def test_detours_fill_up_to_three_routes():
    responses.add_callback(responses.GET, fakes.OSRM, callback=fakes.osrm_callback([fakes.line(A, B)]))
    routes, warnings = routing.get_routes(A, B)
    assert len(routes) == 3 and warnings == []
    assert [r.variant for r in routes] == ["fastest", "detour", "detour"]
    # the two detours bend to opposite sides of the straight route
    mids = [geo.point_at(r.coords, r.cum_mi, r.distance_mi / 2)[1] for r in routes[1:]]
    assert (mids[0] - 35) * (mids[1] - 35) < 0


@responses.activate
def test_near_duplicate_alternative_is_rejected():
    dup = [[x, y + 0.001] for x, y in fakes.line(A, B)]
    responses.add_callback(responses.GET, fakes.OSRM, callback=fakes.osrm_callback([fakes.line(A, B), dup]))
    routes, _ = routing.get_routes(A, B)
    assert all(routing.overlap(r, routes[0]) < routing.MAX_OVERLAP for r in routes[1:])
    assert "alternative" not in [r.variant for r in routes]


@responses.activate
def test_routes_are_cached():
    responses.add_callback(responses.GET, fakes.OSRM, callback=fakes.osrm_callback([fakes.line(A, B)] * 1))
    routing.get_routes(A, B)
    n = len(responses.calls)
    routing.get_routes(A, B)
    assert len(responses.calls) == n


@responses.activate
@pytest.mark.parametrize("code, status", [("NoRoute", 422), ("NoSegment", 422)])
def test_osrm_errors_are_friendly(code, status):
    responses.add(responses.GET, fakes.OSRM, json={"code": code, "message": "x"}, status=400)
    with pytest.raises(ProviderError) as e:
        routing.get_routes(A, B)
    assert e.value.status == status


def test_remove_loops_cuts_out_and_back_spur():
    coords = [(0, 0), (1, 0), (1, 1), (1, 2), (1, 1), (1, 0), (2, 0)]
    seg = [1, 2, 3, 4, 5, 6]
    c, s = routing.remove_loops(coords, seg)
    assert c == [(0, 0), (1, 0), (2, 0)]
    assert s == [1, 6]


def test_parse_route_falls_back_when_annotations_misaligned():
    rt = fakes.osrm_route(fakes.line(A, B, 10))
    rt["legs"][0]["annotation"]["duration"] = [1.0]  # wrong length
    r = routing.parse_osrm_route(rt, "fastest")
    assert len(r.seg_s) == 9 and sum(r.seg_s) == pytest.approx(rt["duration"])
    assert r.roads == ["I 99"]


# ------------------------------------------------------------------------------ weather


def test_cell_snapping():
    assert weather.cell_of((-96.7968, 32.7762)) == (-96.8, 32.8)
    assert weather.cell_of((-96.84, 32.75)) == (-96.8, 32.8)


def _series(wind, rain=None):
    n = len(wind)
    return weather.Series(
        0,
        tuple(wind),
        tuple(None if w is None else w + 5 for w in wind),
        tuple(rain or [0.0] * n),
        tuple([0.0] * n),
        tuple([40.0] * n),
        tuple([0] * n),
    )


def test_sample_interpolates_wind_and_uses_clock_hour_for_precip():
    s = _series([10, 20, 30], rain=[0.0, 0.2, 0.6])
    at = weather.sample(s, 1800)  # 00:30 → between hour 0 and 1; precip of the 00:00-01:00 hour
    assert at["wind_mph"] == pytest.approx(15)
    assert at["rain_in_hr"] == pytest.approx(0.2)
    at = weather.sample(s, 3600)  # exactly 01:00 → the 01:00-02:00 hour
    assert at["wind_mph"] == pytest.approx(20) and at["rain_in_hr"] == pytest.approx(0.6)


def test_sample_outside_window_is_unknown():
    s = _series([10, 20])
    assert weather.sample(s, -1) is None
    assert weather.sample(s, 3601) is None


def test_sample_missing_wind_is_unknown():
    s = _series([None, None])
    assert weather.sample(s, 100) is None


def test_window_covers_trip_and_slider():
    start, end = weather.window(10_000, 10_000 + 3 * 3600)
    assert start == 7200 and end >= 10_000 + 48 * 3600


@responses.activate
def test_fetch_batches_and_caches():
    calls = []
    responses.add_callback(responses.GET, fakes.METEO, callback=fakes.meteo_callback(calls=calls))
    cells = [(round(-100 + i * 0.1, 1), 35.0) for i in range(120)]
    out = weather.fetch(cells + cells[:5], 0, 7200)
    assert len(out) == 120
    assert sorted(calls) == [20, 50, 50]
    weather.fetch(cells, 0, 7200)
    assert len(calls) == 3  # served from cache


@responses.activate
def test_fetch_single_location_object():
    responses.add_callback(responses.GET, fakes.METEO, callback=fakes.meteo_callback())
    out = weather.fetch([(-100.0, 35.0)], 0, 7200)
    assert list(out) == [(-100.0, 35.0)]


@responses.activate
def test_open_meteo_error_reason_is_surfaced():
    responses.add(responses.GET, fakes.METEO, json={"error": True, "reason": "end_hour out of range"}, status=400)
    with pytest.raises(ProviderError) as e:
        weather.fetch([(-100.0, 35.0)], 0, 7200)
    assert "out of range" in e.value.message


# ------------------------------------------------------------------------------ corridor


def test_corridor_cells_are_capped_and_cover_both_sides():
    coords = [tuple(c) for c in fakes.line((-110.0, 35.0), (-80.0, 35.0), 300)]
    cum = geo.cumulative_miles(coords)
    cells = corridor.corridor_cells([(coords, cum)])
    assert 50 < len(cells) <= corridor.MAX_CELLS
    lats = {lat for _, lat in cells}
    assert min(lats) < 34.6 and max(lats) > 35.4  # ~40 mi ≈ 0.58° either side


@responses.activate
def test_heatmap_frames_shape_and_scores():
    responses.add_callback(responses.GET, fakes.METEO, callback=fakes.meteo_callback(lambda lon, lat, h: 30 + h % 5))
    coords = [tuple(c) for c in fakes.line(A, B)]
    data = corridor.build([(coords, geo.cumulative_miles(coords))], 0, 10_000, (0, 52 * 3600))
    n = len(data["points"])
    assert len(data["metrics"]["risk"]) == 49
    assert all(len(f) == n for f in data["metrics"]["wind"])
    assert all(1 <= v < 2 for v in data["metrics"]["risk"][0])  # 30 mph = Moderate
    json.dumps(data)  # serialisable


# ------------------------------------------------------------------------------ geocoding


def test_coordinates_typed_directly():
    assert geocoding.search("32.7767, -96.797")[0]["lat"] == pytest.approx(32.7767)
    assert geocoding.parse_coordinates("100, 200") is None


@responses.activate
def test_photon_results_and_fallback():
    responses.add(responses.GET, "https://photon.komoot.io/api/", status=503, json={})
    responses.add(
        responses.GET,
        "https://nominatim.openstreetmap.org/search",
        json=[{"name": "Dallas", "lat": "32.77", "lon": "-96.79", "address": {"state": "Texas", "country_code": "us"}}],
    )
    out = geocoding.search("Dallas")
    assert out == [{"label": "Dallas, Texas, US", "lat": 32.77, "lon": -96.79, "kind": None}]


@responses.activate
def test_photon_labels_and_dedupe():
    feats = [
        {
            "geometry": {"coordinates": [-96.79, 32.77]},
            "properties": {"name": "Dallas", "state": "Texas", "countrycode": "US", "type": "city"},
        },
        {
            "geometry": {"coordinates": [-96.78, 32.76]},
            "properties": {"name": "Dallas", "state": "Texas", "countrycode": "US", "type": "county"},
        },
        {
            "geometry": {"coordinates": [-96.79, 32.77]},
            "properties": {"name": "Dallas", "state": "Texas", "countrycode": "US", "type": "city"},
        },
    ]
    responses.add(responses.GET, "https://photon.komoot.io/api/", json={"features": feats})
    labels = [r["label"] for r in geocoding.search("Dallas")]
    assert labels == ["Dallas, Texas, US", "Dallas County, Texas, US"]
