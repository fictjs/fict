import path from 'node:path'

import { transformSync } from '@babel/core'
import { describe, expect, it } from 'vitest'

import fictPreset from '../../babel-preset/src'

describe('@fictjs/babel-preset TypeScript integration', () => {
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
