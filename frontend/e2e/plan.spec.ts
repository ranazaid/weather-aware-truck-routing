import { expect, mapIdle, openApp, planTrip, screenPoint, sourceValues, test } from "./helpers";

// Fake weather (backend/planner/tests/fake_server.py): a 40 mph storm with 0.3 in/hr rain at its core
// sits on the straight Dallas-Denver route (A). Detour B clips it, detour C avoids it.

test.describe("plan results", () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test("recommends the route with the fewest High miles and explains why", async ({ page }) => {
    const plan = await planTrip(page, { load: 38000 });
    expect(plan.routes.map((r) => r.variant)).toEqual(["fastest", "detour", "detour"]);
    expect(plan.recommendation.route_id).toBe("C");

    await expect(page.getByRole("heading", { name: /^route c via/i })).toBeVisible();
    const decisive = page.getByRole("row", { name: /high mi/i });
    await expect(decisive).toHaveAttribute("aria-current", "true");
    await expect(decisive.getByText("decides")).toBeVisible();
    await expect(decisive.getByRole("cell")).toHaveText(["0.0", "50.0", "150.0"]); // columns in ranked order C, B, A

    await expect(page.getByText("Route C beats Route B on High miles: 0.0 mi vs 50.0 mi.")).toBeVisible();

    const cards = page.getByRole("list", { name: /route options/i });
    await expect(cards.getByRole("button")).toHaveCount(3);
    const best = cards.getByRole("button", { name: /route c.*recommended/i });
    await expect(best).toHaveAttribute("aria-pressed", "true");
    await expect(best.getByText("Best")).toBeVisible();
    await expect(cards.getByRole("button", { name: /route a/i }).getByText("High", { exact: true })).toBeVisible();
  });

  test("the decision table fits the panel whichever rule decides", async ({ page }) => {
    // Worst case: a wide fallback font, as when web fonts are blocked on Linux or Windows.
    await page.addStyleTag({ content: "* { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }" });
    for (const criterion of ["No Travel miles", "average risk", "travel time"]) {
      await page.route("**/api/plan", async (route) => {
        const response = await route.fetch();
        const plan = await response.json();
        plan.recommendation.comparisons[0].criterion = criterion; // force the widest label to carry the chip
        await route.fulfill({ response, json: plan });
      });
      if (criterion !== "No Travel miles") await page.getByRole("button", { name: "Edit" }).click();
      await planTrip(page);
      const table = page.getByRole("table", { name: /how the routes compare/i });
      await expect(table.getByText("decides")).toBeVisible();
      for (const t of [table, page.getByRole("table", { name: /best route for each departure/i })]) {
        const overflow = await t.evaluate((el) => el.scrollWidth - (el.parentElement?.clientWidth ?? 0));
        expect(overflow, `overflow when "${criterion}" decides`).toBeLessThanOrEqual(1);
      }
      await page.unroute("**/api/plan");
    }
  });

  test("a heavier load turns the same wind into Severe through the load rule", async ({ page }) => {
    await planTrip(page, { load: 45000 });
    await expect(page.getByRole("row", { name: /severe mi/i })).toHaveAttribute("aria-current", "true");
    await page
      .getByRole("list", { name: /route options/i })
      .getByRole("button", { name: /route a/i })
      .click();
    await page.getByLabel(/high\+ only/i).check();
    const rows = page.getByRole("list", { name: /checkpoints in order/i }).locator("li[data-cp]");
    expect(await rows.count()).toBeGreaterThan(0);
    for (const row of await rows.all()) await expect(row.locator(".chip")).toHaveText(/Severe|No Travel/);
    await expect(page.getByText("Load rule: 35–44 mph wind with load over 40,000 lb → Severe").first()).toBeVisible();
  });

  test("the checkpoint interval sets the number of checkpoints", async ({ page }) => {
    for (const interval of [10, 50] as const) {
      if (interval === 50) await page.getByRole("button", { name: "Edit" }).click();
      const plan = await planTrip(page, { interval });
      const route = plan.routes.find((r) => r.id === plan.recommendation.route_id)!;
      const expected = Math.ceil(route.distance_mi / interval - 1e-6) + 1;
      expect(route.checkpoints).toHaveLength(expected);
      expect(route.checkpoints[1]!.mile).toBe(interval);
      await expect(page.getByText(`${expected} checkpoints · weather at the truck's ETA`)).toBeVisible();
      await expect(page.locator("li[data-cp]")).toHaveCount(expected);
    }
  });

  test("hours of service adds a break and a reset, and moves later ETAs", async ({ page }) => {
    const withHos = await planTrip(page);
    const timeline = page.getByRole("list", { name: /checkpoints in order/i });
    await expect(timeline.getByText("30-min break")).toBeVisible();
    await expect(timeline.getByText("10-hr off-duty reset")).toBeVisible();
    await expect(page.locator(".stop-pin")).toHaveCount(2);

    await page.getByRole("button", { name: "Edit" }).click();
    const without = await planTrip(page, { hos: false });
    await expect(timeline.getByText("30-min break")).toHaveCount(0);
    await expect(page.locator(".stop-pin")).toHaveCount(0);
    await expect(page.getByText("HOS off")).toBeVisible();
    const a = withHos.routes[0]!;
    const b = without.routes[0]!;
    expect(a.duration_s - b.duration_s).toBe(10.5 * 3600);
    expect(a.checkpoints.at(-1)!.elapsed_s).toBeGreaterThan(b.checkpoints.at(-1)!.elapsed_s);
  });

  test("routes can be selected from cards, the decision table and map badges", async ({ page }) => {
    await planTrip(page);
    const heading = page.getByRole("heading", { name: /route . checkpoints/i });
    await page
      .getByRole("list", { name: /route options/i })
      .getByRole("button", { name: /route a/i })
      .click();
    await expect(heading).toHaveText("Route A checkpoints");
    expect(await sourceValues(page, "checkpoints", "routeId")).toEqual(["A"]);

    await page.getByRole("columnheader").getByRole("button", { name: "B" }).click();
    await expect(heading).toHaveText("Route B checkpoints");
    await expect(page.getByRole("columnheader").getByRole("button", { name: "B" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.locator(".route-badge", { hasText: "C" }).click();
    await expect(heading).toHaveText("Route C checkpoints");
    await expect(page.locator(".route-badge-selected")).toHaveText("C");
  });

  test("the map draws every route, checkpoint, stop, endpoint and truck", async ({ page }) => {
    const plan = await planTrip(page);
    const selected = plan.routes.find((r) => r.id === plan.recommendation.route_id)!;
    expect((await sourceValues(page, "routes", "id")).sort()).toEqual(["A", "B", "C"]);
    expect((await sourceValues(page, "segments", "routeId")).sort()).toEqual(["A", "B", "C"]);
    expect(await sourceValues(page, "checkpoints", "fid")).toHaveLength(selected.checkpoints.length);
    const levels = await sourceValues(page, "segments", "level");
    expect(levels).toEqual(expect.arrayContaining(["low", "high"]));
    await expect(page.locator(".maplibregl-marker.map-pin-origin")).toHaveCount(1);
    await expect(page.locator(".maplibregl-marker.map-pin-dest")).toHaveCount(1);
    await expect(page.locator(".route-badge")).toHaveCount(3);
    await expect(page.locator(".truck")).toHaveCount(3);
    await expect(page.locator(".stop-pin")).toHaveCount(selected.stops.length);
  });

  test("timeline and map checkpoints open the same popup", async ({ page }) => {
    const plan = await planTrip(page);
    const route = plan.routes.find((r) => r.id === "C")!;
    await page.locator('li[data-cp="2"] button').click();
    const popup = page.locator(".maplibregl-popup");
    await expect(popup).toContainText(`Route C · mile ${route.checkpoints[2]!.mile.toFixed(0)}`);
    await expect(popup).toContainText("ETA");
    await expect(popup).toContainText("Wind");
    await expect(page.locator('li[data-cp="2"] button')).toHaveAttribute("aria-current", "true");
    await popup.getByRole("button", { name: /close/i }).click();
    await expect(popup).toHaveCount(0);

    const cp = route.checkpoints[5]!;
    await mapIdle(page);
    const p = await screenPoint(page, cp.lon, cp.lat);
    await page.mouse.move(p.x, p.y);
    await expect(page.locator(".maplibregl-popup")).toContainText(`mile ${cp.mile.toFixed(0)}`); // hover tooltip
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('li[data-cp="5"] button')).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".maplibregl-popup").last()).toContainText(`Route C · mile ${cp.mile.toFixed(0)}`);
  });

  test("clicking a route line on the map selects it", async ({ page }) => {
    const plan = await planTrip(page);
    // checkpoints lie on the road at known miles (A itself shows none: only the selected route does)
    const coords = plan.routes.find((r) => r.id === "A")!.checkpoints.map((c) => [c.lon, c.lat] as const);
    await mapIdle(page);
    // pick a point on route A that is bare map: not under the legend, a marker or the forecast panel
    let target: { x: number; y: number } | null = null;
    for (const frac of [0.3, 0.25, 0.2, 0.45, 0.5, 0.15]) {
      const c = coords[Math.floor(coords.length * frac)]!;
      const p = await screenPoint(page, c[0], c[1]);
      const onCanvas = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("maplibregl-canvas") ?? false,
        p,
      );
      if (onCanvas) {
        target = p;
        break;
      }
    }
    expect(target, "a clear spot on route A").not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
    await expect(page.getByRole("heading", { name: "Route A checkpoints" })).toBeVisible();
  });

  test("legend collapses and the checkpoints switch hides them", async ({ page }) => {
    await planTrip(page);
    const toggle = page.getByRole("button", { name: "Legend" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("No forecast", { exact: true })).toBeHidden();
    await toggle.click();
    await expect(page.getByText("No forecast", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Checkpoints" }).uncheck();
    expect(await sourceValues(page, "checkpoints", "fid")).toHaveLength(0);
    await page.getByRole("checkbox", { name: "Checkpoints" }).check();
    expect((await sourceValues(page, "checkpoints", "fid")).length).toBeGreaterThan(0);
  });

  test("zoom buttons change the map zoom", async ({ page }) => {
    await planTrip(page);
    await mapIdle(page);
    const zoom = () => page.evaluate(() => window.__routecastMap.getZoom() as number);
    const before = await zoom();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(zoom).toBeGreaterThan(before + 0.5);
    await page.getByRole("button", { name: "Zoom out" }).click();
    await expect.poll(zoom).toBeLessThan(before + 0.5);
  });

  test("a what-if scenario is applied and labelled everywhere", async ({ page }) => {
    await page.getByLabel(/load weight/i).fill("38000");
    await page.getByText("What-if weather").click();
    await page.getByLabel(/extra wind/i).fill("20");
    const plan = await planTrip(page);
    expect(plan.request.scenario).toMatchObject({ wind_add_mph: 20 });
    await expect(page.getByText("What-if: +20 mph wind")).toBeVisible();
    await expect(page.getByText(/What-if scenario: forecasts adjusted by \+20 mph wind/)).toBeVisible();
    // 12 mph calm air becomes 32 mph (Moderate) and the 40 mph storm becomes 60 mph (No Travel).
    await expect(page.getByRole("row", { name: /no travel mi/i })).toHaveAttribute("aria-current", "true");
    await expect(page.getByText(/at least one route crosses no travel/i)).toBeVisible();
  });
});

test("rules dialog opens and closes three ways", async ({ page }) => {
  await openApp(page);
  const dialog = page.getByRole("dialog", { name: /how risk is scored/i });
  const open = () => page.getByRole("button", { name: /risk rules/i }).click();

  await open();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "25–34 mph" })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "> 1.00 in/hr" })).toBeVisible();
  await expect(dialog.getByText("Wind 45–54 mph and load > 30,000 lb → No Travel")).toBeVisible();
  await expect(dialog.getByText(/fewest no travel miles/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  await open();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await open();
  await page.mouse.click(5, 5); // backdrop
  await expect(dialog).toBeHidden();
});
