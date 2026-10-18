import { test as base, expect, type Page, type Response } from "@playwright/test";
import type { Plan } from "../src/api/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __routecastMap?: any;
  }
}

/** Every test runs offline: the basemap is blocked, so the map uses its built-in fallback style (fonts are bundled). */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(/basemaps\.cartocdn\.com|tiles\.openfreemap\.org|fonts\.(googleapis|gstatic)\.com/, (r) =>
      r.abort(),
    );
    await use(page);
  },
});
export { expect };

export async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /plan routes/i })).toBeEnabled();
  await waitForMap(page);
}

export async function waitForMap(page: Page) {
  await page.waitForFunction(() => !!window.__routecastMap?.getSource("routes"), null, { timeout: 30_000 });
}

/** Wait until MapLibre has drawn everything it was asked to draw. */
export async function mapIdle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = window.__routecastMap;
        if (map.loaded() && !map.isMoving()) resolve();
        else map.once("idle", () => resolve());
        setTimeout(resolve, 5000);
      }),
  );
}

export interface PlanOptions {
  load?: number;
  interval?: 10 | 25 | 50;
  hos?: boolean;
}

/** Fill the form (Dallas → Denver preset by default), submit, and return the API response body. */
export async function planTrip(page: Page, opts: PlanOptions = {}): Promise<Plan> {
  if (opts.load != null) await page.getByLabel(/load weight/i).fill(String(opts.load));
  if (opts.interval) await page.getByRole("radio", { name: `${opts.interval} mi` }).click();
  if (opts.hos === false) await page.getByText("Driver hours-of-service").click();
  const response = page.waitForResponse(
    (r: Response) => r.url().endsWith("/api/plan") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /plan routes/i }).click();
  const plan = (await (await response).json()) as Plan;
  await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
  await waitForHeatmap(page);
  return plan;
}

export async function waitForHeatmap(page: Page) {
  await expect(page.getByText(/worst \w+ in the corridor at this hour/i)).toBeVisible();
}

/** Unique values of a property across a GeoJSON source's rendered features. */
export async function sourceValues(page: Page, source: string, prop: string): Promise<unknown[]> {
  await mapIdle(page);
  return page.evaluate(
    ([s, p]) => [...new Set(window.__routecastMap.querySourceFeatures(s).map((f: any) => f.properties[p]))],
    [source, prop] as const,
  );
}

/** Screen position of a lon/lat on the map canvas. */
export async function screenPoint(page: Page, lon: number, lat: number) {
  return page.evaluate(
    ([x, y]) => {
      const map = window.__routecastMap;
      const p = map.project([x, y]);
      const r = map.getCanvas().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
    [lon, lat] as const,
  );
}

export function sliderLabel(page: Page) {
  return page.locator('section[aria-label="Forecast time"] p[aria-live="polite"]');
}

export async function sliderHour(page: Page): Promise<number> {
  const text = (await sliderLabel(page).textContent()) ?? "";
  return Number(/T\+(\d+)/.exec(text)?.[1] ?? NaN);
}
