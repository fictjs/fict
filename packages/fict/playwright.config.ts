import { defineConfig, devices } from '@playwright/test'

const e2eOrigin = 'http://127.0.0.1:43176'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.GITHUB_ACTIONS
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: e2eOrigin,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm vite e2e --host 127.0.0.1 --port 43176 --strictPort',
    url: e2eOrigin,
    reuseExistingServer: false,
  },
})
