import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { CompileRequest, CompileResult, FictDiagnostic } from '@fictjs/compiler'
import { describe, expect, it } from 'vitest'

import { collectSessionDiagnostics } from '../src/server/diagnostics'
import type { PlaygroundCompiler, PlaygroundConfig } from '../src/server/types'

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

function diagnostic(
  request: CompileRequest,
  code: string,
  message: string,
  needle: string,
  severity: FictDiagnostic['severity'],
): FictDiagnostic {
  const characterOffset = request.code.indexOf(needle)
  const start = Buffer.byteLength(request.code.slice(0, Math.max(0, characterOffset)))
  return {
    code,
    message,
    severity,
    primarySpan: { start, end: start + Buffer.byteLength(needle) },
    secondaryLabels: [],
    help: null,
    notes: [],
    guaranteeClass: severity === 'error' ? 'unsupported' : 'fallback',
  }
}

function compileResult(request: CompileRequest): CompileResult {
  const diagnostics: FictDiagnostic[] = []
  if (request.code.includes('function inner()')) {
    diagnostics.push(
      diagnostic(
        request,
        'FICT-PLACEMENT-STATE-NESTED',
        '$state() cannot be declared inside nested functions',
        '$state(0)',
        'error',
      ),
    )
  }
  if (request.code.includes('state.count = 1')) {
    const strict = request.options?.strictGuarantee ?? true
    diagnostics.push(
      diagnostic(
        request,
        'FICT-M',
        'nested state mutation cannot preserve the strict reactivity guarantee',
        'state.count = 1',
        strict ? 'error' : 'warning',
      ),
    )
  }
  return {
    protocolVersion: 1,
    code: diagnostics.some(item => item.severity === 'error')
      ? ''
      : request.code.replace(/\$state/g, '__fictUseSignal'),
    map: null,
    diagnostics,
    moduleMetadata: { version: 1, exports: {} },
    metadataDependencies: [],
    unresolvedMetadataRequests: [],
    metadataIncomplete: false,
    explain: null,
    artifacts: [],
    stats: null,
    compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'0'.repeat(64)}`,
  }
}

const compiler: PlaygroundCompiler = {
  transform: async request => compileResult(request),
}

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

        const result = await collectSessionDiagnostics({ rootDir, config, compiler })

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

        const result = await collectSessionDiagnostics({ rootDir, config, compiler })
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
          compiler,
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

        const strictResult = await collectSessionDiagnostics({ rootDir, config, compiler })
        const relaxedResult = await collectSessionDiagnostics({
          rootDir,
          config: {
            ...config,
            profile: 'migration',
            strictGuarantee: false,
          },
          compiler,
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
    'uses structured native codes and spans for direct compiler failures',
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

        const result = await collectSessionDiagnostics({ rootDir, config, compiler })

        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source: 'compiler',
              code: 'FICT-PLACEMENT-STATE-NESTED',
              severity: 'error',
              line: 5,
            }),
          ]),
        )
        const compilerDiagnostic = result.diagnostics.find(
          diagnostic =>
            diagnostic.source === 'compiler' &&
            diagnostic.code === 'FICT-PLACEMENT-STATE-NESTED' &&
            diagnostic.severity === 'error',
        )
        expect(compilerDiagnostic?.column ?? 0).toBeGreaterThan(0)
        expect(
          result.diagnostics.some(diagnostic =>
            diagnostic.message.includes('$state() cannot be declared inside nested functions'),
          ),
        ).toBe(true)
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    },
    diagnosticTimeout,
  )

  it('converts native UTF-8 byte spans to one-based UTF-16 editor columns', async () => {
    const sandboxRoot = path.join(process.cwd(), '.fict-playground-test')
    await mkdir(sandboxRoot, { recursive: true })
    const rootDir = await mkdtemp(path.join(sandboxRoot, 'diag-unicode-'))
    const source = "const emoji = '😀'; const target = 1\n"
    const unicodeCompiler: PlaygroundCompiler = {
      transform: async request => {
        const result = compileResult(request)
        result.code = ''
        result.diagnostics = [
          diagnostic(request, 'FICT-UNICODE-PROBE', 'unicode location probe', 'target', 'error'),
        ]
        return result
      },
    }

    try {
      await writeDiagnosticsProject(rootDir, source)
      const result = await collectSessionDiagnostics({
        rootDir,
        config,
        compiler: unicodeCompiler,
      })
      const finding = result.diagnostics.find(item => item.code === 'FICT-UNICODE-PROBE')

      expect(finding).toMatchObject({ line: 1, column: source.indexOf('target') + 1 })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
