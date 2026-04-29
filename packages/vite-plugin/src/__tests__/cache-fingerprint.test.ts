import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Plugin, ResolvedConfig, TransformResult } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockBuildConfig = {
  command: 'build',
  mode: 'production',
  root: '/project',
  base: '/',
  build: { ssr: false },
  resolve: { alias: [] },
} as ResolvedConfig

const sample = 'export const value: number = 1'
const fileName = '/project/src/Plain.tsx'

afterEach(() => {
  vi.doUnmock('@fictjs/compiler')
  vi.resetModules()
})

describe('vite-plugin transform cache fingerprint', () => {
  it('invalidates persistent cache entries when the compiler fingerprint changes', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'fict-vite-cache-'))

    try {
      await transformWithCompilerFingerprint('compiler-a', cacheDir)
      const firstEntries = await readdir(cacheDir)
      expect(firstEntries).toHaveLength(1)

      await transformWithCompilerFingerprint('compiler-b', cacheDir)
      const secondEntries = await readdir(cacheDir)
      expect(secondEntries).toHaveLength(2)
      expect(new Set(secondEntries).size).toBe(2)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

async function transformWithCompilerFingerprint(fingerprint: string, cacheDir: string) {
  vi.resetModules()
  vi.doMock('@fictjs/compiler', () => ({
    COMPILER_CACHE_FINGERPRINT: fingerprint,
    createFictPlugin: () => ({
      name: 'mock-fict-compiler',
      visitor: {},
    }),
  }))

  const { default: fict } = await import('..')
  const plugin = fict({
    cache: {
      persistent: true,
      dir: cacheDir,
    },
  })

  runConfigResolved(plugin)
  const result = await runTransform(plugin, sample, fileName)
  expectTransformResult(result)
}

function runConfigResolved(plugin: Plugin): void {
  const hook = plugin.configResolved
  if (typeof hook === 'function') {
    hook.call(undefined, mockBuildConfig)
  } else if (hook) {
    hook.handler.call(undefined, mockBuildConfig)
  }
}

async function runTransform(plugin: Plugin, code: string, id: string): Promise<unknown> {
  const hook = plugin.transform
  if (!hook) throw new Error('Expected transform hook')
  const context = {
    error(error: unknown): never {
      throw error instanceof Error ? error : new Error(String(error))
    },
    warn(error: unknown): void {
      throw error instanceof Error ? error : new Error(String(error))
    },
    emitFile(): string {
      return 'mock-file-id'
    },
  }

  if (typeof hook === 'function') {
    return hook.call(context, code, id)
  }
  return hook.handler.call(context, code, id)
}

function expectTransformResult(result: unknown): asserts result is TransformResult {
  expect(result && typeof result === 'object').toBe(true)
  expect(result).toHaveProperty('code')
}
