import { test, expect } from '@playwright/test'

test('basic reactivity works', async ({ page }) => {
  page.on('console', msg => console.log(`PAGE LOG: ${msg.text()}`))
  page.on('pageerror', err => console.log(`PAGE ERROR: ${err.message}`))
  await page.goto('/')

  // checking initial state
  await expect(page.locator('h1')).toBeVisible()
  await expect(page.locator('#count')).toHaveText('0')
  await expect(page.locator('#doubled')).toHaveText('0')

  // check reactivity
  await page.click('#increment')
  await expect(page.locator('#count')).toHaveText('1')
  await expect(page.locator('#doubled')).toHaveText('2')

  await page.click('#increment')
  await expect(page.locator('#count')).toHaveText('2')
  await expect(page.locator('#doubled')).toHaveText('4')
})
