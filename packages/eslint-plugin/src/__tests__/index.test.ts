import { describe, it, expect } from 'vitest'

import plugin from '..'

describe('eslint-plugin-fict', () => {
  it('exposes renamed rules', () => {
    expect(plugin.rules?.['no-empty-effect']).toBeDefined()
    expect(plugin.rules?.['no-state-in-loop']).toBeDefined()
    expect(plugin.rules?.['no-direct-mutation']).toBeDefined()
  })

  it('includes recommended config entries', () => {
    const recommended = (plugin.configs as Record<string, any>)?.recommended?.rules ?? {}
    expect(recommended['fict/no-empty-effect']).toBe('warn')
    expect(recommended['fict/no-state-in-loop']).toBe('error')
  })
})
