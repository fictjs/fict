import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { getLoadedModulePathFromStack, readLoadedCompilerArtifact } from '../src/cache-fingerprint'

const slashes = (value: string | null) => value?.replace(/\\/g, '/') ?? null
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('compiler cache fingerprint stack parsing', () => {
  it('extracts POSIX paths from stack frames', () => {
    const stack = [
      'Error',
      '    at readLoadedCompilerArtifact (/repo/packages/compiler/dist/index.js:10:5)',
    ].join('\n')

    expect(getLoadedModulePathFromStack(stack)).toBe('/repo/packages/compiler/dist/index.js')
  })

  it('extracts POSIX file URLs from stack frames', () => {
    const stack = [
      'Error',
      '    at readLoadedCompilerArtifact (file:///repo/packages/compiler/dist/index.js:10:5)',
    ].join('\n')

    expect(getLoadedModulePathFromStack(stack)).toBe('/repo/packages/compiler/dist/index.js')
  })

  it('extracts Windows drive-letter paths from stack frames', () => {
    const stack = [
      'Error',
      '    at readLoadedCompilerArtifact (C:\\repo\\packages\\compiler\\dist\\index.cjs:10:5)',
    ].join('\n')

    expect(getLoadedModulePathFromStack(stack)).toBe(
      'C:\\repo\\packages\\compiler\\dist\\index.cjs',
    )
  })

  it('extracts Windows file URLs from stack frames', () => {
    const stack = [
      'Error',
      '    at readLoadedCompilerArtifact (file:///C:/repo/packages/compiler/dist/index.js:10:5)',
    ].join('\n')

    expect(slashes(getLoadedModulePathFromStack(stack))).toContain(
      'C:/repo/packages/compiler/dist/index.js',
    )
  })

  it('skips node internal frames before choosing a module path', () => {
    const stack = [
      'Error',
      '    at run (node:internal/modules/esm/module_job:10:5)',
      '    at readLoadedCompilerArtifact (/repo/packages/compiler/dist/index.js:10:5)',
    ].join('\n')

    expect(getLoadedModulePathFromStack(stack)).toBe('/repo/packages/compiler/dist/index.js')
  })

  it('reads source and dist artifacts for source-map-remapped compiler frames', async () => {
    const root = await makePackageFixture({
      source: 'source compiler helper v1',
      esm: 'esm compiler artifact v1',
      cjs: 'cjs compiler artifact v1',
    })
    const stack = [
      'Error',
      `    at readLoadedCompilerArtifact (${path.join(root, 'src', 'cache-fingerprint.ts')}:10:5)`,
    ].join('\n')

    const artifact = readLoadedCompilerArtifact(stack)

    expect(artifact).toContain('source compiler helper v1')
    expect(artifact).toContain('esm compiler artifact v1')
    expect(artifact).toContain('cjs compiler artifact v1')
  })

  it('reads dist artifacts when remapped compiler source files are not shipped', async () => {
    const root = await makePackageFixture({
      source: null,
      esm: 'esm compiler artifact v1',
      cjs: 'cjs compiler artifact v1',
    })
    const stack = [
      'Error',
      `    at readLoadedCompilerArtifact (${path.join(root, 'src', 'index.ts')}:10:5)`,
    ].join('\n')

    const artifact = readLoadedCompilerArtifact(stack)

    expect(artifact).toContain('esm compiler artifact v1')
    expect(artifact).toContain('cjs compiler artifact v1')
  })
})

async function makePackageFixture(files: {
  source: string | null
  esm: string
  cjs: string
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fict-compiler-artifact-'))
  tempRoots.push(root)
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'dist'), { recursive: true })
  if (files.source !== null) {
    await writeFile(path.join(root, 'src', 'cache-fingerprint.ts'), files.source)
  }
  await writeFile(path.join(root, 'dist', 'index.js'), files.esm)
  await writeFile(path.join(root, 'dist', 'index.cjs'), files.cjs)
  return root
}
