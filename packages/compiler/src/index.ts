import type * as BabelCore from '@babel/core'
import { declare } from '@babel/helper-plugin-utils'
import traverseModule from '@babel/traverse'

import { createCompilerCacheFingerprint } from './cache-fingerprint'
import { SAFE_FUNCTIONS, isRuntimeImportModule } from './constants'
import { debugLog } from './debug'
import { createCompilerExplainArtifact, emitCompilerExplainArtifact } from './explain'
import { buildHIR } from './ir/build-hir'
import { lowerHIRWithRegions } from './ir/codegen'
import { isComponentName, isHookName } from './ir/hook-utils'
import { getFictMacroKind, markFictMacroCall, type FictMacroKind } from './ir/macro-bindings'
import { optimizeHIR } from './ir/optimize'
import { resolveModuleMetadata } from './module-metadata'
import { MODULE_REACTIVE_METADATA_VERSION } from './types'
import type {
  CompilerWarning,
  FictCompilerOptions,
  HookReturnInfoSerializable,
  ModuleReactiveMetadata,
  ReactiveExportKind,
} from './types'
import {
  DirectiveType,
  getRootIdentifier,
  hasDirective,
  isComponentElement,
  isEffectCall,
  isMemoCall,
  isStateCall,
} from './utils'
import { matchesAnyDiagnosticCode, matchesDiagnosticCode } from './validation'

export type { FictCompilerOptions, CompilerWarning } from './types'

function importSpecifierImportedName(
  spec: BabelCore.types.ImportSpecifier,
  t: typeof BabelCore.types,
): string {
  return t.isIdentifier(spec.imported) ? spec.imported.name : String(spec.imported.value)
}

function isReactiveExportKind(value: unknown): value is ReactiveExportKind {
  return value === 'signal' || value === 'memo' || value === 'store'
}

function getOwnReactiveExportKind(
  meta: ModuleReactiveMetadata,
  exportName: string,
): ReactiveExportKind | undefined {
  if (!Object.prototype.hasOwnProperty.call(meta.exports, exportName)) return undefined
  const kind = meta.exports[exportName]
  return isReactiveExportKind(kind) ? kind : undefined
}

function getOwnHookReturnInfo(
  meta: ModuleReactiveMetadata,
  exportName: string,
): HookReturnInfoSerializable | undefined {
  if (!meta.hooks || !Object.prototype.hasOwnProperty.call(meta.hooks, exportName)) {
    return undefined
  }
  return meta.hooks[exportName]
}

function getStaticMemberKeyForDiagnostics(
  member: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
  t: typeof BabelCore.types,
): string | null {
  if (!member.computed) {
    return t.isIdentifier(member.property) ? member.property.name : null
  }
  if (t.isStringLiteral(member.property) || t.isNumericLiteral(member.property)) {
    return String(member.property.value)
  }
  return null
}

function shouldIgnoreIdentifierReference(
  idPath: BabelCore.NodePath<BabelCore.types.Identifier>,
  t: typeof BabelCore.types,
): boolean {
  const parentPath = idPath.parentPath
  if (
    parentPath.isMemberExpression({ property: idPath.node }) &&
    !(idPath.parent as BabelCore.types.MemberExpression).computed
  ) {
    return true
  }
  if (
    parentPath.isOptionalMemberExpression({ property: idPath.node }) &&
    !(idPath.parent as BabelCore.types.OptionalMemberExpression).computed
  ) {
    return true
  }
  if (
    parentPath.isObjectProperty({ key: idPath.node }) &&
    !(idPath.parent as BabelCore.types.ObjectProperty).computed &&
    !(idPath.parent as BabelCore.types.ObjectProperty).shorthand
  ) {
    return true
  }
  if (
    parentPath.isObjectMethod({ key: idPath.node }) &&
    !(idPath.parent as BabelCore.types.ObjectMethod).computed
  ) {
    return true
  }
  if (parentPath.isPrivateName()) {
    return true
  }

  const parent = parentPath.node
  if (
    (t.isClassMethod(parent) || t.isClassProperty(parent) || t.isClassAccessorProperty(parent)) &&
    parent.key === idPath.node &&
    !parent.computed
  ) {
    return true
  }
  if (
    parentPath.isLabeledStatement({ label: idPath.node }) ||
    parentPath.isBreakStatement({ label: idPath.node }) ||
    parentPath.isContinueStatement({ label: idPath.node })
  ) {
    return true
  }
  return false
}

function hookReturnInfoHasAccessor(info: HookReturnInfoSerializable, key: string): boolean {
  if (info.objectProps && Object.prototype.hasOwnProperty.call(info.objectProps, key)) {
    return true
  }
  if (info.arrayProps && Object.prototype.hasOwnProperty.call(info.arrayProps, key)) {
    return true
  }
  return false
}

function pathReadsHookReturnAccessor(
  exprPath: BabelCore.NodePath,
  hookReturnBindingInfo: Map<BabelCore.types.Identifier, HookReturnInfoSerializable>,
  localScopeToIgnore: BabelCore.NodePath['scope'] | undefined,
  t: typeof BabelCore.types,
): boolean {
  if (exprPath.isIdentifier()) {
    const binding = exprPath.scope.getBinding(exprPath.node.name)
    if (!binding || (localScopeToIgnore && binding.scope === localScopeToIgnore)) return false
    const info = hookReturnBindingInfo.get(binding.identifier as BabelCore.types.Identifier)
    return !!info?.directAccessor
  }

  if (!exprPath.isMemberExpression() && !exprPath.isOptionalMemberExpression()) return false
  const object = exprPath.node.object
  if (!t.isIdentifier(object)) return false
  const binding = exprPath.scope.getBinding(object.name)
  if (!binding || (localScopeToIgnore && binding.scope === localScopeToIgnore)) return false
  const info = hookReturnBindingInfo.get(binding.identifier as BabelCore.types.Identifier)
  if (!info) return false
  const key = getStaticMemberKeyForDiagnostics(exprPath.node, t)
  return key !== null && hookReturnInfoHasAccessor(info, key)
}

function stripMacroImports(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  t: typeof BabelCore.types,
): void {
  const nextBody: BabelCore.types.Statement[] = []
  for (const stmt of path.node.body) {
    if (!t.isImportDeclaration(stmt)) {
      nextBody.push(stmt)
      continue
    }
    if (stmt.source.value !== 'fict' && stmt.source.value !== 'fict/slim') {
      nextBody.push(stmt)
      continue
    }
    const filtered = stmt.specifiers.filter(spec => {
      if (t.isImportSpecifier(spec)) {
        return !['$state', '$effect'].includes(importSpecifierImportedName(spec, t))
      }
      return true
    })
    if (filtered.length === 0) {
      continue
    }
    if (filtered.length !== stmt.specifiers.length) {
      nextBody.push(t.importDeclaration(filtered, stmt.source))
      continue
    }
    nextBody.push(stmt)
  }
  path.node.body = nextBody
}

function expressionHasFreeIdentifier(
  expr: BabelCore.types.Expression,
  name: string,
  t: typeof BabelCore.types,
): boolean {
  const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ??
    traverseModule) as typeof traverseModule
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(expr, true))]))
  let found = false

  traverse(file, {
    ReferencedIdentifier(idPath) {
      if (idPath.node.name !== name) return
      if (idPath.scope.getBinding(name)) return
      found = true
      idPath.stop()
    },
  })

  return found
}

function unsupportedTypeScriptRuntimeDeclarationMessage(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): string | null {
  if (t.isTSEnumDeclaration(node) && !node.declare) {
    return 'TypeScript enum declarations must be lowered by TypeScript before Fict compilation.'
  }
  if (t.isTSModuleDeclaration(node) && !node.declare) {
    return 'TypeScript namespace declarations must be lowered by TypeScript before Fict compilation.'
  }
  if (t.isTSImportEqualsDeclaration(node)) {
    return 'TypeScript import equals declarations must be lowered by TypeScript before Fict compilation.'
  }
  if (t.isTSExportAssignment(node)) {
    return 'TypeScript export assignment declarations must be lowered by TypeScript before Fict compilation.'
  }
  return null
}

function isInsideLoop(path: BabelCore.NodePath): boolean {
  let current: BabelCore.NodePath | null = path
  while (current?.parentPath) {
    const parent: BabelCore.NodePath = current.parentPath as BabelCore.NodePath
    if (parent.isFunction?.()) return false
    if (
      parent.isForStatement?.() ||
      parent.isWhileStatement?.() ||
      parent.isDoWhileStatement?.() ||
      parent.isForInStatement?.() ||
      parent.isForOfStatement?.()
    ) {
      return true
    }
    current = parent
  }
  return false
}

function isInsideConditional(path: BabelCore.NodePath): boolean {
  let current: BabelCore.NodePath | null = path
  while (current?.parentPath) {
    const parent: BabelCore.NodePath = current.parentPath as BabelCore.NodePath
    if (parent.isFunction?.()) return false
    if (parent.isIfStatement?.() || parent.isConditionalExpression?.() || parent.isSwitchCase?.()) {
      return true
    }
    if (parent.isLogicalExpression?.() && current.key === 'right') {
      return true
    }
    current = parent
  }
  return false
}

function isInsideJSX(path: BabelCore.NodePath): boolean {
  return !!path.findParent(p => p.isJSXElement?.() || p.isJSXFragment?.())
}

function unwrapTransparentExpression(
  node: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  let current: BabelCore.types.Expression = node
  while (true) {
    const chainCandidate = current as unknown as {
      type?: string
      expression?: BabelCore.types.Node
    }
    if (
      chainCandidate.type === 'ChainExpression' &&
      chainCandidate.expression !== undefined &&
      t.isExpression(chainCandidate.expression)
    ) {
      current = chainCandidate.expression
      continue
    }
    if (t.isParenthesizedExpression(current) && t.isExpression(current.expression)) {
      current = current.expression
      continue
    }
    if (
      (t.isTSAsExpression(current) ||
        t.isTSTypeAssertion(current) ||
        t.isTSNonNullExpression(current) ||
        t.isTSSatisfiesExpression(current) ||
        t.isTSInstantiationExpression(current) ||
        t.isTypeCastExpression(current)) &&
      t.isExpression(current.expression)
    ) {
      current = current.expression
      continue
    }
    return current
  }
}

type WarningSink = (warning: CompilerWarning, path?: BabelCore.NodePath) => void

interface SuppressionDirective {
  line: number
  nextLine: boolean
  codes?: Set<string> | undefined
}

function parseSuppressionCodes(raw?: string): Set<string> | undefined {
  if (!raw) return undefined
  const codes = raw
    .split(/[,\s]+/)
    .map(c => c.trim())
    .filter(Boolean)
  return codes.length > 0 ? new Set(codes) : undefined
}

function parseSuppressions(
  comments: readonly BabelCore.types.Comment[] | null | undefined,
): SuppressionDirective[] {
  if (!comments) return []
  const suppressions: SuppressionDirective[] = []
  for (const comment of comments) {
    if (!comment.loc) continue
    const lines = comment.value.split(/\r\n|\n|\r/)
    const matchEntry = lines
      .map((line, index) => ({
        line: comment.loc!.start.line + index,
        match: line
          .trim()
          .replace(/^\*\s?/, '')
          .match(/^fict-ignore(-next-line)?(?:\s+(.+))?$/i),
      }))
      .find(entry => entry.match)
    if (!matchEntry?.match) continue
    const nextLine = !!matchEntry.match[1]
    suppressions.push({
      line: nextLine ? comment.loc.end.line : matchEntry.line,
      nextLine,
      codes: parseSuppressionCodes(matchEntry.match[2]),
    })
  }
  return suppressions
}

function shouldSuppressWarning(
  suppressions: SuppressionDirective[],
  code: string,
  line: number,
): boolean {
  return suppressions.some(entry => {
    const targetLine = entry.nextLine ? entry.line + 1 : entry.line
    if (targetLine !== line) return false
    if (!entry.codes || entry.codes.size === 0) return true
    return matchesAnyDiagnosticCode(code, entry.codes)
  })
}

type WarningLevel = 'off' | 'warn' | 'error'

const DEFAULT_ERROR_WARNING_CODES = new Set(['FICT-R004'])
const STRICT_REACTIVITY_WARNING_CODES = new Set(['FICT-R003', 'FICT-R006'])
const STRICT_GUARANTEE_WARNING_CODES = new Set([
  'FICT-P001',
  'FICT-P002',
  'FICT-P003',
  'FICT-P004',
  'FICT-P005',
  'FICT-J003',
  'FICT-M',
  'FICT-S002',
  'FICT-H',
  'FICT-R002',
  'FICT-R003',
  'FICT-R005',
  'FICT-R006',
  'FICT-R007',
])

function readBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return undefined
}

function validateStrictGuaranteeConfig(
  options: FictCompilerOptions,
  suppressions: SuppressionDirective[],
): void {
  if (!options.strictGuarantee) return
  if (suppressions.length > 0) {
    throw new SyntaxError(
      'strictGuarantee does not allow fict-ignore suppression comments. Remove suppressions to keep fail-closed guarantees.',
    )
  }
  if (!options.warningLevels) return
  for (const [code, level] of Object.entries(options.warningLevels)) {
    if (!diagnosticCodeOverlaps(code, STRICT_GUARANTEE_WARNING_CODES)) continue
    if (level === 'error') continue
    throw new SyntaxError(
      `strictGuarantee does not allow downgrading ${code} to "${level}". Remove this warningLevels override.`,
    )
  }
}

function diagnosticCodeOverlaps(code: string, patterns: Iterable<string>): boolean {
  for (const pattern of patterns) {
    if (matchesDiagnosticCode(code, pattern) || matchesDiagnosticCode(pattern, code)) {
      return true
    }
  }
  return false
}

function hasErrorEscalation(options: FictCompilerOptions): boolean {
  if (DEFAULT_ERROR_WARNING_CODES.size > 0) return true
  if (options.strictGuarantee) return true
  if (options.strictReactivity) return true
  if (options.warningsAsErrors === true) return true
  if (Array.isArray(options.warningsAsErrors) && options.warningsAsErrors.length > 0) return true
  if (options.warningLevels) {
    return Object.values(options.warningLevels).some(level => level === 'error')
  }
  return false
}

function resolveWarningLevel(code: string, options: FictCompilerOptions): WarningLevel {
  if (options.strictGuarantee && matchesAnyDiagnosticCode(code, STRICT_GUARANTEE_WARNING_CODES)) {
    return 'error'
  }
  const override =
    options.warningLevels?.[code] ??
    Object.entries(options.warningLevels ?? {}).find(([pattern]) =>
      matchesDiagnosticCode(code, pattern),
    )?.[1]
  if (override) return override
  if (options.strictReactivity && matchesAnyDiagnosticCode(code, STRICT_REACTIVITY_WARNING_CODES)) {
    return 'error'
  }
  if (options.warningsAsErrors === true) return 'error'
  if (
    Array.isArray(options.warningsAsErrors) &&
    matchesAnyDiagnosticCode(code, options.warningsAsErrors)
  ) {
    return 'error'
  }
  if (matchesAnyDiagnosticCode(code, DEFAULT_ERROR_WARNING_CODES)) return 'error'
  return 'warn'
}

function formatWarningAsError(warning: CompilerWarning): string {
  const location =
    warning.line > 0 ? `${warning.fileName}:${warning.line}:${warning.column}` : warning.fileName
  return `Fict warning treated as error (${warning.code}): ${warning.message}\n  at ${location}`
}

function formatWarningCodeFrame(warning: CompilerWarning, sourceCode: string): string | null {
  if (warning.line <= 0) return null
  const lines = sourceCode.split(/\r?\n/)
  const lineText = lines[warning.line - 1]
  if (lineText === undefined) return null

  const lineNumber = String(warning.line)
  const gutter = `${lineNumber} | `
  const caretPadding = ' '.repeat(gutter.length + Math.max(0, warning.column - 1))
  return `${gutter}${lineText}\n${caretPadding}^`
}

function buildWarningAsErrorMessage(warning: CompilerWarning, sourceCode?: string): string {
  const base = formatWarningAsError(warning)
  if (!sourceCode || warning.line <= 0) return base

  const frame = formatWarningCodeFrame(warning, sourceCode)

  return frame ? `${base}\n${frame}` : base
}

function createWarningDispatcher(
  onWarn: FictCompilerOptions['onWarn'],
  suppressions: SuppressionDirective[],
  options: FictCompilerOptions,
  dev: boolean,
  sourceCode?: string,
): WarningSink {
  validateStrictGuaranteeConfig(options, suppressions)
  const hasEscalation = hasErrorEscalation(options)
  if (!dev && !hasEscalation) return () => {}
  return (warning, path) => {
    if (shouldSuppressWarning(suppressions, warning.code, warning.line)) return
    const level = resolveWarningLevel(warning.code, options)
    if (level === 'off') return
    if (level === 'error') {
      if (path?.buildCodeFrameError) {
        throw path.buildCodeFrameError(formatWarningAsError(warning))
      }
      throw new SyntaxError(buildWarningAsErrorMessage(warning, sourceCode))
    }
    if (dev && onWarn) {
      onWarn(warning)
    }
  }
}

function emitWarning(
  nodeOrPath: BabelCore.types.Node | BabelCore.NodePath,
  code: string,
  message: string,
  warn: WarningSink,
  fileName: string,
): void {
  const node = 'node' in nodeOrPath ? nodeOrPath.node : nodeOrPath
  const loc = node.loc?.start
  warn(
    {
      code,
      message,
      fileName,
      line: loc?.line ?? 0,
      column: loc ? loc.column + 1 : 0,
    },
    'node' in nodeOrPath ? nodeOrPath : undefined,
  )
}

type CompletionKind = 'normal' | 'abrupt'
type CaseCompletionKind = 'fallthrough' | 'break' | 'abrupt'

function mapToCaseCompletions(completions: Set<CompletionKind>): Set<CaseCompletionKind> {
  const outcomes = new Set<CaseCompletionKind>()
  if (completions.has('normal')) outcomes.add('fallthrough')
  if (completions.has('abrupt')) outcomes.add('abrupt')
  return outcomes
}

function statementListCompletions(statements: BabelCore.types.Statement[]): Set<CompletionKind> {
  let outcomes = new Set<CompletionKind>(['normal'])

  for (const stmt of statements) {
    if (!outcomes.has('normal')) break

    const next = new Set<CompletionKind>()
    outcomes.forEach(outcome => {
      if (outcome !== 'normal') {
        next.add(outcome)
      }
    })
    statementCompletions(stmt).forEach(outcome => next.add(outcome))
    outcomes = next
  }

  return outcomes
}

function caseStatementListCompletions(
  statements: BabelCore.types.Statement[],
): Set<CaseCompletionKind> {
  let outcomes = new Set<CaseCompletionKind>(['fallthrough'])

  for (const stmt of statements) {
    if (!outcomes.has('fallthrough')) break

    const next = new Set<CaseCompletionKind>()
    outcomes.forEach(outcome => {
      if (outcome !== 'fallthrough') {
        next.add(outcome)
      }
    })
    caseStatementCompletions(stmt).forEach(outcome => next.add(outcome))
    outcomes = next
  }

  return outcomes
}

function switchCaseChainCompletions(
  cases: BabelCore.types.SwitchCase[],
  index: number,
): Set<CaseCompletionKind> {
  if (index >= cases.length) {
    return new Set<CaseCompletionKind>(['fallthrough'])
  }

  const currentCase = cases[index]
  if (!currentCase) {
    return new Set<CaseCompletionKind>(['fallthrough'])
  }

  const outcomes = caseStatementListCompletions(currentCase.consequent)
  if (!outcomes.has('fallthrough')) {
    return outcomes
  }

  const nextOutcomes = switchCaseChainCompletions(cases, index + 1)
  const merged = new Set<CaseCompletionKind>()
  outcomes.forEach(outcome => {
    if (outcome !== 'fallthrough') {
      merged.add(outcome)
    }
  })
  nextOutcomes.forEach(outcome => merged.add(outcome))
  return merged
}

function switchCompletions(stmt: BabelCore.types.SwitchStatement): Set<CompletionKind> {
  const outcomes = new Set<CompletionKind>()
  const hasDefaultCase = stmt.cases.some(switchCase => switchCase.test === null)

  if (!hasDefaultCase) {
    outcomes.add('normal')
  }

  stmt.cases.forEach((_, index) => {
    switchCaseChainCompletions(stmt.cases, index).forEach(outcome => {
      if (outcome === 'abrupt') {
        outcomes.add('abrupt')
      } else {
        outcomes.add('normal')
      }
    })
  })

  return outcomes
}

function isStaticTrueExpression(
  expr: BabelCore.types.Expression | null | undefined,
  treatMissingAsTrue = false,
): boolean {
  if (!expr) return treatMissingAsTrue
  return expr.type === 'BooleanLiteral' && expr.value === true
}

function loopCompletions(
  stmt:
    | BabelCore.types.WhileStatement
    | BabelCore.types.ForStatement
    | BabelCore.types.DoWhileStatement,
): Set<CompletionKind> {
  const bodyOutcomes = statementPathCompletions(stmt.body)
  const caseOutcomes = caseStatementPathCompletions(stmt.body)
  if (caseOutcomes.has('break')) {
    return new Set<CompletionKind>(['normal'])
  }

  if (stmt.type === 'DoWhileStatement' && !bodyOutcomes.has('normal')) {
    return new Set<CompletionKind>(['abrupt'])
  }

  const isInfinite =
    stmt.type === 'ForStatement'
      ? isStaticTrueExpression(stmt.test, true)
      : isStaticTrueExpression(stmt.test)

  if (isInfinite && !bodyOutcomes.has('normal')) {
    return new Set<CompletionKind>(['abrupt'])
  }

  return new Set<CompletionKind>(['normal'])
}

function labeledStatementCompletions(stmt: BabelCore.types.LabeledStatement): Set<CompletionKind> {
  const caseOutcomes = caseStatementPathCompletions(stmt.body)
  const outcomes = new Set<CompletionKind>()
  if (caseOutcomes.has('break') || caseOutcomes.has('fallthrough')) {
    outcomes.add('normal')
  }
  if (caseOutcomes.has('abrupt')) {
    outcomes.add('abrupt')
  }
  return outcomes
}

function statementCompletions(stmt: BabelCore.types.Statement): Set<CompletionKind> {
  if (stmt.type === 'ReturnStatement' || stmt.type === 'ThrowStatement') {
    return new Set<CompletionKind>(['abrupt'])
  }

  if (stmt.type === 'BlockStatement') {
    return statementListCompletions(stmt.body)
  }

  if (stmt.type === 'IfStatement') {
    const outcomes = new Set<CompletionKind>()
    statementPathCompletions(stmt.consequent).forEach(outcome => outcomes.add(outcome))
    if (stmt.alternate) {
      statementPathCompletions(stmt.alternate).forEach(outcome => outcomes.add(outcome))
    } else {
      outcomes.add('normal')
    }
    return outcomes
  }

  if (stmt.type === 'SwitchStatement') {
    return switchCompletions(stmt)
  }

  if (
    stmt.type === 'WhileStatement' ||
    stmt.type === 'ForStatement' ||
    stmt.type === 'DoWhileStatement'
  ) {
    return loopCompletions(stmt)
  }

  if (stmt.type === 'LabeledStatement') {
    return labeledStatementCompletions(stmt)
  }

  if (stmt.type === 'TryStatement') {
    const tryOutcomes = statementListCompletions(stmt.block.body)
    const catchOutcomes = stmt.handler
      ? statementListCompletions(stmt.handler.body.body)
      : new Set<CompletionKind>()
    const outcomes = new Set<CompletionKind>([...tryOutcomes, ...catchOutcomes])

    if (!stmt.finalizer) {
      return outcomes
    }

    const finalizerOutcomes = statementListCompletions(stmt.finalizer.body)
    if (!finalizerOutcomes.has('normal')) {
      return new Set<CompletionKind>(['abrupt'])
    }
    return outcomes
  }

  return new Set<CompletionKind>(['normal'])
}

function caseStatementCompletions(stmt: BabelCore.types.Statement): Set<CaseCompletionKind> {
  if (stmt.type === 'BreakStatement') {
    return new Set<CaseCompletionKind>(['break'])
  }

  if (stmt.type === 'BlockStatement') {
    return caseStatementListCompletions(stmt.body)
  }

  if (stmt.type === 'IfStatement') {
    const outcomes = new Set<CaseCompletionKind>()
    caseStatementPathCompletions(stmt.consequent).forEach(outcome => outcomes.add(outcome))
    if (stmt.alternate) {
      caseStatementPathCompletions(stmt.alternate).forEach(outcome => outcomes.add(outcome))
    } else {
      outcomes.add('fallthrough')
    }
    return outcomes
  }

  return mapToCaseCompletions(statementCompletions(stmt))
}

function statementPathCompletions(
  node: BabelCore.types.Statement | BabelCore.types.BlockStatement,
): Set<CompletionKind> {
  return node.type === 'BlockStatement'
    ? statementListCompletions(node.body)
    : statementCompletions(node)
}

function caseStatementPathCompletions(
  node: BabelCore.types.Statement | BabelCore.types.BlockStatement,
): Set<CaseCompletionKind> {
  return node.type === 'BlockStatement'
    ? caseStatementListCompletions(node.body)
    : caseStatementCompletions(node)
}

function functionHasReturn(node: BabelCore.types.Function): boolean {
  if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') return true
  if (node.body && node.body.type === 'BlockStatement') {
    return !statementListCompletions(node.body.body).has('normal')
  }
  return false
}

type CallbackFunctionPath = BabelCore.NodePath<
  BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression
>

function collectCallbackFunctionPaths(
  argPath: BabelCore.NodePath | null | undefined,
): CallbackFunctionPath[] {
  if (!argPath) return []
  if (argPath.isArrowFunctionExpression() || argPath.isFunctionExpression()) {
    return [argPath as CallbackFunctionPath]
  }
  if (argPath.isSequenceExpression()) {
    const expressions = argPath.get('expressions')
    return collectCallbackFunctionPaths(expressions[expressions.length - 1])
  }
  if (argPath.isConditionalExpression()) {
    return [
      ...collectCallbackFunctionPaths(argPath.get('consequent')),
      ...collectCallbackFunctionPaths(argPath.get('alternate')),
    ]
  }
  if (argPath.isLogicalExpression()) {
    return [
      ...collectCallbackFunctionPaths(argPath.get('left')),
      ...collectCallbackFunctionPaths(argPath.get('right')),
    ]
  }
  if (
    argPath.isParenthesizedExpression() ||
    argPath.isTSAsExpression() ||
    argPath.isTSTypeAssertion() ||
    argPath.isTSNonNullExpression() ||
    argPath.isTSSatisfiesExpression() ||
    argPath.isTypeCastExpression()
  ) {
    return collectCallbackFunctionPaths(argPath.get('expression') as BabelCore.NodePath)
  }
  return []
}

function functionHasJSX<T extends BabelCore.types.Function>(
  fnPath: BabelCore.NodePath<T>,
): boolean {
  let found = false
  fnPath.traverse({
    JSXElement(p) {
      found = true
      p.stop()
    },
    JSXFragment(p) {
      found = true
      p.stop()
    },
    Function(inner) {
      if (inner === fnPath) return
      inner.skip()
    },
  })
  return found
}

function unwrapTransparentCallCallee(
  callee:
    | BabelCore.types.CallExpression['callee']
    | BabelCore.types.OptionalCallExpression['callee'],
  t: typeof BabelCore.types,
): BabelCore.types.CallExpression['callee'] | BabelCore.types.OptionalCallExpression['callee'] {
  if (t.isSequenceExpression(callee) && callee.expressions.length > 0) {
    return unwrapTransparentCallCallee(callee.expressions[callee.expressions.length - 1]!, t)
  }
  if (
    t.isParenthesizedExpression(callee) ||
    t.isTSAsExpression(callee) ||
    t.isTSTypeAssertion(callee) ||
    t.isTSNonNullExpression(callee) ||
    t.isTSSatisfiesExpression(callee) ||
    t.isTypeCastExpression(callee)
  ) {
    return unwrapTransparentCallCallee(callee.expression, t)
  }
  return callee
}

function functionUsesStateLike<T extends BabelCore.types.Function>(
  fnPath: BabelCore.NodePath<T>,
  t: typeof BabelCore.types,
): boolean {
  let found = false
  const isFictMacroSource = (source: string): boolean => source === 'fict' || source === 'fict/slim'
  const isSupportedMemoMacroSource = (source: string): boolean =>
    isFictMacroSource(source) || source === 'fict/plus'
  const isStateLikeMacroBinding = (
    callPath: BabelCore.NodePath<BabelCore.types.CallExpression>,
  ) => {
    const callee = unwrapTransparentCallCallee(callPath.node.callee, t)
    if (!t.isIdentifier(callee)) return false
    const calleeName = callee.name
    const binding = callPath.scope.getBinding(calleeName)
    if (!binding) {
      return calleeName === '$state' || calleeName === '$effect' || calleeName === '$memo'
    }
    const bindingNode = binding.path.node
    const importDecl = binding.path.parentPath?.node
    if (!t.isImportSpecifier(bindingNode) || !t.isImportDeclaration(importDecl)) {
      return false
    }

    const importedName = importSpecifierImportedName(bindingNode, t)
    const source = importDecl.source.value
    if ((importedName === '$state' || importedName === '$effect') && isFictMacroSource(source)) {
      return true
    }
    if (importedName === '$memo' && isSupportedMemoMacroSource(source)) {
      return true
    }
    return importedName === 'createMemo' && isRuntimeImportModule(source)
  }
  fnPath.traverse({
    CallExpression(callPath) {
      if (isStateLikeMacroBinding(callPath)) {
        found = true
        callPath.stop()
      }
    },
    JSXElement(p) {
      found = true
      p.stop()
    },
    JSXFragment(p) {
      found = true
      p.stop()
    },
    Function(inner) {
      if (inner === fnPath) return
      inner.skip()
    },
  })
  return found
}

function isDynamicPropertyAccess(
  node: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
  t: typeof BabelCore.types,
): boolean {
  if (!node.computed) return false
  return !(t.isStringLiteral(node.property) || t.isNumericLiteral(node.property))
}

function runWarningPass(
  programPath: BabelCore.NodePath<BabelCore.types.Program>,
  stateBindingIds: Set<BabelCore.types.Identifier>,
  stateRootBindingIds: Set<BabelCore.types.Identifier>,
  reactiveBindingIds: Set<BabelCore.types.Identifier>,
  hookReturnBindingInfo: Map<BabelCore.types.Identifier, HookReturnInfoSerializable>,
  stateMacroNames: Set<string>,
  memoMacroNames: Set<string>,
  effectMacroNames: Set<string>,
  strictMacroBindings: boolean,
  options: FictCompilerOptions,
  warn: WarningSink,
  fileName: string,
  t: typeof BabelCore.types,
): void {
  const hasTrackedBinding = (
    path: BabelCore.NodePath,
    name: string,
    tracked: Set<BabelCore.types.Identifier>,
  ): boolean => {
    const binding = path.scope.getBinding(name)
    return !!(binding && tracked.has(binding.identifier as BabelCore.types.Identifier))
  }

  const isStateRoot = (expr: BabelCore.types.Expression, path: BabelCore.NodePath): boolean => {
    const root = getRootIdentifier(expr, t)
    if (!root) return false
    return hasTrackedBinding(path, root.name, stateRootBindingIds)
  }
  const isReactiveRoot = (expr: BabelCore.types.Expression, path: BabelCore.NodePath): boolean => {
    const root = getRootIdentifier(expr, t)
    if (!root) return false
    return hasTrackedBinding(path, root.name, reactiveBindingIds)
  }
  const unwrapTransparentExpressionNode = (node: BabelCore.types.Node): BabelCore.types.Node => {
    if (
      t.isParenthesizedExpression(node) ||
      t.isTSAsExpression(node) ||
      t.isTSTypeAssertion(node) ||
      t.isTSNonNullExpression(node) ||
      t.isTSSatisfiesExpression(node) ||
      t.isTypeCastExpression(node)
    ) {
      return unwrapTransparentExpressionNode(node.expression)
    }
    return node
  }
  const targetWritesReactiveRoot = (
    node: BabelCore.types.Node | null | undefined,
    path: BabelCore.NodePath,
  ): boolean => {
    if (!node) return false
    const target = unwrapTransparentExpressionNode(node)
    if (
      t.isIdentifier(target) ||
      t.isMemberExpression(target) ||
      t.isOptionalMemberExpression(target)
    ) {
      const root = getRootIdentifier(target as BabelCore.types.Expression, t)
      if (!root) return false
      return (
        hasTrackedBinding(path, root.name, stateRootBindingIds) ||
        hasTrackedBinding(path, root.name, reactiveBindingIds)
      )
    }
    if (t.isAssignmentPattern(target)) {
      return targetWritesReactiveRoot(target.left, path)
    }
    if (t.isRestElement(target)) {
      return targetWritesReactiveRoot(target.argument, path)
    }
    if (t.isArrayPattern(target)) {
      return target.elements.some(element => targetWritesReactiveRoot(element, path))
    }
    if (t.isObjectPattern(target)) {
      return target.properties.some(property => {
        if (t.isObjectProperty(property)) {
          return targetWritesReactiveRoot(property.value, path)
        }
        return targetWritesReactiveRoot(property.argument, path)
      })
    }
    return false
  }
  const jsxChildExpressionWritesReactiveState = (
    exprPath: BabelCore.NodePath<BabelCore.types.JSXExpressionContainer>,
  ): boolean => {
    const expressionPath = exprPath.get('expression') as BabelCore.NodePath<BabelCore.types.Node>
    if (!expressionPath.isExpression()) return false
    let found = false
    const checkWritePath = (writePath: BabelCore.NodePath): void => {
      if (found) return
      if (writePath.isAssignmentExpression()) {
        found = targetWritesReactiveRoot(writePath.node.left, writePath)
      } else if (writePath.isUpdateExpression()) {
        found = targetWritesReactiveRoot(writePath.node.argument, writePath)
      }
    }

    checkWritePath(expressionPath)
    if (found) return true
    if (expressionPath.isJSXElement() || expressionPath.isJSXFragment()) return false

    expressionPath.traverse({
      Function(fnPath) {
        fnPath.skip()
      },
      JSXElement(jsxPath) {
        jsxPath.skip()
      },
      JSXFragment(fragmentPath) {
        fragmentPath.skip()
      },
      AssignmentExpression(assignPath) {
        checkWritePath(assignPath)
        if (found) assignPath.stop()
      },
      UpdateExpression(updatePath) {
        checkWritePath(updatePath)
        if (found) updatePath.stop()
      },
    })
    return found
  }
  const NON_ESCAPING_CALLBACK_METHODS = new Set([
    'map',
    'forEach',
    'filter',
    'some',
    'every',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'flatMap',
    'reduce',
    'reduceRight',
    'sort',
    'toSorted',
  ])
  const MUTATING_ARRAY_METHODS = new Set([
    'copyWithin',
    'fill',
    'pop',
    'push',
    'reverse',
    'shift',
    'sort',
    'splice',
    'unshift',
  ])
  const NON_ESCAPING_CALLBACK_FUNCTION_IMPORTS = new Set([
    'untrack',
    'batch',
    'startTransition',
    'createEffect',
    'createMemo',
    'createRenderEffect',
    'runInScope',
  ])
  const reactiveScopesSet = new Set(options.reactiveScopes ?? [])
  const resolveReactiveScopeName = (
    callee: BabelCore.types.Expression | BabelCore.types.V8IntrinsicIdentifier,
  ): string | null => {
    if (reactiveScopesSet.size === 0) return null
    if (t.isIdentifier(callee)) {
      return reactiveScopesSet.has(callee.name) ? callee.name : null
    }
    if (
      (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
      !callee.computed &&
      t.isIdentifier(callee.property)
    ) {
      return reactiveScopesSet.has(callee.property.name) ? callee.property.name : null
    }
    return null
  }
  const isReactiveScopeBoundaryArgument = (
    callPath: BabelCore.NodePath<
      BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
    >,
    argPath: BabelCore.NodePath,
  ): boolean => {
    if (reactiveScopesSet.size === 0) return false
    const firstArg = callPath.node.arguments[0]
    if (!firstArg || !t.isExpression(firstArg)) return false
    if (firstArg !== argPath.node) return false
    return !!resolveReactiveScopeName(callPath.node.callee)
  }
  const isStoreCreatorCall = (
    callPath: BabelCore.NodePath<
      BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
    >,
  ): boolean => {
    const callee = unwrapTransparentCallCallee(callPath.node.callee, t)
    const isStoreSource = (source: string | undefined) =>
      source === 'fict' || source === 'fict/plus'
    if (t.isIdentifier(callee)) {
      const binding = callPath.scope.getBinding(callee.name)
      if (!binding?.path.isImportSpecifier()) return false
      const importDecl = binding.path.parentPath?.node
      if (!t.isImportDeclaration(importDecl)) return false
      const importedName = importSpecifierImportedName(binding.path.node, t)
      return importedName === '$store' && isStoreSource(importDecl.source.value)
    }
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false
    const propertyName = getStaticPropertyName(callee.property, callee.computed)
    if (propertyName !== '$store') return false
    if (!t.isIdentifier(callee.object)) return false
    const binding = callPath.scope.getBinding(callee.object.name)
    if (!binding?.path.isImportNamespaceSpecifier()) return false
    const importDecl = binding.path.parentPath?.node
    return t.isImportDeclaration(importDecl) && isStoreSource(importDecl.source.value)
  }
  const capturedClosureByBinding = new Map<BabelCore.types.Identifier, Set<string>>()
  const capturedClosureByObjectProperty = new Map<
    BabelCore.types.Identifier,
    Map<string, Set<string>>
  >()
  const capturedClosureByClassMember = new Map<
    BabelCore.types.Identifier,
    { instance: Map<string, Set<string>>; static: Map<string, Set<string>> }
  >()
  const capturedClosureReturnByBinding = new Map<BabelCore.types.Identifier, Set<string>>()
  interface CaptureOptions {
    includeNestedFunctions?: boolean
  }
  const collectCapturedReactiveNames = (
    fnPath: BabelCore.NodePath,
    options: CaptureOptions = {},
  ): Set<string> => {
    const captured = new Set<string>()
    const addHookReturnAccessorCapture = (exprPath: BabelCore.NodePath): boolean => {
      if (!pathReadsHookReturnAccessor(exprPath, hookReturnBindingInfo, fnPath.scope, t)) {
        return false
      }
      if (exprPath.isIdentifier()) {
        captured.add(exprPath.node.name)
        return true
      }
      if (exprPath.isMemberExpression() || exprPath.isOptionalMemberExpression()) {
        const object = exprPath.node.object
        if (t.isIdentifier(object)) {
          captured.add(object.name)
          return true
        }
      }
      return false
    }
    fnPath.traverse({
      Function(inner) {
        if (inner === fnPath) return
        if (options.includeNestedFunctions) return
        inner.skip()
      },
      MemberExpression(memberPath) {
        if (addHookReturnAccessorCapture(memberPath)) memberPath.stop()
      },
      OptionalMemberExpression(memberPath) {
        if (addHookReturnAccessorCapture(memberPath)) memberPath.stop()
      },
      Identifier(idPath) {
        if (shouldIgnoreIdentifierReference(idPath, t)) return
        const name = idPath.node.name
        const binding = idPath.scope.getBinding(name)
        if (!binding) return
        if (addHookReturnAccessorCapture(idPath)) {
          idPath.stop()
          return
        }
        if (!reactiveBindingIds.has(binding.identifier as BabelCore.types.Identifier)) return
        if (binding.scope === idPath.scope || binding.scope === fnPath.scope) return
        captured.add(name)
      },
    })
    return captured
  }
  const getStaticPropertyName = (
    property: BabelCore.types.Expression | BabelCore.types.PrivateName,
    computed: boolean,
  ): string | null => {
    if (t.isPrivateName(property)) return null
    if (!computed && t.isIdentifier(property)) return property.name
    if (t.isStringLiteral(property) || t.isNumericLiteral(property)) return String(property.value)
    return null
  }
  const registerObjectPropertyCapture = (
    objectName: string,
    propertyName: string,
    scopePath: BabelCore.NodePath,
    captured: Set<string>,
  ): void => {
    const binding = scopePath.scope.getBinding(objectName)
    if (!binding) return
    registerObjectPropertyCaptureForBinding(binding, propertyName, captured)
  }
  type ScopeBinding = NonNullable<ReturnType<BabelCore.NodePath['scope']['getBinding']>>
  const resolvingClosureBindings = new Set<BabelCore.types.Identifier>()
  const resolvingClosureReturnBindings = new Set<BabelCore.types.Identifier>()
  const mergeCapturedSets = (
    target: Set<string> | null,
    captured: Set<string> | null,
  ): Set<string> | null => {
    if (!captured || captured.size === 0) return target
    const merged = target ?? new Set<string>()
    for (const name of captured) {
      merged.add(name)
    }
    return merged
  }
  const registerObjectPropertyCaptureForBinding = (
    binding: ScopeBinding,
    propertyName: string,
    captured: Set<string>,
  ): void => {
    const objectBindingId = binding.identifier as BabelCore.types.Identifier
    let propertyCaptures = capturedClosureByObjectProperty.get(objectBindingId)
    if (!propertyCaptures) {
      propertyCaptures = new Map()
      capturedClosureByObjectProperty.set(objectBindingId, propertyCaptures)
    }
    propertyCaptures.set(propertyName, captured)
  }
  const getClassBindingFromPath = (
    classPath: BabelCore.NodePath<
      BabelCore.types.ClassDeclaration | BabelCore.types.ClassExpression
    >,
  ): ScopeBinding | null => {
    if (classPath.isClassDeclaration() && classPath.node.id) {
      return classPath.parentPath.scope.getBinding(classPath.node.id.name) ?? null
    }
    if (
      classPath.isClassExpression() &&
      classPath.parentPath.isVariableDeclarator() &&
      t.isIdentifier(classPath.parentPath.node.id)
    ) {
      return classPath.parentPath.scope.getBinding(classPath.parentPath.node.id.name) ?? null
    }
    return null
  }
  const getClassMemberCaptureStore = (
    binding: ScopeBinding,
  ): { instance: Map<string, Set<string>>; static: Map<string, Set<string>> } => {
    const classBindingId = binding.identifier as BabelCore.types.Identifier
    let store = capturedClosureByClassMember.get(classBindingId)
    if (!store) {
      store = { instance: new Map(), static: new Map() }
      capturedClosureByClassMember.set(classBindingId, store)
    }
    return store
  }
  const registerClassMemberCaptureForBinding = (
    binding: ScopeBinding,
    propertyName: string,
    isStatic: boolean,
    captured: Set<string>,
  ): void => {
    if (captured.size === 0) return
    const store = getClassMemberCaptureStore(binding)
    const target = isStatic ? store.static : store.instance
    target.set(propertyName, captured)
  }
  const getCapturedFromInlineSlots = (
    exprPath: BabelCore.NodePath,
    options: CaptureOptions,
  ): Set<string> | null => {
    let captured: Set<string> | null = null

    if (exprPath.isObjectExpression()) {
      for (const propertyPath of exprPath.get('properties') as BabelCore.NodePath[]) {
        if (propertyPath.isSpreadElement()) {
          captured = mergeCapturedSets(
            captured,
            getCapturedFromExpression(propertyPath.get('argument') as BabelCore.NodePath, options),
          )
          continue
        }
        if (propertyPath.isObjectProperty()) {
          captured = mergeCapturedSets(
            captured,
            getCapturedFromExpression(propertyPath.get('value') as BabelCore.NodePath, options),
          )
          continue
        }
        if (propertyPath.isObjectMethod()) {
          const methodCaptured = collectCapturedReactiveNames(propertyPath, options)
          captured = mergeCapturedSets(captured, methodCaptured.size > 0 ? methodCaptured : null)
        }
      }
      return captured
    }

    if (exprPath.isArrayExpression()) {
      for (const elementPath of exprPath.get('elements') as BabelCore.NodePath[]) {
        if (!elementPath.node) continue
        if (elementPath.isSpreadElement()) {
          captured = mergeCapturedSets(
            captured,
            getCapturedFromExpression(elementPath.get('argument') as BabelCore.NodePath, options),
          )
          continue
        }
        captured = mergeCapturedSets(captured, getCapturedFromExpression(elementPath, options))
      }
    }

    return captured
  }
  const getCapturedFromExpression = (
    exprPath: BabelCore.NodePath,
    options: CaptureOptions = {},
  ): Set<string> | null => {
    if (
      exprPath.isParenthesizedExpression() ||
      exprPath.isTSAsExpression() ||
      exprPath.isTSTypeAssertion() ||
      exprPath.isTSNonNullExpression() ||
      exprPath.isTSSatisfiesExpression() ||
      exprPath.isTypeCastExpression()
    ) {
      return getCapturedFromExpression(exprPath.get('expression') as BabelCore.NodePath, options)
    }
    if (exprPath.isConditionalExpression()) {
      let captured: Set<string> | null = null
      captured = mergeCapturedSets(
        captured,
        getCapturedFromExpression(exprPath.get('consequent') as BabelCore.NodePath, options),
      )
      captured = mergeCapturedSets(
        captured,
        getCapturedFromExpression(exprPath.get('alternate') as BabelCore.NodePath, options),
      )
      return captured
    }
    if (exprPath.isLogicalExpression()) {
      let captured: Set<string> | null = null
      captured = mergeCapturedSets(
        captured,
        getCapturedFromExpression(exprPath.get('left') as BabelCore.NodePath, options),
      )
      captured = mergeCapturedSets(
        captured,
        getCapturedFromExpression(exprPath.get('right') as BabelCore.NodePath, options),
      )
      return captured
    }
    if (exprPath.isSequenceExpression()) {
      const expressions = exprPath.get('expressions') as BabelCore.NodePath[]
      const tail = expressions[expressions.length - 1]
      return tail ? getCapturedFromExpression(tail, options) : null
    }
    if (exprPath.isCallExpression() || exprPath.isOptionalCallExpression()) {
      return getCapturedFromCallResult(exprPath, options)
    }
    if (exprPath.isArrowFunctionExpression() || exprPath.isFunctionExpression()) {
      const captured = collectCapturedReactiveNames(exprPath, options)
      return captured.size > 0 ? captured : null
    }
    if (exprPath.isMemberExpression() || exprPath.isOptionalMemberExpression()) {
      if (pathReadsHookReturnAccessor(exprPath, hookReturnBindingInfo, undefined, t)) {
        const object = exprPath.node.object
        return t.isIdentifier(object) ? new Set([object.name]) : null
      }
      return getCapturedFromMemberExpression(exprPath.node, exprPath, options)
    }
    if (exprPath.isObjectExpression() || exprPath.isArrayExpression()) {
      return getCapturedFromInlineSlots(exprPath, options)
    }
    if (exprPath.isJSXElement() || exprPath.isJSXFragment()) {
      let captured: Set<string> | null = null
      exprPath.traverse({
        Function(fnPath) {
          const fnCaptured = collectCapturedReactiveNames(fnPath, options)
          if (fnCaptured.size > 0) {
            captured = mergeCapturedSets(captured, fnCaptured)
          }
          fnPath.skip()
        },
      })
      return captured
    }
    if (!exprPath.isIdentifier()) return null
    if (pathReadsHookReturnAccessor(exprPath, hookReturnBindingInfo, undefined, t)) {
      return new Set([exprPath.node.name])
    }
    const binding = exprPath.scope.getBinding(exprPath.node.name)
    return binding ? getCapturedFromBinding(binding, options) : null
  }
  const getCapturedFromFunctionReturn = (
    fnPath: BabelCore.NodePath<
      | BabelCore.types.FunctionDeclaration
      | BabelCore.types.FunctionExpression
      | BabelCore.types.ArrowFunctionExpression
    >,
    options: CaptureOptions = {},
  ): Set<string> | null => {
    if (fnPath.isArrowFunctionExpression() && !t.isBlockStatement(fnPath.node.body)) {
      return getCapturedFromExpression(fnPath.get('body') as BabelCore.NodePath, options)
    }

    let captured: Set<string> | null = null
    const bodyPath = fnPath.get('body') as BabelCore.NodePath
    if (!bodyPath.isBlockStatement()) return null
    bodyPath.traverse({
      Function(innerPath) {
        innerPath.skip()
      },
      ReturnStatement(returnPath) {
        const argumentPath = returnPath.get('argument') as BabelCore.NodePath | null
        if (!argumentPath?.node) return
        captured = mergeCapturedSets(captured, getCapturedFromExpression(argumentPath, options))
      },
    })
    return captured
  }
  const getCapturedFromFunctionReturnBinding = (
    binding: ScopeBinding,
    options: CaptureOptions = {},
  ): Set<string> | null => {
    const bindingId = binding.identifier as BabelCore.types.Identifier
    const cached = options.includeNestedFunctions
      ? undefined
      : capturedClosureReturnByBinding.get(bindingId)
    if (cached) return cached.size > 0 ? cached : null
    if (resolvingClosureReturnBindings.has(bindingId)) return null
    resolvingClosureReturnBindings.add(bindingId)

    try {
      let captured: Set<string> | null = null
      if (binding.path.isFunctionDeclaration()) {
        captured = getCapturedFromFunctionReturn(binding.path, options)
      } else if (binding.path.isVariableDeclarator()) {
        const initPath = binding.path.get('init') as BabelCore.NodePath | null
        if (initPath?.isFunctionExpression() || initPath?.isArrowFunctionExpression()) {
          captured = getCapturedFromFunctionReturn(initPath, options)
        }
      }
      if (!options.includeNestedFunctions) {
        capturedClosureReturnByBinding.set(bindingId, captured ?? new Set())
      }
      return captured
    } finally {
      resolvingClosureReturnBindings.delete(bindingId)
    }
  }
  const getCapturedFromCallResult = (
    callPath: BabelCore.NodePath<
      BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
    >,
    options: CaptureOptions = {},
  ): Set<string> | null => {
    const calleePath = callPath.get('callee') as BabelCore.NodePath
    if (calleePath.isArrowFunctionExpression() || calleePath.isFunctionExpression()) {
      return getCapturedFromFunctionReturn(calleePath, options)
    }
    if (!calleePath.isIdentifier()) return null
    const binding = calleePath.scope.getBinding(calleePath.node.name)
    return binding ? getCapturedFromFunctionReturnBinding(binding, options) : null
  }
  const getCapturedFromObjectPropertyPath = (
    propertyPath: BabelCore.NodePath,
    options: CaptureOptions = {},
  ): { propertyName: string; captured: Set<string> } | null => {
    if (propertyPath.isObjectProperty()) {
      const propertyName = getStaticPropertyName(
        propertyPath.node.key as BabelCore.types.Expression,
        propertyPath.node.computed,
      )
      if (!propertyName) return null
      const valuePath = propertyPath.get('value') as BabelCore.NodePath
      const captured = getCapturedFromExpression(valuePath, options)
      return captured ? { propertyName, captured } : null
    }

    if (propertyPath.isObjectMethod()) {
      const propertyName = getStaticPropertyName(
        propertyPath.node.key as BabelCore.types.Expression,
        propertyPath.node.computed,
      )
      if (!propertyName) return null
      const captured = collectCapturedReactiveNames(propertyPath, options)
      return captured.size > 0 ? { propertyName, captured } : null
    }

    return null
  }
  const getCapturedFromObjectInitializerProperty = (
    binding: ScopeBinding,
    propertyName: string,
    options: CaptureOptions = {},
  ): Set<string> | null => {
    if (!binding.path.isVariableDeclarator()) return null
    const initPath = binding.path.get('init') as BabelCore.NodePath | null
    if (!initPath?.isObjectExpression()) return null
    const propertyPaths = initPath.get('properties') as BabelCore.NodePath[]
    for (const propertyPath of propertyPaths) {
      const propertyCapture = getCapturedFromObjectPropertyPath(propertyPath, options)
      if (!propertyCapture || propertyCapture.propertyName !== propertyName) continue
      if (!options.includeNestedFunctions) {
        registerObjectPropertyCaptureForBinding(binding, propertyName, propertyCapture.captured)
      }
      return propertyCapture.captured
    }
    return null
  }
  const getCapturedFromClassMemberPath = (
    memberPath: BabelCore.NodePath,
    options: CaptureOptions = {},
  ): { propertyName: string; isStatic: boolean; captured: Set<string> } | null => {
    const node = memberPath.node
    const isStatic =
      (t.isClassMethod(node) ||
        t.isClassPrivateMethod(node) ||
        t.isClassProperty(node) ||
        t.isClassPrivateProperty(node) ||
        t.isClassAccessorProperty(node)) &&
      node.static === true
    if (t.isClassMethod(node)) {
      const propertyName = getStaticPropertyName(
        node.key as BabelCore.types.Expression,
        node.computed,
      )
      if (!propertyName) return null
      const captured = collectCapturedReactiveNames(memberPath, options)
      return captured.size > 0 ? { propertyName, isStatic, captured } : null
    }
    if (t.isClassProperty(node) || t.isClassAccessorProperty(node)) {
      const propertyName = getStaticPropertyName(
        node.key as BabelCore.types.Expression,
        node.computed,
      )
      const valuePath = memberPath.get('value') as BabelCore.NodePath | null
      if (!propertyName || !valuePath?.node) return null
      const captured = getCapturedFromExpression(valuePath, options)
      return captured ? { propertyName, isStatic, captured } : null
    }
    return null
  }
  const registerClassMemberCaptures = (
    classPath: BabelCore.NodePath<
      BabelCore.types.ClassDeclaration | BabelCore.types.ClassExpression
    >,
  ): void => {
    const binding = getClassBindingFromPath(classPath)
    if (!binding) return
    for (const memberPath of classPath.get('body').get('body') as BabelCore.NodePath[]) {
      const memberCapture = getCapturedFromClassMemberPath(memberPath)
      if (!memberCapture) continue
      registerClassMemberCaptureForBinding(
        binding,
        memberCapture.propertyName,
        memberCapture.isStatic,
        memberCapture.captured,
      )
    }
  }
  const getClassPathFromBinding = (
    binding: ScopeBinding,
  ): BabelCore.NodePath<
    BabelCore.types.ClassDeclaration | BabelCore.types.ClassExpression
  > | null => {
    if (binding.path.isClassDeclaration()) return binding.path
    if (binding.path.isVariableDeclarator()) {
      const initPath = binding.path.get('init') as BabelCore.NodePath | null
      if (initPath?.isClassExpression()) return initPath
    }
    return null
  }
  const getCapturedFromClassMemberBinding = (
    binding: ScopeBinding,
    propertyName: string,
    isStatic: boolean,
    options: CaptureOptions = {},
  ): Set<string> | null => {
    const store = capturedClosureByClassMember.get(binding.identifier as BabelCore.types.Identifier)
    const cached = (isStatic ? store?.static : store?.instance)?.get(propertyName)
    if (cached && cached.size > 0) return cached
    const classPath = getClassPathFromBinding(binding)
    if (!classPath) return null
    for (const memberPath of classPath.get('body').get('body') as BabelCore.NodePath[]) {
      const memberCapture = getCapturedFromClassMemberPath(memberPath, options)
      if (
        !memberCapture ||
        memberCapture.propertyName !== propertyName ||
        memberCapture.isStatic !== isStatic
      ) {
        continue
      }
      if (!options.includeNestedFunctions) {
        registerClassMemberCaptureForBinding(
          binding,
          propertyName,
          isStatic,
          memberCapture.captured,
        )
      }
      return memberCapture.captured
    }
    return null
  }
  const getCapturedFromClassInstanceMember = (
    binding: ScopeBinding,
    propertyName: string,
    options: CaptureOptions = {},
  ): Set<string> | null => {
    if (!binding.path.isVariableDeclarator()) return null
    const initPath = binding.path.get('init') as BabelCore.NodePath | null
    if (!initPath?.isNewExpression()) return null
    const callee = initPath.node.callee
    if (!t.isIdentifier(callee)) return null
    const classBinding = initPath.scope.getBinding(callee.name)
    if (!classBinding) return null
    return getCapturedFromClassMemberBinding(classBinding, propertyName, false, options)
  }
  const registerObjectExpressionPropertyCaptures = (
    objectName: string,
    objectPath: BabelCore.NodePath<BabelCore.types.ObjectExpression>,
    scopePath: BabelCore.NodePath,
  ): void => {
    for (const propertyPath of objectPath.get('properties') as BabelCore.NodePath[]) {
      const propertyCapture = getCapturedFromObjectPropertyPath(propertyPath)
      if (!propertyCapture) continue
      registerObjectPropertyCapture(
        objectName,
        propertyCapture.propertyName,
        scopePath,
        propertyCapture.captured,
      )
    }
  }
  const getCapturedFromMemberExpression = (
    member: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
    scopePath: BabelCore.NodePath,
    options: CaptureOptions = {},
  ): Set<string> | null => {
    if (!t.isIdentifier(member.object)) return null
    const propertyName = getStaticPropertyName(member.property, member.computed)
    if (!propertyName) return null
    const binding = scopePath.scope.getBinding(member.object.name)
    if (!binding) return null
    const staticClassCaptured = getCapturedFromClassMemberBinding(
      binding,
      propertyName,
      true,
      options,
    )
    if (staticClassCaptured) return staticClassCaptured
    const instanceClassCaptured = getCapturedFromClassInstanceMember(binding, propertyName, options)
    if (instanceClassCaptured) return instanceClassCaptured
    const propertyCaptures = capturedClosureByObjectProperty.get(
      binding.identifier as BabelCore.types.Identifier,
    )
    const captured = propertyCaptures?.get(propertyName)
    if (captured && captured.size > 0) return captured
    return getCapturedFromObjectInitializerProperty(binding, propertyName, options)
  }
  const registerClosureCaptureBinding = (
    fnPath: BabelCore.NodePath<
      | BabelCore.types.Function
      | BabelCore.types.FunctionDeclaration
      | BabelCore.types.ArrowFunctionExpression
    >,
    captured: Set<string>,
  ): void => {
    if (captured.size === 0) return
    if (fnPath.isFunctionDeclaration() && fnPath.node.id) {
      const binding = fnPath.parentPath.scope.getBinding(fnPath.node.id.name)
      if (binding) {
        capturedClosureByBinding.set(binding.identifier as BabelCore.types.Identifier, captured)
      }
      return
    }
    if (
      (fnPath.isFunctionExpression() || fnPath.isArrowFunctionExpression()) &&
      fnPath.parentPath.isVariableDeclarator()
    ) {
      const id = fnPath.parentPath.node.id
      if (!t.isIdentifier(id)) return
      const binding = fnPath.parentPath.scope.getBinding(id.name)
      if (binding) {
        capturedClosureByBinding.set(binding.identifier as BabelCore.types.Identifier, captured)
      }
      return
    }
    if (
      (fnPath.isFunctionExpression() || fnPath.isArrowFunctionExpression()) &&
      fnPath.parentPath.isObjectProperty({ value: fnPath.node })
    ) {
      const propertyName = getStaticPropertyName(
        fnPath.parentPath.node.key as BabelCore.types.Expression,
        fnPath.parentPath.node.computed,
      )
      const objectPath = fnPath.parentPath.parentPath
      const containerPath = objectPath?.parentPath
      if (propertyName && objectPath?.isObjectExpression()) {
        if (containerPath?.isVariableDeclarator() && t.isIdentifier(containerPath.node.id)) {
          registerObjectPropertyCapture(
            containerPath.node.id.name,
            propertyName,
            containerPath,
            captured,
          )
          return
        }
        if (containerPath?.isAssignmentExpression({ right: objectPath.node })) {
          const left = containerPath.node.left
          if (t.isIdentifier(left)) {
            registerObjectPropertyCapture(left.name, propertyName, containerPath, captured)
            return
          }
        }
      }
    }
    if (fnPath.parentPath.isAssignmentExpression({ right: fnPath.node })) {
      const left = fnPath.parentPath.node.left
      if (t.isIdentifier(left)) {
        const binding = fnPath.parentPath.scope.getBinding(left.name)
        if (binding) {
          capturedClosureByBinding.set(binding.identifier as BabelCore.types.Identifier, captured)
        }
        return
      }
      if (
        (t.isMemberExpression(left) || t.isOptionalMemberExpression(left)) &&
        t.isIdentifier(left.object)
      ) {
        const propertyName = getStaticPropertyName(left.property, left.computed)
        if (propertyName) {
          registerObjectPropertyCapture(left.object.name, propertyName, fnPath.parentPath, captured)
        }
      }
    }
  }
  const getCapturedFromBinding = (
    binding: ScopeBinding,
    options: CaptureOptions = {},
  ): Set<string> | null => {
    const bindingId = binding.identifier as BabelCore.types.Identifier
    const cached = options.includeNestedFunctions
      ? undefined
      : capturedClosureByBinding.get(bindingId)
    if (cached) return cached.size > 0 ? cached : null
    if (resolvingClosureBindings.has(bindingId)) return null
    resolvingClosureBindings.add(bindingId)

    try {
      if (binding.path.isFunctionDeclaration()) {
        const captured = collectCapturedReactiveNames(binding.path, options)
        if (!options.includeNestedFunctions) {
          capturedClosureByBinding.set(bindingId, captured)
        }
        return captured.size > 0 ? captured : null
      }

      if (binding.path.isVariableDeclarator()) {
        const initPath = binding.path.get('init') as BabelCore.NodePath | null
        if (initPath?.isMemberExpression() || initPath?.isOptionalMemberExpression()) {
          return getCapturedFromMemberExpression(initPath.node, initPath, options)
        }
        if (initPath?.isFunctionExpression() || initPath?.isArrowFunctionExpression()) {
          const captured = collectCapturedReactiveNames(initPath, options)
          if (!options.includeNestedFunctions) {
            capturedClosureByBinding.set(bindingId, captured)
          }
          return captured.size > 0 ? captured : null
        }
      }

      const captured = capturedClosureByBinding.get(bindingId)
      return captured && captured.size > 0 ? captured : null
    } finally {
      resolvingClosureBindings.delete(bindingId)
    }
  }
  const collectCapturedForArgument = (argPath: BabelCore.NodePath): Set<string> | null => {
    return getCapturedFromExpression(argPath, { includeNestedFunctions: true })
  }
  const isNonEscapingCallbackHost = (
    callPath: BabelCore.NodePath<
      BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
    >,
    callee: BabelCore.types.Expression,
  ): boolean => {
    const isKnownArrayReceiver = (expr: BabelCore.types.Expression): boolean => {
      if (t.isArrayExpression(expr)) return true
      if (!t.isIdentifier(expr)) return false
      const binding = callPath.scope.getBinding(expr.name)
      if (!binding?.constant) return false
      if (!binding.path.isVariableDeclarator()) return false
      const init = binding.path.get('init') as BabelCore.NodePath | null
      return !!init?.isArrayExpression()
    }

    if (t.isIdentifier(callee)) {
      const binding = callPath.scope.getBinding(callee.name)
      const bindingPath = binding?.path
      if (bindingPath?.isImportSpecifier()) {
        const imported = bindingPath.node.imported
        const importedName = t.isIdentifier(imported) ? imported.name : imported.value
        const source = bindingPath.parentPath.node
        if (
          source.type === 'ImportDeclaration' &&
          (source.source.value === 'fict' ||
            source.source.value === 'fict/advanced' ||
            source.source.value === '@fictjs/runtime' ||
            source.source.value === '@fictjs/runtime/advanced') &&
          NON_ESCAPING_CALLBACK_FUNCTION_IMPORTS.has(importedName)
        ) {
          return true
        }
      }
    }
    const member =
      t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee) ? callee : null
    if (!member || member.computed || !t.isIdentifier(member.property)) return false
    return (
      NON_ESCAPING_CALLBACK_METHODS.has(member.property.name) &&
      isKnownArrayReceiver(member.object as BabelCore.types.Expression)
    )
  }
  const emitClosureCaptureWarning = (
    nodeOrPath: BabelCore.types.Node | BabelCore.NodePath,
    captured: Set<string>,
  ): void => {
    const names = Array.from(captured).sort().join(', ')
    emitWarning(
      nodeOrPath,
      'FICT-R005',
      `Function captures reactive variable(s): ${names}. Pass them as parameters or memoize explicitly to avoid hidden dependencies.`,
      warn,
      fileName,
    )
  }
  const argumentHasReactive = (argPath: BabelCore.NodePath): boolean => {
    if (argPath.isSpreadElement()) {
      const inner = argPath.get('argument') as BabelCore.NodePath
      return argumentHasReactive(inner)
    }
    if (argPath.isIdentifier()) {
      return (
        pathReadsHookReturnAccessor(argPath, hookReturnBindingInfo, undefined, t) ||
        hasTrackedBinding(argPath, argPath.node.name, reactiveBindingIds)
      )
    }
    if (!argPath.isExpression()) return false
    let found = false
    argPath.traverse({
      Function(path) {
        path.skip()
      },
      MemberExpression(memberPath) {
        if (pathReadsHookReturnAccessor(memberPath, hookReturnBindingInfo, undefined, t)) {
          found = true
          memberPath.stop()
        }
      },
      OptionalMemberExpression(memberPath) {
        if (pathReadsHookReturnAccessor(memberPath, hookReturnBindingInfo, undefined, t)) {
          found = true
          memberPath.stop()
        }
      },
      Identifier(idPath) {
        if (shouldIgnoreIdentifierReference(idPath, t)) return
        if (pathReadsHookReturnAccessor(idPath, hookReturnBindingInfo, undefined, t)) {
          found = true
          idPath.stop()
          return
        }
        const binding = idPath.scope.getBinding(idPath.node.name)
        if (binding && reactiveBindingIds.has(binding.identifier as BabelCore.types.Identifier)) {
          found = true
          idPath.stop()
        }
      },
    })
    return found
  }
  const emitInvocationArgumentEscapeWarnings = (argPaths: BabelCore.NodePath[]): void => {
    for (const argPath of argPaths) {
      if (
        argPath.isIdentifier() &&
        hasTrackedBinding(argPath, argPath.node.name, stateBindingIds)
      ) {
        emitWarning(
          argPath,
          'FICT-S002',
          'State variable is passed as an argument; this passes a value snapshot and may escape component scope.',
          warn,
          fileName,
        )
      }
    }
    for (const argPath of argPaths) {
      if (
        argPath.isIdentifier() &&
        hasTrackedBinding(argPath, argPath.node.name, stateBindingIds)
      ) {
        continue
      }
      if (argumentHasReactive(argPath)) {
        emitWarning(
          argPath,
          'FICT-R002',
          'Reactive value escapes scope when passed to an unknown function; dependency tracking may be imprecise',
          warn,
          fileName,
        )
        break
      }
    }
  }
  const emitCallbackBoundaryWarnings = (
    callPath: BabelCore.NodePath<
      BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
    >,
    callee: BabelCore.types.Expression,
    options: { checkReactiveArguments: boolean },
  ): void => {
    const argPaths = callPath.get('arguments') as BabelCore.NodePath[]
    const nonEscapingCallbackHost = isNonEscapingCallbackHost(callPath, callee)
    if (nonEscapingCallbackHost) return
    if (options.checkReactiveArguments) {
      for (const argPath of argPaths) {
        if (
          isReactiveScopeBoundaryArgument(callPath, argPath) ||
          (argPath.isIdentifier() && hasTrackedBinding(argPath, argPath.node.name, stateBindingIds))
        ) {
          // Direct state bindings already warn via FICT-S002 elsewhere.
          continue
        }
        if (argumentHasReactive(argPath)) {
          emitWarning(
            argPath,
            'FICT-R002',
            'Reactive value escapes scope when passed to an unknown function; dependency tracking may be imprecise',
            warn,
            fileName,
          )
          break
        }
      }
    }
    for (const argPath of argPaths) {
      if (isReactiveScopeBoundaryArgument(callPath, argPath)) continue
      const captured = collectCapturedForArgument(argPath)
      if (!captured) continue
      emitClosureCaptureWarning(argPath, captured)
      break
    }
  }
  const emitReactiveMemberMutationWarning = (
    target: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
    path: BabelCore.NodePath,
  ): boolean => {
    const stateRoot = isStateRoot(target.object as BabelCore.types.Expression, path)
    const reactiveRoot = isReactiveRoot(target.object as BabelCore.types.Expression, path)
    if (!stateRoot && !reactiveRoot) return false
    emitWarning(
      path,
      'FICT-M',
      'Direct mutation of nested property detected; use immutable update or $store helpers',
      warn,
      fileName,
    )
    if (isDynamicPropertyAccess(target, t)) {
      emitWarning(
        path,
        'FICT-H',
        'Dynamic property access widens dependency tracking',
        warn,
        fileName,
      )
    }
    return true
  }
  const emitPatternMemberMutationWarnings = (
    node: BabelCore.types.Node | null | undefined,
    path: BabelCore.NodePath,
  ): boolean => {
    if (!node) return false
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      return emitReactiveMemberMutationWarning(node, path)
    }
    if (t.isAssignmentPattern(node)) {
      return emitPatternMemberMutationWarnings(node.left, path)
    }
    if (t.isRestElement(node)) {
      return emitPatternMemberMutationWarnings(node.argument, path)
    }
    if (t.isObjectPattern(node)) {
      let emitted = false
      for (const prop of node.properties) {
        if (t.isObjectProperty(prop)) {
          emitted = emitPatternMemberMutationWarnings(prop.value, path) || emitted
        } else if (t.isRestElement(prop)) {
          emitted = emitPatternMemberMutationWarnings(prop.argument, path) || emitted
        }
      }
      return emitted
    }
    if (t.isArrayPattern(node)) {
      let emitted = false
      for (const element of node.elements) {
        emitted = emitPatternMemberMutationWarnings(element, path) || emitted
      }
      return emitted
    }
    return false
  }
  programPath.traverse({
    AssignmentExpression(path) {
      const { left } = path.node
      const rightPath = path.get('right') as BabelCore.NodePath
      if (t.isIdentifier(left) && rightPath.isObjectExpression()) {
        registerObjectExpressionPropertyCaptures(left.name, rightPath, path)
      }
      if (
        (t.isMemberExpression(left) || t.isOptionalMemberExpression(left)) &&
        t.isIdentifier(left.object)
      ) {
        const propertyName = getStaticPropertyName(left.property, left.computed)
        const captured = propertyName ? getCapturedFromExpression(rightPath) : null
        if (propertyName && captured) {
          registerObjectPropertyCapture(left.object.name, propertyName, path, captured)
        }
      }
      if (t.isIdentifier(left)) return
      if (t.isMemberExpression(left) || t.isOptionalMemberExpression(left)) {
        if (emitReactiveMemberMutationWarning(left, path)) {
          return
        }
      }
      if (t.isObjectPattern(left) || t.isArrayPattern(left)) {
        emitPatternMemberMutationWarnings(left, path)
      }
    },
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return
      const initPath = path.get('init') as BabelCore.NodePath | null
      if (!initPath?.isObjectExpression()) return
      registerObjectExpressionPropertyCaptures(path.node.id.name, initPath, path)
    },
    Class(path) {
      registerClassMemberCaptures(path)
    },
    UpdateExpression(path) {
      const arg = path.node.argument
      if (t.isMemberExpression(arg) || t.isOptionalMemberExpression(arg)) {
        const stateRoot = isStateRoot(arg.object as BabelCore.types.Expression, path)
        const reactiveRoot = isReactiveRoot(arg.object as BabelCore.types.Expression, path)
        if (stateRoot || reactiveRoot) {
          emitWarning(
            path,
            'FICT-M',
            'Direct mutation of nested property detected; use immutable update or $store helpers',
            warn,
            fileName,
          )
          if (isDynamicPropertyAccess(arg, t)) {
            emitWarning(
              path,
              'FICT-H',
              'Dynamic property access widens dependency tracking',
              warn,
              fileName,
            )
          }
          return
        }
      }
    },
    UnaryExpression(path) {
      if (path.node.operator !== 'delete') return
      const arg = path.node.argument
      if (t.isMemberExpression(arg) || t.isOptionalMemberExpression(arg)) {
        const stateRoot = isStateRoot(arg.object as BabelCore.types.Expression, path)
        const reactiveRoot = isReactiveRoot(arg.object as BabelCore.types.Expression, path)
        if (stateRoot || reactiveRoot) {
          emitWarning(
            path,
            'FICT-M',
            'Direct mutation of nested property detected; use immutable update or $store helpers',
            warn,
            fileName,
          )
          if (isDynamicPropertyAccess(arg, t)) {
            emitWarning(
              path,
              'FICT-H',
              'Dynamic property access widens dependency tracking',
              warn,
              fileName,
            )
          }
        }
      }
    },
    JSXExpressionContainer(path) {
      if (!path.parentPath.isJSXElement() && !path.parentPath.isJSXFragment()) return
      if (!jsxChildExpressionWritesReactiveState(path)) return
      emitWarning(
        path,
        'FICT-R007',
        'Reactive state writes in JSX children cannot be installed as DOM bindings; move the write into an event, effect, or statement before rendering.',
        warn,
        fileName,
      )
    },
    MemberExpression(path) {
      if (!path.node.computed) return
      if (path.parentPath.isAssignmentExpression({ left: path.node })) return
      if (path.parentPath.isUpdateExpression() && path.parentPath.node.argument === path.node) {
        return
      }
      if (
        path.parentPath.isUnaryExpression({ operator: 'delete' }) &&
        path.parentPath.node.argument === path.node
      ) {
        return
      }
      if (
        isDynamicPropertyAccess(path.node, t) &&
        isReactiveRoot(path.node.object as BabelCore.types.Expression, path)
      ) {
        emitWarning(
          path,
          'FICT-H',
          'Dynamic property access widens dependency tracking',
          warn,
          fileName,
        )
      }
    },
    Function(path) {
      const captured = collectCapturedReactiveNames(path)
      registerClosureCaptureBinding(path, captured)
    },
    CallExpression(path) {
      const callNode = path.node as BabelCore.types.CallExpression
      const callbackHasReactiveDependency = (
        callbackPath: BabelCore.NodePath<
          BabelCore.types.FunctionExpression | BabelCore.types.ArrowFunctionExpression
        >,
      ): boolean => {
        let hasReactiveDependency = false
        callbackPath.traverse({
          Function(fnPath) {
            const parent = fnPath.parentPath
            if (
              (parent.isCallExpression() || parent.isOptionalCallExpression()) &&
              parent.node.callee === fnPath.node
            ) {
              return
            }
            fnPath.skip()
          },
          MemberExpression(memberPath) {
            if (
              pathReadsHookReturnAccessor(memberPath, hookReturnBindingInfo, callbackPath.scope, t)
            ) {
              hasReactiveDependency = true
              memberPath.stop()
            }
          },
          OptionalMemberExpression(memberPath) {
            if (
              pathReadsHookReturnAccessor(memberPath, hookReturnBindingInfo, callbackPath.scope, t)
            ) {
              hasReactiveDependency = true
              memberPath.stop()
            }
          },
          Identifier(idPath) {
            if (
              idPath.parentPath.isMemberExpression({ property: idPath.node }) &&
              !(idPath.parent as BabelCore.types.MemberExpression).computed
            ) {
              return
            }
            if (
              idPath.parentPath.isObjectProperty({ key: idPath.node }) &&
              !(idPath.parent as BabelCore.types.ObjectProperty).computed
            ) {
              return
            }
            const binding = idPath.scope.getBinding(idPath.node.name)
            if (binding && binding.scope === callbackPath.scope) return

            if (pathReadsHookReturnAccessor(idPath, hookReturnBindingInfo, callbackPath.scope, t)) {
              hasReactiveDependency = true
              idPath.stop()
              return
            }

            if (
              binding &&
              reactiveBindingIds.has(binding.identifier as BabelCore.types.Identifier)
            ) {
              hasReactiveDependency = true
              idPath.stop()
            }
          },
        })
        return hasReactiveDependency
      }

      const macroKind = getFictMacroKind(callNode)
      if (
        macroKind === 'state' ||
        (!strictMacroBindings && isStateCall(callNode, t, stateMacroNames))
      )
        return
      if (macroKind === 'memo' || (!strictMacroBindings && isMemoCall(callNode, t, memoMacroNames)))
        return

      const isEffect =
        macroKind === 'effect' ||
        (!strictMacroBindings && isEffectCall(callNode, t, effectMacroNames))
      if (isEffect) {
        const argPath = path.get('arguments.0')
        for (const callbackPath of collectCallbackFunctionPaths(argPath)) {
          if (!callbackHasReactiveDependency(callbackPath)) {
            emitWarning(
              callNode,
              'FICT-E001',
              'Effect has no reactive reads; it will run once. Consider removing $effect or adding dependencies.',
              warn,
              fileName,
            )
            break
          }
        }
        return
      }
      if (isStoreCreatorCall(path)) return

      // Re-extract callee to reset TypeScript type narrowing from the $effect check above
      const callee = (path.node as unknown as BabelCore.types.CallExpression)
        .callee as BabelCore.types.Expression
      let calleeName = ''
      let calleeRootName = ''
      if (t.isIdentifier(callee)) {
        calleeName = callee.name
        calleeRootName = callee.name
      } else if (
        (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
        t.isIdentifier(callee.property)
      ) {
        const root = getRootIdentifier(callee.object as BabelCore.types.Expression, t)
        if (root) {
          calleeName = `${root.name}.${callee.property.name}`
          calleeRootName = root.name
        }
      }

      const isSafe =
        calleeName &&
        SAFE_FUNCTIONS.has(calleeName) &&
        !!calleeRootName &&
        !path.scope.getBinding(calleeRootName)
      if (isSafe) return

      const memberCallee =
        t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee) ? callee : null
      if (memberCallee) {
        const methodName = getStaticPropertyName(memberCallee.property, memberCallee.computed)
        if (methodName && MUTATING_ARRAY_METHODS.has(methodName)) {
          const stateRoot = isStateRoot(memberCallee.object as BabelCore.types.Expression, path)
          const reactiveRoot = isReactiveRoot(
            memberCallee.object as BabelCore.types.Expression,
            path,
          )
          if (stateRoot || reactiveRoot) {
            emitWarning(
              path,
              'FICT-M',
              'Direct mutation of nested property detected; use immutable update or $store helpers',
              warn,
              fileName,
            )
          }
        }
      }

      emitCallbackBoundaryWarnings(path, callee, { checkReactiveArguments: true })
    },
    OptionalCallExpression(path) {
      const callee = path.node.callee
      if (!t.isExpression(callee)) return
      emitCallbackBoundaryWarnings(path, callee, { checkReactiveArguments: true })
    },
    NewExpression(path) {
      emitInvocationArgumentEscapeWarnings(path.get('arguments') as BabelCore.NodePath[])
    },
    TaggedTemplateExpression(path) {
      emitInvocationArgumentEscapeWarnings(path.get('quasi.expressions') as BabelCore.NodePath[])
    },
    OptionalMemberExpression(path) {
      if (!path.node.computed) return
      if (path.parentPath.isAssignmentExpression({ left: path.node })) return
      if (path.parentPath.isUpdateExpression() && path.parentPath.node.argument === path.node) {
        return
      }
      if (
        path.parentPath.isUnaryExpression({ operator: 'delete' }) &&
        path.parentPath.node.argument === path.node
      ) {
        return
      }
      if (
        isDynamicPropertyAccess(path.node, t) &&
        isReactiveRoot(path.node.object as BabelCore.types.Expression, path)
      ) {
        emitWarning(
          path.node,
          'FICT-H',
          'Dynamic property access widens dependency tracking',
          warn,
          fileName,
        )
      }
    },
  })
}

function createHIREntrypointVisitor(
  t: typeof BabelCore.types,
  options: FictCompilerOptions,
): BabelCore.PluginObj['visitor'] {
  const collectPatternIdentifiers = (pattern: BabelCore.types.PatternLike): string[] => {
    const ids: string[] = []
    const visit = (p: BabelCore.types.PatternLike) => {
      if (t.isIdentifier(p)) {
        ids.push(p.name)
        return
      }
      if (t.isRestElement(p)) {
        if (t.isIdentifier(p.argument)) ids.push(p.argument.name)
        else if (t.isPatternLike(p.argument)) visit(p.argument as BabelCore.types.PatternLike)
        return
      }
      if (t.isObjectPattern(p)) {
        p.properties.forEach(prop => {
          if (t.isObjectProperty(prop)) {
            if (t.isIdentifier(prop.value)) ids.push(prop.value.name)
            else if (t.isPatternLike(prop.value)) visit(prop.value as BabelCore.types.PatternLike)
          } else if (t.isRestElement(prop)) {
            visit(prop.argument as BabelCore.types.PatternLike)
          }
        })
        return
      }
      if (t.isArrayPattern(p)) {
        p.elements.forEach(el => {
          if (!el) return
          if (t.isIdentifier(el)) ids.push(el.name)
          else if (t.isPatternLike(el)) visit(el as BabelCore.types.PatternLike)
        })
        return
      }
      if (t.isAssignmentPattern(p)) {
        visit(p.left as BabelCore.types.PatternLike)
      }
    }
    visit(pattern)
    return ids
  }

  return {
    Program: {
      enter(path) {
        if (hasDirective(path, DirectiveType.FictCompilerDisable, t)) return
        path.traverse({
          TSEnumDeclaration(tsPath) {
            const message = unsupportedTypeScriptRuntimeDeclarationMessage(tsPath.node, t)
            if (message) throw tsPath.buildCodeFrameError(message)
          },
          TSModuleDeclaration(tsPath) {
            const message = unsupportedTypeScriptRuntimeDeclarationMessage(tsPath.node, t)
            if (message) throw tsPath.buildCodeFrameError(message)
          },
          TSImportEqualsDeclaration(tsPath) {
            const message = unsupportedTypeScriptRuntimeDeclarationMessage(tsPath.node, t)
            if (message) throw tsPath.buildCodeFrameError(message)
          },
          TSExportAssignment(tsPath) {
            const message = unsupportedTypeScriptRuntimeDeclarationMessage(tsPath.node, t)
            if (message) throw tsPath.buildCodeFrameError(message)
          },
        })
      },
      exit(path) {
        if (hasDirective(path, DirectiveType.FictCompilerDisable, t)) return
        const hub = path.hub as unknown as {
          file?: BabelCore.BabelFile & {
            opts?: { filename?: string }
            ast?: BabelCore.types.File
            code?: string
          }
        }
        const sourceProgram = t.cloneNode(path.node, true)
        const fileName = hub.file?.opts?.filename ?? '<unknown>'
        const sourceCode = hub.file?.code
        const comments = hub.file?.ast?.comments ?? []
        const suppressions = parseSuppressions(comments)
        const dev = options.dev !== false
        const explainDiagnostics: CompilerWarning[] = []
        const warn = createWarningDispatcher(
          warning => {
            explainDiagnostics.push(warning)
            options.onWarn?.(warning)
          },
          suppressions,
          options,
          dev,
          sourceCode,
        )
        const optionsWithWarnings: FictCompilerOptions = {
          ...options,
          onWarn: warn,
          filename: fileName,
        }
        // Reactive scopes: function calls whose callbacks are treated as component-like contexts
        const reactiveScopesSet = new Set(options.reactiveScopes ?? [])

        const resolveReactiveScopeName = (
          callee: BabelCore.types.Expression | BabelCore.types.V8IntrinsicIdentifier,
        ): string | null => {
          if (reactiveScopesSet.size === 0) return null
          if (t.isIdentifier(callee)) {
            return reactiveScopesSet.has(callee.name) ? callee.name : null
          }
          if (
            (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
            !callee.computed &&
            t.isIdentifier(callee.property)
          ) {
            return reactiveScopesSet.has(callee.property.name) ? callee.property.name : null
          }
          return null
        }

        // Check if a function is a callback argument to a reactive scope call
        const isReactiveScopeCallback = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean => {
          if (reactiveScopesSet.size === 0) return false
          let parent: BabelCore.NodePath | null = fnPath.parentPath
          while (
            parent &&
            (parent.isParenthesizedExpression?.() ||
              parent.isTSAsExpression?.() ||
              parent.isTSTypeAssertion?.() ||
              parent.isTSNonNullExpression?.() ||
              parent.isTSSatisfiesExpression?.() ||
              parent.isTSInstantiationExpression?.() ||
              parent.isTypeCastExpression?.())
          ) {
            parent = parent.parentPath as BabelCore.NodePath | null
          }
          if (!parent || !(parent.isCallExpression() || parent.isOptionalCallExpression())) {
            return false
          }
          // Check if the function is the first argument
          const firstArg = parent.node.arguments[0]
          if (!firstArg || !t.isExpression(firstArg)) return false
          if (unwrapTransparentExpression(firstArg, t) !== fnPath.node) return false
          const callee = parent.node.callee
          return !!resolveReactiveScopeName(callee)
        }

        // Check if a function node is a reactive scope callback
        const isReactiveScopeCallbackNode = (
          fnNode: BabelCore.types.Function,
          parentNode: BabelCore.types.Node | null | undefined,
        ): boolean => {
          if (reactiveScopesSet.size === 0) return false
          if (!parentNode) return false
          if (!t.isCallExpression(parentNode) && !t.isOptionalCallExpression(parentNode)) {
            return false
          }
          // Check if the function is the first argument
          const firstArg = parentNode.arguments[0]
          if (!firstArg || !t.isExpression(firstArg)) return false
          if (unwrapTransparentExpression(firstArg, t) !== fnNode) return false
          return !!resolveReactiveScopeName(parentNode.callee)
        }

        // Local version of isInsideNestedFunction that respects reactive scope boundaries.
        // Reactive scope callbacks are treated as depth 1 (outermost function), so $state inside
        // them is not considered "nested" as long as it's directly in the callback body.
        const isInsideNestedFunctionWithReactiveScopes = (
          nodePath: BabelCore.NodePath,
        ): boolean => {
          let depth = 0
          let current: BabelCore.NodePath | null = nodePath
          while (current) {
            if (current.isFunction?.()) {
              depth++
              if (
                isReactiveScopeCallbackNode(
                  current.node as BabelCore.types.Function,
                  current.parentPath?.node,
                )
              ) {
                return depth > 1
              }
              if (depth > 1) return true
            }
            current = current.parentPath
          }
          return false
        }

        const getFunctionName = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): string | undefined => {
          if (fnPath.isFunctionDeclaration() && fnPath.node.id) {
            return fnPath.node.id.name
          }
          if (
            (fnPath.isFunctionExpression() || fnPath.isArrowFunctionExpression()) &&
            fnPath.parentPath.isVariableDeclarator() &&
            t.isIdentifier(fnPath.parentPath.node.id) &&
            fnPath.parentPath.node.init === fnPath.node
          ) {
            return fnPath.parentPath.node.id.name
          }
          if (fnPath.isFunctionExpression() && fnPath.node.id) {
            return fnPath.node.id.name
          }
          return undefined
        }
        const isComponentDefinition = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean => {
          const name = getFunctionName(fnPath)
          return (name && isComponentName(name)) || functionHasJSX(fnPath)
        }
        const isHookDefinition = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean => {
          const name = getFunctionName(fnPath)
          return isHookName(name)
        }
        const isComponentOrHookDefinition = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean =>
          isComponentDefinition(fnPath) ||
          isHookDefinition(fnPath) ||
          isReactiveScopeCallback(fnPath)
        const isComponentLike = (fnPath: BabelCore.NodePath<BabelCore.types.Function>): boolean => {
          const name = getFunctionName(fnPath)
          return (
            (name && isComponentName(name)) ||
            isHookName(name) ||
            functionHasJSX(fnPath) ||
            functionUsesStateLike(fnPath, t)
          )
        }
        const isBoundDefinition = (fnPath: BabelCore.NodePath<BabelCore.types.Function>): boolean =>
          fnPath.isFunctionDeclaration() ||
          (fnPath.parentPath.isVariableDeclarator() && fnPath.parentPath.node.init === fnPath.node)
        const isExportDefaultDefinition = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean =>
          fnPath.parentPath?.isExportDefaultDeclaration() &&
          fnPath.parentPath.node.declaration === fnPath.node
        const isNamedComponentOrHookDefinition = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean => {
          if (!isBoundDefinition(fnPath)) return false
          const name = getFunctionName(fnPath)
          return !!name && (isComponentName(name) || isHookName(name))
        }
        const isComponentDefinitionForProps = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean => {
          if (!isComponentDefinition(fnPath)) return false
          return isBoundDefinition(fnPath) || isExportDefaultDefinition(fnPath)
        }
        const memoHasSideEffects = (
          fnPath: BabelCore.NodePath<
            BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression
          >,
        ): boolean => {
          const fn = fnPath.node
          const callScopes = new WeakMap<BabelCore.types.Node, BabelCore.NodePath['scope']>()
          fnPath.traverse({
            CallExpression(callPath) {
              callScopes.set(callPath.node, callPath.scope)
            },
            OptionalCallExpression(callPath) {
              callScopes.set(callPath.node, callPath.scope)
            },
          })
          const pureCalls = new Set(
            Array.from(SAFE_FUNCTIONS).filter(
              name => !name.startsWith('console.') && name !== 'Math.random',
            ),
          )
          const effectfulCalls = new Set([
            '$effect',
            'render',
            'fetch',
            'setTimeout',
            'setInterval',
            'clearTimeout',
            'clearInterval',
            'requestAnimationFrame',
            'cancelAnimationFrame',
          ])
          const userCodeInvokingBuiltins = new Set([
            'JSON.parse',
            'JSON.stringify',
            'Object.values',
            'Object.entries',
            'Array.from',
            'String',
            'Number',
            'parseInt',
            'parseFloat',
            'isNaN',
            'isFinite',
          ])
          const getCalleeName = (
            callee: BabelCore.types.Expression | BabelCore.types.V8IntrinsicIdentifier,
          ): string | null => {
            if (t.isIdentifier(callee)) return callee.name
            if (
              (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
              !callee.computed &&
              t.isIdentifier(callee.property) &&
              t.isIdentifier(callee.object)
            ) {
              return `${callee.object.name}.${callee.property.name}`
            }
            return null
          }
          const getCalleeRootName = (
            callee: BabelCore.types.Expression | BabelCore.types.V8IntrinsicIdentifier,
          ): string | null => {
            if (t.isIdentifier(callee)) return callee.name
            if (
              (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
              !callee.computed &&
              t.isIdentifier(callee.property) &&
              t.isIdentifier(callee.object)
            ) {
              return callee.object.name
            }
            return null
          }
          const mutatingMemberProps = new Set([
            'push',
            'pop',
            'splice',
            'shift',
            'unshift',
            'sort',
            'reverse',
            'set',
            'add',
            'delete',
            'append',
            'appendChild',
            'remove',
            'removeChild',
            'setAttribute',
            'dispatchEvent',
            'replaceChildren',
            'replaceWith',
          ])
          const unwrapStaticMemoValue = (node: BabelCore.types.Node): BabelCore.types.Node => {
            let current = node
            while (
              t.isParenthesizedExpression(current) ||
              t.isTSAsExpression(current) ||
              t.isTSTypeAssertion(current) ||
              t.isTSNonNullExpression(current)
            ) {
              current = current.expression
            }
            return current
          }
          const isPlainPrimitiveMemoValue = (node: BabelCore.types.Node): boolean => {
            const value = unwrapStaticMemoValue(node)
            if (
              t.isStringLiteral(value) ||
              t.isNumericLiteral(value) ||
              t.isBooleanLiteral(value) ||
              t.isNullLiteral(value) ||
              t.isBigIntLiteral(value)
            ) {
              return true
            }
            return (
              t.isUnaryExpression(value) &&
              ['+', '-', '!', '~', 'void'].includes(value.operator) &&
              isPlainPrimitiveMemoValue(value.argument)
            )
          }
          const isPlainMemoDataValue = (node: BabelCore.types.Node): boolean => {
            const value = unwrapStaticMemoValue(node)
            if (isPlainPrimitiveMemoValue(value)) return true
            if (t.isArrayExpression(value)) {
              return value.elements.every(element => {
                if (!element) return true
                return !t.isSpreadElement(element) && isPlainMemoDataValue(element)
              })
            }
            if (t.isObjectExpression(value)) {
              return value.properties.every(prop => {
                if (!t.isObjectProperty(prop) || prop.computed) return false
                return isPlainMemoDataValue(prop.value)
              })
            }
            return false
          }
          const isPlainArrayFromSource = (node: BabelCore.types.Node): boolean => {
            const value = unwrapStaticMemoValue(node)
            if (t.isStringLiteral(value)) return true
            if (t.isArrayExpression(value)) {
              return value.elements.every(element => {
                if (!element) return true
                return !t.isSpreadElement(element) && isPlainMemoDataValue(element)
              })
            }
            return false
          }
          const isUserCodeInvokingBuiltinCall = (
            name: string,
            node: BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression,
          ): boolean => {
            if (!userCodeInvokingBuiltins.has(name)) return false
            if (node.arguments.some(arg => t.isSpreadElement(arg))) return true

            const args = node.arguments as BabelCore.types.Expression[]
            switch (name) {
              case 'JSON.parse':
                return !!args[1]
              case 'JSON.stringify':
                return args.some(arg => !isPlainMemoDataValue(arg))
              case 'Object.values':
              case 'Object.entries': {
                const source = args[0]
                return !!source && !isPlainMemoDataValue(source)
              }
              case 'Array.from': {
                const source = args[0]
                return !!args[1] || (!!source && !isPlainArrayFromSource(source))
              }
              case 'String':
              case 'Number':
              case 'parseInt':
              case 'parseFloat':
              case 'isNaN':
              case 'isFinite':
                return args.some(arg => !isPlainPrimitiveMemoValue(arg))
              default:
                return false
            }
          }
          const isEffectfulCall = (
            node: BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression,
          ): boolean => {
            const name = getCalleeName(node.callee)
            if (!name) return true
            const rootName = getCalleeRootName(node.callee)
            const callScope = callScopes.get(node) ?? fnPath.scope
            if (pureCalls.has(name) && rootName && callScope.getBinding(rootName)) return true
            if (isUserCodeInvokingBuiltinCall(name, node)) return true
            if (pureCalls.has(name)) return false
            if (effectfulCalls.has(name)) return true
            if (
              name.startsWith('console.') ||
              name.startsWith('document.') ||
              name.startsWith('window.')
            ) {
              return true
            }
            if (
              (t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee)) &&
              !node.callee.computed &&
              t.isIdentifier(node.callee.property)
            ) {
              const prop = node.callee.property.name
              if (mutatingMemberProps.has(prop)) return true
              if (
                t.isIdentifier(node.callee.object) &&
                (node.callee.object.name === 'document' || node.callee.object.name === 'window')
              ) {
                return true
              }
            }
            return false
          }
          const checkNode = (node: BabelCore.types.Node | null | undefined): boolean => {
            if (!node) return false
            if (
              t.isAssignmentExpression(node) ||
              t.isUpdateExpression(node) ||
              t.isThrowStatement(node) ||
              t.isNewExpression(node)
            ) {
              return true
            }
            if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
              if (checkNode(node.callee)) return true
              if (node.arguments.some(arg => checkNode(arg as BabelCore.types.Node))) return true
              if (t.isArrowFunctionExpression(node.callee) || t.isFunctionExpression(node.callee)) {
                return checkNode(node.callee.body)
              }
              if (isEffectfulCall(node)) return true
            }
            if (t.isAwaitExpression(node)) return true
            if (t.isExpressionStatement(node)) return checkNode(node.expression)
            if (t.isBlockStatement(node)) return node.body.some(stmt => checkNode(stmt))
            if (t.isReturnStatement(node)) return checkNode(node.argument)
            if (t.isVariableDeclaration(node)) {
              return node.declarations.some(decl => checkPattern(decl.id) || checkNode(decl.init))
            }
            if (t.isSequenceExpression(node)) return node.expressions.some(expr => checkNode(expr))
            if (t.isArrayExpression(node)) {
              return node.elements.some(element => checkNode(element))
            }
            if (t.isObjectExpression(node)) {
              return node.properties.some(prop => {
                if (t.isSpreadElement(prop)) return checkNode(prop.argument)
                if (t.isObjectProperty(prop)) {
                  return (prop.computed && checkNode(prop.key)) || checkNode(prop.value)
                }
                if (t.isObjectMethod(prop)) {
                  return prop.computed && checkNode(prop.key)
                }
                return false
              })
            }
            if (t.isSpreadElement(node)) return checkNode(node.argument)
            if (t.isLogicalExpression(node)) return checkNode(node.left) || checkNode(node.right)
            if (t.isBinaryExpression(node)) return checkNode(node.left) || checkNode(node.right)
            if (t.isUnaryExpression(node)) {
              return node.operator === 'delete' || checkNode(node.argument)
            }
            if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
              return checkNode(node.object) || (node.computed && checkNode(node.property))
            }
            if (t.isTemplateLiteral(node)) {
              return node.expressions.some(expression => checkNode(expression))
            }
            if (t.isTaggedTemplateExpression(node)) {
              return (
                checkNode(node.tag) ||
                node.quasi.expressions.some(expression => checkNode(expression))
              )
            }
            if (t.isParenthesizedExpression(node)) return checkNode(node.expression)
            if (t.isClassExpression(node) || t.isClassDeclaration(node)) {
              const decorators = (node.decorators ?? []) as BabelCore.types.Decorator[]
              if (decorators.some(decorator => checkNode(decorator.expression))) return true
              if (checkNode(node.superClass)) return true
              return node.body.body.some(member => {
                const memberNode = member as BabelCore.types.Node & {
                  computed?: boolean
                  key?: BabelCore.types.Node
                  static?: boolean
                  value?: BabelCore.types.Node | null
                }
                const memberDecorators = ((
                  memberNode as { decorators?: BabelCore.types.Decorator[] }
                ).decorators ?? []) as BabelCore.types.Decorator[]
                if (memberDecorators.some(decorator => checkNode(decorator.expression))) return true
                if (memberNode.computed && checkNode(memberNode.key)) return true
                if (t.isStaticBlock(member)) {
                  return member.body.some(statement => checkNode(statement))
                }
                if (
                  memberNode.static === true &&
                  (t.isClassProperty(member) ||
                    t.isClassPrivateProperty(member) ||
                    t.isClassAccessorProperty(member))
                ) {
                  return checkNode(memberNode.value)
                }
                return false
              })
            }
            if (t.isJSXExpressionContainer(node)) return checkNode(node.expression)
            if (t.isJSXSpreadChild(node)) return checkNode(node.expression)
            if (t.isJSXFragment(node)) {
              return node.children.some(child => checkNode(child))
            }
            if (t.isJSXElement(node)) {
              return (
                node.openingElement.attributes.some(attr => {
                  if (t.isJSXSpreadAttribute(attr)) return checkNode(attr.argument)
                  return t.isJSXAttribute(attr) && checkNode(attr.value)
                }) || node.children.some(child => checkNode(child))
              )
            }
            if (t.isConditionalExpression(node))
              return checkNode(node.test) || checkNode(node.consequent) || checkNode(node.alternate)
            if (t.isIfStatement(node)) {
              return checkNode(node.test) || checkNode(node.consequent) || checkNode(node.alternate)
            }
            if (t.isForStatement(node)) {
              return (
                checkNode(node.init) ||
                checkNode(node.test) ||
                checkNode(node.update) ||
                checkNode(node.body)
              )
            }
            if (t.isForInStatement(node) || t.isForOfStatement(node)) {
              return checkNode(node.left) || checkNode(node.right) || checkNode(node.body)
            }
            if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
              return checkNode(node.test) || checkNode(node.body)
            }
            if (t.isSwitchStatement(node)) {
              return (
                checkNode(node.discriminant) ||
                node.cases.some(
                  switchCase =>
                    checkNode(switchCase.test) ||
                    switchCase.consequent.some(statement => checkNode(statement)),
                )
              )
            }
            if (t.isTryStatement(node)) {
              return (
                checkNode(node.block) || checkNode(node.handler?.body) || checkNode(node.finalizer)
              )
            }
            if (t.isLabeledStatement(node)) return checkNode(node.body)
            if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
              return false
            }
            return false
          }
          const checkPattern = (node: BabelCore.types.Node | null | undefined): boolean => {
            if (!node) return false
            if (t.isAssignmentPattern(node)) return checkPattern(node.left) || checkNode(node.right)
            if (t.isArrayPattern(node)) return node.elements.some(element => checkPattern(element))
            if (t.isObjectPattern(node)) {
              return node.properties.some(prop => {
                if (t.isRestElement(prop)) return checkPattern(prop.argument)
                return t.isObjectProperty(prop) && checkPattern(prop.value as BabelCore.types.Node)
              })
            }
            if (t.isRestElement(node)) return checkPattern(node.argument)
            return false
          }
          return checkNode(fn.body)
        }

        // Warn on component-like functions missing a return
        const emitNoReturnComponentWarning = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): void => {
          if (!functionHasJSX(fnPath) && !functionUsesStateLike(fnPath, t)) return
          if (functionHasReturn(fnPath.node)) return
          emitWarning(
            fnPath,
            'FICT-C004',
            'Component has no return statement and will render nothing.',
            warn,
            fileName,
          )
        }
        path.traverse({
          FunctionDeclaration(fnPath) {
            const name = fnPath.node.id?.name
            if (!isComponentName(name)) return
            emitNoReturnComponentWarning(fnPath)
          },
          VariableDeclarator(varPath) {
            if (!t.isIdentifier(varPath.node.id) || !isComponentName(varPath.node.id.name)) return
            const init = varPath.node.init
            if (!init) return
            if (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init)) {
              return
            }
            const fnPath = varPath.get('init') as BabelCore.NodePath<
              BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression
            >
            emitNoReturnComponentWarning(fnPath)
          },
          ExportDefaultDeclaration(exportPath) {
            const declarationPath = exportPath.get('declaration')
            if (
              !declarationPath.isFunctionDeclaration() &&
              !declarationPath.isFunctionExpression() &&
              !declarationPath.isArrowFunctionExpression()
            ) {
              return
            }
            if (
              declarationPath.isFunctionDeclaration() &&
              isComponentName(declarationPath.node.id?.name)
            ) {
              return
            }

            emitNoReturnComponentWarning(declarationPath)
          },
        })
        // Collect macro imports from fict
        const fictImports = new Set<string>()
        const stateMacroNames = new Set<string>(['$state'])
        const effectMacroNames = new Set<string>(['$effect'])
        const memoMacroNames = new Set<string>(['$memo', 'createMemo'])
        const storeMacroNames = new Set<string>(['$store'])
        const macroBindingIds: Record<FictMacroKind, Set<BabelCore.types.Identifier>> = {
          state: new Set(),
          effect: new Set(),
          memo: new Set(),
        }
        const macroNamespaceBindingSources = new Map<BabelCore.types.Identifier, string>()
        const dollarMemoMacroBindingIds = new Set<BabelCore.types.Identifier>()
        const storeCreatorBindingIds = new Set<BabelCore.types.Identifier>()
        const storeCreatorNamespaceBindingIds = new Set<BabelCore.types.Identifier>()
        const reactiveCreationBindingIds = new Set<BabelCore.types.Identifier>()
        const reactiveCreationNamespaceBindingIds = new Set<BabelCore.types.Identifier>()
        const stateArgumentAllowedBindingIds = new Set<BabelCore.types.Identifier>()
        const importedReactiveBindingIds = new Set<BabelCore.types.Identifier>()
        const hookFunctionReturnInfoByBinding = new Map<
          BabelCore.types.Identifier,
          HookReturnInfoSerializable
        >()
        const hookNamespaceReturnInfoByBinding = new Map<
          BabelCore.types.Identifier,
          NonNullable<ModuleReactiveMetadata['hooks']>
        >()
        const hookReturnBindingInfo = new Map<
          BabelCore.types.Identifier,
          HookReturnInfoSerializable
        >()
        const isReactiveCreationName = (name: string): boolean =>
          name === 'createEffect' ||
          name === 'createMemo' ||
          name === 'createSelector' ||
          name === 'createRenderEffect'
        path.traverse({
          ImportDeclaration(importPath) {
            const source = importPath.node.source.value
            const isFictMacroSource = source === 'fict' || source === 'fict/slim'
            const isSupportedMacroSource = isFictMacroSource || source === 'fict/plus'
            const isRuntimeSource = isRuntimeImportModule(source)
            if (!isSupportedMacroSource && !isRuntimeSource) return
            const addImportBinding = (
              target: Set<BabelCore.types.Identifier>,
              localName: string,
            ): void => {
              const binding = importPath.scope.getBinding(localName)
              if (binding) target.add(binding.identifier as BabelCore.types.Identifier)
            }
            const addNamespaceBinding = (localName: string): void => {
              const binding = importPath.scope.getBinding(localName)
              if (binding) {
                macroNamespaceBindingSources.set(
                  binding.identifier as BabelCore.types.Identifier,
                  source,
                )
              }
            }
            const addStoreNamespaceBinding = (localName: string): void => {
              const binding = importPath.scope.getBinding(localName)
              if (binding) {
                storeCreatorNamespaceBindingIds.add(
                  binding.identifier as BabelCore.types.Identifier,
                )
              }
            }
            for (const spec of importPath.node.specifiers) {
              if (t.isImportNamespaceSpecifier(spec)) {
                if (isFictMacroSource) {
                  addNamespaceBinding(spec.local.name)
                }
                if (source === 'fict' || source === 'fict/plus') {
                  addStoreNamespaceBinding(spec.local.name)
                }
                if (isRuntimeSource) {
                  addImportBinding(reactiveCreationNamespaceBindingIds, spec.local.name)
                }
                continue
              }
              if (t.isImportSpecifier(spec)) {
                const importedName = importSpecifierImportedName(spec, t)
                if (isFictMacroSource) {
                  fictImports.add(importedName)
                  if (importedName === '$state' && t.isIdentifier(spec.local)) {
                    stateMacroNames.add(spec.local.name)
                    addImportBinding(macroBindingIds.state, spec.local.name)
                  }
                  if (importedName === '$effect' && t.isIdentifier(spec.local)) {
                    effectMacroNames.add(spec.local.name)
                    addImportBinding(macroBindingIds.effect, spec.local.name)
                  }
                }
                if (
                  isSupportedMacroSource &&
                  (importedName === '$memo' || importedName === 'createMemo')
                ) {
                  fictImports.add(importedName)
                  if (t.isIdentifier(spec.local)) {
                    memoMacroNames.add(spec.local.name)
                    addImportBinding(macroBindingIds.memo, spec.local.name)
                    if (importedName === '$memo') {
                      addImportBinding(dollarMemoMacroBindingIds, spec.local.name)
                    }
                  }
                }
                if (isRuntimeSource && importedName === 'createMemo') {
                  fictImports.add(importedName)
                  if (t.isIdentifier(spec.local)) {
                    memoMacroNames.add(spec.local.name)
                    addImportBinding(macroBindingIds.memo, spec.local.name)
                  }
                }
                if ((source === 'fict' || source === 'fict/plus') && importedName === '$store') {
                  fictImports.add(importedName)
                  if (t.isIdentifier(spec.local)) {
                    storeMacroNames.add(spec.local.name)
                    addImportBinding(storeCreatorBindingIds, spec.local.name)
                  }
                }
                if (isReactiveCreationName(importedName)) {
                  addImportBinding(reactiveCreationBindingIds, spec.local.name)
                  addImportBinding(stateArgumentAllowedBindingIds, spec.local.name)
                }
                if (importedName === 'render') {
                  addImportBinding(stateArgumentAllowedBindingIds, spec.local.name)
                }
              }
            }
          },
        })
        path.traverse({
          ImportDeclaration(importPath) {
            const meta = resolveModuleMetadata(
              importPath.node.source.value,
              fileName,
              optionsWithWarnings,
            )
            if (!meta) return
            const hasReactiveExports = Object.keys(meta.exports).length > 0
            const hasHookExports = !!meta.hooks && Object.keys(meta.hooks).length > 0
            for (const spec of importPath.node.specifiers) {
              if (t.isImportSpecifier(spec)) {
                const importedName = t.isIdentifier(spec.imported)
                  ? spec.imported.name
                  : String(spec.imported.value)
                if (getOwnReactiveExportKind(meta, importedName)) {
                  const binding = importPath.scope.getBinding(spec.local.name)
                  if (binding) {
                    importedReactiveBindingIds.add(binding.identifier as BabelCore.types.Identifier)
                  }
                }
                const hookInfo = getOwnHookReturnInfo(meta, importedName)
                if (hookInfo) {
                  const binding = importPath.scope.getBinding(spec.local.name)
                  if (binding) {
                    hookFunctionReturnInfoByBinding.set(
                      binding.identifier as BabelCore.types.Identifier,
                      hookInfo,
                    )
                  }
                }
                continue
              }
              if (t.isImportDefaultSpecifier(spec)) {
                if (getOwnReactiveExportKind(meta, 'default')) {
                  const binding = importPath.scope.getBinding(spec.local.name)
                  if (binding) {
                    importedReactiveBindingIds.add(binding.identifier as BabelCore.types.Identifier)
                  }
                }
                const hookInfo = getOwnHookReturnInfo(meta, 'default')
                if (hookInfo) {
                  const binding = importPath.scope.getBinding(spec.local.name)
                  if (binding) {
                    hookFunctionReturnInfoByBinding.set(
                      binding.identifier as BabelCore.types.Identifier,
                      hookInfo,
                    )
                  }
                }
                continue
              }
              if (t.isImportNamespaceSpecifier(spec) && hasReactiveExports) {
                const binding = importPath.scope.getBinding(spec.local.name)
                if (binding) {
                  importedReactiveBindingIds.add(binding.identifier as BabelCore.types.Identifier)
                }
              }
              if (t.isImportNamespaceSpecifier(spec) && hasHookExports && meta.hooks) {
                const binding = importPath.scope.getBinding(spec.local.name)
                if (binding) {
                  hookNamespaceReturnInfoByBinding.set(
                    binding.identifier as BabelCore.types.Identifier,
                    meta.hooks,
                  )
                }
              }
            }
          },
        })
        const staticObjectKey = (key: BabelCore.types.Node, computed?: boolean): string | null => {
          if (!computed && t.isIdentifier(key)) return key.name
          if (t.isStringLiteral(key) || t.isNumericLiteral(key)) return String(key.value)
          return null
        }
        const analyzeLocalHookReturnInfo = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): HookReturnInfoSerializable | null => {
          const reactiveLocals = new Map<string, ReactiveExportKind>()
          fnPath.traverse({
            Function(innerPath) {
              if (innerPath !== fnPath) innerPath.skip()
            },
            VariableDeclarator(declPath) {
              if (!t.isIdentifier(declPath.node.id) || !declPath.node.init) return
              const init = declPath.node.init
              if (!t.isCallExpression(init) && !t.isOptionalCallExpression(init)) return
              const macroKind = getFictMacroKind(init)
              if (macroKind === 'state' || isStateCall(init, t, stateMacroNames)) {
                reactiveLocals.set(declPath.node.id.name, 'signal')
                return
              }
              if (macroKind === 'memo' || isMemoCall(init, t, memoMacroNames)) {
                reactiveLocals.set(declPath.node.id.name, 'memo')
              }
            },
          })

          const info: HookReturnInfoSerializable = {}
          let hasInfo = false
          const localKind = (node: BabelCore.types.Node | null | undefined) =>
            t.isIdentifier(node) ? reactiveLocals.get(node.name) : undefined
          const recordKind = (kind: ReactiveExportKind | undefined, record: () => void) => {
            if (!kind) return
            hasInfo = true
            record()
          }

          fnPath.traverse({
            Function(innerPath) {
              if (innerPath !== fnPath) innerPath.skip()
            },
            ReturnStatement(returnPath) {
              const arg = returnPath.node.argument
              const directKind = localKind(arg)
              if (directKind) {
                info.directAccessor = directKind
                hasInfo = true
                return
              }
              if (t.isObjectExpression(arg)) {
                for (const prop of arg.properties) {
                  if (!t.isObjectProperty(prop) || prop.computed) continue
                  const key = staticObjectKey(prop.key, prop.computed)
                  if (!key) continue
                  const kind = localKind(prop.value)
                  recordKind(kind, () => {
                    info.objectProps = info.objectProps ?? {}
                    info.objectProps[key] = kind!
                  })
                }
                return
              }
              if (t.isArrayExpression(arg)) {
                arg.elements.forEach((element, index) => {
                  const kind = localKind(element)
                  recordKind(kind, () => {
                    info.arrayProps = info.arrayProps ?? {}
                    info.arrayProps![String(index)] = kind!
                  })
                })
              }
            },
          })

          return hasInfo ? info : null
        }
        type ScopeBinding = NonNullable<ReturnType<typeof path.scope.getBinding>>
        const registerLocalHookInfo = (
          binding: ScopeBinding | undefined,
          info: HookReturnInfoSerializable | null,
        ): void => {
          if (!binding || !info) return
          hookFunctionReturnInfoByBinding.set(
            binding.identifier as BabelCore.types.Identifier,
            info,
          )
        }
        path.traverse({
          FunctionDeclaration(fnPath) {
            const name = fnPath.node.id?.name
            if (!name || !isHookName(name)) return
            registerLocalHookInfo(fnPath.scope.getBinding(name), analyzeLocalHookReturnInfo(fnPath))
          },
          VariableDeclarator(declPath) {
            if (!t.isIdentifier(declPath.node.id) || !isHookName(declPath.node.id.name)) return
            const initPath = declPath.get('init') as BabelCore.NodePath | null
            if (!initPath?.isFunction()) return
            registerLocalHookInfo(
              declPath.scope.getBinding(declPath.node.id.name),
              analyzeLocalHookReturnInfo(initPath),
            )
          },
        })
        let hookAliasChanged = true
        while (hookAliasChanged) {
          hookAliasChanged = false
          path.traverse({
            VariableDeclarator(declPath) {
              if (!t.isIdentifier(declPath.node.id) || !t.isIdentifier(declPath.node.init)) return
              const targetBinding = declPath.scope.getBinding(declPath.node.id.name)
              if (
                !targetBinding ||
                hookFunctionReturnInfoByBinding.has(
                  targetBinding.identifier as BabelCore.types.Identifier,
                )
              ) {
                return
              }
              const sourceBinding = declPath.scope.getBinding(declPath.node.init.name)
              const sourceInfo = sourceBinding
                ? hookFunctionReturnInfoByBinding.get(
                    sourceBinding.identifier as BabelCore.types.Identifier,
                  )
                : undefined
              if (!sourceInfo) return
              hookFunctionReturnInfoByBinding.set(
                targetBinding.identifier as BabelCore.types.Identifier,
                sourceInfo,
              )
              hookAliasChanged = true
            },
          })
        }
        const resolveHookCallInfo = (
          call: BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression,
          callPath: BabelCore.NodePath,
        ): HookReturnInfoSerializable | null => {
          const callee = call.callee
          if (t.isIdentifier(callee)) {
            const binding = callPath.scope.getBinding(callee.name)
            return binding
              ? (hookFunctionReturnInfoByBinding.get(
                  binding.identifier as BabelCore.types.Identifier,
                ) ?? null)
              : null
          }
          if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return null
          if (!t.isIdentifier(callee.object)) return null
          const objectBinding = callPath.scope.getBinding(callee.object.name)
          if (!objectBinding) return null
          const namespaceHooks = hookNamespaceReturnInfoByBinding.get(
            objectBinding.identifier as BabelCore.types.Identifier,
          )
          if (!namespaceHooks) return null
          const key = getStaticMemberKeyForDiagnostics(callee, t)
          return key ? (namespaceHooks[key] ?? null) : null
        }
        path.traverse({
          VariableDeclarator(declPath) {
            if (!t.isIdentifier(declPath.node.id) || !declPath.node.init) return
            const init = declPath.node.init
            if (!t.isCallExpression(init) && !t.isOptionalCallExpression(init)) return
            const info = resolveHookCallInfo(init, declPath)
            if (!info) return
            const binding = declPath.scope.getBinding(declPath.node.id.name)
            if (binding) {
              hookReturnBindingInfo.set(binding.identifier as BabelCore.types.Identifier, info)
            }
          },
        })
        path.traverse({
          JSXElement(elementPath) {
            if (isComponentElement(elementPath.node, t)) return
            const attrPaths = elementPath.get('openingElement').get('attributes')
            for (const attrPath of attrPaths) {
              if (!attrPath.isJSXSpreadAttribute()) continue
              emitWarning(
                attrPath,
                'FICT-J003',
                'Spread on native element may include unknown props.',
                warn,
                fileName,
              )
              return
            }
          },
        })
        path.traverse({
          JSXAttribute(attrPath) {
            const expressionContainsInlineFunction = (
              expr: BabelCore.types.Expression,
            ): boolean => {
              if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) return true
              if (t.isConditionalExpression(expr)) {
                return (
                  expressionContainsInlineFunction(expr.consequent) ||
                  expressionContainsInlineFunction(expr.alternate)
                )
              }
              if (t.isLogicalExpression(expr)) {
                return (
                  expressionContainsInlineFunction(expr.left) ||
                  expressionContainsInlineFunction(expr.right)
                )
              }
              if (t.isSequenceExpression(expr)) {
                const tail = expr.expressions[expr.expressions.length - 1]
                return tail ? expressionContainsInlineFunction(tail) : false
              }
              if (t.isParenthesizedExpression(expr)) {
                return expressionContainsInlineFunction(expr.expression)
              }
              if (
                t.isTSAsExpression(expr) ||
                t.isTSTypeAssertion(expr) ||
                t.isTSNonNullExpression(expr) ||
                t.isTSSatisfiesExpression(expr) ||
                t.isTypeCastExpression(expr)
              ) {
                return expressionContainsInlineFunction(expr.expression)
              }
              return false
            }
            if (!t.isJSXIdentifier(attrPath.node.name)) return
            const attrName = attrPath.node.name.name
            if (attrName === 'ref' || /^on[A-Z]/.test(attrName)) return
            if (!t.isJSXExpressionContainer(attrPath.node.value)) return
            const expr = attrPath.node.value.expression
            if (!t.isExpression(expr) || !expressionContainsInlineFunction(expr)) return
            emitWarning(
              attrPath,
              'FICT-X003',
              'Inline function in JSX props may cause unnecessary re-renders.',
              warn,
              fileName,
            )
          },
        })
        // Warn on list rendering without key
        path.traverse({
          JSXExpressionContainer(exprPath) {
            const isMapCallPath = (
              candidatePath: BabelCore.NodePath,
            ): candidatePath is BabelCore.NodePath<
              BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
            > => {
              const node = candidatePath.node
              if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return false
              return (
                (t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee)) &&
                t.isIdentifier(node.callee.property, { name: 'map' })
              )
            }
            const collectRenderedMapCalls = (
              candidatePath: BabelCore.NodePath,
              calls: BabelCore.NodePath<
                BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
              >[],
              seenBindings = new Set<BabelCore.types.Identifier>(),
            ): void => {
              if (isMapCallPath(candidatePath)) {
                calls.push(candidatePath)
                return
              }
              if (candidatePath.isIdentifier()) {
                const binding = candidatePath.scope.getBinding(candidatePath.node.name)
                const bindingId = binding?.identifier as BabelCore.types.Identifier | undefined
                if (!binding || !bindingId || seenBindings.has(bindingId)) return
                if (!binding.path.isVariableDeclarator()) return
                seenBindings.add(bindingId)
                const initPath = binding.path.get('init') as BabelCore.NodePath | null
                if (initPath) collectRenderedMapCalls(initPath, calls, seenBindings)
                return
              }
              if (candidatePath.isConditionalExpression()) {
                collectRenderedMapCalls(candidatePath.get('consequent'), calls, seenBindings)
                collectRenderedMapCalls(candidatePath.get('alternate'), calls, seenBindings)
                return
              }
              if (candidatePath.isLogicalExpression()) {
                collectRenderedMapCalls(candidatePath.get('left'), calls, seenBindings)
                collectRenderedMapCalls(candidatePath.get('right'), calls, seenBindings)
                return
              }
              if (candidatePath.isSequenceExpression()) {
                const expressions = candidatePath.get('expressions')
                const tail = expressions[expressions.length - 1]
                if (tail) collectRenderedMapCalls(tail, calls, seenBindings)
                return
              }
              if (
                candidatePath.isParenthesizedExpression() ||
                candidatePath.isTSAsExpression() ||
                candidatePath.isTSTypeAssertion() ||
                candidatePath.isTSNonNullExpression() ||
                candidatePath.isTSSatisfiesExpression() ||
                candidatePath.isTypeCastExpression()
              ) {
                collectRenderedMapCalls(
                  candidatePath.get('expression') as BabelCore.NodePath,
                  calls,
                  seenBindings,
                )
              }
            }

            const mapCallPaths: BabelCore.NodePath<
              BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
            >[] = []
            collectRenderedMapCalls(exprPath.get('expression') as BabelCore.NodePath, mapCallPaths)
            if (mapCallPaths.length === 0) return

            const getReturnedJsx = (
              fnPath: BabelCore.NodePath<
                BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression
              >,
            ): (BabelCore.types.JSXElement | BabelCore.types.JSXFragment)[] => {
              const collectReturnedJsxFromExpression = (
                node: BabelCore.types.Node | null | undefined,
                returned: (BabelCore.types.JSXElement | BabelCore.types.JSXFragment)[],
              ): void => {
                if (!node) return
                if (t.isJSXElement(node) || t.isJSXFragment(node)) {
                  returned.push(node)
                  return
                }
                if (t.isConditionalExpression(node)) {
                  collectReturnedJsxFromExpression(node.consequent, returned)
                  collectReturnedJsxFromExpression(node.alternate, returned)
                  return
                }
                if (t.isLogicalExpression(node)) {
                  collectReturnedJsxFromExpression(node.left, returned)
                  collectReturnedJsxFromExpression(node.right, returned)
                  return
                }
                if (t.isArrayExpression(node)) {
                  for (const element of node.elements) {
                    if (!element) continue
                    collectReturnedJsxFromExpression(
                      t.isSpreadElement(element) ? element.argument : element,
                      returned,
                    )
                  }
                  return
                }
                if (t.isSequenceExpression(node)) {
                  const tail = node.expressions[node.expressions.length - 1]
                  collectReturnedJsxFromExpression(tail, returned)
                  return
                }
                if (t.isParenthesizedExpression(node)) {
                  collectReturnedJsxFromExpression(node.expression, returned)
                  return
                }
                if (
                  t.isTSAsExpression(node) ||
                  t.isTSTypeAssertion(node) ||
                  t.isTSNonNullExpression(node) ||
                  t.isTSSatisfiesExpression(node) ||
                  t.isTypeCastExpression(node)
                ) {
                  collectReturnedJsxFromExpression(node.expression, returned)
                }
              }

              const fn = fnPath.node
              const returned: (BabelCore.types.JSXElement | BabelCore.types.JSXFragment)[] = []
              if (!t.isBlockStatement(fn.body)) {
                collectReturnedJsxFromExpression(fn.body, returned)
                return returned
              }

              fnPath.get('body').traverse({
                Function(innerFnPath) {
                  innerFnPath.skip()
                },
                ReturnStatement(retPath) {
                  collectReturnedJsxFromExpression(retPath.node.argument, returned)
                },
              })
              return returned
            }

            for (const callExprPath of mapCallPaths) {
              const argPaths = callExprPath.get('arguments')
              const cbPath = Array.isArray(argPaths) ? argPaths[0] : undefined
              if (
                !cbPath ||
                (!cbPath.isArrowFunctionExpression() && !cbPath.isFunctionExpression())
              ) {
                continue
              }

              const returnedJsx = getReturnedJsx(cbPath)
              if (returnedJsx.length === 0) continue
              const indexParam = cbPath.node.params[1]
              const indexParamName = t.isIdentifier(indexParam) ? indexParam.name : null
              const findIndexKeyAttr = (
                jsx: BabelCore.types.JSXElement | BabelCore.types.JSXFragment,
              ): BabelCore.types.JSXAttribute | null => {
                if (!indexParamName || t.isJSXFragment(jsx)) return null
                for (const attr of jsx.openingElement.attributes) {
                  if (
                    t.isJSXAttribute(attr) &&
                    t.isJSXIdentifier(attr.name, { name: 'key' }) &&
                    t.isJSXExpressionContainer(attr.value) &&
                    t.isExpression(attr.value.expression) &&
                    expressionHasFreeIdentifier(attr.value.expression, indexParamName, t)
                  ) {
                    return attr
                  }
                }
                return null
              }

              const hasMissingKeyBranch = returnedJsx.some(jsx => {
                if (t.isJSXFragment(jsx)) return true

                let hasKey = false
                for (const attr of jsx.openingElement.attributes) {
                  if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name: 'key' })) {
                    hasKey = true
                    break
                  }
                }
                return !hasKey
              })

              if (hasMissingKeyBranch) {
                const expr = callExprPath.node
                warn({
                  code: 'FICT-J002',
                  message: 'Missing key prop in list rendering.',
                  fileName,
                  line: expr.loc?.start.line ?? 0,
                  column: expr.loc ? expr.loc.start.column + 1 : 0,
                })
                return
              }

              const indexKeyAttr = returnedJsx.map(findIndexKeyAttr).find(Boolean) ?? null
              if (!indexKeyAttr) continue

              warn({
                code: 'FICT-J001',
                message: 'Dynamic key expression may impact performance.',
                fileName,
                line: indexKeyAttr.loc?.start.line ?? 0,
                column: indexKeyAttr.loc ? indexKeyAttr.loc.start.column + 1 : 0,
              })
              return
            }
          },
        })

        // Validate macro placement consistently for HIR path
        const stateVars = new Set<string>()
        const stateBindingIds = new Set<BabelCore.types.Identifier>()
        const derivedBindingIds = new Set<BabelCore.types.Identifier>()
        const destructuredAliases = new Set<BabelCore.types.Identifier>()
        const aliasBindingIds = new Set<BabelCore.types.Identifier>()
        const stateAliasBindingIds = new Set<BabelCore.types.Identifier>()
        const propsBindingIds = new Set<BabelCore.types.Identifier>()

        const hasTrackedBinding = (
          path: BabelCore.NodePath,
          name: string,
          tracked: Set<BabelCore.types.Identifier>,
        ): boolean => {
          const binding = path.scope.getBinding(name)
          return !!(binding && tracked.has(binding.identifier as BabelCore.types.Identifier))
        }

        const trackBindingByName = (
          path: BabelCore.NodePath,
          name: string,
          tracked: Set<BabelCore.types.Identifier>,
        ): void => {
          const binding = path.scope.getBinding(name)
          if (binding) tracked.add(binding.identifier as BabelCore.types.Identifier)
        }
        const getImportedMacroCallKind = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): FictMacroKind | null => {
          const callee = unwrapTransparentCallCallee(callPath.node.callee, t)
          if (!t.isIdentifier(callee)) return null
          const binding = callPath.scope.getBinding(callee.name)
          if (!binding) return null
          const bindingId = binding.identifier as BabelCore.types.Identifier
          if (macroBindingIds.state.has(bindingId)) return 'state'
          if (macroBindingIds.effect.has(bindingId)) return 'effect'
          if (macroBindingIds.memo.has(bindingId)) return 'memo'
          return null
        }
        const getMacroCallKind = (
          callPath: BabelCore.NodePath<BabelCore.types.CallExpression>,
        ): FictMacroKind | null => {
          const importedKind = getImportedMacroCallKind(callPath)
          if (importedKind) return importedKind
          const callee = callPath.node.callee
          if (!t.isIdentifier(callee)) return null
          if (callPath.scope.getBinding(callee.name)) return null
          if (callee.name === '$state' && !fictImports.has('$state')) return 'state'
          if (callee.name === '$effect' && !fictImports.has('$effect')) return 'effect'
          return null
        }
        const rejectUnsupportedOptionalMacroCall = (
          callPath: BabelCore.NodePath<BabelCore.types.OptionalCallExpression>,
        ): void => {
          const macroKind = getImportedMacroCallKind(callPath)
          if (macroKind !== 'state' && macroKind !== 'effect') return
          const macroName = macroKind === 'state' ? '$state' : '$effect'
          const callee = callPath.node.callee
          const displayName =
            t.isIdentifier(callee) && callee.name !== macroName
              ? `${callee.name} (${macroName})`
              : macroName

          throw callPath.buildCodeFrameError(
            `${displayName} cannot be called with optional-call syntax.\n\n` +
              `Compiler macros are required at compile time. Use ${macroName}(...) directly.`,
          )
        }
        const getImportedValueOnlyMacroName = (
          idPath: BabelCore.NodePath<BabelCore.types.Identifier>,
        ): '$state' | '$effect' | null => {
          const binding = idPath.scope.getBinding(idPath.node.name)
          if (!binding) return null
          const bindingId = binding.identifier as BabelCore.types.Identifier
          if (macroBindingIds.state.has(bindingId)) return '$state'
          if (macroBindingIds.effect.has(bindingId)) return '$effect'
          return null
        }
        const isMacroCallCallee = (
          idPath: BabelCore.NodePath<BabelCore.types.Identifier>,
        ): boolean =>
          (idPath.parentPath.isCallExpression() || idPath.parentPath.isOptionalCallExpression()) &&
          idPath.parentPath.node.callee === idPath.node
        path.traverse({
          Identifier(idPath) {
            if (!idPath.isReferencedIdentifier()) return
            if (isMacroCallCallee(idPath)) return
            const macroName = getImportedValueOnlyMacroName(idPath)
            if (!macroName) return
            const displayName =
              idPath.node.name === macroName ? macroName : `${idPath.node.name} (${macroName})`
            throw idPath.buildCodeFrameError(
              `${displayName} is a compiler macro and cannot be used as a value. ` +
                `Call it only in a supported macro declaration or effect statement.`,
            )
          },
        })
        const getStaticMemberPropertyName = (
          member: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
        ): string | null => {
          if (!member.computed) {
            return t.isIdentifier(member.property) ? member.property.name : null
          }
          if (t.isStringLiteral(member.property) || t.isNumericLiteral(member.property)) {
            return String(member.property.value)
          }
          return null
        }
        const getUnsupportedNamespaceMacroCall = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): { macroName: '$state' | '$effect'; source: string } | null => {
          const callee = callPath.node.callee
          if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return null
          if (!t.isIdentifier(callee.object)) return null
          const propertyName = getStaticMemberPropertyName(callee)
          if (propertyName !== '$state' && propertyName !== '$effect') return null
          const binding = callPath.scope.getBinding(callee.object.name)
          if (!binding) return null
          const source = macroNamespaceBindingSources.get(
            binding.identifier as BabelCore.types.Identifier,
          )
          return source ? { macroName: propertyName, source } : null
        }
        const rejectUnsupportedNamespaceMacroCall = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): void => {
          const macroCall = getUnsupportedNamespaceMacroCall(callPath)
          if (!macroCall) return
          throw callPath.buildCodeFrameError(
            `${macroCall.macroName}() cannot be called through a namespace import from "${macroCall.source}".\n\n` +
              `Use a named macro import instead:\n` +
              `  import { ${macroCall.macroName} } from '${macroCall.source}'`,
          )
        }
        const validateMemberHookPlacement = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): void => {
          const callee = callPath.node.callee
          if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return
          const hookName = getStaticMemberPropertyName(callee)
          if (!hookName || !isHookName(hookName)) return

          const objectName = t.isIdentifier(callee.object) ? callee.object.name : null
          const objectBindingPath = objectName ? callPath.scope.getBinding(objectName)?.path : null
          const isNamespaceHookCall = objectBindingPath?.isImportNamespaceSpecifier() ?? false
          const isPlacementSensitive =
            isInsideLoop(callPath) ||
            isInsideConditional(callPath) ||
            isInsideNestedFunctionWithReactiveScopes(callPath)
          if (!isNamespaceHookCall && !isPlacementSensitive) return

          const ownerFunction = callPath.findParent(parent => {
            if (!parent.isFunction?.()) return false
            return isComponentOrHookDefinition(
              parent as BabelCore.NodePath<BabelCore.types.Function>,
            )
          })
          const displayName = objectName ? `${objectName}.${hookName}` : hookName
          if (!ownerFunction) {
            if (isNamespaceHookCall) {
              throw callPath.buildCodeFrameError(
                `${displayName}() must be called inside a component or hook (useX)`,
              )
            }
            return
          }
          if (isPlacementSensitive) {
            throw callPath.buildCodeFrameError(
              `${displayName}() must be called at the top level of a component or hook (no loops/conditions/nested functions)`,
            )
          }
        }
        const validateDirectHookPlacement = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): void => {
          const callee = callPath.node.callee
          if (!t.isIdentifier(callee)) return
          const calleeId = callee.name
          if (!isHookName(calleeId)) return

          const binding = callPath.scope.getBinding(calleeId)
          const bindingPath = binding?.path
          const bindingIsHook =
            (!bindingPath && isHookName(calleeId)) ||
            bindingPath?.isImportSpecifier() ||
            bindingPath?.isImportDefaultSpecifier() ||
            (bindingPath?.isFunctionDeclaration() &&
              isHookDefinition(bindingPath as BabelCore.NodePath<BabelCore.types.Function>)) ||
            (bindingPath?.isVariableDeclarator() &&
              (() => {
                const init = bindingPath.get('init')
                if (!init?.isFunction()) return false
                return isHookDefinition(init as BabelCore.NodePath<BabelCore.types.Function>)
              })())

          if (!bindingIsHook) return

          const ownerFunction = callPath.getFunctionParent()
          if (!ownerFunction || !isComponentOrHookDefinition(ownerFunction)) {
            throw callPath.buildCodeFrameError(
              `${calleeId}() must be called inside a component or hook (useX)`,
            )
          }
          if (
            isInsideLoop(callPath) ||
            isInsideConditional(callPath) ||
            isInsideNestedFunctionWithReactiveScopes(callPath)
          ) {
            throw callPath.buildCodeFrameError(
              `${calleeId}() must be called at the top level of a component or hook (no loops/conditions/nested functions)`,
            )
          }
        }
        const isImportedReactiveCreationCall = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): boolean => {
          const callee = callPath.node.callee
          if (t.isIdentifier(callee)) {
            const binding = callPath.scope.getBinding(callee.name)
            return !!(
              binding &&
              reactiveCreationBindingIds.has(binding.identifier as BabelCore.types.Identifier)
            )
          }
          if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false
          if (!t.isIdentifier(callee.object)) return false
          const propertyName = getStaticMemberPropertyName(callee)
          if (!propertyName || !isReactiveCreationName(propertyName)) return false
          const binding = callPath.scope.getBinding(callee.object.name)
          return !!(
            binding &&
            reactiveCreationNamespaceBindingIds.has(
              binding.identifier as BabelCore.types.Identifier,
            )
          )
        }
        const getImmediateFunctionInvocationPath = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ):
          | BabelCore.NodePath<BabelCore.types.CallExpression>
          | BabelCore.NodePath<BabelCore.types.OptionalCallExpression>
          | null => {
          const parentPath = fnPath.parentPath
          if (
            (parentPath.isCallExpression() || parentPath.isOptionalCallExpression()) &&
            parentPath.node.callee === fnPath.node
          ) {
            return parentPath
          }
          return null
        }
        const isInsideRuntimeCreatorControlFlow = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): boolean => {
          let current: BabelCore.NodePath | null = callPath
          while (current?.parentPath) {
            const parentPath: BabelCore.NodePath = current.parentPath
            if (parentPath.isFunction()) {
              const invocationPath = getImmediateFunctionInvocationPath(
                parentPath as BabelCore.NodePath<BabelCore.types.Function>,
              )
              if (!invocationPath) return false
              current = invocationPath
              continue
            }
            if (
              parentPath.isForStatement?.() ||
              parentPath.isWhileStatement?.() ||
              parentPath.isDoWhileStatement?.() ||
              parentPath.isForInStatement?.() ||
              parentPath.isForOfStatement?.() ||
              parentPath.isIfStatement?.() ||
              parentPath.isConditionalExpression?.() ||
              parentPath.isSwitchCase?.()
            ) {
              return true
            }
            if (parentPath.isLogicalExpression?.() && current.key === 'right') {
              return true
            }
            current = parentPath
          }
          return false
        }
        const emitReactiveCreationPlacementWarning = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): void => {
          if (
            isImportedReactiveCreationCall(callPath) &&
            isInsideRuntimeCreatorControlFlow(callPath) &&
            !isInsideJSX(callPath)
          ) {
            emitWarning(
              callPath,
              'FICT-R004',
              'Reactive creation inside non-JSX control flow may not auto-dispose in complex paths. Prefer createScope/runInScope (or JSX-managed regions) for explicit lifecycle control.',
              warn,
              fileName,
            )
          }
        }
        const isImportedDollarMemoCall = (
          callPath: BabelCore.NodePath<BabelCore.types.CallExpression>,
        ): boolean => {
          const callee = unwrapTransparentCallCallee(callPath.node.callee, t)
          if (!t.isIdentifier(callee)) return false
          const binding = callPath.scope.getBinding(callee.name)
          return !!(
            binding &&
            dollarMemoMacroBindingIds.has(binding.identifier as BabelCore.types.Identifier)
          )
        }
        const isImportedStoreCall = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): boolean => {
          const callee = unwrapTransparentCallCallee(callPath.node.callee, t)
          if (t.isIdentifier(callee)) {
            const binding = callPath.scope.getBinding(callee.name)
            return !!(
              binding &&
              storeCreatorBindingIds.has(binding.identifier as BabelCore.types.Identifier)
            )
          }
          if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false
          if (!t.isIdentifier(callee.object)) return false
          const propertyName = getStaticMemberPropertyName(callee)
          if (propertyName !== '$store') return false
          const binding = callPath.scope.getBinding(callee.object.name)
          return !!(
            binding &&
            storeCreatorNamespaceBindingIds.has(binding.identifier as BabelCore.types.Identifier)
          )
        }
        const isImportedStateArgumentAllowedCall = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
        ): boolean => {
          const callee = callPath.node.callee
          if (!t.isIdentifier(callee)) return false
          const binding = callPath.scope.getBinding(callee.name)
          return !!(
            binding &&
            stateArgumentAllowedBindingIds.has(binding.identifier as BabelCore.types.Identifier)
          )
        }
        const emitDirectStateArgumentWarnings = (
          callPath: BabelCore.NodePath<
            BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression
          >,
          isAllowedStateCallee: boolean,
        ): void => {
          callPath.node.arguments.forEach(arg => {
            if (
              t.isIdentifier(arg) &&
              hasTrackedBinding(callPath, arg.name, stateBindingIds) &&
              !isAllowedStateCallee
            ) {
              const loc = arg.loc?.start ?? callPath.node.loc?.start
              warn({
                code: 'FICT-S002',
                message:
                  'State variable is passed as an argument; this passes a value snapshot and may escape component scope.',
                fileName,
                line: loc?.line ?? 0,
                column: loc ? loc.column + 1 : 0,
              })
            }
          })
        }
        const hasReactiveAliasSourceBinding = (path: BabelCore.NodePath, name: string): boolean =>
          hasTrackedBinding(path, name, stateBindingIds) ||
          hasTrackedBinding(path, name, derivedBindingIds) ||
          hasTrackedBinding(path, name, aliasBindingIds) ||
          hasTrackedBinding(path, name, destructuredAliases) ||
          hasTrackedBinding(path, name, importedReactiveBindingIds)
        const hasStateRootBinding = (path: BabelCore.NodePath, name: string): boolean =>
          hasTrackedBinding(path, name, stateBindingIds) ||
          hasTrackedBinding(path, name, stateAliasBindingIds)
        const unwrapIdentifier = (
          node: BabelCore.types.Node | null | undefined,
        ): BabelCore.types.Identifier | null => {
          if (!node) return null
          let current: BabelCore.types.Node = node
          while (true) {
            if (t.isTSAsExpression(current)) {
              current = current.expression
              continue
            }
            if (t.isTSNonNullExpression(current)) {
              current = current.expression
              continue
            }
            if (t.isTypeCastExpression?.(current)) {
              current = current.expression
              continue
            }
            break
          }
          return t.isIdentifier(current) ? current : null
        }
        const isStateRootIdentifier = (
          exprPath: BabelCore.NodePath | null | undefined,
        ): BabelCore.types.Identifier | null => {
          if (!exprPath) return null
          const id = unwrapIdentifier(exprPath.node)
          if (!id) return null
          return hasStateRootBinding(exprPath, id.name) ? id : null
        }
        const isImmediateFunctionBodyStatement = (nodePath: BabelCore.NodePath): boolean => {
          const ownerFunction = nodePath.getFunctionParent()
          if (!ownerFunction) return false
          const bodyPath = ownerFunction.get('body')
          if (!bodyPath.isBlockStatement()) return false
          const statementPath = nodePath.isStatement()
            ? nodePath
            : nodePath.findParent(parentPath => parentPath.isStatement())
          return !!statementPath && statementPath.parentPath?.node === bodyPath.node
        }
        const isImmediateProgramStatement = (nodePath: BabelCore.NodePath): boolean => {
          const statementPath = nodePath.isStatement()
            ? nodePath
            : nodePath.findParent(parentPath => parentPath.isStatement())
          return !!statementPath && statementPath.parentPath?.isProgram() === true
        }
        const isImmediateEffectStatement = (
          callPath: BabelCore.NodePath<BabelCore.types.CallExpression>,
        ): boolean => {
          const parentPath = callPath.parentPath
          return !!(
            parentPath?.isExpressionStatement() &&
            parentPath.node.expression === callPath.node &&
            (isImmediateFunctionBodyStatement(parentPath) ||
              isImmediateProgramStatement(parentPath))
          )
        }
        const isImmediateDefaultExportExpression = (
          callPath: BabelCore.NodePath<BabelCore.types.CallExpression>,
        ): boolean => {
          const parentPath = callPath.parentPath
          return !!(
            parentPath?.isExportDefaultDeclaration() &&
            parentPath.node.declaration === callPath.node
          )
        }
        path.traverse({
          VariableDeclarator(varPath) {
            const init = varPath.node.init
            if (!init) return
            const initPath = varPath.get('init')
            const isStateInit =
              initPath.isCallExpression() && getMacroCallKind(initPath) === 'state'
            if (isStateInit) {
              // Check if $state is imported from fict
              if (!fictImports.has('$state')) {
                throw varPath.buildCodeFrameError(
                  `$state() must be imported from "fict".\n\n` +
                    `Add this import at the top of your file:\n` +
                    `  import { $state } from 'fict'`,
                )
              }
              if (!t.isIdentifier(varPath.node.id)) {
                throw varPath.buildCodeFrameError(
                  `Destructuring $state is not supported.\n\n` +
                    `Instead of:  const { a, b } = $state({ a: 1, b: 2 })\n` +
                    `Use:         let state = $state({ a: 1, b: 2 })\n` +
                    `             const { a, b } = state  // read-only aliases\n\n` +
                    `For deep reactivity, consider using $store from 'fict'.`,
                )
              }
              if (isInsideNestedFunctionWithReactiveScopes(varPath)) {
                throw varPath.buildCodeFrameError(
                  `$state() cannot be declared inside nested functions.\n\n` +
                    `Move the $state() declaration to the component's top level,\n` +
                    `or extract the nested logic into a custom hook (useXxx).`,
                )
              }
              const ownerComponent = varPath.getFunctionParent()
              if (!ownerComponent || !isComponentOrHookDefinition(ownerComponent)) {
                throw varPath.buildCodeFrameError(
                  `$state() must be declared inside a component or hook function body.\n\n` +
                    `For module-level shared state, use one of these alternatives:\n` +
                    `  • $store from 'fict' - for deep reactive objects\n` +
                    `  • createSignal from 'fict/advanced' - for primitives`,
                )
              }
              if (!isImmediateFunctionBodyStatement(varPath)) {
                throw varPath.buildCodeFrameError(
                  `$state() cannot be declared inside loops or conditionals.\n\n` +
                    `Signals must be created at the top level of components for stable identity.\n` +
                    `Move the $state() declaration before the nested block.`,
                )
              }
              stateVars.add(varPath.node.id.name)
              trackBindingByName(varPath, varPath.node.id.name, stateBindingIds)
              if (isInsideLoop(varPath) || isInsideConditional(varPath)) {
                throw varPath.buildCodeFrameError(
                  `$state() cannot be declared inside loops or conditionals.\n\n` +
                    `Signals must be created at the top level of components for stable identity.\n` +
                    `Move the $state() declaration before the loop/condition.`,
                )
              }
            } else if (t.isIdentifier(varPath.node.id)) {
              // Check if this is a derived value (const declaration depending on state)
              const parentDecl = varPath.parentPath.node as BabelCore.types.VariableDeclaration
              if (parentDecl.kind === 'const') {
                let dependsOnState = false
                varPath.get('init').traverse({
                  Identifier(idPath: BabelCore.NodePath<BabelCore.types.Identifier>) {
                    if (shouldIgnoreIdentifierReference(idPath, t)) return
                    if (hasTrackedBinding(idPath, idPath.node.name, stateBindingIds)) {
                      dependsOnState = true
                      idPath.stop()
                    }
                  },
                })
                if (dependsOnState) {
                  trackBindingByName(varPath, varPath.node.id.name, derivedBindingIds)
                }
              }
            }
          },
          Function(fnPath) {
            if (isComponentDefinitionForProps(fnPath)) {
              for (const param of fnPath.node.params) {
                if (t.isIdentifier(param)) {
                  trackBindingByName(fnPath, param.name, propsBindingIds)
                  continue
                }
                if (t.isPatternLike(param)) {
                  collectPatternIdentifiers(param).forEach(name =>
                    trackBindingByName(fnPath, name, propsBindingIds),
                  )
                }
              }
            }
            const parentFn = fnPath.getFunctionParent()
            if (!parentFn) return
            if (!isComponentLike(parentFn)) return
            if (!isNamedComponentOrHookDefinition(fnPath)) return
            emitWarning(
              fnPath,
              'FICT-C003',
              'Components should not be defined inside other components. Move this definition to module scope to preserve identity and performance.',
              warn,
              fileName,
            )
          },
          CallExpression(callPath) {
            rejectUnsupportedNamespaceMacroCall(callPath)
            const importedMacroKind = getImportedMacroCallKind(callPath)
            if (importedMacroKind) {
              markFictMacroCall(callPath.node, importedMacroKind)
            }
            const macroKind = importedMacroKind ?? getMacroCallKind(callPath)
            if (macroKind === 'state') {
              const parentPath = callPath.parentPath
              const isVariableDeclarator =
                parentPath?.isVariableDeclarator() && parentPath.node.init === callPath.node

              if (!isVariableDeclarator) {
                throw callPath.buildCodeFrameError(
                  `$state() must be assigned directly to a variable.\n\n` +
                    `Correct usage:\n` +
                    `  let count = $state(0)\n` +
                    `  let user = $state({ name: 'Alice' })\n\n` +
                    `For object state with deep reactivity, consider:\n` +
                    `  import { $store } from 'fict'\n` +
                    `  const user = $store({ name: 'Alice', address: { city: 'NYC' } })`,
                )
              }

              if (!t.isIdentifier(parentPath.node.id)) {
                throw callPath.buildCodeFrameError(
                  `Destructuring $state is not supported.\n\n` +
                    `Instead of:  const { a, b } = $state({ a: 1, b: 2 })\n` +
                    `Use:         let state = $state({ a: 1, b: 2 })\n` +
                    `             const { a, b } = state  // read-only aliases`,
                )
              }

              if (isInsideNestedFunctionWithReactiveScopes(callPath)) {
                throw callPath.buildCodeFrameError(
                  `$state() cannot be declared inside nested functions.\n\n` +
                    `Move the declaration to the component's top level,\n` +
                    `or extract the nested logic into a custom hook (useXxx).`,
                )
              }
              const ownerComponent = callPath.getFunctionParent()
              if (!ownerComponent || !isComponentOrHookDefinition(ownerComponent)) {
                throw callPath.buildCodeFrameError(
                  `$state() must be declared inside a component or hook function body.\n\n` +
                    `For module-level shared state, use one of these alternatives:\n` +
                    `  • $store from 'fict' - for deep reactive objects\n` +
                    `  • createSignal from 'fict/advanced' - for primitives`,
                )
              }
              if (!isImmediateFunctionBodyStatement(parentPath)) {
                throw callPath.buildCodeFrameError(
                  `$state() cannot be declared inside loops or conditionals.\n\n` +
                    `Move the declaration to the top level of your component.\n` +
                    `For dynamic collections, consider using $store with an array/object.`,
                )
              }
              if (isInsideLoop(callPath) || isInsideConditional(callPath)) {
                throw callPath.buildCodeFrameError(
                  `$state() cannot be declared inside loops or conditionals.\n\n` +
                    `Move the declaration to the top of your component.\n` +
                    `For dynamic collections, consider using $store with an array/object.`,
                )
              }
            }
            if (macroKind === 'effect') {
              // Check if $effect is imported from fict
              if (!fictImports.has('$effect')) {
                throw callPath.buildCodeFrameError(
                  `$effect() must be imported from "fict".\n\n` +
                    `Add this import at the top of your file:\n` +
                    `  import { $effect } from 'fict'`,
                )
              }
              if (isInsideNestedFunctionWithReactiveScopes(callPath)) {
                throw callPath.buildCodeFrameError(
                  `$effect() cannot be called inside nested functions.\n\n` +
                    `Move the effect to the component's top level,\n` +
                    `or extract the nested logic into a custom hook (useXxx).`,
                )
              }
              const ownerComponent = callPath.getFunctionParent()
              if (ownerComponent && !isComponentOrHookDefinition(ownerComponent)) {
                throw callPath.buildCodeFrameError(
                  `$effect() must be called inside a component or hook function body, or at module top level.`,
                )
              }
              if (
                !isImmediateEffectStatement(callPath) &&
                !isImmediateDefaultExportExpression(callPath)
              ) {
                throw callPath.buildCodeFrameError(
                  `$effect() cannot be called inside loops or conditionals.\n\n` +
                    `Effects must be registered at the top level of components.\n` +
                    `Move the $effect() call before the nested block.`,
                )
              }
              if (isInsideLoop(callPath) || isInsideConditional(callPath)) {
                throw callPath.buildCodeFrameError(
                  `$effect() cannot be called inside loops or conditionals.\n\n` +
                    `Effects must be registered at the top level of components.\n` +
                    `For conditional effects, use a condition inside the effect body instead:\n` +
                    `  $effect(() => { if (condition) { /* ... */ } })`,
                )
              }
            }
            if (
              isImportedDollarMemoCall(callPath) &&
              (isInsideLoop(callPath) || isInsideConditional(callPath))
            ) {
              throw callPath.buildCodeFrameError(
                `$memo() cannot be called inside loops or conditionals.\n\n` +
                  `Memos must be created at the top level of their component or module scope.\n` +
                  `Move the $memo() call before the nested block.`,
              )
            }
            if (isImportedStoreCall(callPath)) return
            emitReactiveCreationPlacementWarning(callPath)
            validateMemberHookPlacement(callPath)
            validateDirectHookPlacement(callPath)
            const isAllowedStateCallee =
              macroKind === 'effect' ||
              macroKind === 'memo' ||
              isImportedStateArgumentAllowedCall(callPath)
            emitDirectStateArgumentWarnings(callPath, isAllowedStateCallee)
            if (
              macroKind === 'memo' &&
              (fictImports.has('$memo') || fictImports.has('createMemo'))
            ) {
              const firstArgPath = callPath.get('arguments.0')
              const callbackPaths = collectCallbackFunctionPaths(firstArgPath)
              if (callbackPaths.length > 0) {
                let hasReactiveDependency = false
                let firstSideEffectPath: CallbackFunctionPath | null = null
                for (const callbackPath of callbackPaths) {
                  let callbackHasReactiveDependency = false
                  callbackPath.traverse({
                    Function(fnPath) {
                      const parent = fnPath.parentPath
                      if (
                        (parent.isCallExpression() || parent.isOptionalCallExpression()) &&
                        parent.node.callee === fnPath.node
                      ) {
                        return
                      }
                      fnPath.skip()
                    },
                    MemberExpression(memberPath) {
                      if (
                        pathReadsHookReturnAccessor(
                          memberPath,
                          hookReturnBindingInfo,
                          callbackPath.scope,
                          t,
                        )
                      ) {
                        callbackHasReactiveDependency = true
                        memberPath.stop()
                      }
                    },
                    OptionalMemberExpression(memberPath) {
                      if (
                        pathReadsHookReturnAccessor(
                          memberPath,
                          hookReturnBindingInfo,
                          callbackPath.scope,
                          t,
                        )
                      ) {
                        callbackHasReactiveDependency = true
                        memberPath.stop()
                      }
                    },
                    Identifier(idPath) {
                      if (
                        idPath.parentPath.isMemberExpression({ property: idPath.node }) &&
                        !(idPath.parent as BabelCore.types.MemberExpression).computed
                      ) {
                        return
                      }
                      if (
                        idPath.parentPath.isObjectProperty({ key: idPath.node }) &&
                        !(idPath.parent as BabelCore.types.ObjectProperty).computed
                      ) {
                        return
                      }
                      const binding = idPath.scope.getBinding(idPath.node.name)
                      if (binding && binding.scope === callbackPath.scope) return

                      if (
                        pathReadsHookReturnAccessor(
                          idPath,
                          hookReturnBindingInfo,
                          callbackPath.scope,
                          t,
                        )
                      ) {
                        callbackHasReactiveDependency = true
                        idPath.stop()
                        return
                      }

                      if (binding && hasReactiveAliasSourceBinding(idPath, idPath.node.name)) {
                        callbackHasReactiveDependency = true
                        idPath.stop()
                      }
                    },
                  })
                  hasReactiveDependency ||= callbackHasReactiveDependency
                  if (!firstSideEffectPath && memoHasSideEffects(callbackPath)) {
                    firstSideEffectPath = callbackPath
                  }
                }
                if (!hasReactiveDependency && !firstSideEffectPath) {
                  emitWarning(
                    callPath,
                    'FICT-M001',
                    'Memo has no reactive dependencies and could be a constant.',
                    warn,
                    fileName,
                  )
                }
                if (!firstSideEffectPath) return
                const loc = firstSideEffectPath.node.loc?.start ?? callPath.node.loc?.start
                warn({
                  code: 'FICT-M003',
                  message: 'Memo should not contain side effects.',
                  fileName,
                  line: loc?.line ?? 0,
                  column: loc ? loc.column + 1 : 0,
                })
              }
            }
          },
          OptionalCallExpression(callPath) {
            rejectUnsupportedNamespaceMacroCall(callPath)
            validateMemberHookPlacement(callPath)
            validateDirectHookPlacement(callPath)
            emitDirectStateArgumentWarnings(callPath, isImportedStateArgumentAllowedCall(callPath))
          },
        })

        // Validate alias reassignments now that state variables are known
        const getBindingIdentifier = (
          path: BabelCore.NodePath,
          name: string,
        ): BabelCore.types.Identifier | null => {
          const binding = path.scope.getBinding(name)
          return binding ? (binding.identifier as BabelCore.types.Identifier) : null
        }
        const addAliasBinding = (path: BabelCore.NodePath, name: string): void => {
          const bindingId = getBindingIdentifier(path, name)
          if (!bindingId) return
          aliasBindingIds.add(bindingId)
        }
        const addStateAliasBinding = (path: BabelCore.NodePath, name: string): void => {
          const bindingId = getBindingIdentifier(path, name)
          if (!bindingId) return
          stateAliasBindingIds.add(bindingId)
        }
        const isAliasBinding = (path: BabelCore.NodePath, name: string): boolean => {
          const bindingId = getBindingIdentifier(path, name)
          return !!(bindingId && aliasBindingIds.has(bindingId))
        }
        const isDestructuredAliasBinding = (path: BabelCore.NodePath, name: string): boolean => {
          const bindingId = getBindingIdentifier(path, name)
          return !!(bindingId && destructuredAliases.has(bindingId))
        }
        const isDirectReactiveAliasSource = (
          exprPath: BabelCore.NodePath | null | undefined,
        ): boolean => {
          if (!exprPath) return false
          const id = unwrapIdentifier(exprPath.node)
          if (!id) return false
          return hasReactiveAliasSourceBinding(exprPath, id.name)
        }
        debugLog('alias', 'state vars', Array.from(stateVars))
        path.traverse({
          VariableDeclarator(varPath) {
            const initPath = varPath.get('init') as BabelCore.NodePath | null
            const stateRootId = isStateRootIdentifier(initPath)
            if (t.isIdentifier(varPath.node.id) && isDirectReactiveAliasSource(initPath)) {
              debugLog('alias', 'add from decl', varPath.node.id.name)
              addAliasBinding(varPath, varPath.node.id.name)
            }
            if (t.isIdentifier(varPath.node.id) && stateRootId) {
              addStateAliasBinding(varPath, varPath.node.id.name)
            }
            if (t.isObjectPattern(varPath.node.id) || t.isArrayPattern(varPath.node.id)) {
              if (stateRootId) {
                const targets = collectPatternIdentifiers(varPath.node.id)
                for (const target of targets) {
                  debugLog('alias', 'add from destructuring decl', target)
                  addAliasBinding(varPath, target)
                }
                collectPatternIdentifiers(varPath.node.id).forEach(id =>
                  trackBindingByName(varPath, id, destructuredAliases),
                )
              }
            }
          },
          OptionalCallExpression(callPath) {
            rejectUnsupportedOptionalMacroCall(callPath)
            emitReactiveCreationPlacementWarning(callPath)
          },
          AssignmentExpression(assignPath) {
            const rightPath = assignPath.get('right') as BabelCore.NodePath | null
            const directAliasSource = isDirectReactiveAliasSource(rightPath)
            const stateRootId = isStateRootIdentifier(rightPath)
            const left = assignPath.node.left
            if (t.isIdentifier(left)) {
              const targetName = left.name
              if (directAliasSource) {
                debugLog('alias', 'add from assign', targetName)
                addAliasBinding(assignPath, targetName)
                if (stateRootId) {
                  addStateAliasBinding(assignPath, targetName)
                }
                return
              }
              if (isAliasBinding(assignPath, targetName)) {
                if (isDestructuredAliasBinding(assignPath, targetName)) return
                debugLog('alias', 'reassignment detected', targetName)
                throw assignPath.buildCodeFrameError(
                  `Alias reassignment is not supported for "${targetName}"`,
                )
              }
              return
            }
            if (t.isObjectPattern(left) || t.isArrayPattern(left)) {
              const targets = collectPatternIdentifiers(left)
              if (targets.length === 0) return
              if (stateRootId) {
                for (const target of targets) {
                  debugLog('alias', 'add from destructuring assign', target)
                  addAliasBinding(assignPath, target)
                }
                targets.forEach(target =>
                  trackBindingByName(assignPath, target, destructuredAliases),
                )
                return
              }
              const reassigned = targets.find(
                target =>
                  isAliasBinding(assignPath, target) &&
                  !isDestructuredAliasBinding(assignPath, target),
              )
              if (reassigned) {
                debugLog('alias', 'reassignment detected', reassigned)
                throw assignPath.buildCodeFrameError(
                  `Alias reassignment is not supported for "${reassigned}"`,
                )
              }
            }
          },
          UpdateExpression(updatePath) {
            const arg = updatePath.node.argument
            if (
              t.isIdentifier(arg) &&
              isAliasBinding(updatePath, arg.name) &&
              !isDestructuredAliasBinding(updatePath, arg.name)
            ) {
              debugLog('alias', 'reassignment detected', arg.name)
              throw updatePath.buildCodeFrameError(
                `Alias reassignment is not supported for "${arg.name}"`,
              )
            }
          },
        })

        // Validate derived variable reassignments
        if (derivedBindingIds.size > 0) {
          path.traverse({
            AssignmentExpression(assignPath) {
              const { left } = assignPath.node
              if (
                t.isIdentifier(left) &&
                hasTrackedBinding(assignPath, left.name, derivedBindingIds)
              ) {
                throw assignPath.buildCodeFrameError(
                  `Cannot reassign derived value '${left.name}'. Derived values are read-only.`,
                )
              }
              if (t.isObjectPattern(left) || t.isArrayPattern(left)) {
                const targets = collectPatternIdentifiers(left)
                const derivedTarget = targets.find(target =>
                  hasTrackedBinding(assignPath, target, derivedBindingIds),
                )
                if (derivedTarget) {
                  throw assignPath.buildCodeFrameError(
                    `Cannot reassign derived value '${derivedTarget}'. Derived values are read-only.`,
                  )
                }
              }
            },
          })
        }

        // Disallow writes to destructured state aliases
        if (destructuredAliases.size > 0) {
          path.traverse({
            AssignmentExpression(assignPath) {
              const { left } = assignPath.node
              if (
                t.isIdentifier(left) &&
                hasTrackedBinding(assignPath, left.name, destructuredAliases)
              ) {
                throw assignPath.buildCodeFrameError(
                  `Cannot write to destructured state alias '${left.name}'. Update the original state (e.g. state.count++ or immutable update).`,
                )
              }
              if (t.isObjectPattern(left) || t.isArrayPattern(left)) {
                const targets = collectPatternIdentifiers(left)
                const aliasTarget = targets.find(target =>
                  hasTrackedBinding(assignPath, target, destructuredAliases),
                )
                if (aliasTarget) {
                  throw assignPath.buildCodeFrameError(
                    `Cannot write to destructured state alias '${aliasTarget}'. Update the original state (e.g. state.count++ or immutable update).`,
                  )
                }
              }
            },
            UpdateExpression(updatePath) {
              const arg = updatePath.node.argument
              if (
                t.isIdentifier(arg) &&
                hasTrackedBinding(updatePath, arg.name, destructuredAliases)
              ) {
                throw updatePath.buildCodeFrameError(
                  `Cannot write to destructured state alias '${arg.name}'. Update the original state (e.g. state.count++ or immutable update).`,
                )
              }
            },
          })
        }

        // Emit conservative warnings for mutation/dynamic access
        const shouldRunWarnings = dev || hasErrorEscalation(options)
        if (shouldRunWarnings) {
          const stateRootBindingIds = new Set<BabelCore.types.Identifier>([
            ...stateBindingIds,
            ...stateAliasBindingIds,
          ])
          const reactiveBindingIds = new Set<BabelCore.types.Identifier>([
            ...stateBindingIds,
            ...derivedBindingIds,
            ...aliasBindingIds,
            ...destructuredAliases,
            ...propsBindingIds,
            ...importedReactiveBindingIds,
          ])
          runWarningPass(
            path,
            stateBindingIds,
            stateRootBindingIds,
            reactiveBindingIds,
            hookReturnBindingInfo,
            stateMacroNames,
            memoMacroNames,
            effectMacroNames,
            true,
            options,
            warn,
            fileName,
            t,
          )
        }

        // NOTE: Reactive scope callbacks (like renderHook(() => {...})) are NOT hoisted.
        // They stay inline to preserve closure semantics. The HIR builder already processes
        // nested arrow/function expressions via convertFunction, which handles $state/$effect.
        // The isInsideNestedFunctionWithReactiveScopes validation allows $state/$effect
        // inside reactive scope callbacks.

        const fileAst = t.file(path.node)
        const hir = buildHIR(
          fileAst,
          {
            state: stateMacroNames,
            effect: effectMacroNames,
            strictMacroBindings: true,
          },
          {
            dev,
            fileName,
            onWarn: warn,
            reactiveScopes: reactiveScopesSet,
          },
        )
        const optimized = optionsWithWarnings.optimize
          ? optimizeHIR(hir, {
              memoMacroNames,
              storeMacroNames,
              strictMacroBindings: true,
              inlineDerivedMemos: optionsWithWarnings.inlineDerivedMemos ?? true,
              optimizeLevel: optionsWithWarnings.optimizeLevel ?? 'safe',
            })
          : hir
        const lowered = lowerHIRWithRegions(optimized, t, optionsWithWarnings, {
          state: stateMacroNames,
          effect: effectMacroNames,
          memo: memoMacroNames,
          store: storeMacroNames,
          strictMacroBindings: true,
        })

        path.node.body = lowered.program.body
        path.node.directives = lowered.program.directives

        stripMacroImports(path, t)
        if (options.explain) {
          const artifact = createCompilerExplainArtifact({
            sourceProgram,
            outputProgram: path.node,
            fileName,
            diagnostics: explainDiagnostics,
            macroNames: {
              state: stateMacroNames,
              effect: effectMacroNames,
              memo: memoMacroNames,
              memoNamespaces: new Set(
                Array.from(reactiveCreationNamespaceBindingIds, binding => binding.name),
              ),
            },
          })
          emitCompilerExplainArtifact(hub.file, options, artifact)
        }
        if (!process.env.FICT_SKIP_SCOPE_CRAWL) {
          path.scope.crawl()
        }
      },
    },
  }
}

export const createFictPlugin = declare(
  (api, options: FictCompilerOptions = {}): BabelCore.PluginObj => {
    api.assertVersion(7)
    const t = api.types as typeof BabelCore.types
    const strictGuaranteeFromEnv = readBooleanEnv('FICT_STRICT_GUARANTEE') === true
    const isProduction = process.env.NODE_ENV === 'production'
    const normalizedOptions: FictCompilerOptions = {
      ...options,
      fineGrainedDom: options.fineGrainedDom ?? true,
      lazyConditional: options.lazyConditional ?? true,
      getterCache: options.getterCache ?? true,
      optimize: options.optimize ?? true,
      optimizeLevel: options.optimizeLevel ?? 'safe',
      inlineDerivedMemos: options.inlineDerivedMemos ?? true,
      emitModuleMetadata: options.emitModuleMetadata ?? 'auto',
      strictGuarantee: strictGuaranteeFromEnv || isProduction || options.strictGuarantee !== false,
      dev:
        options.dev ?? (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'),
    }

    return {
      name: 'fict-compiler-hir',
      visitor: createHIREntrypointVisitor(t, normalizedOptions),
    }
  },
)

export const COMPILER_CACHE_FINGERPRINT = createCompilerCacheFingerprint([
  String(createFictPlugin),
  String(createHIREntrypointVisitor),
  String(buildHIR),
  String(optimizeHIR),
  String(lowerHIRWithRegions),
  String(resolveModuleMetadata),
  String(MODULE_REACTIVE_METADATA_VERSION),
  JSON.stringify(Array.from(SAFE_FUNCTIONS).sort()),
])

export {
  clearModuleMetadata,
  resolveModuleMetadata,
  resolvePackageModuleMetadata,
  setModuleMetadata,
} from './module-metadata'
export type {
  CompilerExplainArtifact,
  CompilerExplainEvent,
  CompilerExplainEventKind,
  HookReturnInfoSerializable,
  ModuleReactiveMetadata,
  ModuleReactiveMetadataVersion,
  ReactiveExportKind,
} from './types'
export { MODULE_REACTIVE_METADATA_VERSION } from './types'
export { analyzeFictFile, inferTraceMarkersForComponent, minimizeSourceByLines } from './tooling'
export type {
  AnalyzeDiagnostic,
  AnalyzeOptions,
  AnalyzeResult,
  ComponentAnalysis,
  LineTrace,
  RegionInfoSerializable,
  TraceMarker,
  TraceMarkerKind,
  SourceMinimizerOptions,
  SourceMinimizerPredicate,
  SourceMinimizerResult,
} from './tooling'

export default createFictPlugin
