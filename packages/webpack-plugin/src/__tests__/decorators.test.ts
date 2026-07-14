import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformSync, type PluginObj, type TransformOptions } from '@babel/core'
import type * as BabelCore from '@babel/core'
import fictPreset from '@fictjs/babel-preset'
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

type BabelParser = (source: string, options: BabelCore.ParserOptions) => BabelCore.types.File

type AstParserOverridePlugin = PluginObj & {
  parserOverride(
    source: string,
    parserOptions: BabelCore.ParserOptions,
    parse: BabelParser,
  ): BabelCore.types.File
}

function siblingAstParserOverride(): AstParserOverridePlugin {
  return {
    name: 'test-sibling-ast-parser-override',
    visitor: {},
    parserOverride(source, parserOptions, parse) {
      return parse(source, parserOptions)
    },
  }
}

function transformWithPreset(
  source: string,
  filename: string,
  plugins: NonNullable<TransformOptions['plugins']> = [],
  parserOpts?: BabelCore.ParserOptions,
): string {
  const result = transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    plugins,
    parserOpts,
    presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
  })
  if (!result?.code) throw new Error('Babel returned no output.')
  return result.code
}

describe('@fictjs/babel-preset decorator parsing', () => {
  it('preserves 2023-11 decorators before and after export, including auto-accessors', () => {
    const code = transformWithPreset(
      `
        function registered(value: unknown, context: unknown): void {}

        @registered
        export class BeforeExport {
          @registered accessor count: number = 1
        }

        export @registered class AfterExport {
          @registered accessor count: number = 2
        }
      `,
      'decorated.ts',
    )

    expect(code.match(/@registered/g)).toHaveLength(4)
    expect(code).toContain('accessor count = 1')
    expect(code).toContain('accessor count = 2')
    expect(code).not.toContain(': number')
    expect(code).not.toContain(': unknown')
  })

  it('preserves legacy TypeScript parameter decorators after type lowering', () => {
    const code = transformWithPreset(
      `
        function parameter(target: object, key: string, index: number): void {}
        export class Model {
          read(@parameter value: number): number {
            return value
          }
        }
      `,
      'legacy-parameter.ts',
    )

    expect(code).toMatch(/read\(\s*@parameter\s+value\s*\)/)
    expect(code).not.toContain(': number')
    expect(code).not.toContain(': object')
  })

  it('composes standard decorators with a sibling AST parser override', () => {
    const code = transformWithPreset(
      `
        function registered(value: unknown, context: unknown): void {}
        export @registered class Model {
          @registered accessor count: number = 1
        }
      `,
      'sibling-standard.ts',
      [siblingAstParserOverride()],
    )

    expect(code.match(/@registered/g)).toHaveLength(2)
    expect(code).toContain('accessor count = 1')
    expect(code).not.toContain(': number')
  })

  it('composes legacy parameter decorators with a sibling AST parser override', () => {
    const code = transformWithPreset(
      `
        function parameter(target: object, key: string, index: number): void {}
        export class Model {
          read(@parameter value: number): number {
            return value
          }
        }
      `,
      'sibling-legacy.ts',
      [siblingAstParserOverride()],
    )

    expect(code).toMatch(/read\(\s*@parameter\s+value\s*\)/)
    expect(code).not.toContain(': number')
  })

  it('does not swallow other recoverable parser errors', () => {
    let capturedError: unknown
    try {
      transformWithPreset('break;', 'recoverable-error.js')
    } catch (error) {
      capturedError = error
    }

    expect(capturedError).toMatchObject({
      code: 'BABEL_PARSER_SYNTAX_ERROR',
      reasonCode: 'IllegalBreakContinue',
    })
    expect(capturedError).toBeInstanceOf(SyntaxError)
    expect((capturedError as Error).message).toContain('Unsyntactic break')
  })

  it('does not swallow non-recoverable parser errors', () => {
    expect(() => transformWithPreset('export const broken = ;', 'syntax-error.js')).toThrow(
      /Unexpected token/,
    )
  })

  it('leaves an explicit decorator parser profile authoritative', () => {
    expect(() =>
      transformWithPreset('export @registered class Model {}', 'explicit-legacy.js', [], {
        plugins: ['decorators-legacy'],
      }),
    ).toThrow(/Unexpected token/)
    expect(() =>
      transformWithPreset('class Model { read(@parameter value) {} }', 'explicit-standard.js', [], {
        plugins: ['decorators'],
      }),
    ).toThrow(/Decorators cannot be used to decorate parameters/)
  })

  it('preserves standard decorators in JavaScript and JSX files', () => {
    const code = transformWithPreset(
      `
        function registered(value, context) {}
        export @registered class View {
          @registered accessor label = 'ready'
          render() {
            return <span>{this.label}</span>
          }
        }
      `,
      'decorated.jsx',
    )

    expect(code.match(/@registered/g)).toHaveLength(2)
    expect(code).toContain('accessor label =')
    expect(code).toContain('fict/internal')
    expect(code).not.toMatch(/return\s*<span/)
  })

  it('selects decorator profiles independently for implicit metadata dependencies', async () => {
    const root = await createFixture({
      'entry.ts': `
        import { useDecorated } from './hook'
        import { useLegacy } from './legacy-hook'
        export function App() {
          return useDecorated() * 2 + useLegacy()
        }
      `,
      'hook.ts': `
        function registered(value: unknown, context: unknown): void {}
        @registered export class Model {
          @registered accessor count: number = 1
        }
        export function useDecorated() {
          return new Model().count
        }
      `,
      'legacy-hook.ts': `
        function parameter(target: object, key: string, index: number): void {}
        class LegacyModel {
          read(@parameter value: number): number {
            return value
          }
        }
        export function useLegacy() {
          return new LegacyModel().read(1)
        }
      `,
    })

    try {
      const source = await readFile(path.join(root, 'entry.ts'), 'utf8')
      const code = transformWithPreset(source, path.join(root, 'entry.ts'))
      expect(code).toContain('useDecorated() * 2 + useLegacy()')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

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
