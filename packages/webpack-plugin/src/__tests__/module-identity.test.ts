import { rm } from 'node:fs/promises'
import path from 'node:path'

import type { ModuleReactiveMetadata } from '@fictjs/compiler'
import type { NormalModule, Stats } from 'webpack'

import {
  backdateFixtureInputs,
  builtFixtureFiles,
  createFixture,
  createWebpackConfiguration,
  runApp,
  runCompiler,
} from './fixture'

interface StoredModuleMetadata {
  identifier: string
  metadata: ModuleReactiveMetadata
  resource: string
}

function readStoredModules(stats: Stats, resource: string): StoredModuleMetadata[] {
  return [...stats.compilation.modules]
    .filter(candidate => (candidate as { resource?: unknown }).resource === resource)
    .map(candidate => {
      const module = candidate as NormalModule
      const stored = module.buildInfo?.fictWebpackMetadata as
        | {
            identifier?: unknown
            metadataJson?: unknown
            resource?: unknown
            version?: unknown
          }
        | undefined
      if (
        stored?.version !== 6 ||
        typeof stored.identifier !== 'string' ||
        typeof stored.metadataJson !== 'string' ||
        typeof stored.resource !== 'string'
      ) {
        throw new Error(`No current Fict metadata found for ${module.identifier()}.`)
      }
      if (stored.identifier !== module.identifier()) {
        throw new Error(`Stored identifier does not match ${module.identifier()}.`)
      }
      return {
        identifier: stored.identifier,
        metadata: JSON.parse(stored.metadataJson) as ModuleReactiveMetadata,
        resource: stored.resource,
      }
    })
    .sort((left, right) => left.identifier.localeCompare(right.identifier))
}

function readStoredBuildMetadata(stats: Stats, resource: string): Record<string, unknown> {
  const module = [...stats.compilation.modules].find(
    candidate => (candidate as { resource?: unknown }).resource === resource,
  ) as NormalModule | undefined
  const stored = module?.buildInfo?.fictWebpackMetadata
  if (!stored || typeof stored !== 'object') {
    throw new Error(`No persisted Fict metadata found for ${resource}.`)
  }
  return stored as Record<string, unknown>
}

describe('@fictjs/webpack-plugin module identity', () => {
  it('uses a CommonJS graph edge for lowered TypeScript import-equals metadata', async () => {
    const root = await createFixture({
      'entry.cts': `
        import useCounter = require('./hook')

        export function App() {
          const count = useCounter()
          return count * 2
        }
      `,
      'hook.cts': `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(2)
          return count
        }

        export = useCounter
      `,
    })

    try {
      const configuration = createWebpackConfiguration(root)
      configuration.entry = './entry.cts'
      configuration.resolve = {
        ...configuration.resolve,
        extensions: ['.cts', '.ts', '.js'],
      }

      const stats = await runCompiler(configuration)
      const entryModule = [...stats.compilation.modules].find(
        candidate =>
          (candidate as { resource?: unknown }).resource === path.join(root, 'entry.cts'),
      ) as NormalModule | undefined
      expect(
        (entryModule?.buildInfo?.fictWebpackMetadata as { metadataSources?: unknown } | undefined)
          ?.metadataSources,
      ).toEqual(['./hook'])
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps rewritten ESM TypeScript requests back to compiler metadata sources', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter } from './hook.ts'

        export function App() {
          const count = useCounter()
          return count * 2
        }
      `,
      'hook.ts': `
        import { $state } from 'fict'

        export function useCounter() {
          const count = $state(2)
          return count
        }
      `,
    })

    try {
      const entryPath = path.join(root, 'entry.ts')
      const hookPath = path.join(root, 'hook.ts')
      await backdateFixtureInputs([entryPath, hookPath])
      const configuration = () => {
        const value = createWebpackConfiguration(root, {
          cache: {
            type: 'filesystem',
            cacheDirectory: path.join(root, '.webpack-cache'),
          },
          loaderOptions: { typescriptOptions: { rewriteImportExtensions: true } },
        })
        value.resolve = {
          ...value.resolve,
          extensionAlias: { '.js': ['.ts', '.js'] },
        }
        return value
      }

      const stats = await runCompiler(configuration())
      expect(readStoredBuildMetadata(stats, entryPath)).toMatchObject({
        metadataSources: ['./hook.ts'],
        metadataRequestMappings: [['./hook.ts', './hook.js']],
      })
      expect(runApp(root)).toBe(4)

      const cachedStats = await runCompiler(configuration())
      expect(builtFixtureFiles(cachedStats, root)).toEqual([])
      expect(readStoredBuildMetadata(cachedStats, entryPath)).toMatchObject({
        metadataRequestMappings: [['./hook.ts', './hook.js']],
      })
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps rewritten CTS import-equals requests back to compiler metadata sources', async () => {
    const root = await createFixture({
      'entry.cts': `
        import useCounter = require('./hook.cts')

        export function App() {
          const count = useCounter()
          return count * 2
        }
      `,
      'hook.cts': `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(2)
          return count
        }

        export = useCounter
      `,
    })

    try {
      const configuration = createWebpackConfiguration(root, {
        loaderOptions: { typescriptOptions: { rewriteImportExtensions: true } },
      })
      configuration.entry = './entry.cts'
      configuration.resolve = {
        ...configuration.resolve,
        extensionAlias: { '.cjs': ['.cts', '.cjs'] },
        extensions: ['.cts', '.ts', '.js'],
      }

      const stats = await runCompiler(configuration)
      expect(readStoredBuildMetadata(stats, path.join(root, 'entry.cts'))).toMatchObject({
        metadataSources: ['./hook.cts'],
        metadataRequestMappings: [['./hook.cts', './hook.cjs']],
      })
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps compiler metadata resolution scoped to static ESM dependencies', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter } from './hook'

        const plain = require('./hook')

        export function App() {
          const count = useCounter()
          return count * 2 + plain.value
        }
      `,
      'hook.ts': `
        import { $state } from 'fict'

        export function useCounter() {
          const count = $state(1)
          return count
        }
      `,
      'hook.js': `
        exports.value = 40
      `,
    })

    try {
      const configuration = createWebpackConfiguration(root)
      configuration.resolve = {
        ...configuration.resolve,
        byDependency: {
          esm: { extensions: ['.ts'] },
          commonjs: { extensions: ['.js'] },
        },
      }

      await runCompiler(configuration)
      expect(runApp(root)).toBe(42)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates metadata for two loader chains targeting the same resource', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter as useSignalCounter } from './use-counter'
        import { useCounter as usePlainCounter } from './plain-loader.cjs!./use-counter'

        export function App() {
          const signalCounter = useSignalCounter()
          const plainCounter = usePlainCounter()
          return signalCounter * 2 + plainCounter
        }
      `,
      'plain-loader.cjs': `
        module.exports = function () {
          return 'export function useCounter() { return 40 }'
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
    const plainLoaderPath = path.join(root, 'plain-loader.cjs')
    const cache = {
      type: 'filesystem' as const,
      cacheDirectory: path.join(root, '.webpack-cache'),
    }
    const configuration = () => {
      const configured = createWebpackConfiguration(root, { cache })
      const rule = configured.module!.rules![0]
      if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
      rule.enforce = 'post'
      return configured
    }

    try {
      await backdateFixtureInputs([entryPath, hookPath, plainLoaderPath])
      const firstStats = await runCompiler(configuration())
      expect(runApp(root)).toBe(42)
      const firstStored = readStoredModules(firstStats, hookPath)
      expect(firstStored).toHaveLength(2)
      expect(new Set(firstStored.map(record => record.identifier)).size).toBe(2)

      const secondStats = await runCompiler(configuration())
      expect(runApp(root)).toBe(42)
      expect(builtFixtureFiles(secondStats, root)).not.toContain(hookPath)
      const secondStored = readStoredModules(secondStats, hookPath)
      expect(secondStored.map(record => record.identifier)).toEqual(
        firstStored.map(record => record.identifier),
      )
      expect(new Set(secondStored.map(record => record.resource))).toEqual(new Set([hookPath]))

      const plain = secondStored.find(record => record.identifier.includes(plainLoaderPath))
      const signal = secondStored.find(record => !record.identifier.includes(plainLoaderPath))
      expect(plain?.metadata.hooks?.useCounter?.directAccessor).toBeUndefined()
      expect(signal?.metadata.hooks?.useCounter?.directAccessor).toBe('signal')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a registered local inline-loader request opaque', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter as useSignalCounter } from './use-counter'
        import { useCounter as usePlainCounter } from './plain-loader.cjs!./use-counter'

        export function App() {
          const signalCounter = useSignalCounter()
          const plainCounter = usePlainCounter()
          return signalCounter * 2 + plainCounter
        }
      `,
      'plain-loader.cjs': `
        module.exports = function () {
          return 'export function useCounter() { return 40 }'
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
      // Normal loaders run before inline loaders. Fict therefore records signal metadata for the
      // inline module, while the later inline loader replaces its runtime export with a number.
      // The importer must keep the `!` request opaque rather than applying that metadata.
      await runCompiler(createWebpackConfiguration(root))
      expect(runApp(root)).toBe(42)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
