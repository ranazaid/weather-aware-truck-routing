import { expect, test, type Page } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __routecastMap?: any;
  }
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  page.on("response", (r) => r.url().includes("/api/") && r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  return errors;
}

async function plan(page: Page) {
  const res = page.waitForResponse((r) => r.url().endsWith("/api/plan") && r.request().method() === "POST");
  await page.getByRole("button", { name: /plan routes/i }).click();
  const body = await (await res).json();
  await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(page.getByText(/worst \w+ in the corridor at this hour/i)).toBeVisible();
  return body;
}

test("the hosted app plans a real trip end to end", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await page.waitForFunction(() => !!window.__routecastMap?.isStyleLoaded?.(), null, { timeout: 60_000 });
  // the real basemap loaded (not the offline fallback)
  const layers = await page.evaluate(() => window.__routecastMap.getStyle().layers.length);
  expect(layers).toBeGreaterThan(20);

  await page.getByRole("button", { name: "Clear destination" }).click();
  await page.getByRole("combobox", { name: "Destination" }).fill("Denver");
  await page
    .getByRole("option", { name: /^Denver, Colorado, US/ })
    .first()
    .click();
  const body = await plan(page);
  expect(body.routes).toHaveLength(3);
  for (const r of body.routes) {
    expect(r.checkpoints.length).toBeGreaterThan(20);
    expect(r.checkpoints.every((c: any) => c.weather && c.risk)).toBe(true); // forecast at every ETA
  }
  await expect(page.getByRole("table", { name: /how the routes compare/i })).toBeVisible();
  await expect(page.getByRole("region", { name: "Best time to leave" })).toBeVisible();
  await expect(page.locator(".truck")).toHaveCount(3);

  await page.locator('li[data-cp="3"] button').click();
  await expect(page.locator(".maplibregl-popup")).toContainText("ETA");
  await page.getByRole("button", { name: "Play forecast" }).click();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Pause forecast playback" }).click();
  await page.getByRole("radio", { name: "Wind" }).click();
  await page.getByRole("button", { name: /risk rules/i }).click();
  await expect(page.getByRole("dialog")).toContainText("25–34 mph");
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("a long trip stays within the weather budget", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(
    "/?o=34.05220,-118.24370,Los%20Angeles&d=40.71280,-74.00600,New%20York&t=2099-01-01T00:00:00Z&w=42000&i=10&h=1",
  );
  // the link's date is far in the future: the server rejects it and the form explains why
  await expect(page.getByRole("alert")).toContainText(/within the next 7 days/i);
  await page.getByRole("button", { name: "Now", exact: true }).click();
  const body = await plan(page);
  expect(body.routes.every((r: any) => r.checkpoints.length > 200)).toBe(true);
  // the only error allowed is the expected 400 for the out-of-range link
  expect(errors.filter((e) => !e.includes("/api/plan") && !e.includes("status of 400"))).toEqual([]);
});

test("phone layout on the hosted app", async ({ page }) => {
  await page.goto("/");
  await plan(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
