import { describe, it, expect } from 'vitest'

import fict from '..'

describe('fict-vite-plugin', () => {
  it('applies the TypeScript transformer', () => {
    const plugin = fict()
    const sample = `
      import { $state } from 'fict'
      let count = $state(0)
      const Button = () => <button>{count}</button>
    `

    const transform = plugin.transform as any
    const result =
      typeof transform === 'function'
        ? transform.call({} as any, sample, '/src/Button.tsx')
        : transform?.handler.call({} as any, sample, '/src/Button.tsx')
    expect(result && typeof result === 'object').toBe(true)
    if (result && typeof result === 'object' && 'code' in result) {
      // Check that $state is transformed to createSignal
      expect(result.code).toContain('__fictSignal')
      // Check that JSX is compiled with accessor calls
      expect(result.code.includes('count()')).toBe(true)
    }
  })
})
