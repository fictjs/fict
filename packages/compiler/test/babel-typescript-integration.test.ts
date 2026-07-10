import path from 'node:path'

import { transformSync, types as t, type PluginObj } from '@babel/core'
import { describe, expect, it } from 'vitest'

import fictPreset from '../../babel-preset/src'

describe('@fictjs/babel-preset TypeScript integration', () => {
  const reactiveComponent = `
    import { $state } from 'fict'
    export function App() {
      const value = $state(1)
      return <div>{value}</div>
    }
  `

  it.each([
    {
      label: 'CommonJS',
      plugins: ['@babel/plugin-transform-modules-commonjs'],
    },
    {
      label: 'React JSX',
      plugins: [['@babel/plugin-transform-react-jsx', { runtime: 'classic' }]],
    },
    {
      label: 'CommonJS and React JSX',
      plugins: [
        '@babel/plugin-transform-modules-commonjs',
        ['@babel/plugin-transform-react-jsx', { runtime: 'classic' }],
      ],
    },
  ])('runs Fict before sibling $label transforms', ({ plugins }) => {
    const result = transformSync(reactiveComponent, {
      filename: 'App.tsx',
      configFile: false,
      babelrc: false,
      plugins,
      presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
    })

    expect(result?.code).toContain('<!--fict:slot:start-->')
    expect(result?.code).toContain('__fictUseSignal')
    expect(result?.code).not.toContain('$state')
    expect(result?.code).not.toContain('React.createElement')
  })

  it('runs Fict before sibling Program.enter JSX traversal', () => {
    const eagerJsxPlugin: PluginObj = {
      name: 'eager-jsx-consumer',
      visitor: {
        Program: {
          enter(path) {
            path.traverse({
              JSXElement(jsxPath) {
                jsxPath.replaceWith(t.stringLiteral('consumed-before-fict'))
              },
            })
          },
        },
      },
    }
    const result = transformSync(reactiveComponent, {
      filename: 'App.tsx',
      configFile: false,
      babelrc: false,
      plugins: [eagerJsxPlugin],
      presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
    })

    expect(result?.code).toContain('<!--fict:slot:start-->')
    expect(result?.code).not.toContain('consumed-before-fict')
  })

  it('inherits a sibling CommonJS marker while lowering TypeScript import-equals', () => {
    const result = transformSync(
      `
        import fs = require('node:fs')
        import { $state } from 'fict'

        export function App() {
          const value = $state(fs.constants.F_OK)
          return <div>{value}</div>
        }
      `,
      {
        filename: 'App.tsx',
        configFile: false,
        babelrc: false,
        plugins: ['@babel/plugin-transform-modules-commonjs'],
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(result?.code).toContain('require("node:fs")')
    expect(result?.code).toContain('require("fict/internal")')
    expect(result?.code).not.toContain('$state')
    expect(result?.code).not.toContain('import fs =')
  })

  it('runs sibling lifecycle hooks once and preserves outer source maps', () => {
    const lifecycle = { pre: 0, post: 0 }
    const siblingPlugin: PluginObj = {
      name: 'sibling-lifecycle-probe',
      visitor: {},
      pre() {
        lifecycle.pre++
      },
      post() {
        lifecycle.post++
      },
    }
    const result = transformSync(reactiveComponent, {
      filename: 'App.tsx',
      sourceFileName: 'App.tsx',
      sourceMaps: true,
      configFile: false,
      babelrc: false,
      plugins: [siblingPlugin],
      presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
    })

    expect(lifecycle).toEqual({ pre: 1, post: 1 })
    expect(result?.map?.sources).toContain('App.tsx')
    expect(result?.map?.mappings).not.toBe('')
  })

  it('reports isolated compiler errors with one filename prefix', () => {
    let thrown: unknown
    try {
      transformSync(
        `
          export function App() {
            const value = $state(1)
            return <div>{value}</div>
          }
        `,
        {
          filename: 'broken.tsx',
          configFile: false,
          babelrc: false,
          presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
        },
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message.match(/broken\.tsx:/g)).toHaveLength(1)
    expect(message).toContain('$state() must be imported from "fict"')
  })

  it('compiles CTS import-equals, export assignment, and Fict macros to CommonJS', () => {
    const result = transformSync(
      `
        import path = require('node:path')
        import { $state } from 'fict'

        function useValue() {
          const value = $state(path.sep.length)
          return value
        }

        export = { useValue }
      `,
      {
        filename: 'module.cts',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(result?.code).toContain('require("node:path")')
    expect(result?.code).toContain('require("fict/internal")')
    expect(result?.code).toContain('module.exports =')
    expect(result?.code).toContain('__fictUseSignal')
    expect(result?.code).not.toContain('$state')
    expect(result?.code).not.toMatch(/\b(?:import|export)\s/)
  })

  it('compiles ESM-style exports in CTS files to CommonJS', () => {
    const result = transformSync(`export const answer: number = 42`, {
      filename: 'module.cts',
      configFile: false,
      babelrc: false,
      presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
    })

    expect(result?.code).toContain('exports.answer =')
    expect(result?.code).not.toContain('export const')
  })

  it('honors onlyRemoveTypeImports and optimizeConstEnums', () => {
    const result = transformSync(
      `
        import { Shape } from './dep'
        const enum Status { Ready = 2 }
        export const value: Shape = { status: Status.Ready } as Shape
      `,
      {
        filename: 'options.ts',
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              typescriptOptions: {
                onlyRemoveTypeImports: true,
                optimizeConstEnums: true,
              },
            },
          ],
        ],
      },
    )

    expect(result?.code).toContain(`import { Shape } from './dep'`)
    expect(result?.code).not.toContain('function (Status)')
    expect(result?.code).not.toContain('Status.Ready')
    expect(result?.code).toContain('status: 2')
  })

  it('honors explicit JSX pragma imports before a sibling JSX transform', () => {
    const result = transformSync(
      `
        "use fict-compiler-disable"
        import { h, Fragment } from './factory'
        export const view = <><div /></>
      `,
      {
        filename: 'pragma.tsx',
        configFile: false,
        babelrc: false,
        plugins: [['@babel/plugin-transform-react-jsx', { pragma: 'h', pragmaFrag: 'Fragment' }]],
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              typescriptOptions: { jsxPragma: 'h', jsxPragmaFrag: 'Fragment' },
            },
          ],
        ],
      },
    )

    expect(result?.code).toContain(`import { h, Fragment } from './factory'`)
    expect(result?.code).toContain('h(Fragment')
  })

  it('rewrites TypeScript extensions after resolving hook metadata', () => {
    const filename = path.resolve('rewrite-importer.tsx')
    const hookFilename = path.resolve('use-count.ts')
    const moduleMetadata = new Map([
      [
        hookFilename,
        {
          version: 1 as const,
          exports: {},
          hooks: { useCount: { directAccessor: 'signal' as const } },
        },
      ],
    ])
    const result = transformSync(
      `
        import { useCount } from './use-count.ts'
        export const load = () => import('./lazy.mts')
        export function App() {
          const count = useCount()
          return <div>{count * 2}</div>
        }
      `,
      {
        filename,
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              moduleMetadata,
              typescriptOptions: { rewriteImportExtensions: true },
            },
          ],
        ],
      },
    )

    expect(result?.code).toMatch(/from ["']\.\/use-count\.js["']/)
    expect(result?.code).toMatch(/import\(["']\.\/lazy\.mjs["']\)/)
    expect(result?.code).toMatch(/count\(\)\s*\*\s*2/)
  })

  it('honors disallowAmbiguousJSXLike in all-extensions mode', () => {
    expect(() =>
      transformSync(`export const value = <number>input`, {
        filename: 'ambiguous.ts',
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              typescriptOptions: {
                allExtensions: true,
                isTSX: false,
                disallowAmbiguousJSXLike: true,
              },
            },
          ],
        ],
      }),
    ).toThrow(/syntax is reserved|disallowAmbiguousJSLike|angle-bracket/i)
  })

  it('removes an obsolete default JSX pragma import after Fict consumes JSX', () => {
    const result = transformSync(
      `
        import React from 'react'
        export function App() {
          return <div />
        }
      `,
      {
        filename: 'react-import.tsx',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(result?.code).toContain('template("<div></div>")')
    expect(result?.code).not.toContain("from 'react'")
    expect(result?.code).not.toContain('from "react"')
  })

  it('preserves JSX pragma imports with runtime uses or explicit import preservation', () => {
    const runtimeUse = transformSync(
      `
        import React from 'react'
        export const version = React.version
        export function App() {
          return <div />
        }
      `,
      {
        filename: 'react-runtime.tsx',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )
    const preserveImports = transformSync(
      `
        import React from 'react'
        export function App() {
          return <div />
        }
      `,
      {
        filename: 'react-preserved.tsx',
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              typescriptOptions: { onlyRemoveTypeImports: true },
            },
          ],
        ],
      },
    )

    expect(runtimeUse?.code).toMatch(/import React from ["']react["']/)
    expect(preserveImports?.code).toMatch(/import React from ["']react["']/)
  })

  it('detects TypeScript and TSX syntax from the file extension', () => {
    const typed = transformSync(
      `
        import { $state } from 'fict'
        export function useValue(input: unknown) {
          const asserted = <number>input
          const value = $state(asserted)
          return value
        }
      `,
      {
        filename: 'use-value.ts',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )
    const tsx = transformSync(
      `
        import { $state } from 'fict'
        export function App() {
          const value = $state(1)
          return <div>{value}</div>
        }
      `,
      {
        filename: 'App.tsx',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(typed?.code).toContain('__fictUseSignal')
    expect(typed?.code).not.toContain('<number>')
    expect(tsx?.code).toContain('__fictUseSignal')
    expect(tsx?.code).toContain('template("<div>')
  })

  it('composes with Babel plugins explicitly configured by the user', () => {
    const configuredPlugin: PluginObj = {
      name: 'configured-marker-plugin',
      visitor: {
        StringLiteral(path) {
          if (path.node.value === 'original-marker') {
            path.node.value = 'configured-marker'
          }
        },
      },
    }
    const result = transformSync(
      `
        import { $state } from 'fict'
        export function useMarker() {
          const marker = $state('original-marker')
          return marker
        }
      `,
      {
        filename: 'configured-preset.ts',
        configFile: false,
        babelrc: false,
        plugins: [configuredPlugin],
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(result?.code).toContain('configured-marker')
    expect(result?.code).not.toContain('original-marker')
    expect(result?.code).toContain('__fictUseSignal')
  })

  it('lowers runtime TypeScript before Fict and preserves hook metadata', () => {
    const filename = path.resolve('babel-typescript-integration.ts')
    const moduleMetadata = new Map()
    const result = transformSync(
      `
        import { $state } from 'fict'

        enum Status {
          Idle,
          Ready,
        }

        namespace Defaults {
          export const status = Status.Ready
        }

        class Model {
          declare status: Status
          current = Defaults.status
        }

        export function useStatus() {
          const status = $state(new Model().current)
          return status
        }
      `,
      {
        filename,
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              emitModuleMetadata: true,
              moduleMetadata,
            },
          ],
        ],
      },
    )

    expect(result?.code).toContain('__fictUseSignal')
    expect(result?.code).not.toContain('$state')
    expect(result?.code).not.toMatch(/\benum\s+Status\b/)
    expect(result?.code).not.toMatch(/\bnamespace\s+Defaults\b/)
    expect(result?.code).not.toContain('declare status')
    expect(moduleMetadata.get(filename)?.hooks?.useStatus).toEqual({
      directAccessor: 'signal',
    })
  })
})
