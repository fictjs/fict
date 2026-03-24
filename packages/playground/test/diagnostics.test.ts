import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { collectSessionDiagnostics } from '../src/server/diagnostics'
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

describe('playground diagnostics', () => {
  it('reports diagnostics only for session files', async () => {
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
  }, 20_000)

  it('preserves compiler diagnostic codes when strict guarantee escalates warnings', async () => {
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
  }, 20_000)

  it('returns structured FICT-COMPILE diagnostics for direct compiler failures', async () => {
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
            column: 15,
          }),
        ]),
      )
      expect(
        result.diagnostics.some(diagnostic =>
          diagnostic.message.includes('$state() cannot be declared inside nested functions.'),
        ),
      ).toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 20_000)
})
