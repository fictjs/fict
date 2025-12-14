import { describe, expect, it } from 'vitest'

import { type FictCompilerOptions } from '../src/index'

import { transformFineGrained } from './test-utils'

const transform = (source: string, options?: FictCompilerOptions) => {
  return transformFineGrained(source, options)
}

describe('Error/Cycle Protection', () => {
  it('detects simple cycle: a -> b -> a', () => {
    const source = `
      import { $state } from 'fict'
      const count = $state(0)
      const a = count + b
      const b = count + a
    `
    // Should throw compiler error
    expect(() => transform(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('detects self-reference: a -> a', () => {
    const source = `
      import { $state } from 'fict'
      const count = $state(0)
      const a = count + a
    `
    expect(() => transform(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('detects long cycle: a -> b -> c -> a', () => {
    const source = `
      import { $state } from 'fict'
      const count = $state(0)
      const a = count + b
      const b = c + 1
      const c = a + 1
    `
    expect(() => transform(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('allows linear dependencies: a -> b -> c', () => {
    const source = `
      import { $state } from 'fict'
      const count = $state(0)
      const a = count + 1
      const b = a + 1
      const c = b + 1
      console.log(c)
    `
    const output = transform(source)
    expect(output).toContain('const c =')
    expect(output).not.toContain('const c = c')
  })
})
