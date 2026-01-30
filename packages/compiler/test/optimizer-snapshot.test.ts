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

  it('createMemo with equals option', () => {
    const source = `
      import { createMemo, $state } from 'fict'
      export function Demo() {
        let count = $state({ value: 0 })
        const memoized = createMemo(
          () => ({ doubled: count.value * 2 }),
          { equals: (prev, next) => prev.doubled === next.doubled }
        )
        return memoized().doubled
      }
    `
    const output = transformOptimized(source)
    expect(output).toMatchSnapshot()
  })

  it('createMemo with name and devToolsSource options', () => {
    const source = `
      import { createMemo, $state } from 'fict'
      export function Demo() {
        let count = $state(5)
        const doubled = createMemo(
          () => count * 2,
          { name: 'doubledMemo', devToolsSource: 'Demo.tsx:5' }
        )
        return doubled()
      }
    `
    const output = transformOptimized(source)
    expect(output).toMatchSnapshot()
  })
})
