import type * as BabelCore from '@babel/core'
import { parseSync, transformSync } from '@babel/core'

import createFictPlugin from '../index'
import { buildHIR } from '../ir/build-hir'
import { functionContainsJSX } from '../ir/codegen-analysis'
import type { Expression, HIRFunction, Instruction } from '../ir/hir'
import type { Region } from '../ir/regions'
import { deSSAVarName, generateRegions } from '../ir/regions'
import { analyzeReactiveScopesWithSSA } from '../ir/scopes'
import type { CompilerWarning, FictCompilerOptions } from '../types'
import { DiagnosticSeverity, resolveDiagnosticSeverity } from '../validation'

import { inferTraceMarkersForComponent } from './trace-infer'
import type {
  AnalyzeDiagnostic,
  AnalyzeOptions,
  AnalyzeResult,
  ComponentAnalysis,
  RegionInfoSerializable,
} from './types'

function mergeLoc(
  a: BabelCore.types.SourceLocation | null | undefined,
  b: BabelCore.types.SourceLocation | null | undefined,
): BabelCore.types.SourceLocation | null {
  if (!a) return b ?? null
  if (!b) return a

  const start =
    b.start.line < a.start.line ||
    (b.start.line === a.start.line && b.start.column < a.start.column)
      ? b.start
      : a.start
  const end =
    b.end.line > a.end.line || (b.end.line === a.end.line && b.end.column > a.end.column)
      ? b.end
      : a.end

  return {
    start,
    end,
    filename: a.filename ?? b.filename,
    identifierName: a.identifierName ?? b.identifierName,
  }
}

function expressionContainsMacroCall(expr: Expression, macroName: '$state' | '$effect'): boolean {
  let found = false

  const visit = (value: Expression): void => {
    if (found) return

    if (
      value.kind === 'CallExpression' &&
      value.callee.kind === 'Identifier' &&
      deSSAVarName(value.callee.name) === macroName
    ) {
      found = true
      return
    }

    switch (value.kind) {
      case 'CallExpression':
      case 'OptionalCallExpression':
        visit(value.callee)
        value.arguments.forEach(arg => visit(arg))
        return
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visit(value.object)
        if (value.computed) visit(value.property)
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
        visit(value.left)
        visit(value.right)
        return
      case 'UnaryExpression':
      case 'AwaitExpression':
      case 'UpdateExpression':
      case 'SpreadElement':
        visit(value.argument)
        return
      case 'ConditionalExpression':
        visit(value.test)
        visit(value.consequent)
        visit(value.alternate)
        return
      case 'ArrayExpression':
        value.elements.forEach(el => visit(el))
        return
      case 'ObjectExpression':
        value.properties.forEach(prop => {
          if (prop.kind === 'SpreadElement') {
            visit(prop.argument)
            return
          }
          if (prop.computed) visit(prop.key)
          visit(prop.value)
        })
        return
      case 'TemplateLiteral':
        value.expressions.forEach(item => visit(item))
        return
      case 'AssignmentExpression':
        visit(value.left)
        visit(value.right)
        return
      case 'SequenceExpression':
        value.expressions.forEach(item => visit(item))
        return
      case 'YieldExpression':
        if (value.argument) visit(value.argument)
        return
      case 'TaggedTemplateExpression':
        visit(value.tag)
        value.quasi.expressions.forEach(item => visit(item))
        return
      case 'ImportExpression':
        visit(value.source)
        return
      case 'ArrowFunction':
        if (Array.isArray(value.body)) {
          value.body.forEach(block => {
            block.instructions.forEach(instr => {
              if (instr.kind === 'Assign' || instr.kind === 'Expression') {
                visit(instr.value)
              }
            })
          })
        } else {
          visit(value.body)
        }
        return
      case 'FunctionExpression':
        value.body.forEach(block => {
          block.instructions.forEach(instr => {
            if (instr.kind === 'Assign' || instr.kind === 'Expression') {
              visit(instr.value)
            }
          })
        })
        return
      case 'JSXElement':
        if (typeof value.tagName !== 'string') visit(value.tagName)
        value.attributes.forEach(attr => {
          if (attr.isSpread && attr.spreadExpr) {
            visit(attr.spreadExpr)
          } else if (attr.value) {
            visit(attr.value)
          }
        })
        value.children.forEach(child => {
          if (child.kind === 'expression') visit(child.value)
          if (child.kind === 'element') visit(child.value)
        })
        return
      case 'Identifier':
      case 'Literal':
      case 'MetaProperty':
      case 'NewExpression':
      case 'ClassExpression':
      case 'ThisExpression':
      case 'SuperExpression':
        if (value.kind === 'NewExpression') {
          visit(value.callee)
          value.arguments.forEach(arg => visit(arg))
        }
        if (value.kind === 'ClassExpression' && value.superClass) visit(value.superClass)
        return
      default:
        return
    }
  }

  visit(expr)
  return found
}

function instructionContainsMacroCall(
  instruction: Instruction,
  macroName: '$state' | '$effect',
): boolean {
  if (instruction.kind !== 'Assign' && instruction.kind !== 'Expression') return false
  return expressionContainsMacroCall(instruction.value, macroName)
}

function functionUsesMacro(fn: HIRFunction, macroName: '$state' | '$effect'): boolean {
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instructionContainsMacroCall(instruction, macroName)) return true
    }

    const term = block.terminator
    if (
      'argument' in term &&
      term.argument &&
      expressionContainsMacroCall(term.argument, macroName)
    ) {
      return true
    }
    if (term.kind === 'Branch' && expressionContainsMacroCall(term.test, macroName)) {
      return true
    }
    if (term.kind === 'Switch') {
      if (expressionContainsMacroCall(term.discriminant, macroName)) return true
      if (
        term.cases.some(entry => entry.test && expressionContainsMacroCall(entry.test, macroName))
      ) {
        return true
      }
    }
  }
  return false
}

function computeRegionLoc(region: Region, fn: HIRFunction): BabelCore.types.SourceLocation | null {
  let loc: BabelCore.types.SourceLocation | null = null

  for (const instruction of region.instructions) {
    loc = mergeLoc(loc, instruction.loc)
  }

  for (const blockId of region.blocks) {
    const block = fn.blocks.find(entry => entry.id === blockId)
    if (!block) continue
    loc = mergeLoc(loc, block.terminator.loc)
  }

  return loc
}

function regionToSerializable(region: Region, fn: HIRFunction): RegionInfoSerializable {
  const loc = computeRegionLoc(region, fn)
  return {
    id: region.id,
    startLine: loc?.start.line,
    startColumn: loc?.start.column,
    endLine: loc?.end.line,
    endColumn: loc?.end.column,
    dependencies: [...region.dependencies].map(deSSAVarName),
    declarations: [...region.declarations].map(deSSAVarName),
    hasControlFlow: region.hasControlFlow,
    hasReactiveWrites: region.declarations.size > 0,
    children: region.children.map(child => regionToSerializable(child, fn)),
  }
}

function warningSeverity(
  code: string,
  compilerOptions?: Partial<FictCompilerOptions>,
): AnalyzeDiagnostic['severity'] {
  try {
    return resolveDiagnosticSeverity(code as never, compilerOptions)
  } catch {
    return DiagnosticSeverity.Warning
  }
}

function normalizeWarningToDiagnostic(
  warning: CompilerWarning,
  compilerOptions?: Partial<FictCompilerOptions>,
): AnalyzeDiagnostic {
  return {
    code: warning.code,
    message: warning.message,
    severity: warningSeverity(warning.code, compilerOptions),
    line: warning.line,
    column: warning.column,
  }
}

function normalizeThrownError(error: unknown): AnalyzeDiagnostic {
  const message = error instanceof Error ? error.message : String(error)
  return {
    code: 'FICT-COMPILE',
    message,
    severity: DiagnosticSeverity.Error,
    line: 0,
    column: 0,
  }
}

function normalizeEscalatedCompilerError(error: unknown): AnalyzeDiagnostic | null {
  if (!(error instanceof Error)) return null
  const match = /Fict warning treated as error \(([^)]+)\): ([^\n]+)/.exec(error.message)
  if (!match) return null

  const code = match[1]
  const message = match[2]
  if (!code || !message) return null

  const errorWithLocation = error as Error & {
    loc?: {
      line: number
      column: number
    }
  }

  return {
    code,
    message,
    severity: DiagnosticSeverity.Error,
    line: errorWithLocation.loc?.line ?? 0,
    column: (errorWithLocation.loc?.column ?? -1) + 1,
  }
}

function analyzeDiagnostics(
  code: string,
  fileName: string,
  options: AnalyzeOptions,
): AnalyzeDiagnostic[] {
  const warnings: CompilerWarning[] = []
  const warningLevels = Object.fromEntries(
    Object.entries(options.compilerOptions?.warningLevels ?? {}).map(([code, level]) => [
      code,
      level === 'error' ? 'warn' : level,
    ]),
  ) as FictCompilerOptions['warningLevels']
  const pluginOptions: FictCompilerOptions = {
    ...options.compilerOptions,
    dev: true,
    filename: fileName,
    emitModuleMetadata: false,
    warningsAsErrors: false,
    warningLevels: {
      ...warningLevels,
      'FICT-R004': 'warn',
    },
    onWarn: warning => warnings.push(warning),
  }

  try {
    transformSync(code, {
      filename: fileName,
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        allowReturnOutsideFunction: true,
      },
      plugins: [[createFictPlugin, pluginOptions]],
      generatorOpts: {
        compact: false,
      },
    })
  } catch (error) {
    const diagnostics = warnings.map(warning =>
      normalizeWarningToDiagnostic(warning, options.compilerOptions),
    )
    const escalatedDiagnostic = normalizeEscalatedCompilerError(error)
    if (
      escalatedDiagnostic &&
      !diagnostics.some(
        diagnostic =>
          diagnostic.code === escalatedDiagnostic.code &&
          diagnostic.line === escalatedDiagnostic.line &&
          diagnostic.column === escalatedDiagnostic.column,
      )
    ) {
      diagnostics.push(escalatedDiagnostic)
    }
    if (diagnostics.some(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)) {
      return diagnostics
    }
    return [...diagnostics, normalizeThrownError(error)]
  }

  return warnings.map(warning => normalizeWarningToDiagnostic(warning, options.compilerOptions))
}

function shouldIncludeFunction(fn: HIRFunction): boolean {
  return (
    functionContainsJSX(fn) || functionUsesMacro(fn, '$state') || functionUsesMacro(fn, '$effect')
  )
}

function parseFileAst(code: string, fileName: string): BabelCore.types.File {
  const ast = parseSync(code, {
    filename: fileName,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      allowReturnOutsideFunction: true,
    },
  })

  if (!ast || ast.type !== 'File') {
    throw new Error('Failed to parse source file for Fict analysis.')
  }
  return ast
}

export function analyzeFictFile(
  code: string,
  fileName: string,
  options: AnalyzeOptions = {},
): AnalyzeResult {
  const includeRegions = options.includeRegions ?? true
  const includeDiagnostics = options.includeDiagnostics ?? true
  const verbosity = options.verbosity ?? 'minimal'

  const ast = parseFileAst(code, fileName)
  let hir
  try {
    hir = buildHIR(
      ast,
      {
        state: new Set(['$state']),
        effect: new Set(['$effect']),
      },
      {
        dev: true,
        fileName,
      },
    )
  } catch (error) {
    if (!includeDiagnostics) throw error
    return {
      fileName,
      components: [],
      diagnostics: analyzeDiagnostics(code, fileName, options),
    }
  }

  const sourceLines = code.split(/\r?\n/)
  const components: ComponentAnalysis[] = []

  for (const fn of hir.functions) {
    if (!fn.loc || !shouldIncludeFunction(fn)) continue

    const startLine = fn.loc.start.line
    const endLine = fn.loc.end.line

    const scopeResult = analyzeReactiveScopesWithSSA(fn)
    const regionResult = generateRegions(fn, scopeResult)
    const regions = includeRegions
      ? regionResult.topLevelRegions.map(region => regionToSerializable(region, fn))
      : undefined

    const trace = inferTraceMarkersForComponent({
      fn,
      sourceLines,
      startLine,
      endLine,
      verbosity,
      regions,
    })

    components.push({
      name: fn.name ?? '<anonymous>',
      startLine,
      endLine,
      trace,
      regions,
    })
  }

  const diagnostics = includeDiagnostics ? analyzeDiagnostics(code, fileName, options) : []

  return {
    fileName,
    components,
    diagnostics,
  }
}
