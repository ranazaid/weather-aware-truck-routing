export type LevelKey = "low" | "moderate" | "high" | "severe" | "no_travel";
export type SegmentLevel = LevelKey | "unknown";
export type Coord = [number, number]; // [lon, lat]

export interface Place {
  label: string;
  lat: number;
  lon: number;
  kind?: string | null;
}

export interface Factor {
  name: "wind" | "rain" | "snow";
  value: number;
  unit: string;
  level: LevelKey;
  rule: string | null;
}

export interface Assessment {
  level: LevelKey;
  label: string;
  score: number;
  factors: Factor[];
  drivers: Factor["name"][];
}

export interface Weather {
  wind_mph: number;
  gust_mph: number | null;
  rain_in_hr: number;
  snow_in_hr: number;
  temp_f: number | null;
  weather_code: number | null;
}

export interface Checkpoint {
  index: number;
  mile: number;
  lon: number;
  lat: number;
  drive_s: number;
  elapsed_s: number;
  eta: string;
  owned_from_mi: number;
  owned_to_mi: number;
  weather: Weather | null;
  risk: Assessment | null;
}

export interface Stop {
  kind: "break" | "rest";
  label: string;
  at_drive_s: number;
  start_elapsed_s: number;
  duration_s: number;
  mile: number;
  lon: number;
  lat: number;
  starts: string;
  ends: string;
}

export interface RiskSegment {
  level: SegmentLevel;
  from_mi: number;
  to_mi: number;
  coordinates: Coord[];
}

export interface RouteSummary {
  distance_mi: number;
  duration_s: number;
  miles_by_level: Record<LevelKey, number>;
  unknown_mi: number;
  avg_risk: number;
  max_level: LevelKey;
}

export interface PlannedRoute {
  id: string;
  label: string;
  name: string;
  variant: "fastest" | "alternative" | "detour";
  distance_mi: number;
  drive_s: number;
  duration_s: number;
  provider_duration_s: number;
  arrival: string;
  geometry: { type: "LineString"; coordinates: Coord[] };
  bbox: [number, number, number, number];
  segments: RiskSegment[];
  checkpoints: Checkpoint[];
  stops: Stop[];
  track: [number, number, number][]; // [elapsed_s, lon, lat]
  summary: RouteSummary;
}

export interface Comparison {
  route_id: string;
  label: string;
  text: string;
  criterion?: string;
  best?: string;
  other?: string;
}

export interface Recommendation {
  route_id: string;
  label: string;
  headline: string;
  order: string[];
  comparisons: Comparison[];
}

export interface Band {
  level: LevelKey;
  text: string;
}

export interface Rules {
  levels: { key: LevelKey; label: string; score: number }[];
  conditions: { name: "wind" | "rain" | "snow"; unit: string; bands: Band[] }[];
  load_rules: { text: string; level: LevelKey }[];
}

export interface PlanRequest {
  origin: Place | string;
  destination: Place | string;
  departure: string;
  load_lb: number;
  interval_mi: 10 | 25 | 50;
  hos: boolean;
  scenario?: { wind_add_mph: number; precip_factor: number } | null;
}

export interface Plan {
  plan_id: string;
  generated_at: string;
  request: {
    origin: Place;
    destination: Place;
    departure: string;
    load_lb: number;
    interval_mi: number;
    hos: boolean;
    truck_speed_cap_mph: number;
    scenario: { wind_add_mph: number; precip_factor: number; text: string } | null;
  };
  forecast_window: { start: string; end: string };
  routes: PlannedRoute[];
  recommendation: Recommendation;
  warnings: string[];
  rules: Rules;
}

export type HeatMetric = "risk" | "wind" | "rain" | "snow";

export interface Heatmap {
  hours: number;
  step_s: number;
  departure_ts: number;
  points: Coord[];
  metrics: Record<HeatMetric, (number | null)[][]>;
  peak: Record<HeatMetric, number>;
}

export interface Meta {
  rules: Rules;
  intervals_mi: number[];
  max_load_lb: number;
  max_days_ahead: number;
  truck_speed_cap_mph: number;
}
