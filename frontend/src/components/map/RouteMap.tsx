import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type Map as MLMap,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Checkpoint, HeatMetric, Heatmap, Plan, PlannedRoute } from "../../api/types";
import { formatDateTime, formatDuration } from "../../lib/format";
import { LEVEL_COLOR, LEVEL_LABEL, weatherText } from "../../lib/risk";
import { truckState, unionBbox } from "../../lib/track";
import { BASEMAPS, US_VIEW, escapeHtml, heatColor, heatOpacity, heatRadius, segmentColor } from "./style";

export interface MapProps {
  plan: Plan | null;
  heatmap: Heatmap | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  focus: { routeId: string; index: number } | null;
  onFocus: (routeId: string, index: number) => void;
  hour: number;
  metric: HeatMetric;
  showHeatmap: boolean;
  showCheckpoints: boolean;
  padding?: { top: number; bottom: number; left: number; right: number };
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#0b1120" } }],
};

async function loadStyle(): Promise<StyleSpecification> {
  for (const url of BASEMAPS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.ok) return (await r.json()) as StyleSpecification;
    } catch {
      /* try the next basemap */
    }
  }
  return FALLBACK_STYLE;
}

const TRUCK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';

const icon = (paths: string) =>
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const MOON_SVG = icon('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>');
const COFFEE_SVG = icon(
  '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M6 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/>',
);

function checkpointHtml(route: PlannedRoute, cp: Checkpoint): string {
  const level = cp.risk?.level ?? "unknown";
  const color = LEVEL_COLOR[level];
  const w = cp.weather;
  const rows = w
    ? [
        ["Wind", `${w.wind_mph.toFixed(0)} mph${w.gust_mph != null ? ` · gusts ${w.gust_mph.toFixed(0)}` : ""}`],
        ["Rain", `${w.rain_in_hr.toFixed(2)} in/hr`],
        ["Snow", `${w.snow_in_hr.toFixed(2)} in/hr`],
        ["Sky", `${weatherText(w.weather_code)}${w.temp_f != null ? ` · ${w.temp_f.toFixed(0)}°F` : ""}`],
      ]
    : [["Forecast", "Not available for this time"]];
  const rules = (cp.risk?.factors ?? []).filter((f) => f.rule).map((f) => f.rule!);
  const drivers = cp.risk?.drivers ?? [];
  return `
    <div style="min-width:220px;font:12px Inter,system-ui,sans-serif">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #1e293b">
        <b style="color:#fff">Route ${escapeHtml(route.label)} · mile ${cp.mile.toFixed(0)}</b>
        <span style="margin-left:auto;color:${color};background:${color}22;border:1px solid ${color}66;border-radius:999px;padding:1px 8px;font-weight:600;font-size:11px">${LEVEL_LABEL[level]}</span>
      </div>
      <div style="padding:8px 12px;color:#a7b2c7">
        <div style="color:#e2e8f0;margin-bottom:6px">ETA ${escapeHtml(formatDateTime(cp.eta))}
          <span style="color:#7c8aa5"> (+${formatDuration(cp.elapsed_s)})</span></div>
        ${rows
          .map(
            ([k, v]) =>
              `<div style="display:flex;justify-content:space-between;gap:12px;padding:1px 0"><span>${k}</span><span style="color:#e2e8f0;font-family:'JetBrains Mono',monospace">${escapeHtml(v!)}</span></div>`,
          )
          .join("")}
        ${drivers.length ? `<div style="margin-top:6px;color:#cbd5e1">Driven by ${drivers.join(" + ")}</div>` : ""}
        ${rules.map((r) => `<div style="margin-top:4px;color:#f97316;font-weight:600">${escapeHtml(r)}</div>`).join("")}
      </div>
    </div>`;
}

/** Push one (interpolated) forecast hour into the heat layer's feature state: no data upload, no re-tiling. */
function paintFrame(map: MLMap, heatmap: Heatmap, metric: HeatMetric, hour: number) {
  const frames = heatmap.metrics[metric];
  const h = Math.max(0, Math.min(heatmap.hours, hour));
  const h0 = Math.floor(h);
  const h1 = Math.min(heatmap.hours, h0 + 1);
  const t = h - h0;
  const a = frames[h0] ?? [];
  const b = frames[h1] ?? a;
  for (let i = 0; i < heatmap.points.length; i++) {
    const va = a[i];
    const vb = b[i];
    const v = va == null ? vb : vb == null ? va : va + (vb - va) * t;
    map.setFeatureState({ source: "heat", id: i }, { v: v ?? 0, has: v != null });
  }
}

function el(className: string, html: string, title?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = className;
  d.innerHTML = html;
  if (title) d.title = title;
  return d;
}

function RouteMapImpl(props: MapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const latest = useRef(props);
  const [ready, setReady] = useState(false);
  const markers = useRef({
    fixed: [] as maplibregl.Marker[],
    trucks: new Map<string, maplibregl.Marker>(),
  });
  const popup = useRef<maplibregl.Popup | null>(null);
  const hover = useRef<{ popup: maplibregl.Popup | null; id: number | null }>({ popup: null, id: null });
  const focusedId = useRef<number | null>(null);
  const lastMetric = useRef<HeatMetric | null>(null);
  const applyFrame = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    latest.current = props;
  });

  // ------------------------------------------------------------------ init
  useEffect(() => {
    let cancelled = false;
    let map: MLMap | null = null;
    void loadStyle().then((style) => {
      if (cancelled || !container.current) return;
      map = new maplibregl.Map({
        container: container.current,
        style,
        center: US_VIEW.center,
        zoom: US_VIEW.zoom,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
        fadeDuration: 0,
      });
      mapRef.current = map;
      // Browser automation only (navigator.webdriver): lets end-to-end tests inspect layers and project points.
      if (navigator.webdriver) (window as unknown as { __routecastMap?: MLMap }).__routecastMap = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "top-right");
      map.on("load", () => {
        installLayers(map!);
        wireEvents(map!);
        setReady(true);
      });
    });
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  function installLayers(map: MLMap) {
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addSource("heat", { type: "geojson", data: EMPTY, promoteId: "i" });
    map.addLayer(
      {
        id: "heat",
        type: "circle",
        source: "heat",
        paint: {
          "circle-radius": heatRadius,
          "circle-color": heatColor("risk"),
          "circle-opacity": heatOpacity("risk"),
          "circle-blur": 1,
          "circle-pitch-alignment": "map",
        },
      },
      firstSymbol,
    );
    map.addSource("routes", { type: "geojson", data: EMPTY });
    map.addSource("segments", { type: "geojson", data: EMPTY });
    map.addSource("checkpoints", { type: "geojson", data: EMPTY, promoteId: "fid" });
    const line = { "line-join": "round", "line-cap": "round" } as const;
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: "routes",
      layout: line,
      paint: {
        "line-color": "#020617",
        "line-width": ["case", ["get", "selected"], 11, 6.5],
        "line-opacity": ["case", ["get", "selected"], 0.95, 0.75],
      },
    });
    map.addLayer({
      id: "segments-dim",
      type: "line",
      source: "segments",
      layout: line,
      filter: ["!", ["get", "selected"]],
      paint: { "line-color": segmentColor, "line-width": 3.5, "line-opacity": 0.85 },
    });
    map.addLayer({
      id: "segments-sel",
      type: "line",
      source: "segments",
      layout: line,
      filter: ["get", "selected"],
      paint: {
        "line-color": segmentColor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 5, 10, 8],
      },
    });
    map.addLayer({
      id: "route-hit",
      type: "line",
      source: "routes",
      layout: line,
      paint: { "line-color": "#000", "line-opacity": 0, "line-width": 22 },
    });
    const focusB: ExpressionSpecification = ["boolean", ["feature-state", "focus"], false];
    const hoverB: ExpressionSpecification = ["boolean", ["feature-state", "hover"], false];
    map.addLayer({
      id: "cp",
      type: "circle",
      source: "checkpoints",
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          ["case", focusB, 8.5, hoverB, 6.5, 3.6],
          9,
          ["case", focusB, 10, hoverB, 8.5, 6.5],
        ],
        "circle-color": segmentColor,
        "circle-stroke-color": ["case", focusB, "#ffffff", "#0b1120"],
        "circle-stroke-width": ["case", focusB, 3, 1.6],
      },
    });
  }

  function wireEvents(map: MLMap) {
    // Feature state set while the worker is still parsing new heat data can be dropped: repaint once loaded.
    map.on("sourcedata", (e) => {
      if (e.sourceId === "heat" && e.isSourceLoaded) applyFrame.current?.();
    });
    map.on("mouseenter", "route-hit", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "route-hit", () => (map.getCanvas().style.cursor = ""));
    map.on("click", "route-hit", (e: MapLayerMouseEvent) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["cp"] }).length) return;
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) latest.current.onSelect(id);
    });
    map.on("click", "cp", (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties;
      if (p) latest.current.onFocus(String(p.routeId), Number(p.index));
    });
    map.on("mousemove", "cp", (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features?.[0];
      if (!f) return;
      const id = Number(f.id);
      if (hover.current.id !== id) {
        if (hover.current.id != null)
          map.setFeatureState({ source: "checkpoints", id: hover.current.id }, { hover: false });
        map.setFeatureState({ source: "checkpoints", id }, { hover: true });
        hover.current.id = id;
      }
      const { plan } = latest.current;
      const route = plan?.routes.find((r) => r.id === f.properties?.routeId);
      const cp = route?.checkpoints[Number(f.properties?.index)];
      if (!route || !cp || focusedId.current === id) return;
      hover.current.popup ??= new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
        maxWidth: "280px",
      });
      hover.current.popup.setLngLat([cp.lon, cp.lat]).setHTML(checkpointHtml(route, cp)).addTo(map);
    });
    map.on("mouseleave", "cp", () => {
      map.getCanvas().style.cursor = "";
      if (hover.current.id != null)
        map.setFeatureState({ source: "checkpoints", id: hover.current.id }, { hover: false });
      hover.current.id = null;
      hover.current.popup?.remove();
    });
  }

  const { plan, selectedId, showCheckpoints, heatmap, hour, metric, showHeatmap, focus, padding } = props;

  // ------------------------------------------------------------------ routes, segments, checkpoints, markers
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const routes = plan?.routes ?? [];
    (map.getSource("routes") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: [...routes]
        .sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId))
        .map((r) => ({
          type: "Feature",
          properties: { id: r.id, selected: r.id === selectedId },
          geometry: r.geometry,
        })),
    });
    (map.getSource("segments") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: routes.flatMap((r) =>
        r.segments.map((s) => ({
          type: "Feature" as const,
          properties: { routeId: r.id, level: s.level, selected: r.id === selectedId },
          geometry: { type: "LineString" as const, coordinates: s.coordinates },
        })),
      ),
    });
    const sel = routes.find((r) => r.id === selectedId);
    (map.getSource("checkpoints") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features:
        sel && showCheckpoints
          ? sel.checkpoints.map((cp) => ({
              type: "Feature" as const,
              properties: { fid: cp.index, routeId: sel.id, index: cp.index, level: cp.risk?.level ?? "unknown" },
              geometry: { type: "Point" as const, coordinates: [cp.lon, cp.lat] },
            }))
          : [],
    });
    focusedId.current = null;

    markers.current.fixed.forEach((m) => m.remove());
    markers.current.fixed = [];
    if (plan) {
      const add = (m: maplibregl.Marker) => markers.current.fixed.push(m.addTo(map));
      const o = plan.request.origin;
      const d = plan.request.destination;
      add(
        new maplibregl.Marker({ element: el("map-pin map-pin-origin", "", o.label), anchor: "center" }).setLngLat([
          o.lon,
          o.lat,
        ]),
      );
      add(
        new maplibregl.Marker({ element: el("map-pin map-pin-dest", "", d.label), anchor: "center" }).setLngLat([
          d.lon,
          d.lat,
        ]),
      );
      for (const r of routes) {
        const coords = r.geometry.coordinates;
        const at = coords[Math.floor(coords.length * (0.38 + 0.12 * "ABC".indexOf(r.id)))] ?? coords[0]!;
        const badge = el(
          `route-badge${r.id === selectedId ? " route-badge-selected" : ""}`,
          escapeHtml(r.label),
          `Route ${r.label}`,
        );
        badge.addEventListener("click", (ev) => {
          ev.stopPropagation();
          latest.current.onSelect(r.id);
        });
        add(new maplibregl.Marker({ element: badge, anchor: "center" }).setLngLat(at));
      }
      for (const s of sel?.stops ?? []) {
        const icon = s.kind === "rest" ? MOON_SVG : COFFEE_SVG;
        add(
          new maplibregl.Marker({
            element: el(
              `stop-pin stop-pin-${s.kind}`,
              icon,
              `${s.label} · mile ${s.mile.toFixed(0)} · ${formatDateTime(s.starts)}`,
            ),
            anchor: "center",
          }).setLngLat([s.lon, s.lat]),
        );
      }
    }
  }, [ready, plan, selectedId, showCheckpoints]);

  // ------------------------------------------------------------------ fit to a new plan
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !plan) return;
    const b = unionBbox(plan.routes);
    if (!b) return;
    const wide = map.getContainer().clientWidth >= 640;
    map.fitBounds(b as LngLatBoundsLike, {
      // keep routes clear of the legend (top-left) and the forecast panel (bottom)
      padding: padding ?? { top: 40, bottom: wide ? 215 : 40, left: wide ? 250 : 30, right: wide ? 70 : 40 },
      duration: 900,
      maxZoom: 9,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, plan?.plan_id]);

  // ------------------------------------------------------------------ heatmap data
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("heat") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (heatmap?.points ?? []).map((c, i) => ({
        type: "Feature",
        properties: { i },
        geometry: { type: "Point", coordinates: c },
      })),
    });
    lastMetric.current = null;
  }, [ready, heatmap]);

  // ------------------------------------------------------------------ heatmap frame + trucks (runs every slider tick)
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setLayoutProperty("heat", "visibility", showHeatmap && heatmap ? "visible" : "none");
    if (heatmap && showHeatmap) {
      if (lastMetric.current !== metric) {
        map.setPaintProperty("heat", "circle-color", heatColor(metric));
        map.setPaintProperty("heat", "circle-opacity", heatOpacity(metric));
        lastMetric.current = metric;
      }
      applyFrame.current = () => paintFrame(map, heatmap, metric, hour);
      applyFrame.current();
    } else {
      applyFrame.current = null;
    }

    const routes = plan?.routes ?? [];
    const trucks = markers.current.trucks;
    for (const [id, m] of trucks) {
      if (!routes.some((r) => r.id === id)) {
        m.remove();
        trucks.delete(id);
      }
    }
    for (const r of routes) {
      const st = truckState(r, hour * 3600);
      if (!st) continue;
      let m = trucks.get(r.id);
      if (!m) {
        m = new maplibregl.Marker({ element: el("truck", "", ""), anchor: "center" }).setLngLat(st.coord).addTo(map);
        trucks.set(r.id, m);
      }
      const node = m.getElement();
      // toggle our classes only: MapLibre keeps its own positioning classes on the same element
      for (const s of ["driving", "parked", "arrived", "not_departed"])
        node.classList.toggle(`truck-${s}`, st.status === s);
      node.classList.toggle("truck-selected", r.id === selectedId);
      const html = `${TRUCK_SVG}<span>${escapeHtml(r.label)}</span>`;
      if (node.dataset.label !== r.label) {
        node.innerHTML = html;
        node.dataset.label = r.label;
      }
      node.title = `Route ${r.label}: ${st.status.replace("_", " ")} at T+${hour.toFixed(1)} h`;
      m.setLngLat(st.coord);
    }
  }, [ready, heatmap, hour, metric, showHeatmap, plan, selectedId]);

  // ------------------------------------------------------------------ focused checkpoint
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (focusedId.current != null) {
      map.setFeatureState({ source: "checkpoints", id: focusedId.current }, { focus: false });
      focusedId.current = null;
    }
    popup.current?.remove();
    if (!focus || !plan) return;
    const route = plan.routes.find((r) => r.id === focus.routeId);
    const cp = route?.checkpoints[focus.index];
    if (!route || !cp) return;
    if (route.id === selectedId && showCheckpoints) {
      map.setFeatureState({ source: "checkpoints", id: cp.index }, { focus: true });
      focusedId.current = cp.index;
    }
    hover.current.popup?.remove();
    popup.current = new maplibregl.Popup({ offset: 14, maxWidth: "300px", closeButton: true })
      .setLngLat([cp.lon, cp.lat])
      .setHTML(checkpointHtml(route, cp))
      .addTo(map);
    if (!map.getBounds().contains([cp.lon, cp.lat])) map.easeTo({ center: [cp.lon, cp.lat], duration: 600 });
  }, [ready, focus, plan, selectedId, showCheckpoints]);

  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" aria-label="Route map" role="region" />
      {!ready && (
        <div className="absolute inset-0 grid place-items-center bg-ink-950">
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-ink-600 border-t-accent"
            aria-label="Loading map"
          />
        </div>
      )}
    </div>
  );
}

export const RouteMap = memo(RouteMapImpl);
