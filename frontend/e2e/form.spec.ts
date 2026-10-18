import { expect, openApp, planTrip, test } from "./helpers";

test.describe("trip form", () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test("example trips fill both places and swap reverses them", async ({ page }) => {
    const origin = page.getByRole("combobox", { name: "Origin" });
    const destination = page.getByRole("combobox", { name: "Destination" });
    await expect(origin).toHaveValue("Dallas, Texas, US");
    for (const [name, o, d] of [
      ["Salt Lake City → Omaha", "Salt Lake City, Utah, US", "Omaha, Nebraska, US"],
      ["Seattle → Missoula", "Seattle, Washington, US", "Missoula, Montana, US"],
      ["Atlanta → Chicago", "Atlanta, Georgia, US", "Chicago, Illinois, US"],
      ["Dallas → Denver", "Dallas, Texas, US", "Denver, Colorado, US"],
    ]) {
      await page.getByRole("button", { name: name! }).click();
      await expect(origin).toHaveValue(o!);
      await expect(destination).toHaveValue(d!);
    }
    await page.getByRole("button", { name: /swap origin and destination/i }).click();
    await expect(origin).toHaveValue("Denver, Colorado, US");
    await expect(destination).toHaveValue("Dallas, Texas, US");
  });

  test("clear buttons empty a place and validation stops the request", async ({ page }) => {
    let requests = 0;
    page.on("request", (r) => r.url().endsWith("/api/plan") && requests++);
    await page.getByRole("button", { name: "Clear origin" }).click();
    await expect(page.getByRole("combobox", { name: "Origin" })).toHaveValue("");
    await expect(page.getByRole("combobox", { name: "Origin" })).toBeFocused();
    await page.getByRole("button", { name: "Clear destination" }).click();
    await page.getByRole("button", { name: /plan routes/i }).click();
    await expect(page.getByText("Choose where the truck starts.")).toBeVisible();
    await expect(page.getByText("Choose where the truck is going.")).toBeVisible();
    expect(requests).toBe(0);
  });

  test("autocomplete works with the keyboard and the mouse", async ({ page }) => {
    const destination = page.getByRole("combobox", { name: "Destination" });
    await page.getByRole("button", { name: "Clear destination" }).click();
    await destination.fill("Den");
    const list = page.getByRole("listbox", { name: /destination suggestions/i });
    await expect(list.getByRole("option")).toHaveText([/Denton, Texas, US/, /Denver, Colorado, US/]);
    await destination.press("ArrowDown");
    await destination.press("ArrowDown");
    await expect(list.getByRole("option", { name: /Denver/ })).toHaveAttribute("aria-selected", "true");
    await destination.press("Enter");
    await expect(destination).toHaveValue("Denver, Colorado, US");
    await expect(list).toBeHidden();

    await page.getByRole("button", { name: "Clear destination" }).click();
    await destination.fill("Den");
    await list.getByRole("option", { name: /Denton/ }).click();
    await expect(destination).toHaveValue("Denton, Texas, US");

    await page.getByRole("button", { name: "Clear destination" }).click();
    await destination.fill("Den");
    await expect(list).toBeVisible();
    await destination.press("Escape");
    await expect(list).toBeHidden();
  });

  test("unknown places say so, and typed coordinates are accepted", async ({ page }) => {
    const destination = page.getByRole("combobox", { name: "Destination" });
    await page.getByRole("button", { name: "Clear destination" }).click();
    await destination.fill("Qqqzz");
    await expect(page.getByText("No places found. Try a city and state.")).toBeVisible();
    await destination.fill("35.2, -101.8");
    await page.getByRole("option", { name: /35\.20000, -101\.80000/ }).click();
    await expect(destination).toHaveValue("35.20000, -101.80000");
  });

  test("departure quick picks and limits", async ({ page }) => {
    const departure = page.getByLabel("Departure");
    await page.getByRole("button", { name: "Now", exact: true }).click();
    const now = new Date(await departure.inputValue()).getTime();
    await page.getByRole("button", { name: "+6 h" }).click();
    const later = new Date(await departure.inputValue()).getTime();
    expect(later - now).toBe(6 * 3600_000);
    await page.getByRole("button", { name: "Tomorrow 6 AM" }).click();
    await expect(departure).toHaveValue(/T06:00$/);

    await departure.fill("2020-01-01T10:00");
    await page.getByRole("button", { name: /plan routes/i }).click();
    await expect(page.getByText("Departure can't be in the past.")).toBeVisible();
    const tooFar = new Date(Date.now() + 10 * 86400_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    await departure.fill(
      `${tooFar.getFullYear()}-${pad(tooFar.getMonth() + 1)}-${pad(tooFar.getDate())}T${pad(tooFar.getHours())}:00`,
    );
    await expect(page.getByText(/within the next 7 days/)).toBeVisible();
  });

  test("load presets and bounds", async ({ page }) => {
    const load = page.getByLabel(/load weight/i);
    for (const [label, value] of [
      ["10k", "10000"],
      ["25k", "25000"],
      ["35k", "35000"],
      ["45k", "45000"],
    ]) {
      await page.getByRole("button", { name: label!, exact: true }).click();
      await expect(load).toHaveValue(value!);
    }
    await load.fill("99999");
    await page.getByRole("button", { name: /plan routes/i }).click(); // invalid, so nothing is sent
    await expect(page.getByText("Load must be between 0 and 80,000 lb.")).toBeVisible();
    await load.fill("-5");
    await expect(page.getByText("Load must be between 0 and 80,000 lb.")).toBeVisible();
    await load.fill("");
    await expect(page.getByText("Enter the load weight in pounds.")).toBeVisible();
  });

  test("interval radios and the hours-of-service switch", async ({ page }) => {
    for (const mi of [10, 50, 25]) {
      await page.getByRole("radio", { name: `${mi} mi` }).click();
      await expect(page.getByRole("radio", { name: `${mi} mi` })).toHaveAttribute("aria-checked", "true");
      await expect(page.getByRole("radio", { checked: true, name: /mi$/ })).toHaveCount(1);
    }
    const hos = page.getByRole("checkbox", { name: /driver hours-of-service/i });
    await expect(hos).toBeChecked();
    await page.getByText("Driver hours-of-service").click();
    await expect(hos).not.toBeChecked();
  });

  test("what-if controls show, label and reset the scenario", async ({ page }) => {
    await page.getByText("What-if weather").click();
    await page.getByLabel(/extra wind/i).fill("15");
    await expect(page.getByText("+15 mph")).toBeVisible();
    await page.getByLabel(/precipitation multiplier/i).fill("2.5");
    await expect(page.getByText("×2.5")).toBeVisible();
    await expect(page.getByText("simulated", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /reset to the real forecast/i }).click();
    await expect(page.getByText("simulated", { exact: true })).toBeHidden();
    await expect(page.getByText("+0 mph")).toBeVisible();
  });

  test("submitting shows progress, then the results", async ({ page }) => {
    await page.route("**/api/plan", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.getByRole("button", { name: /plan routes/i }).click();
    await expect(page.getByRole("button", { name: /planning routes/i })).toBeDisabled();
    await expect(page.getByRole("status", { name: "Planning progress" })).toContainText(/routes|truck|forecasts|risk/i);
    await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Planning progress" })).toBeHidden();
  });

  test("Edit reopens the trip as entered and re-plans", async ({ page }) => {
    await planTrip(page, { load: 38000 });
    await expect(page.getByRole("form", { name: /trip details/i })).toBeHidden();
    await page.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByLabel(/load weight/i)).toHaveValue("38000");
    await planTrip(page, { load: 45000 });
    await expect(page.getByText("45,000 lb")).toBeVisible();
    await expect(page.getByRole("row", { name: /severe mi/i })).toHaveAttribute("aria-current", "true");
  });
});
