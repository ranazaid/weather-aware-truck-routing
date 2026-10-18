import { expect, mapIdle, openApp, planTrip, sliderHour, sliderLabel, test } from "./helpers";

const slider = (page: import("@playwright/test").Page) => page.getByRole("slider", { name: /forecast hour/i });

test.describe("forecast slider and heatmap", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await planTrip(page);
  });

  test("moving the slider repaints the heatmap and moves the trucks", async ({ page }) => {
    await mapIdle(page);
    const storm = await page.evaluate(() => {
      const map = window.__routecastMap;
      const points = map.querySourceFeatures("heat");
      // the cell nearest the storm centre (100.9 W, 36.3 N)
      let best = points[0];
      let d = Infinity;
      for (const f of points) {
        const [x, y] = f.geometry.coordinates;
        const dd = (x + 100.9) ** 2 + (y - 36.3) ** 2;
        if (dd < d) [d, best] = [dd, f];
      }
      return best.properties.i as number;
    });
    const state = () => page.evaluate((i) => window.__routecastMap.getFeatureState({ source: "heat", id: i }), storm);
    const truck = page.locator(".truck", { hasText: "C" });
    const before = await truck.boundingBox();
    expect((await state()).v).toBeGreaterThanOrEqual(2); // High during the storm

    await slider(page).fill("40"); // the storm ends at T+30
    await expect(sliderLabel(page)).toContainText("T+40 h");
    await expect.poll(async () => (await state()).v).toBeLessThan(1);
    await expect(page.getByText("Worst risk in the corridor at this hour:")).toContainText("Low");
    const after = await truck.boundingBox();
    expect(Math.hypot(after!.x - before!.x, after!.y - before!.y)).toBeGreaterThan(50);
  });

  test("play, pause, step, reset and speed", async ({ page }) => {
    await page.getByRole("combobox", { name: "Playback speed" }).selectOption("8");
    await page.getByRole("button", { name: "Play forecast" }).click();
    await expect.poll(() => sliderHour(page)).toBeGreaterThanOrEqual(3);
    await page.getByRole("button", { name: "Pause forecast playback" }).click();
    const paused = await sliderHour(page);
    await page.waitForTimeout(600);
    expect(await sliderHour(page)).toBe(paused);

    await slider(page).fill("10");
    await page.getByRole("button", { name: "Forward one hour" }).click();
    await expect(sliderLabel(page)).toContainText("T+11 h");
    await page.getByRole("button", { name: "Back one hour" }).click();
    await page.getByRole("button", { name: "Back one hour" }).click();
    await expect(sliderLabel(page)).toContainText("T+9 h");
    await page.getByRole("button", { name: "Back to departure" }).click();
    await expect(sliderLabel(page)).toContainText("T+0 h");

    await slider(page).fill("48");
    await page.getByRole("button", { name: "Play forecast" }).click(); // at the end, play restarts from 0
    await expect.poll(() => sliderHour(page)).toBeLessThan(48);
  });

  test("playback stops by itself at T+48", async ({ page }) => {
    await page.getByRole("combobox", { name: "Playback speed" }).selectOption("8");
    await slider(page).fill("45");
    await page.getByRole("button", { name: "Play forecast" }).click();
    await expect(page.getByRole("button", { name: "Play forecast" })).toBeVisible({ timeout: 10_000 });
    await expect(sliderLabel(page)).toContainText("T+48 h");
  });

  test("metric switch, heatmap toggle and legend thresholds", async ({ page }) => {
    const color = () =>
      page.evaluate(() => JSON.stringify(window.__routecastMap.getPaintProperty("heat", "circle-color")));
    const risk = await color();
    await page.getByRole("radio", { name: "Wind" }).click();
    await expect.poll(color).not.toBe(risk);
    expect(await color()).toContain(",55,");
    await expect(page.getByText("25–34", { exact: true })).toBeVisible();
    await expect(page.getByText("Worst wind in the corridor at this hour:")).toContainText("40 mph");

    await page.getByRole("radio", { name: "Rain" }).click();
    await expect(page.getByText("0.10–0.25", { exact: true })).toBeVisible();
    await expect(page.getByText("Worst rain in the corridor at this hour:")).toContainText("0.30 in/hr");
    await page.getByRole("radio", { name: "Snow" }).click();
    await expect(page.getByText("0.5–1.0", { exact: true })).toBeVisible();

    const visibility = () => page.evaluate(() => window.__routecastMap.getLayoutProperty("heat", "visibility"));
    await page.getByRole("checkbox", { name: "Heatmap" }).uncheck();
    await expect.poll(visibility).toBe("none");
    await page.getByRole("radio", { name: "Risk" }).click(); // choosing a layer turns the heatmap back on
    await expect(page.getByRole("checkbox", { name: "Heatmap" })).toBeChecked();
    await expect.poll(visibility).toBe("visible");
  });

  test("the hourly strip jumps to the clicked hour", async ({ page }) => {
    const strip = page.locator('section[aria-label="Forecast time"] [title^="Worst"]');
    const box = (await strip.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
    await expect(sliderLabel(page)).toContainText("T+36 h");
  });

  test("keyboard: Space plays and pauses, arrows step an hour", async ({ page }) => {
    await page.getByRole("heading", { name: "RouteCast" }).click(); // focus outside any control
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(sliderLabel(page)).toContainText("T+2 h");
    await page.keyboard.press("ArrowLeft");
    await expect(sliderLabel(page)).toContainText("T+1 h");
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Pause forecast playback" })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Play forecast" })).toBeVisible();
  });

  test("trucks show as parked during the 10-hour reset and arrived at the end", async ({ page }) => {
    await slider(page).fill("15"); // the reset runs from about T+11.5 to T+21.5
    await expect(page.locator(".truck", { hasText: "A" })).toHaveClass(/truck-parked/);
    await slider(page).fill("48");
    await expect(page.locator(".truck.truck-arrived")).toHaveCount(3);
  });
});
