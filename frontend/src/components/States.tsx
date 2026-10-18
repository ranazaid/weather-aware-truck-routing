import { AlertTriangle, CloudSun, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

const STEPS = [
  "Finding three distinct road routes…",
  "Timing the truck, including driver breaks…",
  "Fetching forecasts at every checkpoint ETA…",
  "Scoring risk and ranking routes…",
];

export function PlanningOverlay() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => Math.min(STEPS.length - 1, s + 1)), 1400);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-ink-950/40 backdrop-blur-[1px]">
      <div className="panel flex items-center gap-3 px-4 py-3" role="status" aria-live="polite">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink-600 border-t-accent" aria-hidden />
        <span className="text-sm text-ink-200">{STEPS[step]}</span>
      </div>
    </div>
  );
}

export function ResultsSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="panel h-40 animate-pulse bg-ink-850" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="panel h-32 animate-pulse bg-ink-850" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-risk-severe/40 bg-risk-severe/10 p-3 text-sm">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-risk-severe" />
      <p className="flex-1 text-ink-100">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-ghost -my-1 px-2 py-1 text-xs">
          <RefreshCw size={12} /> Retry
        </button>
      )}
    </div>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1.5" aria-label="Warnings">
      {items.map((w) => (
        <li key={w} className="flex items-start gap-2 rounded-lg border border-risk-high/30 bg-risk-high/10 px-3 py-2 text-xs text-ink-100">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-risk-high" /> {w}
        </li>
      ))}
    </ul>
  );
}

export function EmptyResults() {
  return (
    <div className="panel p-5 text-center">
      <CloudSun size={28} className="mx-auto text-accent" />
      <h2 className="mt-2 text-sm font-semibold text-white">Plan a trip to compare routes</h2>
      <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-ink-400">
        You'll get three road routes, the forecast at every checkpoint for the moment the truck gets there, and a
        recommendation that explains itself.
      </p>
    </div>
  );
}
