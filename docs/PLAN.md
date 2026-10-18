# Weather-Aware Truck Routing: build plan

Source: `docs/fs-assessment-spotter.pdf` (Spotter AI, Full Stack Developer assessment).
Budget from Spotter: at most 4 days and 16 working hours. Deliverables: GitHub repo, hosted app, 5–10 min Loom.

## Requirement traceability

| # | Requirement (PDF) | Where it lives | Verified by |
|---|---|---|---|
| R1 | Inputs: origin, destination, departure date/time, load weight | `frontend/src/components/TripForm.tsx` → `POST /api/plan` (`PlanRequestSerializer`) | serializer tests, form tests |
| R2 | 3 route options from a routing API | `backend/planner/services/routing.py` (OSRM alternatives + via-point detours to guarantee 3; ORS HGV when a key is set) | `test_routing.py` |
| R3 | Sample weather every 10 / 25 / 50 mi at the truck's ETA at each checkpoint | `services/sampling.py` (distance + duration annotations) and `services/weather.py` (Open-Meteo hourly, interpolated to ETA) | `test_sampling.py`, `test_weather.py` |
| R4 | Risk from the thresholds + load rules | `services/risk.py` (pure functions, table-driven) | `test_risk.py` (every boundary) |
| R5 | Recommend best route: fewest Severe mi → fewest High mi → lowest avg risk → shortest time | `services/recommend.py` (lexicographic key + human explanation) | `test_recommend.py` |
| R6 | Map with all routes, checkpoints, risk levels, ETAs, summaries | `components/RouteMap.tsx`, `RouteCard.tsx`, `CheckpointTimeline.tsx` | component tests + manual |
| R7 | Weather heatmap along the corridor + 0–48 h forecast slider | `services/corridor.py` → `GET /api/heatmap`; `components/HeatmapLayer` + `ForecastSlider.tsx` (all 49 hours preloaded, slider swaps GPU data only) | `test_corridor.py`, slider tests |
| E1 | 40% logic correctness | pure, tested domain layer; deterministic tie-breaks; documented interpretations | pytest |
| E2 | 40% UI/map/heatmap smoothness | MapLibre GL (WebGL), simplified geometries, precomputed heatmap frames, rAF playback, memoised layers | manual + perf notes |
| E3 | 15% code quality | typed TS, layered Django (views → services → domain), lint, CI | ruff, eslint, tsc, tests |
| E4 | 5% docs + walkthrough | README (decisions, rules interpretation, API), `docs/LOOM_SCRIPT.md` | — |

## Interpretations (stated explicitly in README)
- Boundaries: Low < 25 mph ≤ Moderate < 35 ≤ High < 45 ≤ Severe < 55 ≤ No Travel. Rain/snow use the table's lower bounds as inclusive, and "> 1.00" / "> 3.0" for No Travel.
- Checkpoint level = worst of wind / rain / snow after load rules. Wind = sustained 10 m wind (gusts shown for info).
- Miles per level: each checkpoint owns the route distance up to the next checkpoint.
- Ranking: No Travel miles first (a route you legally/physically cannot run is never "best"), then the PDF order: Severe → High → average risk (distance-weighted, Low=0 … No Travel=4) → duration.
- ETA: routing-API durations along the polyline; optional FMCSA hours-of-service mode (30-min break after 8 h driving, 10 h off after 11 h) because weather must be read at the time the truck is really there.

## Phases (audit after each)
1. **Scaffold + API probes** — repo layout, Django + DRF, Vite React TS, verify OSRM / Open-Meteo / Photon contracts.
2. **Domain logic + tests** — risk, load rules, sampling, ETA/HOS, aggregation, recommendation. Target: every rule boundary covered.
3. **Providers + API** — routing (3 guaranteed), geocoding proxy, batched weather with cache, corridor heatmap grid; `/api/geocode`, `/api/plan`, `/api/heatmap`; mocked integration tests.
4. **Frontend shell** — layout, TripForm (autocomplete, validation, presets), RouteCards with comparison + recommendation reason.
5. **Map** — routes, risk-coloured segments, checkpoint markers with popups, fit bounds, selection sync with cards.
6. **Heatmap + slider** — 49 frames, play/pause, metric switch (risk/wind/rain/snow), truck position at slider time, legend.
7. **Polish + audit** — loading/empty/error states, responsive, keyboard/a11y, performance pass, tests green, README, Loom script, deploy config (single Docker service: Django serves the built SPA).
