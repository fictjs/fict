import { describe, expect, it } from 'vitest'

import type { CompilerWarning } from '../src/index'

import { transform } from './test-utils'

describe('diagnostic suppression directives', () => {
  it('suppresses next-line warnings with fict-ignore-next-line', () => {
    const warnings: CompilerWarning[] = []
    transform(
      `
        import { $memo } from 'fict'
        // fict-ignore-next-line FICT-M003
        const value = $memo(() => {
          fetch('/api/data')
        })
      `,
      { onWarn: w => warnings.push(w) },
    )

    expect(warnings.length).toBe(0)
  })

  it('suppresses inline warnings with fict-ignore', () => {
    const warnings: CompilerWarning[] = []
    transform(
      `
        import { $memo } from 'fict'
        const value = $memo(() => { // fict-ignore FICT-M003
          console.log('side')
        })
      `,
      { onWarn: w => warnings.push(w) },
    )

    expect(warnings.some(w => w.code === 'FICT-M003')).toBe(false)
  })

  it('does not suppress warnings from prose that mentions fict-ignore-next-line', () => {
    const warnings: CompilerWarning[] = []
    transform(
      `
        import { $memo } from 'fict'
        // documentation says do not use fict-ignore-next-line FICT-M003 here
        const value = $memo(() => {
          console.log('side')
        })
      `,
      { onWarn: w => warnings.push(w) },
    )

    expect(warnings.some(w => w.code === 'FICT-M003')).toBe(true)
  })

  it('does not reject strictGuarantee for prose that mentions fict-ignore', () => {
    expect(() =>
      transform(
        `
          // documentation says do not use fict-ignore-next-line FICT-R006 here
          import { $state } from 'fict'

          function App() {
            const count = $state(0)
            return <div>{count}</div>
          }
        `,
        { strictGuarantee: true },
      ),
    ).not.toThrow(/strictGuarantee does not allow fict-ignore/)
  })
})
