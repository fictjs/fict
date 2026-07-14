import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { build, transformWithEsbuild } from 'vite'
import { describe, expect, it, vi } from 'vitest'

import createFictVitePlugin from '..'

function fict(
  options?: Parameters<typeof createFictVitePlugin>[0],
): ReturnType<typeof createFictVitePlugin> {
  return createFictVitePlugin({ backend: 'legacy', ...options })
}

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
      throw error
    },
    warn: vi.fn(),
  }
  return { context, plugin }
}

async function captureTransformError(transform: Promise<unknown>) {
  try {
    await transform
  } catch (error) {
    expect(error).toEqual(expect.objectContaining({ message: expect.any(String) }))
    return error as {
      message: string
      cause?: unknown
    }
  }
  throw new Error('Expected the transform to reject.')
}

function expectBabelParseCause(error: { cause?: unknown }) {
  expect(error.cause).toBeInstanceOf(SyntaxError)
  return error.cause as SyntaxError & {
    code?: string
    reasonCode?: string
    loc?: { line: number; column: number }
  }
}

describe('decorator parser integration', () => {
  it.each(['js', 'jsx', 'ts', 'tsx'])(
    'preserves standard decorators and auto-accessors in .%s compiler stages',
    async extension => {
      const { context, plugin } = createTransformPlugin()
      const rendered = extension.endsWith('x') ? '<button>{count}</button>' : 'count'
      const source = `
        import { $state } from 'fict'

        function tracked(value, _context) {
          return value
        }

        @tracked
        export class BeforeExport {}

        export @tracked class AfterExport {
          @tracked accessor current = 1
        }

        export function App() {
          const count = $state(1)
          return ${rendered}
        }
      `

      const result = await plugin.transform.call(
        context,
        source,
        `/workspace/src/decorated.${extension}`,
      )

      expect(result.code).toContain('@tracked')
      expect(result.code).toContain('accessor current')
      expect(result.code).not.toContain('$state')
    },
  )

  it.each(['js', 'jsx', 'ts', 'tsx'])(
    'preserves legacy parameter decorators in .%s compiler stages',
    async extension => {
      const { context, plugin } = createTransformPlugin()
      const typeAnnotation = extension.startsWith('ts') ? ': number' : ''
      const source = `
        function injected(_target, _key, _index) {}

        export class Service {
          @injected accessor current = 1

          method(@injected value${typeAnnotation}) {
            return value + this.current
          }
        }
      `

      const result = await plugin.transform.call(
        context,
        source,
        `/workspace/src/legacy.${extension}`,
      )

      expect(result.code).toMatch(/method\(@injected\s+value/)
      expect(result.code).toMatch(/@injected\s+accessor current/)
      expect(result.code).not.toContain(': number')
    },
  )

  it('reports a syntax error after a legacy parameter decorator from the legacy parse', async () => {
    const { context, plugin } = createTransformPlugin()
    const source = [
      'function dec() {}',
      'class Service { method(@dec value) { return value + ; } }',
    ].join('\n')

    const transformError = await captureTransformError(
      plugin.transform.call(context, source, '/workspace/src/legacy-typo.js'),
    )
    const error = expectBabelParseCause(transformError)

    expect(error).toMatchObject({
      code: 'BABEL_PARSE_ERROR',
      reasonCode: 'UnexpectedToken',
      loc: { line: 2, column: 52 },
    })
    expect(error.message).toContain('Unexpected token (2:52)')
  })

  it('reports mixed standard and legacy decorator grammar from the legacy parse', async () => {
    const { context, plugin } = createTransformPlugin()
    const source = [
      'function dec() {}',
      'class Service { method(@dec value) {} }',
      'export @dec class Model {}',
    ].join('\n')

    const transformError = await captureTransformError(
      plugin.transform.call(context, source, '/workspace/src/mixed-decorators.js'),
    )
    const error = expectBabelParseCause(transformError)

    expect(error).toMatchObject({
      code: 'BABEL_PARSE_ERROR',
      reasonCode: 'UnexpectedToken',
      loc: { line: 3, column: 7 },
    })
    expect(error.message).toContain('Unexpected token, expected "{" (3:7)')
  })

  it('uses the same legacy error selection while parsing precompiled handlers', async () => {
    const { context, plugin } = createTransformPlugin({ functionSplitting: true })
    const source = [
      'function dec() {}',
      'class Service { method(@dec value) {} }',
      'export @dec class Model {}',
      'export const __fict_e0 = () => {}',
      "__fictQrl(import.meta.url, '__fict_e0')",
    ].join('\n')

    await plugin.transform.call(context, source, '/workspace/src/precompiled-mixed.js')

    expect(context.warn).toHaveBeenCalledOnce()
    const warning = String(context.warn.mock.calls[0]?.[0])
    expect(warning).toContain('Unexpected token, expected "{" (3:7)')
    expect(warning).not.toContain('Decorators cannot be used to decorate parameters')
  })

  it('leaves standard decorator semantics to Vite lowering', async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'fict-vite-decorator-semantics-')),
    )
    const entry = path.join(root, 'decorated.js')

    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'decorator-semantics-fixture', version: '1.0.0', private: true }),
      )
      await writeFile(
        entry,
        `
          function tracked(value, context) {
            if (context.kind === 'class') {
              value.tracked = true
              return value
            }
            return { init(initial) { return initial + 1 } }
          }

          @tracked
          export class BeforeExport {}

          export @tracked class AfterExport {
            @tracked accessor current = 1
          }

          export const semanticsPreserved =
            BeforeExport.tracked === true &&
            AfterExport.tracked === true &&
            new AfterExport().current === 2
        `,
      )

      const result = await build({
        root,
        logLevel: 'silent',
        plugins: [
          fict({ cache: false, functionSplitting: false, useTypeScriptProject: false }),
          {
            name: 'test-standard-decorator-lowering',
            enforce: 'post',
            transform(code, id) {
              if (id.split('?')[0] !== entry) return null
              return transformWithEsbuild(code, id, {
                loader: 'js',
                target: 'es2020',
                format: 'esm',
              })
            },
          },
        ],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'decorated.js' },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const code = outputs
        .flatMap(output => ('output' in output ? output.output : []))
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
      const builtModule = (await import(moduleUrl)) as { semanticsPreserved: boolean }

      expect(code).not.toContain('@tracked')
      expect(builtModule.semanticsPreserved).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds standard decorated hook dependencies through metadata and handler splitting', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-vite-decorators-')))
    const sourceDir = path.join(root, 'src')
    const entry = path.join(sourceDir, 'App.tsx')

    try {
      await mkdir(sourceDir, { recursive: true })
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'decorator-fixture', version: '1.0.0', private: true }),
      )
      await writeFile(
        path.join(sourceDir, 'use-count.ts'),
        `
          import { $state } from 'fict'

          function tracked(value, context) {
            if (context.kind === 'accessor') {
              return { init(initial) { return initial + 1 } }
            }
            return value
          }

          @tracked
          export class BeforeExport {}

          export @tracked class Model {
            @tracked accessor current = 1
          }

          export function useCount() {
            const count = $state(new Model().current)
            return count
          }
        `,
      )
      await writeFile(
        entry,
        `
          import { useCount } from './use-count'

          export function App() {
            const count = useCount()
            return <button onClick$={() => count++}>{count * 2}</button>
          }
        `,
      )

      const result = await build({
        root,
        logLevel: 'silent',
        plugins: [
          fict({
            cache: false,
            functionSplitting: true,
            resumable: true,
            useTypeScriptProject: false,
          }),
        ],
        build: {
          write: false,
          lib: { entry, formats: ['es'], fileName: () => 'app.js' },
          rollupOptions: { external: id => id === 'fict' || id.startsWith('fict/') },
        },
      })
      const outputs = Array.isArray(result) ? result : [result]
      const artifacts = outputs.flatMap(output => ('output' in output ? output.output : []))
      const code = artifacts
        .filter(output => output.type === 'chunk')
        .map(output => output.code)
        .join('\n')

      expect(code).not.toContain('@tracked')
      expect(code).not.toContain('$state')
      expect(code).toMatch(/\(\)\s*=>\s*[\w$]+\(\)\s*\*\s*2/)
      expect(
        artifacts.some(
          output => output.type === 'asset' && output.fileName === 'fict.manifest.json',
        ),
      ).toBe(true)
      expect(
        artifacts.some(output => output.type === 'chunk' && output.fileName.includes('handler-')),
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
