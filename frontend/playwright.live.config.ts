import { defineConfig, devices } from "@playwright/test";

// Smoke tests against the deployed app with the real basemap, OSRM and Open-Meteo:
//   LIVE_URL=https://routecast-zaid.onrender.com npx playwright test -c playwright.live.config.ts
export default defineConfig({
  testDir: "./e2e-live",
  timeout: 180_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.LIVE_URL ?? "https://routecast-zaid.onrender.com",
    timezoneId: "America/Chicago",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } }, testIgnore: /mobile/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile/ },
  ],
});
