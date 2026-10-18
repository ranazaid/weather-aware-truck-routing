import { expect, openApp, planTrip, test } from "./helpers";

test.describe("errors and edge cases", () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test("no road route: a clear message and no pointless retry", async ({ page }) => {
    const destination = page.getByRole("combobox", { name: "Destination" });
    await page.getByRole("button", { name: "Clear destination" }).click();
    await destination.fill("39.7, 175.5"); // the fake router has no roads east of 170 E
    await page.getByRole("option", { name: /39\.70000, 175\.50000/ }).click();
    await page.getByRole("button", { name: /plan routes/i }).click();
    await expect(page.getByRole("alert")).toHaveText("No drivable road route connects these places.");
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(page.getByRole("form", { name: /trip details/i })).toBeVisible();
  });

  test("network failure offers a retry that recovers", async ({ page }) => {
    await page.route("**/api/plan", (route) => route.abort("internetdisconnected"));
    await page.getByRole("button", { name: /plan routes/i }).click();
    await expect(page.getByRole("alert")).toContainText("Can't reach the server");
    await page.unroute("**/api/plan");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a provider outage is retryable", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/plan", async (route) => {
      if (calls++ === 0) {
        await route.fulfill({
          status: 502,
          json: {
            error: { code: "provider_error", message: "OSRM routing is unreachable right now. Please try again." },
          },
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: /plan routes/i }).click();
    await expect(page.getByRole("alert")).toContainText("OSRM routing is unreachable right now.");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
  });

  test("server validation errors land on the field and clear when it is edited", async ({ page }) => {
    await page.route("**/api/plan", (route) =>
      route.fulfill({
        status: 400,
        json: {
          error: {
            code: "invalid",
            message: "Ensure this value is less than or equal to 80000.",
            fields: { load_lb: ["Ensure this value is less than or equal to 80000."] },
          },
        },
      }),
    );
    await page.getByRole("button", { name: /plan routes/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    const fieldError = page.locator("#load-help + p");
    await expect(fieldError).toHaveText("Ensure this value is less than or equal to 80000.");
    await page.getByLabel(/load weight/i).fill("30000");
    await expect(fieldError).toHaveCount(0);
  });

  test("an expired plan explains how to reload the heatmap", async ({ page }) => {
    await page.route("**/heatmap", (route) =>
      route.fulfill({
        status: 404,
        json: { error: { code: "plan_expired", message: "This plan has expired; plan the trip again." } },
      }),
    );
    await page.getByRole("button", { name: /plan routes/i }).click();
    await expect(page.getByText("Plan expired: plan the trip again to reload the heatmap.")).toBeVisible();
    await expect(page.getByText("Recommended", { exact: true })).toBeVisible(); // routes still usable
  });

  test("a place typed but not picked is found by the server", async ({ page }) => {
    const destination = page.getByRole("combobox", { name: "Destination" });
    await page.getByRole("button", { name: "Clear destination" }).click();
    await destination.fill("Amarillo");
    await destination.press("Escape");
    const plan = await planTrip(page);
    expect(plan.request.destination.label).toBe("Amarillo, Texas, US");
    await expect(page.getByText(/Dallas, Texas, US → Amarillo, Texas, US/)).toBeVisible();
  });

  test("an unknown typed place is reported", async ({ page }) => {
    const destination = page.getByRole("combobox", { name: "Destination" });
    await page.getByRole("button", { name: "Clear destination" }).click();
    await destination.fill("Qqqzz");
    await destination.press("Escape");
    await page.getByRole("button", { name: /plan routes/i }).click();
    await expect(page.getByRole("alert")).toHaveText('Could not find "Qqqzz". Try a city and state.');
  });

  test("unknown URLs still load the app", async ({ page }) => {
    await page.goto("/some/deep/link");
    await expect(page.getByRole("button", { name: /plan routes/i })).toBeVisible();
  });
});
