import { describe, expect, it } from 'vitest'

import { transformCommonJS } from './test-utils'

describe('fast paths', () => {
  it('avoids DOM helpers and preserves accessors when there is no JSX or control flow', () => {
    const output = transformCommonJS(`
      import { $state } from 'fict'

      export function useCounter() {
        const count = $state(0)
        const doubled = count * 2
        return { count, doubled }
      }
    `)

    expect(output).not.toContain('template(')
    expect(output).toContain('__fictUseSignal')
    expect(output).toContain('return {')
    expect(output).toContain('count:')
    expect(output).toContain('doubled:')
  })
})
