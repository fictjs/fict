import { describe, it, expect } from 'vitest'

import plugin from '../src/index'

describe('eslint-plugin-fict', () => {
  it('exposes renamed rules', () => {
    expect(plugin.rules?.['no-empty-effect']).toBeDefined()
    expect(plugin.rules?.['no-state-in-loop']).toBeDefined()
    expect(plugin.rules?.['no-direct-mutation']).toBeDefined()
    expect(plugin.rules?.['no-state-destructure-write']).toBeDefined()
    expect(plugin.rules?.['no-state-outside-component']).toBeDefined()
    expect(plugin.rules?.['no-nested-components']).toBeDefined()
    expect(plugin.rules?.['require-list-key']).toBeDefined()
    expect(plugin.rules?.['no-memo-side-effects']).toBeDefined()
    expect(plugin.rules?.['require-component-return']).toBeDefined()
  })

  it('includes recommended config entries', () => {
    const recommended = (plugin.configs as Record<string, any>)?.recommended?.rules ?? {}
    expect(recommended['fict/no-empty-effect']).toBe('warn')
    expect(recommended['fict/no-state-in-loop']).toBe('error')
    expect(recommended['fict/no-state-destructure-write']).toBe('error')
    expect(recommended['fict/no-state-outside-component']).toBe('error')
    expect(recommended['fict/no-nested-components']).toBe('error')
    expect(recommended['fict/require-list-key']).toBe('error')
    expect(recommended['fict/no-memo-side-effects']).toBe('warn')
    expect(recommended['fict/require-component-return']).toBe('warn')
  })
})
