import { transformSync } from '@babel/core'
import pluginTransformTypescript from '@babel/plugin-transform-typescript'
import { describe, expect, it } from 'vitest'

import createFictPlugin from '../src/index'

function transformWithExplicitResourceManagement(source: string): void {
  transformSync(source, {
    filename: 'using.tsx',
    configFile: false,
    babelrc: false,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'explicitResourceManagement'],
    },
    plugins: [
      [
        pluginTransformTypescript,
        {
          isTSX: true,
          allExtensions: true,
          allowDeclareFields: true,
          allowNamespaces: true,
        },
      ],
      [createFictPlugin, { dev: true, strictGuarantee: false }],
    ],
  })
}

function expectUsingRejected(source: string): void {
  expect(() => transformWithExplicitResourceManagement(source)).toThrow(
    /`using` and `await using` declarations are not supported/,
  )
}

describe('using declarations', () => {
  it('rejects using declarations on normal return paths', () => {
    expectUsingRejected(`
      import { $state } from 'fict'

      export function useF() {
        const count = $state(1)
        using resource = {
          [Symbol.dispose]() {}
        }
        return count
      }
    `)
  })

  it('rejects using declarations on throw paths', () => {
    expectUsingRejected(`
      import { $state } from 'fict'

      export function useF() {
        const count = $state(1)
        using resource = {
          [Symbol.dispose]() {}
        }
        throw new Error(String(count()))
      }
    `)
  })

  it('rejects using declarations inside abrupt loop control flow', () => {
    expectUsingRejected(`
      import { $state } from 'fict'

      export function useF() {
        const count = $state(1)
        while (count() > 0) {
          using resource = {
            [Symbol.dispose]() {}
          }
          break
        }
        return count
      }
    `)
  })

  it('rejects using declarations in nested scopes', () => {
    expectUsingRejected(`
      import { $state } from 'fict'

      export function useF() {
        const count = $state(1)
        {
          using resource = {
            [Symbol.dispose]() {}
          }
        }
        return count
      }
    `)
  })

  it('rejects await using declarations', () => {
    expectUsingRejected(`
      import { $state } from 'fict'

      export async function useF() {
        const count = $state(1)
        await using resource = {
          async [Symbol.asyncDispose]() {}
        }
        return count
      }
    `)
  })
})
