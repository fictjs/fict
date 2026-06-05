import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('runtime helper name collisions', () => {
  it('aliases runtime helper imports when source declares the default helper names', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        const __fictUseSignal = () => 'local signal'
        const __fictUseContext = () => 'local context'
        const __fictUseMemo = () => 'local memo'

        export function useProbe() {
          let count = $state(1)
          const doubled = count * 2
          return doubled
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/__fictUseSignal as __fictUseSignal_1/)
    expect(output).toMatch(/__fictUseContext as __fictUseContext_1/)
    expect(output).toMatch(/__fictUseMemo as __fictUseMemo_1/)
    expect(output).toContain('const __fictUseSignal = () => "local signal";')
    expect(output).toContain('const __fictUseContext = () => "local context";')
    expect(output).toContain('const __fictUseMemo = () => "local memo";')
    expect(output).toMatch(/const __fictCtx = __fictUseContext_1\(\)/)
    expect(output).toMatch(/const count = __fictUseSignal_1\(__fictCtx, 1/)
    expect(output).toMatch(/const doubled = __fictUseMemo_1\(__fictCtx, \(\) => count\(\) \* 2/)
  })

  it('renames inlined for-of and for-in helpers when source declares their names', () => {
    const output = transform(
      `
        const __fictForOf = () => 'local for-of'
        const __fictForIn = () => 'local for-in'

        export function probe() {
          __forOf([1], item => item)
          __forIn({ a: 1 }, key => key)
        }
      `,
      { dev: false, optimize: false },
    )

    expect(output).toContain('const __fictForOf = () => "local for-of";')
    expect(output).toContain('const __fictForIn = () => "local for-in";')
    expect(output).toMatch(/function __fictForOf_1\(/)
    expect(output).toMatch(/function __fictForIn_1\(/)
    expect(output).toMatch(/__fictForOf_1\(\[1\], item => item\)/)
    expect(output).toMatch(/__fictForIn_1\(\{\s*a: 1\s*\}, key => key\)/)
  })
})
