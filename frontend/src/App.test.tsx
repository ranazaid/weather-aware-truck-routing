import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { MapProps } from "./components/map/RouteMap";
import { makePlan } from "./test/fixtures";

// WebGL is not available in jsdom: replace the map with a probe that exposes its props.
vi.mock("./components/map/RouteMap", () => ({
  RouteMap: (p: MapProps) => (
    <div data-testid="map" data-selected={p.selectedId ?? ""} data-hour={p.hour} data-heat={p.heatmap ? "yes" : "no"}>
      {p.plan?.routes.map((r) => (
        <button key={r.id} type="button" onClick={() => p.onFocus(r.id, 1)}>
          map checkpoint {r.id}
        </button>
      ))}
    </div>
  ),
}));

const heatmap = {
  hours: 48,
  step_s: 3600,
  departure_ts: 0,
  points: [[-100, 35]],
  metrics: {
    risk: Array.from({ length: 49 }, () => [1.5]),
    wind: Array.from({ length: 49 }, () => [30]),
    rain: Array.from({ length: 49 }, () => [0]),
    snow: Array.from({ length: 49 }, () => [0]),
  },
  peak: { risk: 1.5, wind: 30, rain: 0, snow: 0 },
};

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/plan") && init?.method === "POST") return json(makePlan());
      if (url.includes("/heatmap")) return json(heatmap);
      if (url.includes("/api/meta")) return json({ rules: makePlan().rules });
      return json({ results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("plans a trip end to end", async () => {
    renderApp();
    expect(screen.getByText(/plan a trip to compare routes/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /plan routes/i }));

    expect(await screen.findByRole("heading", { name: /^route c via/i })).toBeInTheDocument();
    const body = JSON.parse(fetchMock.mock.calls.find(([u]) => String(u).endsWith("/api/plan"))![1].body);
    expect(body).toMatchObject({ interval_mi: 25, hos: true, load_lb: 38000 });

    // recommended route is selected on the map and in the cards
    expect(screen.getByTestId("map")).toHaveAttribute("data-selected", "C");
    const cards = screen.getByRole("list", { name: /route options/i });
    expect(within(cards).getByRole("button", { name: /route c.*recommended/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: /route c checkpoints/i })).toBeInTheDocument();

    // heatmap is fetched separately and reaches the map
    expect(await screen.findByText(/worst risk in the corridor/i)).toBeInTheDocument();
    expect(screen.getByTestId("map")).toHaveAttribute("data-heat", "yes");

    // selecting another route updates the timeline; clicking a map checkpoint selects its route
    await userEvent.click(within(cards).getByRole("button", { name: /route a/i }));
    expect(screen.getByRole("heading", { name: /route a checkpoints/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "map checkpoint B" }));
    expect(screen.getByTestId("map")).toHaveAttribute("data-selected", "B");

    // the form collapses to a summary that can be reopened
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(screen.getByRole("form", { name: /trip details/i })).toBeInTheDocument();
  });

  it("shows server errors with retry for provider failures", async () => {
    fetchMock.mockImplementationOnce(() =>
      json({ error: { code: "provider_error", message: "OSRM routing is unreachable right now; please try again" } }, 502),
    );
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: /plan routes/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/OSRM routing is unreachable/);
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("heading", { name: /^route c via/i })).toBeInTheDocument();
  });

  it("maps validation errors onto fields without a retry button", async () => {
    fetchMock.mockImplementationOnce(() =>
      json({ error: { code: "invalid", message: "Departure cannot be in the past.", fields: { departure: ["Departure cannot be in the past."] } } }, 400),
    );
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: /plan routes/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.getAllByText("Departure cannot be in the past.").length).toBeGreaterThanOrEqual(2);
  });

  it("opens the rules dialog", async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: /risk rules/i }));
    expect(await screen.findByText("25–34 mph")).toBeInTheDocument();
    expect(screen.getByText(/fewest severe miles/i)).toBeInTheDocument();
  });
});
