import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run the real Django server and the production bundle against offline fake
// providers (backend/planner/tests/fake_server.py), so results are deterministic and need no network.
const PYTHON = process.env.PYTHON ?? "python";
const API = 8010;
const FAKE = 8099;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${API}`,
    timezoneId: "America/Chicago",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec/ },
  ],
  webServer: [
    {
      command: `${PYTHON} -m planner.tests.fake_server --port ${FAKE}`,
      cwd: "../backend",
      url: `http://127.0.0.1:${FAKE}/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `${PYTHON} manage.py runserver 127.0.0.1:${API} --noreload`,
      cwd: "../backend",
      url: `http://127.0.0.1:${API}/api/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        ...(process.env as Record<string, string>),
        OSRM_URL: `http://127.0.0.1:${FAKE}`,
        OSRM_FALLBACK_URL: "", // stay offline
        OPEN_METEO_URL: `http://127.0.0.1:${FAKE}/v1/forecast`,
        PHOTON_URL: `http://127.0.0.1:${FAKE}/api/`,
        NOMINATIM_URL: `http://127.0.0.1:${FAKE}/search`,
        API_RATE_LIMIT: "10000/min",
      },
    },
  ],
});
