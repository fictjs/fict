import { readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import webpack, {
  type Compilation,
  type Compiler,
  type Configuration,
  type NormalModule,
} from 'webpack'

import {
  backdateFixtureInputs,
  buildAssetMatches,
  builtFixtureFiles,
  closeWatching,
  createBuildQueue,
  createFixture,
  createWebpackConfiguration,
  fixtureWatchOptions,
  runApp,
  runCompiler,
  waitForWatchingReady,
} from './fixture'

const entrySource = (request: string): string => `
  import { useCounter } from '${request}'
  export function App() {
    const count = useCounter()
    return count * 2
  }
`

const signalMetadata = JSON.stringify({
  version: 1,
  exports: {},
  hooks: { useCounter: { directAccessor: 'signal' } },
})

const plainMetadata = JSON.stringify({
  version: 1,
  exports: {},
  hooks: { useCounter: {} },
})

function excludeNodeModules(configuration: Configuration): Configuration {
  const rule = configuration.module?.rules?.[0]
  if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
  rule.exclude = /node_modules/
  return configuration
}

async function readBundle(root: string): Promise<string> {
  return readFile(path.join(root, 'dist', 'bundle.cjs'), 'utf8')
}

describe('@fictjs/webpack-plugin resolver package boundaries', () => {
  it('uses metadata from the package selected by a bare Webpack alias', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter } from 'public-hook'
        const { useCounter: requireCounter } = require('public-hook')
        export function App() {
          void requireCounter
          const count = useCounter()
          return count * 2
        }
      `,
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageJsonPath = path.join(root, 'node_modules', 'actual-hook', 'package.json')

    try {
      const stats = await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, {
            alias: { 'public-hook': 'actual-hook' },
          }),
        ),
      )
      expect(runApp(root)).toBe(4)
      expect(stats.compilation.fileDependencies).toContain(packageJsonPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses a contained legacy main selected by an absolute directory alias', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: 'index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': packageDir },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses configured mainFiles order for static legacy root proof', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/index.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/main.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'index.js') },
    })
    configuration.resolve!.mainFiles = ['main']
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('continues through missing main fields in effective order', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/entry.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        browser: './missing.js',
        module: './entry.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': packageDir },
    })
    configuration.resolve!.mainFields = ['browser', 'module']
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not force a bare main target relative when effective mainFields do not', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/safe.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: 'safe.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const entryPath = path.join(root, 'entry.ts')
    const forceRelativePlugin = {
      apply(compiler: Compiler): void {
        compiler.hooks.thisCompilation.tap('FictForceRelativeFixture', compilation => {
          compilation.hooks.buildModule.tap('FictForceRelativeFixture', module => {
            const normalModule = module as NormalModule
            if (normalModule.resource !== entryPath) return
            const mutableModule = normalModule as unknown as {
              resolveOptions: { mainFields: { forceRelative: boolean; name: string[] }[] }
            }
            mutableModule.resolveOptions = {
              mainFields: [{ forceRelative: false, name: ['main'] }],
            }
          })
        })
      },
    }
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'safe.js') },
      plugins: [forceRelativePlugin],
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not apply fullySpecified to legacy root entry proof', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': packageDir },
    })
    configuration.resolve!.fullySpecified = true
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses configured extension order for static legacy root proof', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/index.json': JSON.stringify({ useCounter: 2 }),
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'index.json') },
    })
    configuration.resolve!.extensions = ['.js', '.json']
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('honors enforceExtension while proving a legacy root target', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/index': 'exports.useCounter = () => 2',
      'vendor/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': packageDir },
    })
    configuration.entry = './entry'
    configuration.resolve!.enforceExtension = true
    configuration.resolve!.extensions = ['.ts', '.js']
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('appends configured extensions to legacy targets that already have a suffix', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/entry.custom.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './entry.custom',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': packageDir },
    })
    configuration.resolve!.extensions = ['.js']
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when extensionAlias changes package file resolution', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'index.js') },
    })
    configuration.resolve!.extensionAlias = { '.js': ['.js', '.ts'] }
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses root metadata from an exports-only file selected by an absolute alias', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/dist/entry.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './dist/entry.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'dist', 'entry.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves extensions for an extensionless exports target', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/entry.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: './entry',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'entry.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses extension precedence for an extensionless exports target', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/entry.ts': 'exports.useCounter = () => 2',
      'vendor/actual-hook/entry.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: './entry',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'entry.js') },
    })
    configuration.resolve!.extensions = ['.ts', '.js']
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not skip an external symlink for an extensionless exports target', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'outside-entry.js': 'exports.useCounter = () => () => 9',
      'vendor/actual-hook/entry.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: './entry',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const outsidePath = path.join(root, 'outside-entry.js')
    await symlink(outsidePath, path.join(packageDir, 'entry'))
    let observedCompilation: Compilation | undefined
    const observer = {
      apply(compiler: Compiler): void {
        compiler.hooks.thisCompilation.tap('FictExportsSymlinkObserver', compilation => {
          observedCompilation = compilation
        })
      },
    }
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'entry.js') },
      plugins: [observer],
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
      const dependencies = [
        ...(observedCompilation?.fileDependencies ?? []),
        ...(observedCompilation?.missingDependencies ?? []),
        ...(observedCompilation?.contextDependencies ?? []),
      ]
      expect(dependencies).not.toContain(outsidePath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not use an exports root for an absolute directory alias resolved through main', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/legacy.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/dist/entry.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './legacy.js',
        exports: { '.': './dist/entry.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': packageDir },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not probe an inactive main while proving an exported absolute file alias', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/dist/entry.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: '../../outside.js',
        exports: { '.': './dist/entry.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'dist', 'entry.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      const stats = await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
      const outsidePath = path.join(root, 'outside.js')
      expect(stats.compilation.fileDependencies).not.toContain(outsidePath)
      expect(stats.compilation.missingDependencies).not.toContain(outsidePath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for mixed subpath and condition export keys', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/safe.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/browser.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './safe.js', browser: './browser.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'safe.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects percent-encoded invalid segments in export targets', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/%2e%2e/hook.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './hooks': './%2e%2e/hook.js' },
        fict: { exports: { './hooks': './hooks.fict.meta.json' } },
      }),
      'vendor/actual-hook/hooks.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, '%2e%2e', 'hook.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not use exports metadata when exportsFields disables that field', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/foo.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './bar': './foo.js' },
        fict: { exports: { './bar': './bar.fict.meta.json' } },
      }),
      'vendor/actual-hook/bar.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'foo.js') },
    })
    configuration.resolve!.exportsFields = []
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not treat a custom description file as a Fict package manifest', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/fict-package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'index.js') },
    })
    configuration.resolve!.descriptionFiles = ['fict-package.json']
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not follow nested main or browser redirects while proving export targets', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter } from 'public-hook'
        const { useCounter: requireCounter } = require('public-hook')
        export function App() {
          void requireCounter
          const count = useCounter()
          return count * 2
        }
      `,
      'outside-browser.js': 'exports.useCounter = () => () => 9',
      'outside-nested.js': 'exports.useCounter = () => () => 9',
      'vendor/actual-hook/safe.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/target.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/nested/package.json': JSON.stringify({
        main: '../../../outside-nested.js',
      }),
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': { nested: './nested', default: './target.js' } },
        browser: { './target.js': '../../outside-browser.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    let observedCompilation: Compilation | undefined
    const observer = {
      apply(compiler: Compiler): void {
        compiler.hooks.thisCompilation.tap('FictExportProofObserver', compilation => {
          observedCompilation = compilation
        })
      },
    }
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'safe.js') },
      plugins: [observer],
    })
    configuration.resolve!.aliasFields = ['browser']
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
      const dependencies = [
        ...(observedCompilation?.fileDependencies ?? []),
        ...(observedCompilation?.missingDependencies ?? []),
        ...(observedCompilation?.contextDependencies ?? []),
      ]
      expect(dependencies).not.toContain(path.join(root, 'outside-browser.js'))
      expect(dependencies).not.toContain(path.join(root, 'outside-nested.js'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses subpath metadata from an exported file selected by an absolute alias', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/dist/hooks.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './hooks': './dist/hooks.js' },
        fict: { exports: { './hooks': './hooks.fict.meta.json' } },
      }),
      'vendor/actual-hook/hooks.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'dist', 'hooks.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not match a queried export target to an absolute base-file alias', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/dist/entry.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './dist/entry.js?raw' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'dist', 'entry.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('proves metadata for an absolute alias to a legacy package deep entry', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/hooks.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        fict: { exports: { './hooks': './hooks.fict.meta.json' } },
      }),
      'vendor/actual-hook/hooks.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'hooks.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when legacy extension spellings publish different metadata', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/hooks.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        fict: {
          exports: {
            './hooks': './hooks.fict.meta.json',
            './hooks.js': './hooks-js.fict.meta.json',
          },
        },
      }),
      'vendor/actual-hook/hooks.fict.meta.json': signalMetadata,
      'vendor/actual-hook/hooks-js.fict.meta.json': plainMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'hooks.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (./hooks, ./hooks.js)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not skip a package-external symlink before an extension candidate', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'outside-hooks.js': 'exports.useCounter = () => () => 9',
      'vendor/actual-hook/hooks.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        fict: { exports: { './hooks': './hooks.fict.meta.json' } },
      }),
      'vendor/actual-hook/hooks.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const outsidePath = path.join(root, 'outside-hooks.js')
    await symlink(outsidePath, path.join(packageDir, 'hooks'))
    let observedCompilation: Compilation | undefined
    const observer = {
      apply(compiler: Compiler): void {
        compiler.hooks.thisCompilation.tap('FictExtensionProofObserver', compilation => {
          observedCompilation = compilation
        })
      },
    }
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'hooks.js') },
      plugins: [observer],
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
      const dependencies = [
        ...(observedCompilation?.fileDependencies ?? []),
        ...(observedCompilation?.missingDependencies ?? []),
        ...(observedCompilation?.contextDependencies ?? []),
      ]
      expect(dependencies).not.toContain(outsidePath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not strip an unconfigured legacy resource extension', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/hooks.custom': 'exports.useCounter = () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        fict: { exports: { './hooks': './hooks.fict.meta.json' } },
      }),
      'vendor/actual-hook/hooks.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'hooks.custom') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses metadata from an npm alias whose manifest has a different name', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/public-hook/dist/entry.js': 'exports.useCounter = () => () => 2',
      'node_modules/public-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './dist/entry.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/public-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses exported subpath metadata from an npm alias with a different manifest name', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook/hooks'),
      'node_modules/public-hook/dist/hooks.js': 'exports.useCounter = () => () => 2',
      'node_modules/public-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './hooks': './dist/hooks.js' },
        fict: { exports: { './hooks': './hooks.fict.meta.json' } },
      }),
      'node_modules/public-hook/hooks.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats an absolute standalone alias without a package boundary as unresolved', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'standalone-hook.js': 'exports.useCounter = () => () => 2',
    })
    const standalonePath = path.join(root, 'standalone-hook.js')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': standalonePath },
      loaderOptions: { strictGuarantee: true },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = standalonePath

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not read shadow package metadata for a Webpack external', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'external-hook.cjs': 'exports.useCounter = () => 2',
      'node_modules/public-hook/index.js': 'exports.useCounter = () => () => 9',
      'node_modules/public-hook/package.json': JSON.stringify({
        name: 'public-hook',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/public-hook/index.fict.meta.json': signalMetadata,
    })
    const externalPath = path.join(root, 'external-hook.cjs')

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, {
              externals: { 'public-hook': `commonjs ${externalPath}` },
            }),
          ),
        ),
      ).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses metadata from the runtime package named by a CommonJS external', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/public-hook/index.js': 'exports.useCounter = () => 2',
      'node_modules/public-hook/package.json': JSON.stringify({
        name: 'public-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/public-hook/index.fict.meta.json': plainMetadata,
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, {
            externals: { 'public-hook': 'commonjs actual-hook' },
          }),
        ),
      )
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses plain metadata from the runtime package instead of reactive shadow metadata', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/public-hook/index.js': 'exports.useCounter = () => () => 9',
      'node_modules/public-hook/package.json': JSON.stringify({
        name: 'public-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/public-hook/index.fict.meta.json': signalMetadata,
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': plainMetadata,
    })

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, {
            externals: { 'public-hook': 'commonjs actual-hook' },
          }),
        ),
      )
      expect(runApp(root)).toBe(4)
      expect(await readBundle(root)).not.toMatch(/count\(\)\s*\*\s*2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves a CommonJS external from the output location instead of an importer shadow', async () => {
    const root = await createFixture({
      'src/entry.ts': entrySource('public-hook'),
      'src/node_modules/actual-hook/index.js': 'exports.useCounter = () => 2',
      'src/node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'src/node_modules/actual-hook/index.fict.meta.json': plainMetadata,
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'commonjs actual-hook' },
      }),
    )
    configuration.entry = './src/entry.ts'

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not apply Webpack aliases to an external runtime package request', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
      'node_modules/shadow-hook/index.js': 'exports.useCounter = () => 2',
      'node_modules/shadow-hook/package.json': JSON.stringify({
        name: 'shadow-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/shadow-hook/index.fict.meta.json': plainMetadata,
    })

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, {
            alias: { 'actual-hook': 'shadow-hook' },
            externals: { 'public-hook': 'commonjs actual-hook' },
          }),
        ),
      )
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses subpath metadata from a CommonJS external runtime request', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/hooks.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './hooks': './hooks.js' },
        fict: { exports: { './hooks': './hooks.fict.meta.json' } },
      }),
      'node_modules/actual-hook/hooks.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, {
            externals: { 'public-hook': 'commonjs actual-hook/hooks' },
          }),
        ),
      )
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not use metadata from a private package nested behind an external export', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/nested/index.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './nested/index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': plainMetadata,
      'node_modules/actual-hook/nested/package.json': JSON.stringify({
        name: 'actual-hook-private',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/nested/index.fict.meta.json': signalMetadata,
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, {
              externals: { 'public-hook': 'commonjs actual-hook' },
            }),
          ),
        ),
      ).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['public-hook?raw', 'inline-loader!public-hook'])(
    'ignores the lexical request %s when a CommonJS external names another package',
    async publicRequest => {
      const root = await createFixture({
        'entry.ts': entrySource(publicRequest),
        'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
        'node_modules/actual-hook/package.json': JSON.stringify({
          name: 'actual-hook',
          version: '1.0.0',
          exports: { '.': './index.js' },
          fict: { metadata: './index.fict.meta.json' },
        }),
        'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
      })

      try {
        await runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, {
              externals: { [publicRequest]: 'commonjs actual-hook' },
            }),
          ),
        )
        expect(runApp(root)).toBe(4)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('does not let Webpack resolve.modules redirect an external runtime package', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'custom_modules/actual-hook/index.js': 'exports.useCounter = () => () => 9',
      'custom_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'custom_modules/actual-hook/index.fict.meta.json': signalMetadata,
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': plainMetadata,
    })
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'commonjs actual-hook' },
      }),
    )
    configuration.resolve!.modules = [path.join(root, 'custom_modules'), 'node_modules']

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
      expect(await readBundle(root)).not.toMatch(/count\(\)\s*\*\s*2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses Node main resolution instead of custom Webpack mainFields for externals', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/main.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/custom.js': 'exports.useCounter = () => () => 9',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './main.js',
        customMain: './custom.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': plainMetadata,
    })
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'commonjs actual-hook' },
      }),
    )
    configuration.resolve!.mainFields = ['customMain', 'main']
    const mainPath = path.join(root, 'node_modules', 'actual-hook', 'main.js')
    const customPath = path.join(root, 'node_modules', 'actual-hook', 'custom.js')

    try {
      const stats = await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
      expect(stats.compilation.fileDependencies).toContain(mainPath)
      expect(stats.compilation.fileDependencies).not.toContain(customPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an ESM external authoritative for a web host', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.mjs': 'export const useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.mjs' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packagePath = path.join(root, 'node_modules', 'actual-hook', 'package.json')
    let observedCompilation: Compilation | undefined
    const observer = {
      apply(compiler: Compiler): void {
        compiler.hooks.thisCompilation.tap('FictWebExternalObserver', compilation => {
          observedCompilation = compilation
        })
      },
    }
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'module actual-hook' },
        plugins: [observer],
      }),
    )
    configuration.experiments = { outputModule: true }
    configuration.output!.library = { type: 'module' }
    configuration.output!.module = true
    configuration.target = 'web'

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
      const dependencies = [
        ...(observedCompilation?.fileDependencies ?? []),
        ...(observedCompilation?.missingDependencies ?? []),
        ...(observedCompilation?.contextDependencies ?? []),
      ]
      expect(dependencies).not.toContain(packagePath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['web', 'electron-main'] as const)(
    'does not infer Node require semantics for a %s CommonJS external host',
    async target => {
      const root = await createFixture({
        'entry.ts': entrySource('public-hook'),
        'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
        'node_modules/actual-hook/package.json': JSON.stringify({
          name: 'actual-hook',
          version: '1.0.0',
          exports: { '.': './index.js' },
          fict: { metadata: './index.fict.meta.json' },
        }),
        'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
      })
      const configuration = excludeNodeModules(
        createWebpackConfiguration(root, {
          externals: { 'public-hook': 'commonjs actual-hook' },
        }),
      )
      configuration.target = target

      try {
        await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.each([
    ['a nested output filename', { filename: 'chunks/bundle.cjs' }],
    ['a templated output filename', { filename: '[name].cjs' }],
    ['a non-CommonJS output filename', { filename: 'bundle.js' }],
    ['an ESM chunk format', { chunkFormat: 'module' }],
  ] as const)('fails closed for %s before using external metadata', async (_label, output) => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
      'dist/chunks/node_modules/actual-hook/index.js': 'exports.useCounter = () => 2',
      'dist/chunks/node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '2.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'dist/chunks/node_modules/actual-hook/index.fict.meta.json': plainMetadata,
    })
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'commonjs actual-hook' },
      }),
    )
    Object.assign(configuration.output!, output)

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for node-commonjs in an ESM output asset', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'node-commonjs actual-hook' },
      }),
    )
    configuration.experiments = { outputModule: true }
    configuration.output!.module = true

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when output.clean would delete the external package resolved at build time', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': plainMetadata,
      'dist/node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 9',
      'dist/node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '2.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'dist/node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'commonjs actual-hook' },
      }),
    )
    configuration.output!.clean = true

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for a nested entry filename override', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'commonjs actual-hook' },
      }),
    )
    configuration.entry = {
      main: { filename: 'chunks/bundle.cjs', import: './entry.ts' },
    }

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed before probing through a symlinked output path', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'logical/node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 9',
      'logical/node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'logical/node_modules/actual-hook/index.fict.meta.json': signalMetadata,
      'physical/node_modules/actual-hook/index.js': 'exports.useCounter = () => 2',
      'physical/node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '2.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'physical/node_modules/actual-hook/index.fict.meta.json': plainMetadata,
      'physical/dist/.keep': '',
    })
    const logicalPackagePath = path.join(
      root,
      'logical',
      'node_modules',
      'actual-hook',
      'package.json',
    )
    const physicalPackagePath = path.join(
      root,
      'physical',
      'node_modules',
      'actual-hook',
      'package.json',
    )
    const outputPath = path.join(root, 'logical', 'dist-link')
    await symlink(
      path.join(root, 'physical', 'dist'),
      outputPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    let observedCompilation: Compilation | undefined
    const observer = {
      apply(compiler: Compiler): void {
        compiler.hooks.thisCompilation.tap('FictSymlinkedOutputObserver', compilation => {
          observedCompilation = compilation
        })
      },
    }
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'commonjs actual-hook' },
        plugins: [observer],
      }),
    )
    configuration.output!.path = outputPath

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
      const dependencies = [
        ...(observedCompilation?.fileDependencies ?? []),
        ...(observedCompilation?.missingDependencies ?? []),
        ...(observedCompilation?.contextDependencies ?? []),
      ]
      expect(dependencies).not.toContain(logicalPackagePath)
      expect(dependencies).not.toContain(physicalPackagePath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when an existing output-path ancestor is symlinked', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 9',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
      'physical-parent/node_modules/actual-hook/index.js': 'exports.useCounter = () => 2',
      'physical-parent/node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '2.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'physical-parent/node_modules/actual-hook/index.fict.meta.json': plainMetadata,
      'physical-parent/output-root/dist/.keep': '',
    })
    const logicalOutputRoot = path.join(root, 'logical-output')
    await symlink(
      path.join(root, 'physical-parent', 'output-root'),
      logicalOutputRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, {
        externals: { 'public-hook': 'commonjs actual-hook' },
      }),
    )
    configuration.output!.path = path.join(logicalOutputRoot, 'dist')

    try {
      await expect(runCompiler(configuration)).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['global external', 'var actual-hook'],
    ['array/property external', ['commonjs actual-hook', 'useCounter'] as string[]],
    ['non-canonical module request', 'commonjs ../actual-hook'],
    ['queried module request', 'commonjs actual-hook?raw'],
    ['fragmented module request', 'commonjs actual-hook#fragment'],
  ] as const)(
    'keeps an unsupported %s authoritative and does not probe it',
    async (_label, target) => {
      const root = await createFixture({
        'entry.ts': entrySource('public-hook'),
        'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
        'node_modules/actual-hook/package.json': JSON.stringify({
          name: 'actual-hook',
          version: '1.0.0',
          exports: { '.': './index.js' },
          fict: { metadata: './index.fict.meta.json' },
        }),
        'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
      })
      const packagePath = path.join(root, 'node_modules', 'actual-hook', 'package.json')
      let observedCompilation: Compilation | undefined
      const observer = {
        apply(compiler: Compiler): void {
          compiler.hooks.thisCompilation.tap('FictExternalProbeObserver', compilation => {
            observedCompilation = compilation
          })
        },
      }

      try {
        await expect(
          runCompiler(
            excludeNodeModules(
              createWebpackConfiguration(root, {
                externals: { 'public-hook': target },
                plugins: [observer],
              }),
            ),
          ),
        ).rejects.toThrow('FICT-H003')
        const dependencies = [
          ...(observedCompilation?.fileDependencies ?? []),
          ...(observedCompilation?.missingDependencies ?? []),
          ...(observedCompilation?.contextDependencies ?? []),
        ]
        expect(dependencies).not.toContain(packagePath)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('does not treat a Node builtin external as an installed package', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/fs/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/fs/package.json': JSON.stringify({
        name: 'fs',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/fs/index.fict.meta.json': signalMetadata,
    })
    const packagePath = path.join(root, 'node_modules', 'fs', 'package.json')
    let observedCompilation: Compilation | undefined
    const observer = {
      apply(compiler: Compiler): void {
        compiler.hooks.thisCompilation.tap('FictBuiltinExternalObserver', compilation => {
          observedCompilation = compilation
        })
      },
    }

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, {
              externals: { 'public-hook': 'commonjs fs' },
              plugins: [observer],
            }),
          ),
        ),
      ).rejects.toThrow('FICT-H003')
      const dependencies = [
        ...(observedCompilation?.fileDependencies ?? []),
        ...(observedCompilation?.missingDependencies ?? []),
        ...(observedCompilation?.contextDependencies ?? []),
      ]
      expect(dependencies).not.toContain(packagePath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('watches metadata from the runtime package named by an external', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const entryPath = path.join(root, 'entry.ts')
    const packagePath = path.join(root, 'node_modules', 'actual-hook', 'package.json')
    const sidecarPath = path.join(root, 'node_modules', 'actual-hook', 'index.fict.meta.json')
    const compiler = webpack(
      excludeNodeModules(
        createWebpackConfiguration(root, {
          externals: { 'public-hook': 'commonjs actual-hook' },
        }),
      ),
    )
    const builds = createBuildQueue()
    const firstBuild = builds.next()
    const watching = compiler.watch(fixtureWatchOptions, (error, stats) => {
      builds.push(error, stats)
    })!

    try {
      const firstStats = await firstBuild
      expect(await readBundle(root)).toMatch(/count\(\)\s*\*\s*2/)
      expect(firstStats.compilation.fileDependencies).toContain(packagePath)
      expect(firstStats.compilation.fileDependencies).toContain(sidecarPath)
      await waitForWatchingReady(watching)

      const plainBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /return count\s*\*\s*2/),
        { description: 'the plain external-package bundle' },
      )
      await writeFile(sidecarPath, plainMetadata)
      const plainStats = await plainBuild
      const plainBundle = await readBundle(root)
      expect(plainBundle).toMatch(/return count\s*\*\s*2/)
      expect(plainBundle).not.toMatch(/count\(\)\s*\*\s*2/)
      expect(builtFixtureFiles(plainStats, root)).toContain(entryPath)
    } finally {
      await closeWatching(watching, compiler)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('invalidates a cached importer when an external type or target changes', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/.keep': '',
      'packages/shared-hook/index.js': 'exports.useCounter = () => () => 2',
      'packages/shared-hook/package.json': JSON.stringify({
        name: 'shared-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'packages/shared-hook/index.fict.meta.json': signalMetadata,
    })
    const entryPath = path.join(root, 'entry.ts')
    const realPackage = path.join(root, 'packages', 'shared-hook')
    await Promise.all(
      ['actual-a', 'actual-b'].map(name =>
        symlink(
          realPackage,
          path.join(root, 'node_modules', name),
          process.platform === 'win32' ? 'junction' : 'dir',
        ),
      ),
    )
    const cache = {
      type: 'filesystem' as const,
      cacheDirectory: path.join(root, '.webpack-cache'),
    }
    const configuration = (external: string): Configuration => {
      const result = createWebpackConfiguration(root, {
        cache,
        externals: { 'public-hook': external },
      })
      const rule = result.module?.rules?.[0]
      if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
      rule.exclude = (resource: string) =>
        resource.includes(`${path.sep}node_modules${path.sep}`) ||
        resource === realPackage ||
        resource.startsWith(`${realPackage}${path.sep}`)
      return result
    }
    const fingerprint = (stats: Compilation): unknown => {
      const entryModule = [...stats.modules].find(
        module => (module as { resource?: unknown }).resource === entryPath,
      ) as { buildInfo?: Record<string, unknown> } | undefined
      return (
        entryModule?.buildInfo?.fictWebpackMetadataV7 as
          | { dependencyFingerprint?: unknown }
          | undefined
      )?.dependencyFingerprint
    }

    try {
      await backdateFixtureInputs([
        entryPath,
        path.join(realPackage, 'index.js'),
        path.join(realPackage, 'package.json'),
        path.join(realPackage, 'index.fict.meta.json'),
      ])
      const firstStats = await runCompiler(configuration('commonjs actual-a'))
      const firstFingerprint = fingerprint(firstStats.compilation)
      expect(typeof firstFingerprint).toBe('string')

      const cachedStats = await runCompiler(configuration('commonjs actual-a'))
      expect(builtFixtureFiles(cachedStats, root)).toEqual([])

      const typeStats = await runCompiler(configuration('commonjs2 actual-a'))
      const typeFingerprint = fingerprint(typeStats.compilation)
      expect(typeFingerprint).not.toBe(firstFingerprint)
      expect(builtFixtureFiles(typeStats, root)).toContain(entryPath)

      const targetStats = await runCompiler(configuration('commonjs actual-b'))
      expect(fingerprint(targetStats.compilation)).not.toBe(typeFingerprint)
      expect(builtFixtureFiles(targetStats, root)).toContain(entryPath)

      const recachedStats = await runCompiler(configuration('commonjs actual-b'))
      expect(builtFixtureFiles(recachedStats, root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a package manifest without a valid name as unresolved', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('bad-hook'),
      'node_modules/bad-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/bad-hook/package.json': JSON.stringify({
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/bad-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, { loaderOptions: { strictGuarantee: true } }),
          ),
        ),
      ).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not probe a malicious manifest name behind an absolute alias', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/dist/entry.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: '../../outside-hook',
        version: '1.0.0',
        exports: { '.': './dist/entry.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'dist', 'entry.js') },
      loaderOptions: { strictGuarantee: false },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      const stats = await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
      const outsideProbe = path.resolve(root, '../../outside-hook')
      expect(
        [...stats.compilation.fileDependencies].some(dependency =>
          dependency.startsWith(outsideProbe),
        ),
      ).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('watches metadata from the package selected by an alias', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const entryPath = path.join(root, 'entry.ts')
    const packagePath = path.join(root, 'node_modules', 'actual-hook', 'package.json')
    const sidecarPath = path.join(root, 'node_modules', 'actual-hook', 'index.fict.meta.json')
    const compiler = webpack(
      excludeNodeModules(
        createWebpackConfiguration(root, { alias: { 'public-hook': 'actual-hook' } }),
      ),
    )
    const builds = createBuildQueue()
    const firstBuild = builds.next()
    const watching = compiler.watch(fixtureWatchOptions, (error, stats) => {
      builds.push(error, stats)
    })!

    try {
      const firstStats = await firstBuild
      expect(await readBundle(root)).toMatch(/count\(\)\s*\*\s*2/)
      expect(firstStats.compilation.fileDependencies).toContain(packagePath)
      expect(firstStats.compilation.fileDependencies).toContain(sidecarPath)
      await waitForWatchingReady(watching)

      const plainBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /return count\s*\*\s*2/),
        { description: 'the plain aliased-package bundle' },
      )
      await writeFile(sidecarPath, plainMetadata)
      const plainStats = await plainBuild
      const plainBundle = await readBundle(root)
      expect(plainBundle).toMatch(/return count\s*\*\s*2/)
      expect(plainBundle).not.toMatch(/count\(\)\s*\*\s*2/)
      expect(builtFixtureFiles(plainStats, root)).toContain(entryPath)
      await waitForWatchingReady(watching)

      const signalBuild = builds.nextMatching(
        stats => buildAssetMatches(stats, /count\(\)\s*\*\s*2/),
        { description: 'the signal aliased-package bundle' },
      )
      await writeFile(sidecarPath, signalMetadata)
      const signalStats = await signalBuild
      expect(await readBundle(root)).toMatch(/count\(\)\s*\*\s*2/)
      expect(builtFixtureFiles(signalStats, root)).toContain(entryPath)
    } finally {
      await closeWatching(watching, compiler)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('invalidates a cached aliased importer from package metadata content', async () => {
    const paddedPlainMetadata = plainMetadata.padEnd(signalMetadata.length, ' ')
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const entryPath = path.join(root, 'entry.ts')
    const sidecarPath = path.join(root, 'node_modules', 'actual-hook', 'index.fict.meta.json')
    const cache = {
      type: 'filesystem' as const,
      cacheDirectory: path.join(root, '.webpack-cache'),
    }
    const configuration = () =>
      excludeNodeModules(
        createWebpackConfiguration(root, {
          alias: { 'public-hook': 'actual-hook' },
          cache,
        }),
      )

    try {
      expect(Buffer.byteLength(paddedPlainMetadata)).toBe(Buffer.byteLength(signalMetadata))
      await backdateFixtureInputs([
        entryPath,
        path.join(root, 'node_modules', 'actual-hook', 'index.js'),
        path.join(root, 'node_modules', 'actual-hook', 'package.json'),
        sidecarPath,
      ])

      await runCompiler(configuration())
      expect(await readBundle(root)).toMatch(/count\(\)\s*\*\s*2/)
      const cachedStats = await runCompiler(configuration())
      expect(builtFixtureFiles(cachedStats, root)).toEqual([])

      const originalStat = await stat(sidecarPath)
      await writeFile(sidecarPath, paddedPlainMetadata)
      await utimes(sidecarPath, originalStat.atime, originalStat.mtime)

      const changedStats = await runCompiler(configuration())
      const changedBundle = await readBundle(root)
      expect(changedBundle).toMatch(/return count\s*\*\s*2/)
      expect(changedBundle).not.toMatch(/count\(\)\s*\*\s*2/)
      expect(builtFixtureFiles(changedStats, root)).toContain(entryPath)

      const recachedStats = await runCompiler(configuration())
      expect(builtFixtureFiles(recachedStats, root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when a persistent cache retains a stale package runtime entry', async () => {
    const signalManifest = JSON.stringify({
      name: 'actual-hook',
      version: '1.0.0',
      exports: { '.': { import: './signal.js', require: './signal.js' } },
      fict: { metadata: './signal.fict.meta.json' },
    })
    const plainManifest = JSON.stringify({
      name: 'actual-hook',
      version: '1.0.0',
      exports: { '.': { import: './plain_.js', require: './signal.js' } },
      fict: { metadata: './plain_.fict.meta.json' },
    })
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook'),
      'node_modules/actual-hook/signal.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/plain_.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': signalManifest,
      'node_modules/actual-hook/signal.fict.meta.json': signalMetadata,
      'node_modules/actual-hook/plain_.fict.meta.json': plainMetadata,
    })
    const packageJsonPath = path.join(root, 'node_modules', 'actual-hook', 'package.json')
    const cache = {
      type: 'filesystem' as const,
      cacheDirectory: path.join(root, '.webpack-cache'),
    }
    const configuration = () => excludeNodeModules(createWebpackConfiguration(root, { cache }))

    try {
      expect(Buffer.byteLength(signalManifest)).toBe(Buffer.byteLength(plainManifest))
      await backdateFixtureInputs([
        path.join(root, 'entry.ts'),
        packageJsonPath,
        path.join(root, 'node_modules', 'actual-hook', 'signal.js'),
        path.join(root, 'node_modules', 'actual-hook', 'plain_.js'),
        path.join(root, 'node_modules', 'actual-hook', 'signal.fict.meta.json'),
        path.join(root, 'node_modules', 'actual-hook', 'plain_.fict.meta.json'),
      ])

      await runCompiler(configuration())
      expect(runApp(root)).toBe(4)
      expect(builtFixtureFiles(await runCompiler(configuration()), root)).toEqual([])

      const originalStat = await stat(packageJsonPath)
      await writeFile(packageJsonPath, plainManifest)
      await utimes(packageJsonPath, originalStat.atime, originalStat.mtime)
      await expect(runCompiler(configuration())).rejects.toThrow(
        /package boundary changed|could not be matched/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps ordinary non-aliased package metadata working', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 1',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the static ESM package boundary when CommonJS shares the request', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter } from 'dual-hook'
        const { useCounter: requireCounter } = require('dual-hook')
        export function App() {
          const count = useCounter()
          const required = requireCounter()
          return count * 2 + required()
        }
      `,
      'node_modules/dual-hook/esm.mjs': 'export const useCounter = () => () => 2',
      'node_modules/dual-hook/cjs.cjs': 'exports.useCounter = () => () => 2',
      'node_modules/dual-hook/package.json': JSON.stringify({
        name: 'dual-hook',
        version: '1.0.0',
        exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/dual-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(6)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the static ESM target when CommonJS resolves the same request elsewhere', async () => {
    const root = await createFixture({
      'package.json': JSON.stringify({
        name: 'fixture',
        private: true,
        imports: { '#hook': { import: './local.ts', require: 'hook-lib' } },
      }),
      'entry.ts': `
        import { useCounter } from '#hook'
        const required = require('#hook')
        export function App() {
          const count = useCounter()
          return count * 2 + required.useCounter()
        }
      `,
      'local.ts': `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(1)
          return count
        }
      `,
      'node_modules/hook-lib/index.js': 'exports.useCounter = () => 2',
      'node_modules/hook-lib/package.json': JSON.stringify({
        name: 'hook-lib',
        version: '1.0.0',
        main: './index.js',
      }),
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses aliased local hook metadata through an opaque package star export', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter as useAliasedCounter } from './hook'
        export function App() {
          const count = useAliasedCounter()
          return count * 2
        }
      `,
      'hook.ts': `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(2)
          return count
        }
        export * from 'ordinary-utility-package'
      `,
      'node_modules/ordinary-utility-package/index.js': 'exports.utility = 1',
      'node_modules/ordinary-utility-package/package.json': JSON.stringify({
        name: 'ordinary-utility-package',
        version: '1.0.0',
        main: './index.js',
      }),
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores partial incomplete local hook metadata from filesystem cache', async () => {
    const root = await createFixture({
      'entry.ts': `
        import './hook'
        export function App() { return 0 }
      `,
      'hook.ts': `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(2)
          return count
        }
        export * from 'ordinary-utility-package'
      `,
      'node_modules/ordinary-utility-package/index.js': 'exports.utility = 1',
      'node_modules/ordinary-utility-package/package.json': JSON.stringify({
        name: 'ordinary-utility-package',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './missing.fict.meta.json' },
      }),
    })
    const entryPath = path.join(root, 'entry.ts')
    const hookPath = path.join(root, 'hook.ts')
    let builtBeforeFict: string[] = []
    const observer = {
      apply(compiler: Compiler): void {
        compiler.hooks.finishMake.tap(
          { name: 'FictIncompleteCacheObserver', stage: Number.MAX_SAFE_INTEGER - 1 },
          compilation => {
            builtBeforeFict = [...compilation.modules]
              .filter(module => compilation.builtModules.has(module))
              .map(module => (module as { resource?: unknown }).resource)
              .filter((resource): resource is string => typeof resource === 'string')
          },
        )
      },
    }
    const cache = {
      type: 'filesystem' as const,
      cacheDirectory: path.join(root, '.webpack-cache'),
    }
    const configuration = () =>
      excludeNodeModules(createWebpackConfiguration(root, { cache, plugins: [observer] }))

    try {
      await backdateFixtureInputs([
        entryPath,
        hookPath,
        path.join(root, 'node_modules', 'ordinary-utility-package', 'index.js'),
        path.join(root, 'node_modules', 'ordinary-utility-package', 'package.json'),
      ])
      const firstStats = await runCompiler(configuration())
      const hookModule = [...firstStats.compilation.modules].find(
        module => (module as { resource?: unknown }).resource === hookPath,
      ) as { buildInfo?: Record<string, unknown> } | undefined
      expect(hookModule?.buildInfo?.fictWebpackMetadataV7).toMatchObject({
        version: 7,
        incomplete: true,
      })

      await writeFile(
        entryPath,
        `
          import { useCounter as useAliasedCounter } from './hook'
          export function App() {
            const count = useAliasedCounter()
            return count * 2
          }
        `,
      )
      await runCompiler(configuration())
      expect(runApp(root)).toBe(4)
      expect(builtBeforeFict).toContain(entryPath)
      expect(builtBeforeFict).not.toContain(hookPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks shadow metadata when an alias selects a package with no metadata', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index.js',
      }),
      'node_modules/public-hook/index.js': 'exports.useCounter = () => () => 9',
      'node_modules/public-hook/package.json': JSON.stringify({
        name: 'public-hook',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/public-hook/index.fict.meta.json': signalMetadata,
    })
    const packageJsonPath = path.join(root, 'node_modules', 'actual-hook', 'package.json')

    try {
      const stats = await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, {
            alias: { 'public-hook': 'actual-hook' },
            loaderOptions: { strictGuarantee: false },
          }),
        ),
      )
      expect(runApp(root)).toBe(4)
      expect(stats.compilation.fileDependencies).toContain(packageJsonPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails strict builds when a declared package sidecar is missing', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './missing.fict.meta.json' },
      }),
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, { loaderOptions: { strictGuarantee: true } }),
          ),
        ),
      ).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails strict builds without deleting an existing importer metadata sidecar', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook'),
      'entry.ts.fict.meta.json': plainMetadata,
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './missing.fict.meta.json' },
      }),
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, { loaderOptions: { strictGuarantee: true } }),
          ),
        ),
      ).rejects.toThrow('FICT-H003')
      expect(await readFile(path.join(root, 'entry.ts.fict.meta.json'), 'utf8')).toBe(plainMetadata)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['non-string root metadata', { metadata: 5, exports: { './dummy': './dummy.meta.json' } }],
    ['empty canonical metadata entry', { exports: { '.': '' } }],
    ['invalid-only metadata key', { exports: { '../escape': './escape.meta.json' } }],
  ])('fails strict builds for %s config', async (_label, fictConfig) => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index.js',
        fict: fictConfig,
      }),
    })

    try {
      await expect(
        runCompiler(excludeNodeModules(createWebpackConfiguration(root))),
      ).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows a proven direct package subpath that does not publish metadata', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook/plain'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/plain.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js', './plain': './plain.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses an aliased package subpath only when its public entry is uniquely proven', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => 1',
      'node_modules/actual-hook/hooks.js': 'exports.useCounter = () => () => 1',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js', './hooks': './hooks.js' },
        fict: {
          metadata: './index.fict.meta.json',
          exports: { './hooks': './hooks.fict.meta.json' },
        },
      }),
      'node_modules/actual-hook/index.fict.meta.json': JSON.stringify({
        version: 1,
        exports: {},
        hooks: { useCounter: {} },
      }),
      'node_modules/actual-hook/hooks.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, { alias: { 'public-hook': 'actual-hook/hooks' } }),
        ),
      )
      expect(runApp(root)).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an aliased runtime subpath plain when it publishes no Fict metadata', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 9',
      'node_modules/actual-hook/plain.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js', './plain': './plain.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, { alias: { 'public-hook': 'actual-hook/plain' } }),
        ),
      )
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('proves an aliased plain subpath exposed through runtime wildcard exports', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 9',
      'node_modules/actual-hook/plain.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js', './*': './*.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, { alias: { 'public-hook': 'actual-hook/plain' } }),
        ),
      )
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for an aliased unlisted legacy deep import', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 9',
      'node_modules/actual-hook/plain.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, { alias: { 'public-hook': 'actual-hook/plain' } }),
          ),
        ),
      ).rejects.toThrow('could not be matched to one public entry (none)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not probe legacy root main fields for an absolute safe-file alias', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'outside-browser.js': 'exports.useCounter = () => () => 9',
      'outside-custom.js': 'exports.useCounter = () => () => 9',
      'outside-main.js': 'exports.useCounter = () => () => 9',
      'vendor/actual-hook/safe.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: '../../outside-main.js',
        browser: '../../outside-browser.js',
        customMain: '../../outside-custom.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'vendor/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    let observedCompilation: Compilation | undefined
    const observer = {
      apply(compiler: Compiler): void {
        compiler.hooks.thisCompilation.tap('FictLegacyRootObserver', compilation => {
          observedCompilation = compilation
        })
      },
    }
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'safe.js') },
      plugins: [observer],
    })
    configuration.resolve!.mainFields = ['customMain', 'browser', 'main']
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (none)',
      )
      const dependencies = [
        ...(observedCompilation?.fileDependencies ?? []),
        ...(observedCompilation?.missingDependencies ?? []),
        ...(observedCompilation?.contextDependencies ?? []),
      ]
      for (const outside of ['outside-main.js', 'outside-browser.js', 'outside-custom.js']) {
        expect(dependencies).not.toContain(path.join(root, outside))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not probe a package-external symlink for legacy metadata proof', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'outside-leak.js': 'exports.useCounter = () => () => 9',
      'vendor/actual-hook/safe.js': 'exports.useCounter = () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './safe.js',
        fict: { exports: { './leak': './leak.fict.meta.json' } },
      }),
      'vendor/actual-hook/leak.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    const outsidePath = path.join(root, 'outside-leak.js')
    await symlink(outsidePath, path.join(packageDir, 'leak'))
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'safe.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      const stats = await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
      const dependencies = [
        ...stats.compilation.fileDependencies,
        ...stats.compilation.missingDependencies,
        ...stats.compilation.contextDependencies,
      ]
      expect(dependencies).not.toContain(outsidePath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when a contained legacy symlink aliases two metadata entries', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'vendor/actual-hook/safe.js': 'exports.useCounter = () => () => 2',
      'vendor/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './safe.js',
        fict: {
          metadata: './index.fict.meta.json',
          exports: { './alias.js': './alias.fict.meta.json' },
        },
      }),
      'vendor/actual-hook/index.fict.meta.json': plainMetadata,
      'vendor/actual-hook/alias.fict.meta.json': signalMetadata,
    })
    const packageDir = path.join(root, 'vendor', 'actual-hook')
    await symlink(path.join(packageDir, 'safe.js'), path.join(packageDir, 'alias.js'))
    const configuration = createWebpackConfiguration(root, {
      alias: { 'public-hook': path.join(packageDir, 'safe.js') },
    })
    const rule = configuration.module?.rules?.[0]
    if (!rule || typeof rule !== 'object') throw new Error('Fixture loader rule is missing.')
    rule.exclude = packageDir

    try {
      await expect(runCompiler(configuration)).rejects.toThrow(
        'could not be matched to one public entry (., ./alias.js)',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('verifies a same-name alias instead of trusting the original package subpath', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => 1',
      'node_modules/actual-hook/hooks.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js', './hooks': './hooks.js' },
        fict: {
          metadata: './index.fict.meta.json',
          exports: { './hooks': './hooks.fict.meta.json' },
        },
      }),
      'node_modules/actual-hook/index.fict.meta.json': JSON.stringify({
        version: 1,
        exports: {},
        hooks: { useCounter: {} },
      }),
      'node_modules/actual-hook/hooks.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, { alias: { 'actual-hook': 'actual-hook/hooks' } }),
        ),
      )
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps resource queries opaque instead of applying package metadata', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook?raw'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a query introduced by an alias opaque', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'raw-loader.cjs': `
        module.exports = function () {
          return 'exports.useCounter = () => 2'
        }
      `,
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const configuration = excludeNodeModules(
      createWebpackConfiguration(root, { alias: { 'public-hook': 'actual-hook?raw' } }),
    )
    configuration.module!.rules!.push({
      resourceQuery: /raw/,
      use: [path.join(root, 'raw-loader.cjs')],
    })

    try {
      await runCompiler(configuration)
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses base package metadata for a fragment introduced by an alias', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const packageEntry = path.join(root, 'node_modules', 'actual-hook', 'index.js')

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, {
            alias: { 'public-hook': `${packageEntry}#fragment` },
          }),
        ),
      )
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps inline-loader requests opaque', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('plain-loader!actual-hook'),
      'node_modules/plain-loader/index.js': `
        module.exports = function () {
          return 'exports.useCounter = () => 2'
        }
      `,
      'node_modules/plain-loader/package.json': JSON.stringify({
        name: 'plain-loader',
        version: '1.0.0',
        main: './index.js',
      }),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves package-import specifiers through the local metadata graph', async () => {
    const root = await createFixture({
      'package.json': JSON.stringify({
        name: 'fixture',
        private: true,
        imports: { '#hook': './hook.ts' },
      }),
      'entry.ts': entrySource('#hook'),
      'hook.ts': `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(2)
          return count
        }
      `,
    })

    try {
      await runCompiler(createWebpackConfiguration(root))
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('proves package metadata behind an external package-import specifier', async () => {
    const root = await createFixture({
      'package.json': JSON.stringify({
        name: 'fixture',
        private: true,
        imports: { '#hook': 'hook-lib' },
      }),
      'entry.ts': entrySource('#hook'),
      'node_modules/hook-lib/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/hook-lib/package.json': JSON.stringify({
        name: 'hook-lib',
        version: '1.0.0',
        main: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/hook-lib/index.fict.meta.json': signalMetadata,
    })

    try {
      await runCompiler(excludeNodeModules(createWebpackConfiguration(root)))
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when a same-name alias shares one resource across public entries', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook'),
      'node_modules/actual-hook/shared.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './shared.js', './hooks': './shared.js' },
        fict: {
          metadata: './root.fict.meta.json',
          exports: { './hooks': './hooks.fict.meta.json' },
        },
      }),
      'node_modules/actual-hook/root.fict.meta.json': plainMetadata,
      'node_modules/actual-hook/hooks.fict.meta.json': signalMetadata,
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, { alias: { 'actual-hook': 'actual-hook/hooks' } }),
          ),
        ),
      ).rejects.toThrow('could not be matched to one public entry (., ./hooks)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when an alias hides a non-invertible export pattern', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/shared.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './*': './shared.js', './meta': './shared.js' },
        fict: { exports: { './meta': './meta.fict.meta.json' } },
      }),
      'node_modules/actual-hook/meta.fict.meta.json': signalMetadata,
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, { alias: { 'public-hook': 'actual-hook/meta' } }),
          ),
        ),
      ).rejects.toThrow('non-invertible export pattern')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for an extensionless non-invertible export target', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/shared.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './*': './shared', './meta': './shared' },
        fict: { exports: { './meta': './meta.fict.meta.json' } },
      }),
      'node_modules/actual-hook/meta.fict.meta.json': signalMetadata,
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, { alias: { 'public-hook': 'actual-hook/meta' } }),
          ),
        ),
      ).rejects.toThrow('non-invertible export pattern')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not let a same-name alias suppress non-invertible pattern ambiguity', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook/meta'),
      'node_modules/actual-hook/shared.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './*': './shared.js', './meta': './shared.js' },
        fict: { exports: { './meta': './meta.fict.meta.json' } },
      }),
      'node_modules/actual-hook/meta.fict.meta.json': signalMetadata,
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, {
              alias: { 'actual-hook/meta': 'actual-hook/foo' },
            }),
          ),
        ),
      ).rejects.toThrow('non-invertible export pattern')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for a non-invertible export pattern even through a direct request', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook/counter'),
      'node_modules/actual-hook/shared.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './*': './shared.js' },
        fict: { exports: { './counter': './counter.fict.meta.json' } },
      }),
      'node_modules/actual-hook/counter.fict.meta.json': signalMetadata,
    })

    try {
      await expect(
        runCompiler(excludeNodeModules(createWebpackConfiguration(root))),
      ).rejects.toThrow('non-invertible export pattern')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not hard-fail a non-invertible runtime pattern without Fict metadata', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/shared.js': 'exports.useCounter = () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { './*': './shared.js' },
      }),
    })

    try {
      await runCompiler(
        excludeNodeModules(
          createWebpackConfiguration(root, {
            alias: { 'public-hook': 'actual-hook/counter' },
            loaderOptions: { strictGuarantee: false },
          }),
        ),
      )
      expect(runApp(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tracks dependencies discovered by alias-disabled proof resolution', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('actual-hook'),
      'node_modules/actual-hook/index.js': 'exports.useCounter = () => () => 2',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './index.js', './future': './future.js' },
        fict: { metadata: './index.fict.meta.json' },
      }),
      'node_modules/actual-hook/index.fict.meta.json': signalMetadata,
    })
    const futurePath = path.join(root, 'node_modules', 'actual-hook', 'future.js')
    const compiler = webpack(excludeNodeModules(createWebpackConfiguration(root)))
    const builds = createBuildQueue()
    const firstBuild = builds.next()
    const watching = compiler.watch(fixtureWatchOptions, (error, stats) => {
      builds.push(error, stats)
    })!

    try {
      const firstStats = await firstBuild
      expect(
        [...firstStats.compilation.missingDependencies].some(dependency =>
          dependency.endsWith(`${path.sep}future.js`),
        ),
      ).toBe(true)
      await waitForWatchingReady(watching)

      const nextBuild = builds.nextMatching(
        stats =>
          stats.compilation.fileDependencies.has(futurePath) &&
          !stats.compilation.missingDependencies.has(futurePath),
        { description: 'the build that resolves the future package file' },
      )
      await writeFile(futurePath, 'exports.useCounter = () => 3')
      const nextStats = await nextBuild
      expect(nextStats.compilation.fileDependencies).toContain(futurePath)
      expect(nextStats.compilation.missingDependencies).not.toContain(futurePath)
    } finally {
      await closeWatching(watching, compiler)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when an alias resolves to multiple metadata public entries', async () => {
    const root = await createFixture({
      'entry.ts': entrySource('public-hook'),
      'node_modules/actual-hook/hooks.js': 'exports.useCounter = () => () => 1',
      'node_modules/actual-hook/package.json': JSON.stringify({
        name: 'actual-hook',
        version: '1.0.0',
        exports: { '.': './hooks.js', './duplicate': './hooks.js' },
        fict: {
          metadata: './root.fict.meta.json',
          exports: { './duplicate': './duplicate.fict.meta.json' },
        },
      }),
      'node_modules/actual-hook/root.fict.meta.json': signalMetadata,
      'node_modules/actual-hook/duplicate.fict.meta.json': JSON.stringify({
        version: 1,
        exports: {},
        hooks: { useCounter: {} },
      }),
    })

    try {
      await expect(
        runCompiler(
          excludeNodeModules(
            createWebpackConfiguration(root, { alias: { 'public-hook': 'actual-hook' } }),
          ),
        ),
      ).rejects.toThrow('could not be matched to one public entry (., ./duplicate)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
