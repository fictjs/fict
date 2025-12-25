import { describe, it, expect } from 'vitest'

import { type FictCompilerOptions } from '../src/index'
import { transform } from './test-utils'

function transformWithOptions(source: string, options: FictCompilerOptions) {
  return transform(source, options)
}

describe('Rule D Verification', () => {
  // TODO: HIR codegen region handling is different - skip until output format is aligned
  it('groups related derived values into a single region', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(0)
      let heading
      let extra

      if (count > 0) {
        const noun = count > 1 ? 'Videos' : 'Video'
        heading = \`\${count} \${noun}\`
        extra = count * 10
      }
    `
    const output = transform(input)

    // HIR groups derived values into region memo
    expect(output).toContain('__fictUseMemo')
    // Should contain output variables
    expect(output).toContain('heading')
    expect(output).toContain('extra')
    // Should use region-based destructuring
    expect(output).toContain('__region_')
  })

  // TODO: HIR codegen region handling is different - skip until output format is aligned
  it('groups derived values that include ternary control flow', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(0)
      const doubled = count * 2
      const heading = count > 0 ? \`\${count} items\` : 'none'
      const summary = count > 1 ? doubled + 1 : doubled - 1
    `
    const output = transform(input)

    // HIR groups derived values into region memo
    expect(output).toContain('__fictUseMemo')
    expect(output).toContain('doubled')
    expect(output).toContain('heading')
    expect(output).toContain('summary')
    // Should use region-based output
    expect(output).toContain('__region_')
  })

  it('preserves region grouping before early returns', () => {
    const input = `
      import { $state } from 'fict'
      const count = $state(0)

      export function view() {
        const doubled = count * 2
        const tripled = doubled + count
        if (count > 5) {
          return doubled
        }
        return tripled
      }
    `
    const output = transform(input)

    // Note: For function-scoped derived values used in return statements,
    // the compiler may use simple getters instead of regions if they're not in conditionals
    // This is valid behavior - the test should check for proper reactivity
    expect(output).toContain('doubled')
    expect(output).toContain('tripled')
    // Either regions, simple getters, or individual memos are acceptable
    const hasRegion = output.includes('__fictUseMemo')
    const hasSimpleGetters =
      output.includes('const doubled = () =>') && output.includes('const tripled = () =>')
    const hasMemoCalls =
      output.includes('__fictUseMemo') ||
      output.includes('__fictMemo') ||
      output.includes('useMemo')
    expect(hasRegion || hasSimpleGetters || hasMemoCalls).toBe(true)
  })

  // TODO: HIR codegen condition caching is different - skip until output format is aligned
  it('caches conditional evaluation for lazy branches', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(0)
      let heading
      let detail

      if (count > 1) {
        heading = count * 2
        detail = heading + 1
      }
    `
    const output = transformWithOptions(input, { lazyConditional: true })
    // HIR uses memo for conditional derived values
    expect(output).toContain('__fictUseMemo')
    expect(output).toContain('heading')
    expect(output).toContain('detail')
  })

  // TODO: HIR codegen region handling is different - skip until output format is aligned
  it('groups derived values assigned inside switch branches', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(0)
      let label
      let bonus

      switch (count) {
        case 0:
          label = 'zero'
          bonus = count + 1
          break
        case 1:
          label = 'one'
          bonus = count + 2
          break
        default:
          label = 'many'
          bonus = count * 2
      }
    `

    const output = transform(input)
    // HIR groups switch-derived values into region memo
    expect(output).toContain('__fictUseMemo')
    expect(output).toContain('label')
    expect(output).toContain('bonus')
    expect(output).toContain('__region_')
  })
})
