import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Configuration, RuleSetRule, RuleSetUseItem } from 'webpack'

import { createFixture, createWebpackConfiguration, runApp, runCompiler } from './fixture'

const decoratorLoweringLoader = fileURLToPath(
  new URL('./typescript-decorators-loader.cjs', import.meta.url),
)

function addDecoratorLowering(configuration: Configuration, legacy: boolean): void {
  const rule = configuration.module?.rules?.[0] as RuleSetRule | undefined
  if (!rule) throw new Error('Missing Fict fixture loader rule.')
  const fictLoaders = Array.isArray(rule.use)
    ? rule.use
    : rule.use
      ? ([rule.use] as RuleSetUseItem[])
      : []
  // Webpack executes loaders from right to left: Fict sees the original
  // decorators first and TypeScript lowers the preserved syntax afterwards.
  rule.use = [{ loader: decoratorLoweringLoader, options: { legacy } }, ...fictLoaders]
}

describe('@fictjs/webpack-plugin decorator handoff', () => {
  it('hands 2023-11 decorators to downstream lowering in a real build', async () => {
    const root = await createFixture({
      'entry.ts': `
        const calls: string[] = []
        function registered(value: unknown, context: { kind: string }) {
          calls.push(context.kind)
          if (context.kind === 'accessor') {
            return { init(initial: number) { return initial + 1 } }
          }
        }

        @registered
        export class BeforeExport {
          @registered accessor count: number = 1
        }

        export @registered class AfterExport {}

        export function App() {
          return new BeforeExport().count * 10 + calls.length
        }
      `,
    })

    try {
      const configuration = createWebpackConfiguration(root)
      addDecoratorLowering(configuration, false)
      await runCompiler(configuration)

      expect(runApp(root)).toBe(23)
      const bundle = await readFile(path.join(root, 'dist', 'bundle.cjs'), 'utf8')
      expect(bundle).not.toMatch(/@registered/)
      expect(bundle).toContain('__esDecorate')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lowers legacy parameter decorators natively before downstream TypeScript', async () => {
    const root = await createFixture({
      'entry.ts': `
        const calls: number[] = []
        function parameter(target: object, key: string, index: number): void {
          calls.push(index)
        }

        export class Model {
          read(@parameter value: number): number {
            return value
          }
        }

        export function App() {
          return calls.length * 10 + new Model().read(2)
        }
      `,
    })

    try {
      const configuration = createWebpackConfiguration(root)
      addDecoratorLowering(configuration, true)
      await runCompiler(configuration)

      expect(runApp(root)).toBe(12)
      const bundle = await readFile(path.join(root, 'dist', 'bundle.cjs'), 'utf8')
      expect(bundle).not.toMatch(/@parameter/)
      expect(bundle).toContain('decorateParam')
      expect(bundle).toContain('decorate')
      expect(bundle).not.toContain('__param')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
