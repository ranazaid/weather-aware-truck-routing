import type { ExpressionSpecification } from "maplibre-gl";
import type { HeatMetric } from "../../api/types";
import { LEVEL_COLOR, LEVELS, METRIC_STOPS } from "../../lib/risk";

export const BASEMAPS = [
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  "https://tiles.openfreemap.org/styles/dark",
];

export const US_VIEW = { center: [-97.5, 38.5] as [number, number], zoom: 3.6 };

const levelColorByProp: ExpressionSpecification = [
  "match",
  ["get", "level"],
  ...LEVELS.flatMap((l) => [l, LEVEL_COLOR[l]]),
  LEVEL_COLOR.unknown,
] as unknown as ExpressionSpecification;

export const segmentColor = levelColorByProp;

/** Lower bounds per level for a metric. Rain/snow No Travel is strictly ">" so it starts a hair above. */
function thresholds(metric: HeatMetric): number[] {
  const [, m, h, s, n] = METRIC_STOPS[metric];
  const strict = metric === "rain" || metric === "snow";
  return [m!, h!, s!, strict ? n! + 1e-6 : n!];
}

/** Step (not interpolate) so a cell's colour is always exactly its risk level's colour. */
export function heatColor(metric: HeatMetric): ExpressionSpecification {
  const [m, h, s, n] = thresholds(metric);
  return [
    "step",
    ["coalesce", ["feature-state", "v"], 0],
    LEVEL_COLOR.low,
    m!,
    LEVEL_COLOR.moderate,
    h!,
    LEVEL_COLOR.high,
    s!,
    LEVEL_COLOR.severe,
    n!,
    LEVEL_COLOR.no_travel,
  ] as unknown as ExpressionSpecification;
}

export function heatOpacity(metric: HeatMetric): ExpressionSpecification {
  const [m, h] = thresholds(metric);
  return [
    "case",
    ["==", ["feature-state", "has"], true],
    ["step", ["coalesce", ["feature-state", "v"], 0], 0.22, m!, 0.42, h!, 0.62],
    0,
  ] as unknown as ExpressionSpecification;
}

/** Cells are 12–40 miles apart; grow the radius with zoom so neighbours always blend into a field. */
export const heatRadius: ExpressionSpecification = [
  "interpolate",
  ["exponential", 2],
  ["zoom"],
  3,
  6,
  4,
  12,
  10,
  768,
];

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
