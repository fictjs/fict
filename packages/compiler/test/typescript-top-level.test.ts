import { describe, expect, it } from 'vitest'

import { transform, transformRawTypeScript } from './test-utils'

describe('TypeScript top-level declarations', () => {
  it('lets non-exported type and interface declarations be erased by TypeScript', () => {
    const output = transform(`
      type Foo = { a: number }

      interface Bar {
        b: string
      }

      export function useProbe() {
        return 1
      }
    `)

    expect(output).not.toContain('type Foo')
    expect(output).not.toContain('interface Bar')
    expect(output).toContain('export function useProbe')
  })

  it('lets exported type and interface declarations be erased by TypeScript', () => {
    const output = transform(`
      export type Foo = { a: number }

      export interface Bar {
        b: string
      }

      export function useProbe() {
        return 1
      }
    `)

    expect(output).not.toContain('type Foo')
    expect(output).not.toContain('interface Bar')
    expect(output).toContain('export function useProbe')
  })

  it('does not lower ambient declarations to runtime bindings', () => {
    const output = transform(`
      declare const X: number
      declare function declaredFn(): number
      declare class DeclaredClass {}

      export declare const Y: number

      export function useProbe() {
        return 1
      }
    `)

    expect(output).not.toContain('const X = undefined')
    expect(output).not.toContain('function declaredFn')
    expect(output).not.toContain('class DeclaredClass')
    expect(output).not.toContain('const Y = undefined')
    expect(output).toContain('export function useProbe')
  })

  it('rejects TypeScript enums that have not been lowered first', () => {
    expect(() =>
      transformRawTypeScript(`
      enum Status {
        Ready = 1,
      }

      const enum Flag {
        On = 2,
      }

      export function useProbe() {
        return Status.Ready + Flag.On
      }
    `),
    ).toThrow(/TypeScript enum declarations must be lowered by TypeScript before Fict compilation/)
  })
})
