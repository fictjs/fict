import { describe, expect, it } from 'vitest'

import { transform, transformWithCompilerDefaults } from './test-utils'

describe('compiler default options', () => {
  it('enables lazyConditional by default', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        if (count > 0) {
          return <div>{count}</div>
        }
        return <span>{count}</span>
      }
    `

    const withCompilerDefaults = transformWithCompilerDefaults(source, { strictGuarantee: false })
    const withLazyConditionalDisabled = transform(source, {
      strictGuarantee: false,
      lazyConditional: false,
    })

    expect(withCompilerDefaults).toContain('createConditional')
    expect(withLazyConditionalDisabled).not.toContain('createConditional')
  })

  it('enables getterCache by default', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        const click = () => {
          console.log(count)
          console.log(count)
          console.log(count)
        }
        return click
      }
    `

    const output = transformWithCompilerDefaults(source, { strictGuarantee: false })
    expect(output).toMatch(/__cached_count_\d+/)
  })

  it('enables strictGuarantee by default', () => {
    const source = `
      function App({ list: [first, ...rest] }) {
        return <div>{first}</div>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).toThrow(/FICT-P00[1-5]/)
  })
})
