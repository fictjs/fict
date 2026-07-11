import { readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import webpack, {
  type Compilation,
  type Compiler,
  type Configuration,
  type NormalModule,
} from 'webpack'

import {
  builtFixtureFiles,
  closeWatching,
  createBuildQueue,
  createFixture,
  createWebpackConfiguration,
  runApp,
  runCompiler,
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
    const watching = compiler.watch({ aggregateTimeout: 5 }, (error, stats) => {
      builds.push(error, stats)
    })!

    try {
      const firstStats = await firstBuild
      expect(await readBundle(root)).toMatch(/count\(\)\s*\*\s*2/)
      expect(firstStats.compilation.fileDependencies).toContain(packagePath)
      expect(firstStats.compilation.fileDependencies).toContain(sidecarPath)

      const plainBuild = builds.next()
      await writeFile(sidecarPath, plainMetadata)
      const plainStats = await plainBuild
      const plainBundle = await readBundle(root)
      expect(plainBundle).toMatch(/return count\s*\*\s*2/)
      expect(plainBundle).not.toMatch(/count\(\)\s*\*\s*2/)
      expect(builtFixtureFiles(plainStats, root)).toContain(entryPath)

      const signalBuild = builds.next()
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
      const oldTimestamp = new Date(Date.now() - 10_000)
      await utimes(sidecarPath, oldTimestamp, oldTimestamp)

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
      const oldTimestamp = new Date(Date.now() - 10_000)
      await Promise.all(
        [
          path.join(root, 'entry.ts'),
          packageJsonPath,
          path.join(root, 'node_modules', 'actual-hook', 'signal.js'),
          path.join(root, 'node_modules', 'actual-hook', 'plain_.js'),
          path.join(root, 'node_modules', 'actual-hook', 'signal.fict.meta.json'),
          path.join(root, 'node_modules', 'actual-hook', 'plain_.fict.meta.json'),
        ].map(filename => utimes(filename, oldTimestamp, oldTimestamp)),
      )

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

  it('aggregates conditional import and require resources at one metadata boundary', async () => {
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

  it('fails closed when one request crosses local and package metadata boundaries', async () => {
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
      await expect(
        runCompiler(excludeNodeModules(createWebpackConfiguration(root))),
      ).rejects.toThrow('across both local and non-local metadata boundaries')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when an alias rename reaches incomplete local hook metadata', async () => {
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
      await expect(
        runCompiler(excludeNodeModules(createWebpackConfiguration(root))),
      ).rejects.toThrow('FICT-H003')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores incomplete local hook metadata from filesystem cache', async () => {
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
      }),
    })
    const entryPath = path.join(root, 'entry.ts')
    const hookPath = path.join(root, 'hook.ts')
    const cache = {
      type: 'filesystem' as const,
      cacheDirectory: path.join(root, '.webpack-cache'),
    }
    const configuration = () => excludeNodeModules(createWebpackConfiguration(root, { cache }))

    try {
      const firstStats = await runCompiler(configuration())
      const hookModule = [...firstStats.compilation.modules].find(
        module => (module as { resource?: unknown }).resource === hookPath,
      ) as { buildInfo?: Record<string, unknown> } | undefined
      expect(hookModule?.buildInfo?.fictWebpackMetadata).toMatchObject({
        version: 3,
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
      await expect(runCompiler(configuration())).rejects.toThrow('FICT-H003')
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
    const watching = compiler.watch({ aggregateTimeout: 5 }, (error, stats) => {
      builds.push(error, stats)
    })!

    try {
      const firstStats = await firstBuild
      expect(
        [...firstStats.compilation.missingDependencies].some(dependency =>
          dependency.endsWith(`${path.sep}future.js`),
        ),
      ).toBe(true)

      const nextBuild = builds.next()
      await writeFile(futurePath, 'exports.useCounter = () => 3')
      await nextBuild
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
