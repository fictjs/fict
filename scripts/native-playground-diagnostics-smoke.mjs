#!/usr/bin/env node

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const nativeCompilerPath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target', 'release', 'fict_compiler_napi.node'),
)
await access(nativeCompilerPath)
process.env.FICT_COMPILER_NATIVE_PATH = nativeCompilerPath

const { collectSessionDiagnostics } = await import(
  pathToFileURL(path.join(repositoryRoot, 'packages', 'playground', 'dist', 'index.js')).href
)

const config = {
  profile: 'app-default',
  strictGuarantee: true,
  strictReactivity: false,
  lazyConditional: true,
  resumable: false,
  functionSplitting: false,
  devtools: false,
}
const rootDir = await mkdtemp(path.join(repositoryRoot, '.fict-playground-native-'))
const sourceDir = path.join(rootDir, 'src')
const sourcePath = path.join(sourceDir, 'main.tsx')

try {
  await mkdir(sourceDir, { recursive: true })
  await Promise.all([
    writeFile(
      path.join(rootDir, 'tsconfig.json'),
      JSON.stringify({
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
      }),
    ),
    writeFile(
      path.join(rootDir, '.babelrc'),
      JSON.stringify({ plugins: ['./missing-consumer-plugin.cjs'] }),
    ),
    writeFile(
      sourcePath,
      `
        import { $state } from 'fict'
        export function Counter() {
          const count = $state(0)
          return <button>{count}</button>
        }
      `,
    ),
  ])

  const valid = await collectSessionDiagnostics({ rootDir, config })
  assert.deepEqual(valid.diagnostics, [])
  assert.equal(valid.artifacts.length, 1)
  assert.match(valid.artifacts[0].code, /__fictUseSignal/)

  await writeFile(
    sourcePath,
    `import { $state } from 'fict'

export function Counter() {
  function nested() {
    const count = $state(0)
    return count
  }
  return <button>{nested()}</button>
}
`,
  )
  const invalid = await collectSessionDiagnostics({ rootDir, config })
  const placement = invalid.diagnostics.find(
    diagnostic => diagnostic.code === 'FICT-PLACEMENT-STATE-NESTED',
  )
  assert.deepEqual(
    {
      source: placement?.source,
      severity: placement?.severity,
      filePath: placement?.filePath,
      line: placement?.line,
      hasColumn: (placement?.column ?? 0) > 0,
    },
    {
      source: 'compiler',
      severity: 'error',
      filePath: 'src/main.tsx',
      line: 5,
      hasColumn: true,
    },
  )

  process.stdout.write(
    `${JSON.stringify({
      backend: 'rust',
      artifactBytes: valid.artifacts[0].code.length,
      diagnosticCode: placement.code,
      diagnosticLine: placement.line,
      ignoresConsumerBabelConfig: true,
    })}\n`,
  )
} finally {
  await rm(rootDir, { recursive: true, force: true })
}
