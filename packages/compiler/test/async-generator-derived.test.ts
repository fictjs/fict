import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('async and generator derived initializers', () => {
  it('does not wrap reactive await initializers in sync memo getters', () => {
    const output = transform(`
      import { $state } from 'fict'

      export async function useF() {
        const count = $state(1)
        const v = await Promise.resolve(count)
        return v
      }
    `)

    expect(output).toContain('const v = await Promise.resolve(count())')
    expect(output).not.toContain('() => await')
  })

  it('preserves await assignments without memo wrapping', () => {
    const output = transform(`
      import { $state } from 'fict'

      export async function useF() {
        const count = $state(1)
        let v
        v = await Promise.resolve(count)
        return v
      }
    `)

    expect(output).toContain('v = await Promise.resolve(count())')
    expect(output).not.toContain('() => await')
  })

  it('keeps non-reactive await initializers direct', () => {
    const output = transform(`
      import { $state } from 'fict'

      export async function useF() {
        const count = $state(1)
        const v = await Promise.resolve(2)
        return v + count
      }
    `)

    expect(output).toContain('const v = await Promise.resolve(2)')
    expect(output).not.toContain('() => await')
  })

  it('does not wrap reactive yield initializers in sync memo getters', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function* useF() {
        const count = $state(1)
        const v = yield count
        return v
      }
    `)

    expect(output).toContain('const v = yield count()')
    expect(output).not.toContain('() => yield')
  })

  it('does not wrap reactive yield delegates in sync memo getters', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function* useF() {
        const items = $state([1, 2])
        const v = yield* items
        return v
      }
    `)

    expect(output).toContain('const v = yield* items()')
    expect(output).not.toContain('() => yield')
  })
})
