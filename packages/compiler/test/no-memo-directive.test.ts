import { describe, it, expect } from 'vitest'
import { transform } from './test-utils'

describe('"use no memo" directive', () => {
  // TODO: HIR codegen directive handling is different
  it('disables memo/region/fine-grained at file level', () => {
    const output = transform(`
      "use no memo";
      import { $state } from 'fict'
      function View() {
        let count = $state(0)
        const doubled = count * 2
        return <div>{doubled}</div>
      }
    `)

    expect(output).not.toContain('__fictMemo')
    expect(output).not.toContain('__fictConditional')
    expect(output).not.toContain('bindText')
    expect(output).toContain('count()')
  })

  it('disables memo inference inside a function-scoped directive', () => {
    const output = transform(`
      import { $state } from 'fict'
      function View() {
        "use no memo";
        let count = $state(0)
        const doubled = count * 2
        return <div>{doubled}</div>
      }
    `)

    expect(output).not.toContain('__fictMemo')
    expect(output).toContain('count()')
  })
})
