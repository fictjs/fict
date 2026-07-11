import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { transformSync } from '@babel/core'
import syntaxJsx from '@babel/plugin-syntax-jsx'
import { describe, expect, it } from 'vitest'

import createFictPlugin, { type CompilerWarning } from '../src'
import {
  clearModuleMetadata,
  invalidateModuleMetadata,
  resolveModuleMetadata,
  setModuleMetadata,
} from '../src'
import type { ModuleReactiveMetadata } from '../src/types'

describe('module metadata safety', () => {
  it('invalidates one module without leaving its global metadata reusable', () => {
    clearModuleMetadata()
    const filename = path.resolve('__fict_metadata_single_invalidation__.ts')
    setModuleMetadata(filename, { exports: { value: 'signal' } }, { emitModuleMetadata: false })

    expect(resolveModuleMetadata(filename, undefined, { emitModuleMetadata: false })).toEqual({
      exports: { value: 'signal' },
    })
    invalidateModuleMetadata(filename, { emitModuleMetadata: false })
    expect(
      resolveModuleMetadata(filename, undefined, { emitModuleMetadata: false }),
    ).toBeUndefined()
    clearModuleMetadata()
  })

  it('invalidates only integration-owned metadata while preserving default memory and disk owners', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_integration_invalidation__')
    const sourceFilename = path.join(baseDir, 'source-module.ts')
    const diskFilename = path.join(baseDir, 'disk-module.ts')
    const importer = path.join(baseDir, 'consumer.ts')
    const cacheDir = path.join(baseDir, 'cache')
    const cachedSourceMetaPath = path.join(
      cacheDir,
      `${createHash('sha256').update(sourceFilename).digest('hex')}.fict.meta.json`,
    )
    const diskMetaPath = `${diskFilename}.fict.meta.json`
    const sourceOwned: ModuleReactiveMetadata = { exports: { value: 'signal' } }
    const cachedOwned: ModuleReactiveMetadata = { exports: { value: 'store' } }
    const diskOwned: ModuleReactiveMetadata = { exports: { value: 'signal' } }
    const freshDiskOwned: ModuleReactiveMetadata = { exports: { value: 'memo' } }
    const integrationOwned: ModuleReactiveMetadata = { exports: { value: 'store' } }
    const defaultOptions = { emitModuleMetadata: false as const }
    const integrationMetadata = new Map([
      [sourceFilename, integrationOwned],
      [diskFilename, integrationOwned],
    ])

    try {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(cachedSourceMetaPath, JSON.stringify(cachedOwned), 'utf8')
      writeFileSync(diskMetaPath, JSON.stringify(diskOwned), 'utf8')
      setModuleMetadata(sourceFilename, sourceOwned, defaultOptions)
      expect(resolveModuleMetadata('./source-module', importer, defaultOptions)).toEqual(
        sourceOwned,
      )
      expect(resolveModuleMetadata('./disk-module', importer, defaultOptions)).toEqual(diskOwned)

      const integrationOptions = {
        ...defaultOptions,
        moduleMetadata: integrationMetadata,
        validateIntegrationMetadata: true,
      }
      invalidateModuleMetadata(sourceFilename, integrationOptions)
      invalidateModuleMetadata(diskFilename, integrationOptions)

      expect(integrationMetadata.size).toBe(0)
      expect(JSON.parse(readFileSync(cachedSourceMetaPath, 'utf8'))).toEqual(cachedOwned)
      expect(JSON.parse(readFileSync(diskMetaPath, 'utf8'))).toEqual(diskOwned)
      expect(resolveModuleMetadata('./source-module', importer, defaultOptions)).toEqual(
        sourceOwned,
      )
      writeFileSync(diskMetaPath, JSON.stringify(freshDiskOwned), 'utf8')
      expect(resolveModuleMetadata('./disk-module', importer, defaultOptions)).toEqual(
        freshDiskOwned,
      )
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      clearModuleMetadata()
    }
  })

  it('does not hide failures while removing stale incomplete sidecars', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_invalidation_failure__')
    const filename = path.join(baseDir, 'module.ts')
    const metaPath = `${filename}.fict.meta.json`

    try {
      mkdirSync(metaPath, { recursive: true })
      expect(() => invalidateModuleMetadata(filename, { emitModuleMetadata: true })).toThrow()
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      clearModuleMetadata()
    }
  })

  it('does not write metadata sidecar for unknown filename', () => {
    const unknownMetaPath = path.resolve('<unknown>.fict.meta.json')
    if (existsSync(unknownMetaPath)) {
      rmSync(unknownMetaPath, { force: true })
    }

    transformSync('export const value = 1', {
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript'],
      },
      plugins: [[createFictPlugin, { emitModuleMetadata: true, dev: false }]],
    })

    expect(existsSync(unknownMetaPath)).toBe(false)
  })

  it('reports codegen diagnostics with the compiler filename', () => {
    const warnings: Array<{ code: string; fileName: string }> = []
    const filename = '/tmp/props-pattern.tsx'
    transformSync(
      `
      function Comp({ list: [first, ...rest] }) {
        return <div>{first}</div>
      }
    `,
      {
        filename,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
        },
        plugins: [
          [syntaxJsx, {}],
          [
            createFictPlugin,
            {
              emitModuleMetadata: false,
              dev: true,
              strictGuarantee: false,
              onWarn: (warning: CompilerWarning) => warnings.push(warning),
            },
          ],
        ],
      },
    )

    const warning = warnings.find(item => item.code === 'FICT-P002')
    expect(warning?.fileName).toBe(filename)
  })

  it('skips rewriting unchanged metadata payloads', async () => {
    const baseDir = path.join(process.cwd(), '__fict_metadata_safety__')
    mkdirSync(baseDir, { recursive: true })
    const filePath = path.join(baseDir, 'module.ts')
    const metaPath = `${filePath}.fict.meta.json`
    const source = 'export const value = 1'

    try {
      transformSync(source, {
        filename: filePath,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript'],
        },
        plugins: [[createFictPlugin, { emitModuleMetadata: true, dev: false }]],
      })

      const firstMtime = statSync(metaPath).mtimeMs
      await new Promise(resolve => setTimeout(resolve, 20))

      transformSync(source, {
        filename: filePath,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript'],
        },
        plugins: [[createFictPlugin, { emitModuleMetadata: true, dev: false }]],
      })

      const secondMtime = statSync(metaPath).mtimeMs
      expect(secondMtime).toBe(firstMtime)
    } finally {
      if (existsSync(metaPath)) {
        rmSync(metaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
    }
  })

  it('restores externally overwritten metadata before reusing the last payload', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_external_overwrite__')
    const filePath = path.join(baseDir, 'module.ts')
    const metaPath = `${filePath}.fict.meta.json`
    const metadata: ModuleReactiveMetadata = { exports: { value: 'signal' } }

    try {
      setModuleMetadata(filePath, metadata, { emitModuleMetadata: true })
      const expectedPayload = readFileSync(metaPath, 'utf8')

      writeFileSync(metaPath, '{"exports":{"value":"memo"}}', 'utf8')
      setModuleMetadata(filePath, metadata, { emitModuleMetadata: true })

      expect(readFileSync(metaPath, 'utf8')).toBe(expectedPayload)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      clearModuleMetadata()
    }
  })

  it('emits versioned module metadata sidecars', () => {
    const baseDir = path.join(process.cwd(), '__fict_metadata_versioned__')
    mkdirSync(baseDir, { recursive: true })
    const filePath = path.join(baseDir, 'module.ts')
    const metaPath = `${filePath}.fict.meta.json`

    try {
      transformSync('export const value = 1', {
        filename: filePath,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript'],
        },
        plugins: [[createFictPlugin, { emitModuleMetadata: true, dev: false }]],
      })

      expect(JSON.parse(readFileSync(metaPath, 'utf8'))).toEqual({
        version: 1,
        exports: {},
      })
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
    }
  })

  it('does not cache external metadata resolver callbacks', () => {
    let resolveCalls = 0
    const pluginOptions = {
      emitModuleMetadata: 'auto' as const,
      dev: false,
      resolveModuleMetadata: (source: string) => {
        if (source === './dep') {
          resolveCalls += 1
          return {
            exports: {
              value: 'signal' as const,
            },
          }
        }
        return undefined
      },
    }

    const source = `
      import { value } from './dep'
      export function useValue() {
        return value
      }
    `

    transformSync(source, {
      filename: '/tmp/consumer.ts',
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript'],
      },
      plugins: [[createFictPlugin, pluginOptions]],
    })
    const firstPassCalls = resolveCalls

    transformSync(source, {
      filename: '/tmp/consumer.ts',
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript'],
      },
      plugins: [[createFictPlugin, pluginOptions]],
    })

    expect(firstPassCalls).toBeGreaterThan(0)
    expect(resolveCalls).toBeGreaterThan(firstPassCalls)
  })

  it('rebuilds scope after stripping macro imports for later plugins', () => {
    let hasStateBinding: boolean | undefined
    let hasKeepBinding: boolean | undefined

    transformSync(
      `
        import { $state, keep } from 'fict'
        export const value = keep
      `,
      {
        filename: '/tmp/strip-macro-imports.ts',
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript'],
        },
        plugins: [
          [createFictPlugin, { emitModuleMetadata: false, dev: false }],
          () => ({
            visitor: {
              Program: {
                exit(path: { scope: { hasBinding(name: string): boolean } }) {
                  hasStateBinding = path.scope.hasBinding('$state')
                  hasKeepBinding = path.scope.hasBinding('keep')
                },
              },
            },
          }),
        ],
      },
    )

    expect(hasStateBinding).toBe(false)
    expect(hasKeepBinding).toBe(true)
  })

  it('does not resolve bare package imports from cwd metadata sidecars', () => {
    clearModuleMetadata()
    const bareSource = '__fict_bare_pkg__'
    const fakeResolvedPath = path.resolve(bareSource)
    const fakeMetaPath = `${fakeResolvedPath}.fict.meta.json`

    try {
      writeFileSync(fakeMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')

      const resolved = resolveModuleMetadata(bareSource, '/tmp/consumer.ts', {
        emitModuleMetadata: false,
      })

      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(fakeMetaPath)) {
        rmSync(fakeMetaPath, { force: true })
      }
      clearModuleMetadata()
    }
  })

  it('rejects package metadata paths that escape the package root', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_metadata_escape__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const escapedMetaPath = path.join(baseDir, 'escaped.fict.meta.json')

    try {
      mkdirSync(packageDir, { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fict: { metadata: '../../escaped.fict.meta.json' },
        }),
        'utf8',
      )
      writeFileSync(
        escapedMetaPath,
        JSON.stringify({
          exports: {},
          hooks: { useCounter: { directAccessor: 'signal' } },
        }),
        'utf8',
      )

      const resolved = resolveModuleMetadata('fict-hook-lib', importer, {
        emitModuleMetadata: false,
      })

      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('ignores package metadata files with invalid shapes', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_metadata_shape__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const metaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')

    try {
      mkdirSync(path.dirname(metaPath), { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
        'utf8',
      )
      writeFileSync(metaPath, JSON.stringify({ exports: null }), 'utf8')

      const resolved = resolveModuleMetadata('fict-hook-lib', importer, {
        emitModuleMetadata: false,
      })

      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('rejects package metadata with non-canonical hook array prop keys', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_metadata_array_props__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const metaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')
    const writeMetadata = (arrayProps: Record<string, string>): void => {
      writeFileSync(
        metaPath,
        JSON.stringify({
          exports: {},
          hooks: {
            usePair: {
              arrayProps,
            },
          },
        }),
        'utf8',
      )
    }
    const resolve = (): ModuleReactiveMetadata | undefined =>
      resolveModuleMetadata('fict-hook-lib', importer, {
        emitModuleMetadata: false,
      })

    try {
      mkdirSync(path.dirname(metaPath), { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
        'utf8',
      )

      writeMetadata({ '0': 'signal', '1': 'memo' })
      expect(resolve()?.hooks?.usePair?.arrayProps).toEqual({ '0': 'signal', '1': 'memo' })

      for (const key of ['01', '00', '-1', '1.5', '9007199254740992']) {
        clearModuleMetadata()
        writeMetadata({ [key]: 'signal' })
        expect(resolve()).toBeUndefined()
      }
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('rejects package metadata files with unsupported versions', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_metadata_unsupported_version__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const metaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')

    try {
      mkdirSync(path.dirname(metaPath), { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
        'utf8',
      )
      writeFileSync(
        metaPath,
        JSON.stringify({
          version: 2,
          exports: {},
          hooks: { useCounter: { directAccessor: 'signal' } },
        }),
        'utf8',
      )

      const resolved = resolveModuleMetadata('fict-hook-lib', importer, {
        emitModuleMetadata: false,
      })

      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('rejects package metadata paths that resolve through symlinks outside the package root', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_metadata_symlink__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const externalDir = path.join(baseDir, 'external')
    const externalMetaPath = path.join(externalDir, 'index.fict.meta.json')
    const linkedMetaPath = path.join(packageDir, 'dist', 'linked.fict.meta.json')

    try {
      mkdirSync(path.dirname(linkedMetaPath), { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      mkdirSync(externalDir, { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fict: { metadata: './dist/linked.fict.meta.json' },
        }),
        'utf8',
      )
      writeFileSync(
        externalMetaPath,
        JSON.stringify({
          exports: {},
          hooks: { useCounter: { directAccessor: 'signal' } },
        }),
        'utf8',
      )
      symlinkSync(externalMetaPath, linkedMetaPath)

      const resolved = resolveModuleMetadata('fict-hook-lib', importer, {
        emitModuleMetadata: false,
      })

      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('resolves legacy package fictMetadata declarations', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_legacy_metadata__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const metaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')

    try {
      mkdirSync(path.dirname(metaPath), { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fictMetadata: './dist/index.fict.meta.json',
        }),
        'utf8',
      )
      writeFileSync(
        metaPath,
        JSON.stringify({
          exports: {},
          hooks: { useCounter: { directAccessor: 'signal' } },
        }),
        'utf8',
      )

      const resolved = resolveModuleMetadata('fict-hook-lib', importer, {
        emitModuleMetadata: false,
      })

      expect(resolved).toEqual({
        exports: {},
        hooks: { useCounter: { directAccessor: 'signal' } },
      })
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('reports package manifests and sidecars consulted during metadata resolution', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_metadata_dependencies__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const packageJsonPath = path.join(packageDir, 'package.json')
    const metaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')
    const dependencies: string[] = []

    try {
      mkdirSync(path.dirname(metaPath), { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      writeFileSync(
        packageJsonPath,
        JSON.stringify({
          name: 'fict-hook-lib',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
        'utf8',
      )
      writeFileSync(
        metaPath,
        JSON.stringify({
          exports: {},
          hooks: { useCounter: { directAccessor: 'signal' } },
        }),
        'utf8',
      )

      expect(
        resolveModuleMetadata('fict-hook-lib', importer, {
          emitModuleMetadata: false,
          onModuleMetadataDependency: file => dependencies.push(file),
        }),
      ).toEqual({
        exports: {},
        hooks: { useCounter: { directAccessor: 'signal' } },
      })
      expect(dependencies).toEqual([packageJsonPath, metaPath])
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('observes package manifests created immediately after a resolution miss', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_manifest_created_after_miss__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const metaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')

    try {
      mkdirSync(path.dirname(importer), { recursive: true })
      expect(
        resolveModuleMetadata('fict-hook-lib', importer, { emitModuleMetadata: false }),
      ).toBeUndefined()

      mkdirSync(path.dirname(metaPath), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
      )
      writeFileSync(metaPath, JSON.stringify({ exports: { value: 'signal' } }))

      expect(
        resolveModuleMetadata('fict-hook-lib', importer, { emitModuleMetadata: false }),
      ).toEqual({ exports: { value: 'signal' } })
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      clearModuleMetadata()
    }
  })

  it('observes package sidecars created immediately after a resolution miss', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_sidecar_created_after_miss__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const metaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')

    try {
      mkdirSync(path.dirname(metaPath), { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
      )
      expect(
        resolveModuleMetadata('fict-hook-lib', importer, { emitModuleMetadata: false }),
      ).toBeUndefined()

      writeFileSync(metaPath, JSON.stringify({ exports: { value: 'memo' } }))

      expect(
        resolveModuleMetadata('fict-hook-lib', importer, { emitModuleMetadata: false }),
      ).toEqual({ exports: { value: 'memo' } })
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      clearModuleMetadata()
    }
  })

  it('prefers modern package metadata exports over legacy fictMetadata declarations', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_modern_metadata_with_legacy__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')
    const legacyMetaPath = path.join(packageDir, 'dist', 'legacy.fict.meta.json')
    const rootMetaPath = path.join(packageDir, 'dist', 'index.fict.meta.json')
    const hooksMetaPath = path.join(packageDir, 'dist', 'hooks.fict.meta.json')

    try {
      mkdirSync(path.dirname(rootMetaPath), { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fictMetadata: './dist/legacy.fict.meta.json',
          fict: {
            metadata: './dist/index.fict.meta.json',
            exports: {
              '.': './dist/index.fict.meta.json',
              './hooks': './dist/hooks.fict.meta.json',
            },
          },
        }),
        'utf8',
      )
      writeFileSync(
        legacyMetaPath,
        JSON.stringify({
          exports: {},
          hooks: { useLegacy: { directAccessor: 'signal' } },
        }),
        'utf8',
      )
      writeFileSync(
        rootMetaPath,
        JSON.stringify({
          exports: {},
          hooks: { useRoot: { directAccessor: 'signal' } },
        }),
        'utf8',
      )
      writeFileSync(
        hooksMetaPath,
        JSON.stringify({
          exports: {},
          hooks: { useHooks: { directAccessor: 'memo' } },
        }),
        'utf8',
      )

      const rootResolved = resolveModuleMetadata('fict-hook-lib', importer, {
        emitModuleMetadata: false,
      })
      const subpathResolved = resolveModuleMetadata('fict-hook-lib/hooks', importer, {
        emitModuleMetadata: false,
      })

      expect(rootResolved).toEqual({
        exports: {},
        hooks: { useRoot: { directAccessor: 'signal' } },
      })
      expect(subpathResolved).toEqual({
        exports: {},
        hooks: { useHooks: { directAccessor: 'memo' } },
      })
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('normalizes package export suffixes before resolving metadata', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_suffix_metadata__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-suffix-lib')
    const scopedPackageDir = path.join(baseDir, 'node_modules', '@scope', 'fict-suffix-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')

    const writePackage = (dir: string, name: string): void => {
      mkdirSync(path.join(dir, 'dist'), { recursive: true })
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name,
          fict: {
            metadata: './dist/root.fict.meta.json',
            exports: {
              './hooks': './dist/hooks.fict.meta.json',
            },
          },
        }),
        'utf8',
      )
      writeFileSync(
        path.join(dir, 'dist', 'root.fict.meta.json'),
        JSON.stringify({ exports: { rootCount: 'signal' } }),
        'utf8',
      )
      writeFileSync(
        path.join(dir, 'dist', 'hooks.fict.meta.json'),
        JSON.stringify({ exports: { count: 'signal' } }),
        'utf8',
      )
    }

    try {
      mkdirSync(path.dirname(importer), { recursive: true })
      writePackage(packageDir, 'fict-suffix-lib')
      writePackage(scopedPackageDir, '@scope/fict-suffix-lib')

      for (const source of ['fict-suffix-lib?raw', 'fict-suffix-lib#frag']) {
        expect(
          resolveModuleMetadata(source, importer, { emitModuleMetadata: false })?.exports,
        ).toEqual({ rootCount: 'signal' })
      }

      for (const source of [
        'fict-suffix-lib/hooks?raw',
        'fict-suffix-lib/hooks#frag',
        'fict-suffix-lib/hooks?raw#frag',
        '@scope/fict-suffix-lib/hooks?worker#frag',
      ]) {
        expect(
          resolveModuleMetadata(source, importer, { emitModuleMetadata: false })?.exports,
        ).toEqual({ count: 'signal' })
      }
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('prefers exact suffix-bearing package metadata exports before normalized keys', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_package_exact_suffix_metadata__')
    const packageDir = path.join(baseDir, 'node_modules', 'fict-suffix-exact-lib')
    const importer = path.join(baseDir, 'src', 'consumer.tsx')

    try {
      mkdirSync(path.join(packageDir, 'dist'), { recursive: true })
      mkdirSync(path.dirname(importer), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-suffix-exact-lib',
          fict: {
            exports: {
              './hooks': './dist/hooks.fict.meta.json',
              './hooks?raw': './dist/raw-hooks.fict.meta.json',
            },
          },
        }),
        'utf8',
      )
      writeFileSync(
        path.join(packageDir, 'dist', 'hooks.fict.meta.json'),
        JSON.stringify({ exports: { count: 'signal' } }),
        'utf8',
      )
      writeFileSync(
        path.join(packageDir, 'dist', 'raw-hooks.fict.meta.json'),
        JSON.stringify({ exports: { rawCount: 'memo' } }),
        'utf8',
      )

      expect(
        resolveModuleMetadata('fict-suffix-exact-lib/hooks?raw', importer, {
          emitModuleMetadata: false,
        })?.exports,
      ).toEqual({ rawCount: 'memo' })
      expect(
        resolveModuleMetadata('fict-suffix-exact-lib/hooks#frag', importer, {
          emitModuleMetadata: false,
        })?.exports,
      ).toEqual({ count: 'signal' })
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('does not read disk sidecars when moduleMetadata store is explicitly provided', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_store_only__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    mkdirSync(baseDir, { recursive: true })

    try {
      writeFileSync(depMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')
      const resolved = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
        moduleMetadata: new Map(),
      })
      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('prefers explicit external metadata after the same key was loaded from disk', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_external_after_disk__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    mkdirSync(baseDir, { recursive: true })

    try {
      writeFileSync(depMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')

      const diskResolved = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
      })
      expect(diskResolved).toEqual({ exports: { value: 'signal' } })

      const explicitStore = new Map<string, ModuleReactiveMetadata>([
        [depPath, { exports: { value: 'memo' } }],
      ])
      const explicitResolved = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
        moduleMetadata: explicitStore,
      })
      expect(explicitResolved).toEqual({ exports: { value: 'memo' } })

      const otherExplicitStore = new Map<string, ModuleReactiveMetadata>([
        [depPath, { exports: { value: 'store' } }],
      ])
      const otherExplicitResolved = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
        moduleMetadata: otherExplicitStore,
      })
      expect(otherExplicitResolved).toEqual({ exports: { value: 'store' } })
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('keeps global disk refresh markers when clearing an explicit metadata store', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_store_clear_isolation__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    const explicitStore = new Map<string, ModuleReactiveMetadata>([
      [depPath, { exports: { value: 'store' } }],
    ])
    mkdirSync(baseDir, { recursive: true })

    try {
      writeFileSync(depMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')
      expect(resolveModuleMetadata('./dep', importer, { emitModuleMetadata: false })).toEqual({
        exports: { value: 'signal' },
      })

      writeFileSync(depMetaPath, JSON.stringify({ exports: { value: 'memo' } }), 'utf8')
      clearModuleMetadata({ emitModuleMetadata: false, moduleMetadata: explicitStore })

      expect(explicitStore.size).toBe(0)
      expect(resolveModuleMetadata('./dep', importer, { emitModuleMetadata: false })).toEqual({
        exports: { value: 'memo' },
      })
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      clearModuleMetadata()
    }
  })

  it('does not let explicit-store disk markers invalidate global memory metadata', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_disk_marker_isolation__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    const explicitStore = new Map<string, ModuleReactiveMetadata>()
    mkdirSync(baseDir, { recursive: true })

    try {
      writeFileSync(depMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')
      setModuleMetadata(depPath, { exports: { value: 'memo' } }, { emitModuleMetadata: false })

      expect(
        resolveModuleMetadata('./dep', importer, {
          emitModuleMetadata: true,
          moduleMetadata: explicitStore,
        }),
      ).toEqual({ exports: { value: 'signal' } })
      expect(resolveModuleMetadata('./dep', importer, { emitModuleMetadata: false })).toEqual({
        exports: { value: 'memo' },
      })
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      clearModuleMetadata()
    }
  })

  it('does not resolve reactive metadata for query-suffixed import sources', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_query_suffix__')
    const importer = path.join(baseDir, 'consumer.ts')
    const queryImporter = `${importer}?import`
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    const moduleMetadata = new Map<string, ModuleReactiveMetadata>([
      [depPath, { exports: { default: 'signal', value: 'memo' } }],
    ])
    mkdirSync(baseDir, { recursive: true })

    try {
      expect(
        resolveModuleMetadata('./dep.ts', importer, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual({ exports: { default: 'signal', value: 'memo' } })
      expect(
        resolveModuleMetadata('./dep.ts', queryImporter, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual({ exports: { default: 'signal', value: 'memo' } })

      for (const query of ['raw', 'url', 'worker', 'import']) {
        expect(
          resolveModuleMetadata(`./dep.ts?${query}`, importer, {
            emitModuleMetadata: false,
            moduleMetadata,
          }),
        ).toBeUndefined()
      }

      writeFileSync(depMetaPath, JSON.stringify({ exports: { default: 'signal' } }), 'utf8')
      expect(
        resolveModuleMetadata('./dep.ts?raw', importer, {
          emitModuleMetadata: false,
        }),
      ).toBeUndefined()
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('resolves reactive metadata for hash-fragment import sources', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_hash_suffix__')
    const importer = path.join(baseDir, 'consumer.ts')
    const hashImporter = `${importer}#import`
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    const moduleMetadata = new Map<string, ModuleReactiveMetadata>([
      [depPath, { exports: { default: 'signal', value: 'memo' } }],
    ])
    mkdirSync(baseDir, { recursive: true })

    try {
      expect(
        resolveModuleMetadata('./dep.ts#hash', importer, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual({ exports: { default: 'signal', value: 'memo' } })
      expect(
        resolveModuleMetadata('./dep#hash', importer, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual({ exports: { default: 'signal', value: 'memo' } })
      expect(
        resolveModuleMetadata('./dep.ts#hash', hashImporter, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual({ exports: { default: 'signal', value: 'memo' } })

      writeFileSync(depMetaPath, JSON.stringify({ exports: { default: 'signal' } }), 'utf8')
      expect(
        resolveModuleMetadata('./dep.ts#hash', importer, {
          emitModuleMetadata: false,
        }),
      ).toEqual({ exports: { default: 'signal' } })
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('resolves file-url imports against normalized external metadata keys', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_file_url__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const moduleMetadata = new Map<string, ModuleReactiveMetadata>([
      [depPath, { exports: { value: 'signal' } }],
    ])
    mkdirSync(baseDir, { recursive: true })

    try {
      const expected = { exports: { value: 'signal' } }
      expect(
        resolveModuleMetadata(pathToFileURL(depPath).href, importer, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual(expected)
      expect(
        resolveModuleMetadata(depPath, importer, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual(expected)
      expect(
        resolveModuleMetadata('./dep.ts', importer, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual(expected)
    } finally {
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('preserves absolute paths for /@fs metadata imports', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_atfs__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    const moduleMetadata = new Map<string, ModuleReactiveMetadata>([
      [depPath, { exports: { value: 'memo' } }],
    ])
    mkdirSync(baseDir, { recursive: true })

    try {
      expect(
        resolveModuleMetadata(`/@fs${depPath}`, importer, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual({ exports: { value: 'memo' } })
      expect(
        resolveModuleMetadata(`/@fs/${depPath}`, importer, {
          emitModuleMetadata: false,
          moduleMetadata,
        }),
      ).toEqual({ exports: { value: 'memo' } })

      writeFileSync(depMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')
      expect(
        resolveModuleMetadata(`/@fs${depPath}`, importer, {
          emitModuleMetadata: false,
        }),
      ).toEqual({ exports: { value: 'signal' } })
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('invalidates fs probe cache when metadata sidecars are created', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_probe_cache__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    mkdirSync(baseDir, { recursive: true })

    try {
      const first = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
      })
      expect(first).toBeUndefined()

      setModuleMetadata(
        depPath,
        {
          exports: {
            value: 'signal',
          },
        },
        {
          emitModuleMetadata: true,
          dev: false,
        },
      )

      const resolved = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
      })

      expect(resolved).toEqual({
        exports: {
          value: 'signal',
        },
      })
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('observes metadata sidecars created immediately after a resolution miss', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_negative_cache__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    mkdirSync(baseDir, { recursive: true })

    try {
      const first = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
      })
      expect(first).toBeUndefined()

      writeFileSync(
        depMetaPath,
        JSON.stringify({
          exports: {
            value: 'signal',
          },
        }),
        'utf8',
      )

      const resolved = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
      })

      expect(resolved).toEqual({
        exports: {
          value: 'signal',
        },
      })
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('refreshes disk-loaded metadata immediately when sidecars change', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_refresh__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    mkdirSync(baseDir, { recursive: true })

    try {
      writeFileSync(
        depMetaPath,
        JSON.stringify({
          exports: {
            value: 'signal',
          },
        }),
        'utf8',
      )

      const first = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
      })
      expect(first).toEqual({
        exports: {
          value: 'signal',
        },
      })

      writeFileSync(
        depMetaPath,
        JSON.stringify({
          exports: {
            value: 'memo',
          },
        }),
        'utf8',
      )

      const second = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
      })

      expect(second).toEqual({
        exports: {
          value: 'memo',
        },
      })
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('does not fall back to cwd sidecars for unresolved relative imports', () => {
    clearModuleMetadata()
    const marker = '__fict_relative_probe__'
    const source = `./${marker}`
    const importer = '/tmp/consumer.ts'
    const cwdMetaPath = path.resolve(`${marker}.fict.meta.json`)

    try {
      writeFileSync(cwdMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')
      const resolved = resolveModuleMetadata(source, importer, {
        emitModuleMetadata: false,
      })
      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(cwdMetaPath)) {
        rmSync(cwdMetaPath, { force: true })
      }
      clearModuleMetadata()
    }
  })
})
