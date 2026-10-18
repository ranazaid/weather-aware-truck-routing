import { ChevronDown, Layers } from "lucide-react";
import { useState } from "react";
import type { HeatMetric } from "../api/types";
import { LEVEL_COLOR, LEVEL_LABEL, LEVELS, METRIC_META, METRIC_STOPS } from "../lib/risk";

/** Band text in the assessment's own wording: wind "25–34", rain "0.10–0.25", snow "0.5–1.0". */
export function rangeText(metric: HeatMetric, i: number): string {
  if (metric === "risk") return "";
  const s = METRIC_STOPS[metric];
  const unit = METRIC_META[metric].unit;
  const digits = metric === "wind" ? 0 : metric === "rain" ? 2 : 1;
  const fmt = (v: number) => v.toFixed(digits);
  const top = (v: number) => (metric === "wind" ? fmt(v - 1) : fmt(v));
  if (i === 0) return `< ${fmt(s[1]!)}`;
  if (i === 4) return `${metric === "wind" ? "≥" : ">"} ${fmt(s[4]!)} ${unit}`;
  return `${fmt(s[i]!)}–${top(s[i + 1]!)}`;
}

interface Props {
  metric: HeatMetric;
  showHeatmap: boolean;
  showCheckpoints: boolean;
  onShowCheckpoints: (v: boolean) => void;
}

export function MapLegend({ metric, showHeatmap, showCheckpoints, onShowCheckpoints }: Props) {
  const [open, setOpen] = useState(true);
  return (
    <div className="panel w-[210px] text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 font-semibold text-ink-200"
        aria-expanded={open}
      >
        <Layers size={13} /> Legend
        <ChevronDown size={13} className={`ml-auto transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-ink-700/80 px-3 pt-2 pb-3">
          <ul className="space-y-1">
            {LEVELS.map((l, i) => (
              <li key={l} className="flex items-center gap-2">
                <span className="h-2.5 w-5 rounded-sm" style={{ backgroundColor: LEVEL_COLOR[l] }} />
                <span className="text-ink-200">{LEVEL_LABEL[l]}</span>
                {showHeatmap && metric !== "risk" && (
                  <span className="num ml-auto text-[10px] text-ink-400">{rangeText(metric, i)}</span>
                )}
              </li>
            ))}
            <li className="flex items-center gap-2">
              <span className="h-2.5 w-5 rounded-sm" style={{ backgroundColor: LEVEL_COLOR.unknown }} />
              <span className="text-ink-400">No forecast</span>
            </li>
          </ul>
          {showHeatmap && (
            <p className="text-[10px] leading-snug text-ink-400">
              Heatmap: {METRIC_META[metric].label.toLowerCase()}{" "}
              {metric === "risk" ? "level (wind, rain, snow + load rules)" : `(${METRIC_META[metric].unit})`} across a
              ±40 mi corridor.
            </p>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-ink-300">
            <input
              type="checkbox"
              className="accent-sky-500"
              checked={showCheckpoints}
              onChange={(e) => onShowCheckpoints(e.target.checked)}
            />
            Checkpoints
          </label>
          <div className="flex items-center gap-3 text-[10px] text-ink-400">
            <span className="flex items-center gap-1">
              <span className="map-pin map-pin-origin inline-block h-3 w-3 border-2" /> Origin
            </span>
            <span className="flex items-center gap-1">
              <span className="map-pin map-pin-dest inline-block h-3 w-3 border-2" /> Destination
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
