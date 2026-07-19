import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import { realAppOrigins, realAppPorts } from './server-origins'

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
  reporter: process.env.GITHUB_ACTIONS
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : 'list',
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
      command: `pnpm preview --host 127.0.0.1 --port ${realAppPorts.operations} --strictPort`,
      url: realAppOrigins.operations,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    },
    {
      command: 'node server.js',
      cwd: fileURLToPath(new URL('../ssr-basic', import.meta.url)),
      env: { NODE_ENV: 'production', PORT: String(realAppPorts.resumableSsr) },
      url: realAppOrigins.resumableSsr,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    },
    {
      command: 'node server.js',
      cwd: fileURLToPath(new URL('../ssr-streaming', import.meta.url)),
      env: { NODE_ENV: 'production', PORT: String(realAppPorts.streamingSsr) },
      url: realAppOrigins.streamingSsr,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    },
  ],
})
