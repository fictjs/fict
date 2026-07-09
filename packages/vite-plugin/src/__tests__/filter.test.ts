import { describe, expect, it, vi } from 'vitest'

import fict from '..'

function createTransformPlugin(options: Parameters<typeof fict>[0] = {}) {
  const plugin = fict({
    cache: false,
    functionSplitting: false,
    useTypeScriptProject: false,
    ...options,
  }) as any
  const context = {
    emitFile: vi.fn(),
    error(error: unknown): never {
      throw error instanceof Error ? error : new Error(String(error))
    },
    warn: vi.fn(),
  }
  return { context, plugin }
}

describe('vite plugin transform filter', () => {
  it('honors nested include and exclude globs', async () => {
    const { context, plugin } = createTransformPlugin({
      include: ['**/src/**/*.tsx'],
      exclude: ['**/src/**/generated/**'],
    })
    const source = 'export function App() { return <div /> }'

    await expect(
      plugin.transform.call(context, source, '/workspace/src/features/App.tsx'),
    ).resolves.toMatchObject({ code: expect.any(String) })
    await expect(
      plugin.transform.call(context, source, '/workspace/src/generated/App.tsx'),
    ).resolves.toBeNull()
    await expect(
      plugin.transform.call(context, source, '/workspace/test/App.tsx'),
    ).resolves.toBeNull()
  })

  it('excludes dependency files with the default node_modules glob', async () => {
    const { context, plugin } = createTransformPlugin()

    await expect(
      plugin.transform.call(
        context,
        'export function App() { return <div /> }',
        '/workspace/node_modules/example/App.tsx',
      ),
    ).resolves.toBeNull()
  })

  it.each(['types.d.ts?import', 'types.d.mts?raw', 'types.d.cts#raw'])(
    'never transforms TypeScript declaration request %s',
    async request => {
      const { context, plugin } = createTransformPlugin({ include: ['**/*'] })

      await expect(
        plugin.transform.call(
          context,
          'export declare function useCounter(): number',
          `/workspace/src/${request}`,
        ),
      ).resolves.toBeNull()
    },
  )
})
