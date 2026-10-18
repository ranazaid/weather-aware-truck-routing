import clsx from "clsx";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import type { Plan, PlannedRoute } from "../api/types";
import { formatHours } from "../lib/format";

type Row = { key: string; label: string; get: (r: PlannedRoute) => number; fmt: (v: number) => string };

/** The ranking rules in the order they are applied (mirrors backend `recommend.CRITERIA`). */
export const CRITERIA: Row[] = [
  {
    key: "No Travel miles",
    label: "No Travel mi",
    get: (r) => r.summary.miles_by_level.no_travel,
    fmt: (v) => v.toFixed(1),
  },
  { key: "Severe miles", label: "Severe mi", get: (r) => r.summary.miles_by_level.severe, fmt: (v) => v.toFixed(1) },
  { key: "High miles", label: "High mi", get: (r) => r.summary.miles_by_level.high, fmt: (v) => v.toFixed(1) },
  { key: "average risk", label: "Avg risk", get: (r) => r.summary.avg_risk, fmt: (v) => v.toFixed(2) },
  { key: "travel time", label: "Travel time", get: (r) => r.duration_s, fmt: (v) => formatHours(v) },
];

export function Recommendation({
  plan,
  selectedId,
  onSelect,
}: {
  plan: Plan;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const rec = plan.recommendation;
  const best = plan.routes.find((r) => r.id === rec.route_id)!;
  const ordered = rec.order.map((id) => plan.routes.find((r) => r.id === id)!).filter(Boolean);
  const decisive = rec.comparisons[0]?.criterion;
  const danger = best.summary.miles_by_level.no_travel > 0 || best.summary.miles_by_level.severe > 0;

  return (
    <section aria-labelledby="rec-title" className="panel overflow-hidden">
      <div
        className={clsx(
          "flex items-start gap-3 border-b border-ink-700/80 p-4",
          danger ? "bg-risk-severe/10" : "bg-risk-low/[0.07]",
        )}
      >
        <span
          className={clsx(
            "mt-0.5 rounded-lg p-2",
            danger ? "bg-risk-severe/15 text-risk-severe" : "bg-risk-low/15 text-risk-low",
          )}
        >
          {danger ? <TriangleAlert size={18} /> : <ShieldCheck size={18} />}
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-wider text-ink-400 uppercase">Recommended</p>
          <h2 id="rec-title" className="truncate text-base font-semibold text-white">
            Route {best.label} <span className="font-normal text-ink-300">{best.name}</span>
          </h2>
          <p className="mt-0.5 text-sm text-ink-300">{rec.headline}</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            How the routes compare on each ranking rule, applied top to bottom. Average risk is distance-weighted, from
            0 (Low) to 4 (No Travel).
          </caption>
          <thead>
            <tr className="text-[11px] tracking-wider text-ink-400 uppercase">
              <th scope="col" className="px-3 py-2 text-left font-semibold whitespace-nowrap sm:px-4">
                Rule, in order
              </th>
              {ordered.map((r) => (
                <th key={r.id} scope="col" className="px-2 py-2 text-right font-semibold">
                  <button
                    type="button"
                    onClick={() => onSelect(r.id)}
                    className={clsx(
                      "rounded px-1.5 py-0.5",
                      r.id === selectedId ? "bg-ink-700 text-white" : "hover:text-white",
                    )}
                    aria-pressed={r.id === selectedId}
                  >
                    {r.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CRITERIA.map((c, i) => {
              const values = ordered.map((r) => c.get(r));
              const min = Math.min(...values);
              const isDecisive = c.key === decisive;
              return (
                <tr
                  key={c.key}
                  className={clsx("border-t border-ink-800", isDecisive && "bg-accent/[0.07]")}
                  aria-current={isDecisive ? "true" : undefined}
                >
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-ink-300 sm:px-4">
                    {/* the chip wraps under the label when space is short, so the table never overflows */}
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="whitespace-nowrap">
                        <span className="num mr-2 text-[10px] text-ink-400">{i + 1}</span>
                        {c.label}
                      </span>
                      {isDecisive && (
                        <span
                          className="chip bg-accent/15 px-1.5 text-[10px] text-accent"
                          title="This rule decided the recommendation"
                        >
                          decides
                        </span>
                      )}
                    </span>
                  </th>
                  {ordered.map((r, j) => {
                    const v = values[j]!;
                    const isBest = c.fmt(v) === c.fmt(min);
                    return (
                      <td
                        key={r.id}
                        className={clsx(
                          "num px-2 py-1.5 text-right whitespace-nowrap sm:px-3",
                          isBest ? "text-white" : "text-ink-400",
                        )}
                      >
                        {c.fmt(v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rec.comparisons.length > 0 && (
        <ul className="space-y-1 border-t border-ink-700/80 px-4 py-3 text-xs text-ink-400">
          {rec.comparisons.map((c) => (
            <li key={c.route_id}>{c.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
