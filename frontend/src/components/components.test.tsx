import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Heatmap } from "../api/types";
import { makePlan } from "../test/fixtures";
import { CheckpointTimeline } from "./CheckpointTimeline";
import { ForecastSlider, peaksByHour } from "./ForecastSlider";
import { rangeText } from "./MapLegend";
import { PlaceInput } from "./PlaceInput";
import { Recommendation } from "./Recommendation";
import { RouteCard } from "./RouteCard";
import { TripForm, validateTrip } from "./TripForm";

vi.mock("../api/client", () => ({
  api: {
    geocode: vi.fn(async (q: string) =>
      q.toLowerCase().startsWith("den")
        ? [
            { label: "Denver, Colorado, US", lat: 39.74, lon: -104.99, kind: "city" },
            { label: "Denton, Texas, US", lat: 33.21, lon: -97.13, kind: "city" },
          ]
        : [],
    ),
  },
  ApiError: class extends Error {},
}));

function withQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("validateTrip", () => {
  const now = new Date("2026-10-20T12:00:00");
  const ok = { origin: "Dallas", destination: "Denver", departure: "2026-10-20T13:00", load: "38000" };

  it("accepts a valid trip", () => expect(validateTrip(ok, now)).toEqual({}));
  it("rejects missing or identical places", () => {
    expect(validateTrip({ ...ok, origin: "" }, now).origin).toBeTruthy();
    expect(validateTrip({ ...ok, destination: "dallas" }, now).destination).toMatch(/differ/);
  });
  it("rejects past and out-of-range departures", () => {
    expect(validateTrip({ ...ok, departure: "2026-10-20T10:00" }, now).departure).toMatch(/past/);
    expect(validateTrip({ ...ok, departure: "2026-10-28T13:00" }, now).departure).toMatch(/7 days/);
  });
  it("rejects bad loads", () => {
    expect(validateTrip({ ...ok, load: "" }, now).load_lb).toBeTruthy();
    expect(validateTrip({ ...ok, load: "-5" }, now).load_lb).toBeTruthy();
    expect(validateTrip({ ...ok, load: "90000" }, now).load_lb).toBeTruthy();
  });
});

describe("TripForm", () => {
  it("submits the request the API expects", async () => {
    const onSubmit = vi.fn();
    render(withQuery(<TripForm onSubmit={onSubmit} loading={false} />));
    await userEvent.click(screen.getByRole("radio", { name: "10 mi" }));
    await userEvent.click(screen.getByRole("button", { name: "45k" }));
    await userEvent.click(screen.getByRole("button", { name: /plan routes/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const req = onSubmit.mock.calls[0]![0];
    expect(req).toMatchObject({ interval_mi: 10, load_lb: 45000, hos: true });
    expect(req.origin).toMatchObject({ label: "Dallas, Texas, US" });
    expect(new Date(req.departure).toString()).not.toBe("Invalid Date");
  });

  it("sends a labelled what-if scenario only when one is set", async () => {
    const onSubmit = vi.fn();
    render(withQuery(<TripForm onSubmit={onSubmit} loading={false} />));
    await userEvent.click(screen.getByRole("button", { name: /plan routes/i }));
    expect(onSubmit.mock.calls[0]![0].scenario).toBeNull();
    await userEvent.click(screen.getByText("What-if weather"));
    fireEvent.change(screen.getByLabelText(/extra wind/i), { target: { value: "15" } });
    expect(screen.getByText("simulated")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /plan routes/i }));
    expect(onSubmit.mock.calls[1]![0].scenario).toEqual({ wind_add_mph: 15, precip_factor: 1 });
  });

  it("shows validation errors and does not submit", async () => {
    const onSubmit = vi.fn();
    render(withQuery(<TripForm onSubmit={onSubmit} loading={false} />));
    const load = screen.getByLabelText(/load weight/i);
    await userEvent.clear(load);
    await userEvent.type(load, "99999");
    await userEvent.click(screen.getByRole("button", { name: /plan routes/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/between 0 and 80,000/i)).toBeInTheDocument();
  });

  it("swaps origin and destination", async () => {
    render(withQuery(<TripForm onSubmit={vi.fn()} loading={false} />));
    await userEvent.click(screen.getByRole("button", { name: /swap/i }));
    expect(screen.getByLabelText("Origin")).toHaveValue("Denver, Colorado, US");
  });

  it("shows server field errors", () => {
    render(
      withQuery(
        <TripForm
          onSubmit={vi.fn()}
          loading={false}
          serverErrors={{ departure: ["Departure cannot be in the past."] }}
        />,
      ),
    );
    expect(screen.getByText("Departure cannot be in the past.")).toBeInTheDocument();
  });
});

describe("PlaceInput", () => {
  it("suggests places and picks one with the keyboard", async () => {
    const onChange = vi.fn();
    function Harness() {
      return <PlaceInput label="Destination" value="Den" onChange={onChange} />;
    }
    render(withQuery(<Harness />));
    const input = screen.getByRole("combobox", { name: "Destination" });
    input.focus();
    const options = await screen.findAllByRole("option", {}, { timeout: 2000 });
    expect(options).toHaveLength(2);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Denton, Texas, US" }));
  });
});

describe("Recommendation", () => {
  it("marks the rule that decided and highlights best values", async () => {
    const plan = makePlan();
    const onSelect = vi.fn();
    render(<Recommendation plan={plan} selectedId="C" onSelect={onSelect} />);
    expect(screen.getByRole("heading", { name: /route c/i })).toBeInTheDocument();
    const decisive = screen.getByRole("row", { name: /high mi/i });
    expect(decisive).toHaveAttribute("aria-current", "true");
    expect(within(decisive).getByText("decides")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    expect(onSelect).toHaveBeenCalledWith("A");
    expect(screen.getByText(/beats Route A on Severe miles/)).toBeInTheDocument();
  });
});

describe("RouteCard", () => {
  it("summarises a route", () => {
    const r = makePlan().routes[0]!;
    render(<RouteCard route={r} recommended={false} selected onSelect={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /route a/i });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("100 mi")).toBeInTheDocument();
    expect(screen.getByText("1h 40m")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /severe 25 mi/i })).toBeInTheDocument();
    expect(screen.queryByText("Best")).not.toBeInTheDocument();
  });
});

describe("CheckpointTimeline", () => {
  it("lists checkpoints with stops in time order and filters to High+", async () => {
    const r = makePlan().routes[0]!;
    const onFocus = vi.fn();
    render(<CheckpointTimeline route={r} focused={null} onFocus={onFocus} />);
    const list = screen.getByRole("list", { name: /checkpoints in order/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(5); // 4 checkpoints + 1 break
    expect(items[1]).toHaveTextContent("30-min break");
    expect(screen.getByText(/Load rule: 35–44 mph/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/high\+ only/i));
    expect(within(list).getAllByRole("listitem")).toHaveLength(2); // the Severe checkpoint + the break
    await userEvent.click(within(list).getAllByRole("button")[0]!);
    expect(onFocus).toHaveBeenCalledWith(1);
  });
});

describe("ForecastSlider", () => {
  const heatmap: Heatmap = {
    hours: 2,
    step_s: 3600,
    departure_ts: 0,
    points: [
      [0, 0],
      [1, 1],
    ],
    metrics: {
      risk: [
        [0.5, 1.2],
        [2.4, null],
        [0.1, 0.2],
      ],
      wind: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
      rain: [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      snow: [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    },
    peak: { risk: 2.4, wind: 6, rain: 0, snow: 0 },
  };

  it("computes the worst value per hour", () => {
    expect(peaksByHour(heatmap, "risk")).toEqual([1.2, 2.4, 0.2]);
  });

  it("drives hour, playback and metric", async () => {
    const props = {
      hour: 0,
      maxHour: 48,
      onHour: vi.fn(),
      playing: false,
      onToggle: vi.fn(),
      onReset: vi.fn(),
      speed: 4,
      onSpeed: vi.fn(),
      metric: "risk" as const,
      onMetric: vi.fn(),
      heatmap,
      heatLoading: false,
      heatError: null,
      departureMs: Date.parse("2026-10-20T14:00:00Z"),
      showHeatmap: true,
      onShowHeatmap: vi.fn(),
    };
    render(<ForecastSlider {...props} />);
    fireEvent.change(screen.getByRole("slider", { name: /forecast hour/i }), { target: { value: "12" } });
    expect(props.onHour).toHaveBeenCalledWith(12);
    await userEvent.click(screen.getByRole("button", { name: /play forecast/i }));
    expect(props.onToggle).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Snow" }));
    expect(props.onMetric).toHaveBeenCalledWith("snow");
    expect(screen.getByText(/worst risk in the corridor/i)).toHaveTextContent("Moderate");
  });
});

describe("legend wording", () => {
  it("uses the assessment's band text", () => {
    expect(rangeText("wind", 1)).toBe("25–34");
    expect(rangeText("wind", 4)).toBe("≥ 55 mph");
    expect(rangeText("rain", 1)).toBe("0.10–0.25");
    expect(rangeText("rain", 4)).toBe("> 1.00 in/hr");
    expect(rangeText("snow", 3)).toBe("2.0–3.0");
  });
});
