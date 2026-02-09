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
})
