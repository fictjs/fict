import { expect, test } from '@playwright/test'

test('runtime rejects invalid DOM names with browser-compatible errors', async ({ page }) => {
  await page.goto('/')
  const errors = await page.evaluate(async () => {
    const moduleUrl = '/src/dom-name-test-api.ts'
    const { createElement } = await import(moduleUrl)
    const capture = (fn: () => unknown) => {
      try {
        fn()
        return { isDOMException: false, name: '' }
      } catch (error) {
        return {
          isDOMException: error instanceof DOMException,
          name: error instanceof Error ? error.name : '',
        }
      }
    }

    return [
      capture(() =>
        createElement({
          type: 'div name',
          props: { children: 'unsafe' },
          key: undefined,
        }),
      ),
      capture(() =>
        createElement({
          type: 'div',
          props: { 'data unsafe': 'value' },
          key: undefined,
        }),
      ),
      capture(() =>
        createElement({
          type: 'svg',
          props: {
            children: {
              type: 'use',
              props: { 'xlink::href': '#icon' },
              key: undefined,
            },
          },
          key: undefined,
        }),
      ),
    ]
  })

  expect(errors).toEqual([
    { isDOMException: true, name: 'InvalidCharacterError' },
    { isDOMException: true, name: 'InvalidCharacterError' },
    { isDOMException: true, name: 'InvalidCharacterError' },
  ])
})
