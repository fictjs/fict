import { promises as fs } from 'node:fs'
import path from 'node:path'

import { parseSync, transformAsync } from '@babel/core'
import * as BabelTypes from '@babel/types'
import { createFictPlugin, type CompilerWarning, type FictCompilerOptions } from '@fictjs/compiler'
import type * as TypeScriptApi from 'typescript'

import type {
  PlaygroundArtifact,
  PlaygroundConfig,
  PlaygroundDiagnostic,
  PlaygroundDiagnosticsResult,
} from './types'
import { findWorkspaceRoot, listSourceFiles, relativeToRoot } from './utils'

interface DiagnosticsInput {
  rootDir: string
  config: PlaygroundConfig
}

type CompilerErrorContext = 'loop-or-conditional' | 'nested-function'
type CompilerMacroName = '$effect' | '$state'

export async function collectSessionDiagnostics(
  input: DiagnosticsInput,
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
  input: DiagnosticsInput,
): Promise<{ diagnostics: PlaygroundDiagnostic[]; artifacts: PlaygroundArtifact[] }> {
  const sourceFiles = await listSourceFiles(input.rootDir)
  const diagnostics: PlaygroundDiagnostic[] = []
  const artifacts: PlaygroundArtifact[] = []

  for (const absolutePath of sourceFiles) {
    const relativePath = relativeToRoot(input.rootDir, absolutePath)
    const sourceCode = await fs.readFile(absolutePath, 'utf8')
    const isTypeScript = /\.(tsx|ts)$/.test(absolutePath)

    const warnings: PlaygroundDiagnostic[] = []

    const options = toCompilerOptions(input.config, warning => {
      warnings.push(fromCompilerWarning(input.rootDir, warning))
    })

    try {
      const result = await transformAsync(sourceCode, {
        filename: absolutePath,
        sourceMaps: true,
        sourceFileName: absolutePath,
        presets: isTypeScript
          ? [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]]
          : [],
        plugins: [
          ['@babel/plugin-syntax-jsx', {}],
          [createFictPlugin, { ...options, filename: absolutePath }],
        ],
      })

      diagnostics.push(...warnings)

      if (result?.code) {
        artifacts.push({
          filePath: relativePath,
          code: result.code,
        })
      }
    } catch (error) {
      diagnostics.push(fromCompilerError(input.rootDir, absolutePath, sourceCode, error))
    }
  }

  return {
    diagnostics,
    artifacts,
  }
}

async function collectTypeScriptDiagnostics(
  input: DiagnosticsInput,
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

function toCompilerOptions(
  config: PlaygroundConfig,
  onWarn: (warning: CompilerWarning) => void,
): FictCompilerOptions {
  return {
    dev: true,
    strictGuarantee: config.strictGuarantee,
    strictReactivity: config.strictReactivity,
    lazyConditional: config.lazyConditional,
    resumable: config.resumable,
    onWarn,
  }
}

function fromCompilerWarning(rootDir: string, warning: CompilerWarning): PlaygroundDiagnostic {
  const filePath = toRelativeFilePath(rootDir, warning.fileName)
  const diagnostic: PlaygroundDiagnostic = {
    source: 'compiler',
    severity: 'warning',
    code: warning.code,
    message: warning.message,
    filePath,
  }
  if (warning.line > 0) diagnostic.line = warning.line
  if (warning.column > 0) diagnostic.column = warning.column
  return diagnostic
}

function parseEscalatedCompilerWarning(message: string): { code: string; message: string } | null {
  const match = /Fict warning treated as error \(([^)]+)\): ([^\n]+)/.exec(message)
  if (!match) return null
  const code = match[1]
  const warningMessage = match[2]
  if (!code || !warningMessage) return null
  return {
    code,
    message: warningMessage,
  }
}

function extractLocationFromCompilerMessage(
  message: string,
): { line: number; column: number } | null {
  const lineMatch = /^>\s+(\d+)\s+\|/m.exec(message)
  const columnMatch = /^\s*\|\s+(\^+)/m.exec(message)
  if (lineMatch && columnMatch) {
    const line = Number.parseInt(lineMatch[1] ?? '', 10)
    const carets = columnMatch[1]
    if (!Number.isFinite(line) || !carets) return null

    const markerIndex = columnMatch.index + columnMatch[0].indexOf(carets)
    const lineStart = message.lastIndexOf('\n', columnMatch.index) + 1
    const column = markerIndex - lineStart

    return { line, column: column + 1 }
  }

  const summaryMatch = /\((\d+):(\d+)\)(?:\s|$)/.exec(message)
  if (!summaryMatch) return null

  const line = Number.parseInt(summaryMatch[1] ?? '', 10)
  const column = Number.parseInt(summaryMatch[2] ?? '', 10)
  if (!Number.isFinite(line) || !Number.isFinite(column)) return null

  return { line, column: column + 1 }
}

function classifyCompilerPlacementError(
  message: string,
): { context: CompilerErrorContext; macroName: CompilerMacroName } | null {
  if (/\$state\(\) cannot be declared inside loops or conditionals\./.test(message)) {
    return {
      context: 'loop-or-conditional',
      macroName: '$state',
    }
  }

  if (/\$state\(\) cannot be declared inside nested functions\./.test(message)) {
    return {
      context: 'nested-function',
      macroName: '$state',
    }
  }

  if (/\$effect\(\) cannot be called inside loops or conditionals\./.test(message)) {
    return {
      context: 'loop-or-conditional',
      macroName: '$effect',
    }
  }

  if (/\$effect\(\) cannot be called inside nested functions\./.test(message)) {
    return {
      context: 'nested-function',
      macroName: '$effect',
    }
  }

  return null
}

function parseSourceAstSafely(sourceCode: string, filePath: string): BabelTypes.File | null {
  try {
    const ast = parseSync(sourceCode, {
      filename: filePath,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        allowReturnOutsideFunction: true,
      },
    })

    return ast && ast.type === 'File' ? ast : null
  } catch {
    return null
  }
}

function isLoopNode(node: BabelTypes.Node): boolean {
  return (
    BabelTypes.isForStatement(node) ||
    BabelTypes.isForInStatement(node) ||
    BabelTypes.isForOfStatement(node) ||
    BabelTypes.isWhileStatement(node) ||
    BabelTypes.isDoWhileStatement(node)
  )
}

function isConditionalNode(node: BabelTypes.Node): boolean {
  return (
    BabelTypes.isIfStatement(node) ||
    BabelTypes.isSwitchStatement(node) ||
    BabelTypes.isSwitchCase(node) ||
    BabelTypes.isConditionalExpression(node) ||
    BabelTypes.isLogicalExpression(node)
  )
}

function findFirstMacroCallInContext(
  node: BabelTypes.Node,
  macroName: CompilerMacroName,
  context: CompilerErrorContext,
  ancestors: BabelTypes.Node[] = [],
): { line: number; column: number } | null {
  const nextAncestors = [...ancestors, node]

  if (
    BabelTypes.isCallExpression(node) &&
    BabelTypes.isIdentifier(node.callee) &&
    node.callee.name === macroName &&
    node.loc
  ) {
    const hasLoop = nextAncestors.some(isLoopNode)
    const hasConditional = nextAncestors.some(isConditionalNode)
    const functionDepth = nextAncestors.filter(ancestor => BabelTypes.isFunction(ancestor)).length

    if (context === 'loop-or-conditional' && (hasLoop || hasConditional)) {
      return {
        line: node.loc.start.line,
        column: node.loc.start.column + 1,
      }
    }

    if (context === 'nested-function' && functionDepth > 1) {
      return {
        line: node.loc.start.line,
        column: node.loc.start.column + 1,
      }
    }
  }

  const visitorKeys = BabelTypes.VISITOR_KEYS[node.type] ?? []
  for (const key of visitorKeys) {
    const value = (node as unknown as Record<string, unknown>)[key]

    if (Array.isArray(value)) {
      for (const child of value) {
        if (!child || typeof child !== 'object' || !('type' in child)) continue
        const found = findFirstMacroCallInContext(
          child as BabelTypes.Node,
          macroName,
          context,
          nextAncestors,
        )
        if (found) return found
      }
      continue
    }

    if (!value || typeof value !== 'object' || !('type' in value)) continue
    const found = findFirstMacroCallInContext(
      value as BabelTypes.Node,
      macroName,
      context,
      nextAncestors,
    )
    if (found) return found
  }

  return null
}

export function inferCompilerLocationFromSource(
  sourceCode: string,
  filePath: string,
  message: string,
): { line: number; column: number } | null {
  const classification = classifyCompilerPlacementError(message)
  if (!classification) return null

  const ast = parseSourceAstSafely(sourceCode, filePath)
  if (!ast) return null

  return findFirstMacroCallInContext(ast, classification.macroName, classification.context)
}

function fromCompilerError(
  rootDir: string,
  fileName: string,
  sourceCode: string,
  error: unknown,
): PlaygroundDiagnostic {
  let message = 'Unknown compiler transform failure'
  let line: number | undefined
  let column: number | undefined

  if (error instanceof Error) {
    message = error.message
    const derivedLocation = extractLocationFromCompilerMessage(message)
    const inferredLocation = inferCompilerLocationFromSource(sourceCode, fileName, message)
    const errorWithLocation = error as Error & {
      loc?: {
        line: number
        column: number
      }
    }
    if (errorWithLocation.loc) {
      line = errorWithLocation.loc.line
      column = errorWithLocation.loc.column + 1
    } else if (derivedLocation) {
      line = derivedLocation.line
      column = derivedLocation.column
    } else if (inferredLocation) {
      line = inferredLocation.line
      column = inferredLocation.column
    }
  }

  const escalatedWarning = parseEscalatedCompilerWarning(message)
  const conciseMessage = message.split('\n')[0] ?? message

  const diagnostic: PlaygroundDiagnostic = {
    source: 'compiler',
    severity: 'error',
    code: escalatedWarning?.code ?? 'FICT-COMPILE',
    message: escalatedWarning?.message ?? conciseMessage,
    filePath: toRelativeFilePath(rootDir, fileName),
  }
  if (line !== undefined) diagnostic.line = line
  if (column !== undefined) diagnostic.column = column
  return diagnostic
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
