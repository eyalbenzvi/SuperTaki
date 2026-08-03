import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Environments that pre-install Chromium at a fixed path (containers, CI images)
 * can point Playwright at it instead of downloading a matching revision.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const launchOptions = executablePath ? { executablePath } : {};

/**
 * End-to-end tests run against the production build served by `vite preview`.
 *
 * Multiplayer scenarios use the BroadcastChannel transport (`?transport=broadcast`)
 * so two pages in the same browser can play a real game without depending on
 * public signalling servers or NAT traversal — see docs/qa-report.md.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
    { name: 'mobile', use: { ...devices['Pixel 5'], launchOptions } },
  ],
  webServer: {
    // Bind explicitly to 127.0.0.1. `vite preview` otherwise listens on
    // `localhost`, which resolves to ::1 on GitHub's runners while Playwright
    // probes 127.0.0.1 — the health check then never succeeds and the run dies
    // with "Timed out waiting from config.webServer".
    command: `npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
