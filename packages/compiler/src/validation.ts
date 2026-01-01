/**
 * Validation Module - Unified Compiler Diagnostics
 *
 * This module provides a centralized error/warning code system for the Fict compiler.
 * It can be reused by ESLint rules and the CLI health check tool.
 */

import type * as BabelCore from '@babel/core'

import type { TransformContext } from './types'

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

  // State-related (FICT-S*)
  FICT_S001 = 'FICT-S001', // State variable mutation outside component
  FICT_S002 = 'FICT-S002', // State variable escaped to external scope

  // Effect-related (FICT-E*)
  FICT_E001 = 'FICT-E001', // Effect without dependencies
  FICT_E002 = 'FICT-E002', // Effect with captured reactive value
  FICT_E003 = 'FICT-E003', // Effect cleanup not tracked

  // Memo-related (FICT-M*)
  FICT_M001 = 'FICT-M001', // Memo without reactive dependencies
  FICT_M002 = 'FICT-M002', // Unnecessary memo (constant value)
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
  FICT_R001 = 'FICT-R001', // Region boundary crossing
  FICT_R002 = 'FICT-R002', // Scope escape detected
  FICT_R003 = 'FICT-R003', // Non-memoizable expression
  FICT_R004 = 'FICT-R004', // Reactive creation inside non-JSX control flow

  // Performance (FICT-X*)
  FICT_X001 = 'FICT-X001', // Object recreation on each render
  FICT_X002 = 'FICT-X002', // Array recreation on each render
  FICT_X003 = 'FICT-X003', // Inline function in JSX props
}

/**
 * Diagnostic message templates
 */
export const DiagnosticMessages: Record<DiagnosticCode, string> = {
  [DiagnosticCode.FICT_P001]: 'Props destructuring falls back to non-reactive binding.',
  [DiagnosticCode.FICT_P002]:
    'Array rest in props destructuring falls back to non-reactive binding.',
  [DiagnosticCode.FICT_P003]: 'Computed property in props pattern cannot be made reactive.',

  [DiagnosticCode.FICT_S001]: 'State variable mutation detected outside component scope.',
  [DiagnosticCode.FICT_S002]: 'State variable escaped to external scope, may cause memory leaks.',

  [DiagnosticCode.FICT_E001]:
    'Effect without reactive dependencies will run only once; consider adding state reads or removing the effect.',
  [DiagnosticCode.FICT_E002]: 'Effect captures reactive value that may change.',
  [DiagnosticCode.FICT_E003]: 'Effect cleanup function is not properly tracked.',

  [DiagnosticCode.FICT_M001]: 'Memo has no reactive dependencies and could be a constant.',
  [DiagnosticCode.FICT_M002]: 'Unnecessary memo wrapping a constant value.',
  [DiagnosticCode.FICT_M003]: 'Memo should not contain side effects.',

  [DiagnosticCode.FICT_C001]: 'Hooks should not be called conditionally.',
  [DiagnosticCode.FICT_C002]: 'Hooks should not be called inside loops.',
  [DiagnosticCode.FICT_C003]: 'Components should not be defined inside other components.',
  [DiagnosticCode.FICT_C004]: 'Component has no return statement and will render nothing.',

  [DiagnosticCode.FICT_J001]: 'Dynamic key expression may impact performance.',
  [DiagnosticCode.FICT_J002]: 'Missing key prop in list rendering.',
  [DiagnosticCode.FICT_J003]: 'Spread on native element may include unknown props.',

  [DiagnosticCode.FICT_R001]: 'Expression crosses reactive region boundary.',
  [DiagnosticCode.FICT_R002]: 'Scope escape detected, value may not be tracked.',
  [DiagnosticCode.FICT_R003]: 'Expression cannot be memoized automatically.',
  [DiagnosticCode.FICT_R004]:
    'Reactive creation inside non-JSX control flow will not auto-dispose; wrap it in createScope/runInScope or move it into JSX-managed regions.',

  [DiagnosticCode.FICT_X001]: 'Object is recreated on each render, consider memoizing.',
  [DiagnosticCode.FICT_X002]: 'Array is recreated on each render, consider memoizing.',
  [DiagnosticCode.FICT_X003]: 'Inline function in JSX props may cause unnecessary re-renders.',
}

/**
 * Default severity for each diagnostic code
 */
export const DiagnosticSeverities: Record<DiagnosticCode, DiagnosticSeverity> = {
  [DiagnosticCode.FICT_P001]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_P002]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_P003]: DiagnosticSeverity.Warning,

  [DiagnosticCode.FICT_S001]: DiagnosticSeverity.Error,
  [DiagnosticCode.FICT_S002]: DiagnosticSeverity.Warning,

  [DiagnosticCode.FICT_E001]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_E002]: DiagnosticSeverity.Info,
  [DiagnosticCode.FICT_E003]: DiagnosticSeverity.Warning,

  [DiagnosticCode.FICT_M001]: DiagnosticSeverity.Info,
  [DiagnosticCode.FICT_M002]: DiagnosticSeverity.Hint,
  [DiagnosticCode.FICT_M003]: DiagnosticSeverity.Error,

  [DiagnosticCode.FICT_C001]: DiagnosticSeverity.Error,
  [DiagnosticCode.FICT_C002]: DiagnosticSeverity.Error,
  [DiagnosticCode.FICT_C003]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_C004]: DiagnosticSeverity.Warning,

  [DiagnosticCode.FICT_J001]: DiagnosticSeverity.Info,
  [DiagnosticCode.FICT_J002]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_J003]: DiagnosticSeverity.Info,

  [DiagnosticCode.FICT_R001]: DiagnosticSeverity.Info,
  [DiagnosticCode.FICT_R002]: DiagnosticSeverity.Warning,
  [DiagnosticCode.FICT_R003]: DiagnosticSeverity.Info,
  [DiagnosticCode.FICT_R004]: DiagnosticSeverity.Warning,

  [DiagnosticCode.FICT_X001]: DiagnosticSeverity.Hint,
  [DiagnosticCode.FICT_X002]: DiagnosticSeverity.Hint,
  [DiagnosticCode.FICT_X003]: DiagnosticSeverity.Hint,
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
  endLine?: number
  endColumn?: number
  /** Additional context for the diagnostic */
  context?: Record<string, unknown>
}

/**
 * Create a diagnostic from a node
 */
export function createDiagnostic(
  code: DiagnosticCode,
  node: BabelCore.types.Node,
  fileName: string,
  context?: Record<string, unknown>,
): Diagnostic {
  const loc = node.loc
  return {
    code,
    severity: DiagnosticSeverities[code],
    message: DiagnosticMessages[code],
    fileName,
    line: loc?.start.line ?? 0,
    column: loc?.start.column ?? 0,
    endLine: loc?.end.line,
    endColumn: loc?.end.column,
    context,
  }
}

/**
 * Report a diagnostic through the context
 */
export function reportDiagnostic(
  ctx: TransformContext,
  code: DiagnosticCode,
  node: BabelCore.types.Node,
  context?: Record<string, unknown>,
): void {
  const diagnostic = createDiagnostic(code, node, ctx.file.opts.filename || '<unknown>', context)

  // Use existing warning mechanism
  if (ctx.options.onWarn) {
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

/**
 * Validate that hooks are not called conditionally
 */
export function validateNoConditionalHooks(
  node: BabelCore.types.CallExpression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): Diagnostic | null {
  // Check if this is a hook call
  const callee = node.callee
  if (!t.isIdentifier(callee)) return null

  const hookNames = ['useSignal', 'useMemo', 'useEffect', 'useState', 'useMemo', 'useCallback']
  if (!hookNames.some(h => callee.name.includes(h))) return null

  // This would require path context to check if inside conditional
  // For now, return null - full implementation needs path traversal
  return null
}

/**
 * Validate that lists have keys
 */
export function validateListKeys(
  _node: BabelCore.types.JSXElement,
  _ctx: TransformContext,
  _t: typeof BabelCore.types,
): Diagnostic | null {
  // Check if this is inside a .map() call
  // This would require parent context
  // For now, return null - full implementation needs path traversal
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
  if (!t.isJSXExpressionContainer(attr.value)) return null
  const expr = attr.value.expression
  if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) {
    return createDiagnostic(DiagnosticCode.FICT_X003, attr, ctx.file.opts.filename || '<unknown>')
  }
  return null
}

// ============================================================================
// Batch Validation
// ============================================================================

/**
 * Run all validations on a function body and collect diagnostics
 */
export function validateFunction(
  _node: BabelCore.types.Function,
  _ctx: TransformContext,
  _t: typeof BabelCore.types,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  // Validation logic would go here
  // Full implementation would traverse the AST
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
export function getDiagnosticInfo(code: DiagnosticCode): {
  code: DiagnosticCode
  severity: DiagnosticSeverity
  message: string
} {
  return {
    code,
    severity: DiagnosticSeverities[code],
    message: DiagnosticMessages[code],
  }
}
