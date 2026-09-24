import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests for the agent console.
 *
 * Introduced at the end of M2 rather than in M1 on purpose: a browser test is tied to the
 * screens it clicks through, and the inbox changed shape daily while it was being invented.
 * Now that it has settled, these cover the three flows that would embarrass us if they
 * broke.
 *
 * The suite drives a real API, worker and Postgres, with only the model provider mocked.
 */
export default defineConfig({
  testDir: './e2e',
  // One worker: the tests share a database and a seeded workspace.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-GB',
    /**
     * The embed tests serve a host page from 127.0.0.1 that loads the widget from
     * localhost: two origins, one machine. Chrome's local-network-access check treats that
     * as a page reaching into the loopback address space and blocks the script. In the
     * world the host site and the chat server are both public, so the check never applies;
     * here it would stop the test from exercising anything.
     */
    launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] },
  },
  /**
   * Desktop runs everything not tagged for another project. The others run only what is
   * tagged for them, so the suite is not multiplied by every configuration: `@mobile` for
   * phone-width layouts, `@theme` for dark mode in Thai.
   */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile|@theme/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
    {
      name: 'dark-th',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark', locale: 'th-TH' },
      grep: /@theme/,
    },
  ],
  /**
   * Runs once, after the servers are up, to resolve conversations left open by earlier
   * runs. See `clearInbox` for why the suite cannot simply ignore them any more.
   */
  globalSetup: './e2e/global-setup.ts',

  webServer: [
    {
      command: 'bun run scripts/mock-provider.ts',
      url: 'http://localhost:4010/v1/models',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'bun run apps/api/src/index.ts',
      url: 'http://localhost:3000/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // The tool endpoint these tests define runs on localhost, which the restricted
      // egress client refuses everywhere else by design.
      //
      // This only applies when Playwright starts the process. A developer who already has
      // `bun run dev` up gets that server reused without the flag, and e2e/tools.spec.ts
      // then fails with an egress refusal that reads like a bug in the product. Restart
      // the dev servers with TOOL_EGRESS_ALLOW_PRIVATE=true, or stop them and let
      // Playwright start its own.
      env: { ...process.env, TOOL_EGRESS_ALLOW_PRIVATE: 'true' },
    },
    {
      command: 'bun run apps/worker/src/index.ts',
      // The worker's own health endpoint. Pointing this at the API's URL made Playwright
      // think the same server was declared twice and refuse to start.
      url: 'http://localhost:3001/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...process.env, TOOL_EGRESS_ALLOW_PRIVATE: 'true' },
    },
    {
      command: 'bun run dev:web',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})
