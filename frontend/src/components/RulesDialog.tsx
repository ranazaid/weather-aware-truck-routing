import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Rules } from "../api/types";
import { LEVEL_COLOR } from "../lib/risk";

interface Props {
  open: boolean;
  onClose: () => void;
  rules: Rules | undefined;
}

export function RulesDialog({ open, onClose, rules }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="rules-title"
      className="m-auto w-[min(720px,calc(100vw-2rem))] rounded-2xl border border-ink-600 bg-ink-900 p-0 text-ink-100 shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center border-b border-ink-700 px-5 py-4">
        <h2 id="rules-title" className="text-base font-semibold text-white">
          How risk is scored and routes are ranked
        </h2>
        <button type="button" onClick={onClose} className="btn-ghost ml-auto p-1.5" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="scroll-thin max-h-[75vh] space-y-5 overflow-y-auto px-5 py-4 text-sm">
        {rules ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-ink-400">
                    <th className="py-1.5 pr-3 text-left font-semibold">Condition</th>
                    {rules.levels.map((l) => (
                      <th key={l.key} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: LEVEL_COLOR[l.key] }} />
                        {l.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rules.conditions.map((c) => (
                    <tr key={c.name} className="border-t border-ink-800">
                      <th className="py-1.5 pr-3 text-left font-medium capitalize">{c.name}</th>
                      {c.bands.map((b) => (
                        <td key={b.level} className="num px-2 py-1.5 whitespace-nowrap text-ink-300">
                          {b.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="mb-1.5 text-xs font-semibold tracking-wider text-ink-400 uppercase">Load rules</h3>
              <ul className="space-y-1 text-ink-200">
                {rules.load_rules.map((r) => (
                  <li key={r.text} className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: LEVEL_COLOR[r.level] }} />
                    {r.text}
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <p className="text-ink-400">Loading rules…</p>
        )}
        <div>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wider text-ink-400 uppercase">Interpretation</h3>
          <ul className="list-disc space-y-1 pl-5 text-ink-300">
            <li>Each checkpoint takes the worst of its wind, rain and snow levels, after the load rules.</li>
            <li>Band edges belong to the higher band (25 mph is Moderate); rain above 1.00 and snow above 3.0 in/hr is No Travel.</li>
            <li>Wind is the sustained 10 m wind; gusts are shown for context.</li>
            <li>A checkpoint's weather applies to the road halfway to its neighbours, so miles add up to the route length.</li>
            <li>Weather is read at the truck's ETA: OSRM road timing, capped at the truck speed limit, plus FMCSA breaks and resets when enabled.</li>
          </ul>
        </div>
        <div>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wider text-ink-400 uppercase">Recommendation, rule by rule</h3>
          <ol className="list-decimal space-y-1 pl-5 text-ink-300">
            <li>Fewest No Travel miles (a route that must not be driven is never the safest)</li>
            <li>Fewest Severe miles</li>
            <li>Fewest High miles</li>
            <li>Lowest average risk (distance-weighted, Low = 0 … No Travel = 4)</li>
            <li>Shortest door-to-door travel time</li>
          </ol>
        </div>
      </div>
    </dialog>
  );
}
