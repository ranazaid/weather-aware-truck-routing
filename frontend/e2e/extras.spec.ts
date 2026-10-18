import { expect, openApp, planTrip, test, waitForMap } from "./helpers";

test.describe("best time to leave and shareable links", () => {
  test("the departure table lists every option and re-plans at a later time", async ({ page }) => {
    await openApp(page);
    const plan = await planTrip(page);
    const panel = page.getByRole("region", { name: "Best time to leave" });
    const rows = panel.getByRole("row");
    await expect(rows).toHaveCount(1 + plan.departure_advice.options.length);
    expect(plan.departure_advice.options.map((o) => o.offset_h)).toEqual([0, 3, 6, 12, 24]);
    await expect(panel.getByRole("rowheader").first()).toContainText("As planned");
    // Route C already avoids the fake storm, so leaving now is safest.
    await expect(panel.getByText("Leaving as planned is already the safest of these times.")).toBeVisible();

    const replan = page.waitForResponse((r) => r.url().endsWith("/api/plan"));
    await panel.getByRole("button", { name: "Plan for 3 hours later" }).click();
    const second = await (await replan).json();
    expect(Date.parse(second.request.departure) - Date.parse(plan.request.departure)).toBe(3 * 3600_000);
    await page.getByRole("button", { name: "Edit" }).click();
    const value = await page.getByLabel("Departure", { exact: true }).inputValue();
    const shown = await page.evaluate((v) => new Date(v).getTime(), value); // parse in the browser's time zone
    expect(Math.abs(shown - Date.parse(second.request.departure))).toBeLessThan(60_000); // the form follows
  });

  test("advice to leave later is shown with a one-click re-plan", async ({ page }) => {
    await openApp(page);
    await page.route("**/api/plan", async (route) => {
      const response = await route.fetch();
      const plan = await response.json();
      if (Date.parse(plan.request.departure) - Date.now() < 2 * 3600_000) {
        plan.departure_advice.best_offset_h = 6;
        plan.departure_advice.text = "Leaving 6 h later is safer: Route C cuts High miles from 50.0 mi to 0.0 mi.";
      }
      await route.fulfill({ response, json: plan });
    });
    await planTrip(page);
    const panel = page.getByRole("region", { name: "Best time to leave" });
    await expect(panel.getByText(/Leaving 6 h later is safer/)).toBeVisible();
    await expect(panel.getByRole("row").nth(3)).toHaveAttribute("aria-current", "true"); // the +6 h row
    const replan = page.waitForResponse((r) => r.url().endsWith("/api/plan"));
    const banner = panel.getByRole("button", { name: /^Plan for (?!\d+ hours later)/ });
    await banner.click();
    expect((await replan).ok()).toBe(true);
  });

  test("a shared link reopens the same trip and plan", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    await openApp(page);
    await page.getByLabel(/load weight/i).fill("45000");
    await page.getByRole("radio", { name: "10 mi" }).click();
    const first = await planTrip(page);
    expect(page.url()).toContain("w=45000");
    expect(page.url()).toContain("i=10");

    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(page.url());

    const other = await context.newPage();
    await other.route(/basemaps\.cartocdn\.com|tiles\.openfreemap\.org|fonts\./, (r) => r.abort());
    const auto = other.waitForResponse((r) => r.url().endsWith("/api/plan"));
    await other.goto(copied);
    await waitForMap(other);
    const second = await (await auto).json();
    expect(second.request.load_lb).toBe(45000);
    expect(second.request.interval_mi).toBe(10);
    expect(second.recommendation.route_id).toBe(first.recommendation.route_id);
    await expect(other.getByText("45,000 lb")).toBeVisible();
    await expect(other.getByRole("row", { name: /severe mi/i })).toHaveAttribute("aria-current", "true");
  });

  test("a shared link whose departure has passed leaves now instead", async ({ page }) => {
    await page.route(/basemaps\.cartocdn\.com|tiles\.openfreemap\.org|fonts\./, (r) => r.abort());
    await page.goto("/?o=32.7767,-96.797,Dallas&d=39.7392,-104.9903,Denver&t=2020-01-01T00:00:00Z&w=20000&i=25&h=1");
    await expect(page.getByText(/departure had already passed/)).toBeVisible();
    await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
  });
});
