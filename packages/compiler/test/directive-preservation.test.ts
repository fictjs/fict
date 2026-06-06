import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('directive preservation', () => {
  it('preserves program use client directives before generated imports', () => {
    const output = transform(`
      'use client'

      import { $state } from 'fict'

      export function useProbe() {
        let count = $state(0)
        return count
      }
    `)

    expect(output.trimStart()).toMatch(/^['"]use client['"];/)
    expect(output.search(/['"]use client['"];/)).toBeLessThan(output.indexOf('import'))
  })

  it('preserves program use server directives in plain modules', () => {
    const output = transform(`
      'use server'

      export function action() {
        return 1
      }
    `)

    expect(output.trimStart()).toMatch(/^['"]use server['"];/)
  })

  it('does not re-emit consumed Fict program directives', () => {
    const output = transform(`
      'use client'
      'use no memo'

      import { $state } from 'fict'

      export function useProbe() {
        let count = $state(0)
        return count
      }
    `)

    expect(output).toMatch(/['"]use client['"];/)
    expect(output).not.toContain('use no memo')
  })

  it('honors program compiler disable directives by skipping Fict lowering', () => {
    const output = transform(`
      'use fict-compiler-disable'

      import { $state } from 'fict'

      export function App() {
        const count = $state(0)
        return <div>{count}</div>
      }
    `)

    expect(output.trimStart()).toMatch(/^['"]use fict-compiler-disable['"];/)
    expect(output).toContain('$state(0)')
    expect(output).toContain('return <div>{count}</div>')
    expect(output).not.toContain('__fictUseSignal')
    expect(output).not.toContain('template(')
  })

  it('lets program compiler disable directives take precedence over enable directives', () => {
    const output = transform(`
      'use fict-compiler'
      'use fict-compiler-disable'

      import { $state } from 'fict'

      export function App() {
        const count = $state(0)
        return <div>{count}</div>
      }
    `)

    expect(output).toContain('$state(0)')
    expect(output).not.toContain('__fictUseSignal')
  })

  it('skips compiler-only TypeScript runtime declaration rejection when disabled', () => {
    expect(() =>
      transform(`
        'use fict-compiler-disable'

        export enum Color {
          Red = 1,
        }
      `),
    ).not.toThrow()
  })

  it('preserves function body directives in transformed hooks', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function useProbe() {
        'custom directive'
        let count = $state(0)
        return count
      }
    `)

    expect(output).toMatch(/['"]custom directive['"];\s+const __fictCtx/)
  })

  it('preserves function body directives in plain functions', () => {
    const output = transform(`
      export function action() {
        'custom directive'
        return 1
      }
    `)

    expect(output).toMatch(/['"]custom directive['"];\s+return 1/)
  })

  it('does not re-emit consumed Fict function directives', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function useProbe() {
        'custom directive'
        'use no memo'
        let count = $state(0)
        return count
      }
    `)

    expect(output).toMatch(/['"]custom directive['"];/)
    expect(output).not.toContain('use no memo')
  })
})
