import { afterEach, describe, expect, it, vi } from 'vitest'

const FORBIDDEN_RUNTIME_MODULES = [
  '@babel/core',
  '@babel/helper-plugin-utils',
  '@babel/parser',
  '@babel/traverse',
  '@babel/types',
] as const

afterEach(() => {
  for (const moduleId of FORBIDDEN_RUNTIME_MODULES) vi.doUnmock(moduleId)
  vi.resetModules()
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
})
