import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["ui.spec.ts", "map-ui.spec.ts", "explorer-ui.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: "reports/portfolio/playwright",
  reporter: [["list"], ["json", { outputFile: "reports/portfolio/ui-results.json" }]],
  use: {
    baseURL: process.env.PULSE_TEST_URL ?? "http://127.0.0.1:3100",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
