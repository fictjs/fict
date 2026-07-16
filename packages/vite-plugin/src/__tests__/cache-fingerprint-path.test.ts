import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readLoadedPluginArtifact } from '../cache-fingerprint'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('vite plugin cache fingerprint artifact resolution', () => {
  it('reads source and dist artifacts for source-map-remapped source frames', async () => {
    const root = await makePackageFixture({
      source: 'source cache helper should not be fingerprinted',
      esm: 'esm plugin artifact v1',
      cjs: 'cjs plugin artifact v1',
    })
    const stack = [
      'Error',
      `    at readLoadedPluginArtifact (${path.join(root, 'src', 'cache-fingerprint.ts')}:10:5)`,
    ].join('\n')

    const artifact = readLoadedPluginArtifact(stack)

    expect(artifact).toContain('esm plugin artifact v1')
    expect(artifact).toContain('cjs plugin artifact v1')
    expect(artifact).toContain('source cache helper should not be fingerprinted')
  })

  it('reads dist artifacts when remapped source files are not shipped', async () => {
    const root = await makePackageFixture({
      source: null,
      esm: 'esm plugin artifact v1',
      cjs: 'cjs plugin artifact v1',
    })
    const stack = [
      'Error',
      `    at readLoadedPluginArtifact (${path.join(root, 'src', 'cache-fingerprint.ts')}:10:5)`,
    ].join('\n')

    const artifact = readLoadedPluginArtifact(stack)

    expect(artifact).toContain('esm plugin artifact v1')
    expect(artifact).toContain('cjs plugin artifact v1')
  })

  it('changes when remapped dist artifacts change', async () => {
    const firstRoot = await makePackageFixture({
      source: 'same source helper',
      esm: 'esm plugin artifact v1',
      cjs: 'cjs plugin artifact v1',
    })
    const secondRoot = await makePackageFixture({
      source: 'same source helper',
      esm: 'esm plugin artifact v2',
      cjs: 'cjs plugin artifact v2',
    })

    const first = readLoadedPluginArtifact(remappedStack(firstRoot))
    const second = readLoadedPluginArtifact(remappedStack(secondRoot))

    expect(first).not.toBe(second)
  })

  it('changes when sibling source artifacts change while dist is stale', async () => {
    const firstRoot = await makePackageFixture({
      source: null,
      cacheSource: 'same cache helper',
      indexSource: 'index source v1',
      esm: 'same esm plugin artifact',
      cjs: 'same cjs plugin artifact',
    })
    const secondRoot = await makePackageFixture({
      source: null,
      cacheSource: 'same cache helper',
      indexSource: 'index source v2',
      esm: 'same esm plugin artifact',
      cjs: 'same cjs plugin artifact',
    })

    const first = readLoadedPluginArtifact(cacheHelperStack(firstRoot))
    const second = readLoadedPluginArtifact(cacheHelperStack(secondRoot))

    expect(first).not.toBe(second)
  })

  it('changes when cache helper source changes from index remapped frames', async () => {
    const firstRoot = await makePackageFixture({
      source: null,
      cacheSource: 'cache helper v1',
      indexSource: 'same index source',
      esm: 'same esm plugin artifact',
      cjs: 'same cjs plugin artifact',
    })
    const secondRoot = await makePackageFixture({
      source: null,
      cacheSource: 'cache helper v2',
      indexSource: 'same index source',
      esm: 'same esm plugin artifact',
      cjs: 'same cjs plugin artifact',
    })

    const first = readLoadedPluginArtifact(remappedStack(firstRoot))
    const second = readLoadedPluginArtifact(remappedStack(secondRoot))

    expect(first).not.toBe(second)
  })
})

async function makePackageFixture(files: {
  source: string | null
  cacheSource?: string | null
  indexSource?: string | null
  esm: string
  cjs: string
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fict-vite-plugin-artifact-'))
  tempRoots.push(root)
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'dist'), { recursive: true })
  const cacheSource = files.cacheSource ?? files.source
  const indexSource = files.indexSource ?? null
  if (cacheSource !== null) {
    await writeFile(path.join(root, 'src', 'cache-fingerprint.ts'), cacheSource)
  }
  if (indexSource !== null) {
    await writeFile(path.join(root, 'src', 'index.ts'), indexSource)
  }
  await writeFile(path.join(root, 'dist', 'index.js'), files.esm)
  await writeFile(path.join(root, 'dist', 'index.cjs'), files.cjs)
  return root
}

function cacheHelperStack(root: string): string {
  return [
    'Error',
    `    at readLoadedPluginArtifact (${path.join(root, 'src', 'cache-fingerprint.ts')}:10:5)`,
  ].join('\n')
}

function remappedStack(root: string): string {
  return [
    'Error',
    `    at readLoadedPluginArtifact (${path.join(root, 'src', 'index.ts')}:10:5)`,
  ].join('\n')
}
