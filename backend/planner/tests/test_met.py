import pytest
import responses

from planner.services import met, weather
from planner.services.http import ProviderError

from . import fakes

T0 = 1_800_000_000  # on the hour
H = 3600


def iso(t):
    from datetime import UTC, datetime

    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def step(t, wind_ms, temp_c, mm1=None, sym1=None, mm6=None, sym6=None):
    data = {"instant": {"details": {"wind_speed": wind_ms, "air_temperature": temp_c}}}
    if mm1 is not None:
        data["next_1_hours"] = {"summary": {"symbol_code": sym1}, "details": {"precipitation_amount": mm1}}
    if mm6 is not None:
        data["next_6_hours"] = {"summary": {"symbol_code": sym6}, "details": {"precipitation_amount": mm6}}
    return {"time": iso(t), "data": data}


def doc():
    # hourly for three hours, then one 6-hour step
    return {
        "properties": {
            "timeseries": [
                step(T0, 10.0, 12.0, mm1=0.0, sym1="cloudy"),
                step(T0 + H, 20.0, 12.0, mm1=5.08, sym1="heavyrain"),
                step(T0 + 2 * H, 20.0, -2.0, mm1=2.54, sym1="snow"),
                step(T0 + 3 * H, 10.0, 0.0, mm6=12.0, sym6="lightsnow"),
                step(T0 + 9 * H, 10.0, 5.0, mm6=0.0, sym6="clearsky_day"),
            ]
        }
    }


def test_converts_units_and_splits_rain_from_snow():
    s = met.to_series(doc(), T0, T0 + 8 * H)
    assert s.wind[0] == pytest.approx(22.37, abs=0.01)  # 10 m/s in mph
    assert s.temp[0] == pytest.approx(53.6)  # 12 C in F
    assert s.gust[0] is None
    # the hour ending at T0+2h is covered by the step at T0+1h: 5.08 mm of rain = 0.2 in/hr
    assert s.rain[2] == pytest.approx(0.2) and s.snow[2] == 0
    assert s.code[2] == 65
    # the hour ending at T0+3h: 2.54 mm water as snow at 10:1 = 1.0 in/hr
    assert s.snow[3] == pytest.approx(1.0) and s.rain[3] == 0
    # 6-hour block: 12 mm over 6 h = 2 mm/hr water, frozen -> 0.787 in/hr of snow
    assert s.snow[5] == pytest.approx(2 / 25.4 * 10)


def test_symbol_decides_before_temperature():
    assert met._frozen("heavyrain", -3.0) is False  # freezing rain is still rain for the rules
    assert met._frozen("lightsnow", 2.0) is True
    assert met._frozen("cloudy", 0.0) is True
    assert met._frozen(None, 5.0) is False


def test_interpolates_wind_between_steps():
    s = met.to_series(doc(), T0, T0 + 8 * H)
    assert s.wind[6] == pytest.approx(22.37, abs=0.01)  # 10 m/s both sides of the 6-hour gap


@responses.activate
def test_open_meteo_rate_limit_falls_back_to_met(settings):
    settings.PROVIDERS = {
        **settings.PROVIDERS,
        "MET_URL": "https://api.met.no/weatherapi/locationforecast/2.0/complete",
    }
    responses.add(responses.GET, fakes.METEO, status=429, json={"error": True, "reason": "Minutely API request limit"})
    responses.add(responses.GET, "https://api.met.no/weatherapi/locationforecast/2.0/complete", json=doc())
    out = weather.fetch([(-100.0, 35.0), (-99.0, 35.0)], T0, T0 + 8 * H)
    assert len(out) == 2 and out.backup_cells == 2
    assert weather.sample(out[(-100.0, 35.0)], T0 + 1.5 * H)["rain_in_hr"] == pytest.approx(0.2)


@responses.activate
def test_when_both_providers_fail_the_primary_error_is_reported(settings):
    settings.PROVIDERS = {
        **settings.PROVIDERS,
        "MET_URL": "https://api.met.no/weatherapi/locationforecast/2.0/complete",
    }
    responses.add(responses.GET, fakes.METEO, status=429, json={"error": True, "reason": "Minutely API request limit"})
    responses.add(responses.GET, "https://api.met.no/weatherapi/locationforecast/2.0/complete", status=503, body="")
    with pytest.raises(ProviderError) as e:
        weather.fetch([(-100.0, 35.0)], T0, T0 + 8 * H)
    assert e.value.code == "rate_limited"


@responses.activate
def test_plan_reports_the_backup_source(client_settings=None):
    from rest_framework.test import APIClient

    from .test_api import body

    responses.add_callback(
        responses.GET, fakes.OSRM, callback=fakes.osrm_callback([fakes.line((-100.0, 35.0), (-96.0, 35.0))])
    )
    responses.add(responses.GET, fakes.METEO, status=429, json={"error": True, "reason": "Minutely API request limit"})

    # MET answers with a calm forecast that covers any window
    def met_cb(request):
        import json
        import time

        start = int(time.time()) // 3600 * 3600 - 2 * H
        steps = [step(start + k * H, 3.0, 15.0, mm1=0.0, sym1="clearsky_day") for k in range(24 * 9)]
        return 200, {}, json.dumps({"properties": {"timeseries": steps}})

    responses.add_callback(
        responses.GET, "https://api.met.no/weatherapi/locationforecast/2.0/complete", callback=met_cb
    )
    p = APIClient().post("/api/plan", body(), format="json").json()
    assert p["forecast_window"]["source"] == "MET Norway"
    assert all(cp["weather"] is not None for r in p["routes"] for cp in r["checkpoints"])
