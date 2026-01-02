import { describe, expect, it } from 'vitest'

import { type FictCompilerOptions } from '../src/index'
import { transform } from './test-utils'

const run = (source: string, options?: FictCompilerOptions) => {
  return transform(source, options)
}

describe('Error/Cycle Protection', () => {
  it('detects simple cycle: a -> b -> a', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + b
        const b = count + a
        return a + b
      }
    `
    // Should throw compiler error
    expect(() => run(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('detects self-reference: a -> a', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + a
        return a
      }
    `
    expect(() => run(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('detects long cycle: a -> b -> c -> a', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + b
        const b = c + 1
        const c = a + 1
        return a + b + c
      }
    `
    expect(() => run(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('allows linear dependencies: a -> b -> c', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + 1
        const b = a + 1
        const c = b + 1
        console.log(c)
        return c
      }
    `
    const output = run(source)
    expect(output).toContain('const c =')
    expect(output).not.toContain('const c = c')
  })
})
