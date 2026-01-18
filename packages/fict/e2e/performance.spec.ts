import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  page.on('console', msg => console.log(`PAGE LOG: ${msg.text()}`))
  page.on('pageerror', err => console.log(`PAGE ERROR: ${err.message}`))
  await page.goto('/')
})

// ============================================================================
// Performance Regression Tests
// ============================================================================
test.describe('Performance Regression Tests', () => {
  test.describe('Reactivity Performance', () => {
    test('rapid state updates complete without delay', async ({ page }) => {
      const startTime = Date.now()

      // Rapid increment
      for (let i = 0; i < 10; i++) {
        await page.click('#increment')
      }

      await expect(page.locator('#count')).toHaveText('10')
      await expect(page.locator('#doubled')).toHaveText('20')

      const duration = Date.now() - startTime
      // Should complete in reasonable time (less than 2 seconds for 10 clicks)
      expect(duration).toBeLessThan(2000)
    })

    test('derived values update synchronously with state', async ({ page }) => {
      await page.click('#increment')

      // Both should update in the same render cycle
      const count = await page.locator('#count').textContent()
      const doubled = await page.locator('#doubled').textContent()

      expect(count).toBe('1')
      expect(doubled).toBe('2')
    })

    test('multiple independent state updates batch correctly', async ({ page }) => {
      // Toggle show and increment should not cause multiple renders
      await page.click('#toggle-show')
      await page.click('#increment')

      await expect(page.locator('#count')).toHaveText('1')
      await expect(page.locator('#shown-element')).not.toBeVisible()
    })
  })

  test.describe('List Rendering Performance', () => {
    test('add 100 items without noticeable delay', async ({ page }) => {
      await page.fill('#batch-size', '100')

      const startTime = Date.now()
      await page.click('#perf-add')
      await expect(page.locator('.perf-item')).toHaveCount(100)
      const duration = Date.now() - startTime

      // Should render 100 items in less than 1 second
      expect(duration).toBeLessThan(1000)
    })

    test('keyed list maintains identity during reorder', async ({ page }) => {
      // Add items
      await page.click('#perf-add')
      await expect(page.locator('.perf-item')).toHaveCount(10)

      // Get first item's data attribute
      const firstValue = await page.locator('.perf-item').first().getAttribute('data-value')

      // Reverse
      await page.click('#perf-reverse')

      // First item's value should now be at the end
      const lastValue = await page.locator('.perf-item').last().getAttribute('data-value')
      expect(firstValue).toBe(lastValue)
    })

    test('list removal does not leak memory', async ({ page }) => {
      // Add many items
      await page.fill('#batch-size', '50')
      await page.click('#perf-add')
      await expect(page.locator('.perf-item')).toHaveCount(50)

      // Clear
      await page.click('#perf-clear')
      await expect(page.locator('.perf-item')).toHaveCount(0)

      // Add again - should work without issues
      await page.click('#perf-add')
      await expect(page.locator('.perf-item')).toHaveCount(50)
    })

    test('partial list updates are efficient', async ({ page }) => {
      await page.fill('#batch-size', '20')
      await page.click('#perf-add')

      // Remove half should be fast
      const startTime = Date.now()
      await page.click('#perf-remove-half')
      await expect(page.locator('.perf-item')).toHaveCount(10)
      const duration = Date.now() - startTime

      expect(duration).toBeLessThan(500)
    })
  })

  test.describe('Conditional Rendering Performance', () => {
    test('toggle visibility rapidly without errors', async ({ page }) => {
      // Toggle 11 times (odd number) to end up in opposite state from start
      for (let i = 0; i < 11; i++) {
        await page.click('#toggle-show')
      }

      // Should end up hidden after 11 toggles (started visible, odd toggles = hidden)
      await expect(page.locator('#shown-element')).not.toBeVisible()
    })

    test('mode switch updates content correctly', async ({ page }) => {
      await page.click('#set-mode-b')
      await expect(page.locator('#mode-result')).toContainText('Mode B active')

      await page.click('#set-mode-c')
      await expect(page.locator('#mode-result')).toContainText('Mode C active')

      await page.click('#set-mode-a')
      await expect(page.locator('#mode-result')).toContainText('Mode A active')
    })

    test('conditional branches switch cleanly', async ({ page }) => {
      // Ternary branch switch
      await expect(page.locator('#ternary-result')).toContainText('Show is true')
      await page.click('#toggle-show')
      await expect(page.locator('#ternary-result')).toContainText('Show is false')
      await page.click('#toggle-show')
      await expect(page.locator('#ternary-result')).toContainText('Show is true')
    })
  })

  test.describe('Store Performance', () => {
    test('nested store updates are efficient', async ({ page }) => {
      const startTime = Date.now()

      // Multiple nested updates
      await page.click('#update-name')
      await page.click('#update-city')
      await page.click('#add-store-item')

      await expect(page.locator('#store-name')).toContainText('Bob')
      await expect(page.locator('#store-city')).toContainText('Shanghai')
      await expect(page.locator('#store-items')).toContainText('d')

      const duration = Date.now() - startTime
      expect(duration).toBeLessThan(500)
    })

    test('store array push updates length correctly', async ({ page }) => {
      const itemsBefore = await page.locator('#store-items').textContent()
      expect(itemsBefore).toBe('Items: a, b, c')

      await page.click('#add-store-item')

      const itemsAfter = await page.locator('#store-items').textContent()
      expect(itemsAfter).toBe('Items: a, b, c, d')
    })
  })

  test.describe('Form Input Performance', () => {
    test('text input updates in real-time', async ({ page }) => {
      const input = page.locator('#text-input')
      const preview = page.locator('#text-preview')

      // Type character by character
      await input.type('Hello', { delay: 50 })

      await expect(preview).toContainText('Preview: Hello')
    })

    test('form state maintains consistency', async ({ page }) => {
      await page.fill('#text-input', 'Test Value')
      await page.check('#checkbox-input')
      await page.selectOption('#select-input', 'option2')

      await expect(page.locator('#text-preview')).toContainText('Preview: Test Value')
      await expect(page.locator('#checkbox-status')).toHaveText('Checked')
      await expect(page.locator('#select-preview')).toContainText('Selected: option2')
    })
  })

  test.describe('Component Props Performance', () => {
    test('prop changes propagate immediately', async ({ page }) => {
      await page.fill('#name-input', 'Updated')
      await expect(page.locator('#child-name')).toContainText('Hello, Updated!')
    })

    test('callback props work correctly', async ({ page }) => {
      await page.click('#child-increment')
      await expect(page.locator('#child-count')).toContainText('Count from parent: 1')

      await page.click('#child-increment')
      await expect(page.locator('#child-count')).toContainText('Count from parent: 2')
    })
  })

  test.describe('Lifecycle Performance', () => {
    test('mount/unmount cycle is clean', async ({ page }) => {
      await expect(page.locator('.lifecycle-child')).toHaveCount(2)

      // Add and remove multiple times
      await page.click('#add-lifecycle-child')
      await expect(page.locator('.lifecycle-child')).toHaveCount(3)

      await page.click('#remove-lifecycle-child')
      await expect(page.locator('.lifecycle-child')).toHaveCount(2)

      await page.click('#add-lifecycle-child')
      await expect(page.locator('.lifecycle-child')).toHaveCount(3)
    })

    test('lifecycle log captures mount events', async ({ page }) => {
      const log = page.locator('#lifecycle-log')
      await expect(log).toContainText('Mounted: 1')
      await expect(log).toContainText('Mounted: 2')

      await page.click('#add-lifecycle-child')
      await expect(log).toContainText('Mounted: 3')
    })
  })

  test.describe('Context Performance', () => {
    test('context updates propagate to consumers', async ({ page }) => {
      await expect(page.locator('#themed-button')).toContainText('Theme: light')

      await page.click('#toggle-theme')
      await expect(page.locator('#themed-button')).toContainText('Theme: dark')

      await page.click('#toggle-theme')
      await expect(page.locator('#themed-button')).toContainText('Theme: light')
    })
  })

  test.describe('Suspense Performance', () => {
    test('lazy component shows loading then content', async ({ page }) => {
      await page.click('#load-lazy')

      // Should show loading first
      await expect(page.locator('#lazy-loading')).toBeVisible()

      // Then show content
      await expect(page.locator('#lazy-content')).toBeVisible({ timeout: 5000 })
      await expect(page.locator('#lazy-loading')).not.toBeVisible()
    })

    test('resource data loads correctly', async ({ page }) => {
      await page.click('#load-resource')

      await expect(page.locator('#user-name')).toContainText('Name: User 1', { timeout: 5000 })
      await expect(page.locator('#user-email')).toContainText('Email: user1@example.com')
    })

    test('resource switching works', async ({ page }) => {
      await page.click('#load-resource')
      await expect(page.locator('#user-name')).toContainText('Name: User 1', { timeout: 5000 })

      await page.click('#change-user')
      await expect(page.locator('#user-name')).toContainText('Name: User 2', { timeout: 5000 })
    })
  })

  test.describe('Style Binding Performance', () => {
    test('class toggle is immediate', async ({ page }) => {
      const target = page.locator('#class-target')

      await expect(target).not.toHaveClass(/active/)
      await page.click('#toggle-active')
      await expect(target).toHaveClass(/active/)
      await page.click('#toggle-active')
      await expect(target).not.toHaveClass(/active/)
    })

    test('inline style updates immediately', async ({ page }) => {
      const target = page.locator('#style-target')

      await page.fill('#color-input', 'green')
      await expect(target).toHaveCSS('color', 'rgb(0, 128, 0)')
    })
  })

  test.describe('Error Boundary Performance', () => {
    test('error boundary catches and recovers', async ({ page }) => {
      await expect(page.locator('#no-error')).toBeVisible()

      await page.click('#trigger-error')
      await expect(page.locator('#error-fallback')).toBeVisible()
      await expect(page.locator('#error-fallback')).toContainText('Intentional error')
    })
  })

  test.describe('Memory Stress Tests', () => {
    test('repeated add/clear cycles do not degrade', async ({ page }) => {
      for (let i = 0; i < 5; i++) {
        await page.fill('#batch-size', '50')
        await page.click('#perf-add')
        await expect(page.locator('.perf-item')).toHaveCount(50 * (i + 1))
      }

      await page.click('#perf-clear')
      await expect(page.locator('.perf-item')).toHaveCount(0)

      // Should still work after clearing
      await page.fill('#batch-size', '10')
      await page.click('#perf-add')
      await expect(page.locator('.perf-item')).toHaveCount(10)
    })

    test('complex wizard flow remains responsive', async ({ page }) => {
      // Multiple complete flows
      for (let i = 0; i < 3; i++) {
        await page.fill('#wizard-name', `User ${i}`)
        await page.click('#wizard-next')
        await page.fill('#wizard-email', `user${i}@test.com`)
        await page.click('#wizard-next')
        await page.check('#wizard-confirm')
        await page.click('#wizard-submit')

        await expect(page.locator('#submission-result')).toBeVisible()
        await page.click('#reset-form')
        await expect(page.locator('#current-step')).toContainText('Step 1')
      }
    })
  })
})
