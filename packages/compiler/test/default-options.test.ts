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

  it('does not cache returned closure reads by default', () => {
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
    expect(output).not.toMatch(/__cached_count_\d+/)
    expect(output).toMatch(/console\.log\(count\(\)\)/)
  })

  it('enables strictGuarantee by default', () => {
    const source = `
      function App({ list: [first, ...rest] }) {
        return <div>{first}</div>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).toThrow(/FICT-P00[1-5]/)
  })

  it('forces strictGuarantee on in production even when an integration opts out', () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const source = `
      import { $state } from 'fict'
      function sink(value) {
        return value
      }
      function App() {
        let count = $state(0)
        sink(count)
        return <div />
      }
    `

    try {
      expect(() =>
        transformWithCompilerDefaults(source, {
          strictGuarantee: false,
          dev: false,
        }),
      ).toThrow(/FICT-S002/)
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
    }
  })
})
