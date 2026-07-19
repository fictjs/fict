import { expect, test, type Page } from '@playwright/test'

import { realAppOrigins } from '../server-origins'

const operationsUrl = realAppOrigins.operations
const resumableSsrUrl = realAppOrigins.resumableSsr
const streamingSsrUrl = realAppOrigins.streamingSsr
const soakMs = Math.min(
  10 * 60_000,
  Math.max(1_000, Number.parseInt(process.env.FICT_REAL_APP_SOAK_MS ?? '10000', 10) || 10_000),
)

function collectPageErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.stack ?? error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  return errors
}

test.describe.configure({ mode: 'serial' })

test('operations suite covers forms, nested routing, resources, and recovery control flow', async ({
  page,
}) => {
  const errors = collectPageErrors(page)
  await page.goto(operationsUrl)
  await expect(page.getByRole('heading', { name: 'Commercial health' })).toBeVisible()

  await page.locator('[data-view="intake"]').click()
  await page.getByLabel('Budget').fill('75000')
  await page.getByRole('button', { name: 'high', exact: true }).click()
  await page.getByRole('button', { name: 'Submit request' }).click()
  await expect(page.getByText('Request queued for executive review.')).toBeVisible()

  await page.locator('[data-view="router"]').click()
  await page.getByRole('link', { name: 'Accounts', exact: true }).click()
  await page.getByRole('link', { name: 'Northwind Supply' }).click()
  await expect(page.getByRole('heading', { name: 'Northwind Supply' })).toBeVisible()

  await page.locator('[data-view="resources"]').click()
  await expect(page.getByTestId('resource-ready')).toBeVisible()
  const firstRevision = await page.getByTestId('resource-revision').textContent()
  await page.getByTestId('resource-refresh').click()
  await expect(page.getByTestId('resource-ready')).toBeVisible()
  await expect(page.getByTestId('resource-revision')).not.toHaveText(firstRevision ?? '')

  await page.locator('[data-view="auth"]').click()
  await page.getByLabel('Access key').fill('fict-v1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'Open workspace' }).click()
  await expect(page.getByText('Privileged operations enabled')).toBeVisible()
  await page.getByRole('button', { name: 'Simulate outage' }).click()
  await expect(page.getByRole('heading', { name: 'Audit stream unavailable' })).toBeVisible()
  await page.getByRole('button', { name: 'Reconnect' }).click()
  await expect(page.getByRole('heading', { name: 'Audit stream' })).toBeVisible()

  expect(errors).toEqual([])
})

test('resumable SSR application serves state and resumes interactions from a production build', async ({
  page,
  request,
}) => {
  const response = await request.get(resumableSsrUrl)
  expect(response.ok()).toBe(true)
  const html = await response.text()
  expect(html).toContain('Release operations console')
  expect(html).toContain('id="__FICT_SNAPSHOT__"')
  expect(html).toContain('US East')

  const errors = collectPageErrors(page)
  await page.goto(resumableSsrUrl)
  await expect(page.getByTestId('capacity-east-value')).toHaveText('65%')
  await page.getByTestId('capacity-east-increment').click()
  await expect(page.getByTestId('capacity-east-value')).toHaveText('70%')

  await page.getByTestId('change-title').fill('Promote identity canary')
  await page.getByTestId('change-risk').selectOption('critical')
  await page.getByTestId('change-submit').click()
  await expect(page.getByTestId('change-result')).toContainText('critical approval lane')

  await page.locator('[data-filter="Paused"]').click()
  await expect(page.getByTestId('deployment-rows').locator('tr')).toHaveCount(1)
  expect(errors).toEqual([])
})

test('streaming SSR application completes concurrent production requests', async ({
  page,
  request,
}) => {
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => request.get(streamingSsrUrl)),
  )
  for (const response of responses) {
    expect(response.ok()).toBe(true)
    const html = await response.text()
    expect(html).toContain('Operations command center')
    expect(html).toContain('$612k')
    expect(html).toContain('data-fict-suspense')
  }

  const errors = collectPageErrors(page)
  await page.goto(streamingSsrUrl)
  await expect(page.getByText('$612k')).toBeVisible()
  await expect(page.getByText('29', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test(`mixed browser and SSR workload remains healthy for ${soakMs}ms`, async ({
  page,
  request,
}) => {
  test.setTimeout(soakMs + 30_000)
  const errors = collectPageErrors(page)
  await page.goto(operationsUrl)

  const deadline = Date.now() + soakMs
  let cycles = 0
  while (Date.now() < deadline) {
    await page.locator(`[data-range="${cycles % 2 === 0 ? 'today' : 'week'}"]`).click()
    await page.locator('[data-view="resources"]').click()
    await expect(page.getByTestId('resource-ready')).toBeVisible()
    await page.locator('[data-view="dashboard"]').click()

    if (cycles % 5 === 0) {
      const [resumableResponse, streamingResponse] = await Promise.all([
        request.get(resumableSsrUrl),
        request.get(streamingSsrUrl),
      ])
      expect(resumableResponse.ok()).toBe(true)
      expect(streamingResponse.ok()).toBe(true)
    }
    cycles += 1
  }

  expect(cycles).toBeGreaterThan(0)
  await expect(page.getByRole('heading', { name: 'Commercial health' })).toBeVisible()
  expect(errors).toEqual([])
  console.log(`Real-application soak completed ${cycles} mixed workload cycles in ${soakMs}ms.`)
})
