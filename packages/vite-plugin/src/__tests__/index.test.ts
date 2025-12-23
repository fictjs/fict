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
      // HIR codegen is now the default - check for HIR output markers
      // The output should contain __fict_hir_codegen__ marker or runtime imports
      const code = result.code as string
      const hasHIRMarker = code.includes('__fict_hir_codegen__')
      const hasRuntimeImport = code.includes('@fictjs/runtime')
      expect(hasHIRMarker || hasRuntimeImport).toBe(true)
    }
  })
})
