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
