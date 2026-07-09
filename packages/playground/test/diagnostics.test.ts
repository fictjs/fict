import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  collectSessionDiagnostics,
  inferCompilerLocationFromSource,
} from '../src/server/diagnostics'
import type { PlaygroundConfig } from '../src/server/types'

const config: PlaygroundConfig = {
  profile: 'app-default',
  strictGuarantee: true,
  strictReactivity: false,
  lazyConditional: true,
  resumable: false,
  functionSplitting: false,
  devtools: false,
}

const diagnosticTimeout = process.env.CI ? 60_000 : 20_000

async function writeDiagnosticsProject(rootDir: string, source: string): Promise<void> {
  await writeFile(
    path.join(rootDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'preserve',
          jsxImportSource: 'fict',
          strict: true,
          skipLibCheck: true,
        },
        include: ['src'],
      },
      null,
      2,
    ),
  )
  await mkdir(path.join(rootDir, 'src'), { recursive: true })
  await writeFile(path.join(rootDir, 'src/main.tsx'), source)
}

describe('playground diagnostics', () => {
  it(
    'ignores a consumer .babelrc that references an unavailable plugin',
    async () => {
      const sandboxRoot = path.join(process.cwd(), '.fict-playground-test')
      await mkdir(sandboxRoot, { recursive: true })
      const rootDir = await mkdtemp(path.join(sandboxRoot, 'diag-babelrc-'))

      try {
        await writeDiagnosticsProject(
          rootDir,
          "import { $state } from 'fict'\n\nexport function App() {\n  const count = $state(1)\n  return <div>{count}</div>\n}\n",
        )
        await writeFile(
          path.join(rootDir, '.babelrc'),
          JSON.stringify({ plugins: ['./missing-consumer-babel-plugin.cjs'] }),
        )

        const result = await collectSessionDiagnostics({ rootDir, config })

        expect(result.diagnostics).toEqual([])
        expect(result.artifacts[0]?.code).toContain('__fictUseSignal')
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    },
    diagnosticTimeout,
  )

  it(
    'ignores a consumer babel.config that would change artifact semantics',
    async () => {
      const originalCwd = process.cwd()
      const sandboxRoot = path.join(originalCwd, '.fict-playground-test')
      await mkdir(sandboxRoot, { recursive: true })
      const rootDir = await mkdtemp(path.join(sandboxRoot, 'diag-babel-config-'))

      try {
        await writeDiagnosticsProject(
          rootDir,
          "import { $state } from 'fict'\n\nexport function useMarker() {\n  const marker = $state('original-marker')\n  return marker\n}\n",
        )
        await writeFile(
          path.join(rootDir, 'babel.config.cjs'),
          `
            module.exports = {
              plugins: [function mutateMarker() {
                return {
                  visitor: {
                    StringLiteral(path) {
                      if (path.node.value === 'original-marker') {
                        path.node.value = 'mutated-marker'
                      }
                    }
                  }
                }
              }]
            }
          `,
        )
        process.chdir(rootDir)

        const result = await collectSessionDiagnostics({ rootDir, config })
        const code = result.artifacts[0]?.code ?? ''

        expect(result.diagnostics).toEqual([])
        expect(code).toContain('original-marker')
        expect(code).not.toContain('mutated-marker')
      } finally {
        process.chdir(originalCwd)
        await rm(rootDir, { recursive: true, force: true })
      }
    },
    diagnosticTimeout,
  )

  it('ignores consumer Babel configuration while inferring compiler locations', async () => {
    const sandboxRoot = path.join(process.cwd(), '.fict-playground-test')
    await mkdir(sandboxRoot, { recursive: true })
    const rootDir = await mkdtemp(path.join(sandboxRoot, 'diag-location-babelrc-'))
    const sourceCode =
      "import { $state } from 'fict'\n\nexport function App() {\n  function inner() {\n    let count = $state(0)\n    return count\n  }\n  return <div>{inner()}</div>\n}\n"
    const filePath = path.join(rootDir, 'src/main.tsx')

    try {
      await writeFile(
        path.join(rootDir, '.babelrc'),
        JSON.stringify({ plugins: ['./missing-consumer-babel-plugin.cjs'] }),
      )

      expect(
        inferCompilerLocationFromSource(
          sourceCode,
          filePath,
          `${filePath}: $state() cannot be declared inside nested functions.`,
        ),
      ).toEqual({ line: 5, column: 17 })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it(
    'reports diagnostics only for session files',
    async () => {
      const sandboxRoot = path.join(process.cwd(), '.fict-playground-test')
      await mkdir(sandboxRoot, { recursive: true })
      const rootDir = await mkdtemp(path.join(sandboxRoot, 'diag-'))

      try {
        await writeFile(
          path.join(rootDir, 'tsconfig.json'),
          JSON.stringify(
            {
              compilerOptions: {
                target: 'ES2020',
                module: 'ESNext',
                moduleResolution: 'bundler',
                jsx: 'preserve',
                jsxImportSource: 'fict',
                strict: true,
                skipLibCheck: true,
              },
              include: ['src'],
            },
            null,
            2,
          ),
        )

        await mkdir(path.join(rootDir, 'src'), { recursive: true })
        await writeFile(
          path.join(rootDir, 'src/main.tsx'),
          "import { $state, render } from 'fict'\n\nfunction App() {\n  let count = $state(0)\n  return <button onClick={() => count++}>{count}</button>\n}\n\nrender(() => <App />, document.body)\n",
        )

        const result = await collectSessionDiagnostics({
          rootDir,
          config,
        })

        expect(result.diagnostics).toEqual([])
        expect(result.artifacts.length).toBe(1)
        expect(result.artifacts[0]?.filePath).toBe('src/main.tsx')
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    },
    diagnosticTimeout,
  )

  it(
    'preserves compiler diagnostic codes when strict guarantee escalates warnings',
    async () => {
      const sandboxRoot = path.join(process.cwd(), '.fict-playground-test')
      await mkdir(sandboxRoot, { recursive: true })
      const rootDir = await mkdtemp(path.join(sandboxRoot, 'diag-strict-'))

      try {
        await writeFile(
          path.join(rootDir, 'tsconfig.json'),
          JSON.stringify(
            {
              compilerOptions: {
                target: 'ES2020',
                module: 'ESNext',
                moduleResolution: 'bundler',
                jsx: 'preserve',
                jsxImportSource: 'fict',
                strict: true,
                skipLibCheck: true,
              },
              include: ['src'],
            },
            null,
            2,
          ),
        )

        await mkdir(path.join(rootDir, 'src'), { recursive: true })
        await writeFile(
          path.join(rootDir, 'src/main.tsx'),
          "import { $state } from 'fict'\n\nexport function App() {\n  let state = $state({ count: 0 })\n  state.count = 1\n  return <div>{state.count}</div>\n}\n",
        )

        const strictResult = await collectSessionDiagnostics({ rootDir, config })
        const relaxedResult = await collectSessionDiagnostics({
          rootDir,
          config: {
            ...config,
            profile: 'migration',
            strictGuarantee: false,
          },
        })

        expect(strictResult.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ source: 'compiler', code: 'FICT-M', severity: 'error' }),
          ]),
        )
        expect(relaxedResult.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ source: 'compiler', code: 'FICT-M', severity: 'warning' }),
          ]),
        )
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    },
    diagnosticTimeout,
  )

  it(
    'returns structured FICT-COMPILE diagnostics for direct compiler failures',
    async () => {
      const sandboxRoot = path.join(process.cwd(), '.fict-playground-test')
      await mkdir(sandboxRoot, { recursive: true })
      const rootDir = await mkdtemp(path.join(sandboxRoot, 'diag-direct-'))

      try {
        await writeFile(
          path.join(rootDir, 'tsconfig.json'),
          JSON.stringify(
            {
              compilerOptions: {
                target: 'ES2020',
                module: 'ESNext',
                moduleResolution: 'bundler',
                jsx: 'preserve',
                jsxImportSource: 'fict',
                strict: true,
                skipLibCheck: true,
              },
              include: ['src'],
            },
            null,
            2,
          ),
        )

        await mkdir(path.join(rootDir, 'src'), { recursive: true })
        await writeFile(
          path.join(rootDir, 'src/main.tsx'),
          "import { $state } from 'fict'\n\nexport function App() {\n  function inner() {\n    let count = $state(0)\n    return count\n  }\n  return <div>{inner()}</div>\n}\n",
        )

        const result = await collectSessionDiagnostics({ rootDir, config })

        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source: 'compiler',
              code: 'FICT-COMPILE',
              severity: 'error',
              line: 5,
            }),
          ]),
        )
        const compilerDiagnostic = result.diagnostics.find(
          diagnostic =>
            diagnostic.source === 'compiler' &&
            diagnostic.code === 'FICT-COMPILE' &&
            diagnostic.severity === 'error',
        )
        expect(compilerDiagnostic?.column ?? 0).toBeGreaterThan(0)
        expect(
          result.diagnostics.some(diagnostic =>
            diagnostic.message.includes('$state() cannot be declared inside nested functions.'),
          ),
        ).toBe(true)
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    },
    diagnosticTimeout,
  )

  it('infers compiler locations from summary-only nested-function failures', () => {
    const sourceCode =
      "import { $state } from 'fict'\n\nexport function App() {\n  function inner() {\n    let count = $state(0)\n    return count\n  }\n  return <div>{inner()}</div>\n}\n"

    expect(
      inferCompilerLocationFromSource(
        sourceCode,
        '/tmp/src/main.tsx',
        '/tmp/src/main.tsx: $state() cannot be declared inside nested functions.',
      ),
    ).toEqual({
      line: 5,
      column: 17,
    })
  })
})
