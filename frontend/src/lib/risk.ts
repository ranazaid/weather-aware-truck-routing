import type { HeatMetric, LevelKey, SegmentLevel } from "../api/types";

export const LEVELS: LevelKey[] = ["low", "moderate", "high", "severe", "no_travel"];

export const LEVEL_LABEL: Record<SegmentLevel, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  severe: "Severe",
  no_travel: "No Travel",
  unknown: "Unknown",
};

/** One palette everywhere: route segments, chips, bars, heatmap and legend. */
export const LEVEL_COLOR: Record<SegmentLevel, string> = {
  low: "#22c55e",
  moderate: "#eab308",
  high: "#f97316",
  severe: "#f47272",
  no_travel: "#e46bf2",
  unknown: "#94a3b8",
};

export const levelIndex = (l: SegmentLevel) => (l === "unknown" ? -1 : LEVELS.indexOf(l));

/**
 * Colour stops for each heatmap metric. Breakpoints are the risk thresholds, so a wind of
 * 35 mph is drawn in exactly the "High" orange, and every metric shares one legend.
 */
export const METRIC_STOPS: Record<HeatMetric, number[]> = {
  risk: [0, 1, 2, 3, 4],
  wind: [0, 25, 35, 45, 55],
  rain: [0, 0.1, 0.25, 0.5, 1.0],
  snow: [0, 0.5, 1.0, 2.0, 3.0],
};

export const METRIC_META: Record<HeatMetric, { label: string; unit: string; digits: number }> = {
  risk: { label: "Risk", unit: "", digits: 1 },
  wind: { label: "Wind", unit: "mph", digits: 0 },
  rain: { label: "Rain", unit: "in/hr", digits: 2 },
  snow: { label: "Snow", unit: "in/hr", digits: 2 },
};

/** Discrete level of a heatmap value; mirrors backend boundaries (wind ≥ 55 No Travel, rain/snow strictly >). */
export function metricLevel(metric: HeatMetric, v: number): LevelKey {
  const [, m, h, s, n] = METRIC_STOPS[metric] as [number, number, number, number, number];
  if (metric === "risk") return LEVELS[Math.min(4, Math.max(0, Math.floor(v)))] as LevelKey;
  const noTravel = metric === "wind" ? v >= n : v > n;
  if (noTravel) return "no_travel";
  if (v >= s) return "severe";
  if (v >= h) return "high";
  if (v >= m) return "moderate";
  return "low";
}

const WMO: [number[], string][] = [
  [[0], "Clear"],
  [[1], "Mostly clear"],
  [[2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Fog"],
  [[51, 53, 55], "Drizzle"],
  [[56, 57], "Freezing drizzle"],
  [[61, 63, 65], "Rain"],
  [[66, 67], "Freezing rain"],
  [[71, 73, 75], "Snow"],
  [[77], "Snow grains"],
  [[80, 81, 82], "Rain showers"],
  [[85, 86], "Snow showers"],
  [[95], "Thunderstorm"],
  [[96, 99], "Thunderstorm with hail"],
];

export function weatherText(code: number | null | undefined): string {
  if (code == null) return "—";
  return WMO.find(([codes]) => codes.includes(code))?.[1] ?? "—";
}
