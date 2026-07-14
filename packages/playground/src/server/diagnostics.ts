import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { CompileRequest, FictDiagnostic } from '@fictjs/compiler'
import { loadNativeCompilerBinding } from '@fictjs/compiler/native'
import type * as TypeScriptApi from 'typescript'

import type {
  PlaygroundArtifact,
  PlaygroundCompiler,
  PlaygroundConfig,
  PlaygroundDiagnostic,
  PlaygroundDiagnosticsInput,
  PlaygroundDiagnosticsResult,
} from './types'
import { findWorkspaceRoot, listSourceFiles, relativeToRoot } from './utils'

let defaultCompiler: PlaygroundCompiler | undefined

function getDefaultCompiler(): PlaygroundCompiler {
  defaultCompiler ??= loadNativeCompilerBinding(
    process.env.FICT_COMPILER_NATIVE_PATH
      ? { nativePath: process.env.FICT_COMPILER_NATIVE_PATH }
      : {},
  )
  return defaultCompiler
}

export async function collectSessionDiagnostics(
  input: PlaygroundDiagnosticsInput,
): Promise<PlaygroundDiagnosticsResult> {
  const [compiler, typescript] = await Promise.all([
    collectCompilerDiagnostics(input),
    collectTypeScriptDiagnostics(input),
  ])

  const diagnostics = [...compiler.diagnostics, ...typescript]
  diagnostics.sort(compareDiagnostics)

  let errorCount = 0
  let warningCount = 0
  let infoCount = 0

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') {
      errorCount += 1
      continue
    }
    if (diagnostic.severity === 'warning') {
      warningCount += 1
      continue
    }
    infoCount += 1
  }

  return {
    diagnostics,
    artifacts: compiler.artifacts,
    summary: {
      errorCount,
      warningCount,
      infoCount,
    },
  }
}

async function collectCompilerDiagnostics(
  input: PlaygroundDiagnosticsInput,
): Promise<{ diagnostics: PlaygroundDiagnostic[]; artifacts: PlaygroundArtifact[] }> {
  const sourceFiles = await listSourceFiles(input.rootDir)
  const diagnostics: PlaygroundDiagnostic[] = []
  const artifacts: PlaygroundArtifact[] = []
  let compiler: PlaygroundCompiler

  try {
    compiler = input.compiler ?? getDefaultCompiler()
  } catch (error) {
    diagnostics.push(nativeHostFailure(error))
    return { diagnostics, artifacts }
  }

  for (const absolutePath of sourceFiles) {
    const relativePath = relativeToRoot(input.rootDir, absolutePath)
    const sourceCode = await fs.readFile(absolutePath, 'utf8')

    try {
      const result = await compiler.transform(
        toCompileRequest(sourceCode, absolutePath, input.config),
      )
      diagnostics.push(
        ...result.diagnostics.map(diagnostic =>
          fromNativeDiagnostic(input.rootDir, absolutePath, sourceCode, diagnostic),
        ),
      )

      if (result.code) {
        artifacts.push({
          filePath: relativePath,
          code: result.code,
        })
      }
    } catch (error) {
      diagnostics.push(nativeTransformFailure(input.rootDir, absolutePath, error))
    }
  }

  return { diagnostics, artifacts }
}

function toCompileRequest(
  sourceCode: string,
  absolutePath: string,
  config: PlaygroundConfig,
): CompileRequest {
  return {
    code: sourceCode,
    filename: absolutePath,
    moduleId: absolutePath,
    options: {
      dev: true,
      strictGuarantee: config.strictGuarantee,
      strictReactivity: config.strictReactivity,
      lazyConditional: config.lazyConditional,
      sourcemap: true,
      ...(config.resumable
        ? {
            preview: {
              resumable: true,
              autoExtractHandlers: true,
            },
          }
        : {}),
    },
  }
}

function fromNativeDiagnostic(
  rootDir: string,
  fileName: string,
  sourceCode: string,
  diagnostic: FictDiagnostic,
): PlaygroundDiagnostic {
  const view: PlaygroundDiagnostic = {
    source: 'compiler',
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    filePath: toRelativeFilePath(rootDir, fileName),
  }
  if (diagnostic.primarySpan) {
    const location = byteOffsetToEditorLocation(sourceCode, diagnostic.primarySpan.start)
    view.line = location.line
    view.column = location.column
  }
  return view
}

function byteOffsetToEditorLocation(
  sourceCode: string,
  byteOffset: number,
): { line: number; column: number } {
  const bytes = Buffer.from(sourceCode)
  const safeOffset = Math.max(0, Math.min(bytes.length, Math.trunc(byteOffset)))
  const prefix = bytes.subarray(0, safeOffset).toString('utf8')
  const lines = prefix.split(/\r?\n/)
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  }
}

function nativeHostFailure(error: unknown): PlaygroundDiagnostic {
  return {
    source: 'compiler',
    severity: 'error',
    code: 'FICT-NATIVE-LOAD',
    message: error instanceof Error ? error.message : String(error),
  }
}

function nativeTransformFailure(
  rootDir: string,
  fileName: string,
  error: unknown,
): PlaygroundDiagnostic {
  return {
    source: 'compiler',
    severity: 'error',
    code: 'FICT-NATIVE-HOST',
    message: error instanceof Error ? error.message : String(error),
    filePath: toRelativeFilePath(rootDir, fileName),
  }
}

async function collectTypeScriptDiagnostics(
  input: PlaygroundDiagnosticsInput,
): Promise<PlaygroundDiagnostic[]> {
  try {
    const ts = (await import('typescript')) as typeof TypeScriptApi
    const configPath = path.join(input.rootDir, 'tsconfig.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)

    if (config.error) {
      return [fromTypeScriptDiagnostic(ts, input.rootDir, config.error)]
    }

    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      input.rootDir,
      undefined,
      configPath,
    )
    const workspaceRoot = findWorkspaceRoot(input.rootDir)
    const options = withWorkspaceModulePaths(parsed.options, workspaceRoot)

    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options,
    })

    return ts
      .getPreEmitDiagnostics(program)
      .filter(diagnostic => {
        if (!diagnostic.file) return true
        return isWithinRoot(input.rootDir, diagnostic.file.fileName)
      })
      .map(diagnostic => fromTypeScriptDiagnostic(ts, input.rootDir, diagnostic))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [
      {
        source: 'typescript',
        severity: 'error',
        code: 'TS-SETUP',
        message: `TypeScript diagnostics failed: ${message}`,
      },
    ]
  }
}

function isWithinRoot(rootDir: string, fileName: string): boolean {
  const root = path.resolve(rootDir)
  const target = path.resolve(fileName)
  if (target === root) return true
  return target.startsWith(`${root}${path.sep}`)
}

function withWorkspaceModulePaths(
  options: TypeScriptApi.CompilerOptions,
  workspaceRoot: string,
): TypeScriptApi.CompilerOptions {
  return {
    ...options,
    ignoreDeprecations: options.ignoreDeprecations ?? '5.0',
    baseUrl: workspaceRoot,
    paths: {
      ...(options.paths ?? {}),
      fict: ['packages/fict/src/index.ts'],
      'fict/*': ['packages/fict/src/*'],
      '@fictjs/runtime': ['packages/runtime/src/index.ts'],
      '@fictjs/runtime/*': ['packages/runtime/src/*'],
      '@fictjs/compiler': ['packages/compiler/src/index.ts'],
      '@fictjs/compiler/*': ['packages/compiler/src/*'],
      '@fictjs/ssr': ['packages/ssr/src/index.ts'],
      '@fictjs/ssr/*': ['packages/ssr/src/*'],
      '@fictjs/devtools': ['packages/devtools/src/index.ts'],
      '@fictjs/devtools/*': ['packages/devtools/src/*'],
      '@fictjs/vite-plugin': ['packages/vite-plugin/src/index.ts'],
      '@fictjs/vite-plugin/*': ['packages/vite-plugin/src/*'],
    },
  }
}

function fromTypeScriptDiagnostic(
  ts: typeof TypeScriptApi,
  rootDir: string,
  diagnostic: TypeScriptApi.Diagnostic,
): PlaygroundDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')

  const severity =
    diagnostic.category === ts.DiagnosticCategory.Error
      ? 'error'
      : diagnostic.category === ts.DiagnosticCategory.Warning
        ? 'warning'
        : 'info'

  let filePath: string | undefined
  let line: number | undefined
  let column: number | undefined

  if (diagnostic.file && diagnostic.start !== undefined) {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    line = position.line + 1
    column = position.character + 1
    filePath = toRelativeFilePath(rootDir, diagnostic.file.fileName)
  }

  const view: PlaygroundDiagnostic = {
    source: 'typescript',
    severity,
    code: `TS${diagnostic.code}`,
    message,
  }
  if (filePath) view.filePath = filePath
  if (line !== undefined) view.line = line
  if (column !== undefined) view.column = column
  return view
}

function toRelativeFilePath(rootDir: string, fileName: string): string {
  if (!fileName) return fileName
  if (!path.isAbsolute(fileName)) return fileName
  const relativePath = path.relative(rootDir, fileName)
  return relativePath.startsWith('..') ? fileName : relativePath.replace(/\\/g, '/')
}

function compareDiagnostics(left: PlaygroundDiagnostic, right: PlaygroundDiagnostic): number {
  if (left.severity !== right.severity) {
    return severityRank(left.severity) - severityRank(right.severity)
  }

  const leftFile = left.filePath ?? ''
  const rightFile = right.filePath ?? ''
  if (leftFile !== rightFile) {
    return leftFile.localeCompare(rightFile)
  }

  const leftLine = left.line ?? Number.MAX_SAFE_INTEGER
  const rightLine = right.line ?? Number.MAX_SAFE_INTEGER
  if (leftLine !== rightLine) {
    return leftLine - rightLine
  }

  return (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
}

function severityRank(severity: PlaygroundDiagnostic['severity']): number {
  if (severity === 'error') return 0
  if (severity === 'warning') return 1
  return 2
}
