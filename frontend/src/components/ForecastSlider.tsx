import clsx from "clsx";
import { Loader2, Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { memo, useMemo, type MouseEvent } from "react";
import type { HeatMetric, Heatmap } from "../api/types";
import { formatDayHour, formatDateTime } from "../lib/format";
import { LEVEL_COLOR, LEVEL_LABEL, METRIC_META, metricLevel } from "../lib/risk";

const METRICS: HeatMetric[] = ["risk", "wind", "rain", "snow"];
const SPEEDS = [2, 4, 8];

interface Props {
  hour: number;
  maxHour: number;
  onHour: (h: number) => void;
  playing: boolean;
  onToggle: () => void;
  onReset: () => void;
  speed: number;
  onSpeed: (s: number) => void;
  metric: HeatMetric;
  onMetric: (m: HeatMetric) => void;
  heatmap: Heatmap | null;
  heatLoading: boolean;
  heatError: string | null;
  departureMs: number;
  showHeatmap: boolean;
  onShowHeatmap: (v: boolean) => void;
}

/** Worst value of the metric along the whole corridor, per hour. */
export function peaksByHour(heatmap: Heatmap, metric: HeatMetric): number[] {
  return heatmap.metrics[metric].map((frame) =>
    frame.reduce<number>((m, v) => (v != null && v > m ? v : m), 0),
  );
}

function ForecastSliderImpl(p: Props) {
  const peaks = useMemo(() => (p.heatmap ? peaksByHour(p.heatmap, p.metric) : []), [p.heatmap, p.metric]);
  const peakMax = Math.max(...peaks, 0);
  const at = new Date(p.departureMs + p.hour * 3600_000);
  const whole = Math.round(p.hour);
  const worstNow = peaks[Math.min(peaks.length - 1, Math.floor(p.hour))];
  const meta = METRIC_META[p.metric];

  const jump = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    p.onHour(Math.round(((e.clientX - r.left) / r.width) * p.maxHour));
  };

  return (
    <section aria-label="Forecast time" className="panel p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button type="button" className="btn-ghost p-1.5" onClick={() => p.onHour(Math.floor(p.hour) - 1)} aria-label="Back one hour">
            <SkipBack size={15} />
          </button>
          <button
            type="button"
            onClick={p.onToggle}
            className="btn-primary h-9 w-9 rounded-full p-0"
            aria-label={p.playing ? "Pause forecast playback" : "Play forecast"}
            title="Play / pause (Space)"
          >
            {p.playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
          </button>
          <button type="button" className="btn-ghost p-1.5" onClick={() => p.onHour(Math.floor(p.hour) + 1)} aria-label="Forward one hour">
            <SkipForward size={15} />
          </button>
          <button type="button" className="btn-ghost p-1.5" onClick={p.onReset} aria-label="Back to departure">
            <RotateCcw size={14} />
          </button>
        </div>

        <div className="min-w-0">
          <p className="num text-sm font-semibold text-white" aria-live="polite">
            T+{whole} h <span className="font-normal text-ink-300">· {formatDateTime(at)}</span>
          </p>
          <p className="text-[11px] text-ink-400">
            Hours after departure · trucks show where each route is at this time
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-ink-700 bg-ink-850 p-0.5" role="radiogroup" aria-label="Heatmap layer">
            {METRICS.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={p.metric === m}
                onClick={() => {
                  p.onMetric(m);
                  p.onShowHeatmap(true);
                }}
                className={clsx(
                  "rounded-md px-2 py-1 text-xs transition-colors",
                  p.metric === m && p.showHeatmap ? "bg-ink-600 text-white" : "text-ink-400 hover:text-ink-100",
                )}
              >
                {METRIC_META[m].label}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-300">
            <input
              type="checkbox"
              className="accent-sky-500"
              checked={p.showHeatmap}
              onChange={(e) => p.onShowHeatmap(e.target.checked)}
            />
            Heatmap
          </label>
          <select
            aria-label="Playback speed"
            className="rounded-md border border-ink-700 bg-ink-850 px-1.5 py-1 text-xs text-ink-200"
            value={p.speed}
            onChange={(e) => p.onSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s} h/s
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3">
        <div
          className="relative flex h-7 cursor-pointer items-end gap-px"
          onClick={jump}
          aria-hidden
          title={`Worst ${meta.label.toLowerCase()} anywhere in the corridor, by hour`}
        >
          {p.heatLoading && (
            <span className="absolute inset-0 flex items-center gap-2 text-[11px] text-ink-400">
              <Loader2 size={12} className="animate-spin" /> Loading 48-hour corridor forecast…
            </span>
          )}
          {p.heatError && <span className="absolute inset-0 text-[11px] text-risk-high">{p.heatError}</span>}
          {peaks.map((v, i) => {
            const lvl = metricLevel(p.metric, v);
            const h = peakMax > 0 ? Math.max(12, (v / peakMax) * 100) : 12;
            return (
              <div
                key={i}
                className={clsx("flex-1 rounded-t-[2px] transition-opacity", Math.floor(p.hour) === i ? "opacity-100" : "opacity-55")}
                style={{ height: `${h}%`, backgroundColor: LEVEL_COLOR[lvl] }}
              />
            );
          })}
        </div>
        <input
          type="range"
          className="slider mt-1.5"
          min={0}
          max={p.maxHour}
          step={0.25}
          value={p.hour}
          onChange={(e) => p.onHour(Number(e.target.value))}
          aria-label="Forecast hour after departure"
          aria-valuetext={`T plus ${whole} hours, ${formatDateTime(at)}`}
        />
        <div className="num mt-1 flex justify-between text-[10px] text-ink-500" aria-hidden>
          {[0, 12, 24, 36, 48].map((h) => (
            <span key={h}>
              {h === 0 ? "Depart" : `+${h}h`}
              <span className="hidden sm:inline"> · {formatDayHour(p.departureMs + h * 3600_000)}</span>
            </span>
          ))}
        </div>
        {worstNow != null && p.heatmap && (
          <p className="mt-1.5 text-[11px] text-ink-400">
            Worst {meta.label.toLowerCase()} in the corridor at this hour:{" "}
            <span className="num" style={{ color: LEVEL_COLOR[metricLevel(p.metric, worstNow)] }}>
              {p.metric === "risk" ? LEVEL_LABEL[metricLevel("risk", worstNow)] : `${worstNow.toFixed(meta.digits)} ${meta.unit}`}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}

export const ForecastSlider = memo(ForecastSliderImpl);
