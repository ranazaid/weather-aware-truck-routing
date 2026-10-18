import clsx from "clsx";
import { Clock, Coffee, Moon, Star } from "lucide-react";
import type { PlannedRoute } from "../api/types";
import { formatDateTime, formatHours, formatMiles } from "../lib/format";
import { RiskBar } from "./RiskBar";
import { RiskChip } from "./RiskChip";

const VARIANT: Record<PlannedRoute["variant"], string> = {
  fastest: "Fastest",
  alternative: "Alternative",
  detour: "Detour",
};

interface Props {
  route: PlannedRoute;
  recommended: boolean;
  selected: boolean;
  onSelect: () => void;
}

export function RouteCard({ route, recommended, selected, onSelect }: Props) {
  const s = route.summary;
  const breaks = route.stops.filter((x) => x.kind === "break").length;
  const rests = route.stops.filter((x) => x.kind === "rest").length;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Route ${route.label} ${route.name}${recommended ? ", recommended" : ""}`}
      className={clsx(
        "group w-full rounded-xl border p-3.5 text-left transition-all",
        selected
          ? "border-accent/70 bg-ink-800 shadow-lg shadow-sky-950/50 ring-1 ring-accent/30"
          : "border-ink-700/80 bg-ink-900/80 hover:border-ink-500 hover:bg-ink-850",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={clsx(
            "grid h-7 w-7 shrink-0 place-items-center rounded-lg text-sm font-bold",
            selected ? "bg-accent text-ink-950" : "bg-ink-700 text-ink-100",
          )}
        >
          {route.label}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{route.name}</p>
          <p className="text-[11px] text-ink-400">{VARIANT[route.variant]} option</p>
        </div>
        {recommended && (
          <span className="chip bg-risk-low/15 text-risk-low ring-1 ring-risk-low/40 ring-inset">
            <Star size={11} fill="currentColor" /> Best
          </span>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-ink-500">Distance</dt>
          <dd className="num mt-0.5 text-ink-100">{formatMiles(route.distance_mi)}</dd>
        </div>
        <div>
          <dt className="text-ink-500">Door to door</dt>
          <dd className="num mt-0.5 text-ink-100">{formatHours(route.duration_s)}</dd>
        </div>
        <div>
          <dt className="text-ink-500">Worst</dt>
          <dd className="mt-0.5">
            <RiskChip level={s.max_level} />
          </dd>
        </div>
      </dl>

      <div className="mt-3">
        <RiskBar summary={s} />
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-400">
        <span className="inline-flex items-center gap-1">
          <Clock size={11} /> Arrives {formatDateTime(route.arrival)}
        </span>
        {breaks > 0 && (
          <span className="inline-flex items-center gap-1" title="30-minute breaks">
            <Coffee size={11} /> {breaks}
          </span>
        )}
        {rests > 0 && (
          <span className="inline-flex items-center gap-1" title="10-hour off-duty resets">
            <Moon size={11} /> {rests}
          </span>
        )}
        <span className="num ml-auto">
          {s.miles_by_level.severe > 0 && (
            <span className="text-risk-severe">{s.miles_by_level.severe.toFixed(0)} Severe · </span>
          )}
          {s.miles_by_level.high > 0 && (
            <span className="text-risk-high">{s.miles_by_level.high.toFixed(0)} High · </span>
          )}
          avg {s.avg_risk.toFixed(2)}
        </span>
      </div>
      {s.unknown_mi > 0 && (
        <p className="mt-2 text-[11px] text-ink-400">
          {formatMiles(s.unknown_mi)} beyond the forecast range (shown grey).
        </p>
      )}
    </button>
  );
}
