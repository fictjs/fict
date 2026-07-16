import { rm } from 'node:fs/promises'
import path from 'node:path'

import type { ModuleReactiveMetadata } from '@fictjs/compiler'
import type { NormalModule, Stats } from 'webpack'

import {
  createCompilationState,
  registerFictModule,
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
): {
  identifier: string
  metadata: ModuleReactiveMetadata
  resource: string
  webpackIdentifier: string
} {
  const module = [...stats.compilation.modules].find(
    candidate => (candidate as { resource?: unknown }).resource === resource,
  ) as NormalModule | undefined
  const stored = module?.buildInfo?.fictWebpackMetadataV7 as
    | { identifier?: unknown; metadataJson?: unknown; resource?: unknown; version?: unknown }
    | undefined
  if (
    !module ||
    stored?.version !== 7 ||
    typeof stored?.identifier !== 'string' ||
    typeof stored.metadataJson !== 'string' ||
    typeof stored.resource !== 'string'
  ) {
    throw new Error(`No persisted Fict metadata found for ${resource}.`)
  }
  return {
    identifier: stored.identifier,
    metadata: JSON.parse(stored.metadataJson) as ModuleReactiveMetadata,
    resource: stored.resource,
    webpackIdentifier: module.identifier(),
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
      expect(rawMetadata.identifier).toBe(rawMetadata.webpackIdentifier)
      expect(variantMetadata.identifier).toBe(variantMetadata.webpackIdentifier)
      expect(rawMetadata.identifier).not.toBe(variantMetadata.identifier)
      expect(rawMetadata.resource).toBe(path.resolve(rawResource))
      expect(variantMetadata.resource).toBe(path.resolve(variantResource))
      expect(rawMetadata.metadata.hooks?.useCounter?.directAccessor).toBeUndefined()
      expect(variantMetadata.metadata.hooks?.useCounter?.directAccessor).toBe('signal')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores pre-V7 resource-keyed cache records', () => {
    const state = createCompilationState()
    const physicalFilename = path.resolve('/virtual/use-counter.ts')
    const resource = `${physicalFilename}?raw`
    const identifier = `fict-loader!${resource}`
    const module = {
      buildInfo: {},
      identifier: () => identifier,
      resource,
    } as unknown as NormalModule
    const metadata: ModuleReactiveMetadata = {
      version: 1,
      exports: {},
      hooks: { useCounter: { directAccessor: 'signal' } },
    }

    registerFictModule(state, module)
    storeFictModuleMetadata(state, module, metadata, 'old-fingerprint')
    const buildInfo = module.buildInfo as unknown as Record<string, unknown>
    const stored = buildInfo.fictWebpackMetadataV7 as Record<string, unknown>
    delete buildInfo.fictWebpackMetadataV7
    stored.version = 3
    stored.filename = physicalFilename
    delete stored.identifier
    delete stored.resource
    buildInfo.fictWebpackMetadata = stored

    expect(restoreFictModuleMetadata(module)).toBeUndefined()
  })
})
