import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('warnings as errors', () => {
  const source = `
    import { $state } from 'fict'
    function App() {
      const state = $state({ count: 0 })
      state.count = 1
      return state.count
    }
  `

  it('throws when warnings are escalated to errors (dev)', () => {
    expect(() => transform(source, { warningsAsErrors: true })).toThrow(
      /Fict warning treated as error/,
    )
  })

  it('throws when warnings are escalated to errors (prod)', () => {
    expect(() => transform(source, { dev: false, warningsAsErrors: ['FICT-M'] })).toThrow(
      /Fict warning treated as error/,
    )
  })

  it('allows warning suppression via warningLevels', () => {
    expect(() =>
      transform(source, {
        warningsAsErrors: true,
        warningLevels: { 'FICT-M': 'off' },
      }),
    ).not.toThrow()
  })
})
