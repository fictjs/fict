import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import type { RuleSetRule, RuleSetUseItem } from 'webpack'

import { createFixture, createWebpackConfiguration, runApp, runCompiler } from './fixture'

const inputSourceMapLoader = fileURLToPath(
  new URL('./input-source-map-loader.cjs', import.meta.url),
)

function generatedPosition(source: string, needle: string): { line: number; column: number } {
  const offset = source.indexOf(needle)
  if (offset < 0) throw new Error(`Generated bundle does not contain ${JSON.stringify(needle)}.`)
  const prefix = source.slice(0, offset)
  const lines = prefix.split('\n')
  return { line: lines.length, column: lines[lines.length - 1]?.length ?? 0 }
}

describe('@fictjs/webpack-plugin native transform', () => {
  it('composes an upstream loader source map through native code generation', async () => {
    const root = await createFixture({
      'entry.ts': 'export function App() {\n  return 42\n}\n',
    })

    try {
      const configuration = createWebpackConfiguration(root)
      configuration.devtool = 'source-map'
      const rule = configuration.module?.rules?.[0] as RuleSetRule | undefined
      if (!rule) throw new Error('Fixture loader rule is missing.')
      const fictLoaders = Array.isArray(rule.use)
        ? rule.use
        : rule.use
          ? ([rule.use] as RuleSetUseItem[])
          : []
      rule.use = [...fictLoaders, { loader: inputSourceMapLoader }]

      await runCompiler(configuration)
      expect(runApp(root)).toBe(42)

      const bundle = await readFile(path.join(root, 'dist', 'bundle.cjs'), 'utf8')
      const sourceMap = JSON.parse(
        await readFile(path.join(root, 'dist', 'bundle.cjs.map'), 'utf8'),
      ) as ConstructorParameters<typeof TraceMap>[0]
      const original = originalPositionFor(
        new TraceMap(sourceMap),
        generatedPosition(bundle, 'return 42'),
      )
      expect(original.source).toMatch(/entry\.ts$/)
      expect(original.line).toBe(2)
      expect(original.column).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores consumer Babel configuration and plugins', async () => {
    const root = await createFixture({
      '.babelrc': JSON.stringify({ plugins: ['./throwing-babel-plugin.cjs'] }),
      'throwing-babel-plugin.cjs': "throw new Error('consumer Babel config was loaded')",
      'entry.ts': 'export function App(): number { return 42 }',
    })

    try {
      await runCompiler(createWebpackConfiguration(root))
      expect(runApp(root)).toBe(42)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
