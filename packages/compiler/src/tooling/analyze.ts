import type * as BabelCore from '@babel/core'
import { parseSync, transformSync } from '@babel/core'
import * as BabelTypes from '@babel/types'

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

interface AnalyzeMacroNames {
  state: Set<string>
  effect: Set<string>
}

function importSpecifierImportedName(spec: BabelCore.types.ImportSpecifier): string {
  return BabelTypes.isIdentifier(spec.imported) ? spec.imported.name : String(spec.imported.value)
}

function collectAnalyzeMacroNames(ast: BabelCore.types.File): AnalyzeMacroNames {
  const names: AnalyzeMacroNames = {
    state: new Set(['$state']),
    effect: new Set(['$effect']),
  }

  for (const statement of ast.program.body) {
    if (!BabelTypes.isImportDeclaration(statement)) continue
    const source = statement.source.value
    if (source !== 'fict' && source !== 'fict/slim') continue
    for (const spec of statement.specifiers) {
      if (!BabelTypes.isImportSpecifier(spec)) {
        continue
      }
      const importedName = importSpecifierImportedName(spec)
      if (importedName === '$state') {
        names.state.add(spec.local.name)
      }
      if (importedName === '$effect') {
        names.effect.add(spec.local.name)
      }
    }
  }

  return names
}

function expressionContainsMacroCall(expr: Expression, macroNames: Set<string>): boolean {
  let found = false

  const visit = (value: Expression): void => {
    if (found) return

    if (
      value.kind === 'CallExpression' &&
      value.callee.kind === 'Identifier' &&
      macroNames.has(deSSAVarName(value.callee.name))
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
        value.elements.forEach(el => {
          if (el) visit(el)
        })
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

function instructionContainsMacroCall(instruction: Instruction, macroNames: Set<string>): boolean {
  if (instruction.kind !== 'Assign' && instruction.kind !== 'Expression') return false
  return expressionContainsMacroCall(instruction.value, macroNames)
}

function functionUsesMacro(fn: HIRFunction, macroNames: Set<string>): boolean {
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instructionContainsMacroCall(instruction, macroNames)) return true
    }

    const term = block.terminator
    if (
      'argument' in term &&
      term.argument &&
      expressionContainsMacroCall(term.argument, macroNames)
    ) {
      return true
    }
    if (term.kind === 'Branch' && expressionContainsMacroCall(term.test, macroNames)) {
      return true
    }
    if (term.kind === 'Switch') {
      if (expressionContainsMacroCall(term.discriminant, macroNames)) return true
      if (
        term.cases.some(entry => entry.test && expressionContainsMacroCall(entry.test, macroNames))
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
    if (instruction.kind === 'Assign' || instruction.kind === 'Expression') {
      loc = mergeLoc(loc, instruction.value.loc)
    }
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

function normalizeThrownError(source: string, fileName: string, error: unknown): AnalyzeDiagnostic {
  const message = error instanceof Error ? error.message : String(error)
  const location =
    extractLocationFromCompilerMessage(message) ??
    inferCompilerDiagnosticFromSource(source, fileName, message)?.location
  // Use extracted location from message, preserving 1-based column
  return {
    code: 'FICT-COMPILE',
    message: message.split('\n')[0] ?? message,
    severity: DiagnosticSeverity.Error,
    line: location?.line ?? 0,
    column: location ? location.column + 1 : 0,
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
  const location = errorWithLocation.loc ?? extractLocationFromCompilerMessage(error.message)

  return {
    code,
    message,
    severity: DiagnosticSeverity.Error,
    line: location?.line ?? 0,
    column: location ? location.column + 1 : 0,
  }
}

function isLoopNode(node: BabelCore.types.Node): boolean {
  return (
    BabelTypes.isForStatement(node) ||
    BabelTypes.isForInStatement(node) ||
    BabelTypes.isForOfStatement(node) ||
    BabelTypes.isWhileStatement(node) ||
    BabelTypes.isDoWhileStatement(node)
  )
}

function isConditionalNode(node: BabelCore.types.Node): boolean {
  return (
    BabelTypes.isIfStatement(node) ||
    BabelTypes.isSwitchStatement(node) ||
    BabelTypes.isSwitchCase(node) ||
    BabelTypes.isConditionalExpression(node) ||
    BabelTypes.isLogicalExpression(node)
  )
}

type CompilerErrorContext = 'loop-or-conditional' | 'nested-function'
type CompilerMacroName = '$effect' | '$memo' | '$state'

interface InferredCompilerDiagnostic {
  code: string | null
  location: {
    line: number
    column: number
  }
}

function containsPosition(
  loc: BabelCore.types.SourceLocation | null | undefined,
  line: number,
  column: number,
): boolean {
  if (!loc) return false
  if (line < loc.start.line || line > loc.end.line) return false
  if (line === loc.start.line && column < loc.start.column) return false
  if (line === loc.end.line && column > loc.end.column) return false
  return true
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

    return { line, column }
  }

  const summaryMatch = /\((\d+):(\d+)\)(?:\s|$)/.exec(message)
  if (summaryMatch) {
    const line = Number.parseInt(summaryMatch[1] ?? '', 10)
    const column = Number.parseInt(summaryMatch[2] ?? '', 10)
    if (!Number.isFinite(line) || !Number.isFinite(column)) return null

    return { line, column }
  }

  const atLocationMatch = /^\s+at .+:(\d+):(\d+)\s*$/m.exec(message)
  if (!atLocationMatch) return null

  const line = Number.parseInt(atLocationMatch[1] ?? '', 10)
  const column = Number.parseInt(atLocationMatch[2] ?? '', 10)
  if (!Number.isFinite(line) || !Number.isFinite(column)) return null

  return { line, column: Math.max(0, column - 1) }
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

  if (/\$memo\(\) cannot be called inside loops or conditionals\./.test(message)) {
    return {
      context: 'loop-or-conditional',
      macroName: '$memo',
    }
  }

  return null
}

function parseSourceAstSafely(source: string, fileName: string): BabelCore.types.File | null {
  try {
    const ast = parseSync(source, {
      filename: fileName,
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

function findFirstMacroCallInContext(
  node: BabelCore.types.Node,
  macroName: CompilerMacroName,
  context: CompilerErrorContext,
  ancestors: BabelCore.types.Node[] = [],
): InferredCompilerDiagnostic | null {
  const nextAncestors = [...ancestors, node]

  if (
    BabelTypes.isCallExpression(node) &&
    BabelTypes.isIdentifier(node.callee) &&
    deSSAVarName(node.callee.name) === macroName &&
    node.loc
  ) {
    const hasLoop = nextAncestors.some(isLoopNode)
    const hasConditional = nextAncestors.some(isConditionalNode)
    const functionDepth = nextAncestors.filter(ancestor => BabelTypes.isFunction(ancestor)).length

    if (context === 'loop-or-conditional' && (hasLoop || hasConditional)) {
      return {
        code: hasLoop ? 'FICT-C002' : 'FICT-C001',
        location: {
          line: node.loc.start.line,
          column: node.loc.start.column,
        },
      }
    }

    if (context === 'nested-function' && functionDepth > 1) {
      return {
        code: null,
        location: {
          line: node.loc.start.line,
          column: node.loc.start.column,
        },
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
          child as BabelCore.types.Node,
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
      value as BabelCore.types.Node,
      macroName,
      context,
      nextAncestors,
    )
    if (found) return found
  }

  return null
}

export function inferCompilerDiagnosticFromSource(
  source: string,
  fileName: string,
  message: string,
): InferredCompilerDiagnostic | null {
  const classification = classifyCompilerPlacementError(message)
  if (!classification) return null

  const ast = parseSourceAstSafely(source, fileName)
  if (!ast) return null

  return findFirstMacroCallInContext(ast, classification.macroName, classification.context)
}

function findAncestorsAtPosition(
  node: BabelCore.types.Node,
  line: number,
  column: number,
  ancestors: BabelCore.types.Node[] = [],
): BabelCore.types.Node[] | null {
  if (!containsPosition(node.loc, line, column)) return null

  const visitorKeys = BabelTypes.VISITOR_KEYS[node.type] ?? []
  for (const key of visitorKeys) {
    const value = (node as unknown as Record<string, unknown>)[key]

    if (Array.isArray(value)) {
      for (const child of value) {
        if (!child || typeof child !== 'object' || !('type' in child)) continue
        const found = findAncestorsAtPosition(child as BabelCore.types.Node, line, column, [
          ...ancestors,
          node,
        ])
        if (found) return found
      }
      continue
    }

    if (!value || typeof value !== 'object' || !('type' in value)) continue
    const found = findAncestorsAtPosition(value as BabelCore.types.Node, line, column, [
      ...ancestors,
      node,
    ])
    if (found) return found
  }

  return [...ancestors, node]
}

function inferDirectCompilerDiagnosticCode(
  source: string,
  fileName: string,
  error: Error & { loc?: { line: number; column: number } },
): string | null {
  const classification = classifyCompilerPlacementError(error.message)
  if (!classification || classification.context !== 'loop-or-conditional') {
    return null
  }

  const location = error.loc ?? extractLocationFromCompilerMessage(error.message)
  if (!location) {
    return inferCompilerDiagnosticFromSource(source, fileName, error.message)?.code ?? null
  }

  const ast = parseSourceAstSafely(source, fileName)
  if (!ast) return null

  const ancestors = findAncestorsAtPosition(ast, location.line, location.column)
  if (!ancestors) return null
  if (ancestors.some(isLoopNode)) return 'FICT-C002'
  if (ancestors.some(isConditionalNode)) return 'FICT-C001'
  return null
}

function normalizeKnownCompilerError(
  source: string,
  fileName: string,
  error: unknown,
): AnalyzeDiagnostic | null {
  if (!(error instanceof Error)) return null

  const errorWithLocation = error as Error & {
    loc?: {
      line: number
      column: number
    }
  }
  const code = inferDirectCompilerDiagnosticCode(source, fileName, errorWithLocation)
  if (!code) return null

  // Use error.loc if available, otherwise extract from message
  const extractedLocation =
    errorWithLocation.loc ?? extractLocationFromCompilerMessage(error.message)
  const inferredDiagnostic = extractedLocation
    ? null
    : inferCompilerDiagnosticFromSource(source, fileName, error.message)

  return {
    code,
    message: error.message.split('\n')[0] ?? error.message,
    severity: DiagnosticSeverity.Error,
    line: extractedLocation?.line ?? inferredDiagnostic?.location.line ?? 0,
    column:
      extractedLocation != null
        ? extractedLocation.column + 1
        : inferredDiagnostic
          ? inferredDiagnostic.location.column + 1
          : 0,
  }
}

function analyzeDiagnostics(
  code: string,
  fileName: string,
  options: AnalyzeOptions,
): AnalyzeDiagnostic[] {
  const warnings: CompilerWarning[] = []
  const pluginOptions: FictCompilerOptions = {
    ...options.compilerOptions,
    dev: true,
    filename: fileName,
    emitModuleMetadata: false,
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
    const knownDiagnostic = normalizeKnownCompilerError(code, fileName, error)
    if (
      knownDiagnostic &&
      !diagnostics.some(
        diagnostic =>
          diagnostic.code === knownDiagnostic.code &&
          diagnostic.line === knownDiagnostic.line &&
          diagnostic.column === knownDiagnostic.column,
      )
    ) {
      diagnostics.push(knownDiagnostic)
    }
    if (diagnostics.some(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)) {
      return diagnostics
    }
    return [...diagnostics, normalizeThrownError(code, fileName, error)]
  }

  return warnings.map(warning => normalizeWarningToDiagnostic(warning, options.compilerOptions))
}

function shouldIncludeFunction(fn: HIRFunction, macroNames: AnalyzeMacroNames): boolean {
  return (
    functionContainsJSX(fn) ||
    functionUsesMacro(fn, macroNames.state) ||
    functionUsesMacro(fn, macroNames.effect)
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
  const macroNames = collectAnalyzeMacroNames(ast)
  let hir
  try {
    hir = buildHIR(ast, macroNames, {
      dev: true,
      fileName,
    })
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
    if (!fn.loc || !shouldIncludeFunction(fn, macroNames)) continue

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
      effectMacroNames: macroNames.effect,
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
