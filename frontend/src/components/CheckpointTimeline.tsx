import clsx from "clsx";
import { Coffee, Moon, Snowflake, Thermometer, Umbrella, Wind } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Checkpoint, PlannedRoute, Stop } from "../api/types";
import { formatDateTime, formatDuration } from "../lib/format";
import { LEVEL_COLOR, levelIndex, weatherText } from "../lib/risk";
import { RiskChip } from "./RiskChip";

type Item = { kind: "cp"; at: number; cp: Checkpoint } | { kind: "stop"; at: number; stop: Stop };

interface Props {
  route: PlannedRoute;
  focused: number | null;
  onFocus: (index: number) => void;
}

export function CheckpointTimeline({ route, focused, onFocus }: Props) {
  const [onlyRisky, setOnlyRisky] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  const items = useMemo<Item[]>(() => {
    const cps: Item[] = route.checkpoints
      .filter((cp) => !onlyRisky || levelIndex(cp.risk?.level ?? "unknown") >= 2 || cp.risk === null)
      .map((cp) => ({ kind: "cp", at: cp.elapsed_s, cp }));
    const stops: Item[] = route.stops.map((stop) => ({ kind: "stop", at: stop.start_elapsed_s + 0.5, stop }));
    return [...cps, ...stops].sort((a, b) => a.at - b.at);
  }, [route, onlyRisky]);

  useEffect(() => {
    if (focused == null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-cp="${focused}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  const riskyCount = route.checkpoints.filter((cp) => levelIndex(cp.risk?.level ?? "unknown") >= 2).length;

  return (
    <section aria-labelledby="timeline-title" className="panel">
      <header className="flex items-center justify-between gap-2 border-b border-ink-700/80 px-4 py-3">
        <div>
          <h3 id="timeline-title" className="text-sm font-semibold text-white">
            Route {route.label} checkpoints
          </h3>
          <p className="text-[11px] text-ink-400">
            {route.checkpoints.length} checkpoints · weather at the truck's ETA
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-300">
          <input
            type="checkbox"
            checked={onlyRisky}
            onChange={(e) => setOnlyRisky(e.target.checked)}
            className="accent-sky-500"
          />
          High+ only ({riskyCount})
        </label>
      </header>

      <ol ref={listRef} className="scroll-thin max-h-[420px] overflow-y-auto py-1" aria-label="Checkpoints in order">
        {items.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-ink-400">
            No High, Severe or No Travel checkpoints on this route.
          </li>
        )}
        {items.map((item) =>
          item.kind === "stop" ? (
            <li
              key={`stop-${item.stop.start_elapsed_s}`}
              className="mx-3 my-1 flex items-center gap-2 rounded-lg border border-dashed border-ink-600 px-3 py-2 text-xs text-ink-300"
            >
              {item.stop.kind === "rest" ? <Moon size={13} /> : <Coffee size={13} />}
              <span className="font-medium">{item.stop.label}</span>
              <span className="text-ink-400">mile {item.stop.mile.toFixed(0)}</span>
              <span className="num ml-auto text-ink-400">{formatDateTime(item.stop.starts)}</span>
            </li>
          ) : (
            <CheckpointRow
              key={item.cp.index}
              cp={item.cp}
              last={item.cp.index === route.checkpoints.length - 1}
              focused={focused === item.cp.index}
              onFocus={() => onFocus(item.cp.index)}
            />
          ),
        )}
      </ol>
    </section>
  );
}

function CheckpointRow({
  cp,
  last,
  focused,
  onFocus,
}: {
  cp: Checkpoint;
  last: boolean;
  focused: boolean;
  onFocus: () => void;
}) {
  const level = cp.risk?.level ?? "unknown";
  const w = cp.weather;
  const rules = cp.risk?.factors.filter((f) => f.rule).map((f) => f.rule) ?? [];
  const drivers = cp.risk?.drivers ?? [];

  return (
    <li data-cp={cp.index}>
      <button
        type="button"
        onClick={onFocus}
        aria-current={focused ? "true" : undefined}
        className={clsx(
          "flex w-full gap-3 px-4 py-2 text-left transition-colors",
          focused ? "bg-ink-700/70" : "hover:bg-ink-800/80",
        )}
      >
        <span className="relative flex w-3 shrink-0 justify-center">
          <span className="absolute top-0 bottom-0 w-px bg-ink-700" style={last ? { bottom: "50%" } : undefined} />
          <span
            className="relative mt-1.5 h-3 w-3 rounded-full border-2 border-ink-900"
            style={{ backgroundColor: LEVEL_COLOR[level] }}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="num text-xs text-ink-400">mi {cp.mile.toFixed(0)}</span>
            <span className="num truncate text-xs text-ink-200">{formatDateTime(cp.eta)}</span>
            <span className="num hidden text-[10px] text-ink-400 sm:inline">+{formatDuration(cp.elapsed_s)}</span>
            <RiskChip level={level} className="ml-auto" />
          </span>
          {w ? (
            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-400">
              <Metric icon={<Wind size={11} />} hot={drivers.includes("wind")}>
                {w.wind_mph.toFixed(0)} mph{w.gust_mph != null && ` (g ${w.gust_mph.toFixed(0)})`}
              </Metric>
              <Metric icon={<Umbrella size={11} />} hot={drivers.includes("rain")}>
                {w.rain_in_hr.toFixed(2)} in/hr
              </Metric>
              <Metric icon={<Snowflake size={11} />} hot={drivers.includes("snow")}>
                {w.snow_in_hr.toFixed(2)} in/hr
              </Metric>
              {w.temp_f != null && <Metric icon={<Thermometer size={11} />}>{w.temp_f.toFixed(0)}°F</Metric>}
              <span className="text-ink-400">{weatherText(w.weather_code)}</span>
            </span>
          ) : (
            <span className="mt-1 block text-[11px] text-ink-400">No forecast available for this time.</span>
          )}
          {rules.map((r) => (
            <span key={r} className="mt-1 block text-[11px] font-medium text-risk-high">
              Load rule: {r}
            </span>
          ))}
        </span>
      </button>
    </li>
  );
}

function Metric({ icon, hot, children }: { icon: ReactNode; hot?: boolean; children: ReactNode }) {
  return (
    <span className={clsx("num inline-flex items-center gap-1", hot && "font-semibold text-ink-100")}>
      {icon}
      {children}
    </span>
  );
}
