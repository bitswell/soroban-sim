import { defineConfig, devices } from '@playwright/test';

// Browser tests run against dist/ (`pnpm build` first): the demo under a
// strict CSP, and the framework examples bundled by build-examples.mjs.
export default defineConfig({
  testDir: './test/browser',
  testMatch: '*.spec.mjs',
  timeout: 60_000,
  globalSetup: './test/browser/build-examples.mjs',
  webServer: {
    command: 'node scripts/serve.mjs 4178',
    url: 'http://127.0.0.1:4178/demo/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: { baseURL: 'http://127.0.0.1:4178', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
