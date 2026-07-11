import { rm } from 'node:fs/promises'
import path from 'node:path'

import type { ModuleReactiveMetadata } from '@fictjs/compiler'
import type { NormalModule, Stats } from 'webpack'

import {
  createCompilationState,
  restoreFictModuleMetadata,
  storeFictModuleMetadata,
} from '../shared'

import {
  backdateFixtureInputs,
  createFixture,
  createWebpackConfiguration,
  runApp,
  runCompiler,
} from './fixture'

function readStoredMetadata(
  stats: Stats,
  resource: string,
): { filename: string; metadata: ModuleReactiveMetadata } {
  const module = [...stats.compilation.modules].find(
    candidate => (candidate as { resource?: unknown }).resource === resource,
  ) as { buildInfo?: Record<string, unknown> } | undefined
  const stored = module?.buildInfo?.fictWebpackMetadata as
    | { filename?: unknown; metadataJson?: unknown }
    | undefined
  if (typeof stored?.filename !== 'string' || typeof stored.metadataJson !== 'string') {
    throw new Error(`No persisted Fict metadata found for ${resource}.`)
  }
  return {
    filename: stored.filename,
    metadata: JSON.parse(stored.metadataJson) as ModuleReactiveMetadata,
  }
}

describe('@fictjs/webpack-plugin resource-query metadata', () => {
  it('keeps separate Webpack modules for query variants of one resource', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter as useRawCounter } from './use-counter?raw'
        import { useCounter as useVariantCounter } from './use-counter?variant'

        export function App() {
          const rawCounter = useRawCounter()
          const variantCounter = useVariantCounter()
          return rawCounter + variantCounter
        }
      `,
      'use-counter.ts': `
        import { $state } from 'fict'

        export function useCounter() {
          const count = $state(1)
          return count
        }
      `,
    })

    try {
      await runCompiler(createWebpackConfiguration(root))
      expect(runApp(root)).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps divergent query-loader metadata attached to the correct variant', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter as useRawCounter } from './use-counter?raw'
        import { useCounter as useVariantCounter } from './use-counter?variant'

        export function App() {
          const rawCounter = useRawCounter()
          const variantCounter = useVariantCounter()
          return rawCounter + variantCounter * 2
        }
      `,
      'query-loader.cjs': `
        module.exports = function (source) {
          if (this.resourceQuery !== '?raw') return source
          return source.replace('const count = $state(1)', 'const count = 40')
        }
      `,
      'use-counter.ts': `
        import { $state } from 'fict'

        export function useCounter() {
          const count = $state(1)
          return count
        }
      `,
    })
    const entryPath = path.join(root, 'entry.ts')
    const hookPath = path.join(root, 'use-counter.ts')
    const queryLoaderPath = path.join(root, 'query-loader.cjs')
    const rawResource = `${hookPath}?raw`
    const variantResource = `${hookPath}?variant`
    const cache = {
      type: 'filesystem' as const,
      cacheDirectory: path.join(root, '.webpack-cache'),
    }
    const configuration = () => {
      const configured = createWebpackConfiguration(root, { cache })
      configured.module!.rules!.push({
        resourceQuery: /raw/,
        use: [queryLoaderPath],
      })
      return configured
    }

    try {
      await backdateFixtureInputs([entryPath, hookPath, queryLoaderPath])
      await runCompiler(configuration())
      expect(runApp(root)).toBe(42)
      const stats = await runCompiler(configuration())
      expect(runApp(root)).toBe(42)
      const rawMetadata = readStoredMetadata(stats, rawResource)
      const variantMetadata = readStoredMetadata(stats, variantResource)
      expect(rawMetadata.filename).toBe(path.resolve(rawResource))
      expect(variantMetadata.filename).toBe(path.resolve(variantResource))
      expect(rawMetadata.metadata.hooks?.useCounter?.directAccessor).toBeUndefined()
      expect(variantMetadata.metadata.hooks?.useCounter?.directAccessor).toBe('signal')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rehydrates cached metadata under the current full resource identity', () => {
    const state = createCompilationState()
    const physicalFilename = path.resolve('/virtual/use-counter.ts')
    const resource = `${physicalFilename}?raw`
    const module = { buildInfo: {}, resource } as unknown as NormalModule
    const metadata: ModuleReactiveMetadata = {
      exports: {},
      hooks: { useCounter: { directAccessor: 'signal' } },
    }

    storeFictModuleMetadata(state, module, physicalFilename, metadata, 'old-fingerprint')

    expect(restoreFictModuleMetadata(module)).toMatchObject({
      filename: path.resolve(resource),
      metadata,
      incomplete: true,
      dependencyFingerprint: null,
    })
  })
})
