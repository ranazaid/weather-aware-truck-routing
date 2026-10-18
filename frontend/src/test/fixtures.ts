import type { Checkpoint, LevelKey, Plan, PlannedRoute, Rules } from "../api/types";

const DEP = Date.parse("2026-10-20T14:00:00Z");

function checkpoint(index: number, mile: number, level: LevelKey, wind = 10, rule: string | null = null): Checkpoint {
  const elapsed = mile * 60;
  return {
    index,
    mile,
    lon: -100 + mile / 50,
    lat: 35,
    drive_s: elapsed,
    elapsed_s: elapsed,
    eta: new Date(DEP + elapsed * 1000).toISOString(),
    owned_from_mi: Math.max(0, mile - 12.5),
    owned_to_mi: mile + 12.5,
    weather: { wind_mph: wind, gust_mph: wind + 6, rain_in_hr: 0, snow_in_hr: 0, temp_f: 55, weather_code: 3 },
    risk: {
      level,
      label: level,
      score: ["low", "moderate", "high", "severe", "no_travel"].indexOf(level),
      factors: [
        { name: "wind", value: wind, unit: "mph", level, rule },
        { name: "rain", value: 0, unit: "in/hr", level: "low", rule: null },
        { name: "snow", value: 0, unit: "in/hr", level: "low", rule: null },
      ],
      drivers: level === "low" ? [] : ["wind"],
    },
  };
}

function route(id: string, opts: Partial<PlannedRoute> & { levels: LevelKey[] }): PlannedRoute {
  const cps = opts.levels.map((lvl, i) =>
    checkpoint(
      i,
      i * 25,
      lvl,
      lvl === "severe" ? 40 : lvl === "high" ? 38 : 10,
      lvl === "severe" ? "35–44 mph wind with load over 40,000 lb → Severe" : null,
    ),
  );
  const miles = { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0 } as Record<LevelKey, number>;
  opts.levels.forEach((l) => (miles[l] += 25));
  const dist = opts.levels.length * 25;
  const duration = opts.duration_s ?? dist * 60;
  return {
    id,
    label: id,
    name: `via I ${id.charCodeAt(0)}`,
    variant: id === "A" ? "fastest" : "detour",
    distance_mi: dist,
    drive_s: duration,
    duration_s: duration,
    provider_duration_s: duration,
    arrival: new Date(DEP + duration * 1000).toISOString(),
    geometry: { type: "LineString", coordinates: cps.map((c) => [c.lon, c.lat]) },
    bbox: [-100, 35, -100 + dist / 50, 35],
    segments: [],
    checkpoints: cps,
    stops: [
      {
        kind: "break",
        label: "30-min break",
        at_drive_s: 30,
        start_elapsed_s: 30,
        duration_s: 1800,
        mile: 12,
        lon: -99.8,
        lat: 35,
        starts: new Date(DEP + 30_000).toISOString(),
        ends: new Date(DEP + 1_830_000).toISOString(),
      },
    ],
    track: [
      [0, -100, 35],
      [duration, -100 + dist / 50, 35],
    ],
    summary: {
      distance_mi: dist,
      duration_s: duration,
      miles_by_level: miles,
      unknown_mi: 0,
      avg_risk:
        opts.levels.reduce((a, l) => a + ["low", "moderate", "high", "severe", "no_travel"].indexOf(l), 0) /
        opts.levels.length,
      max_level: opts.levels.reduce<LevelKey>(
        (m, l) =>
          ["low", "moderate", "high", "severe", "no_travel"].indexOf(l) >
          ["low", "moderate", "high", "severe", "no_travel"].indexOf(m)
            ? l
            : m,
        "low",
      ),
    },
    ...opts,
  };
}

export const RULES: Rules = {
  levels: [
    { key: "low", label: "Low", score: 0 },
    { key: "moderate", label: "Moderate", score: 1 },
    { key: "high", label: "High", score: 2 },
    { key: "severe", label: "Severe", score: 3 },
    { key: "no_travel", label: "No Travel", score: 4 },
  ],
  conditions: [
    {
      name: "wind",
      unit: "mph",
      bands: [
        { level: "low", text: "< 25 mph" },
        { level: "moderate", text: "25–34 mph" },
        { level: "high", text: "35–44 mph" },
        { level: "severe", text: "45–54 mph" },
        { level: "no_travel", text: "≥ 55 mph" },
      ],
    },
  ],
  load_rules: [{ text: "Wind 35–44 mph and load > 40,000 lb → Severe", level: "severe" }],
};

/** A: fastest but 25 Severe miles · B: no Severe, 50 High · C: no Severe, 25 High → C recommended. */
export function makePlan(): Plan {
  const A = route("A", { levels: ["low", "severe", "low", "low"], duration_s: 6000 });
  const B = route("B", { levels: ["low", "high", "high", "low"], duration_s: 6500 });
  const C = route("C", { levels: ["low", "high", "moderate", "low"], duration_s: 7000 });
  return {
    plan_id: "p1",
    generated_at: new Date(DEP - 60_000).toISOString(),
    request: {
      origin: { label: "West Town", lat: 35, lon: -100 },
      destination: { label: "East City", lat: 35, lon: -98 },
      departure: new Date(DEP).toISOString(),
      load_lb: 42000,
      interval_mi: 25,
      hos: true,
      truck_speed_cap_mph: 65,
      scenario: null,
    },
    forecast_window: {
      start: new Date(DEP).toISOString(),
      end: new Date(DEP + 50 * 3600_000).toISOString(),
      grid_deg: 0.1,
    },
    routes: [A, B, C],
    recommendation: {
      route_id: "C",
      label: "C",
      headline: "No Severe weather; 25.0 High-risk miles.",
      order: ["C", "B", "A"],
      comparisons: [
        {
          route_id: "B",
          label: "B",
          text: "Route C beats Route B on High miles: 25.0 mi vs 50.0 mi.",
          criterion: "High miles",
        },
        {
          route_id: "A",
          label: "A",
          text: "Route C beats Route A on Severe miles: 0.0 mi vs 25.0 mi.",
          criterion: "Severe miles",
        },
      ],
    },
    departure_advice: {
      options: [
        {
          offset_h: 0,
          route_id: "C",
          label: "C",
          no_travel_mi: 0,
          severe_mi: 0,
          high_mi: 25,
          avg_risk: 0.75,
          duration_s: 7000,
        },
        {
          offset_h: 6,
          route_id: "A",
          label: "A",
          no_travel_mi: 0,
          severe_mi: 0,
          high_mi: 0,
          avg_risk: 0,
          duration_s: 6000,
        },
      ],
      best_offset_h: 6,
      text: "Leaving 6 h later is safer: Route A cuts High miles from 25.0 mi to 0.0 mi.",
    },
    warnings: [],
    rules: RULES,
  };
}
