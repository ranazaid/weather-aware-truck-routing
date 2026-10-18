import clsx from "clsx";
import { Clock3 } from "lucide-react";
import type { DepartureAdvice } from "../api/types";
import { formatDayHour } from "../lib/format";

interface Props {
  advice: DepartureAdvice;
  departure: string;
  /** Latest departure the planner accepts (forecast range). */
  latestMs: number;
  onReplan: (offsetH: number) => void;
}

export function DepartureOptions({ advice, departure, latestMs, onReplan }: Props) {
  const dep = Date.parse(departure);
  const showNoTravel = advice.options.some((o) => o.no_travel_mi > 0);
  const best = advice.best_offset_h;
  const canPlan = (offset: number) => dep + offset * 3600_000 <= latestMs;

  return (
    <section aria-labelledby="dep-title" className="panel">
      <header className="flex items-center gap-2 border-b border-ink-700/80 px-4 py-3">
        <Clock3 size={15} className="text-accent" />
        <div>
          <h3 id="dep-title" className="text-sm font-semibold text-white">
            Best time to leave
          </h3>
          <p className="text-[11px] text-ink-400">Safest route for each departure, same forecast</p>
        </div>
      </header>

      {advice.text ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-700/80 bg-accent/[0.07] px-4 py-2.5 text-xs">
          <p className="min-w-0 flex-1 text-ink-100">{advice.text}</p>
          {canPlan(best) && (
            <button type="button" className="btn-primary px-2.5 py-1 text-xs" onClick={() => onReplan(best)}>
              Plan for {formatDayHour(dep + best * 3600_000)}
            </button>
          )}
        </div>
      ) : (
        <p className="border-b border-ink-700/80 px-4 py-2.5 text-xs text-ink-300">
          Leaving as planned is already the safest of these times.
        </p>
      )}

      <table className="w-full text-xs">
        <caption className="sr-only">Risk of the best route for each departure time</caption>
        <thead>
          <tr className="text-[10px] tracking-wider text-ink-400 uppercase">
            <th scope="col" className="px-4 py-1.5 text-left font-semibold">
              Leave
            </th>
            <th scope="col" className="px-2 py-1.5 text-left font-semibold">
              Route
            </th>
            {showNoTravel && (
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                No Travel
              </th>
            )}
            <th scope="col" className="px-2 py-1.5 text-right font-semibold">
              Severe
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-semibold">
              High
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-semibold">
              Avg
            </th>
            <th scope="col" className="w-12 px-2 py-1.5">
              <span className="sr-only">Plan</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {advice.options.map((o) => (
            <tr
              key={o.offset_h}
              className={clsx("border-t border-ink-800", o.offset_h === best && "bg-risk-low/[0.06]")}
              aria-current={o.offset_h === best ? "true" : undefined}
            >
              <th scope="row" className="px-4 py-1.5 text-left font-normal whitespace-nowrap text-ink-200">
                {o.offset_h === 0 ? "As planned" : `+${o.offset_h} h`}
                <span className="ml-1 text-ink-500">{formatDayHour(dep + o.offset_h * 3600_000)}</span>
              </th>
              <td className="px-2 py-1.5 text-ink-300">{o.label}</td>
              {showNoTravel && <td className="num px-2 py-1.5 text-right">{o.no_travel_mi.toFixed(0)}</td>}
              <td className="num px-2 py-1.5 text-right">{o.severe_mi.toFixed(0)}</td>
              <td className="num px-2 py-1.5 text-right">{o.high_mi.toFixed(0)}</td>
              <td className="num px-2 py-1.5 text-right">{o.avg_risk.toFixed(2)}</td>
              <td className="px-2 py-1.5 text-right">
                {o.offset_h > 0 && canPlan(o.offset_h) && (
                  <button
                    type="button"
                    className="text-accent hover:underline"
                    onClick={() => onReplan(o.offset_h)}
                    aria-label={`Plan for ${o.offset_h} hours later`}
                  >
                    Plan
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
