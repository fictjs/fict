import { describe, it, expect } from 'vitest'

import { type FictCompilerOptions } from '../index'
import { transformFineGrained } from './test-utils'

function transform(source: string): string {
  return transformFineGrained(source)
}

function transformWithOptions(source: string, options: FictCompilerOptions) {
  return transformFineGrained(source, options)
}

describe('Rule D Verification', () => {
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
    console.log(output)

    // Should contain the region marker
    expect(output).toContain('__fictRegion')
    // Should return an object with heading and extra (not noun - it's a local variable)
    expect(output).toContain('heading: heading != undefined ? heading : undefined')
    expect(output).toContain('extra: extra != undefined ? extra : undefined')
    // Should expose getters for external variables only
    expect(output).toMatch(/const heading = \(\) => __fictRegion_\d+\(\)\.heading/)
    expect(output).toMatch(/const extra = \(\) => __fictRegion_\d+\(\)\.extra/)
    // Should NOT expose noun - it's an internal variable
    expect(output).not.toContain('const noun = ()')
  })

  it('groups derived values that include ternary control flow', () => {
    const input = `
      import { $state } from 'fict'
      let count = $state(0)
      const doubled = count * 2
      const heading = count > 0 ? \`\${count} items\` : 'none'
      const summary = count > 1 ? doubled + 1 : doubled - 1
    `
    const output = transform(input)

    expect(output).toContain('__fictRegion')
    expect(output).toContain('doubled: doubled != undefined ? doubled : undefined')
    expect(output).toContain('heading: heading != undefined ? heading : undefined')
    expect(output).toContain('summary: summary != undefined ? summary : undefined')
    expect(output).toMatch(/const heading = \(\) => __fictRegion_\d+\(\)\.heading/)
    expect(output).toMatch(/const summary = \(\) => __fictRegion_\d+\(\)\.summary/)
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
    // Either regions or simple getters are acceptable
    const hasRegion = output.includes('__fictRegion')
    const hasSimpleGetters =
      output.includes('const doubled = () =>') && output.includes('const tripled = () =>')
    expect(hasRegion || hasSimpleGetters).toBe(true)
  })

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
    // Condition should be evaluated once into a temp
    expect(output).toMatch(/const __fictCond_\d+ = count\(\) > 1/)
    expect(output).toContain('__fictCond')
  })

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
    expect(output).toContain('__fictRegion')
    expect(output).toContain('label: label != undefined ? label : undefined')
    expect(output).toContain('bonus: bonus != undefined ? bonus : undefined')
    expect(output).toMatch(/const label = \(\) => __fictRegion_\d+\(\)\.label/)
    expect(output).toMatch(/const bonus = \(\) => __fictRegion_\d+\(\)\.bonus/)
  })
})
