import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { createFixture, createWebpackConfiguration, runApp, runCompiler } from './fixture'

describe('@fictjs/webpack-plugin cold metadata graph', () => {
  it('compiles CommonJS entries with a legal top-level return', async () => {
    const root = await createFixture({
      'entry.cjs': `
        if (globalThis.__fictSkipCommonJsEntry) return
        module.exports.App = () => 42
      `,
    })

    try {
      const configuration = createWebpackConfiguration(root)
      configuration.entry = './entry.cjs'
      configuration.resolve = { ...configuration.resolve, extensions: ['.cjs', '.js'] }

      await runCompiler(configuration)
      expect(runApp(root)).toBe(42)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rebuilds an importer after its hook metadata becomes available', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useCounter } from './use-counter'
        export function App() {
          const count = useCounter()
          return count * 2
        }
      `,
      'use-counter.ts': `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(1)
          return count
        }
      `,
    })

    try {
      await runCompiler(createWebpackConfiguration(root))
      expect(runApp(root)).toBe(2)
      const bundle = await readFile(path.join(root, 'dist', 'bundle.cjs'), 'utf8')
      expect(bundle).toMatch(/count\(\) \* 2/)
      expect(bundle).not.toMatch(/return count \* 2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('converges hook metadata through an aliased circular barrel', async () => {
    const root = await createFixture({
      'entry.ts': `
          import { useCounter } from '@hooks'
          export function App() {
            const count = useCounter()
            return count * 2
          }
        `,
      'hooks/index.ts': `
          export { useCounter } from './use-counter'
          export const marker = 1
        `,
      'hooks/use-counter.ts': `
          import { $state } from 'fict'
          import { marker } from './index'
          export function useCounter() {
            const count = $state(marker)
            return count
          }
        `,
    })

    try {
      await runCompiler(
        createWebpackConfiguration(root, { alias: { '@hooks': path.join(root, 'hooks') } }),
      )
      expect(runApp(root)).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
