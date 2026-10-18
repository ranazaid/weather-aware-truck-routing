import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api/client";
import type { HeatMetric, Plan, PlanRequest } from "./api/types";
import { CheckpointTimeline } from "./components/CheckpointTimeline";
import { ForecastSlider } from "./components/ForecastSlider";
import { MapLegend } from "./components/MapLegend";
import { RouteMap } from "./components/map/RouteMap";
import { Recommendation } from "./components/Recommendation";
import { RouteCard } from "./components/RouteCard";
import { RulesDialog } from "./components/RulesDialog";
import { EmptyResults, ErrorBanner, PlanningOverlay, ResultsSkeleton, Warnings } from "./components/States";
import { TripForm } from "./components/TripForm";
import { usePlayback } from "./hooks/usePlayback";
import { formatDateTime, formatLoad } from "./lib/format";

const MAX_HOUR = 48;

/** Retrying only helps when the network, a rate limit or a provider outage was the cause. */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

function TripSummary({ plan, onEdit }: { plan: Plan; onEdit: () => void }) {
  const r = plan.request;
  return (
    <div className="panel flex items-start gap-3 p-3.5">
      <div className="min-w-0 flex-1 text-sm">
        <p className="truncate font-semibold text-white">
          {r.origin.label} <span className="text-ink-500">→</span> {r.destination.label}
        </p>
        <p className="num mt-0.5 text-xs text-ink-400">
          {formatDateTime(r.departure)} · {formatLoad(r.load_lb)} · every {r.interval_mi} mi · HOS{" "}
          {r.hos ? "on" : "off"}
        </p>
        {r.scenario && (
          <p className="mt-1.5">
            <span className="chip bg-risk-no_travel/15 text-risk-no_travel ring-1 ring-risk-no_travel/40 ring-inset">
              What-if: {r.scenario.text}
            </span>
          </p>
        )}
      </div>
      <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={onEdit}>
        <Pencil size={12} /> Edit
      </button>
    </div>
  );
}

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ routeId: string; index: number } | null>(null);
  const [metric, setMetric] = useState<HeatMetric>("risk");
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showCheckpoints, setShowCheckpoints] = useState(true);
  const [speed, setSpeed] = useState(4);
  const [formOpen, setFormOpen] = useState(true);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [lastRequest, setLastRequest] = useState<PlanRequest | null>(null);
  const playback = usePlayback(MAX_HOUR, speed);
  const { reset: resetPlayback, toggle: togglePlayback, setHour } = playback;

  const planMut = useMutation({
    mutationFn: api.plan,
    onSuccess: (p) => {
      setSelectedId(p.recommendation.route_id);
      setFocus(null);
      resetPlayback();
      setFormOpen(false);
    },
  });
  const plan = planMut.data ?? null;

  const heat = useQuery({
    queryKey: ["heatmap", plan?.plan_id],
    queryFn: () => api.heatmap(plan!.plan_id),
    enabled: !!plan,
    staleTime: Infinity,
  });
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity, enabled: rulesOpen && !plan });

  const submit = useCallback(
    (req: PlanRequest) => {
      setLastRequest(req);
      planMut.mutate(req);
    },
    [planMut],
  );

  const onSelect = useCallback((id: string) => {
    setSelectedId(id);
    setFocus((f) => (f && f.routeId !== id ? null : f));
  }, []);
  const onFocus = useCallback((routeId: string, index: number) => {
    setSelectedId(routeId);
    setFocus({ routeId, index });
  }, []);

  // Space toggles playback, arrows step an hour (unless typing in a field).
  useEffect(() => {
    if (!plan) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true], dialog[open]") || t.tagName === "BUTTON"))
        return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlayback();
      } else if (e.key === "ArrowRight") setHour(Math.floor(playback.hour) + 1);
      else if (e.key === "ArrowLeft") setHour(Math.ceil(playback.hour) - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plan, togglePlayback, setHour, playback.hour]);

  const error = planMut.error;
  const serverFields = error instanceof ApiError ? error.fields : {};
  const selected = plan?.routes.find((r) => r.id === selectedId) ?? null;
  const heatError = heat.error
    ? heat.error instanceof ApiError && heat.error.code === "plan_expired"
      ? "Plan expired: plan the trip again to reload the heatmap."
      : "Corridor forecast unavailable right now."
    : null;

  return (
    <div className="flex min-h-full flex-col lg:h-full">
      <header className="flex items-center gap-3 border-b border-ink-800 bg-ink-950/95 px-4 py-2.5">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <div className="min-w-0">
          <h1 className="text-sm leading-tight font-semibold text-white">RouteCast</h1>
          <p className="truncate text-[11px] text-ink-400">Weather-aware truck routing</p>
        </div>
        <button type="button" className="btn-ghost ml-auto px-2.5 py-1.5 text-xs" onClick={() => setRulesOpen(true)}>
          <BookOpen size={14} /> Risk rules
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="scroll-thin order-2 w-full shrink-0 space-y-3 border-ink-800 p-3 lg:order-1 lg:w-[430px] lg:overflow-y-auto lg:border-r xl:w-[460px]">
          {plan && !formOpen && <TripSummary plan={plan} onEdit={() => setFormOpen(true)} />}
          {/* Kept mounted while collapsed so "Edit" reopens the trip exactly as it was entered. */}
          <div className="panel p-4" hidden={!!plan && !formOpen}>
            <TripForm onSubmit={submit} loading={planMut.isPending} serverErrors={serverFields} />
          </div>

          {error && (
            <ErrorBanner
              message={error instanceof Error ? error.message : "Planning failed."}
              onRetry={lastRequest && isRetryable(error) ? () => submit(lastRequest) : undefined}
            />
          )}

          {planMut.isPending ? (
            <ResultsSkeleton />
          ) : plan && selected ? (
            <>
              <Warnings items={plan.warnings} />
              <Recommendation plan={plan} selectedId={selected.id} onSelect={onSelect} />
              <div className="space-y-2" role="list" aria-label="Route options">
                {plan.routes.map((r) => (
                  <div role="listitem" key={r.id}>
                    <RouteCard
                      route={r}
                      recommended={r.id === plan.recommendation.route_id}
                      selected={r.id === selected.id}
                      onSelect={() => onSelect(r.id)}
                    />
                  </div>
                ))}
              </div>
              <CheckpointTimeline
                route={selected}
                focused={focus?.routeId === selected.id ? focus.index : null}
                onFocus={(i) => onFocus(selected.id, i)}
              />
              <p className="px-1 pb-2 text-[10px] leading-relaxed text-ink-500">
                Routing © OSRM / OpenStreetMap contributors · Forecast © Open-Meteo · Truck speed capped at{" "}
                {plan.request.truck_speed_cap_mph} mph · Generated {formatDateTime(plan.generated_at)}
              </p>
            </>
          ) : (
            !error && <EmptyResults />
          )}
        </aside>

        <main className="relative order-1 flex flex-1 flex-col lg:order-2">
          <div className="relative h-[52vh] min-h-[340px] sm:h-[62vh] lg:h-auto lg:flex-1">
            <RouteMap
              plan={plan}
              heatmap={heat.data ?? null}
              selectedId={selectedId}
              onSelect={onSelect}
              focus={focus}
              onFocus={onFocus}
              hour={playback.hour}
              metric={metric}
              showHeatmap={showHeatmap}
              showCheckpoints={showCheckpoints}
            />
            <div className="pointer-events-none absolute top-3 left-3 z-10 hidden sm:block">
              <div className="pointer-events-auto">
                <MapLegend
                  metric={metric}
                  showHeatmap={showHeatmap && !!heat.data}
                  showCheckpoints={showCheckpoints}
                  onShowCheckpoints={setShowCheckpoints}
                />
              </div>
            </div>
            {planMut.isPending && <PlanningOverlay />}
          </div>
          {plan && (
            <div className="z-10 p-2 sm:absolute sm:inset-x-3 sm:bottom-3 sm:p-0 lg:right-14">
              <ForecastSlider
                hour={playback.hour}
                maxHour={MAX_HOUR}
                onHour={setHour}
                playing={playback.playing}
                onToggle={togglePlayback}
                onReset={resetPlayback}
                speed={speed}
                onSpeed={setSpeed}
                metric={metric}
                onMetric={setMetric}
                heatmap={heat.data ?? null}
                heatLoading={heat.isLoading}
                heatError={heatError}
                departureMs={new Date(plan.request.departure).getTime()}
                showHeatmap={showHeatmap}
                onShowHeatmap={setShowHeatmap}
              />
            </div>
          )}
        </main>
      </div>

      <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} rules={plan?.rules ?? meta.data?.rules} />
    </div>
  );
}
