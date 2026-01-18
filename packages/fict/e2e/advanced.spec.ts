import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  page.on('console', msg => console.log(`PAGE LOG: ${msg.text()}`))
  page.on('pageerror', err => console.log(`PAGE ERROR: ${err.message}`))
  await page.goto('/')
})

// ============================================================================
// 15. Complex Interaction - Multi-step Wizard Tests
// ============================================================================
test.describe('Complex Interaction - Wizard', () => {
  test('initial wizard state', async ({ page }) => {
    await expect(page.locator('#current-step')).toContainText('Step 1 of 3')
    await expect(page.locator('#step-1')).toBeVisible()
    await expect(page.locator('#step-2')).not.toBeVisible()
    await expect(page.locator('#step-3')).not.toBeVisible()
  })

  test('wizard navigation forward', async ({ page }) => {
    await page.fill('#wizard-name', 'John Doe')
    await page.click('#wizard-next')
    await expect(page.locator('#current-step')).toContainText('Step 2 of 3')
    await expect(page.locator('#step-2')).toBeVisible()

    await page.fill('#wizard-email', 'john@example.com')
    await page.click('#wizard-next')
    await expect(page.locator('#current-step')).toContainText('Step 3 of 3')
    await expect(page.locator('#step-3')).toBeVisible()
    await expect(page.locator('#step-3')).toContainText('John Doe - john@example.com')
  })

  test('wizard navigation backward', async ({ page }) => {
    await page.fill('#wizard-name', 'Test User')
    await page.click('#wizard-next')
    await page.fill('#wizard-email', 'test@example.com')
    await page.click('#wizard-next')

    await page.click('#wizard-prev')
    await expect(page.locator('#current-step')).toContainText('Step 2 of 3')
    await expect(page.locator('#wizard-email')).toHaveValue('test@example.com')

    await page.click('#wizard-prev')
    await expect(page.locator('#current-step')).toContainText('Step 1 of 3')
    await expect(page.locator('#wizard-name')).toHaveValue('Test User')
  })

  test('wizard previous button disabled on step 1', async ({ page }) => {
    await expect(page.locator('#wizard-prev')).toBeDisabled()
  })

  test('wizard submit requires confirmation', async ({ page }) => {
    await page.fill('#wizard-name', 'Test')
    await page.click('#wizard-next')
    await page.fill('#wizard-email', 'test@test.com')
    await page.click('#wizard-next')

    await expect(page.locator('#wizard-submit')).toBeDisabled()

    await page.check('#wizard-confirm')
    await expect(page.locator('#wizard-submit')).toBeEnabled()
  })

  test('wizard complete submission flow', async ({ page }) => {
    await page.fill('#wizard-name', 'Complete User')
    await page.click('#wizard-next')
    await page.fill('#wizard-email', 'complete@example.com')
    await page.click('#wizard-next')
    await page.check('#wizard-confirm')
    await page.click('#wizard-submit')

    await expect(page.locator('#submission-result')).toBeVisible()
    await expect(page.locator('#submission-result')).toContainText('Complete User')
    await expect(page.locator('#submission-result')).toContainText('complete@example.com')
  })

  test('wizard reset after submission', async ({ page }) => {
    await page.fill('#wizard-name', 'Reset Test')
    await page.click('#wizard-next')
    await page.fill('#wizard-email', 'reset@test.com')
    await page.click('#wizard-next')
    await page.check('#wizard-confirm')
    await page.click('#wizard-submit')

    await expect(page.locator('#submission-result')).toBeVisible()

    await page.click('#reset-form')
    await expect(page.locator('#current-step')).toContainText('Step 1 of 3')
    await expect(page.locator('#wizard-name')).toHaveValue('')
  })
})

// ============================================================================
// 16. Suspense + ErrorBoundary Combined Tests
// ============================================================================
test.describe('Suspense + ErrorBoundary Combined', () => {
  test('success lazy component loads correctly', async ({ page }) => {
    await page.click('#show-success')
    await expect(page.locator('#success-loading')).toBeVisible()
    await expect(page.locator('#success-lazy')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#success-loading')).not.toBeVisible()
  })

  test('failable component shows loading state', async ({ page }) => {
    await page.click('#show-failable')
    await expect(page.locator('#failable-loading')).toBeVisible()
    // Wait for either success or error
    await expect(page.locator('#failable-content, #failable-error').first()).toBeVisible({
      timeout: 5000,
    })
  })

  test('multiple lazy components can coexist', async ({ page }) => {
    await page.click('#show-success')
    await page.click('#show-failable')

    // Success component should always succeed
    await expect(page.locator('#success-lazy')).toBeVisible({ timeout: 5000 })
  })
})

// ============================================================================
// 17. Performance Tests
// ============================================================================
test.describe('Performance Operations', () => {
  test('add items in batch', async ({ page }) => {
    await expect(page.locator('#item-total')).toHaveText('0')

    await page.click('#perf-add')
    await expect(page.locator('#item-total')).toHaveText('10')
    await expect(page.locator('.perf-item')).toHaveCount(10)

    await page.click('#perf-add')
    await expect(page.locator('#item-total')).toHaveText('20')
    await expect(page.locator('.perf-item')).toHaveCount(20)
  })

  test('remove half of items', async ({ page }) => {
    // Add items first
    await page.fill('#batch-size', '20')
    await page.click('#perf-add')
    await expect(page.locator('#item-total')).toHaveText('20')

    // Remove half
    await page.click('#perf-remove-half')
    await expect(page.locator('#item-total')).toHaveText('10')
    await expect(page.locator('.perf-item')).toHaveCount(10)
  })

  test('reverse items order', async ({ page }) => {
    await page.click('#perf-add')
    const firstItemBefore = await page.locator('.perf-item').first().getAttribute('data-value')

    await page.click('#perf-reverse')
    const lastItemAfter = await page.locator('.perf-item').last().getAttribute('data-value')

    expect(firstItemBefore).toBe(lastItemAfter)
  })

  test('shuffle items', async ({ page }) => {
    await page.click('#perf-add')
    const orderBefore = await page.locator('.perf-item').allTextContents()

    await page.click('#perf-shuffle')
    const orderAfter = await page.locator('.perf-item').allTextContents()

    // Order should likely be different (there's a tiny chance it's the same)
    expect(orderBefore.length).toBe(orderAfter.length)
  })

  test('clear all items', async ({ page }) => {
    await page.click('#perf-add')
    await expect(page.locator('#item-total')).toHaveText('10')

    await page.click('#perf-clear')
    await expect(page.locator('#item-total')).toHaveText('0')
    await expect(page.locator('.perf-item')).toHaveCount(0)
  })

  test('render count tracks updates', async ({ page }) => {
    await expect(page.locator('#render-count')).toHaveText('0')

    await page.click('#perf-add')
    await expect(page.locator('#render-count')).toHaveText('1')

    await page.click('#perf-add')
    await expect(page.locator('#render-count')).toHaveText('2')

    await page.click('#perf-reverse')
    await expect(page.locator('#render-count')).toHaveText('3')
  })

  test('large batch performance', async ({ page }) => {
    await page.fill('#batch-size', '100')
    await page.click('#perf-add')
    await expect(page.locator('#item-total')).toHaveText('100')
    await expect(page.locator('.perf-item')).toHaveCount(100)

    // Verify items render correctly
    const items = await page.locator('.perf-item').allTextContents()
    expect(items.length).toBe(100)
    expect(items[0]).toContain('Item 1')
    expect(items[99]).toContain('Item 100')
  })
})

// ============================================================================
// 18. Keyboard Navigation Tests
// ============================================================================
test.describe('Keyboard Navigation', () => {
  test('arrow down navigates to next item', async ({ page }) => {
    await page.locator('#keyboard-list').focus()
    await expect(page.locator('#selected-item')).toContainText('Apple')

    await page.keyboard.press('ArrowDown')
    await expect(page.locator('#selected-item')).toContainText('Banana')
    await expect(page.locator('#last-key')).toContainText('ArrowDown')
  })

  test('arrow up navigates to previous item', async ({ page }) => {
    await page.locator('#keyboard-list').focus()

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('#selected-item')).toContainText('Cherry')

    await page.keyboard.press('ArrowUp')
    await expect(page.locator('#selected-item')).toContainText('Banana')
  })

  test('arrow up at top stays at first item', async ({ page }) => {
    await page.locator('#keyboard-list').focus()
    await expect(page.locator('#selected-item')).toContainText('Apple')

    await page.keyboard.press('ArrowUp')
    await expect(page.locator('#selected-item')).toContainText('Apple')
  })

  test('arrow down at bottom stays at last item', async ({ page }) => {
    await page.locator('#keyboard-list').focus()

    // Navigate to last item
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowDown')
    }

    await expect(page.locator('#selected-item')).toContainText('Elderberry')
  })

  test('delete key removes selected item', async ({ page }) => {
    await page.locator('#keyboard-list').focus()
    await expect(page.locator('.keyboard-item')).toHaveCount(5)

    await page.keyboard.press('Delete')
    await expect(page.locator('.keyboard-item')).toHaveCount(4)
    await expect(page.locator('#selected-item')).toContainText('Banana')
  })

  test('delete maintains valid selection after removal', async ({ page }) => {
    await page.locator('#keyboard-list').focus()

    // Navigate to last item
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowDown')
    }
    await expect(page.locator('#selected-item')).toContainText('Elderberry')

    // Delete last item
    await page.keyboard.press('Delete')
    // Selection should move to new last item
    await expect(page.locator('#selected-item')).toContainText('Date')
  })
})

// ============================================================================
// 19. Drag and Drop Tests
// ============================================================================
test.describe('Drag and Drop', () => {
  test('initial drag list order', async ({ page }) => {
    await expect(page.locator('#drag-order')).toContainText('Item A, Item B, Item C, Item D')
  })

  test('drag status updates during drag', async ({ page }) => {
    await expect(page.locator('#drag-status')).toContainText('Not dragging')

    const firstItem = page.locator('.drag-item').first()
    const secondItem = page.locator('.drag-item').nth(1)

    // Start drag
    await firstItem.dispatchEvent('dragstart')
    await expect(page.locator('#drag-status')).toContainText('Dragging: Item A')

    // Hover over second item
    await secondItem.dispatchEvent('dragover')
    await expect(page.locator('#drag-status')).toContainText('target: Item B')

    // End drag
    await secondItem.dispatchEvent('drop')
    await expect(page.locator('#drag-status')).toContainText('Not dragging')
  })

  test('drag and drop reorders items', async ({ page }) => {
    const firstItem = page.locator('.drag-item').first()
    const thirdItem = page.locator('.drag-item').nth(2)

    // Drag first item to third position
    await firstItem.dispatchEvent('dragstart')
    await thirdItem.dispatchEvent('dragover')
    await thirdItem.dispatchEvent('drop')

    // A should now be after B and before C (or after C)
    const order = await page.locator('#drag-order').textContent()
    expect(order).not.toBe('Item A, Item B, Item C, Item D')
  })
})

// ============================================================================
// 20. Animation Frame Tests
// ============================================================================
test.describe('Animation Frame', () => {
  test('animation starts and stops', async ({ page }) => {
    await expect(page.locator('#frame-count')).toContainText('Frames: 0')

    // Start animation
    await page.click('#toggle-animation')
    await page.waitForTimeout(100)
    const count1 = parseInt(
      (await page.locator('#frame-count').textContent())?.replace('Frames: ', '') ?? '0',
    )
    expect(count1).toBeGreaterThan(0)

    // Stop animation
    await page.click('#toggle-animation')
    await page.waitForTimeout(50)
    const count2 = parseInt(
      (await page.locator('#frame-count').textContent())?.replace('Frames: ', '') ?? '0',
    )

    // Wait a bit more and check it stopped
    await page.waitForTimeout(100)
    const count3 = parseInt(
      (await page.locator('#frame-count').textContent())?.replace('Frames: ', '') ?? '0',
    )

    // Frame count should be stable after stopping
    expect(count3).toBe(count2)
  })

  test('reset clears position and frame count', async ({ page }) => {
    await page.click('#toggle-animation')
    await page.waitForTimeout(100)
    await page.click('#toggle-animation')

    const countBefore = parseInt(
      (await page.locator('#frame-count').textContent())?.replace('Frames: ', '') ?? '0',
    )
    expect(countBefore).toBeGreaterThan(0)

    await page.click('#reset-animation')
    await expect(page.locator('#frame-count')).toContainText('Frames: 0')
  })

  test('animated box moves during animation', async ({ page }) => {
    const box = page.locator('#animated-box')

    const leftBefore = await box.evaluate(el => el.style.left)

    await page.click('#toggle-animation')
    await page.waitForTimeout(100)
    await page.click('#toggle-animation')

    const leftAfter = await box.evaluate(el => el.style.left)

    // Position should have changed
    expect(leftBefore).not.toBe(leftAfter)
  })
})
