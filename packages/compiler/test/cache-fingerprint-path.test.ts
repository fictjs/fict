import { describe, expect, it } from 'vitest'

import { getLoadedModulePathFromStack } from '../src/cache-fingerprint'

const slashes = (value: string | null) => value?.replace(/\\/g, '/') ?? null

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
})
