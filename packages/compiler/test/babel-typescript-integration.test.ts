import path from 'node:path'

import { transformSync, type PluginObj } from '@babel/core'
import { describe, expect, it } from 'vitest'

import fictPreset from '../../babel-preset/src'

describe('@fictjs/babel-preset TypeScript integration', () => {
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
