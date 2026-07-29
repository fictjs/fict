import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

    const { resolvePackageModuleMetadata } = await import('../src/graph-host')
    const dependencies: string[] = []
    expect(
      resolvePackageModuleMetadata('fict-library', importer, {
        onDependency: dependency => dependencies.push(dependency),
      }),
    ).toEqual({ version: 1, exports: { count: 'signal' } })
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

  it.each(['@scope/.', '@scope/..', '@scope/../x', '@scope\\escape/package'])(
    'rejects non-canonical package request %s before reading a manifest',
    async source => {
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
    },
  )

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
})
