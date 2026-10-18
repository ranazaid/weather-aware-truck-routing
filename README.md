# RouteCast · weather-aware truck routing

Plan a truck trip around the weather. RouteCast finds **three road routes**, works out **when the truck will be at every checkpoint** (including driver breaks), reads the **forecast for that exact hour**, scores the risk with the assessment's thresholds and load rules, and **recommends the safest route with a rule-by-rule explanation**. A **48-hour corridor heatmap** with a time slider shows how conditions move along the routes and where each truck is at any hour.

**Live app:** _add the hosted URL here_ · **Walkthrough:** _add the Loom URL here_

![Route plan with a what-if wind scenario: risk-coloured routes, corridor heatmap, decision table](docs/screenshots/plan-what-if.png)

| Checkpoint detail at the truck's ETA | Phone layout |
|---|---|
| ![Checkpoint popup and timeline](docs/screenshots/checkpoint.png) | <img src="docs/screenshots/mobile.png" width="300" alt="Mobile layout"> |

---

## Requirements → where they live

| Requirement | Implementation |
|---|---|
| Origin, destination, departure date/time, load weight | `TripForm` with place autocomplete (or `lat, lon`), quick times, load presets, client + server validation |
| 3 route options from a routing API | `services/routing.py`: OSRM alternatives, topped up with detours through via points either side of the fastest route; near-duplicates (≥ 80 % shared road) and very slow options rejected |
| Weather every 10 / 25 / 50 miles at the truck's ETA | `domain/sampling.py` places checkpoints, `domain/hos.py` adds FMCSA breaks/resets, `services/weather.py` reads Open-Meteo at each ETA |
| Risk levels from the thresholds and load rules | `domain/risk.py`: table-driven, every boundary tested |
| Recommend by Severe → High → average risk → time | `domain/recommend.py`: lexicographic key + "which rule decided" explanation, shown as a decision table |
| Map with routes, checkpoints, risk, ETAs, summaries | MapLibre GL: risk-coloured route segments, checkpoint popups, HOS stops, route cards, checkpoint timeline |
| Corridor heatmap + 0–48 h forecast slider | `services/corridor.py` precomputes 49 hourly frames over a ±40 mi band; the slider only swaps GPU feature state, so playback is smooth |

## How a plan is built

```
origin, destination ─► OSRM ─► 3 distinct routes (per-segment durations)
                                   │
                    truck speed cap (65 mph) + FMCSA hours of service
                                   │
                 checkpoints every N mi, each with drive time and wall-clock ETA
                                   │
        Open-Meteo hourly forecast per 0.1° cell (batched, cached) ─► conditions at ETA
                                   │
          risk per checkpoint (worst of wind / rain / snow after load rules)
                                   │
       miles per level per route ─► lexicographic ranking ─► recommendation + reasons
```

The heatmap is a separate request (`GET /api/plans/<id>/heatmap`), so the routes appear as soon as they are scored and the corridor forecast streams in a moment later.

## Rules, and how the ambiguous parts were decided

The thresholds are implemented exactly as given. Where the table leaves room for interpretation, this is the reading, and it is the same in the code, the tests, the legend and the in-app **Risk rules** dialog:

- **Band edges.** The ranges touch (wind "25–34" then "35–44"), so each band's lower bound is inclusive: 25 mph is Moderate, 35 High, 45 Severe, ≥ 55 No Travel. For rain and snow, No Travel is written as strictly "> 1.00" and "> 3.0", so exactly 1.00 in/hr rain is still Severe.
- **Load rules** apply to wind and take precedence where they are stricter: ≥ 55 mph is No Travel for any load; 45–54 mph with more than 30,000 lb is No Travel; 35–44 mph with more than 40,000 lb is Severe. The checkpoint shows which rule fired.
- **Checkpoint level** = the worst of its wind, rain and snow levels (after load rules). Wind is the sustained 10 m wind; gusts are shown for context.
- **Miles per level.** Each checkpoint represents the road halfway to its neighbours, so the miles always add up to the route length.
- **Average risk** is distance-weighted with Low = 0 … No Travel = 4.
- **Ranking.** The PDF order (fewest Severe miles → fewest High miles → lowest average risk → shortest time), with one guard placed first: **fewest No Travel miles**, because a route that must not be driven can never be the safest one. Miles are compared at 0.1 mi so floating-point noise never decides.
- **ETA.** OSRM's per-segment durations, slowed to a 65 mph truck cap on fast roads (OSRM's public server has no truck profile). With hours of service on (default): a 30-minute break after 8 hours of driving and a 10-hour reset after 11, so the weather is read when the truck is really there. "Travel time" is door to door, stops included.
- **Reading the forecast at an ETA.** Wind is interpolated between hours. Rain, showers and snowfall are Open-Meteo's totals for the preceding hour, which is a rate in in/hr; the truck gets the rate of the clock hour it is driving in.
- **Heatmap colour = checkpoint colour.** The heatmap uses a continuous score whose integer part is exactly the discrete level, and colours step at the thresholds, so a cell and a checkpoint with the same weather always show the same colour.
- **Slider time** is hours after departure (T+0 … T+48), since that is the window in which the truck is on the road.

## Things worth knowing

- **What-if weather.** Real forecasts are often calm. The form has a clearly labelled *What-if* section that adds wind and scales precipitation on top of the real forecast, so you can watch the load rules and the ranking react. Every simulated result is badged and carries a warning; the default is the real forecast.
- **Fast and polite to free APIs.** Weather is fetched per 0.1° grid cell (about 7 miles, finer than most forecast models' native grid), so overlapping routes and the heatmap share one download per cell; requests are batched 50 locations at a time and cached for 30 minutes. A Dallas→Denver plan takes about 2–5 s cold.
- **Smooth heatmap.** All 49 frames arrive at once. Scrubbing or playing interpolates between hours and writes values into MapLibre feature state: no network, no re-tiling, no React re-render of the map.
- **One error shape.** Every API error is `{"error": {"code", "message", "fields"?}}`; provider failures become clean 5xx messages with a retry button, validation errors land on the right form fields.
- **Keyboard and screen readers.** The place search is an ARIA combobox, the decision table has a caption and row headers, and Space / ← / → control the forecast playback.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/plan` | Build a plan (body below) |
| `GET` | `/api/plans/<plan_id>/heatmap` | 49 hourly frames for the corridor (risk, wind, rain, snow) |
| `GET` | `/api/geocode?q=` | Place search (Photon, Nominatim fallback); accepts `lat, lon` |
| `GET` | `/api/meta` | Thresholds, load rules, limits (drives the legend and rules dialog) |
| `GET` | `/api/health` | Health check |

```bash
curl -X POST http://localhost:8000/api/plan -H 'Content-Type: application/json' -d '{
  "origin": "Dallas, TX",
  "destination": {"lat": 39.7392, "lon": -104.9903, "label": "Denver, CO"},
  "departure": "2026-10-20T14:00:00Z",
  "load_lb": 42000,
  "interval_mi": 25,
  "hos": true,
  "scenario": null
}'
```

The response holds the three routes, each with geometry, risk-coloured segments, checkpoints (ETA, weather, assessment with factors and drivers), HOS stops, a 15-minute position track, and a summary; plus the recommendation (`order`, `headline`, per-route `comparisons`) and any warnings. Types for the whole contract are in [`frontend/src/api/types.ts`](frontend/src/api/types.ts).

Limits: departure from one hour ago to 7 days ahead, load 0–80,000 lb, interval 10 / 25 / 50 mi.

## Run it locally

Requirements: Python 3.12+ and Node 20+. No API keys are needed.

```bash
# backend (http://127.0.0.1:8000)
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements-dev.txt
cd backend && python manage.py runserver

# frontend (http://localhost:5173, proxies /api to Django)
cd frontend && npm ci && npm run dev
```

## Tests and quality

```bash
cd backend && pytest && ruff check . && ruff format --check .
cd frontend && npm test && npm run typecheck && npm run lint && npm run format:check
```

- **Backend: 146 tests.** Every threshold boundary and load rule, the continuous score's agreement with levels, geometry, checkpoint ownership, HOS scheduling and its inverse, ranking order and tie-breaks, the three-route guarantee, loop removal on detours, forecast interpolation and batching, the heatmap grid, and the API end to end against deterministic fake OSRM and Open-Meteo servers (no network).
- **Frontend: 46 tests.** Formatting and thresholds mirrored from the backend, truck positions, form validation and payload, keyboard autocomplete, decision table, cards, timeline, slider, and an App integration test with a mocked network.
- CI (GitHub Actions) runs all of it plus a production build on every push.

## Deploy

One Docker service: Django serves the API and the built React app (WhiteNoise, pre-compressed, hashed assets cached for a year).

```bash
docker build -t routecast . && docker run -p 8000:8000 -e DJANGO_SECRET_KEY=change-me -e DJANGO_ALLOWED_HOSTS=localhost routecast
```

`render.yaml` deploys it on Render as-is. Gunicorn runs **one process with eight threads** on purpose: plans are cached in process memory and the heatmap request has to reach the same process. Moving the cache to Redis would allow more processes.

## Project layout

```
backend/
  config/                 settings, urls, wsgi
  planner/
    domain/               pure logic: risk, recommend, sampling, hos, geo  (no I/O, fully unit-tested)
    services/             providers and orchestration: routing, weather, geocoding, corridor, planner
    serializers.py        request validation
    views.py              thin HTTP layer + uniform error handler
    tests/                pytest suite and fake providers
frontend/
  src/api/                typed client and response types
  src/components/         TripForm, PlaceInput, Recommendation, RouteCard, CheckpointTimeline,
                          ForecastSlider, MapLegend, RulesDialog, map/RouteMap
  src/lib/                formatting, risk palette and thresholds, truck position maths
```

## Limitations and next steps

- OSRM's public server routes with a car profile; the speed cap approximates truck pace but not truck restrictions (low bridges, weight limits). A heavy-goods profile (OpenRouteService `driving-hgv`, or a self-hosted OSRM truck profile) would slot into `services/routing.py`.
- Forecast resolution is that of Open-Meteo's best-match models (roughly 3–13 km); the 0.1° snapping is finer than that.
- Fuel, inspection and the 14-hour window are not modelled (with continuous driving the 11-hour limit always binds first).
- The free OSRM, Photon and Open-Meteo services have fair-use limits; heavy use would need self-hosting or paid tiers.

## Data and credits

Routing © [OSRM](https://project-osrm.org/) / © OpenStreetMap contributors · Forecasts © [Open-Meteo](https://open-meteo.com/) (CC BY 4.0) · Geocoding © [Photon](https://photon.komoot.io/) / Nominatim · Basemap © CARTO, © OpenStreetMap contributors · Map rendering by [MapLibre GL JS](https://maplibre.org/).
