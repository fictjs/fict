/**
 * Validation Module - Unified Compiler Diagnostics
 *
 * This module provides a centralized error/warning code system for the Fict compiler.
 * It can be reused by ESLint rules and the CLI health check tool.
 */

import type * as BabelCore from '@babel/core'

import type { FictCompilerOptions, TransformContext } from './types'
import { isComponentElement } from './utils'

// ============================================================================
// Diagnostic Codes
// ============================================================================

/**
 * Diagnostic severity levels
 */
export enum DiagnosticSeverity {
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
  Hint = 'hint',
}

/**
 * Unified error code table for all compiler diagnostics
 */
export enum DiagnosticCode {
  // Props-related (FICT-P*)
  FICT_P001 = 'FICT-P001', // Props destructuring fallback
  FICT_P002 = 'FICT-P002', // Array rest in props destructuring
  FICT_P003 = 'FICT-P003', // Computed property in props pattern
  FICT_P004 = 'FICT-P004', // Nested props destructuring fallback
  FICT_P005 = 'FICT-P005', // Dynamic props spread

  // State-related (FICT-S*)
  FICT_S001 = 'FICT-S001', // State variable mutation outside component
  FICT_S002 = 'FICT-S002', // State variable escaped to external scope

  // Effect-related (FICT-E*)
  FICT_E001 = 'FICT-E001', // Effect without dependencies

  // Memo-related (FICT-M*)
  FICT_M001 = 'FICT-M001', // Memo without reactive dependencies
  FICT_M003 = 'FICT-M003', // Memo with side effects

  // Control flow (FICT-C*)
  FICT_C001 = 'FICT-C001', // Conditional hook call
  FICT_C002 = 'FICT-C002', // Loop hook call
  FICT_C003 = 'FICT-C003', // Nested component definition
  FICT_C004 = 'FICT-C004', // Component missing return

  // JSX-related (FICT-J*)
  FICT_J001 = 'FICT-J001', // Dynamic key expression
  FICT_J002 = 'FICT-J002', // Missing key in list
  FICT_J003 = 'FICT-J003', // Spread on native element

  // Region/Scope (FICT-R*)
  FICT_R002 = 'FICT-R002', // Scope escape detected
  FICT_R003 = 'FICT-R003', // Non-memoizable expression
  FICT_R004 = 'FICT-R004', // Reactive creation inside non-JSX control flow
  FICT_R005 = 'FICT-R005', // Function captures reactive variable without explicit dependency boundary
  FICT_R006 = 'FICT-R006',
  FICT_R007 = 'FICT-R007', // Reactive write in JSX child expression

  FICT_M = 'FICT-M',
  FICT_H = 'FICT-H',
  FICT_HIR_UNSUPPORTED = 'FICT-HIR-UNSUPPORTED',

  // Performance (FICT-X*)
  FICT_X003 = 'FICT-X003', // Inline function in JSX props
}

export function matchesDiagnosticCode(code: string, pattern: string): boolean {
  if (code === pattern) return true
  if (!code.startsWith(pattern)) return false
  const suffix = code.slice(pattern.length)
  return /^[0-9]/.test(suffix)
}

export function matchesAnyDiagnosticCode(code: string, patterns: Iterable<string>): boolean {
  for (const pattern of patterns) {
    if (matchesDiagnosticCode(code, pattern)) return true
  }
  return false
}

/**
 * Diagnostic message templates
 */
export const DiagnosticMessages: Record<DiagnosticCode, string> = {
  [DiagnosticCode.FICT_P001]: 'Props destructuring falls back to non-reactive binding.',
  [DiagnosticCode.FICT_P002]:
    'Array rest in props destructuring falls back to non-reactive binding.',
  [DiagnosticCode.FICT_P003]: 'Computed property in props pattern cannot be made reactive.',
  [DiagnosticCode.FICT_P004]:
    'Nested props destructuring falls back to non-reactive binding; access props directly or use prop.',
  [DiagnosticCode.FICT_P005]:
    'Dynamic props spread may not stay reactive; consider explicit props or mergeProps(() => source).',

  [DiagnosticCode.FICT_S001]: 'State variable mutation detected outside component scope.',
  [DiagnosticCode.FICT_S002]: 'State variable escaped to external scope, may cause memory leaks.',

  [DiagnosticCode.FICT_E001]:
    'Effect without reactive dependencies will run only once; consider adding state reads or removing the effect.',

  [DiagnosticCode.FICT_M001]: 'Memo has no reactive dependencies and could be a constant.',
  [DiagnosticCode.FICT_M003]: 'Memo should not contain side effects.',

  [DiagnosticCode.FICT_C001]: 'Hooks should not be called conditionally.',
  [DiagnosticCode.FICT_C002]: 'Hooks should not be called inside loops.',
  [DiagnosticCode.FICT_C003]: 'Components should not be defined inside other components.',
  [DiagnosticCode.FICT_C004]: 'Component has no return statement and will render nothing.',

  [DiagnosticCode.FICT_J001]: 'Dynamic key expression may impact performance.',
  [DiagnosticCode.FICT_J002]: 'Missing key prop in list rendering.',
  [DiagnosticCode.FICT_J003]: 'Spread on native element may include unknown props.',

  [DiagnosticCode.FICT_R002]: 'Scope escape detected, value may not be tracked.',
  [DiagnosticCode.FICT_R003]: 'Expression cannot be memoized automatically.',
  [DiagnosticCode.FICT_R004]:
    'Reactive creation inside non-JSX control flow may not auto-dispose in complex paths. Prefer createScope/runInScope (or JSX-managed regions) for explicit lifecycle control.',
  [DiagnosticCode.FICT_R005]:
    'Function captures reactive variables from outer scope; pass them as parameters or memoize explicitly to avoid hidden dependencies.',
  [DiagnosticCode.FICT_R006]:
    'Reactive control-flow reads force region re-execution; prefer expression-only branching in JSX for finer-grained updates.',
  [DiagnosticCode.FICT_R007]:
    'Reactive state writes in JSX children cannot be installed as DOM bindings; move the write into an event, effect, or statement before rendering.',
  [DiagnosticCode.FICT_M]:
    'Direct mutation of nested $state properties is not tracked; use immutable updates or $store helpers.',
  [DiagnosticCode.FICT_H]: 'Dynamic property access widens dependency tracking.',
  [DiagnosticCode.FICT_HIR_UNSUPPORTED]:
    'The HIR conversion encountered syntax that it cannot faithfully represent.',

  [DiagnosticCode.FICT_X003]: 'Inline function in JSX props may cause unnecessary re-renders.',
}

const BaseDiagnosticSeverities: Record<DiagnosticCode, DiagnosticSeverity> = {
  [DiagnosticCode.FICT_P001]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_P002]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_P003]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_P004]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_P005]: DiagnosticSeverity.Warning,

  [DiagnosticCode.FICT_S001]: DiagnosticSeverity.Error,
  [DiagnosticCode.FICT_S002]: DiagnosticSeverity.Warning,

  [DiagnosticCode.FICT_E001]: DiagnosticSeverity.Warning,

  [DiagnosticCode.FICT_M001]: DiagnosticSeverity.Info,
  [DiagnosticCode.FICT_M003]: DiagnosticSeverity.Error,

  [DiagnosticCode.FICT_C001]: DiagnosticSeverity.Error,
  [DiagnosticCode.FICT_C002]: DiagnosticSeverity.Error,
  [DiagnosticCode.FICT_C003]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_C004]: DiagnosticSeverity.Warning,

  [DiagnosticCode.FICT_J001]: DiagnosticSeverity.Info,
  [DiagnosticCode.FICT_J002]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_J003]: DiagnosticSeverity.Info,

  [DiagnosticCode.FICT_R002]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_R003]: DiagnosticSeverity.Info,
  [DiagnosticCode.FICT_R004]: DiagnosticSeverity.Error,
  [DiagnosticCode.FICT_R005]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_R006]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_R007]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_M]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_H]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_HIR_UNSUPPORTED]: DiagnosticSeverity.Error,

  [DiagnosticCode.FICT_X003]: DiagnosticSeverity.Hint,
}

const STRICT_REACTIVITY_DIAGNOSTICS = new Set<DiagnosticCode>([
  DiagnosticCode.FICT_R003,
  DiagnosticCode.FICT_R006,
])

const STRICT_GUARANTEE_DIAGNOSTICS = new Set<DiagnosticCode>([
  DiagnosticCode.FICT_P001,
  DiagnosticCode.FICT_P002,
  DiagnosticCode.FICT_P003,
  DiagnosticCode.FICT_P004,
  DiagnosticCode.FICT_P005,
  DiagnosticCode.FICT_J003,
  DiagnosticCode.FICT_M,
  DiagnosticCode.FICT_S002,
  DiagnosticCode.FICT_H,
  DiagnosticCode.FICT_R002,
  DiagnosticCode.FICT_R003,
  DiagnosticCode.FICT_R005,
  DiagnosticCode.FICT_R006,
  DiagnosticCode.FICT_R007,
])

export const DiagnosticSeverities: Record<DiagnosticCode, DiagnosticSeverity> = Object.fromEntries(
  (Object.values(DiagnosticCode) as DiagnosticCode[]).map(code => [
    code,
    STRICT_GUARANTEE_DIAGNOSTICS.has(code)
      ? DiagnosticSeverity.Error
      : BaseDiagnosticSeverities[code],
  ]),
) as Record<DiagnosticCode, DiagnosticSeverity>

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

export function resolveDiagnosticSeverity(
  code: DiagnosticCode,
  options: Partial<FictCompilerOptions> = {},
): DiagnosticSeverity {
  const strictGuaranteeEnabled =
    readBooleanEnv('FICT_STRICT_GUARANTEE') === true ||
    process.env.NODE_ENV === 'production' ||
    options.strictGuarantee !== false

  if (strictGuaranteeEnabled && matchesAnyDiagnosticCode(code, STRICT_GUARANTEE_DIAGNOSTICS)) {
    return DiagnosticSeverity.Error
  }

  const override =
    options.warningLevels?.[code] ??
    Object.entries(options.warningLevels ?? {}).find(([pattern]) =>
      matchesDiagnosticCode(code, pattern),
    )?.[1]
  if (override === 'error') return DiagnosticSeverity.Error
  if (override === 'warn') return DiagnosticSeverity.Warning
  if (override === 'off') return DiagnosticSeverity.Hint

  if (options.strictReactivity && matchesAnyDiagnosticCode(code, STRICT_REACTIVITY_DIAGNOSTICS)) {
    return DiagnosticSeverity.Error
  }

  if (options.warningsAsErrors === true) return DiagnosticSeverity.Error
  if (
    Array.isArray(options.warningsAsErrors) &&
    matchesAnyDiagnosticCode(code, options.warningsAsErrors)
  ) {
    return DiagnosticSeverity.Error
  }

  return BaseDiagnosticSeverities[code]
}

// ============================================================================
// Diagnostic Reporting
// ============================================================================

/**
 * Extended diagnostic with all metadata
 */
export interface Diagnostic {
  code: DiagnosticCode
  severity: DiagnosticSeverity
  message: string
  fileName: string
  line: number
  column: number
  endLine?: number | undefined
  endColumn?: number | undefined
  /** Additional context for the diagnostic */
  context?: Record<string, unknown> | undefined
}

interface DiagnosticNode {
  loc?: BabelCore.types.SourceLocation | null | undefined
}

/**
 * Create a diagnostic from a node
 */
export function createDiagnostic(
  code: DiagnosticCode,
  node: DiagnosticNode,
  fileName: string,
  context?: Record<string, unknown>,
  options: Partial<FictCompilerOptions> = {},
): Diagnostic {
  const loc = node.loc
  return {
    code,
    severity: resolveDiagnosticSeverity(code, options),
    message: DiagnosticMessages[code],
    fileName,
    line: loc?.start.line ?? 0,
    column: loc ? loc.start.column + 1 : 0,
    endLine: loc?.end.line,
    endColumn: loc?.end ? loc.end.column + 1 : undefined,
    context,
  }
}

/** Context type for diagnostics - compatible with both TransformContext and CodegenContext */
export interface DiagnosticContext {
  file?: { opts?: { filename?: string | null | undefined } | undefined } | undefined
  options?:
    | Pick<
        FictCompilerOptions,
        | 'dev'
        | 'filename'
        | 'onWarn'
        | 'strictGuarantee'
        | 'strictReactivity'
        | 'warningLevels'
        | 'warningsAsErrors'
      >
    | undefined
}

/**
 * Report a diagnostic through the context
 */
export function reportDiagnostic(
  ctx: DiagnosticContext,
  code: DiagnosticCode,
  node: DiagnosticNode,
  context?: Record<string, unknown>,
): void {
  const fileName = ctx.file?.opts?.filename ?? ctx.options?.filename ?? '<unknown>'
  const diagnostic = createDiagnostic(code, node, fileName, context, ctx.options)

  // Use existing warning mechanism
  if (ctx.options?.onWarn) {
    ctx.options.onWarn({
      code: diagnostic.code,
      message: diagnostic.message,
      fileName: diagnostic.fileName,
      line: diagnostic.line,
      column: diagnostic.column,
    })
  }
}

// ============================================================================
// Validation Rules
// ============================================================================

const HOOK_CALLEE_NAMES = new Set([
  '$state',
  '$effect',
  '$memo',
  'createSignal',
  'createMemo',
  'createEffect',
  'createStore',
  'createSelector',
  '__fictUseSignal',
  '__fictUseMemo',
  '__fictUseEffect',
])

type CallLikeExpression = BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression

function getCallExpressionCalleeName(
  node: CallLikeExpression,
  t: typeof BabelCore.types,
): string | null {
  const { callee } = node
  if (t.isIdentifier(callee)) {
    return callee.name
  }
  if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    !callee.computed &&
    t.isIdentifier(callee.property)
  ) {
    return callee.property.name
  }
  return null
}

function isHookLikeCalleeName(name: string): boolean {
  if (HOOK_CALLEE_NAMES.has(name)) return true
  return /^use[A-Z0-9_]/.test(name)
}

function isLoopNode(node: BabelCore.types.Node, t: typeof BabelCore.types): boolean {
  return (
    t.isForStatement(node) ||
    t.isForInStatement(node) ||
    t.isForOfStatement(node) ||
    t.isWhileStatement(node) ||
    t.isDoWhileStatement(node)
  )
}

function isConditionalNode(node: BabelCore.types.Node, t: typeof BabelCore.types): boolean {
  return (
    t.isIfStatement(node) ||
    t.isSwitchStatement(node) ||
    t.isSwitchCase(node) ||
    t.isConditionalExpression(node)
  )
}

function isConditionalAncestorChain(
  node: BabelCore.types.Node,
  ancestors: readonly BabelCore.types.Node[],
  t: typeof BabelCore.types,
): boolean {
  if (ancestors.length === 0) return false
  const chain = [...ancestors, node]
  for (let i = 0; i < chain.length - 1; i++) {
    const parent = chain[i]!
    const child = chain[i + 1]!
    if (isConditionalNode(parent, t)) return true
    if (t.isLogicalExpression(parent) && parent.right === child) {
      return true
    }
  }
  return false
}

function getAncestorsInsideCurrentFunction(
  ancestors: readonly BabelCore.types.Node[],
  t: typeof BabelCore.types,
): readonly BabelCore.types.Node[] {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (t.isFunction(ancestors[i])) {
      return ancestors.slice(i + 1)
    }
  }
  return ancestors
}

function isMapCallbackContext(
  ancestors: readonly BabelCore.types.Node[],
  t: typeof BabelCore.types,
): number {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const candidate = ancestors[i]
    if (!t.isArrowFunctionExpression(candidate) && !t.isFunctionExpression(candidate)) {
      continue
    }
    if (i === 0) continue
    const parent = ancestors[i - 1]
    if (!parent || (!t.isCallExpression(parent) && !t.isOptionalCallExpression(parent))) continue
    if (!parent.arguments.includes(candidate)) continue
    const callee = parent.callee
    if (
      (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
      !callee.computed &&
      t.isIdentifier(callee.property)
    ) {
      if (callee.property.name === 'map') {
        return i
      }
    }
  }
  return -1
}

function getMapCallbackIndexParamName(
  ancestors: readonly BabelCore.types.Node[],
  t: typeof BabelCore.types,
): string | null {
  const callbackIndex = isMapCallbackContext(ancestors, t)
  if (callbackIndex < 0) return null
  const callback = ancestors[callbackIndex]
  if (!t.isArrowFunctionExpression(callback) && !t.isFunctionExpression(callback)) {
    return null
  }
  const indexParam = callback.params[1]
  return t.isIdentifier(indexParam) ? indexParam.name : null
}

function isNode(value: unknown): value is BabelCore.types.Node {
  return !!value && typeof value === 'object' && 'type' in value
}

function getNodeChildren(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): BabelCore.types.Node[] {
  const keys = (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS
  const visitorKeys = keys?.[node.type] ?? []
  const children: BabelCore.types.Node[] = []
  for (const key of visitorKeys) {
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) children.push(item)
      }
    } else if (isNode(value)) {
      children.push(value)
    }
  }
  return children
}

function walkNode(
  node: BabelCore.types.Node | null | undefined,
  t: typeof BabelCore.types,
  ancestors: readonly BabelCore.types.Node[],
  visit: (node: BabelCore.types.Node, ancestors: readonly BabelCore.types.Node[]) => boolean | void,
): void {
  if (!node) return
  const shouldContinue = visit(node, ancestors)
  if (shouldContinue === false) return
  const nextAncestors = [...ancestors, node]
  const children = getNodeChildren(node, t)
  for (const child of children) {
    walkNode(child, t, nextAncestors, visit)
  }
}

/**
 * Validate that hooks are not called conditionally
 */
export function validateNoConditionalHooks(
  node: CallLikeExpression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
  ancestors: readonly BabelCore.types.Node[] = [],
): Diagnostic | null {
  const calleeName = getCallExpressionCalleeName(node, t)
  if (!calleeName || !isHookLikeCalleeName(calleeName)) return null

  const fileName = ctx.file.opts.filename || '<unknown>'
  const localAncestors = getAncestorsInsideCurrentFunction(ancestors, t)
  if (localAncestors.some(ancestor => isLoopNode(ancestor, t))) {
    return createDiagnostic(
      DiagnosticCode.FICT_C002,
      node,
      fileName,
      { callee: calleeName },
      ctx.options,
    )
  }
  if (isConditionalAncestorChain(node, localAncestors, t)) {
    return createDiagnostic(
      DiagnosticCode.FICT_C001,
      node,
      fileName,
      { callee: calleeName },
      ctx.options,
    )
  }
  return null
}

/**
 * Validate that lists have keys
 */
export function validateListKeys(
  node: BabelCore.types.JSXElement | BabelCore.types.JSXFragment,
  ctx: TransformContext,
  t: typeof BabelCore.types,
  ancestors: readonly BabelCore.types.Node[] = [],
): Diagnostic | null {
  const callbackIndex = isMapCallbackContext(ancestors, t)
  if (callbackIndex < 0) return null

  // Only validate the top-level JSX returned by the map callback.
  for (let i = callbackIndex + 1; i < ancestors.length; i++) {
    const ancestor = ancestors[i]
    if (t.isJSXElement(ancestor) || t.isJSXFragment(ancestor)) {
      return null
    }
  }

  const fileName = ctx.file.opts.filename || '<unknown>'
  if (t.isJSXFragment(node)) {
    return createDiagnostic(DiagnosticCode.FICT_J002, node, fileName, undefined, ctx.options)
  }

  const indexParamName = getMapCallbackIndexParamName(ancestors, t)
  let keyAttr: BabelCore.types.JSXAttribute | null = null
  for (const attr of node.openingElement.attributes) {
    if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name: 'key' })) {
      keyAttr = attr
      break
    }
  }
  if (!keyAttr) {
    return createDiagnostic(DiagnosticCode.FICT_J002, node, fileName, undefined, ctx.options)
  }
  if (
    indexParamName &&
    t.isJSXExpressionContainer(keyAttr.value) &&
    t.isIdentifier(keyAttr.value.expression, { name: indexParamName })
  ) {
    return createDiagnostic(DiagnosticCode.FICT_J001, keyAttr, fileName, undefined, ctx.options)
  }
  return null
}

/**
 * Validate that inline functions are not passed to JSX props
 */
export function validateNoInlineFunctions(
  attr: BabelCore.types.JSXAttribute,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): Diagnostic | null {
  if (t.isJSXIdentifier(attr.name) && /^on[A-Z]/.test(attr.name.name)) {
    return null
  }
  if (!t.isJSXExpressionContainer(attr.value)) return null
  const expr = attr.value.expression
  if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) {
    return createDiagnostic(
      DiagnosticCode.FICT_X003,
      attr,
      ctx.file.opts.filename || '<unknown>',
      undefined,
      ctx.options,
    )
  }
  return null
}

function validateNativeElementSpread(
  node: BabelCore.types.JSXElement,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): Diagnostic | null {
  if (isComponentElement(node, t)) return null
  for (const attr of node.openingElement.attributes) {
    if (!t.isJSXSpreadAttribute(attr)) continue
    return createDiagnostic(
      DiagnosticCode.FICT_J003,
      attr,
      ctx.file.opts.filename || '<unknown>',
      undefined,
      ctx.options,
    )
  }
  return null
}

function pushDiagnostic(diagnostics: Diagnostic[], diagnostic: Diagnostic | null): void {
  if (!diagnostic) return
  const duplicate = diagnostics.some(
    existing =>
      existing.code === diagnostic.code &&
      existing.line === diagnostic.line &&
      existing.column === diagnostic.column,
  )
  if (!duplicate) {
    diagnostics.push(diagnostic)
  }
}

function validateNode(
  node: BabelCore.types.Node,
  ancestors: readonly BabelCore.types.Node[],
  diagnostics: Diagnostic[],
  ctx: TransformContext,
  t: typeof BabelCore.types,
): boolean | void {
  if (t.isFunction(node)) {
    // Nested function bodies are validated separately.
    return false
  }

  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    pushDiagnostic(diagnostics, validateNoConditionalHooks(node, ctx, t, ancestors))
  }
  if (t.isJSXElement(node) || t.isJSXFragment(node)) {
    pushDiagnostic(diagnostics, validateListKeys(node, ctx, t, ancestors))
    if (t.isJSXElement(node)) {
      pushDiagnostic(diagnostics, validateNativeElementSpread(node, ctx, t))
    }
  }
  if (t.isJSXAttribute(node)) {
    pushDiagnostic(diagnostics, validateNoInlineFunctions(node, ctx, t))
  }
  return undefined
}

// ============================================================================
// Batch Validation
// ============================================================================

/**
 * Run all validations on a function body and collect diagnostics
 */
export function validateFunction(
  node: BabelCore.types.Function,
  ctx: TransformContext,
  t: typeof BabelCore.types,
  parentAncestors: readonly BabelCore.types.Node[] = [],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const root = node.body
  const functionAncestors = [...parentAncestors, node]
  walkNode(root, t, functionAncestors, (current, ancestors) =>
    validateNode(current, ancestors, diagnostics, ctx, t),
  )
  if (t.isBlockStatement(root)) {
    // Validate nested functions independently.
    walkNode(root, t, functionAncestors, (current, ancestors) => {
      if (!t.isFunction(current)) return
      diagnostics.push(...validateFunction(current, ctx, t, ancestors))
      return false
    })
  }
  return diagnostics
}

/**
 * Get all diagnostic codes for documentation/tooling
 */
export function getAllDiagnosticCodes(): DiagnosticCode[] {
  return Object.values(DiagnosticCode) as DiagnosticCode[]
}

/**
 * Get diagnostic info for a code (for CLI/tooling)
 */
export function getDiagnosticInfo(
  code: DiagnosticCode,
  options: Partial<FictCompilerOptions> = {},
): {
  code: DiagnosticCode
  severity: DiagnosticSeverity
  message: string
} {
  return {
    code,
    severity: resolveDiagnosticSeverity(code, options),
    message: DiagnosticMessages[code],
  }
}
