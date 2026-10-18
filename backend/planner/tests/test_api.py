from datetime import UTC, datetime, timedelta

import pytest
import requests
import responses
from rest_framework.test import APIClient

from . import fakes

A, B = (-100.0, 35.0), (-96.0, 35.0)


@pytest.fixture
def client():
    return APIClient()


def body(**over):
    data = {
        "origin": {"lat": A[1], "lon": A[0], "label": "West"},
        "destination": {"lat": B[1], "lon": B[0], "label": "East"},
        "departure": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        "load_lb": 20_000,
        "interval_mi": 25,
        "hos": True,
    }
    data.update(over)
    return data


def mock_providers(wind_for=lambda lon, lat, h: 10.0, rain=0.0, snow=0.0):
    responses.add_callback(responses.GET, fakes.OSRM, callback=fakes.osrm_callback([fakes.line(A, B)]))
    responses.add_callback(responses.GET, fakes.METEO, callback=fakes.meteo_callback(wind_for, rain, snow))


def test_health_and_meta(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    meta = client.get("/api/meta").json()
    assert meta["intervals_mi"] == [10, 25, 50]
    assert [c["name"] for c in meta["rules"]["conditions"]] == ["wind", "rain", "snow"]


@responses.activate
def test_plan_happy_path(client):
    mock_providers()
    r = client.post("/api/plan", body(), format="json")
    assert r.status_code == 200, r.content
    p = r.json()
    assert len(p["routes"]) == 3
    for route in p["routes"]:
        cps = route["checkpoints"]
        assert cps[0]["mile"] == 0 and cps[-1]["mile"] == pytest.approx(route["distance_mi"], abs=0.1)
        assert sum(route["summary"]["miles_by_level"].values()) == pytest.approx(route["distance_mi"], abs=0.5)
        assert all(cp["risk"]["level"] == "low" for cp in cps)
        assert route["segments"][0]["coordinates"]
        assert route["track"][0][0] == 0 and route["track"][-1][0] == route["duration_s"]
    assert p["recommendation"]["label"] == "A"  # all calm: the fastest wins on travel time
    assert p["recommendation"]["comparisons"][0]["criterion"] == "travel time"


@responses.activate
def test_load_rule_changes_recommendation(client):
    # 40 mph wind north of 35.2°N: the detour bending north crosses it, the others do not.
    mock_providers(wind_for=lambda lon, lat, h: 40.0 if lat > 35.2 else 10.0)
    heavy = client.post("/api/plan", body(load_lb=45_000), format="json").json()
    north = next(r for r in heavy["routes"] if max(c["lat"] for c in r["checkpoints"]) > 35.3)
    assert north["summary"]["miles_by_level"]["severe"] > 0  # 35-44 mph with > 40,000 lb → Severe
    assert heavy["recommendation"]["route_id"] != north["id"]
    light = client.post("/api/plan", body(load_lb=20_000), format="json").json()
    north_light = next(r for r in light["routes"] if r["id"] == north["id"])
    assert north_light["summary"]["miles_by_level"]["severe"] == 0
    assert north_light["summary"]["miles_by_level"]["high"] > 0


@responses.activate
def test_hos_moves_late_checkpoints_later(client):
    far = (-80.0, 35.0)  # ~1,130 miles: needs a break and a 10-hour reset
    responses.add_callback(responses.GET, fakes.OSRM, callback=fakes.osrm_callback([fakes.line(A, far, 400)]))
    responses.add_callback(responses.GET, fakes.METEO, callback=fakes.meteo_callback())
    payload = body(destination={"lat": far[1], "lon": far[0], "label": "Far"})
    with_hos = client.post("/api/plan", payload, format="json").json()["routes"][0]
    without = client.post("/api/plan", {**payload, "hos": False}, format="json").json()["routes"][0]
    assert with_hos["stops"] and not without["stops"]
    assert with_hos["duration_s"] > without["duration_s"]
    assert with_hos["checkpoints"][-1]["elapsed_s"] > without["checkpoints"][-1]["elapsed_s"]


@responses.activate
def test_heatmap_endpoint(client):
    mock_providers()
    plan_id = client.post("/api/plan", body(), format="json").json()["plan_id"]
    h = client.get(f"/api/plans/{plan_id}/heatmap")
    assert h.status_code == 200
    assert len(h.json()["metrics"]["risk"]) == 49
    missing = client.get("/api/plans/nope/heatmap")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "plan_expired"


@pytest.mark.parametrize(
    "over, field",
    [
        ({"load_lb": -1}, "load_lb"),
        ({"load_lb": 90_000}, "load_lb"),
        ({"interval_mi": 15}, "interval_mi"),
        ({"departure": "2020-01-01T00:00:00Z"}, "departure"),
        ({"departure": (datetime.now(UTC) + timedelta(days=9)).isoformat()}, "departure"),
        ({"origin": {"lat": 120, "lon": 0}}, "origin"),
        ({"origin": "x"}, "origin"),
        ({"destination": {"lat": A[1], "lon": A[0]}}, "destination"),
    ],
)
def test_validation_errors_have_one_shape(client, over, field):
    r = client.post("/api/plan", body(**over), format="json")
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "invalid" and field in err["fields"] and err["message"]


@responses.activate
def test_provider_failure_is_a_clean_502(client):
    responses.add(responses.GET, fakes.OSRM, body=requests.ConnectionError("down"))
    r = client.post("/api/plan", body(), format="json")
    assert r.status_code == 502
    assert "OSRM" in r.json()["error"]["message"]


def test_geocode_validation_and_coordinates(client):
    assert client.get("/api/geocode?q=a").status_code == 400
    r = client.get("/api/geocode", {"q": "35.0, -100.0"})
    assert r.json()["results"][0]["lon"] == -100.0


def test_spa_fallback(client):
    r = client.get("/some/client/route")
    assert r.status_code == 200 and b"<" in r.content


@responses.activate
def test_what_if_scenario_is_applied_and_labelled(client):
    mock_providers(wind_for=lambda lon, lat, h: 20.0)  # Low on its own
    real = client.post("/api/plan", body(load_lb=45_000), format="json").json()
    assert real["request"]["scenario"] is None
    assert all(r["summary"]["max_level"] == "low" for r in real["routes"])

    p = client.post("/api/plan", body(load_lb=45_000, scenario={"wind_add_mph": 18}), format="json").json()
    # 38 mph with > 40,000 lb → Severe through the load rule
    assert all(r["summary"]["max_level"] == "severe" for r in p["routes"])
    assert p["routes"][0]["checkpoints"][0]["weather"]["wind_mph"] == 38.0
    assert p["request"]["scenario"]["text"] == "+18 mph wind"
    assert p["warnings"][0].startswith("What-if scenario")
    h = client.get(f"/api/plans/{p['plan_id']}/heatmap").json()
    assert all(3 <= v < 4 for v in h["metrics"]["risk"][0])


def test_scenario_bounds_are_validated(client):
    r = client.post("/api/plan", body(scenario={"wind_add_mph": 99}), format="json")
    assert r.status_code == 400 and "scenario" in r.json()["error"]["fields"]
