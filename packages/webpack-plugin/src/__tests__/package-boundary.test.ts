import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ModuleReactiveMetadata } from '@fictjs/compiler'
import type { NormalModule } from 'webpack'

import {
  getPackageMetadataKeyFingerprint,
  getPackageNonInvertibleRuntimeTargets,
  getPackageRuntimeMappingFingerprint,
  getPackageRuntimeTargets,
  isCanonicalPackageName,
  isCanonicalPublicSubpath,
  readPackageMetadataAtBoundary,
  resolvePackageRuntimeTargetPath,
  type FictWebpackPackageResolution,
  type PackagePublicSubpath,
} from '../package-metadata'
import {
  createCompilationState,
  registerFictModule,
  restoreFictModuleMetadata,
  storeFictModuleMetadata,
} from '../shared'

const createResolution = (
  packageJsonPath: string,
  publicSubpath: PackagePublicSubpath = '.',
  packageData: unknown = { name: 'hook-lib', fict: { metadata: './snapshot.meta.json' } },
): FictWebpackPackageResolution => ({
  packageJsonPath,
  publicSubpath,
  resourcePaths: [path.join(path.dirname(packageJsonPath), 'index.js')],
  metadataKeyFingerprint: getPackageMetadataKeyFingerprint(packageData),
  runtimeMappingFingerprint: getPackageRuntimeMappingFingerprint(packageData),
})

function readResolvedMetadata(
  resolution: FictWebpackPackageResolution,
): ModuleReactiveMetadata | undefined {
  const result = readPackageMetadataAtBoundary(resolution, () => {})
  return result.kind === 'resolved' ? result.metadata : undefined
}

describe('Webpack package metadata boundaries', () => {
  it('persists metadata completeness and distrusts previous cache records', () => {
    const state = createCompilationState()
    const filename = path.resolve('/virtual/incomplete-hook.ts')
    const identifier = `fict-loader!${filename}`
    const module = {
      buildInfo: {},
      identifier: () => identifier,
      resource: filename,
    } as unknown as NormalModule
    const metadata: ModuleReactiveMetadata = {
      exports: {},
      hooks: { useCounter: { directAccessor: 'signal' } },
    }
    registerFictModule(state, module)
    state.incompleteModuleMetadata.add(identifier)
    storeFictModuleMetadata(state, module, metadata, 'fingerprint')

    expect(restoreFictModuleMetadata(module)).toMatchObject({
      identifier,
      resource: filename,
      metadata,
      incomplete: true,
      dependencyFingerprint: 'fingerprint',
    })

    const stored = (module.buildInfo as unknown as Record<string, unknown>)
      .fictWebpackMetadata as Record<string, unknown>
    stored.version = 2
    stored.filename = filename
    delete stored.identifier
    delete stored.resource
    delete stored.incomplete
    expect(restoreFictModuleMetadata(module)).toMatchObject({
      incomplete: true,
      dependencyFingerprint: null,
    })
  })

  it('reads fresh manifests and sidecars and reports missing dependencies', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fict-webpack-boundary-'))
    const packageJsonPath = path.join(root, 'package.json')
    const firstMetaPath = path.join(root, 'first.fict.meta.json')
    const secondMetaPath = path.join(root, 'second.fict.meta.json')
    const signalPayload = JSON.stringify({
      version: 1,
      exports: {},
      hooks: { useCounter: { directAccessor: 'signal' } },
    })
    const memoPayload = JSON.stringify({
      version: 1,
      exports: {},
      hooks: { useCounter: { directAccessor: 'memo' } },
    }).padEnd(signalPayload.length, ' ')
    const storePayload = JSON.stringify({
      version: 1,
      exports: {},
      hooks: { useCounter: { directAccessor: 'store' } },
    })

    try {
      writeFileSync(
        packageJsonPath,
        JSON.stringify({ name: 'hook-lib', fict: { metadata: './first.fict.meta.json' } }),
      )
      const dependencies: string[] = []
      expect(
        readPackageMetadataAtBoundary(createResolution(packageJsonPath), dependency =>
          dependencies.push(dependency),
        ),
      ).toEqual({ kind: 'unresolved' })
      expect(dependencies).toEqual([packageJsonPath, firstMetaPath])

      writeFileSync(firstMetaPath, signalPayload)
      expect(
        readResolvedMetadata(createResolution(packageJsonPath))?.hooks?.useCounter?.directAccessor,
      ).toBe('signal')

      const oldTimestamp = new Date(Date.now() - 10_000)
      utimesSync(firstMetaPath, oldTimestamp, oldTimestamp)
      const originalStat = statSync(firstMetaPath)
      writeFileSync(firstMetaPath, memoPayload)
      utimesSync(firstMetaPath, originalStat.atime, originalStat.mtime)
      expect(
        readResolvedMetadata(createResolution(packageJsonPath))?.hooks?.useCounter?.directAccessor,
      ).toBe('memo')

      writeFileSync(secondMetaPath, storePayload)
      writeFileSync(
        packageJsonPath,
        JSON.stringify({ name: 'hook-lib', fict: { metadata: './second.fict.meta.json' } }),
      )
      expect(
        readResolvedMetadata(createResolution(packageJsonPath))?.hooks?.useCounter?.directAccessor,
      ).toBe('store')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts only canonical public subpaths', () => {
    expect(isCanonicalPublicSubpath('.')).toBe(true)
    expect(isCanonicalPublicSubpath('./hooks')).toBe(true)
    for (const subpath of [
      '',
      'hooks',
      './',
      './hooks/',
      './hooks//nested',
      './hooks?raw',
      './hooks#fragment',
      './hooks\\nested',
      './hooks/../private',
      './node_modules/private',
      './NODE_MODULES/private',
      './%2e%2e/private',
      './%6eode_modules/private',
      './*',
    ]) {
      expect(isCanonicalPublicSubpath(subpath)).toBe(false)
    }
  })

  it('accepts only canonical package names before resolver proof', () => {
    expect(isCanonicalPackageName('hook-lib')).toBe(true)
    expect(isCanonicalPackageName('@scope/hook-lib')).toBe(true)
    for (const name of [
      '',
      '.',
      '..',
      'node_modules',
      './outside',
      '../outside',
      '../../dev/zero',
      '/absolute',
      'nested/hook',
      '@scope',
      '@scope/nested/hook',
      '@/hook',
      '@../hook',
      '@scope/..',
      'hook\\outside',
      'hook\0outside',
      'hook?raw',
      'hook#fragment',
      'loader!hook',
      'file:hook',
    ]) {
      expect(isCanonicalPackageName(name)).toBe(false)
    }
  })

  it('maps resolved public entries back to conditional and wildcard export targets', () => {
    expect(
      getPackageRuntimeTargets(
        { exports: { import: './dist/index.mjs', require: './dist/index.cjs' } },
        '.',
      ),
    ).toEqual(['./dist/index.cjs', './dist/index.mjs'])
    expect(
      getPackageRuntimeTargets(
        {
          exports: {
            './hooks': { import: './dist/hooks.mjs', require: './dist/hooks.cjs' },
            './features/*': './dist/features/*.js',
          },
        },
        './hooks',
      ),
    ).toEqual(['./dist/hooks.cjs', './dist/hooks.mjs'])
    expect(
      getPackageRuntimeTargets(
        { exports: { './features/*': './dist/features/*.js' } },
        './features/counter',
      ),
    ).toEqual(['./dist/features/counter.js'])
    expect(
      getPackageRuntimeTargets({ exports: { './*/*': './dist/*/*' } }, './features/counter'),
    ).toEqual([])
    expect(
      getPackageRuntimeTargets(
        { exports: { '.': './dist/index.js', browser: './dist/browser.js' } },
        '.',
      ),
    ).toEqual([])
    expect(
      getPackageRuntimeTargets(
        { exports: { '.': { browser: '../outside.js', default: './dist/index.js' } } },
        '.',
      ),
    ).toEqual([])
    expect(
      getPackageRuntimeTargets(
        { exports: { '.': { default: './dist/index.js', browser: './dist/browser.js' } } },
        '.',
      ),
    ).toEqual([])
    expect(getPackageRuntimeTargets({ exports: { '.': [null, './dist/index.js'] } }, '.')).toEqual(
      [],
    )
  })

  it('rejects unsafe runtime targets before resolving package paths', () => {
    for (const target of [
      '../../dev/zero',
      './../../dev/zero',
      './dist/hook\0.js',
      './dist/hook.js?raw',
      './dist/hook.js#fragment',
      './dist\\hook.js',
      './dist/./hook.js',
      './dist/../hook.js',
      './node_modules/hook.js',
      './dist/node_modules/hook.js',
      './%2e/hook.js',
      './%2E%2e/hook.js',
      './%6eode_modules/hook.js',
      './NoDe_MoDuLeS/hook.js',
      './%4eode_%6dodules/hook.js',
      '.',
      './',
    ]) {
      expect(getPackageRuntimeTargets({ exports: { '.': { unsafe: target } } }, '.')).toEqual([])
      expect(resolvePackageRuntimeTargetPath('/unused/package.json', target)).toBeUndefined()
    }
    expect(
      getPackageRuntimeTargets(
        {
          exports: {
            '.': {
              unsafe: './../../dev/zero',
              import: './dist/index.mjs',
              require: './dist/index.cjs',
            },
          },
        },
        '.',
      ),
    ).toEqual([])
  })

  it('rejects runtime targets that escape through a package symlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fict-webpack-runtime-target-'))
    const packageDir = path.join(root, 'package')
    const outsideDir = path.join(root, 'outside')
    const packageJsonPath = path.join(packageDir, 'package.json')
    const linkedTarget = path.join(packageDir, 'dist', 'linked.js')

    try {
      mkdirSync(path.dirname(linkedTarget), { recursive: true })
      mkdirSync(outsideDir)
      writeFileSync(packageJsonPath, '{}')
      writeFileSync(path.join(outsideDir, 'linked.js'), '')
      symlinkSync(path.join(outsideDir, 'linked.js'), linkedTarget)
      expect(resolvePackageRuntimeTargetPath(packageJsonPath, './dist/linked.js')).toBeUndefined()
      expect(resolvePackageRuntimeTargetPath(packageJsonPath, './dist/missing.js')).toBe(
        path.join(packageDir, 'dist', 'missing.js'),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('identifies non-invertible public patterns even when the request names one subpath', () => {
    const packageData = {
      exports: { './*': './shared.js', './meta': './shared.js' },
    }
    expect(getPackageNonInvertibleRuntimeTargets(packageData)).toEqual(['./shared.js'])
    expect(getPackageNonInvertibleRuntimeTargets({ exports: { './*/*': './shared.js' } })).toEqual(
      [],
    )
  })

  it('fingerprints every non-metadata manifest field without absent/null collisions', () => {
    expect(getPackageRuntimeMappingFingerprint({})).not.toBe(
      getPackageRuntimeMappingFingerprint({ exports: null }),
    )
    expect(
      getPackageRuntimeMappingFingerprint({
        customMain: './index.js',
        fict: { metadata: './first.meta.json' },
      }),
    ).toBe(
      getPackageRuntimeMappingFingerprint({
        customMain: './index.js',
        fict: { metadata: './second.meta.json' },
      }),
    )
    expect(getPackageRuntimeMappingFingerprint({ customMain: './first.js' })).not.toBe(
      getPackageRuntimeMappingFingerprint({ customMain: './second.js' }),
    )
    expect(
      getPackageMetadataKeyFingerprint({ fict: { exports: { './hooks': './first.meta.json' } } }),
    ).toBe(
      getPackageMetadataKeyFingerprint({ fict: { exports: { './hooks': './second.meta.json' } } }),
    )
    expect(getPackageMetadataKeyFingerprint({})).not.toBe(
      getPackageMetadataKeyFingerprint({ fict: { metadata: './root.meta.json' } }),
    )
  })

  it('treats invalid-only configs and invalid declared entries as unresolved', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fict-webpack-invalid-config-'))
    const packageJsonPath = path.join(root, 'package.json')
    const invalidOnly = { name: 'hook-lib', fict: { exports: { '../escape': './meta.json' } } }
    const invalidEntry = { name: 'hook-lib', fict: { exports: { './hooks': '' } } }
    const absentEntry = {
      name: 'hook-lib',
      fict: { exports: { './other': './other.meta.json' } },
    }

    try {
      writeFileSync(packageJsonPath, JSON.stringify(invalidOnly))
      expect(
        readPackageMetadataAtBoundary(
          createResolution(packageJsonPath, '.', invalidOnly),
          () => {},
        ),
      ).toEqual({
        kind: 'unresolved',
      })

      writeFileSync(packageJsonPath, JSON.stringify(invalidEntry))
      expect(
        readPackageMetadataAtBoundary(
          createResolution(packageJsonPath, './hooks', invalidEntry),
          () => {},
        ),
      ).toEqual({ kind: 'unresolved' })

      writeFileSync(packageJsonPath, JSON.stringify(absentEntry))
      expect(
        readPackageMetadataAtBoundary(
          createResolution(packageJsonPath, './plain', absentEntry),
          () => {},
        ),
      ).toEqual({ kind: 'plain' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('enforces real package containment while allowing a linked package root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fict-webpack-boundary-links-'))
    const realPackageDir = path.join(root, 'real-package')
    const linkedPackageDir = path.join(root, 'linked-package')
    const manifestLinkDir = path.join(root, 'manifest-link-package')
    const outsideDir = path.join(root, 'outside')
    const outsideManifestPath = path.join(outsideDir, 'package.json')
    const outsideMetaPath = path.join(outsideDir, 'outside.fict.meta.json')
    const linkedMetaPath = path.join(realPackageDir, 'linked.fict.meta.json')
    const payload = JSON.stringify({
      version: 1,
      exports: {},
      hooks: { useCounter: { directAccessor: 'signal' } },
    })

    try {
      mkdirSync(realPackageDir, { recursive: true })
      mkdirSync(manifestLinkDir)
      mkdirSync(outsideDir)
      writeFileSync(
        path.join(realPackageDir, 'package.json'),
        JSON.stringify({ name: 'hook-lib', fict: { metadata: './linked.fict.meta.json' } }),
      )
      writeFileSync(outsideMetaPath, payload)
      writeFileSync(
        outsideManifestPath,
        JSON.stringify({ fict: { metadata: './outside.fict.meta.json' } }),
      )
      symlinkSync(outsideManifestPath, path.join(manifestLinkDir, 'package.json'))
      const manifestDependencies: string[] = []
      expect(
        readPackageMetadataAtBoundary(
          createResolution(path.join(manifestLinkDir, 'package.json')),
          dependency => manifestDependencies.push(dependency),
        ),
      ).toEqual({ kind: 'unresolved' })
      expect(manifestDependencies).toEqual([])

      symlinkSync(outsideMetaPath, linkedMetaPath)
      const metadataDependencies: string[] = []
      expect(
        readPackageMetadataAtBoundary(
          createResolution(path.join(realPackageDir, 'package.json')),
          dependency => metadataDependencies.push(dependency),
        ),
      ).toEqual({ kind: 'unresolved' })
      expect(metadataDependencies).toEqual([path.join(realPackageDir, 'package.json')])

      rmSync(linkedMetaPath)
      symlinkSync(path.join(outsideDir, 'missing.fict.meta.json'), linkedMetaPath)
      const danglingDependencies: string[] = []
      expect(
        readPackageMetadataAtBoundary(
          createResolution(path.join(realPackageDir, 'package.json')),
          dependency => danglingDependencies.push(dependency),
        ),
      ).toEqual({ kind: 'unresolved' })
      expect(danglingDependencies).toEqual([
        path.join(realPackageDir, 'package.json'),
        linkedMetaPath,
      ])

      rmSync(linkedMetaPath)
      writeFileSync(linkedMetaPath, payload)
      symlinkSync(realPackageDir, linkedPackageDir, 'dir')
      expect(
        readResolvedMetadata(createResolution(path.join(linkedPackageDir, 'package.json')))?.hooks
          ?.useCounter?.directAccessor,
      ).toBe('signal')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the compiler parser to reject invalid nested metadata', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fict-webpack-boundary-abi-'))
    const packageJsonPath = path.join(root, 'package.json')
    const metadataPath = path.join(root, 'index.fict.meta.json')

    try {
      writeFileSync(
        packageJsonPath,
        JSON.stringify({ fict: { metadata: './index.fict.meta.json' } }),
      )
      writeFileSync(
        metadataPath,
        JSON.stringify({
          version: 1,
          exports: {},
          namespaces: {
            nested: {
              version: 1,
              exports: {},
              hooks: { useCounter: { directAccessor: 'invalid' } },
            },
          },
        }),
      )
      expect(
        readPackageMetadataAtBoundary(
          createResolution(packageJsonPath, '.', {
            fict: { metadata: './index.fict.meta.json' },
          }),
          () => {},
        ),
      ).toEqual({ kind: 'unresolved' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
