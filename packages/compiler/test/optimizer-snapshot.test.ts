import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

const transformOptimized = (source: string) =>
  transform(source, { fineGrainedDom: false, optimize: true, dev: false })

describe('optimizer output snapshots', () => {
  it('stabilizes cross-block constants in a reactive function', () => {
    const source = `
      import { $state } from 'fict'
      export function Demo(flag) {
        let count = $state(1)
        const __a = 1
        const __b = __a + 2
        if (flag) {
          return __b + count
        }
        return __b + count
      }
    `
    const output = transformOptimized(source)
    expect(output).toMatchSnapshot()
  })

  it('stabilizes derived values and memo accessors', () => {
    const source = `
      import { $state } from 'fict'
      export function Demo() {
        let count = $state(2)
        const doubled = count * 2
        return doubled
      }
    `
    const output = transformOptimized(source)
    expect(output).toMatchSnapshot()
  })
})
