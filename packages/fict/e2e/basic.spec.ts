import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  page.on('console', msg => console.log(`PAGE LOG: ${msg.text()}`))
  page.on('pageerror', err => console.log(`PAGE ERROR: ${err.message}`))
  await page.goto('/')
})

// ============================================================================
// 1. Basic Reactivity Tests
// ============================================================================
test.describe('Basic Reactivity', () => {
  test('initial state renders correctly', async ({ page }) => {
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('#count')).toHaveText('0')
    await expect(page.locator('#doubled')).toHaveText('0')
  })

  test('increment updates count and derived value', async ({ page }) => {
    await page.click('#increment')
    await expect(page.locator('#count')).toHaveText('1')
    await expect(page.locator('#doubled')).toHaveText('2')

    await page.click('#increment')
    await expect(page.locator('#count')).toHaveText('2')
    await expect(page.locator('#doubled')).toHaveText('4')
  })

  test('decrement updates count correctly', async ({ page }) => {
    await page.click('#increment')
    await page.click('#increment')
    await expect(page.locator('#count')).toHaveText('2')

    await page.click('#decrement')
    await expect(page.locator('#count')).toHaveText('1')
    await expect(page.locator('#doubled')).toHaveText('2')
  })
})

// ============================================================================
// 2. Conditional Rendering Tests
// ============================================================================
test.describe('Conditional Rendering', () => {
  test('boolean toggle shows/hides element', async ({ page }) => {
    await expect(page.locator('#shown-element')).toBeVisible()

    await page.click('#toggle-show')
    await expect(page.locator('#shown-element')).not.toBeVisible()

    await page.click('#toggle-show')
    await expect(page.locator('#shown-element')).toBeVisible()
  })

  test('ternary renders correct branch', async ({ page }) => {
    await expect(page.locator('#ternary-result')).toContainText('Show is true')

    await page.click('#toggle-show')
    await expect(page.locator('#ternary-result')).toContainText('Show is false')
  })

  test('multi-branch conditional renders correct content', async ({ page }) => {
    await expect(page.locator('#mode-result')).toContainText('Mode A active')

    await page.click('#set-mode-b')
    await expect(page.locator('#mode-result')).toContainText('Mode B active')
    await expect(page.locator('#mode-result')).not.toContainText('Mode A active')

    await page.click('#set-mode-c')
    await expect(page.locator('#mode-result')).toContainText('Mode C active')
  })
})

// ============================================================================
// 3. List Rendering Tests
// ============================================================================
test.describe('List Rendering', () => {
  test('initial list renders correctly', async ({ page }) => {
    await expect(page.locator('#item-list .list-item')).toHaveCount(3)
    await expect(page.locator('#item-count')).toContainText('Total: 3')
  })

  test('add item updates list', async ({ page }) => {
    await page.click('#add-item')
    await expect(page.locator('#item-list .list-item')).toHaveCount(4)
    await expect(page.locator('#item-count')).toContainText('Total: 4')
  })

  test('remove item updates list', async ({ page }) => {
    await page.locator('.list-item[data-id="2"] .remove-item').click()
    await expect(page.locator('#item-list .list-item')).toHaveCount(2)
    await expect(page.locator('#item-count')).toContainText('Total: 2')
    await expect(page.locator('.list-item[data-id="2"]')).not.toBeVisible()
  })

  test('reverse items changes order', async ({ page }) => {
    const firstItem = page.locator('#item-list .list-item').first()
    await expect(firstItem).toContainText('Item 1')

    await page.click('#reverse-items')
    await expect(firstItem).toContainText('Item 3')
  })
})

// ============================================================================
// 4. Form Input Tests
// ============================================================================
test.describe('Form Input', () => {
  test('text input updates preview', async ({ page }) => {
    await page.fill('#text-input', 'Hello Fict')
    await expect(page.locator('#text-preview')).toContainText('Preview: Hello Fict')
  })

  test('checkbox toggles state', async ({ page }) => {
    await expect(page.locator('#checkbox-status')).toHaveText('Unchecked')

    await page.check('#checkbox-input')
    await expect(page.locator('#checkbox-status')).toHaveText('Checked')

    await page.uncheck('#checkbox-input')
    await expect(page.locator('#checkbox-status')).toHaveText('Unchecked')
  })

  test('select updates preview', async ({ page }) => {
    await expect(page.locator('#select-preview')).toContainText('Selected: option1')

    await page.selectOption('#select-input', 'option2')
    await expect(page.locator('#select-preview')).toContainText('Selected: option2')
  })

  test('form submission captures all values', async ({ page }) => {
    await page.fill('#text-input', 'Test')
    await page.check('#checkbox-input')
    await page.selectOption('#select-input', 'option3')

    await page.click('#submit-form')
    await expect(page.locator('#form-result')).toContainText('Text: Test')
    await expect(page.locator('#form-result')).toContainText('Checked: true')
    await expect(page.locator('#form-result')).toContainText('Selected: option3')
  })
})

// ============================================================================
// 5. Component Props Tests
// ============================================================================
test.describe('Component Props', () => {
  test('child receives initial props', async ({ page }) => {
    await expect(page.locator('#child-name')).toContainText('Hello, World!')
    await expect(page.locator('#child-count')).toContainText('Count from parent: 0')
  })

  test('child updates when parent prop changes', async ({ page }) => {
    await page.fill('#name-input', 'Fict')
    await expect(page.locator('#child-name')).toContainText('Hello, Fict!')
  })

  test('child callback updates parent state', async ({ page }) => {
    await page.click('#child-increment')
    await expect(page.locator('#child-count')).toContainText('Count from parent: 1')

    await page.click('#child-increment')
    await expect(page.locator('#child-count')).toContainText('Count from parent: 2')
  })
})

// ============================================================================
// 6. Store (Deep Reactivity) Tests
// ============================================================================
test.describe('Store (Deep Reactivity)', () => {
  test('initial store values render', async ({ page }) => {
    await expect(page.locator('#store-name')).toContainText('Name: Alice')
    await expect(page.locator('#store-city')).toContainText('City: Beijing')
    await expect(page.locator('#store-items')).toContainText('Items: a, b, c')
  })

  test('nested property update works', async ({ page }) => {
    await page.click('#update-name')
    await expect(page.locator('#store-name')).toContainText('Name: Bob')
  })

  test('deeply nested property update works', async ({ page }) => {
    await page.click('#update-city')
    await expect(page.locator('#store-city')).toContainText('City: Shanghai')
  })

  test('array mutation in store works', async ({ page }) => {
    await page.click('#add-store-item')
    await expect(page.locator('#store-items')).toContainText('Items: a, b, c, d')
  })
})

// ============================================================================
// 7. Context API Tests
// ============================================================================
test.describe('Context API', () => {
  test('initial context value is used', async ({ page }) => {
    await expect(page.locator('#themed-button')).toContainText('Theme: light')
  })

  test('context updates propagate to consumers', async ({ page }) => {
    await page.click('#toggle-theme')
    await expect(page.locator('#themed-button')).toContainText('Theme: dark')

    await page.click('#toggle-theme')
    await expect(page.locator('#themed-button')).toContainText('Theme: light')
  })
})

// ============================================================================
// 8. Error Boundary Tests
// ============================================================================
test.describe('Error Boundary', () => {
  test('renders children when no error', async ({ page }) => {
    await expect(page.locator('#no-error')).toBeVisible({ timeout: 2000 })
  })

  test('shows fallback when error occurs', async ({ page }) => {
    await page.click('#trigger-error')
    await expect(page.locator('#error-fallback')).toBeVisible()
    await expect(page.locator('#error-fallback')).toContainText(
      'Error: Intentional error for testing',
    )
  })
})

// ============================================================================
// 9. Style Binding Tests
// ============================================================================
test.describe('Style Binding', () => {
  test('class binding toggles correctly', async ({ page }) => {
    const target = page.locator('#class-target')
    await expect(target).toHaveClass(/base/)
    await expect(target).not.toHaveClass(/active/)

    await page.click('#toggle-active')
    await expect(target).toHaveClass(/active/)

    await page.click('#toggle-active')
    await expect(target).not.toHaveClass(/active/)
  })

  test('inline style binding updates', async ({ page }) => {
    const target = page.locator('#style-target')
    await expect(target).toHaveCSS('color', 'rgb(255, 0, 0)') // red

    await page.fill('#color-input', 'blue')
    await expect(target).toHaveCSS('color', 'rgb(0, 0, 255)') // blue
  })

  test('numeric style binding works', async ({ page }) => {
    const target = page.locator('#style-target')
    await expect(target).toHaveCSS('font-size', '16px')

    await page.fill('#size-input', '24')
    await expect(target).toHaveCSS('font-size', '24px')
  })
})

// ============================================================================
// 10. Lifecycle Tests
// ============================================================================
test.describe('Lifecycle', () => {
  test('initial children are mounted', async ({ page }) => {
    const log = page.locator('#lifecycle-log')
    await expect(log).toContainText('Mounted: 1')
    await expect(log).toContainText('Mounted: 2')
  })

  test('new child triggers mount', async ({ page }) => {
    await page.click('#add-lifecycle-child')
    const log = page.locator('#lifecycle-log')
    await expect(log).toContainText('Mounted: 3')
  })

  test('children render correctly after add/remove', async ({ page }) => {
    await expect(page.locator('.lifecycle-child')).toHaveCount(2)

    await page.click('#add-lifecycle-child')
    await expect(page.locator('.lifecycle-child')).toHaveCount(3)

    await page.click('#remove-lifecycle-child')
    await expect(page.locator('.lifecycle-child')).toHaveCount(2)
  })
})

// ============================================================================
// 11. Derived Value Tests (Effect-like behavior)
// ============================================================================
test.describe('Derived Values', () => {
  test('derived value shows initial count', async ({ page }) => {
    await expect(page.locator('#effect-count')).toHaveText('0')
    await expect(page.locator('#effect-message')).toContainText('Current count: 0')
  })

  test('derived value updates when state changes', async ({ page }) => {
    await page.click('#effect-increment')
    await expect(page.locator('#effect-count')).toHaveText('1')
    await expect(page.locator('#effect-message')).toContainText('Current count: 1')

    await page.click('#effect-increment')
    await expect(page.locator('#effect-count')).toHaveText('2')
    await expect(page.locator('#effect-message')).toContainText('Current count: 2')
  })
})

// ============================================================================
// 12. Memo/Computed Tests
// ============================================================================
test.describe('Computed Values', () => {
  test('computed value shows initial sum', async ({ page }) => {
    await expect(page.locator('#memo-sum')).toContainText('Sum: 3')
  })

  test('computed value updates when dependencies change', async ({ page }) => {
    await page.click('#increment-a')
    await expect(page.locator('#memo-sum')).toContainText('Sum: 4')

    await page.click('#increment-b')
    await expect(page.locator('#memo-sum')).toContainText('Sum: 5')
  })
})
