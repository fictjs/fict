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
    expect(dependencies).toEqual([path.join(packageRoot, 'package.json'), metadataPath])
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
})
