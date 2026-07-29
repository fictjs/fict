import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

const FORBIDDEN_RUNTIME_MODULES = [
  '@babel/core',
  '@babel/helper-plugin-utils',
  '@babel/parser',
  '@babel/traverse',
  '@babel/types',
] as const
const tempRoots: string[] = []

afterEach(async () => {
  for (const moduleId of FORBIDDEN_RUNTIME_MODULES) vi.doUnmock(moduleId)
  vi.resetModules()
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('@fictjs/compiler/graph-host', () => {
  it('loads metadata services without evaluating Babel or the legacy compiler', async () => {
    for (const moduleId of FORBIDDEN_RUNTIME_MODULES) {
      vi.doMock(moduleId, () => {
        throw new Error(`graph-host loaded forbidden runtime module ${moduleId}`)
      })
    }

    const graphHost = await import('../src/graph-host')
    expect(
      graphHost.parseModuleReactiveMetadata(
        JSON.stringify({ version: 1, exports: { count: 'signal' } }),
      ),
    ).toEqual({ version: 1, exports: { count: 'signal' } })
  })

  it('rejects unversioned, future, and unknown metadata schemas', async () => {
    const { parseModuleReactiveMetadata } = await import('../src/graph-host')

    expect(parseModuleReactiveMetadata('{"exports":{}}')).toBeNull()
    expect(parseModuleReactiveMetadata('{"version":2,"exports":{}}')).toBeNull()
    expect(parseModuleReactiveMetadata('{"version":1,"exports":{},"legacy":true}')).toBeNull()
  })

  it('resolves only package-declared versioned metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-'))
    tempRoots.push(root)
    const packageRoot = path.join(root, 'node_modules', 'fict-library')
    const metadataPath = path.join(packageRoot, 'dist', 'index.fict.meta.json')
    const importer = path.join(root, 'src', 'App.tsx')
    await mkdir(path.dirname(metadataPath), { recursive: true })
    await mkdir(path.dirname(importer), { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ fict: { metadata: './dist/index.fict.meta.json' } }),
    )
    await writeFile(metadataPath, JSON.stringify({ version: 1, exports: { count: 'signal' } }))

    const { resolvePackageModuleMetadata, resolvePackageModuleMetadataState } =
      await import('../src/graph-host')
    const dependencies: string[] = []
    expect(
      resolvePackageModuleMetadata('fict-library', importer, {
        onDependency: dependency => dependencies.push(dependency),
      }),
    ).toEqual({ version: 1, exports: { count: 'signal' } })
    expect(resolvePackageModuleMetadataState('fict-library', importer)).toEqual({
      kind: 'resolved',
      metadata: { version: 1, exports: { count: 'signal' } },
    })
    expect(dependencies).toEqual([
      path.join(path.dirname(importer), 'node_modules', 'fict-library', 'package.json'),
      path.join(packageRoot, 'package.json'),
      metadataPath,
    ])
  })

  it('does not read the retired root fictMetadata declaration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-legacy-'))
    tempRoots.push(root)
    const packageRoot = path.join(root, 'node_modules', 'legacy-library')
    const importer = path.join(root, 'src', 'App.tsx')
    await mkdir(path.join(packageRoot, 'dist'), { recursive: true })
    await mkdir(path.dirname(importer), { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ fictMetadata: './dist/index.fict.meta.json' }),
    )
    await writeFile(
      path.join(packageRoot, 'dist', 'index.fict.meta.json'),
      JSON.stringify({ version: 1, exports: { count: 'signal' } }),
    )

    const { resolvePackageModuleMetadata } = await import('../src/graph-host')
    expect(resolvePackageModuleMetadata('legacy-library', importer)).toBeUndefined()
  })

  it.each([
    '@scope/.',
    '@scope/..',
    '@scope/../x',
    '@scope\\escape/package',
    'node_modules',
    'NODE_MODULES',
    '%2e%2e',
    '@%2e%2e/package',
    '@scope/%2e%2e',
    'loader!package',
  ])('rejects non-canonical package request %s before reading a manifest', async source => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-package-name-'))
    tempRoots.push(root)
    const importer = path.join(root, 'workspace', 'src', 'App.tsx')
    const escapedManifest = path.join(root, 'workspace', 'node_modules', 'package.json')
    await mkdir(path.dirname(importer), { recursive: true })
    await mkdir(path.dirname(escapedManifest), { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(
      escapedManifest,
      JSON.stringify({ fict: { metadata: './escaped.fict.meta.json' } }),
    )
    await writeFile(
      path.join(path.dirname(escapedManifest), 'escaped.fict.meta.json'),
      JSON.stringify({ version: 1, exports: { escaped: 'signal' } }),
    )

    const { resolvePackageModuleMetadata } = await import('../src/graph-host')
    const dependencies: string[] = []
    expect(
      resolvePackageModuleMetadata(source, importer, {
        onDependency: dependency => dependencies.push(dependency),
      }),
    ).toBeUndefined()
    expect(dependencies).toEqual([])
  })

  it.each(['node:async_hooks', 'virtual:hook', 'https://example.test/hook.js'])(
    'does not treat scheme import %s as an npm package request',
    async source => {
      const { resolvePackageModuleMetadataState } = await import('../src/graph-host')
      const dependencies: string[] = []
      const resolvePackage = vi.fn()

      expect(
        resolvePackageModuleMetadataState(source, path.join(process.cwd(), 'src', 'App.tsx'), {
          onDependency: dependency => dependencies.push(dependency),
          resolvePackage,
        }),
      ).toEqual({ kind: 'invalid' })
      expect(resolvePackage).not.toHaveBeenCalled()
      expect(dependencies).toEqual([])
    },
  )

  it.each([
    'package/../escape',
    'package/./hook',
    'package//hook',
    'package/hook/',
    'package/node_modules/hook',
    'package/NODE_MODULES/hook',
    'package/%2e%2e/escape',
    'package/%2Fescape',
  ])('rejects non-canonical package public subpath %s before host resolution', async source => {
    const { resolvePackageModuleMetadataState } = await import('../src/graph-host')
    const dependencies: string[] = []
    const resolvePackage = vi.fn()

    expect(
      resolvePackageModuleMetadataState(source, 'virtual:entry', {
        onDependency: dependency => dependencies.push(dependency),
        resolvePackage,
      }),
    ).toEqual({ kind: 'invalid' })
    expect(resolvePackage).not.toHaveBeenCalled()
    expect(dependencies).toEqual([])
  })

  it.skipIf(process.platform === 'win32').each(['?', '#'])(
    'preserves a literal %s in a physical importer path',
    async literal => {
      const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-literal-importer-'))
      tempRoots.push(root)
      const literalWorkspace = path.join(root, `workspace${literal}literal`)
      const importer = path.join(literalWorkspace, 'src', 'App.tsx')
      const correctPackageRoot = path.join(literalWorkspace, 'node_modules', 'fict-library')
      const incorrectPackageRoot = path.join(root, 'workspace', 'node_modules', 'fict-library')
      await mkdir(path.dirname(importer), { recursive: true })
      await mkdir(correctPackageRoot, { recursive: true })
      await mkdir(incorrectPackageRoot, { recursive: true })
      await writeFile(importer, 'export {}')

      for (const [packageRoot, exportName] of [
        [correctPackageRoot, 'correct'],
        [incorrectPackageRoot, 'incorrect'],
      ] as const) {
        await writeFile(
          path.join(packageRoot, 'package.json'),
          JSON.stringify({ fict: { metadata: './index.fict.meta.json' } }),
        )
        await writeFile(
          path.join(packageRoot, 'index.fict.meta.json'),
          JSON.stringify({ version: 1, exports: { [exportName]: 'signal' } }),
        )
      }

      const { resolvePackageModuleMetadata } = await import('../src/graph-host')
      expect(resolvePackageModuleMetadata('fict-library', importer)).toEqual({
        version: 1,
        exports: { correct: 'signal' },
      })
    },
  )

  it('resolves packages from file URL importers with mixed-case schemes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-file-url-'))
    tempRoots.push(root)
    const importer = path.join(root, 'src', 'App.tsx')
    const packageRoot = path.join(root, 'node_modules', 'fict-library')
    await mkdir(path.dirname(importer), { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ fict: { metadata: './index.fict.meta.json' } }),
    )
    await writeFile(
      path.join(packageRoot, 'index.fict.meta.json'),
      JSON.stringify({ version: 1, exports: { value: 'signal' } }),
    )

    const importerUrl = pathToFileURL(importer).href.replace(/^file:/, 'FiLe:')
    const { resolvePackageModuleMetadata } = await import('../src/graph-host')
    expect(resolvePackageModuleMetadata('fict-library', importerUrl)).toEqual({
      version: 1,
      exports: { value: 'signal' },
    })
  })

  it('reports every missing package boundary candidate as a watch dependency', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-missing-package-'))
    tempRoots.push(root)
    const importer = path.join(root, 'workspace', 'src', 'App.tsx')
    await mkdir(path.dirname(importer), { recursive: true })
    await writeFile(importer, 'export {}')

    const { resolvePackageModuleMetadata } = await import('../src/graph-host')
    const dependencies: string[] = []
    expect(
      resolvePackageModuleMetadata('future-library', importer, {
        onDependency: dependency => dependencies.push(dependency),
      }),
    ).toBeUndefined()

    const expected: string[] = []
    let current = path.dirname(importer)
    while (true) {
      expected.push(path.join(current, 'node_modules', 'future-library', 'package.json'))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    expect(dependencies).toEqual(expected)
  })

  it.each([
    ['plain-library', {}, undefined, 'plain'],
    [
      'missing-metadata-library',
      { fict: { metadata: './missing.fict.meta.json' } },
      undefined,
      'missing',
    ],
    ['invalid-metadata-library', { fict: { metadata: './index.fict.meta.json' } }, '{', 'invalid'],
    [
      'outside-metadata-library',
      { fict: { metadata: '../outside.fict.meta.json' } },
      undefined,
      'invalid',
    ],
    ['invalid-config-library', { fict: { metadata: 42 } }, undefined, 'invalid'],
    [
      'invalid-exports-key-library',
      { fict: { exports: { hooks: './index.fict.meta.json' } } },
      undefined,
      'invalid',
    ],
    [
      'encoded-invalid-exports-key-library',
      { fict: { exports: { './%2e%2e/escape': './index.fict.meta.json' } } },
      undefined,
      'invalid',
    ],
  ])(
    'preserves the %s package metadata resolution state',
    async (packageName, manifest, metadataContents, expectedKind) => {
      const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-state-'))
      tempRoots.push(root)
      const importer = path.join(root, 'src', 'App.tsx')
      const packageRoot = path.join(root, 'node_modules', packageName as string)
      await mkdir(path.dirname(importer), { recursive: true })
      await mkdir(packageRoot, { recursive: true })
      await writeFile(importer, 'export {}')
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest))
      if (metadataContents !== undefined) {
        await writeFile(path.join(packageRoot, 'index.fict.meta.json'), metadataContents as string)
      }

      const { resolvePackageModuleMetadataState } = await import('../src/graph-host')
      expect(resolvePackageModuleMetadataState(packageName as string, importer)).toEqual({
        kind: expectedKind,
      })
    },
  )

  it('uses a host package boundary outside node_modules for PnP-style resolution', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-pnp-'))
    tempRoots.push(root)
    const importer = path.join(root, 'workspace', 'src', 'App.tsx')
    const packageRoot = path.join(root, '.pnp-store', 'virtual-hook')
    const packageJsonPath = path.join(packageRoot, 'package.json')
    const metadataPath = path.join(packageRoot, 'hook.fict.meta.json')
    await mkdir(path.dirname(importer), { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(importer, 'export {}')
    await writeFile(
      packageJsonPath,
      JSON.stringify({ fict: { exports: { './hook': './hook.fict.meta.json' } } }),
    )
    await writeFile(metadataPath, JSON.stringify({ version: 1, exports: { value: 'signal' } }))

    const { resolvePackageModuleMetadataState } = await import('../src/graph-host')
    const dependencies: string[] = []
    const requests: unknown[] = []
    expect(
      resolvePackageModuleMetadataState('virtual-hook/hook', importer, {
        onDependency: dependency => dependencies.push(dependency),
        resolvePackage: request => {
          requests.push(request)
          return { packageJsonPath }
        },
      }),
    ).toEqual({
      kind: 'resolved',
      metadata: { version: 1, exports: { value: 'signal' } },
    })
    expect(requests).toEqual([
      {
        source: 'virtual-hook/hook',
        importer,
        packageName: 'virtual-hook',
        publicSubpath: './hook',
      },
    ])
    expect(dependencies).toEqual([packageJsonPath, metadataPath])
  })

  it('accepts authoritative virtual package states without physical traversal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-virtual-'))
    tempRoots.push(root)
    const importer = path.join(root, 'src', 'App.tsx')
    await mkdir(path.dirname(importer), { recursive: true })
    await writeFile(importer, 'export {}')

    const { resolvePackageModuleMetadataState } = await import('../src/graph-host')
    expect(
      resolvePackageModuleMetadataState('virtual-hook', importer, {
        resolvePackage: () => ({
          kind: 'resolved',
          metadata: { version: 1, exports: { virtual: 'memo' } },
        }),
      }),
    ).toEqual({
      kind: 'resolved',
      metadata: { version: 1, exports: { virtual: 'memo' } },
    })
    expect(
      resolvePackageModuleMetadataState('missing-virtual-hook', importer, {
        resolvePackage: () => null,
      }),
    ).toEqual({ kind: 'missing' })
  })

  it('lets host resolution handle packages imported by virtual modules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fict-graph-host-virtual-importer-'))
    tempRoots.push(root)
    const packageJsonPath = path.join(root, 'virtual-hook', 'package.json')
    const metadataPath = path.join(root, 'virtual-hook', 'hook.fict.meta.json')
    await mkdir(path.dirname(packageJsonPath), { recursive: true })
    await writeFile(
      packageJsonPath,
      JSON.stringify({ fict: { exports: { './hook': './hook.fict.meta.json' } } }),
    )
    await writeFile(metadataPath, JSON.stringify({ version: 1, exports: { value: 'signal' } }))

    const { resolvePackageModuleMetadataState } = await import('../src/graph-host')
    const requests: unknown[] = []
    expect(
      resolvePackageModuleMetadataState('virtual-hook/hook', 'virtual:entry', {
        resolvePackage: request => {
          requests.push(request)
          return { packageJsonPath }
        },
      }),
    ).toEqual({
      kind: 'resolved',
      metadata: { version: 1, exports: { value: 'signal' } },
    })
    expect(requests).toEqual([
      {
        source: 'virtual-hook/hook',
        importer: 'virtual:entry',
        packageName: 'virtual-hook',
        publicSubpath: './hook',
      },
    ])
    expect(resolvePackageModuleMetadataState('virtual-hook', 'virtual:entry')).toEqual({
      kind: 'invalid',
    })
  })

  it('preserves a one-character hierarchical scheme importer for host resolution', async () => {
    const { resolvePackageModuleMetadataState } = await import('../src/graph-host')
    const requests: unknown[] = []

    expect(
      resolvePackageModuleMetadataState('virtual-hook', 'x://entry', {
        resolvePackage: request => {
          requests.push(request)
          return { kind: 'plain' }
        },
      }),
    ).toEqual({ kind: 'plain' })
    expect(requests).toEqual([
      {
        source: 'virtual-hook',
        importer: 'x://entry',
        packageName: 'virtual-hook',
        publicSubpath: '.',
      },
    ])
  })
})
