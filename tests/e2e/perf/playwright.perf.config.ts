/**
 * Playwright config for the host open-latency profiler (host-open.perf.ts).
 * Kept apart from playwright.config.ts so the profiler never runs as part of
 * the E2E suite; see the spec's header for usage.
 */
import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.perf\.ts$/,
  workers: 1,
  reporter: "list",
  use: {
    headless: true,
    launchOptions: { args: ["--disable-dev-shm-usage"] },
  },
});
