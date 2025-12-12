import { describe, it, expect, vi } from 'vitest'

import fict from '..'

describe('fict vite-plugin', () => {
  it('applies the Babel transformer', async () => {
    const plugin = fict()
    const sample = `
      import { $state } from 'fict'
      let count = $state(0)
      const Button = () => <button>{count}</button>
    `

    const mockContext = {
      error: vi.fn(),
    }

    const transform = plugin.transform as any
    const result =
      typeof transform === 'function'
        ? await transform.call(mockContext, sample, '/project/src/Button.tsx')
        : await transform?.handler.call(mockContext, sample, '/project/src/Button.tsx')

    expect(result && typeof result === 'object').toBe(true)
    if (result && typeof result === 'object' && 'code' in result) {
      // Check that $state is transformed to __fictSignal
      expect(result.code).toContain('__fictSignal')
      // Check that JSX is compiled with accessor calls
      expect(result.code.includes('count()')).toBe(true)
    }
  })
})
