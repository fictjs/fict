import { defineConfig, devices } from '@playwright/test'

const soakMs = Math.min(
  10 * 60_000,
  Math.max(1_000, Number.parseInt(process.env.FICT_REAL_APP_SOAK_MS ?? '10000', 10) || 10_000),
)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: Math.max(30_000, soakMs + 30_000),
  expect: { timeout: 5_000 },
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-real-apps',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm preview --host 127.0.0.1 --port 43173 --strictPort',
      url: 'http://127.0.0.1:43173',
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: 'PORT=43174 NODE_ENV=production pnpm -C ../ssr-basic preview',
      url: 'http://127.0.0.1:43174',
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: 'PORT=43175 NODE_ENV=production pnpm -C ../ssr-streaming preview',
      url: 'http://127.0.0.1:43175',
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
  ],
})
