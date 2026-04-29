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
const splitFileName = '/project/src/Counter.tsx'
const compiledHandlerModule = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
`

afterEach(() => {
  vi.doUnmock('@fictjs/compiler')
  vi.doUnmock('../cache-fingerprint')
  vi.resetModules()
})

describe('vite-plugin transform cache fingerprint', () => {
  it('invalidates persistent cache entries when the compiler fingerprint changes', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'fict-vite-cache-'))

    try {
      await transformWithFingerprints('compiler-a', 'plugin-a', cacheDir)
      const firstEntries = await readdir(cacheDir)
      expect(firstEntries).toHaveLength(1)

      await transformWithFingerprints('compiler-b', 'plugin-a', cacheDir)
      const secondEntries = await readdir(cacheDir)
      expect(secondEntries).toHaveLength(2)
      expect(new Set(secondEntries).size).toBe(2)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('invalidates persistent cache entries when the plugin fingerprint changes', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'fict-vite-cache-'))

    try {
      await transformWithFingerprints('compiler-a', 'plugin-a', cacheDir)
      const firstEntries = await readdir(cacheDir)
      expect(firstEntries).toHaveLength(1)

      await transformWithFingerprints('compiler-a', 'plugin-b', cacheDir)
      const secondEntries = await readdir(cacheDir)
      expect(secondEntries).toHaveLength(2)
      expect(new Set(secondEntries).size).toBe(2)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('does not reuse split cache entries for non-split transforms', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'fict-vite-cache-'))

    try {
      const split = await transformWithSplitMode(true, cacheDir)
      const inline = await transformWithSplitMode(false, cacheDir)
      const entries = await readdir(cacheDir)

      expect(split.code).toContain('virtual:fict-handler:')
      expect(inline.code).toContain("__fictQrl(import.meta.url, '__fict_e0')")
      expect(entries).toHaveLength(2)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('does not reuse non-split cache entries for split transforms', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'fict-vite-cache-'))

    try {
      const inline = await transformWithSplitMode(false, cacheDir)
      const split = await transformWithSplitMode(true, cacheDir)
      const entries = await readdir(cacheDir)

      expect(inline.code).toContain("__fictQrl(import.meta.url, '__fict_e0')")
      expect(split.code).toContain('virtual:fict-handler:')
      expect(entries).toHaveLength(2)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

async function transformWithFingerprints(
  compilerFingerprint: string,
  pluginFingerprint: string,
  cacheDir: string,
) {
  vi.resetModules()
  vi.doMock('@fictjs/compiler', () => ({
    COMPILER_CACHE_FINGERPRINT: compilerFingerprint,
    createFictPlugin: () => ({
      name: 'mock-fict-compiler',
      visitor: {},
    }),
  }))
  vi.doMock('../cache-fingerprint', () => ({
    createVitePluginCacheFingerprint: () => pluginFingerprint,
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

async function transformWithSplitMode(
  shouldSplit: boolean,
  cacheDir: string,
): Promise<TransformResult> {
  vi.resetModules()
  vi.doUnmock('@fictjs/compiler')
  vi.doUnmock('../cache-fingerprint')

  const { default: fict } = await import('..')
  const plugin = fict({
    functionSplitting: shouldSplit,
    cache: {
      persistent: true,
      dir: cacheDir,
    },
  })

  runConfigResolved(plugin)
  const result = await runTransform(plugin, compiledHandlerModule, splitFileName)
  expectTransformResult(result)
  return result
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
