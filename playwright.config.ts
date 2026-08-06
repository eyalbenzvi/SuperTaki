import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;
/** Must match `build:e2e`'s `VITE_RELAY_URL`, and `wrangler dev`'s own default. */
const RELAY_PORT = 8787;

/**
 * Environments that pre-install Chromium at a fixed path (containers, CI images)
 * can point Playwright at it instead of downloading a matching revision.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const launchOptions = executablePath ? { executablePath } : {};

/**
 * End-to-end tests run against the production build served by `vite preview`, talking
 * to the *real* room worker under `wrangler dev`.
 *
 * They used to talk to a BroadcastChannel transport instead, because the game lived
 * in one of the tabs and there was no server to run. That made the suite fast and
 * deterministic and meant it never once exercised the path a player actually takes.
 * The room is a worker now, and workerd runs locally, so there is no longer a reason
 * to test a lookalike: what CI drives here is production, minus the domain name.
 *
 * The build must be made with `VITE_RELAY_URL` pointing at that worker — `npm run
 * build:e2e` — because the URL is baked into the bundle *and* into the page's
 * `connect-src`, and a preview built without it has no room to talk to.
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
  webServer: [
    {
      /*
       * The room. `--local` is the default for `wrangler dev`, so this is workerd with
       * a real SQLite-backed Durable Object — the same class that is deployed, running
       * the same code, with no network involved.
       */
      command: `npx wrangler dev --port ${RELAY_PORT}`,
      cwd: 'worker',
      url: `http://127.0.0.1:${RELAY_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Bind explicitly to 127.0.0.1. `vite preview` otherwise listens on
      // `localhost`, which resolves to ::1 on GitHub's runners while Playwright probes
      // 127.0.0.1 — the health check then never succeeds and the run dies with
      // "Timed out waiting from config.webServer".
      command: `npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
