import clsx from "clsx";
import {
  ArrowDownUp,
  CalendarClock,
  FlaskConical,
  Flag,
  Loader2,
  Navigation,
  Route as RouteIcon,
  Weight,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type { PlanRequest } from "../api/types";
import { fromLocalInput, nextQuarterHour, toLocalInput } from "../lib/format";
import { PlaceInput, placeText, type PlaceValue } from "./PlaceInput";

export const MAX_LOAD_LB = 80_000;
export const MAX_DAYS_AHEAD = 7;
const INTERVALS = [10, 25, 50] as const;
const LOAD_PRESETS = [10_000, 25_000, 35_000, 45_000];

export const PRESETS: { name: string; origin: PlaceValue; destination: PlaceValue }[] = [
  {
    name: "Dallas → Denver",
    origin: { label: "Dallas, Texas, US", lat: 32.7767, lon: -96.797 },
    destination: { label: "Denver, Colorado, US", lat: 39.7392, lon: -104.9903 },
  },
  {
    name: "Salt Lake City → Omaha",
    origin: { label: "Salt Lake City, Utah, US", lat: 40.7608, lon: -111.891 },
    destination: { label: "Omaha, Nebraska, US", lat: 41.2565, lon: -95.9345 },
  },
  {
    name: "Seattle → Missoula",
    origin: { label: "Seattle, Washington, US", lat: 47.6062, lon: -122.3321 },
    destination: { label: "Missoula, Montana, US", lat: 46.8721, lon: -113.994 },
  },
  {
    name: "Atlanta → Chicago",
    origin: { label: "Atlanta, Georgia, US", lat: 33.749, lon: -84.388 },
    destination: { label: "Chicago, Illinois, US", lat: 41.8781, lon: -87.6298 },
  },
];

type Errors = Partial<Record<"origin" | "destination" | "departure" | "load_lb", string>>;

export function validateTrip(
  v: { origin: PlaceValue; destination: PlaceValue; departure: string; load: string },
  now = new Date(),
): Errors {
  const e: Errors = {};
  const o = placeText(v.origin).trim();
  const d = placeText(v.destination).trim();
  if (o.length < 2) e.origin = "Choose where the truck starts.";
  if (d.length < 2) e.destination = "Choose where the truck is going.";
  else if (o && o.toLowerCase() === d.toLowerCase()) e.destination = "Destination must differ from the origin.";
  const dep = fromLocalInput(v.departure);
  if (!dep) e.departure = "Enter a departure date and time.";
  else if (dep.getTime() < now.getTime() - 3600_000) e.departure = "Departure can't be in the past.";
  else if (dep.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86400_000)
    e.departure = `Pick a time within the next ${MAX_DAYS_AHEAD} days (forecast range).`;
  const load = Number(v.load);
  if (v.load.trim() === "" || !Number.isFinite(load)) e.load_lb = "Enter the load weight in pounds.";
  else if (load < 0 || load > MAX_LOAD_LB) e.load_lb = `Load must be between 0 and ${MAX_LOAD_LB.toLocaleString()} lb.`;
  return e;
}

interface Props {
  onSubmit: (req: PlanRequest) => void;
  loading: boolean;
  serverErrors?: Record<string, string[]>;
  /** Start from this trip (a shared link, or a re-plan at another departure time). */
  initial?: PlanRequest | null;
}

export function TripForm({ onSubmit, loading, serverErrors = {}, initial }: Props) {
  const [origin, setOrigin] = useState<PlaceValue>(initial?.origin ?? PRESETS[0]!.origin);
  const [destination, setDestination] = useState<PlaceValue>(initial?.destination ?? PRESETS[0]!.destination);
  const [departure, setDeparture] = useState(() =>
    toLocalInput(initial ? new Date(initial.departure) : nextQuarterHour()),
  );
  const [load, setLoad] = useState(String(initial?.load_lb ?? 38000));
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>(initial?.interval_mi ?? 25);
  const [hos, setHos] = useState(initial?.hos ?? true);
  const [windAdd, setWindAdd] = useState(initial?.scenario?.wind_add_mph ?? 0);
  const [precipX, setPrecipX] = useState(initial?.scenario?.precip_factor ?? 1);
  const whatIf = windAdd > 0 || precipX > 1;
  const [touched, setTouched] = useState(false);

  const errors = useMemo(
    () => validateTrip({ origin, destination, departure, load }),
    [origin, destination, departure, load],
  );
  // A server error belongs to the values that were sent; hide it as soon as that field is edited.
  const [sent, setSent] = useState<Record<keyof Errors, unknown> | null>(null);
  const current: Record<keyof Errors, unknown> = { origin, destination, departure, load_lb: load };
  const shown = (k: keyof Errors) =>
    (touched ? errors[k] : undefined) ?? (sent && sent[k] === current[k] ? serverErrors[k]?.[0] : undefined);
  const minDeparture = toLocalInput(new Date(Date.now() - 3600_000));
  const maxDeparture = toLocalInput(new Date(Date.now() + MAX_DAYS_AHEAD * 86400_000));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setSent(current);
    onSubmit({
      origin,
      destination,
      departure: fromLocalInput(departure)!.toISOString(),
      load_lb: Number(load),
      interval_mi: interval,
      hos,
      scenario: whatIf ? { wind_add_mph: windAdd, precip_factor: precipX } : null,
    });
  };

  const quickTimes = [
    { label: "Now", date: nextQuarterHour() },
    { label: "+6 h", date: new Date(nextQuarterHour().getTime() + 6 * 3600_000) },
    {
      label: "Tomorrow 6 AM",
      date: (() => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(6, 0, 0, 0);
        return d;
      })(),
    },
  ];

  return (
    <form onSubmit={submit} noValidate aria-label="Trip details" className="space-y-4">
      <div className="space-y-1">
        <PlaceInput
          label="Origin"
          value={origin}
          onChange={setOrigin}
          placeholder="City, address or lat, lon"
          error={shown("origin")}
          icon={<Navigation size={15} />}
        />
        <div className="-mb-4 flex justify-end pr-1">
          <button
            type="button"
            onClick={() => {
              setOrigin(destination);
              setDestination(origin);
            }}
            className="relative z-10 rounded-full border border-ink-600 bg-ink-800 p-1.5 text-ink-300 shadow hover:border-accent hover:text-white"
            aria-label="Swap origin and destination"
            title="Swap origin and destination"
          >
            <ArrowDownUp size={13} />
          </button>
        </div>
        <PlaceInput
          label="Destination"
          value={destination}
          onChange={setDestination}
          placeholder="City, address or lat, lon"
          error={shown("destination")}
          icon={<Flag size={15} />}
        />
      </div>

      <div className="flex flex-wrap gap-1.5" aria-label="Example trips">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className="rounded-full border border-ink-700 px-2.5 py-1 text-[11px] text-ink-300 hover:border-ink-500 hover:text-white"
            onClick={() => {
              setOrigin(p.origin);
              setDestination(p.destination);
            }}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.35fr_1fr]">
        <div>
          <label htmlFor="departure" className="label">
            Departure
          </label>
          <div className="relative">
            <CalendarClock
              size={15}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-400"
            />
            <input
              id="departure"
              type="datetime-local"
              className={clsx("field pl-9 [color-scheme:dark]", shown("departure") && "field-invalid")}
              value={departure}
              min={minDeparture}
              max={maxDeparture}
              onChange={(e) => setDeparture(e.target.value)}
              aria-invalid={!!shown("departure")}
              aria-describedby="departure-help"
            />
          </div>
          <div id="departure-help" className="mt-1.5 flex flex-wrap gap-1">
            {quickTimes.map((q) => (
              <button
                key={q.label}
                type="button"
                className="rounded px-1.5 py-0.5 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-white"
                onClick={() => setDeparture(toLocalInput(q.date))}
              >
                {q.label}
              </button>
            ))}
          </div>
          {shown("departure") && <p className="mt-1 text-xs text-risk-severe">{shown("departure")}</p>}
        </div>

        <div>
          <label htmlFor="load" className="label">
            Load weight
          </label>
          <div className="relative">
            <Weight size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-400" />
            <input
              id="load"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_LOAD_LB}
              step={500}
              className={clsx("field num pr-9 pl-9", shown("load_lb") && "field-invalid")}
              value={load}
              onChange={(e) => setLoad(e.target.value)}
              aria-invalid={!!shown("load_lb")}
              aria-describedby="load-help"
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-ink-400">
              lb
            </span>
          </div>
          <div id="load-help" className="mt-1.5 flex flex-wrap gap-1">
            {LOAD_PRESETS.map((lb) => (
              <button
                key={lb}
                type="button"
                className={clsx(
                  "num rounded px-1.5 py-0.5 text-[11px] hover:bg-ink-800 hover:text-white",
                  Number(load) === lb ? "bg-ink-800 text-white" : "text-ink-400",
                )}
                onClick={() => setLoad(String(lb))}
              >
                {lb / 1000}k
              </button>
            ))}
          </div>
          {shown("load_lb") && <p className="mt-1 text-xs text-risk-severe">{shown("load_lb")}</p>}
        </div>
      </div>

      <fieldset>
        <legend className="label">Weather checkpoint every</legend>
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-ink-700 bg-ink-850 p-1" role="radiogroup">
          {INTERVALS.map((mi) => (
            <button
              key={mi}
              type="button"
              role="radio"
              aria-checked={interval === mi}
              onClick={() => setInterval(mi)}
              className={clsx(
                "num rounded-md py-1.5 text-sm transition-colors",
                interval === mi ? "bg-ink-600 text-white shadow" : "text-ink-400 hover:text-ink-100",
              )}
            >
              {mi} mi
            </button>
          ))}
        </div>
      </fieldset>

      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-700 bg-ink-850/60 p-3">
        <input type="checkbox" className="peer sr-only" checked={hos} onChange={(e) => setHos(e.target.checked)} />
        <span
          aria-hidden
          className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-ink-600 transition-colors peer-checked:bg-accent-strong peer-focus-visible:ring-2 peer-focus-visible:ring-accent after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
        />
        <span className="text-sm">
          <span className="font-medium text-ink-100">Driver hours-of-service</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-400">
            FMCSA 30-min break after 8 h and 10-h reset after 11 h of driving, so each checkpoint's weather is read when
            the truck is actually there.
          </span>
        </span>
      </label>

      <details className="group rounded-lg border border-ink-700 bg-ink-850/40">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm text-ink-300 hover:text-white">
          <FlaskConical size={14} />
          What-if weather
          {whatIf && <span className="chip ml-auto bg-risk-no_travel/15 text-risk-no_travel">simulated</span>}
        </summary>
        <div className="space-y-3 border-t border-ink-700 px-3 pt-2.5 pb-3">
          <p className="text-[11px] leading-relaxed text-ink-400">
            Stress-test the plan: add wind and scale precipitation on top of the real forecast. Results are clearly
            marked as simulated.
          </p>
          <label className="block text-xs text-ink-300">
            <span className="flex justify-between">
              Extra wind <span className="num text-ink-100">+{windAdd} mph</span>
            </span>
            <input
              type="range"
              className="slider mt-2"
              min={0}
              max={40}
              step={1}
              value={windAdd}
              onChange={(e) => setWindAdd(Number(e.target.value))}
              aria-label="Extra wind in mph"
            />
          </label>
          <label className="block text-xs text-ink-300">
            <span className="flex justify-between">
              Rain and snow <span className="num text-ink-100">×{precipX.toFixed(1)}</span>
            </span>
            <input
              type="range"
              className="slider mt-2"
              min={1}
              max={5}
              step={0.5}
              value={precipX}
              onChange={(e) => setPrecipX(Number(e.target.value))}
              aria-label="Precipitation multiplier"
            />
          </label>
          {whatIf && (
            <button
              type="button"
              className="text-[11px] text-accent hover:underline"
              onClick={() => {
                setWindAdd(0);
                setPrecipX(1);
              }}
            >
              Reset to the real forecast
            </button>
          )}
        </div>
      </details>

      <button type="submit" className="btn-primary w-full py-2.5" disabled={loading}>
        {loading ? <Loader2 size={16} className="animate-spin" /> : <RouteIcon size={16} />}
        {loading ? "Planning routes…" : "Plan routes"}
      </button>
    </form>
  );
}
