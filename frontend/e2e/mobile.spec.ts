import { expect, openApp, planTrip, test } from "./helpers";

test("phone layout: map first, slider below it, no sideways scrolling", async ({ page }) => {
  await openApp(page);
  await planTrip(page);
  const map = page.getByRole("region", { name: "Route map" });
  const slider = page.locator('section[aria-label="Forecast time"]');
  const mapBox = (await map.boundingBox())!;
  const sliderBox = (await slider.boundingBox())!;
  expect(sliderBox.y).toBeGreaterThanOrEqual(mapBox.y + mapBox.height - 1); // not covering the map
  expect(mapBox.height).toBeGreaterThan(300);
  await expect(page.getByRole("button", { name: "Legend" })).toBeHidden();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  const cards = page.getByRole("list", { name: /route options/i });
  await cards.scrollIntoViewIfNeeded();
  await cards.getByRole("button", { name: /route a/i }).tap();
  await expect(page.getByRole("heading", { name: "Route A checkpoints" })).toBeVisible();

  await page.getByRole("button", { name: /risk rules/i }).tap();
  const dialog = page.getByRole("dialog");
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
