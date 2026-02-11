import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolveAssetsRoot } from '../src/server/http-server'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(testDir, '..')
const workspaceRoot = path.resolve(packageRoot, '..', '..')
const expectedAssetsRoot = path.resolve(packageRoot, 'src/web')

describe('resolveAssetsRoot', () => {
  it('finds web assets for dist runtime when cwd is package root', () => {
    const distModuleUrl = pathToFileURL(path.join(packageRoot, 'dist', 'chunk-runtime.js')).href
    const resolved = resolveAssetsRoot({
      importMetaUrl: distModuleUrl,
      cwd: packageRoot,
      env: {},
    })

    expect(path.normalize(resolved)).toBe(path.normalize(expectedAssetsRoot))
  })

  it('finds web assets for dist runtime when cwd is workspace root', () => {
    const distModuleUrl = pathToFileURL(path.join(packageRoot, 'dist', 'chunk-runtime.js')).href
    const resolved = resolveAssetsRoot({
      importMetaUrl: distModuleUrl,
      cwd: workspaceRoot,
      env: {},
    })

    expect(path.normalize(resolved)).toBe(path.normalize(expectedAssetsRoot))
  })
})
