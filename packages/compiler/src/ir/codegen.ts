import type * as BabelCore from '@babel/core'

import { DelegatedEvents } from '../constants'
import { debugLog } from '../debug'
import { applyRegionMetadata, shouldMemoizeRegion, type RegionMetadata } from '../fine-grained-dom'
import { setModuleMetadata } from '../module-metadata'
import type {
  FictCompilerOptions,
  HookReturnInfoSerializable,
  ModuleReactiveMetadata,
  ReactiveExportKind,
} from '../types'
import { isLogicalAssignmentOperator } from '../utils'
import { DiagnosticCode, reportDiagnostic } from '../validation'

import {
  convertExpression as convertBabelExpressionToHIR,
  convertStatementsToHIRFunction,
} from './build-hir'
import {
  collectMemberMutatedIdentifiers,
  collectMutatedIdentifiers,
  collectCalledIdentifiers,
  collectFunctionDependencyMutations,
  collectIdentifierAliasesFromRoots,
  functionContainsJSX,
  functionHasAsyncAwait,
  functionHasYield,
  structuredNodeHasComplexControlFlow,
} from './codegen-analysis'
import {
  clearCachedGetters,
  getCachedGetterExpression,
  getOrCreateHoistedTemplate,
  invalidateCachedGetter,
  withGetterCache,
} from './codegen-cache'
import { emitConditionalChild } from './codegen-conditional-child'
import { detectDerivedCycles } from './codegen-cycles'
import {
  extractDelegatedEventData,
  extractDelegatedEventDataFromHIR,
} from './codegen-delegated-data'
import { emitReactiveControlFlowReexecutionWarning } from './codegen-diagnostics'
import { isDOMProperty, isStaticDelegatedDataAst } from './codegen-dom-utils'
import { collectExpressionDependencies } from './codegen-expression-deps'
import {
  emitHIRChildBinding,
  resolveHIRBindingPath,
  type HIRChildBindingOps,
} from './codegen-hir-bindings'
import {
  analyzeHookReturnInfo as analyzeHookReturnInfoWithOps,
  deserializeHookReturnInfo,
  getHookReturnInfo as getHookReturnInfoWithOps,
  serializeHookReturnInfo,
  type HookAccessorKind,
  type HookReturnInfo,
  type HookReturnInfoAnalysisOps,
} from './codegen-hook-returns'
import { attachHelperImports, collectDeclaredNames } from './codegen-imports'
import { buildListCallExpression, emitListChild, type ListChildOps } from './codegen-list-child'
import {
  getListKeyAliasReplacementName,
  isListKeyConstExpression,
  isStaticDelegatedDataExpression,
  matchesListKeyPattern,
  shouldSuppressListKeyBindingExpression,
} from './codegen-list-keys'
import {
  applyImportedReactiveMetadata,
  buildModuleReactiveMetadata,
} from './codegen-module-metadata'
import { createGeneratedIdentifier } from './codegen-name-allocation'
import {
  markSkipRegionOverride,
  normalizeDependencyKey,
  replaceIdentifiersWithOverrides,
  type RegionOverrideMap,
} from './codegen-overrides'
import { computeReactiveAccessors } from './codegen-reactive-accessors'
import { markCompilerReactiveGetter } from './codegen-reactive-getter'
import {
  getReactiveCallKind,
  getReactiveCallKindFromBabel,
  getStaticPropName,
} from './codegen-reactive-kind'
import {
  getReactiveDependencies,
  isExpressionReactive,
  isLikelyTextExpression,
} from './codegen-reactivity'
import { findContainingRegion, regionInfoToMetadata } from './codegen-region-utils'
import { registerResumableComponent } from './codegen-resumable-component'
import {
  emitResumableEventBinding,
  type ResumableEventBindingOps,
} from './codegen-resumable-events'
import { runtimeIdentifier } from './codegen-runtime-helpers'
import { collectRuntimeImports } from './codegen-runtime-imports'
import {
  extractHIRStaticHtml,
  parseForcedBindingName,
  resolveNamespaceContext,
  type NamespaceContext,
} from './codegen-template-extraction'
import {
  HIRError,
  type AssignmentExpression as HIRAssignmentExpression,
  type BabelClassMember,
  type BabelDirective,
  type BabelParamNode,
  type BasicBlock,
  type Expression,
  type HIRFunction,
  type HIRProgram,
  type Instruction,
  type JSXChild,
  type JSXElementExpression,
  type OptionalMemberExpression as HIROptionalMemberExpression,
  type TemplateQuasi,
  type Terminator,
  type UpdateExpression as HIRUpdateExpression,
} from './hir'
import { isComponentName, isHookLikeFunction, isHookName } from './hook-utils'
import { buildPropsExpression } from './props-plan'
import {
  deSSAVarName,
  expressionNeedsAsyncContext,
  expressionUsesTracked,
  lowerStructuredNodeWithoutRegions,
  type Region,
} from './regions'
import { generateRegions, generateRegionCode, regionToMetadata } from './regions'
import type { ReactiveScopeResult } from './scopes'
import { analyzeReactiveScopesWithSSA } from './scopes'
import { structurizeCFG, structurizeCFGWithDiagnostics } from './structurize'
import { walkExpression } from './walk-expression'

export { getReactiveCallKind } from './codegen-reactive-kind'

const HOOK_SLOT_BASE = 1000
const DELEGATED_DATA_ONLY_MARKER = '__fictDataOnly'
const DELEGATED_DATA_PLAIN_MARKER = '__fictDataOnlyPlain'
const COMPONENT_CONTEXT_PRIMITIVE_CALLEES = new Set([
  '$effect',
  '$memo',
  '$state',
  '$store',
  'createEffect',
  'createMemo',
  'createRenderEffect',
  'createSignal',
  'createStore',
])

function jsxMemberNamePath(node: BabelCore.types.JSXMemberExpression): string[] | null {
  const objectPath =
    node.object.type === 'JSXIdentifier' ? [node.object.name] : jsxMemberNamePath(node.object)
  if (!objectPath) return null
  return [...objectPath, node.property.name]
}

function collectJSXMemberComponentPaths(
  statements: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Set<string> {
  const paths = new Set<string>()
  const visitorKeys =
    (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS ?? {}

  const visit = (node: BabelCore.types.Node | null | undefined): void => {
    if (!node) return
    if (t.isJSXElement(node) && t.isJSXMemberExpression(node.openingElement.name)) {
      const path = jsxMemberNamePath(node.openingElement.name)
      if (path) paths.add(path.join('.'))
    }

    const keys = visitorKeys[node.type] ?? []
    for (const key of keys) {
      const value = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        value.forEach(child => {
          if (child && typeof child === 'object' && 'type' in child) {
            visit(child as BabelCore.types.Node)
          }
        })
      } else if (value && typeof value === 'object' && 'type' in value) {
        visit(value as BabelCore.types.Node)
      }
    }
  }

  statements.forEach(visit)
  return paths
}

function collectJSXComponentNames(
  statements: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Set<string> {
  const names = new Set<string>()
  const visitorKeys =
    (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS ?? {}

  const visit = (node: BabelCore.types.Node | null | undefined): void => {
    if (!node) return
    if (t.isJSXElement(node) && t.isJSXIdentifier(node.openingElement.name)) {
      const name = node.openingElement.name.name
      if (isComponentName(name)) names.add(name)
    }

    const keys = visitorKeys[node.type] ?? []
    for (const key of keys) {
      const value = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        value.forEach(child => {
          if (child && typeof child === 'object' && 'type' in child) {
            visit(child as BabelCore.types.Node)
          }
        })
      } else if (value && typeof value === 'object' && 'type' in value) {
        visit(value as BabelCore.types.Node)
      }
    }
  }

  statements.forEach(visit)
  return names
}

function collectExportedComponentNames(
  statements: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Set<string> {
  const names = new Set<string>()
  const specifierName = (node: BabelCore.types.Identifier | BabelCore.types.StringLiteral) =>
    t.isIdentifier(node) ? node.name : node.value

  for (const stmt of statements) {
    if (t.isExportNamedDeclaration(stmt)) {
      const declaration = stmt.declaration
      if (declaration) {
        if (
          (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) &&
          declaration.id &&
          isComponentName(declaration.id.name)
        ) {
          names.add(declaration.id.name)
        }
        if (t.isVariableDeclaration(declaration)) {
          for (const decl of declaration.declarations) {
            if (t.isIdentifier(decl.id) && isComponentName(decl.id.name)) {
              names.add(decl.id.name)
            }
          }
        }
        continue
      }
      if (!stmt.source) {
        for (const spec of stmt.specifiers) {
          if (!t.isExportSpecifier(spec)) continue
          const exportedName = specifierName(spec.exported)
          if (t.isIdentifier(spec.local) && isComponentName(exportedName)) {
            names.add(spec.local.name)
          }
        }
      }
      continue
    }
    if (t.isExportDefaultDeclaration(stmt)) {
      const declaration = stmt.declaration
      if (t.isIdentifier(declaration) && isComponentName(declaration.name)) {
        names.add(declaration.name)
      } else if (
        (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) &&
        declaration.id &&
        isComponentName(declaration.id.name)
      ) {
        names.add(declaration.id.name)
      }
    }
  }

  return names
}

function getBabelStaticMemberPath(
  node: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): string[] | null {
  if (t.isIdentifier(node)) return [node.name]
  if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) return null
  if (!t.isIdentifier(node.object) && !t.isMemberExpression(node.object)) return null
  const objectPath = getBabelStaticMemberPath(node.object as BabelCore.types.Expression, t)
  if (!objectPath) return null
  const property = node.property
  if (node.computed) {
    if (t.isStringLiteral(property) || t.isNumericLiteral(property)) {
      return [...objectPath, String(property.value)]
    }
    return null
  }
  if (t.isIdentifier(property)) return [...objectPath, property.name]
  return null
}

function collectObjectClassComponentPaths(
  value: BabelCore.types.Expression | null | undefined,
  path: string[],
  into: Set<string>,
  t: typeof BabelCore.types,
): void {
  if (!value || !t.isObjectExpression(value)) return
  for (const prop of value.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) continue
    const key = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key) || t.isNumericLiteral(prop.key)
        ? String(prop.key.value)
        : null
    if (!key) continue
    const nextPath = [...path, key]
    if (t.isClassExpression(prop.value)) {
      into.add(objectPathKey(nextPath))
    } else if (t.isObjectExpression(prop.value)) {
      collectObjectClassComponentPaths(prop.value, nextPath, into, t)
    }
  }
}

function collectClassComponentPaths(
  statements: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Set<string> {
  const paths = new Set<string>()
  for (const stmt of statements) {
    const declaration = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt
    if (t.isVariableDeclaration(declaration)) {
      for (const decl of declaration.declarations) {
        if (t.isIdentifier(decl.id)) {
          collectObjectClassComponentPaths(decl.init, [decl.id.name], paths, t)
        }
      }
      continue
    }
    if (!t.isExpressionStatement(stmt)) continue
    const expr = stmt.expression
    if (!t.isAssignmentExpression(expr) || expr.operator !== '=') continue
    if (!t.isExpression(expr.left) || !t.isClassExpression(expr.right)) continue
    const path = getBabelStaticMemberPath(expr.left, t)
    if (path && path.length > 1) paths.add(objectPathKey(path))
  }
  return paths
}

function collectStaticRestExclusionKeys(
  statements: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()

  for (const stmt of statements) {
    if (!t.isVariableDeclaration(stmt)) continue
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id) || !t.isArrayExpression(decl.init)) continue
      const keys = new Set<string>()
      let staticKeys = true
      for (const element of decl.init.elements) {
        if (!element || !t.isExpression(element)) {
          staticKeys = false
          break
        }
        if (t.isStringLiteral(element) || t.isNumericLiteral(element)) {
          keys.add(String(element.value))
          continue
        }
        staticKeys = false
        break
      }
      if (staticKeys) {
        result.set(decl.id.name, keys)
      }
    }
  }

  return result
}

function isComponentContextPrimitiveCall(expr: Expression): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  if (expr.callee.kind !== 'Identifier') return false
  return COMPONENT_CONTEXT_PRIMITIVE_CALLEES.has(deSSAVarName(expr.callee.name))
}

function expressionUsesComponentContextPrimitive(expr: Expression): boolean {
  let found = false
  walkExpression(
    expr,
    node => {
      if (!found && isComponentContextPrimitiveCall(node)) found = true
    },
    { includeFunctionBodies: false },
  )
  return found
}

function terminatorUsesComponentContextPrimitive(term: Terminator): boolean {
  switch (term.kind) {
    case 'Return':
      return !!term.argument && expressionUsesComponentContextPrimitive(term.argument)
    case 'Throw':
      return expressionUsesComponentContextPrimitive(term.argument)
    case 'Branch':
      return expressionUsesComponentContextPrimitive(term.test)
    case 'Switch':
      return (
        expressionUsesComponentContextPrimitive(term.discriminant) ||
        term.cases.some(item => !!item.test && expressionUsesComponentContextPrimitive(item.test))
      )
    case 'ForOf':
      return (
        expressionUsesComponentContextPrimitive(term.iterable) ||
        (!!term.assignmentTarget && expressionUsesComponentContextPrimitive(term.assignmentTarget))
      )
    case 'ForIn':
      return (
        expressionUsesComponentContextPrimitive(term.object) ||
        (!!term.assignmentTarget && expressionUsesComponentContextPrimitive(term.assignmentTarget))
      )
    case 'Break':
    case 'Continue':
    case 'Jump':
    case 'Try':
    case 'Unreachable':
      return false
  }
}

function functionUsesComponentContextPrimitives(fn: HIRFunction): boolean {
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (
        (instr.kind === 'Assign' || instr.kind === 'Expression') &&
        expressionUsesComponentContextPrimitive(instr.value)
      ) {
        return true
      }
    }
    if (terminatorUsesComponentContextPrimitive(block.terminator)) return true
  }
  return false
}

function expressionContainsJSX(expr: Expression): boolean {
  let found = false
  walkExpression(
    expr,
    node => {
      if (!found && node.kind === 'JSXElement') found = true
    },
    { includeFunctionBodies: false },
  )
  return found
}

function expressionUsesRenderHookPrimitive(expr: Expression, ctx: CodegenContext): boolean {
  let found = false
  walkExpression(
    expr,
    node => {
      if (found) return
      if (node.kind === 'JSXElement') {
        found = true
        return
      }
      if (
        (node.kind === 'CallExpression' || node.kind === 'OptionalCallExpression') &&
        (isComponentContextPrimitiveCall(node) || getReactiveCallKind(node, ctx) !== null)
      ) {
        found = true
      }
    },
    { includeFunctionBodies: false },
  )
  return found
}

function instructionCreatesRenderHook(instr: Instruction, ctx: CodegenContext): boolean {
  if (instr.kind !== 'Assign' && instr.kind !== 'Expression') return false
  if (expressionUsesRenderHookPrimitive(instr.value, ctx)) return true
  if (instr.kind !== 'Assign' || !instr.declarationKind) return false
  if (expressionNeedsAsyncContext(instr.value)) return false
  return expressionUsesTracked(instr.value, ctx)
}

function terminatorCreatesRenderHook(term: Terminator, ctx: CodegenContext): boolean {
  switch (term.kind) {
    case 'Return':
      return !!term.argument && expressionContainsJSX(term.argument)
    case 'Throw':
      return expressionUsesRenderHookPrimitive(term.argument, ctx)
    case 'Branch':
      return expressionUsesRenderHookPrimitive(term.test, ctx)
    case 'Switch':
      return (
        expressionUsesRenderHookPrimitive(term.discriminant, ctx) ||
        term.cases.some(item => !!item.test && expressionUsesRenderHookPrimitive(item.test, ctx))
      )
    case 'ForOf':
      return (
        expressionUsesRenderHookPrimitive(term.iterable, ctx) ||
        (!!term.assignmentTarget && expressionUsesRenderHookPrimitive(term.assignmentTarget, ctx))
      )
    case 'ForIn':
      return (
        expressionUsesRenderHookPrimitive(term.object, ctx) ||
        (!!term.assignmentTarget && expressionUsesRenderHookPrimitive(term.assignmentTarget, ctx))
      )
    case 'Break':
    case 'Continue':
    case 'Jump':
    case 'Try':
    case 'Unreachable':
      return false
  }
}

function terminatorNeedsAsyncContext(term: Terminator): boolean {
  switch (term.kind) {
    case 'Return':
      return !!term.argument && expressionNeedsAsyncContext(term.argument)
    case 'Throw':
      return expressionNeedsAsyncContext(term.argument)
    case 'Branch':
      return expressionNeedsAsyncContext(term.test)
    case 'Switch':
      return (
        expressionNeedsAsyncContext(term.discriminant) ||
        term.cases.some(item => !!item.test && expressionNeedsAsyncContext(item.test))
      )
    case 'ForOf':
      return (
        expressionNeedsAsyncContext(term.iterable) ||
        (!!term.assignmentTarget && expressionNeedsAsyncContext(term.assignmentTarget))
      )
    case 'ForIn':
      return (
        expressionNeedsAsyncContext(term.object) ||
        (!!term.assignmentTarget && expressionNeedsAsyncContext(term.assignmentTarget))
      )
    case 'Break':
    case 'Continue':
    case 'Jump':
    case 'Try':
    case 'Unreachable':
      return false
  }
}

function asyncFunctionCreatesRenderHookAfterAwait(fn: HIRFunction, ctx: CodegenContext): boolean {
  let seenAwait = false
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (seenAwait && instructionCreatesRenderHook(instr, ctx)) return true
      if (
        (instr.kind === 'Assign' || instr.kind === 'Expression') &&
        expressionNeedsAsyncContext(instr.value)
      ) {
        if (instructionCreatesRenderHook(instr, ctx)) return true
        seenAwait = true
      }
    }
    if (seenAwait && terminatorCreatesRenderHook(block.terminator, ctx)) return true
    if (terminatorNeedsAsyncContext(block.terminator)) {
      if (terminatorCreatesRenderHook(block.terminator, ctx)) return true
      seenAwait = true
    }
  }
  return false
}

function throwAsyncRenderHookAfterAwait(
  fn: HIRFunction,
  ctx: CodegenContext,
  kind: 'component' | 'hook',
): never {
  const name = fn.name ?? '<anonymous>'
  throw new HIRError(
    `Async ${kind} "${name}" cannot create JSX or reactive render hooks after await. Move hook/JSX setup before the await or use a non-async helper.`,
    'BUILD_ERROR',
    {
      file: ctx.options?.filename,
      line: fn.loc?.start.line,
      variable: name,
    },
  )
}

function throwAsyncComponent(fn: HIRFunction, ctx: CodegenContext): never {
  const name = fn.name ?? '<anonymous>'
  throw new HIRError(
    `Async component "${name}" is not supported by the current synchronous render ABI. Use a synchronous component or move async work into a non-component helper.`,
    'BUILD_ERROR',
    {
      file: ctx.options?.filename,
      line: fn.loc?.start.line,
      variable: name,
    },
  )
}

function throwGeneratorComponentOrHook(
  fn: HIRFunction,
  ctx: CodegenContext,
  kind: 'component' | 'hook',
): never {
  const name = fn.name ?? '<anonymous>'
  throw new HIRError(
    `Generator ${kind} "${name}" is not supported by the current synchronous render ABI. Use a normal function or move generator logic into a non-component helper.`,
    'BUILD_ERROR',
    {
      file: ctx.options?.filename,
      line: fn.loc?.start.line,
      variable: name,
    },
  )
}

function eventHandlerExpressionNeedsReactiveGetter(expr: Expression, ctx: CodegenContext): boolean {
  const deps = new Set<string>()
  collectExpressionDependencies(expr, deps)

  for (const depName of deps) {
    const dep = deSSAVarName(depName)
    if (ctx.listItemAccessorParamNames?.has(dep)) return true
    if (
      ctx.signalVars?.has(dep) ||
      ctx.callableSignalVars?.has(dep) ||
      ctx.memoVars?.has(dep) ||
      ctx.aliasVars?.has(dep) ||
      ctx.storeVars?.has(dep)
    ) {
      return true
    }
    if (ctx.trackedVars.has(dep) && !(ctx.functionVars?.has(dep) ?? false)) {
      return true
    }
  }

  return false
}

function cloneDirectives(
  directives: BabelDirective[] | undefined,
  t: typeof BabelCore.types,
): BabelCore.types.Directive[] {
  return (directives ?? []).map(
    directive => t.cloneNode(directive, true) as BabelCore.types.Directive,
  )
}

function buildFunctionBlock(
  fn: HIRFunction,
  statements: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): BabelCore.types.BlockStatement {
  return t.blockStatement(statements, cloneDirectives(fn.meta?.directives, t))
}

function buildProgram(
  program: HIRProgram,
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): BabelCore.types.Program {
  return t.program(body, cloneDirectives(program.directives, t))
}

function isTypeScriptEnumRuntimeDeclaration(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): boolean {
  if (!t.isVariableDeclaration(node) || node.kind !== 'var' || node.declarations.length === 0) {
    return false
  }
  return node.declarations.every(decl => {
    if (!t.isIdentifier(decl.id) || !decl.init || !t.isCallExpression(decl.init)) {
      return false
    }
    if (!t.isFunctionExpression(decl.init.callee) || decl.init.arguments.length !== 1) {
      return false
    }
    const arg = decl.init.arguments[0]
    return (
      t.isLogicalExpression(arg) &&
      arg.operator === '||' &&
      t.isIdentifier(arg.left, { name: decl.id.name }) &&
      t.isObjectExpression(arg.right)
    )
  })
}

function isTypeScriptOnlyTopLevelStatement(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): boolean {
  if (node.type.startsWith('TS') || isTypeScriptEnumRuntimeDeclaration(node, t)) {
    return true
  }
  return (node as { declare?: boolean }).declare === true
}

function isTypeOnlyKind(kind: string | null | undefined): boolean {
  return kind === 'type'
}

function isTypeOnlyRuntimeOmittedStatement(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): boolean {
  return (
    t.isTSTypeAliasDeclaration(node) ||
    t.isTSInterfaceDeclaration(node) ||
    t.isTSDeclareFunction(node) ||
    ((node as { declare?: boolean }).declare === true &&
      (t.isFunctionDeclaration(node) ||
        t.isClassDeclaration(node) ||
        t.isVariableDeclaration(node)))
  )
}

function runtimeImportDeclaration(
  stmt: BabelCore.types.ImportDeclaration,
  t: typeof BabelCore.types,
): BabelCore.types.ImportDeclaration | null {
  if (isTypeOnlyKind(stmt.importKind)) return null
  const specifiers = stmt.specifiers.filter(spec => {
    return !(t.isImportSpecifier(spec) && isTypeOnlyKind(spec.importKind))
  })
  if (stmt.specifiers.length > 0 && specifiers.length === 0) return null
  if (specifiers.length === stmt.specifiers.length) return stmt
  const next = t.cloneNode(stmt, true)
  next.specifiers = specifiers.map(spec => t.cloneNode(spec, true))
  return next
}

function runtimeExportNamedDeclaration(
  stmt: BabelCore.types.ExportNamedDeclaration,
  t: typeof BabelCore.types,
): BabelCore.types.ExportNamedDeclaration | null {
  if (isTypeOnlyKind(stmt.exportKind)) return null
  if (stmt.declaration && isTypeOnlyRuntimeOmittedStatement(stmt.declaration, t)) return null
  if (stmt.specifiers.length === 0) return stmt

  const specifiers = stmt.specifiers.filter(spec => {
    return !isTypeOnlyKind((spec as { exportKind?: string | null }).exportKind)
  })
  if (specifiers.length === 0) return null
  if (specifiers.length === stmt.specifiers.length) return stmt
  const next = t.cloneNode(stmt, true)
  next.specifiers = specifiers.map(spec => t.cloneNode(spec, true))
  return next
}

function lowerRawJSXInBabelNode<T extends BabelCore.types.Node>(node: T, ctx: CodegenContext): T {
  const { t } = ctx
  const preserveRawHookReturns = (fnNode: BabelCore.types.Function): void => {
    const visitReturn = (
      current: BabelCore.types.Node | null | undefined,
      isRoot = false,
    ): void => {
      if (!current) return
      if (
        !isRoot &&
        (t.isFunctionDeclaration(current) ||
          t.isFunctionExpression(current) ||
          t.isArrowFunctionExpression(current) ||
          t.isObjectMethod(current) ||
          t.isClassMethod(current))
      ) {
        return
      }
      if (t.isReturnStatement(current) && current.argument && t.isExpression(current.argument)) {
        current.argument = unwrapAccessorCalls(current.argument, ctx)
        return
      }

      const keys = (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS
      const visitorKeys = keys?.[(current as { type: string }).type] ?? []
      for (const key of visitorKeys) {
        const value = (current as unknown as Record<string, unknown>)[key]
        if (Array.isArray(value)) {
          for (const child of value) {
            if (child && typeof child === 'object' && 'type' in (child as object)) {
              visitReturn(child as BabelCore.types.Node)
            }
          }
        } else if (value && typeof value === 'object' && 'type' in value) {
          visitReturn(value as BabelCore.types.Node)
        }
      }
    }

    visitReturn(fnNode, true)
  }
  const visit = (current: unknown): unknown => {
    if (!current || typeof current !== 'object') return current
    if (Array.isArray(current)) return current.map(item => visit(item))
    if (!('type' in current)) return current

    const astNode = current as BabelCore.types.Node
    if (t.isJSXElement(astNode) || t.isJSXFragment(astNode)) {
      return lowerExpression(
        convertBabelExpressionToHIR(
          astNode as BabelCore.types.Expression | BabelCore.types.JSXFragment,
        ),
        ctx,
      )
    }

    const record = astNode as unknown as Record<string, unknown>
    for (const key of Object.keys(astNode)) {
      if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
      const value = record[key]
      if (Array.isArray(value)) {
        record[key] = value.map(item => visit(item))
      } else if (value && typeof value === 'object' && 'type' in value) {
        record[key] = visit(value)
      }
    }
    if (t.isFunctionDeclaration(astNode) && isHookName(astNode.id?.name)) {
      preserveRawHookReturns(astNode)
    }
    return astNode
  }

  return visit(node) as T
}

const cloneLoc = (loc?: BabelCore.types.SourceLocation | null) =>
  loc === undefined
    ? undefined
    : loc === null
      ? null
      : {
          start: { ...loc.start },
          end: { ...loc.end },
          filename: loc.filename,
          identifierName: loc.identifierName,
        }

function setNodeLoc<T extends { loc?: BabelCore.types.SourceLocation | null }>(
  node: T,
  loc?: BabelCore.types.SourceLocation | null,
): T {
  if (loc === undefined) return node
  node.loc = cloneLoc(loc) ?? null
  return node
}

function voidZero(t: typeof BabelCore.types): BabelCore.types.UnaryExpression {
  return t.unaryExpression('void', t.numericLiteral(0), true)
}

function numericValueExpression(
  value: number,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  if (Object.is(value, -0)) {
    return t.unaryExpression('-', t.numericLiteral(0), true)
  }
  if (Number.isNaN(value)) {
    return t.binaryExpression('/', t.numericLiteral(0), t.numericLiteral(0))
  }
  if (value === Infinity) {
    return t.binaryExpression('/', t.numericLiteral(1), t.numericLiteral(0))
  }
  if (value === -Infinity) {
    return t.binaryExpression(
      '/',
      t.unaryExpression('-', t.numericLiteral(1), true),
      t.numericLiteral(0),
    )
  }
  return t.numericLiteral(value)
}

function lowerTemplateElement(
  quasi: TemplateQuasi,
  tail: boolean,
  t: typeof BabelCore.types,
): BabelCore.types.TemplateElement {
  const raw = typeof quasi === 'string' ? quasi : quasi.raw
  const cooked = typeof quasi === 'string' ? quasi : quasi.cooked
  const element =
    cooked === null ? t.templateElement({ raw }, tail) : t.templateElement({ raw, cooked }, tail)
  ;(element.value as { raw: string; cooked: string | null }).cooked = cooked
  return element
}

function getTerminatorArgumentLoc(
  terminator: Terminator,
): BabelCore.types.SourceLocation | undefined {
  switch (terminator.kind) {
    case 'Return':
      return terminator.argument?.loc ?? undefined
    case 'Throw':
      return terminator.argument.loc ?? undefined
    default:
      return undefined
  }
}

/**
 * Region metadata for fine-grained DOM integration.
 * This is the HIR codegen equivalent of RegionMetadata from fine-grained-dom.ts.
 */
export interface RegionInfo {
  id: number
  dependencies: Set<string>
  declarations: Set<string>
  hasControlFlow: boolean
  hasReactiveWrites?: boolean
}

export interface RegionLoweringOps {
  applyRegionToContext: typeof applyRegionToContext
  applyRegionMetadataToExpression: typeof applyRegionMetadataToExpression
  buildDependencyGetter: typeof buildDependencyGetter
  contextIdentifier: typeof contextIdentifier
  getReactiveCallKind: typeof getReactiveCallKind
  assertWritableImportedReactiveIdentifier: typeof assertWritableImportedReactiveIdentifier
  lowerExpression: typeof lowerExpression
  propagateHookResultAlias: typeof propagateHookResultAlias
  reserveFunctionLocalName: typeof reservePreferredFunctionLocalName
  resolveHookReturnMemberAccessorKind: typeof resolveHookReturnMemberAccessorKind
  resolveHookMemberValue: typeof resolveHookMemberValue
}

export function propagateHookResultAlias(
  targetBase: string,
  value: Expression,
  ctx: CodegenContext,
): void {
  targetBase = deSSAVarName(targetBase)
  propagateHookFunctionAlias(targetBase, value, ctx)
  propagateHookFunctionMemberAliases([targetBase], value, ctx)
  clearHookResultAlias(targetBase, ctx)
  const hookResultPassthroughCalls = new Set(['_slicedToArray', '_toArray'])
  const hookResultRestCalls = new Set(['__fictPropsRest', '__fictObjectRest'])
  const hookCall = resolveDirectHookCallInfo(value, ctx)
  if (hookCall) {
    ctx.hookResultVarMap?.set(targetBase, hookCall.hookName)
    markHookReactiveLocal(targetBase, hookCall.info?.directAccessor, ctx)
    return
  }
  const mapHookName = (hookName: string) => {
    ctx.hookResultVarMap?.set(targetBase, hookName)
    const info = getHookReturnInfo(hookName, ctx)
    markHookReactiveLocal(targetBase, info?.directAccessor, ctx)
  }
  const hookInfoMatches = (leftName: string, rightName: string): boolean => {
    if (leftName === rightName) return true
    const left = getHookReturnInfo(leftName, ctx)
    const right = getHookReturnInfo(rightName, ctx)
    return !!left && !!right && hookReturnInfoMatches(left, right)
  }
  const mergeHookNames = (left: string | null, right: string | null): string | null => {
    if (!left || !right) return null
    return hookInfoMatches(left, right) ? left : null
  }
  const resolveTransparentHookName = (expr: Expression): string | null => {
    const direct = resolveDirectHookCallInfo(expr, ctx)
    if (direct) return direct.hookName
    if (expr.kind === 'Identifier') return getHookResultNameForLocal(expr.name, ctx)
    if (
      expr.kind === 'CallExpression' &&
      expr.callee.kind === 'Identifier' &&
      hookResultPassthroughCalls.has(expr.callee.name)
    ) {
      const firstArg = expr.arguments[0]
      return firstArg?.kind === 'Identifier' ? getHookResultNameForLocal(firstArg.name, ctx) : null
    }
    if (expr.kind === 'SequenceExpression') {
      const last = expr.expressions[expr.expressions.length - 1]
      return last ? resolveTransparentHookName(last) : null
    }
    if (expr.kind === 'ConditionalExpression') {
      return mergeHookNames(
        resolveTransparentHookName(expr.consequent as Expression),
        resolveTransparentHookName(expr.alternate as Expression),
      )
    }
    if (expr.kind === 'LogicalExpression') {
      return mergeHookNames(
        resolveTransparentHookName(expr.left as Expression),
        resolveTransparentHookName(expr.right as Expression),
      )
    }
    return null
  }
  const mapSource = (source: string) => {
    const hookName = getHookResultNameForLocal(source, ctx)
    if (!hookName) return
    mapHookName(hookName)
  }
  const mapRestSource = (source: string, excludedArg: Expression | undefined) => {
    const hookName = getHookResultNameForLocal(source, ctx)
    if (!hookName) return
    const excludedKeys = getStaticRestExcludedKeys(excludedArg, ctx)
    if (!excludedKeys) return
    const info = getHookReturnInfo(hookName, ctx)
    const narrowed = narrowHookReturnInfoForObjectRest(info, excludedKeys)
    if (!narrowed) return
    const restHookName = `${hookName}.__rest_${targetBase}_${ctx.tempCounter++}`
    ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
    ctx.hookReturnInfo.set(restHookName, narrowed)
    ctx.hookResultVarMap?.set(targetBase, restHookName)
    markHookReactiveLocal(targetBase, narrowed.directAccessor, ctx)
  }

  const transparentHookName = resolveTransparentHookName(value)
  if (transparentHookName) {
    mapHookName(transparentHookName)
    return
  }

  if (
    value.kind === 'CallExpression' &&
    value.callee.kind === 'Identifier' &&
    hookResultPassthroughCalls.has(value.callee.name)
  ) {
    const firstArg = value.arguments[0]
    if (firstArg && firstArg.kind === 'Identifier') {
      mapSource(deSSAVarName(firstArg.name))
    }
  }
  if (
    value.kind === 'CallExpression' &&
    value.callee.kind === 'Identifier' &&
    hookResultRestCalls.has(value.callee.name)
  ) {
    const firstArg = value.arguments[0]
    if (firstArg && firstArg.kind === 'Identifier') {
      mapRestSource(deSSAVarName(firstArg.name), value.arguments[1] as Expression | undefined)
    }
  }

  if (value.kind === 'SequenceExpression' && value.expressions.length > 0) {
    const last = value.expressions[value.expressions.length - 1]
    if (
      last &&
      last.kind === 'CallExpression' &&
      last.callee.kind === 'Identifier' &&
      hookResultPassthroughCalls.has(last.callee.name)
    ) {
      const firstArg = last.arguments[0]
      if (firstArg && firstArg.kind === 'Identifier') {
        mapSource(deSSAVarName(firstArg.name))
      }
    }
    if (
      last &&
      last.kind === 'CallExpression' &&
      last.callee.kind === 'Identifier' &&
      hookResultRestCalls.has(last.callee.name)
    ) {
      const firstArg = last.arguments[0]
      if (firstArg && firstArg.kind === 'Identifier') {
        mapRestSource(deSSAVarName(firstArg.name), last.arguments[1] as Expression | undefined)
      }
    }
  }
}

function getStaticRestExcludedKeys(
  expr: Expression | undefined,
  ctx: CodegenContext,
): Set<string> | null {
  if (expr?.kind === 'Identifier') {
    const keys = ctx.staticRestExclusionKeys?.get(deSSAVarName(expr.name))
    return keys ? new Set(keys) : null
  }
  if (!expr || expr.kind !== 'ArrayExpression') return null
  const keys = new Set<string>()
  for (const element of expr.elements) {
    if (!element || element.kind !== 'Literal') return null
    if (typeof element.value !== 'string' && typeof element.value !== 'number') return null
    keys.add(String(element.value))
  }
  return keys
}

function canonicalArrayRestKey(key: string): number | null {
  const index = Number(key)
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) return null
  return index
}

function narrowHookReturnInfoForObjectRest(
  info: HookReturnInfo | null,
  excludedKeys: Set<string>,
): HookReturnInfo | null {
  if (!info) return null
  const objectProps = info.objectProps ? new Map(info.objectProps) : undefined
  const arrayProps = info.arrayProps ? new Map(info.arrayProps) : undefined

  for (const key of excludedKeys) {
    objectProps?.delete(key)
    const arrayKey = canonicalArrayRestKey(key)
    if (arrayKey !== null) {
      arrayProps?.delete(arrayKey)
    }
  }

  const narrowed: HookReturnInfo = {}
  if (objectProps && objectProps.size > 0) narrowed.objectProps = objectProps
  if (arrayProps && arrayProps.size > 0) narrowed.arrayProps = arrayProps

  return narrowed.objectProps || narrowed.arrayProps || narrowed.directAccessor ? narrowed : null
}

function getHookResultNameForLocal(name: string, ctx: CodegenContext): string | null {
  const baseName = deSSAVarName(name)
  if (ctx.shadowedNames?.has(baseName) ?? false) return null
  return ctx.hookResultVarMap?.get(baseName) ?? null
}

/**
 * Apply region metadata to the codegen context.
 * This is the HIR codegen equivalent of applyRegionMetadata from fine-grained-dom.ts.
 * It sets up the context to use region information for DOM binding decisions.
 *
 * @param ctx - The codegen context
 * @param region - The region info to apply
 * @returns The previous region (for restoration)
 */
export function applyRegionToContext(
  ctx: CodegenContext,
  region: RegionInfo | null,
): RegionInfo | undefined {
  const prevRegion = ctx.currentRegion
  ctx.currentRegion = region ?? undefined

  return prevRegion
}

function createRegionLoweringOps(): RegionLoweringOps {
  return {
    applyRegionToContext,
    applyRegionMetadataToExpression,
    buildDependencyGetter,
    contextIdentifier,
    getReactiveCallKind,
    assertWritableImportedReactiveIdentifier,
    lowerExpression,
    propagateHookResultAlias,
    reserveFunctionLocalName: reservePreferredFunctionLocalName,
    resolveHookReturnMemberAccessorKind,
    resolveHookMemberValue,
  }
}

function createHIRChildBindingOps(): HIRChildBindingOps {
  const listOps = createListChildOps()
  return {
    emitConditionalChild: (startMarkerId, endMarkerId, expr, statements, ctx) =>
      emitConditionalChild(startMarkerId, endMarkerId, expr, statements, ctx, {
        buildListCallExpression: (candidate, childStatements, childCtx) =>
          buildListCallExpression(candidate, childStatements, childCtx, listOps),
        genTemp,
        lowerDomExpression,
      }),
    emitListChild: (startMarkerId, endMarkerId, expr, statements, ctx) =>
      emitListChild(startMarkerId, endMarkerId, expr, statements, ctx, listOps),
    genTemp,
    lowerDomExpression,
    lowerExpression,
    lowerJSXElement: (expr, ctx) => lowerJSXElement(expr as JSXElementExpression, ctx),
  }
}

function createListChildOps(): ListChildOps {
  return {
    applyRegionMetadataToExpression,
    genTemp,
    lowerDomExpression,
    lowerExpression,
  }
}

function createResumableEventBindingOps(): ResumableEventBindingOps {
  return {
    lowerDomExpression,
  }
}

function reserveHookSlot(ctx: CodegenContext): number {
  if (ctx.dynamicHookSlotDepth && ctx.dynamicHookSlotDepth > 0) {
    return -1
  }
  const slot = ctx.nextHookSlot ?? HOOK_SLOT_BASE
  ctx.nextHookSlot = slot + 1
  return slot
}

function withNoMemoAndDynamicHooks<T>(ctx: CodegenContext, fn: () => T): T {
  const prevNoMemo = ctx.noMemo
  const prevDynamic = ctx.dynamicHookSlotDepth ?? 0
  ctx.noMemo = true
  ctx.dynamicHookSlotDepth = prevDynamic + 1
  try {
    return fn()
  } finally {
    ctx.noMemo = prevNoMemo
    ctx.dynamicHookSlotDepth = prevDynamic
  }
}

export type ModuleBindingKind =
  | 'const'
  | 'let'
  | 'var'
  | 'function'
  | 'class'
  | 'import'
  | 'unknown'

/**
 * Codegen context for tracking state during code generation
 */
export interface CodegenContext {
  t: typeof BabelCore.types
  /** Compiler options (for feature toggles like lazyConditional). */
  options?: FictCompilerOptions | undefined
  /** Module-level declared names for helper shadowing checks. */
  moduleDeclaredNames?: Set<string> | undefined
  /** Module-level binding kinds for resumable stability checks. */
  moduleBindingKinds?: Map<string, ModuleBindingKind> | undefined
  /** Module-level runtime helper imports (e.g., from 'fict'). */
  moduleRuntimeNames?: Set<string> | undefined
  /** Module-level runtime import map (local name -> imported name). */
  moduleRuntimeImportMap?: Map<string, string> | undefined
  /** Module-level runtime import source map (local name -> module source). */
  moduleRuntimeImportSources?: Map<string, string> | undefined
  /** Module-level runtime namespace/default imports (local name). */
  moduleRuntimeNamespaceImports?: Set<string> | undefined
  /** Module-level runtime namespace/default import source map (local name -> module source). */
  moduleRuntimeNamespaceImportSources?: Map<string, string> | undefined
  /** Macro aliases for $state (compiler macro). */
  stateMacroNames?: Set<string> | undefined
  /** Use compiler-confirmed macro markers instead of identifier names. */
  strictMacroBindings?: boolean | undefined
  /** Local (function-scope) declared names for helper shadowing checks. */
  localDeclaredNames?: Set<string> | undefined
  /** Names declared directly by the function currently being lowered. */
  currentFunctionDeclaredNames?: Set<string> | undefined
  /** Locals that should be treated as plain values even if reactive analysis tracks the name. */
  localValueVars?: Set<string> | undefined
  /** Props destructuring aliases emitted as mutable function-scope locals. */
  mutablePropVars?: Set<string> | undefined
  /** Tracks which runtime helpers are used */
  helpersUsed: Set<string>
  /** Runtime helper local names chosen to avoid source declarations. */
  runtimeHelperLocalNames?: Map<string, string> | undefined
  /** Local inlined helper names chosen to avoid source declarations. */
  inlineHelperLocalNames?: Map<string, string> | undefined
  /** Counter for generating unique identifiers */
  tempCounter: number
  /** Generated local temporary names already allocated in this module. */
  generatedTempNames?: Set<string> | undefined
  /** Set of tracked/reactive variable names (de-versioned) */
  trackedVars: Set<string>
  /** Identifiers shadowed in the current lowering scope (params/locals) */
  shadowedNames?: Set<string> | undefined
  /** Reactive scope analysis results */
  scopes?: ReactiveScopeResult | undefined
  /** Whether a context object (__fictCtx) is needed */
  needsCtx?: boolean | undefined
  /** Local name chosen for the current function/module runtime context object. */
  contextLocalName?: string | undefined
  /** Whether local for-of helper is needed */
  needsForOfHelper?: boolean | undefined
  /** Whether local for-in helper is needed */
  needsForInHelper?: boolean | undefined
  /** Control-flow dependencies per instruction (from CFG analysis) */
  controlDepsByInstr?: Map<Instruction, Set<string>> | undefined
  /** Current region info for fine-grained DOM optimization */
  currentRegion?: RegionInfo | undefined
  /** All regions for the current function */
  regions?: RegionInfo[] | undefined
  /** Alias variables that point to tracked signals (for reassignment guards) */
  aliasVars?: Set<string> | undefined
  /** Tracked bindings that exist outside the current lowering scope (e.g., captured signals) */
  externalTracked?: Set<string> | undefined
  /** Variables initialized with $store (need path-level reactivity, no getter transformation) */
  storeVars?: Set<string> | undefined
  /** Local aliases that forward namespace-imported store proxies. */
  namespaceStoreAliasVars?: Set<string> | undefined
  /** Namespace import metadata for reactive exports (used for obj.signal access) */
  importedNamespaces?: Map<string, ModuleReactiveMetadata> | undefined
  /** Static object-rest exclusion arrays emitted by syntax lowering. */
  staticRestExclusionKeys?: Map<string, Set<string>> | undefined
  /** Variables initialized with $state (signal accessors) */
  signalVars?: Set<string> | undefined
  /** Variables initialized directly from array literals and still trusted as arrays. */
  knownArrayVars?: Set<string> | undefined
  /** Signal bindings whose current value is known to be callable. */
  callableSignalVars?: Set<string> | undefined
  /** Signal bindings whose known initial/current value cannot be snapshotted safely. */
  nonSerializableSignalVars?: Set<string> | undefined
  /** Variables assigned to function expressions (should not be treated as reactive accessors) */
  functionVars?: Set<string> | undefined
  /** Declaration kind for function-valued local bindings. */
  functionBindingKinds?: Map<string, ModuleBindingKind> | undefined
  /** Imported reactive bindings tracked separately from component-local accessors. */
  importedReactiveVars?: Set<string> | undefined
  /** Imported reactive binding kind by local name. */
  importedReactiveKinds?: Map<string, ReactiveExportKind> | undefined
  /** Variables that are memos (derived values) - these shouldn't be cached by getter cache */
  memoVars?: Set<string> | undefined
  /** Memo call names (including aliases) that return accessors */
  memoMacroNames?: Set<string> | undefined
  /** Store call names (including aliases) that create store proxies */
  storeMacroNames?: Set<string> | undefined
  /** Variables that are assigned after declaration (need mutable binding) */
  mutatedVars?: Set<string> | undefined
  /** Variables whose member properties are assigned or updated. */
  memberMutatedVars?: Set<string> | undefined
  /** Whether we are emitting statements inside a region memo */
  inRegionMemo?: boolean | undefined
  /** Whether we are lowering a list item render callback */
  inListRender?: boolean | undefined
  /** List render callback item parameters that lower to runtime accessors. */
  listItemAccessorParamNames?: Set<string> | undefined
  /** Whether we are lowering top-level module statements */
  inModule?: boolean | undefined
  /** Next explicit slot index for nested memo hooks */
  nextHookSlot?: number | undefined
  /** Disable numbered hook slots within dynamic iteration contexts */
  dynamicHookSlotDepth?: number | undefined
  /**
   * Rule L: Getter cache for sync blocks.
   * Maps getter expression keys to their cached variable names.
   * When enabled, repeated reads of the same getter within a sync function
   * will use a cached value instead of calling the getter multiple times.
   */
  getterCache?: Map<string, string> | undefined
  /** Pending cache declarations to insert at the start of a function body */
  getterCacheDeclarations?: Map<string, BabelCore.types.Expression | null> | undefined
  /** Getter names written in this cache scope; future reads must not use hoisted cache values. */
  getterCacheInvalidated?: Set<string> | undefined
  /** Whether getter caching is enabled for the current scope */
  getterCacheEnabled?: boolean | undefined
  /** Disable memoization for the current function (\"use no memo\" directive) */
  noMemo?: boolean | undefined
  /** Current expression recursion depth for stack overflow protection */
  expressionDepth?: number | undefined
  /** Maximum allowed expression depth (default: 500) */
  maxExpressionDepth?: number | undefined
  /** Track non-reactive nested scopes (event handlers, effects) */
  nonReactiveScopeDepth?: number | undefined
  /** Current assignment target name (for devtools metadata) */
  currentAssignmentName?: string | undefined
  /** Uppercase component binding currently being initialized through a wrapper call. */
  componentWrapperName?: string | undefined
  /** Static JSX identifier component names used in this module, e.g. "App". */
  jsxComponentNames?: Set<string> | undefined
  /** Static JSX member component paths used in this module, e.g. "UI.Button". */
  jsxMemberComponentPaths?: Set<string> | undefined
  /** Static member component paths known to resolve to class constructors. */
  classComponentPaths?: Set<string> | undefined
  /** Static path of the object literal currently being lowered, e.g. ["UI", "Nav"]. */
  objectLiteralPath?: string[] | undefined
  /** Depth counter for conditional child lowering (disable memo caching) */
  inConditional?: number | undefined
  /** Whether we are lowering JSX props (enables prop getter wrapping) */
  inPropsContext?: boolean | undefined
  /** Name of the props parameter for component lowering */
  propsParamName?: string | undefined
  /** Pending prop accessor declarations synthesized for props reads */
  propAccessorDecls?: Map<string, BabelCore.types.Statement> | undefined
  /** Destructured prop accessors that resumable handlers can restore from serialized props. */
  resumablePropAccessors?:
    | Map<string, { path: string[]; defaultValue?: BabelCore.types.Expression | undefined }>
    | undefined
  /** Destructured prop rest bindings that resumable handlers can restore from serialized props. */
  resumablePropRests?: Map<string, { excludedKeys: string[] }> | undefined
  /** Whether tracked expressions should be wrapped in runtime effects */
  wrapTrackedExpressions?: boolean | undefined
  /** Whether the current function is treated as a hook (preserve accessor returns) */
  currentFnIsHook?: boolean | undefined
  /** Whether the current function is a component (PascalCase) */
  isComponentFn?: boolean | undefined
  /** Whether we are lowering a return statement (for hook return preservation) */
  inReturn?: boolean | undefined
  /** Whether hook return lowering should preserve namespace/imported accessors. */
  preserveHookReturnAccessors?: boolean | undefined
  /** Cache of hook return accessor metadata keyed by hook name */
  hookReturnInfo?: Map<string, HookReturnInfo> | undefined
  /** Hook metadata cache keys that came from imported module metadata. */
  importedHookReturnInfoNames?: Set<string> | undefined
  /** Local function aliases that point at hook functions with known return metadata. */
  hookFunctionAliases?: Map<string, string> | undefined
  /** Local object member paths that point at hook functions with known return metadata. */
  hookFunctionMemberAliases?: Map<string, string> | undefined
  /** Map of local variables bound to hook results (per function) */
  hookResultVarMap?: Map<string, string> | undefined
  /** Imported hook bindings that did not publish hook-return metadata */
  opaqueImportedHookNames?: Set<string> | undefined
  /** Program functions keyed by name for hook metadata lookup */
  programFunctions?: Map<string, HIRFunction> | undefined
  /** Cache of hoisted template identifiers keyed by HTML string */
  hoistedTemplates?: Map<string, BabelCore.types.Identifier> | undefined
  /** Hoisted template declarations to insert at function/component scope */
  hoistedTemplateStatements?: BabelCore.types.Statement[] | undefined
  /** Hoisted resumable handler/export statements */
  hoistedResumableStatements?: BabelCore.types.Statement[] | undefined
  /** Resumable handler counter */
  resumableHandlerCounter?: number | undefined
  /** Resumable component counter */
  resumableComponentCounter?: number | undefined
  /** Resumable component metadata */
  resumableComponents?: Map<string, { resumeExport: string; typeKey: string }> | undefined
  /** Whether resumable output is enabled */
  resumableEnabled?: boolean | undefined
  /** Whether auto-extraction of handlers is enabled */
  autoExtractEnabled?: boolean | undefined
  /** Minimum AST node count for auto-extraction */
  autoExtractThreshold?: number | undefined
  /** Set of delegated events used (for hoisting delegateEvents call) */
  delegatedEventsUsed?: Set<string> | undefined
  /** Component-scoped function definitions (variable name -> HIR expression) for handler dependency hoisting */
  componentFunctionDefs?: Map<string, Expression> | undefined
  /** Component-scoped function object mutations that make dependency hoisting unsafe */
  componentFunctionMutations?: Map<string, string[]> | undefined
  /** Hoisted function dependency counter for unique naming */
  hoistedFunctionDepCounter?: number | undefined
  /** Map of hoisted function dep names (original name -> hoisted module-level name) */
  hoistedFunctionDepNames?: Map<string, string> | undefined
  /** Parameter name for the list key constant (e.g., "__key") when in list render */
  listKeyParamName?: string | undefined
  /** The key expression HIR (e.g., row.id) for comparison when replacing with __key */
  listKeyExpr?: Expression | undefined
  /** Actual returned JSX key attribute signatures already evaluated by the list key function. */
  listKeyBindingSignatures?: Set<string> | undefined
  /** Local callback aliases whose initializer has already been evaluated by the list key function. */
  listKeyAliasNames?: Set<string> | undefined
  /** The item parameter name in list render (e.g., "row") for key expression matching */
  listItemParamName?: string | undefined
  /** Function-scope depth while lowering a list render callback for key constification. */
  listKeyConstificationDepth?: number | undefined
  /** Whether key constification is disabled by a nested scope shadowing the item parameter. */
  listKeyConstificationDisabled?: boolean | undefined
  /** Current namespace context for SVG/MathML element creation */
  namespaceContext?: NamespaceContext | undefined
  /** Injected lowering operations used by regions.ts to avoid runtime import cycles */
  regionLoweringOps?: RegionLoweringOps | undefined
  /** Dedupe set for control-flow re-execution diagnostics */
  controlFlowReexecWarnings?: Set<string> | undefined
}

/**
 * Creates a fresh codegen context
 */
export function createCodegenContext(t: typeof BabelCore.types): CodegenContext {
  return {
    t,
    moduleDeclaredNames: new Set(),
    moduleBindingKinds: new Map(),
    moduleRuntimeNames: new Set(),
    moduleRuntimeImportMap: new Map(),
    moduleRuntimeImportSources: new Map(),
    moduleRuntimeNamespaceImports: new Set(),
    moduleRuntimeNamespaceImportSources: new Map(),
    stateMacroNames: new Set(),
    localDeclaredNames: new Set(),
    currentFunctionDeclaredNames: new Set(),
    helpersUsed: new Set(),
    runtimeHelperLocalNames: new Map(),
    inlineHelperLocalNames: new Map(),
    tempCounter: 0,
    generatedTempNames: new Set(),
    trackedVars: new Set(),
    shadowedNames: new Set(),
    needsForOfHelper: false,
    needsForInHelper: false,
    controlDepsByInstr: new Map(),
    aliasVars: new Set(),
    externalTracked: new Set(),
    storeVars: new Set(),
    namespaceStoreAliasVars: new Set(),
    importedNamespaces: new Map(),
    staticRestExclusionKeys: new Map(),
    signalVars: new Set(),
    knownArrayVars: new Set(),
    callableSignalVars: new Set(),
    nonSerializableSignalVars: new Set(),
    functionVars: new Set(),
    functionBindingKinds: new Map(),
    jsxComponentNames: new Set(),
    jsxMemberComponentPaths: new Set(),
    classComponentPaths: new Set(),
    importedReactiveVars: new Set(),
    importedReactiveKinds: new Map(),
    memoVars: new Set(),
    memoMacroNames: new Set(['$memo', 'createMemo']),
    storeMacroNames: new Set(['$store']),
    strictMacroBindings: false,
    mutatedVars: new Set(),
    memberMutatedVars: new Set(),
    inRegionMemo: false,
    inListRender: false,
    inModule: false,
    nextHookSlot: HOOK_SLOT_BASE,
    nonReactiveScopeDepth: 0,
    inConditional: 0,
    wrapTrackedExpressions: true,
    getterCache: new Map(),
    getterCacheDeclarations: new Map(),
    getterCacheInvalidated: new Set(),
    getterCacheEnabled: false,
    inPropsContext: false,
    propsParamName: undefined,
    propAccessorDecls: new Map(),
    resumablePropAccessors: new Map(),
    resumablePropRests: new Map(),
    hookReturnInfo: new Map(),
    importedHookReturnInfoNames: new Set(),
    hookFunctionAliases: new Map(),
    hookFunctionMemberAliases: new Map(),
    opaqueImportedHookNames: new Set(),
    hoistedTemplates: new Map(),
    hoistedTemplateStatements: [],
    hoistedResumableStatements: [],
    resumableHandlerCounter: 0,
    resumableComponentCounter: 0,
    resumableComponents: new Map(),
    resumableEnabled: false,
    autoExtractEnabled: false,
    autoExtractThreshold: 3,
    delegatedEventsUsed: new Set(),
    componentFunctionDefs: new Map(),
    componentFunctionMutations: new Map(),
    hoistedFunctionDepCounter: 0,
    hoistedFunctionDepNames: new Map(),
    regionLoweringOps: createRegionLoweringOps(),
    controlFlowReexecWarnings: new Set(),
  }
}

const hookReturnInfoAnalysisOps: HookReturnInfoAnalysisOps = {
  createCodegenContext,
  detectDerivedCycles,
  flattenRegions,
}

function analyzeHookReturnInfo(fn: HIRFunction, ctx: CodegenContext): HookReturnInfo | null {
  return analyzeHookReturnInfoWithOps(fn, ctx, hookReturnInfoAnalysisOps)
}

function markImportedHookReturnInfoName(name: string, ctx: CodegenContext): void {
  const baseName = deSSAVarName(name)
  ctx.importedHookReturnInfoNames = ctx.importedHookReturnInfoNames ?? new Set()
  ctx.importedHookReturnInfoNames.add(baseName)
}

function hasShadowedImportedHookReturnInfo(name: string, ctx: CodegenContext): boolean {
  const baseName = deSSAVarName(name)
  if (!(ctx.importedHookReturnInfoNames?.has(baseName) ?? false)) return false
  return (
    (ctx.shadowedNames?.has(baseName) ?? false) ||
    (ctx.currentFunctionDeclaredNames?.has(baseName) ?? false)
  )
}

function getCachedHookReturnInfo(name: string, ctx: CodegenContext): HookReturnInfo | null {
  if (hasShadowedImportedHookReturnInfo(name, ctx)) return null
  return ctx.hookReturnInfo?.get(deSSAVarName(name)) ?? null
}

function getHookReturnInfo(name: string, ctx: CodegenContext): HookReturnInfo | null {
  if (hasShadowedImportedHookReturnInfo(name, ctx)) return null
  return getHookReturnInfoWithOps(name, ctx, hookReturnInfoAnalysisOps)
}

function getHookFunctionAliasName(name: string, ctx: CodegenContext): string | null {
  const baseName = deSSAVarName(name)
  if (ctx.shadowedNames?.has(baseName) ?? false) return null
  return ctx.hookFunctionAliases?.get(baseName) ?? null
}

function hookFunctionMemberAliasKey(path: string[]): string {
  return path.join('.')
}

function getHookFunctionMemberAliasName(
  expr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  ctx: CodegenContext,
): string | null {
  const path = getStaticMemberPath(expr)
  if (!path || path.length < 2) return null
  const root = path[0]
  if (root && (ctx.shadowedNames?.has(root) ?? false)) return null
  return ctx.hookFunctionMemberAliases?.get(hookFunctionMemberAliasKey(path)) ?? null
}

function resolveHookFunctionNameForAliasSource(name: string, ctx: CodegenContext): string | null {
  const baseName = deSSAVarName(name)
  const aliased = getHookFunctionAliasName(baseName, ctx)
  if (aliased) return aliased
  return getHookReturnInfo(baseName, ctx) ? baseName : null
}

function resolveHookFunctionAliasSource(expr: Expression, ctx: CodegenContext): string | null {
  if (expr.kind === 'Identifier') return resolveHookFunctionNameForAliasSource(expr.name, ctx)
  if (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') {
    return getHookFunctionMemberAliasName(expr, ctx)
  }
  if (expr.kind === 'SequenceExpression') {
    const last = expr.expressions[expr.expressions.length - 1]
    return last ? resolveHookFunctionAliasSource(last, ctx) : null
  }
  return null
}

function clearHookFunctionAlias(targetBase: string, ctx: CodegenContext): void {
  ctx.hookFunctionAliases?.delete(deSSAVarName(targetBase))
}

function propagateHookFunctionAlias(
  targetBase: string,
  value: Expression,
  ctx: CodegenContext,
): void {
  const target = deSSAVarName(targetBase)
  clearHookFunctionAlias(target, ctx)
  const source = resolveHookFunctionAliasSource(value, ctx)
  if (!source) return
  ctx.hookFunctionAliases = ctx.hookFunctionAliases ?? new Map()
  ctx.hookFunctionAliases.set(target, source)
}

function clearHookFunctionMemberAliasesForPath(path: string[], ctx: CodegenContext): void {
  const key = hookFunctionMemberAliasKey(path)
  const aliases = ctx.hookFunctionMemberAliases
  if (!aliases) return
  for (const existing of Array.from(aliases.keys())) {
    if (existing === key || existing.startsWith(`${key}.`)) {
      aliases.delete(existing)
    }
  }
}

function copyHookFunctionMemberAliases(
  sourcePath: string[],
  targetPath: string[],
  ctx: CodegenContext,
): void {
  const aliases = ctx.hookFunctionMemberAliases
  if (!aliases) return
  const sourceKey = hookFunctionMemberAliasKey(sourcePath)
  const targetKey = hookFunctionMemberAliasKey(targetPath)
  for (const [key, hookName] of Array.from(aliases.entries())) {
    if (key === sourceKey) {
      aliases.set(targetKey, hookName)
      continue
    }
    if (key.startsWith(`${sourceKey}.`)) {
      aliases.set(`${targetKey}${key.slice(sourceKey.length)}`, hookName)
    }
  }
}

function copyHookFunctionMemberAliasesFromExpression(
  targetPath: string[],
  value: Expression,
  ctx: CodegenContext,
): void {
  const sourcePath = getStaticMemberPath(value)
  if (!sourcePath) return
  copyHookFunctionMemberAliases(sourcePath, targetPath, ctx)
}

function setHookFunctionMemberAlias(path: string[], hookName: string, ctx: CodegenContext): void {
  ctx.hookFunctionMemberAliases = ctx.hookFunctionMemberAliases ?? new Map()
  ctx.hookFunctionMemberAliases.set(hookFunctionMemberAliasKey(path), hookName)
}

function propagateHookFunctionMemberAliases(
  targetPath: string[],
  value: Expression,
  ctx: CodegenContext,
): void {
  clearHookFunctionMemberAliasesForPath(targetPath, ctx)
  copyHookFunctionMemberAliasesFromExpression(targetPath, value, ctx)

  if (value.kind !== 'ObjectExpression') return
  for (const prop of value.properties) {
    if (prop.kind === 'SpreadElement') continue
    const segment = getStaticObjectPropertySegment(prop)
    if (!segment) continue
    const propertyPath = [...targetPath, segment]
    const sourceHookName = resolveHookFunctionAliasSource(prop.value, ctx)
    if (sourceHookName) {
      setHookFunctionMemberAlias(propertyPath, sourceHookName, ctx)
    }
    if (prop.value.kind === 'ObjectExpression') {
      propagateHookFunctionMemberAliases(propertyPath, prop.value, ctx)
    } else {
      copyHookFunctionMemberAliasesFromExpression(propertyPath, prop.value, ctx)
    }
  }
}

function propagateHookFunctionMemberAssignment(expr: Expression, ctx: CodegenContext): void {
  if (expr.kind !== 'AssignmentExpression') return
  if (expr.left.kind !== 'MemberExpression' && expr.left.kind !== 'OptionalMemberExpression') {
    return
  }
  const path = getStaticMemberPath(expr.left)
  if (!path || path.length < 2) return
  clearHookFunctionMemberAliasesForPath(path, ctx)
  if (expr.operator !== '=') return
  const sourceHookName = resolveHookFunctionAliasSource(expr.right, ctx)
  if (sourceHookName) {
    setHookFunctionMemberAlias(path, sourceHookName, ctx)
  }
}

export function resolveHookMemberValue(
  expr: Expression,
  ctx: CodegenContext,
): { member: BabelCore.types.MemberExpression; kind: HookAccessorKind } | null {
  if (expr.kind !== 'MemberExpression') return null
  const kind = resolveHookReturnMemberAccessorKind(expr, ctx)
  if (!kind) return null

  const propName = getStaticPropName(expr.property as Expression, expr.computed)
  const obj =
    expr.object.kind === 'Identifier'
      ? ctx.t.identifier(deSSAVarName(expr.object.name))
      : lowerExpression(expr.object, ctx)
  const prop = expr.computed
    ? lowerExpression(expr.property as Expression, ctx)
    : ctx.t.identifier(String(propName))
  const member = ctx.t.memberExpression(obj, prop, expr.computed, expr.optional)
  return { member, kind }
}

function resolveNamespaceHookCallInfo(
  expr: Expression,
  ctx: CodegenContext,
): { hookName: string; info: HookReturnInfo } | null {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
  const callee = expr.callee
  if (callee.kind !== 'MemberExpression' && callee.kind !== 'OptionalMemberExpression') return null
  if (callee.object.kind !== 'Identifier') return null

  const namespaceName = deSSAVarName(callee.object.name)
  const nsMeta = getImportedNamespaceMetadata(namespaceName, ctx)
  if (!nsMeta?.hooks) return null

  const propName = getStaticMemberMetadataKey(callee.property as Expression, callee.computed)
  if (propName === null) return null

  if (!Object.prototype.hasOwnProperty.call(nsMeta.hooks, propName)) return null
  const serialized = nsMeta.hooks[propName]
  if (!isSerializedHookReturnInfo(serialized)) return null

  const hookName = `${namespaceName}.${propName}`
  const info = deserializeHookReturnInfo(serialized)
  ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
  ctx.hookReturnInfo.set(hookName, info)
  return { hookName, info }
}

function resolveLocalHookMemberCallInfo(
  expr: Expression,
  ctx: CodegenContext,
): { hookName: string; info: HookReturnInfo | null } | null {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
  const callee = expr.callee
  if (callee.kind !== 'MemberExpression' && callee.kind !== 'OptionalMemberExpression') {
    return null
  }
  const hookName = getHookFunctionMemberAliasName(callee, ctx)
  if (!hookName) return null
  return { hookName, info: getHookReturnInfo(hookName, ctx) }
}

function resolveDirectHookCallInfo(
  expr: Expression,
  ctx: CodegenContext,
): { hookName: string; info: HookReturnInfo | null } | null {
  const namespaceHookCall = resolveNamespaceHookCallInfo(expr, ctx)
  if (namespaceHookCall) return namespaceHookCall
  const localHookMemberCall = resolveLocalHookMemberCallInfo(expr, ctx)
  if (localHookMemberCall) return localHookMemberCall

  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
  if (expr.callee.kind !== 'Identifier') return null

  const localName = deSSAVarName(expr.callee.name)
  const aliasedHookName = getHookFunctionAliasName(localName, ctx)
  const resolvedHookName = aliasedHookName ?? localName
  const cached = getCachedHookReturnInfo(resolvedHookName, ctx)
  if (cached) return { hookName: resolvedHookName, info: cached }
  if (aliasedHookName)
    return { hookName: resolvedHookName, info: getHookReturnInfo(resolvedHookName, ctx) }
  if (!isHookName(resolvedHookName)) return null
  if (ctx.opaqueImportedHookNames?.has(resolvedHookName)) return null

  return { hookName: resolvedHookName, info: getHookReturnInfo(resolvedHookName, ctx) }
}

function getHookReturnAccessorKind(
  info: HookReturnInfo | null,
  propName: string | number | null,
): HookAccessorKind | null {
  if (typeof propName === 'string') {
    const kind = info?.objectProps?.get(propName)
    if (kind) return kind
    const numeric = getCanonicalNumericKey(propName)
    if (numeric !== null) {
      const arrayKind = info?.arrayProps?.get(numeric)
      if (arrayKind) return arrayKind
    }
  } else if (typeof propName === 'number') {
    const kind = info?.arrayProps?.get(propName)
    if (kind) return kind
    if (Number.isFinite(propName)) {
      const objectKind = info?.objectProps?.get(String(propName))
      if (objectKind) return objectKind
    }
  }
  return null
}

function hookAccessorMapsMatch<K>(
  left: Map<K, HookAccessorKind> | undefined,
  right: Map<K, HookAccessorKind> | undefined,
): boolean {
  if (!left || left.size === 0) return !right || right.size === 0
  if (!right || left.size !== right.size) return false
  for (const [key, kind] of left) {
    if (right.get(key) !== kind) return false
  }
  return true
}

function hookReturnInfoMatches(left: HookReturnInfo, right: HookReturnInfo): boolean {
  return (
    left.directAccessor === right.directAccessor &&
    hookAccessorMapsMatch(left.objectProps, right.objectProps) &&
    hookAccessorMapsMatch(left.arrayProps, right.arrayProps)
  )
}

function getStaticMetadataPropertyKey(propName: string | number | null): string | null {
  if (typeof propName === 'string') return propName
  if (typeof propName === 'number') return String(propName)
  return null
}

function getStaticMemberMetadataKey(property: Expression, computed: boolean): string | null {
  return getStaticMetadataPropertyKey(getStaticPropName(property, computed))
}

function getCanonicalNumericKey(key: string): number | null {
  const numeric = Number(key)
  if (!Number.isFinite(numeric) || String(numeric) !== key) return null
  return numeric
}

function isHookAccessorKind(value: unknown): value is HookAccessorKind {
  return value === 'signal' || value === 'memo' || value === 'store'
}

function isCallableHookAccessorKind(
  kind: HookAccessorKind | null | undefined,
): kind is Extract<HookAccessorKind, 'signal' | 'memo'> {
  return kind === 'signal' || kind === 'memo'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isCanonicalArrayPropIndex(value: string): boolean {
  const index = Number(value)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === value
}

function isSerializedHookReturnInfo(value: unknown): value is HookReturnInfoSerializable {
  if (!isPlainRecord(value)) return false
  if (
    Object.prototype.hasOwnProperty.call(value, 'directAccessor') &&
    value.directAccessor !== undefined &&
    !isHookAccessorKind(value.directAccessor)
  ) {
    return false
  }
  if (Object.prototype.hasOwnProperty.call(value, 'objectProps')) {
    if (value.objectProps !== undefined) {
      if (!isPlainRecord(value.objectProps)) return false
      if (!Object.values(value.objectProps).every(isHookAccessorKind)) return false
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'arrayProps')) {
    if (value.arrayProps !== undefined) {
      if (!isPlainRecord(value.arrayProps)) return false
      if (!Object.keys(value.arrayProps).every(isCanonicalArrayPropIndex)) return false
      if (!Object.values(value.arrayProps).every(isHookAccessorKind)) return false
    }
  }
  return true
}

function getImportedNamespaceMetadata(
  name: string,
  ctx: CodegenContext,
): ModuleReactiveMetadata | undefined {
  const baseName = deSSAVarName(name)
  if (
    (ctx.shadowedNames?.has(baseName) ?? false) ||
    (ctx.localDeclaredNames?.has(baseName) ?? false)
  ) {
    return undefined
  }
  return ctx.importedNamespaces?.get(baseName)
}

function markHookReactiveLocal(
  name: string,
  kind: HookAccessorKind | null | undefined,
  ctx: CodegenContext,
): void {
  if (kind === 'signal') {
    ctx.signalVars?.add(name)
    ctx.trackedVars.add(name)
  } else if (kind === 'memo') {
    ctx.memoVars?.add(name)
  } else if (kind === 'store') {
    ctx.storeVars?.add(name)
    ctx.trackedVars.add(name)
  }
}

function unmarkHookReactiveLocal(
  name: string,
  kind: HookAccessorKind | null | undefined,
  ctx: CodegenContext,
): void {
  if (kind === 'signal') {
    ctx.signalVars?.delete(name)
    ctx.trackedVars.delete(name)
  } else if (kind === 'memo') {
    ctx.memoVars?.delete(name)
  } else if (kind === 'store') {
    ctx.storeVars?.delete(name)
    ctx.trackedVars.delete(name)
  }
  ctx.aliasVars?.delete(name)
}

function clearHookResultAlias(targetBase: string, ctx: CodegenContext): void {
  const baseName = deSSAVarName(targetBase)
  const hookName = ctx.hookResultVarMap?.get(baseName)
  if (!hookName) return
  ctx.hookResultVarMap?.delete(baseName)
  const info = getHookReturnInfo(hookName, ctx)
  unmarkHookReactiveLocal(baseName, info?.directAccessor, ctx)
}

type ReadOnlyImportedReactiveKind = Extract<ReactiveExportKind, 'memo' | 'store'>

function isReadOnlyImportedReactiveKind(
  kind: ReactiveExportKind | undefined,
): kind is ReadOnlyImportedReactiveKind {
  return kind === 'memo' || kind === 'store'
}

function importedReactiveWriteMessage(kind: ReadOnlyImportedReactiveKind, name: string): string {
  const detail =
    kind === 'memo'
      ? 'Imported memo bindings are read-only accessors.'
      : 'Imported store bindings are proxy objects, not writable signal accessors.'
  return `Cannot write to imported ${kind} binding "${name}". ${detail}`
}

function throwImportedReactiveWrite(
  name: string,
  kind: ReadOnlyImportedReactiveKind,
  ctx: CodegenContext,
  loc?: BabelCore.types.SourceLocation | null,
): never {
  throw new HIRError(importedReactiveWriteMessage(kind, name), 'BUILD_ERROR', {
    file: ctx.options?.filename,
    line: loc?.start.line,
    variable: name,
  })
}

function assertWritableImportedReactiveIdentifier(
  name: string,
  ctx: CodegenContext,
  loc?: BabelCore.types.SourceLocation | null,
): void {
  const baseName = deSSAVarName(name)
  const kind = ctx.importedReactiveKinds?.get(baseName)
  if (isReadOnlyImportedReactiveKind(kind)) {
    throwImportedReactiveWrite(baseName, kind, ctx, loc)
  }
}

function assertWritableImportedNamespaceMember(
  expr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  ctx: CodegenContext,
): void {
  if (expr.object.kind !== 'Identifier') return
  const namespaceName = deSSAVarName(expr.object.name)
  const nsMeta = getImportedNamespaceMetadata(namespaceName, ctx)
  if (!nsMeta) return

  const exportName = getStaticMemberMetadataKey(expr.property as Expression, expr.computed)
  if (exportName === null) return

  const kind = nsMeta.exports[exportName]
  if (isReadOnlyImportedReactiveKind(kind)) {
    throwImportedReactiveWrite(`${namespaceName}.${exportName}`, kind, ctx, expr.loc)
  }
}

function resolveHookReturnMemberInfo(
  expr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  ctx: CodegenContext,
): { info: HookReturnInfo | null } | null {
  let info: HookReturnInfo | null | undefined
  if (expr.object.kind === 'Identifier') {
    const hookName = getHookResultNameForLocal(expr.object.name, ctx)
    if (!hookName) return null
    info = getHookReturnInfo(hookName, ctx)
  } else if (
    expr.object.kind === 'CallExpression' ||
    expr.object.kind === 'OptionalCallExpression'
  ) {
    const hookCall = resolveDirectHookCallInfo(expr.object, ctx)
    if (!hookCall) return null
    info = hookCall.info
  } else {
    return null
  }

  return {
    info: info ?? null,
  }
}

function resolveHookReturnMemberAccessorKind(
  expr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  ctx: CodegenContext,
): HookAccessorKind | null {
  const hookMemberInfo = resolveHookReturnMemberInfo(expr, ctx)
  if (!hookMemberInfo) return null
  const propName = getStaticPropName(expr.property as Expression, expr.computed)
  return getHookReturnAccessorKind(hookMemberInfo.info, propName)
}

function withNonReactiveScope<T>(ctx: CodegenContext, fn: () => T): T {
  const prevDepth = ctx.nonReactiveScopeDepth ?? 0
  ctx.nonReactiveScopeDepth = prevDepth + 1
  try {
    return fn()
  } finally {
    ctx.nonReactiveScopeDepth = prevDepth
  }
}

/**
 * Generate a unique temporary identifier
 */
function genTemp(ctx: CodegenContext, prefix = 'tmp'): BabelCore.types.Identifier {
  return createGeneratedIdentifier(ctx, prefix)
}

function isContextNameReserved(
  ctx: CodegenContext,
  name: string,
  scope: 'function' | 'module',
): boolean {
  if (scope === 'module') {
    return (
      (ctx.moduleDeclaredNames?.has(name) ?? false) ||
      (ctx.moduleRuntimeNames?.has(name) ?? false) ||
      Array.from(ctx.runtimeHelperLocalNames?.values() ?? []).includes(name) ||
      Array.from(ctx.inlineHelperLocalNames?.values() ?? []).includes(name)
    )
  }

  return (ctx.localDeclaredNames?.has(name) ?? false) || (ctx.shadowedNames?.has(name) ?? false)
}

function reservePreferredFunctionLocalName(ctx: CodegenContext, preferred: string): string {
  if (!isContextNameReserved(ctx, preferred, 'function')) return preferred

  let index = 1
  while (true) {
    const candidate = `${preferred}_${index++}`
    if (!isContextNameReserved(ctx, candidate, 'function')) return candidate
  }
}

function reserveContextLocalName(ctx: CodegenContext, scope: 'function' | 'module'): string {
  const preferred = '__fictCtx'
  if (scope === 'function') return reservePreferredFunctionLocalName(ctx, preferred)
  if (!isContextNameReserved(ctx, preferred, scope)) return preferred

  let index = 1
  while (true) {
    const candidate = `${preferred}_${index++}`
    if (!isContextNameReserved(ctx, candidate, scope)) return candidate
  }
}

function contextLocalName(ctx: CodegenContext, scope: 'function' | 'module' = 'function'): string {
  if (!ctx.contextLocalName) {
    ctx.contextLocalName = reserveContextLocalName(ctx, scope)
  }
  return ctx.contextLocalName
}

export function contextIdentifier(ctx: CodegenContext): BabelCore.types.Identifier {
  return ctx.t.identifier(contextLocalName(ctx))
}

function moduleContextIdentifier(ctx: CodegenContext): BabelCore.types.Identifier {
  return ctx.t.identifier(contextLocalName(ctx, 'module'))
}

/**
 * Minimal lowering from HIR back to Babel AST.
 * - Emits a single function declaration per HIR function.
 * - Linearizes blocks in order and reconstructs statements best-effort.
 * - Unsupported instructions become empty statements.
 * - Placeholder for region→fine-grained DOM mapping (not implemented yet).
 * Primarily used for tests that snapshot intermediate lowering.
 */
export function lowerHIRToBabel(
  program: HIRProgram,
  t: typeof BabelCore.types,
): BabelCore.types.File {
  const ctx = createCodegenContext(t)
  const originalBody = (program.originalBody ?? []) as BabelCore.types.Statement[]
  ctx.programFunctions = new Map(
    program.functions.filter(fn => !!fn.name).map(fn => [fn.name as string, fn]),
  )
  ctx.jsxComponentNames = collectJSXComponentNames(originalBody, t)
  for (const name of collectExportedComponentNames(originalBody, t)) {
    ctx.jsxComponentNames.add(name)
  }
  ctx.jsxMemberComponentPaths = collectJSXMemberComponentPaths(originalBody, t)
  ctx.classComponentPaths = collectClassComponentPaths(originalBody, t)
  ctx.staticRestExclusionKeys = collectStaticRestExclusionKeys(originalBody, t)
  addDestructuredJSXComponentSourcePaths(program, ctx)
  seedSameFileHookAliasMetadata(program, originalBody, ctx, t)
  const body: BabelCore.types.Statement[] = []
  const emittedFunctionNames = new Set<string>()
  for (const fn of program.functions) {
    const funcStmt = lowerFunction(fn, ctx)
    if (funcStmt) {
      body.push(funcStmt)
      if (fn.name) emittedFunctionNames.add(fn.name)
    }
  }
  const filteredBody = body.filter(stmt => {
    if (t.isVariableDeclaration(stmt)) {
      return !stmt.declarations.some(
        decl => t.isIdentifier(decl.id) && emittedFunctionNames.has(decl.id.name),
      )
    }
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
      if (
        t.isVariableDeclaration(stmt.declaration) &&
        stmt.declaration.declarations.some(
          decl => t.isIdentifier(decl.id) && emittedFunctionNames.has(decl.id.name),
        )
      ) {
        return false
      }
    }
    return true
  })

  return t.file(buildProgram(program, attachHelperImports(ctx, filteredBody, t), t))
}

function collectParamBindingNames(
  params: { name: string }[],
  rawParams: BabelParamNode[] | undefined,
  t: typeof BabelCore.types,
): Set<string> {
  const names = new Set(params.map(p => deSSAVarName(p.name)))
  rawParams?.forEach(param => {
    const ids = t.getBindingIdentifiers(param)
    Object.keys(ids).forEach(name => names.add(deSSAVarName(name)))
  })
  return names
}

function parameterRegionOverride(ctx: CodegenContext): RegionInfo | null {
  if (ctx.inReturn && ctx.currentFnIsHook) return null
  return (
    ctx.currentRegion ??
    (ctx.trackedVars.size
      ? {
          id: -1,
          dependencies: new Set(ctx.trackedVars),
          declarations: new Set<string>(),
          hasControlFlow: false,
          hasReactiveWrites: false,
        }
      : null)
  )
}

function lowerParameterExpression(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
  paramNames: Set<string>,
): BabelCore.types.Expression {
  const prevShadowed = ctx.shadowedNames
  const shadowed = new Set(prevShadowed ?? [])
  paramNames.forEach(name => shadowed.add(name))
  ctx.shadowedNames = shadowed
  try {
    const regionOverride = parameterRegionOverride(ctx) ?? undefined
    const hirExpr = convertBabelExpressionToHIR(
      ctx.t.cloneNode(expr, true) as BabelCore.types.Expression,
    )
    const lowered = lowerExpression(hirExpr, ctx)
    if (ctx.t.isAssignmentExpression(lowered)) {
      const right = applyRegionMetadataToExpression(lowered.right, ctx, regionOverride)
      return ctx.t.assignmentExpression(lowered.operator, lowered.left, right)
    }
    if (ctx.t.isUpdateExpression(lowered)) {
      const arg = applyRegionMetadataToExpression(
        lowered.argument as BabelCore.types.Expression,
        ctx,
        regionOverride,
      )
      return ctx.t.updateExpression(
        lowered.operator,
        arg as BabelCore.types.Expression,
        lowered.prefix,
      )
    }
    return applyRegionMetadataToExpression(lowered, ctx, regionOverride)
  } finally {
    ctx.shadowedNames = prevShadowed
  }
}

function lowerParameterPattern(
  pattern: BabelCore.types.FunctionParameter | BabelCore.types.PatternLike,
  ctx: CodegenContext,
  paramNames: Set<string>,
): BabelCore.types.FunctionParameter | BabelCore.types.PatternLike {
  const { t } = ctx

  if (t.isIdentifier(pattern)) {
    return t.identifier(deSSAVarName(pattern.name))
  }
  if (t.isAssignmentPattern(pattern)) {
    pattern.left = lowerParameterPattern(
      pattern.left as BabelCore.types.PatternLike,
      ctx,
      paramNames,
    ) as typeof pattern.left
    pattern.right = lowerParameterExpression(pattern.right, ctx, paramNames)
    return pattern
  }
  if (t.isRestElement(pattern)) {
    pattern.argument = lowerParameterPattern(
      pattern.argument as BabelCore.types.PatternLike,
      ctx,
      paramNames,
    ) as typeof pattern.argument
    return pattern
  }
  if (t.isObjectPattern(pattern)) {
    pattern.properties = pattern.properties.map(prop => {
      if (t.isRestElement(prop)) {
        prop.argument = lowerParameterPattern(
          prop.argument as BabelCore.types.PatternLike,
          ctx,
          paramNames,
        ) as typeof prop.argument
        return prop
      }
      if (t.isObjectProperty(prop)) {
        if (prop.computed && t.isExpression(prop.key)) {
          prop.key = lowerParameterExpression(prop.key, ctx, paramNames)
        }
        prop.value = lowerParameterPattern(
          prop.value as BabelCore.types.PatternLike,
          ctx,
          paramNames,
        ) as typeof prop.value
      }
      return prop
    })
    return pattern
  }
  if (t.isArrayPattern(pattern)) {
    pattern.elements = pattern.elements.map(element =>
      element && t.isPatternLike(element)
        ? (lowerParameterPattern(element, ctx, paramNames) as BabelCore.types.PatternLike)
        : element,
    )
    return pattern
  }
  return pattern
}

function stripTypeScriptExpressionSyntax(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  if (t.isTSAsExpression(expr) || t.isTSTypeAssertion(expr) || t.isTSSatisfiesExpression(expr)) {
    return stripTypeScriptExpressionSyntax(expr.expression as BabelCore.types.Expression, t)
  }
  if (t.isTSNonNullExpression(expr)) {
    return stripTypeScriptExpressionSyntax(expr.expression as BabelCore.types.Expression, t)
  }
  return expr
}

function stripTypeScriptPatternSyntax(
  pattern: BabelCore.types.FunctionParameter | BabelCore.types.PatternLike,
  t: typeof BabelCore.types,
): BabelCore.types.FunctionParameter | BabelCore.types.PatternLike {
  const node = pattern

  if (t.isIdentifier(node)) {
    delete node.typeAnnotation
    delete node.optional
    return node
  }
  if (t.isAssignmentPattern(node)) {
    delete node.typeAnnotation
    node.left = stripTypeScriptPatternSyntax(
      node.left as BabelCore.types.PatternLike,
      t,
    ) as typeof node.left
    node.right = stripTypeScriptExpressionSyntax(node.right, t)
    return node
  }
  if (t.isRestElement(node)) {
    delete node.typeAnnotation
    node.argument = stripTypeScriptPatternSyntax(
      node.argument as BabelCore.types.PatternLike,
      t,
    ) as typeof node.argument
    return node
  }
  if (t.isObjectPattern(node)) {
    delete node.typeAnnotation
    delete node.optional
    node.properties = node.properties.map(prop => {
      if (t.isRestElement(prop)) {
        return stripTypeScriptPatternSyntax(prop, t) as BabelCore.types.RestElement
      }
      if (t.isObjectProperty(prop)) {
        delete (prop as { optional?: boolean }).optional
        if (prop.computed && t.isExpression(prop.key)) {
          prop.key = stripTypeScriptExpressionSyntax(prop.key, t)
        }
        prop.value = stripTypeScriptPatternSyntax(
          prop.value as BabelCore.types.PatternLike,
          t,
        ) as typeof prop.value
      }
      return prop
    })
    return node
  }
  if (t.isArrayPattern(node)) {
    delete node.typeAnnotation
    delete node.optional
    node.elements = node.elements.map(element =>
      element && t.isPatternLike(element)
        ? (stripTypeScriptPatternSyntax(element, t) as BabelCore.types.PatternLike)
        : element,
    )
    return node
  }
  return node
}

function sanitizeFunctionParameter(
  param: BabelParamNode,
  t: typeof BabelCore.types,
): BabelCore.types.FunctionParameter {
  const unwrapped = t.isTSParameterProperty(param) ? param.parameter : param
  const cloned = t.cloneNode(unwrapped, true) as BabelCore.types.FunctionParameter
  return stripTypeScriptPatternSyntax(cloned, t) as BabelCore.types.FunctionParameter
}

function buildFunctionParams(
  params: { name: string }[],
  rawParams: BabelParamNode[] | undefined,
  ctx: CodegenContext,
): BabelCore.types.FunctionParameter[] {
  if (rawParams && rawParams.length > 0) {
    const paramNames = collectParamBindingNames(params, rawParams, ctx.t)
    return rawParams.map(param =>
      lowerParameterPattern(sanitizeFunctionParameter(param, ctx.t), ctx, paramNames),
    ) as BabelCore.types.FunctionParameter[]
  }
  return params.map(p => ctx.t.identifier(deSSAVarName(p.name)))
}

function buildOutputParams(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionParameter[] {
  return buildFunctionParams(fn.params, fn.rawParams, ctx)
}

function lowerFunction(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  const prevTracked = ctx.trackedVars
  const prevCallableSignalVars = ctx.callableSignalVars
  const prevNonSerializableSignalVars = ctx.nonSerializableSignalVars
  const prevLocalDeclared = ctx.localDeclaredNames
  const prevImportedReactiveKinds = ctx.importedReactiveKinds
  const prevContextLocalName = ctx.contextLocalName
  const prevHookFunctionAliases = ctx.hookFunctionAliases
  const prevHookFunctionMemberAliases = ctx.hookFunctionMemberAliases
  const scopedTracked = new Set(ctx.trackedVars)
  const scopedImportedReactiveKinds = new Map(prevImportedReactiveKinds ?? [])
  fn.params.forEach(p => scopedTracked.delete(deSSAVarName(p.name)))
  fn.params.forEach(p => scopedImportedReactiveKinds.delete(deSSAVarName(p.name)))
  ctx.trackedVars = scopedTracked
  ctx.importedReactiveKinds = scopedImportedReactiveKinds
  ctx.callableSignalVars = new Set(prevCallableSignalVars ?? [])
  ctx.nonSerializableSignalVars = new Set(prevNonSerializableSignalVars ?? [])
  fn.params.forEach(p => ctx.callableSignalVars?.delete(deSSAVarName(p.name)))
  fn.params.forEach(p => ctx.nonSerializableSignalVars?.delete(deSSAVarName(p.name)))
  const localDeclared = new Set(prevLocalDeclared ?? [])
  for (const name of collectLocalDeclaredNames(fn.params, fn.blocks, t)) {
    localDeclared.add(name)
    ctx.importedReactiveKinds?.delete(name)
    ctx.callableSignalVars?.delete(name)
    ctx.nonSerializableSignalVars?.delete(name)
  }
  ctx.localDeclaredNames = localDeclared
  ctx.hookFunctionAliases = new Map(prevHookFunctionAliases ?? [])
  ctx.hookFunctionMemberAliases = new Map(prevHookFunctionMemberAliases ?? [])
  ctx.contextLocalName = undefined
  ctx.needsCtx = false
  const prevHookFlag = ctx.currentFnIsHook
  ctx.currentFnIsHook = isHookLikeFunction(fn)
  const params = buildOutputParams(fn, ctx)
  const statements: BabelCore.types.Statement[] = []

  // For now, just emit instructions in block order, ignoring control flow structure.
  for (const block of fn.blocks) {
    statements.push(
      ...(block.instructions
        .map(instr => lowerInstruction(instr, ctx))
        .filter(Boolean) as BabelCore.types.Statement[]),
    )
    statements.push(...lowerTerminator(block, ctx))
  }

  if (ctx.needsCtx) {
    ctx.helpersUsed.add('useContext')
    statements.unshift(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          contextIdentifier(ctx),
          t.callExpression(runtimeIdentifier(ctx, 'useContext'), []),
        ),
      ]),
    )
  }

  const result = setNodeLoc(
    t.functionDeclaration(
      t.identifier(fn.name ?? 'fn'),
      params,
      buildFunctionBlock(fn, statements, t),
    ),
    fn.loc,
  )
  result.async = !!fn.meta?.isAsync || functionHasAsyncAwait(fn)
  result.generator = !!fn.meta?.isGenerator || functionHasYield(fn)
  ctx.trackedVars = prevTracked
  ctx.callableSignalVars = prevCallableSignalVars
  ctx.nonSerializableSignalVars = prevNonSerializableSignalVars
  ctx.localDeclaredNames = prevLocalDeclared
  ctx.importedReactiveKinds = prevImportedReactiveKinds
  ctx.hookFunctionAliases = prevHookFunctionAliases
  ctx.hookFunctionMemberAliases = prevHookFunctionMemberAliases
  ctx.contextLocalName = prevContextLocalName
  ctx.currentFnIsHook = prevHookFlag
  return result
}

function lowerTrackedExpression(
  expr: Expression,
  ctx: CodegenContext,
  valueUsed = true,
): BabelCore.types.Expression {
  const regionOverride =
    ctx.inReturn && ctx.currentFnIsHook
      ? null
      : (ctx.currentRegion ??
        (ctx.trackedVars.size
          ? {
              id: -1,
              dependencies: new Set(ctx.trackedVars),
              declarations: new Set<string>(),
              hasControlFlow: false,
              hasReactiveWrites: false,
            }
          : null))
  const lowered = lowerExpression(expr, ctx, valueUsed)
  if (ctx.t.isAssignmentExpression(lowered)) {
    const right = applyRegionMetadataToExpression(lowered.right, ctx, regionOverride ?? undefined)
    return ctx.t.assignmentExpression(lowered.operator, lowered.left, right)
  }
  if (ctx.t.isUpdateExpression(lowered)) {
    const arg = applyRegionMetadataToExpression(
      lowered.argument as BabelCore.types.Expression,
      ctx,
      regionOverride ?? undefined,
    )
    return ctx.t.updateExpression(
      lowered.operator,
      arg as BabelCore.types.Expression,
      lowered.prefix,
    )
  }
  return applyRegionMetadataToExpression(lowered, ctx, regionOverride ?? undefined)
}

function isFunctionExpressionValue(expr: Expression | undefined): boolean {
  return expr?.kind === 'ArrowFunction' || expr?.kind === 'FunctionExpression'
}

function isCallableSignalInitializer(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  return getReactiveCallKind(expr, ctx) === 'signal' && isFunctionExpressionValue(expr.arguments[0])
}

function expressionContainsNonSerializableFunctionValue(
  expr: Expression | null | undefined,
): boolean {
  if (!expr) return false
  switch (expr.kind) {
    case 'ArrowFunction':
    case 'FunctionExpression':
      return true
    case 'ArrayExpression':
      return expr.elements.some(element => expressionContainsNonSerializableFunctionValue(element))
    case 'ObjectExpression':
      return expr.properties.some(prop => {
        if (prop.kind === 'SpreadElement') {
          return expressionContainsNonSerializableFunctionValue(prop.argument)
        }
        return (
          (prop.propertyKind !== undefined && prop.propertyKind !== 'init') ||
          expressionContainsNonSerializableFunctionValue(prop.value)
        )
      })
    default:
      return false
  }
}

function isNonSerializableSignalInitializer(expr: Expression, ctx: CodegenContext): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  return (
    getReactiveCallKind(expr, ctx) === 'signal' &&
    expressionContainsNonSerializableFunctionValue(expr.arguments[0])
  )
}

function markCallableSignalIfFunctionValue(
  name: string,
  value: Expression,
  ctx: CodegenContext,
): void {
  if (isFunctionExpressionValue(value) || isCallableSignalInitializer(value, ctx)) {
    ctx.callableSignalVars?.add(name)
  }
}

function markNonSerializableSignalIfFunctionValue(
  name: string,
  value: Expression,
  ctx: CodegenContext,
): void {
  if (
    expressionContainsNonSerializableFunctionValue(value) ||
    isNonSerializableSignalInitializer(value, ctx)
  ) {
    ctx.nonSerializableSignalVars?.add(name)
  }
}

function markCallableSignalAssignmentValue(expr: Expression, ctx: CodegenContext): void {
  if (expr.kind !== 'AssignmentExpression') return
  if (expr.left.kind !== 'Identifier') return
  const target = deSSAVarName(expr.left.name)
  if (!(ctx.signalVars?.has(target) ?? false)) return
  markCallableSignalIfFunctionValue(target, expr.right, ctx)
  markNonSerializableSignalIfFunctionValue(target, expr.right, ctx)
}

function markKnownArrayInitializer(
  name: string,
  value: Expression,
  ctx: CodegenContext,
  isDeclaration: boolean,
): void {
  if (isDeclaration && value.kind === 'ArrayExpression') {
    ctx.knownArrayVars?.add(name)
    return
  }
  ctx.knownArrayVars?.delete(name)
}

function lowerLoopAssignmentTarget(
  target: Expression,
  ctx: CodegenContext,
): BabelCore.types.Identifier | BabelCore.types.MemberExpression {
  if (target.kind === 'Identifier') {
    assertWritableImportedReactiveIdentifier(target.name, ctx, target.loc)
  } else if (target.kind === 'MemberExpression' || target.kind === 'OptionalMemberExpression') {
    assertWritableImportedNamespaceMember(target, ctx)
  }
  const lowered =
    target.kind === 'MemberExpression' || target.kind === 'OptionalMemberExpression'
      ? lowerMemberExpressionForAssignmentTarget(target, ctx)
      : lowerExpression(target, ctx)
  if (ctx.t.isIdentifier(lowered) || ctx.t.isMemberExpression(lowered)) {
    return lowered
  }
  return ctx.t.identifier('_item')
}

function lowerInstruction(
  instr: Instruction,
  ctx: CodegenContext,
): BabelCore.types.Statement | null {
  const { t } = ctx
  const applyLoc = <T extends BabelCore.types.Statement | null>(stmt: T): T => {
    if (!stmt) return stmt
    const baseLoc =
      instr.loc ??
      (instr.kind === 'Assign' || instr.kind === 'Expression' ? instr.value.loc : undefined)
    return setNodeLoc(stmt, baseLoc) as T
  }
  if (instr.kind === 'Assign') {
    const baseName = deSSAVarName(instr.target.name)

    const isFunctionDecl =
      instr.value.kind === 'FunctionExpression' &&
      (instr.declarationKind === 'function' ||
        (!instr.declarationKind && !instr.isMutation && instr.value.name === baseName))
    if (isFunctionDecl) {
      const loweredFn = lowerExpression(instr.value, ctx)
      if (t.isFunctionExpression(loweredFn)) {
        return applyLoc(
          t.functionDeclaration(
            t.identifier(baseName),
            loweredFn.params as BabelCore.types.Identifier[],
            loweredFn.body as BabelCore.types.BlockStatement,
            loweredFn.generator ?? false,
            loweredFn.async ?? false,
          ),
        )
      }
    }

    const declKind = instr.declarationKind === 'function' ? undefined : instr.declarationKind
    if (!declKind) {
      assertWritableImportedReactiveIdentifier(baseName, ctx, instr.loc ?? instr.value.loc)
    }
    const listKeyAliasReplacement = declKind ? getListKeyAliasReplacementName(baseName, ctx) : null
    if (declKind && listKeyAliasReplacement) {
      return applyLoc(
        t.variableDeclaration(declKind, [
          t.variableDeclarator(t.identifier(baseName), t.identifier(listKeyAliasReplacement)),
        ]),
      )
    }
    markKnownArrayInitializer(baseName, instr.value, ctx, !!declKind)
    propagateHookResultAlias(baseName, instr.value, ctx)
    const hookMember = resolveHookMemberValue(instr.value, ctx)
    if (hookMember) {
      markHookReactiveLocal(baseName, hookMember.kind, ctx)
      if (declKind) {
        return applyLoc(
          t.variableDeclaration(declKind, [
            t.variableDeclarator(t.identifier(baseName), hookMember.member),
          ]),
        )
      }
      return applyLoc(
        t.expressionStatement(
          t.assignmentExpression('=', t.identifier(baseName), hookMember.member),
        ),
      )
    }
    const directHookCall = resolveDirectHookCallInfo(instr.value, ctx)
    if (directHookCall && directHookCall.hookName.indexOf('.') === -1) {
      ctx.hookResultVarMap?.set(baseName, directHookCall.hookName)
      const retInfo = directHookCall.info
      markHookReactiveLocal(baseName, retInfo?.directAccessor, ctx)
    }
    const namespaceHookCall = resolveNamespaceHookCallInfo(instr.value, ctx)
    if (namespaceHookCall) {
      ctx.hookResultVarMap?.set(baseName, namespaceHookCall.hookName)
      markHookReactiveLocal(baseName, namespaceHookCall.info.directAccessor, ctx)
    }
    if (declKind) {
      const initKind = getReactiveCallKind(instr.value, ctx)
      if (initKind === 'signal') {
        ctx.signalVars?.add(baseName)
        ctx.trackedVars.add(baseName)
        markCallableSignalIfFunctionValue(baseName, instr.value, ctx)
        markNonSerializableSignalIfFunctionValue(baseName, instr.value, ctx)
        ctx.currentAssignmentName = baseName
        const loweredValue = (() => {
          try {
            return lowerTrackedExpression(instr.value, ctx)
          } finally {
            ctx.currentAssignmentName = undefined
          }
        })()
        return applyLoc(
          t.variableDeclaration(declKind, [
            t.variableDeclarator(t.identifier(baseName), loweredValue),
          ]),
        )
      }
    }
    if (ctx.signalVars?.has(baseName)) {
      markCallableSignalIfFunctionValue(baseName, instr.value, ctx)
      markNonSerializableSignalIfFunctionValue(baseName, instr.value, ctx)
      ctx.currentAssignmentName = baseName
      const loweredValue = (() => {
        try {
          return lowerTrackedExpression(instr.value, ctx)
        } finally {
          ctx.currentAssignmentName = undefined
        }
      })()
      invalidateCachedGetter(ctx, baseName)
      return applyLoc(
        t.expressionStatement(t.callExpression(t.identifier(baseName), [loweredValue])),
      )
    }
    ctx.currentAssignmentName = baseName
    const loweredAssign = (() => {
      try {
        return lowerTrackedExpression(instr.value, ctx)
      } finally {
        ctx.currentAssignmentName = undefined
      }
    })()
    return applyLoc(
      t.expressionStatement(t.assignmentExpression('=', t.identifier(baseName), loweredAssign)),
    )
  }
  if (instr.kind === 'Expression') {
    propagateHookFunctionMemberAssignment(instr.value, ctx)
    return applyLoc(t.expressionStatement(lowerTrackedExpression(instr.value, ctx, false)))
  }
  if (instr.kind === 'Debugger') {
    return applyLoc(t.debuggerStatement())
  }
  if (instr.kind === 'Phi') {
    // Phi nodes are typically eliminated in SSA-out pass; emit comment for debugging
    return null
  }
  return null
}

function lowerTerminator(block: BasicBlock, ctx: CodegenContext): BabelCore.types.Statement[] {
  const { t } = ctx
  const baseLoc = block.terminator.loc ?? getTerminatorArgumentLoc(block.terminator)
  const applyLoc = (stmts: BabelCore.types.Statement[]): BabelCore.types.Statement[] =>
    stmts.map(stmt => setNodeLoc(stmt, baseLoc))
  const appendPostTerminatorStatements = (
    stmts: BabelCore.types.Statement[],
  ): BabelCore.types.Statement[] => [
    ...applyLoc(stmts),
    ...(block.postTerminatorStatements ?? []).map(
      stmt => t.cloneNode(stmt, true) as BabelCore.types.Statement,
    ),
  ]
  switch (block.terminator.kind) {
    case 'Return': {
      const preserveAccessors = ctx.currentFnIsHook
      const prevHookFlag = ctx.currentFnIsHook
      const prevPreserveHookReturnAccessors = ctx.preserveHookReturnAccessors
      if (preserveAccessors) ctx.currentFnIsHook = false
      ctx.preserveHookReturnAccessors = preserveAccessors
      ctx.inReturn = true
      let retExpr = block.terminator.argument
        ? lowerTrackedExpression(block.terminator.argument, ctx)
        : null
      ctx.inReturn = false
      ctx.preserveHookReturnAccessors = prevPreserveHookReturnAccessors
      if (preserveAccessors) {
        ctx.currentFnIsHook = prevHookFlag
      }
      if (preserveAccessors && retExpr) {
        retExpr = unwrapAccessorCalls(retExpr, ctx)
      }
      return appendPostTerminatorStatements([t.returnStatement(retExpr)])
    }
    case 'Throw':
      return appendPostTerminatorStatements([
        t.throwStatement(lowerTrackedExpression(block.terminator.argument, ctx)),
      ])
    case 'Jump':
      return applyLoc([t.expressionStatement(t.stringLiteral(`jump ${block.terminator.target}`))])
    case 'Branch':
      return applyLoc([
        t.ifStatement(
          lowerTrackedExpression(block.terminator.test, ctx),
          t.blockStatement([
            t.expressionStatement(t.stringLiteral(`goto ${block.terminator.consequent}`)),
          ]),
          t.blockStatement([
            t.expressionStatement(t.stringLiteral(`goto ${block.terminator.alternate}`)),
          ]),
        ),
      ])
    case 'Switch':
      return applyLoc([
        t.switchStatement(
          lowerTrackedExpression(block.terminator.discriminant, ctx),
          block.terminator.cases.map(({ test, target }) =>
            t.switchCase(test ? lowerTrackedExpression(test, ctx) : null, [
              t.expressionStatement(t.stringLiteral(`goto ${target}`)),
            ]),
          ),
        ),
      ])
    case 'ForOf': {
      const term = block.terminator
      const varKind = term.variableKind ?? 'const'
      const leftPattern = term.pattern ? term.pattern : t.identifier(term.variable)
      const isAssignmentTarget = term.leftKind === 'assignment' && !term.pattern
      const bodyStatements: BabelCore.types.Statement[] = [
        t.expressionStatement(t.stringLiteral(`body ${term.body}`)),
      ]
      const left = isAssignmentTarget
        ? term.assignmentTarget
          ? lowerLoopAssignmentTarget(term.assignmentTarget, ctx)
          : t.identifier(term.variable)
        : t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      if (isAssignmentTarget && !term.assignmentTarget) {
        assertWritableImportedReactiveIdentifier(term.variable, ctx, term.loc)
      }
      if (
        isAssignmentTarget &&
        !term.assignmentTarget &&
        ctx.trackedVars.has(deSSAVarName(term.variable))
      ) {
        const loopValue = genTemp(ctx, 'forOf')
        bodyStatements.unshift(
          t.expressionStatement(
            t.callExpression(t.identifier(deSSAVarName(term.variable)), [
              t.identifier(loopValue.name),
            ]),
          ),
        )
        return applyLoc([
          t.forOfStatement(
            t.variableDeclaration('const', [t.variableDeclarator(loopValue)]),
            lowerExpression(term.iterable, ctx),
            t.blockStatement(bodyStatements),
            !!term.await,
          ),
        ])
      }
      return applyLoc([
        t.forOfStatement(
          left,
          lowerExpression(term.iterable, ctx),
          t.blockStatement(bodyStatements),
          !!term.await,
        ),
      ])
    }
    case 'ForIn': {
      const term = block.terminator
      const varKind = term.variableKind ?? 'const'
      const leftPattern = term.pattern ? term.pattern : t.identifier(term.variable)
      const isAssignmentTarget = term.leftKind === 'assignment' && !term.pattern
      const bodyStatements: BabelCore.types.Statement[] = [
        t.expressionStatement(t.stringLiteral(`body ${term.body}`)),
      ]
      const left = isAssignmentTarget
        ? term.assignmentTarget
          ? lowerLoopAssignmentTarget(term.assignmentTarget, ctx)
          : t.identifier(term.variable)
        : t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)])
      if (isAssignmentTarget && !term.assignmentTarget) {
        assertWritableImportedReactiveIdentifier(term.variable, ctx, term.loc)
      }
      if (
        isAssignmentTarget &&
        !term.assignmentTarget &&
        ctx.trackedVars.has(deSSAVarName(term.variable))
      ) {
        const loopValue = genTemp(ctx, 'forIn')
        bodyStatements.unshift(
          t.expressionStatement(
            t.callExpression(t.identifier(deSSAVarName(term.variable)), [
              t.identifier(loopValue.name),
            ]),
          ),
        )
        return applyLoc([
          t.forInStatement(
            t.variableDeclaration('const', [t.variableDeclarator(loopValue)]),
            lowerExpression(term.object, ctx),
            t.blockStatement(bodyStatements),
          ),
        ])
      }
      return applyLoc([
        t.forInStatement(left, lowerExpression(term.object, ctx), t.blockStatement(bodyStatements)),
      ])
    }
    case 'Try': {
      const term = block.terminator
      const tryBlock = t.blockStatement([
        t.expressionStatement(t.stringLiteral(`try ${term.tryBlock}`)),
      ])
      const catchClause =
        term.catchBlock !== undefined
          ? t.catchClause(
              term.catchPattern
                ? (t.cloneNode(term.catchPattern, true) as BabelCore.types.CatchClause['param'])
                : term.catchParam
                  ? t.identifier(term.catchParam)
                  : null,
              t.blockStatement([
                t.expressionStatement(t.stringLiteral(`catch ${term.catchBlock}`)),
              ]),
            )
          : null
      const finallyBlock =
        term.finallyBlock !== undefined
          ? t.blockStatement([
              t.expressionStatement(t.stringLiteral(`finally ${term.finallyBlock}`)),
            ])
          : null
      return applyLoc([t.tryStatement(tryBlock, catchClause, finallyBlock)])
    }
    case 'Unreachable':
      return applyLoc([])
    case 'Break':
      return applyLoc([
        t.breakStatement(block.terminator.label ? t.identifier(block.terminator.label) : null),
      ])
    case 'Continue':
      return applyLoc([
        t.continueStatement(block.terminator.label ? t.identifier(block.terminator.label) : null),
      ])
    default:
      return applyLoc([])
  }
}

function collectLocalDeclaredNames(
  params: { name: string }[],
  blocks: BasicBlock[] | null | undefined,
  t: typeof BabelCore.types,
): Set<string> {
  const declared = new Set<string>()
  const addPatternNames = (pattern: BabelCore.types.LVal | BabelCore.types.PatternLike): void => {
    if (t.isIdentifier(pattern)) {
      declared.add(deSSAVarName(pattern.name))
      return
    }
    if (t.isAssignmentPattern(pattern)) {
      addPatternNames(pattern.left as BabelCore.types.PatternLike)
      return
    }
    if (t.isRestElement(pattern)) {
      addPatternNames(pattern.argument as BabelCore.types.PatternLike)
      return
    }
    if (t.isObjectPattern(pattern)) {
      for (const prop of pattern.properties) {
        if (t.isRestElement(prop)) {
          addPatternNames(prop.argument as BabelCore.types.PatternLike)
        } else if (t.isObjectProperty(prop)) {
          addPatternNames(prop.value as BabelCore.types.PatternLike)
        }
      }
      return
    }
    if (t.isArrayPattern(pattern)) {
      for (const el of pattern.elements) {
        if (!el) continue
        if (t.isPatternLike(el)) addPatternNames(el as BabelCore.types.PatternLike)
      }
    }
  }

  params.forEach(param => declared.add(deSSAVarName(param.name)))

  if (!blocks) return declared

  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const target = deSSAVarName(instr.target.name)
      const isFunctionDecl =
        instr.value.kind === 'FunctionExpression' &&
        !!instr.value.name &&
        !instr.isMutation &&
        deSSAVarName(instr.value.name) === target
      if (instr.declarationKind || isFunctionDecl) {
        declared.add(target)
      }
    }
    const term = block.terminator
    if (term.kind === 'ForOf' || term.kind === 'ForIn') {
      if (term.leftKind !== 'assignment') {
        declared.add(deSSAVarName(term.variable))
      }
      if (term.leftKind !== 'assignment' && term.pattern) {
        addPatternNames(term.pattern as BabelCore.types.PatternLike)
      }
    } else if (term.kind === 'Try') {
      if (term.catchPattern) {
        addPatternNames(term.catchPattern as BabelCore.types.PatternLike)
      } else if (term.catchParam) {
        declared.add(deSSAVarName(term.catchParam))
      }
    }
  }

  return declared
}

/**
 * Lower an HIR Expression to a Babel AST Expression.
 * All SSA-versioned variable names are automatically de-versioned to their original names.
 */
export function lowerExpression(
  expr: Expression,
  ctx: CodegenContext,
  valueUsed = true,
): BabelCore.types.Expression {
  // Check recursion depth to prevent stack overflow
  const depth = (ctx.expressionDepth ?? 0) + 1
  const maxDepth = ctx.maxExpressionDepth ?? 500
  if (depth > maxDepth) {
    throw new HIRError(
      `Expression too deeply nested (depth ${depth} exceeds maximum ${maxDepth}). ` +
        `This may indicate a malformed AST or excessively complex expression.`,
      'DEPTH_EXCEEDED',
    )
  }
  ctx.expressionDepth = depth

  try {
    return setNodeLoc(lowerExpressionImpl(expr, ctx, valueUsed), expr.loc)
  } finally {
    ctx.expressionDepth = depth - 1
  }
}

function isAccessorObjectRoot(expr: Expression, ctx: CodegenContext): string | null {
  if (expr.kind !== 'Identifier') return null
  const baseName = deSSAVarName(expr.name)
  if (
    ctx.signalVars?.has(baseName) ||
    ctx.memoVars?.has(baseName) ||
    ctx.aliasVars?.has(baseName)
  ) {
    return baseName
  }
  return null
}

function lowerMemberPropertyForTarget(
  property: Expression,
  computed: boolean,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  if (computed) return lowerExpression(property, ctx)
  if (property.kind === 'Identifier') return ctx.t.identifier(property.name)
  return ctx.t.stringLiteral(String(property.kind === 'Literal' ? (property.value ?? '') : ''))
}

function lowerMemberObjectForAssignmentTarget(
  object: Expression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const accessorName = isAccessorObjectRoot(object, ctx)
  if (accessorName) {
    return ctx.t.callExpression(ctx.t.identifier(accessorName), [])
  }
  if (object.kind === 'MemberExpression' || object.kind === 'OptionalMemberExpression') {
    return lowerMemberExpressionForAssignmentTarget(object, ctx)
  }
  return lowerExpression(object, ctx)
}

function lowerMemberExpressionForAssignmentTarget(
  expr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  ctx: CodegenContext,
): BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression {
  const object = lowerMemberObjectForAssignmentTarget(expr.object as Expression, ctx)
  const property = lowerMemberPropertyForTarget(expr.property as Expression, expr.computed, ctx)
  if (expr.kind === 'OptionalMemberExpression') {
    return ctx.t.optionalMemberExpression(object, property, expr.computed, expr.optional)
  }
  return ctx.t.memberExpression(object, property, expr.computed, expr.optional)
}

function withObjectLiteralPath<T>(ctx: CodegenContext, path: string[] | undefined, fn: () => T): T {
  if (!path) return fn()
  const prevPath = ctx.objectLiteralPath
  ctx.objectLiteralPath = path
  try {
    return fn()
  } finally {
    ctx.objectLiteralPath = prevPath
  }
}

function getStaticObjectPropertySegment(
  prop: Extract<Expression, { kind: 'ObjectExpression' }>['properties'][number],
): string | null {
  if (prop.kind === 'SpreadElement' || prop.computed) return null
  const name = getStaticPropName(prop.key as Expression, false)
  return typeof name === 'string' || typeof name === 'number' ? String(name) : null
}

function objectPathKey(path: string[]): string {
  return path.join('.')
}

function isJSXMemberComponentPath(path: string[] | undefined, ctx: CodegenContext): boolean {
  if (!path) return false
  return ctx.jsxMemberComponentPaths?.has(objectPathKey(path)) ?? false
}

function isJSXIdentifierComponentName(name: string, ctx: CodegenContext): boolean {
  return ctx.jsxComponentNames?.has(name) ?? false
}

function classComponentNameForJSXTag(
  tagName: string | Expression,
  ctx: CodegenContext,
): string | null {
  if (typeof tagName === 'string') {
    return ctx.moduleBindingKinds?.get(tagName) === 'class' ? tagName : null
  }
  const path = getStaticMemberPath(tagName)
  if (!path) return null
  if (path.length === 1) {
    const name = path[0]
    return name && ctx.moduleBindingKinds?.get(name) === 'class' ? name : null
  }
  const key = objectPathKey(path)
  return ctx.classComponentPaths?.has(key) ? key : null
}

function assertSupportedJSXComponentTag(jsx: JSXElementExpression, ctx: CodegenContext): void {
  const className = classComponentNameForJSXTag(jsx.tagName, ctx)
  if (!className) return
  throw new HIRError(
    `Class component "${className}" is not supported. Fict components must be functions.`,
    'CODEGEN_ERROR',
    { file: ctx.options?.filename, line: jsx.loc?.start.line },
  )
}

function getStaticMemberPath(expr: Expression): string[] | null {
  if (expr.kind === 'Identifier') return [deSSAVarName(expr.name)]
  if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return null
  const objectPath = getStaticMemberPath(expr.object as Expression)
  if (!objectPath) return null
  const propertyName = getStaticPropName(expr.property as Expression, expr.computed)
  if (propertyName === null) return null
  return [...objectPath, String(propertyName)]
}

function addDestructuredJSXComponentSourcePathsFromFunctions(
  functions: Iterable<HIRFunction>,
  ctx: CodegenContext,
): void {
  const paths = ctx.jsxMemberComponentPaths ?? (ctx.jsxMemberComponentPaths = new Set())
  for (const fn of functions) {
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind !== 'Assign') continue
        const targetName = deSSAVarName(instr.target.name)
        if (!isJSXIdentifierComponentName(targetName, ctx)) continue
        const sourcePath = getStaticMemberPath(instr.value)
        if (!sourcePath || sourcePath.length < 2) continue
        paths.add(objectPathKey(sourcePath))
      }
    }
  }
}

function addDestructuredJSXComponentSourcePaths(program: HIRProgram, ctx: CodegenContext): void {
  addDestructuredJSXComponentSourcePathsFromFunctions(program.functions, ctx)
}

function functionValueToHIRFunction(
  value: Extract<Expression, { kind: 'ArrowFunction' | 'FunctionExpression' }>,
  componentName: string,
): HIRFunction {
  const blocks: BasicBlock[] = Array.isArray(value.body)
    ? (value.body as BasicBlock[])
    : [
        {
          id: 0,
          instructions: [],
          terminator: {
            kind: 'Return',
            argument: value.body as Expression,
            loc: value.loc ?? null,
          },
        },
      ]

  return {
    name: componentName,
    params: value.params,
    rawParams: value.rawParams,
    blocks,
    meta: {
      fromExpression: true,
      isArrow: value.kind === 'ArrowFunction',
      hasExpressionBody: value.kind === 'ArrowFunction' && value.isExpression,
      isAsync: value.isAsync ?? false,
      ...(value.kind === 'FunctionExpression' && value.isGenerator
        ? { isGenerator: value.isGenerator }
        : null),
      ...(value.kind === 'FunctionExpression' && value.name
        ? { functionExpressionName: value.name }
        : null),
      ...(value.noMemo ? { noMemo: true } : null),
      ...(value.pure ? { pure: true } : null),
    },
    loc: value.loc ?? null,
  }
}

function lowerJSXMemberComponentFunctionValue(
  value: Expression,
  path: string[] | undefined,
  ctx: CodegenContext,
): BabelCore.types.Expression | null {
  if (!isJSXMemberComponentPath(path, ctx)) return null
  if (value.kind !== 'ArrowFunction' && value.kind !== 'FunctionExpression') return null
  const componentName = path?.[path.length - 1] ?? 'Component'
  const fn = functionValueToHIRFunction(value, componentName)
  const lowered = lowerFunctionWithRegions(fn, ctx, { forceComponentContext: true })
  if (!lowered) return null
  return buildFunctionDeclaratorExpression({ fn, stmt: lowered }, ctx.t)
}

function lowerComponentWrapperFunctionArgument(
  value: Expression,
  ctx: CodegenContext,
): BabelCore.types.Expression | null {
  return lowerComponentExpressionFunctionValue(value, ctx)
}

function lowerComponentExpressionFunctionValue(
  value: Expression,
  ctx: CodegenContext,
): BabelCore.types.Expression | null {
  const componentName = ctx.componentWrapperName
  if (!componentName) return null
  if (value.kind !== 'ArrowFunction' && value.kind !== 'FunctionExpression') return null
  const fn = functionValueToHIRFunction(value, componentName)
  const prevComponentWrapperName = ctx.componentWrapperName
  ctx.componentWrapperName = undefined
  let lowered: BabelCore.types.FunctionDeclaration | null
  try {
    lowered = lowerFunctionWithRegions(fn, ctx, { forceComponentContext: true })
  } finally {
    ctx.componentWrapperName = prevComponentWrapperName
  }
  if (!lowered) return null
  return buildFunctionDeclaratorExpression({ fn, stmt: lowered }, ctx.t)
}

function lowerExpressionComponentCandidate(
  value: Expression,
  ctx: CodegenContext,
  valueUsed = true,
): BabelCore.types.Expression {
  return lowerComponentExpressionFunctionValue(value, ctx) ?? lowerExpression(value, ctx, valueUsed)
}

function lowerExpressionImpl(
  expr: Expression,
  ctx: CodegenContext,
  valueUsed = true,
): BabelCore.types.Expression {
  const { t } = ctx
  const lowerCallArguments = (
    args: Expression[],
    mapArg?: (arg: Expression, idx: number) => BabelCore.types.Expression,
  ): (BabelCore.types.Expression | BabelCore.types.SpreadElement)[] =>
    args.map((arg, idx) => {
      if (arg.kind === 'SpreadElement') {
        return t.spreadElement(lowerExpression(arg.argument as Expression, ctx))
      }
      return mapArg ? mapArg(arg, idx) : lowerExpression(arg, ctx)
    })
  const withCallCacheBarrier = <T extends BabelCore.types.Expression>(node: T): T => {
    clearCachedGetters(ctx)
    return node
  }
  const withOptionalGetterCache = <T>(
    enabled: boolean,
    fn: () => T,
    disabledGetters?: Iterable<string>,
  ): { result: T; cacheDeclarations: BabelCore.types.Statement[] } =>
    enabled ? withGetterCache(ctx, fn, disabledGetters) : { result: fn(), cacheDeclarations: [] }
  const withFunctionScope = <T>(
    paramNames: Set<string>,
    fn: () => T,
    localDeclared?: Set<string>,
  ): T => {
    const prevTracked = ctx.trackedVars
    const prevAlias = ctx.aliasVars
    const prevSignals = ctx.signalVars
    const prevMemos = ctx.memoVars
    const prevCallableSignals = ctx.callableSignalVars
    const prevImportedReactiveKinds = ctx.importedReactiveKinds
    const prevExternal = ctx.externalTracked
    const prevShadowed = ctx.shadowedNames
    const prevLocalDeclared = ctx.localDeclaredNames
    const prevCurrentFunctionDeclared = ctx.currentFunctionDeclaredNames
    const prevHookFunctionAliases = ctx.hookFunctionAliases
    const prevHookFunctionMemberAliases = ctx.hookFunctionMemberAliases
    const scoped = new Set(ctx.trackedVars)
    paramNames.forEach(n => scoped.delete(deSSAVarName(n)))
    if (localDeclared) {
      for (const name of localDeclared) {
        scoped.delete(deSSAVarName(name))
      }
    }
    ctx.trackedVars = scoped
    ctx.signalVars = new Set(ctx.signalVars)
    paramNames.forEach(n => ctx.signalVars?.delete(deSSAVarName(n)))
    if (localDeclared) {
      for (const name of localDeclared) {
        ctx.signalVars?.delete(deSSAVarName(name))
      }
    }
    ctx.memoVars = new Set(ctx.memoVars)
    paramNames.forEach(n => ctx.memoVars?.delete(deSSAVarName(n)))
    if (localDeclared) {
      for (const name of localDeclared) {
        ctx.memoVars?.delete(deSSAVarName(name))
      }
    }
    ctx.callableSignalVars = new Set(ctx.callableSignalVars)
    paramNames.forEach(n => ctx.callableSignalVars?.delete(deSSAVarName(n)))
    if (localDeclared) {
      for (const name of localDeclared) {
        ctx.callableSignalVars?.delete(deSSAVarName(name))
      }
    }
    ctx.importedReactiveKinds = new Map(prevImportedReactiveKinds ?? [])
    paramNames.forEach(n => ctx.importedReactiveKinds?.delete(deSSAVarName(n)))
    if (localDeclared) {
      for (const name of localDeclared) {
        ctx.importedReactiveKinds?.delete(deSSAVarName(name))
      }
    }
    ctx.aliasVars = new Set(ctx.aliasVars)
    ctx.hookFunctionAliases = new Map(prevHookFunctionAliases ?? [])
    ctx.hookFunctionMemberAliases = new Map(prevHookFunctionMemberAliases ?? [])
    ctx.externalTracked = new Set(prevTracked)
    const shadowed = new Set(prevShadowed ?? [])
    paramNames.forEach(n => shadowed.add(deSSAVarName(n)))
    if (localDeclared) {
      for (const name of localDeclared) {
        shadowed.add(deSSAVarName(name))
      }
    }
    ctx.shadowedNames = shadowed
    const localNames = new Set(prevLocalDeclared ?? [])
    const currentFunctionDeclared = new Set<string>()
    paramNames.forEach(n => currentFunctionDeclared.add(deSSAVarName(n)))
    if (localDeclared) {
      for (const name of localDeclared) {
        const declaredName = deSSAVarName(name)
        localNames.add(declaredName)
        currentFunctionDeclared.add(declaredName)
      }
    }
    ctx.localDeclaredNames = localNames
    ctx.currentFunctionDeclaredNames = currentFunctionDeclared
    const result = fn()
    ctx.trackedVars = prevTracked
    ctx.aliasVars = prevAlias
    ctx.signalVars = prevSignals
    ctx.memoVars = prevMemos
    ctx.callableSignalVars = prevCallableSignals
    ctx.importedReactiveKinds = prevImportedReactiveKinds
    ctx.externalTracked = prevExternal
    ctx.shadowedNames = prevShadowed
    ctx.localDeclaredNames = prevLocalDeclared
    ctx.currentFunctionDeclaredNames = prevCurrentFunctionDeclared
    ctx.hookFunctionAliases = prevHookFunctionAliases
    ctx.hookFunctionMemberAliases = prevHookFunctionMemberAliases
    return result
  }
  const withListKeyConstificationScope = <T>(
    paramNames: Set<string>,
    localDeclared: Set<string> | undefined,
    fn: () => T,
  ): T => {
    const prevDepth = ctx.listKeyConstificationDepth
    if (prevDepth === undefined) return fn()

    const prevDisabled = ctx.listKeyConstificationDisabled
    const itemName = ctx.listItemParamName ? deSSAVarName(ctx.listItemParamName) : null
    const shadowsItem =
      !!itemName && (paramNames.has(itemName) || (localDeclared?.has(itemName) ?? false))

    ctx.listKeyConstificationDepth = prevDepth + 1
    if (prevDepth > 0 && shadowsItem) {
      ctx.listKeyConstificationDisabled = true
    }
    try {
      return fn()
    } finally {
      ctx.listKeyConstificationDepth = prevDepth
      ctx.listKeyConstificationDisabled = prevDisabled
    }
  }
  const lowerTrackedWriteCall = (
    callee: BabelCore.types.Expression,
    nextValue: BabelCore.types.Expression,
  ): BabelCore.types.Expression => {
    if (t.isIdentifier(callee)) {
      invalidateCachedGetter(ctx, deSSAVarName(callee.name))
    }
    if (!valueUsed) {
      return t.callExpression(t.cloneNode(callee, true), [nextValue])
    }

    const nextId = genTemp(ctx, 'next')
    const nextRef = t.identifier(nextId.name)
    return t.callExpression(
      t.arrowFunctionExpression(
        [t.cloneNode(nextId, true)],
        t.sequenceExpression([
          t.callExpression(t.cloneNode(callee, true), [nextRef]),
          t.identifier(nextId.name),
        ]),
      ),
      [nextValue],
    )
  }
  const lowerTrackedLogicalAssignment = (
    callee: BabelCore.types.Expression,
    current: BabelCore.types.Expression,
    operator: '||=' | '&&=' | '??=',
    right: BabelCore.types.Expression,
  ): BabelCore.types.Expression => {
    const prevId = genTemp(ctx, 'prev')
    const prev = () => t.identifier(prevId.name)
    const write = lowerTrackedWriteCall(callee, right)
    const body =
      operator === '&&='
        ? t.logicalExpression('&&', prev(), write)
        : operator === '||='
          ? t.logicalExpression('||', prev(), write)
          : t.logicalExpression('??', prev(), write)

    return t.callExpression(t.arrowFunctionExpression([t.cloneNode(prevId, true)], body), [current])
  }
  const lowerTrackedAssignmentWrite = (
    callee: BabelCore.types.Expression,
    operator: BabelCore.types.AssignmentExpression['operator'],
    current: BabelCore.types.Expression,
    right: BabelCore.types.Expression,
  ): BabelCore.types.Expression => {
    if (isLogicalAssignmentOperator(operator)) {
      return lowerTrackedLogicalAssignment(callee, current, operator, right)
    }
    return lowerTrackedWriteCall(callee, buildTrackedAssignmentNext(operator, current, right))
  }
  const buildTrackedAssignmentNext = (
    operator: string,
    current: BabelCore.types.Expression,
    right: BabelCore.types.Expression,
  ): BabelCore.types.Expression => {
    switch (operator) {
      case '=':
        return right
      case '+=':
        return t.binaryExpression('+', current, right)
      case '-=':
        return t.binaryExpression('-', current, right)
      case '*=':
        return t.binaryExpression('*', current, right)
      case '/=':
        return t.binaryExpression('/', current, right)
      case '%=':
        return t.binaryExpression('%', current, right)
      case '**=':
        return t.binaryExpression('**', current, right)
      case '<<=':
        return t.binaryExpression('<<', current, right)
      case '>>=':
        return t.binaryExpression('>>', current, right)
      case '>>>=':
        return t.binaryExpression('>>>', current, right)
      case '|=':
        return t.binaryExpression('|', current, right)
      case '^=':
        return t.binaryExpression('^', current, right)
      case '&=':
        return t.binaryExpression('&', current, right)
      case '&&=':
        return t.logicalExpression('&&', current, right)
      case '||=':
        return t.logicalExpression('||', current, right)
      case '??=':
        return t.logicalExpression('??', current, right)
      default:
        return right
    }
  }
  const buildStaticSignalKeyTest = (
    keyRef: BabelCore.types.Identifier,
    keys: (string | number)[],
  ): BabelCore.types.Expression | null => {
    if (keys.length === 0) return null
    let test: BabelCore.types.Expression | null = null
    const seen = new Set<string>()
    const addKeyTest = (key: string | number): void => {
      const seenKey = `${typeof key}:${String(key)}`
      if (seen.has(seenKey)) return
      seen.add(seenKey)
      const literal = typeof key === 'number' ? t.numericLiteral(key) : t.stringLiteral(String(key))
      const eq = t.binaryExpression('===', t.cloneNode(keyRef, true), literal)
      test = test ? t.logicalExpression('||', test, eq) : eq
    }
    const addNumericStringEquivalent = (key: string): void => {
      const numeric = getCanonicalNumericKey(key)
      if (numeric === null) return
      addKeyTest(numeric)
    }

    for (const key of keys) {
      addKeyTest(key)
      if (typeof key === 'number' && Number.isFinite(key)) {
        addKeyTest(String(key))
      } else if (typeof key === 'string') {
        addNumericStringEquivalent(key)
      }
    }
    return test
  }
  const lowerComputedHookSignalAssignmentForObject = (
    objectExpr: BabelCore.types.Expression,
    keyExpr: Expression,
    signalKeys: (string | number)[],
    operator: BabelCore.types.AssignmentExpression['operator'],
    rightExpr: Expression,
  ): BabelCore.types.Expression | null => {
    const keyTestKeys = signalKeys.filter(
      key => (typeof key === 'number' && Number.isFinite(key)) || typeof key === 'string',
    )
    if (keyTestKeys.length === 0) return null

    const keyId = genTemp(ctx, 'key')
    const keyRef = t.identifier(keyId.name)
    const memberForAccessor = t.memberExpression(
      t.cloneNode(objectExpr, true),
      t.identifier(keyId.name),
      true,
    )
    const current = t.callExpression(t.cloneNode(memberForAccessor, true), [])
    const right = lowerExpression(rightExpr, ctx)
    const signalWrite = lowerTrackedAssignmentWrite(
      memberForAccessor,
      operator,
      current,
      t.cloneNode(right, true),
    )
    const fallback = t.assignmentExpression(
      operator,
      t.memberExpression(t.cloneNode(objectExpr, true), t.identifier(keyId.name), true),
      right,
    )
    const keyTest = buildStaticSignalKeyTest(keyRef, keyTestKeys)
    if (!keyTest) return null
    return t.callExpression(
      t.arrowFunctionExpression(
        [t.cloneNode(keyId, true)],
        t.conditionalExpression(keyTest, signalWrite, fallback),
      ),
      [lowerExpression(keyExpr, ctx)],
    )
  }
  const lowerComputedHookSignalUpdateForObject = (
    objectExpr: BabelCore.types.Expression,
    keyExpr: Expression,
    signalKeys: (string | number)[],
    operator: '++' | '--',
    prefix: boolean,
  ): BabelCore.types.Expression | null => {
    const keyTestKeys = signalKeys.filter(
      key => (typeof key === 'number' && Number.isFinite(key)) || typeof key === 'string',
    )
    if (keyTestKeys.length === 0) return null

    const keyId = genTemp(ctx, 'key')
    const keyRef = t.identifier(keyId.name)
    const signalUpdate = lowerTrackedUpdateCall(
      t.memberExpression(t.cloneNode(objectExpr, true), t.identifier(keyId.name), true),
      operator,
      prefix,
    )
    const fallback = t.updateExpression(
      operator,
      t.memberExpression(t.cloneNode(objectExpr, true), t.identifier(keyId.name), true),
      prefix,
    )
    const keyTest = buildStaticSignalKeyTest(keyRef, keyTestKeys)
    if (!keyTest) return null
    return t.callExpression(
      t.arrowFunctionExpression(
        [t.cloneNode(keyId, true)],
        t.conditionalExpression(keyTest, signalUpdate, fallback),
      ),
      [lowerExpression(keyExpr, ctx)],
    )
  }
  const lowerTrackedUpdateCall = (
    callee: BabelCore.types.Expression,
    operator: '++' | '--',
    prefix: boolean,
  ): BabelCore.types.Expression => {
    const current = t.callExpression(t.cloneNode(callee, true), [])
    const prevId = genTemp(ctx, 'prev')
    const prevRef = (): BabelCore.types.Identifier => t.identifier(prevId.name)
    const buildUpdate = (isPrefix: boolean): BabelCore.types.UpdateExpression =>
      t.updateExpression(operator, prevRef(), isPrefix)
    if (!valueUsed) {
      return t.callExpression(
        t.arrowFunctionExpression(
          [t.cloneNode(prevId, true)],
          t.callExpression(t.cloneNode(callee, true), [buildUpdate(true)]),
        ),
        [current],
      )
    }

    if (prefix) {
      return t.callExpression(
        t.arrowFunctionExpression(
          [t.cloneNode(prevId, true)],
          t.sequenceExpression([
            t.callExpression(t.cloneNode(callee, true), [buildUpdate(true)]),
            prevRef(),
          ]),
        ),
        [current],
      )
    }

    const oldId = genTemp(ctx, 'old')
    return t.callExpression(
      t.arrowFunctionExpression(
        [t.cloneNode(prevId, true)],
        t.callExpression(
          t.arrowFunctionExpression(
            [t.cloneNode(oldId, true)],
            t.sequenceExpression([
              t.callExpression(t.cloneNode(callee, true), [prevRef()]),
              t.identifier(oldId.name),
            ]),
          ),
          [buildUpdate(false)],
        ),
      ),
      [current],
    )
  }
  const lowerRawClassReactiveWrites = <T extends BabelCore.types.Node>(node: T): T => {
    const bindingNames = (current: BabelCore.types.Node | null | undefined): Set<string> => {
      const names = new Set<string>()
      if (!current) return names
      const ids = t.getBindingIdentifiers(current)
      Object.keys(ids).forEach(name => names.add(deSSAVarName(name)))
      return names
    }
    const scopedWithBindings = (
      shadowed: Set<string>,
      nodes: (BabelCore.types.Node | null | undefined)[],
    ): Set<string> => {
      const scoped = new Set(shadowed)
      nodes.forEach(current => bindingNames(current).forEach(name => scoped.add(name)))
      return scoped
    }
    const visit = (current: unknown, shadowed: Set<string>): unknown => {
      if (!current || typeof current !== 'object') return current
      if (Array.isArray(current)) return current.map(item => visit(item, shadowed))
      if (!('type' in current)) return current

      const astNode = current as BabelCore.types.Node
      if (t.isClassMethod(astNode) || t.isClassPrivateMethod(astNode)) {
        if (astNode.computed) {
          astNode.key = visit(astNode.key, shadowed) as typeof astNode.key
        }
        const scoped = scopedWithBindings(shadowed, [astNode.body, ...astNode.params])
        astNode.body = visit(astNode.body, scoped) as typeof astNode.body
        return astNode
      }
      if (t.isStaticBlock(astNode)) {
        const scoped = scopedWithBindings(shadowed, [astNode])
        astNode.body = astNode.body.map(stmt => visit(stmt, scoped) as typeof stmt)
        return astNode
      }

      if (t.isAssignmentExpression(astNode)) {
        astNode.right = visit(astNode.right, shadowed) as BabelCore.types.Expression
        if (t.isIdentifier(astNode.left)) {
          const baseName = deSSAVarName(astNode.left.name)
          if (
            !shadowed.has(baseName) &&
            ctx.trackedVars.has(baseName) &&
            !(ctx.localValueVars?.has(baseName) ?? false)
          ) {
            assertWritableImportedReactiveIdentifier(baseName, ctx, astNode.loc)
            const callee = t.identifier(baseName)
            const currentValue = t.callExpression(t.identifier(baseName), [])
            return lowerTrackedAssignmentWrite(
              callee,
              astNode.operator,
              currentValue,
              astNode.right,
            )
          }
        }
      }

      if (t.isUpdateExpression(astNode) && t.isIdentifier(astNode.argument)) {
        const baseName = deSSAVarName(astNode.argument.name)
        if (
          !shadowed.has(baseName) &&
          ctx.trackedVars.has(baseName) &&
          !(ctx.localValueVars?.has(baseName) ?? false)
        ) {
          assertWritableImportedReactiveIdentifier(baseName, ctx, astNode.loc)
          return lowerTrackedUpdateCall(t.identifier(baseName), astNode.operator, astNode.prefix)
        }
      }

      const record = astNode as unknown as Record<string, unknown>
      for (const key of Object.keys(astNode)) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
        const value = record[key]
        if (Array.isArray(value)) {
          record[key] = value.map(item => visit(item, shadowed))
        } else if (value && typeof value === 'object' && 'type' in value) {
          record[key] = visit(value, shadowed)
        }
      }
      return astNode
    }

    return visit(node, new Set(ctx.shadowedNames ?? [])) as T
  }
  const lowerBlocksToStatements = (blocks: BasicBlock[]): BabelCore.types.Statement[] => {
    const stmts: BabelCore.types.Statement[] = []
    for (const block of blocks) {
      stmts.push(
        ...(block.instructions
          .map(instr => lowerInstruction(instr, ctx))
          .filter(Boolean) as BabelCore.types.Statement[]),
      )
      stmts.push(...lowerTerminator(block, ctx))
    }
    return stmts
  }
  const collectWrittenGetterNames = (blocks: BasicBlock[]): Set<string> => {
    const written = new Set<string>()
    const isGetterBinding = (name: string): boolean =>
      !!(ctx.signalVars?.has(name) || ctx.memoVars?.has(name) || ctx.aliasVars?.has(name))

    for (const block of blocks) {
      for (const instr of block.instructions) {
        if (instr.kind !== 'Assign' || instr.declarationKind) continue
        const target = deSSAVarName(instr.target.name)
        if (isGetterBinding(target)) {
          written.add(target)
        }
      }
    }
    return written
  }
  const collectCacheableGetterNames = (): Set<string> => {
    const names = new Set<string>()
    ctx.signalVars?.forEach(name => names.add(name))
    ctx.aliasVars?.forEach(name => names.add(name))
    return names
  }
  const expressionHasCallBarrier = (value: Expression | null | undefined): boolean => {
    if (!value) return false
    switch (value.kind) {
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression':
      case 'TaggedTemplateExpression':
      case 'ImportExpression':
        return true
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        return (
          expressionHasCallBarrier(value.object) ||
          (value.computed && expressionHasCallBarrier(value.property))
        )
      case 'BinaryExpression':
      case 'LogicalExpression':
        return expressionHasCallBarrier(value.left) || expressionHasCallBarrier(value.right)
      case 'UnaryExpression':
      case 'SpreadElement':
      case 'AwaitExpression':
        return expressionHasCallBarrier(value.argument)
      case 'ConditionalExpression':
        return (
          expressionHasCallBarrier(value.test) ||
          expressionHasCallBarrier(value.consequent) ||
          expressionHasCallBarrier(value.alternate)
        )
      case 'ArrayExpression':
        return value.elements.some(expressionHasCallBarrier)
      case 'ObjectExpression':
        return value.properties.some(prop =>
          prop.kind === 'SpreadElement'
            ? expressionHasCallBarrier(prop.argument)
            : expressionHasCallBarrier(prop.key) || expressionHasCallBarrier(prop.value),
        )
      case 'JSXElement':
        return (
          expressionHasCallBarrier(typeof value.tagName === 'string' ? undefined : value.tagName) ||
          value.attributes.some(attr =>
            attr.isSpread
              ? expressionHasCallBarrier(attr.spreadExpr)
              : expressionHasCallBarrier(attr.value),
          ) ||
          value.children.some(child =>
            child.kind === 'expression'
              ? expressionHasCallBarrier(child.value)
              : child.kind === 'element'
                ? expressionHasCallBarrier(child.value)
                : false,
          )
        )
      case 'AssignmentExpression':
        return expressionHasCallBarrier(value.left) || expressionHasCallBarrier(value.right)
      case 'UpdateExpression':
        return expressionHasCallBarrier(value.argument)
      case 'TemplateLiteral':
        return value.expressions.some(expressionHasCallBarrier)
      case 'SequenceExpression':
        return value.expressions.some(expressionHasCallBarrier)
      case 'YieldExpression':
        return expressionHasCallBarrier(value.argument)
      case 'ClassExpression':
        return !!value.superClass && expressionHasCallBarrier(value.superClass)
      case 'ArrowFunction':
      case 'FunctionExpression':
      case 'Identifier':
      case 'Literal':
      case 'MetaProperty':
      case 'ThisExpression':
      case 'SuperExpression':
        return false
    }
  }
  const blocksHaveCallBarrier = (blocks: BasicBlock[]): boolean =>
    blocks.some(block => {
      if (
        block.instructions.some(instr =>
          instr.kind === 'Assign' || instr.kind === 'Expression'
            ? expressionHasCallBarrier(instr.value)
            : false,
        )
      ) {
        return true
      }
      switch (block.terminator.kind) {
        case 'Return':
          return expressionHasCallBarrier(block.terminator.argument)
        case 'Throw':
          return expressionHasCallBarrier(block.terminator.argument)
        case 'Branch':
          return expressionHasCallBarrier(block.terminator.test)
        case 'Switch':
          return (
            expressionHasCallBarrier(block.terminator.discriminant) ||
            block.terminator.cases.some(c => expressionHasCallBarrier(c.test))
          )
        case 'ForOf':
          return expressionHasCallBarrier(block.terminator.iterable)
        case 'ForIn':
          return expressionHasCallBarrier(block.terminator.object)
        default:
          return false
      }
    })
  const collectDisabledGetterNames = (blocks: BasicBlock[]): Set<string> => {
    const disabled = collectWrittenGetterNames(blocks)
    if (blocksHaveCallBarrier(blocks)) {
      collectCacheableGetterNames().forEach(name => disabled.add(name))
    }
    return disabled
  }
  const lowerStructuredBlocks = (
    blocks: BasicBlock[],
    params: { name: string }[],
    paramIds: BabelCore.types.FunctionParameter[],
  ): BabelCore.types.Statement[] => {
    try {
      const fn: HIRFunction = {
        params: params.map(p => ({ kind: 'Identifier', name: p.name })),
        blocks,
        meta: { fromExpression: true },
      }
      const { node, diagnostics } = structurizeCFGWithDiagnostics(fn)
      const structured =
        node.kind === 'stateMachine'
          ? node
          : diagnostics.isComplete
            ? node
            : {
                kind: 'stateMachine' as const,
                blocks: fn.blocks.map(block => ({
                  blockId: block.id,
                  instructions: block.instructions,
                  terminator: block.terminator,
                  postTerminatorStatements: block.postTerminatorStatements,
                })),
                entryBlock: fn.blocks[0]?.id ?? 0,
              }
      const declared = new Set<string>()
      for (const p of paramIds) {
        const ids = t.getBindingIdentifiers(p)
        for (const name of Object.keys(ids)) {
          declared.add(name)
        }
      }
      return lowerStructuredNodeWithoutRegions(structured, t, ctx, declared)
    } catch {
      return lowerBlocksToStatements(blocks)
    }
  }

  const lowerReactiveScopeExpression = (
    fnExpr: Extract<Expression, { kind: 'ArrowFunction' | 'FunctionExpression' }>,
  ): BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression | null => {
    if (!fnExpr.reactiveScope) return null
    const blocks = Array.isArray(fnExpr.body)
      ? (fnExpr.body as BasicBlock[])
      : ([
          {
            id: 0,
            instructions: [],
            terminator: {
              kind: 'Return',
              argument: fnExpr.body as Expression,
            },
          },
        ] as BasicBlock[])

    const fn: HIRFunction = {
      params: fnExpr.params,
      rawParams: fnExpr.rawParams,
      blocks,
      meta: {
        fromExpression: true,
        isArrow: fnExpr.kind === 'ArrowFunction',
        hasExpressionBody: fnExpr.kind === 'ArrowFunction' && fnExpr.isExpression,
        isAsync: fnExpr.isAsync ?? false,
        isGenerator: fnExpr.kind === 'FunctionExpression' ? !!fnExpr.isGenerator : false,
        noMemo: fnExpr.noMemo ?? false,
        pure: fnExpr.pure ?? false,
      },
      loc: fnExpr.loc ?? null,
    }

    const lowered = lowerFunctionWithRegions(fn, ctx, { forceHookContext: true })
    if (!lowered) return null

    const params = lowered.params
    if (fnExpr.kind === 'ArrowFunction') {
      const arrow = t.arrowFunctionExpression(params, lowered.body)
      arrow.async = lowered.async
      return arrow
    }

    const fnExprAst = t.functionExpression(
      fnExpr.name ? t.identifier(deSSAVarName(fnExpr.name)) : null,
      params,
      lowered.body,
    )
    fnExprAst.async = lowered.async
    fnExprAst.generator = lowered.generator ?? fnExpr.isGenerator ?? false
    return fnExprAst
  }

  const lowerMemberExpressionWithoutAccessorCall = (
    member: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
    objectOverride?: BabelCore.types.Expression,
  ): BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression => {
    const object = objectOverride ?? lowerExpression(member.object, ctx)
    const property = member.computed
      ? lowerExpression(member.property, ctx)
      : member.property.kind === 'Identifier'
        ? t.identifier(member.property.name)
        : t.stringLiteral(
            String(member.property.kind === 'Literal' ? (member.property.value ?? '') : ''),
          )

    if (member.kind === 'OptionalMemberExpression') {
      return t.optionalMemberExpression(object, property, member.computed, member.optional)
    }
    return t.memberExpression(object, property, member.computed, member.optional)
  }

  const lowerWithHookReturnObject = (
    member: Extract<Expression, { kind: 'MemberExpression' }>,
    build: (object: BabelCore.types.Expression) => BabelCore.types.Expression | null,
  ): BabelCore.types.Expression | null => {
    if (member.object.kind === 'Identifier') {
      return build(t.identifier(deSSAVarName(member.object.name)))
    }
    if (
      member.object.kind === 'CallExpression' ||
      member.object.kind === 'OptionalCallExpression'
    ) {
      const hookId = genTemp(ctx, 'hook')
      const body = build(t.identifier(hookId.name))
      if (!body) return null
      return t.callExpression(t.arrowFunctionExpression([t.cloneNode(hookId, true)], body), [
        lowerExpression(member.object, ctx),
      ])
    }
    return null
  }

  const collectHookSignalKeys = (info: HookReturnInfo | null): (string | number)[] => {
    const signalKeys: (string | number)[] = []
    if (info?.objectProps) {
      for (const [key, accessorKind] of info.objectProps.entries()) {
        if (accessorKind === 'signal') signalKeys.push(key)
      }
    }
    if (info?.arrayProps) {
      for (const [key, accessorKind] of info.arrayProps.entries()) {
        if (accessorKind === 'signal') signalKeys.push(key)
      }
    }
    return signalKeys
  }

  const throwHookReturnMemoMemberWrite = (
    member: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  ): never => {
    throw new HIRError(
      'Cannot write to hook-return memo member. Hook-return memo members are read-only accessors.',
      'BUILD_ERROR',
      {
        file: ctx.options?.filename,
        line: member.loc?.start.line,
      },
    )
  }

  const throwHookReturnAccessorMemberDelete = (
    member: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  ): never => {
    throw new HIRError(
      'Cannot delete hook-return accessor member. Hook-return accessor members are compiler-managed accessors.',
      'BUILD_ERROR',
      {
        file: ctx.options?.filename,
        line: member.loc?.start.line,
      },
    )
  }

  const lowerDeleteArgument = (argument: Expression): BabelCore.types.Expression => {
    if (argument.kind === 'MemberExpression' || argument.kind === 'OptionalMemberExpression') {
      const hookMemberInfo = resolveHookReturnMemberInfo(argument, ctx)
      if (hookMemberInfo) {
        const accessorKind = resolveHookReturnMemberAccessorKind(argument, ctx)
        if (isCallableHookAccessorKind(accessorKind)) {
          throwHookReturnAccessorMemberDelete(argument)
        }
        return lowerMemberExpressionWithoutAccessorCall(argument)
      }
      if (isNamespaceReactiveAccessorMember(argument)) {
        return lowerMemberExpressionWithoutAccessorCall(argument)
      }
    }
    return lowerExpression(argument, ctx)
  }

  const lowerHookReturnSignalMemberAssignment = (
    expr: HIRAssignmentExpression,
  ): BabelCore.types.Expression | null => {
    if (expr.left.kind !== 'MemberExpression') return null
    const left = expr.left
    const hookMemberInfo = resolveHookReturnMemberInfo(left, ctx)
    if (!hookMemberInfo) return null

    const accessorKind = resolveHookReturnMemberAccessorKind(left, ctx)
    if (accessorKind === 'signal') {
      return lowerWithHookReturnObject(left, object => {
        const member = lowerMemberExpressionWithoutAccessorCall(left, object)
        const current = t.callExpression(t.cloneNode(member, true), [])
        const right = lowerExpression(expr.right, ctx)
        return lowerTrackedAssignmentWrite(
          member,
          expr.operator as BabelCore.types.AssignmentExpression['operator'],
          current,
          right,
        )
      })
    }
    if (accessorKind === 'memo') {
      throwHookReturnMemoMemberWrite(left)
    }

    if (left.computed) {
      const signalKeys = collectHookSignalKeys(hookMemberInfo.info)
      if (signalKeys.length === 0) return null
      return lowerWithHookReturnObject(left, object =>
        lowerComputedHookSignalAssignmentForObject(
          object,
          left.property as Expression,
          signalKeys,
          expr.operator as BabelCore.types.AssignmentExpression['operator'],
          expr.right,
        ),
      )
    }

    return null
  }

  const lowerHookReturnSignalMemberUpdate = (
    expr: HIRUpdateExpression,
  ): BabelCore.types.Expression | null => {
    if (expr.argument.kind !== 'MemberExpression') return null
    const argument = expr.argument
    const hookMemberInfo = resolveHookReturnMemberInfo(argument, ctx)
    if (!hookMemberInfo) return null

    const accessorKind = resolveHookReturnMemberAccessorKind(argument, ctx)
    if (accessorKind === 'signal') {
      return lowerWithHookReturnObject(argument, object => {
        const member = lowerMemberExpressionWithoutAccessorCall(argument, object)
        return lowerTrackedUpdateCall(member, expr.operator, expr.prefix)
      })
    }
    if (accessorKind === 'memo') {
      throwHookReturnMemoMemberWrite(argument)
    }

    if (argument.computed) {
      const signalKeys = collectHookSignalKeys(hookMemberInfo.info)
      if (signalKeys.length === 0) return null
      return lowerWithHookReturnObject(argument, object =>
        lowerComputedHookSignalUpdateForObject(
          object,
          argument.property as Expression,
          signalKeys,
          expr.operator,
          expr.prefix,
        ),
      )
    }

    return null
  }

  const isNamespaceReactiveAccessorMember = (
    callee: Expression,
  ): callee is Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }> => {
    if (callee.kind !== 'MemberExpression' && callee.kind !== 'OptionalMemberExpression') {
      return false
    }
    if (callee.object.kind !== 'Identifier') return false
    const nsMeta = getImportedNamespaceMetadata(callee.object.name, ctx)
    if (!nsMeta) return false
    const propName = getStaticMemberMetadataKey(callee.property as Expression, callee.computed)
    if (propName === null) return false
    const kind = nsMeta.exports[propName]
    return kind === 'signal' || kind === 'memo'
  }

  const isHookReturnAccessorMember = (
    callee: Expression,
  ): callee is Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }> => {
    if (callee.kind !== 'MemberExpression' && callee.kind !== 'OptionalMemberExpression') {
      return false
    }
    return isCallableHookAccessorKind(resolveHookReturnMemberAccessorKind(callee, ctx))
  }

  const lowerCallCalleeExpression = (callee: Expression): BabelCore.types.Expression => {
    if (isNamespaceReactiveAccessorMember(callee) || isHookReturnAccessorMember(callee)) {
      return lowerMemberExpressionWithoutAccessorCall(callee)
    }
    return lowerExpression(callee, ctx)
  }
  const shouldUnwrapOptionalAccessorMember = (member: HIROptionalMemberExpression): boolean =>
    isNamespaceReactiveAccessorMember(member as Expression) ||
    isHookReturnAccessorMember(member as Expression)

  switch (expr.kind) {
    case 'Identifier':
      // Apply SSA de-versioning to restore original variable names
      return t.identifier(deSSAVarName(expr.name))

    case 'Literal':
      if (expr.value === null) return t.nullLiteral()
      if (expr.value === undefined) return voidZero(t)
      if (typeof expr.value === 'string') return t.stringLiteral(expr.value)
      if (typeof expr.value === 'number') {
        return numericValueExpression(expr.value, t)
      }
      if (typeof expr.value === 'boolean') return t.booleanLiteral(expr.value)
      if (typeof expr.value === 'bigint') return t.bigIntLiteral(expr.value.toString())
      if (expr.value instanceof RegExp) {
        return t.regExpLiteral(expr.value.source, expr.value.flags)
      }
      return voidZero(t)

    case 'ImportExpression':
      return t.importExpression(
        lowerExpression(expr.source, ctx) as BabelCore.types.Expression,
        expr.options ? (lowerExpression(expr.options, ctx) as BabelCore.types.Expression) : null,
      )

    case 'MetaProperty':
      return t.metaProperty(t.identifier(expr.meta.name), t.identifier(expr.property.name))

    case 'CallExpression': {
      // Handle Fict macros in HIR path
      const stateCalleeNameRaw = expr.callee.kind === 'Identifier' ? expr.callee.name : null
      const stateCalleeName = stateCalleeNameRaw ? deSSAVarName(stateCalleeNameRaw) : null
      const isStateMacro =
        expr.macro === 'state' ||
        (!ctx.strictMacroBindings && !!stateCalleeName && ctx.stateMacroNames?.has(stateCalleeName))
      if (isStateMacro) {
        const args = lowerCallArguments(expr.arguments)
        const includeDevtools = ctx.options?.dev !== false
        const options: BabelCore.types.ObjectProperty[] = []
        // Always include name when available - needed for resumable mode slotMap and devtools
        if (ctx.currentAssignmentName) {
          options.push(
            t.objectProperty(t.identifier('name'), t.stringLiteral(ctx.currentAssignmentName)),
          )
        }
        if (includeDevtools && expr.loc) {
          const source = `${ctx.options?.filename ?? ''}:${expr.loc.start.line}:${expr.loc.start.column}`
          options.push(t.objectProperty(t.identifier('devToolsSource'), t.stringLiteral(source)))
        }
        if (options.length > 0) {
          args.push(t.objectExpression(options))
        }

        if (ctx.inModule) {
          ctx.helpersUsed.add('signal')
          return t.callExpression(runtimeIdentifier(ctx, 'signal'), args)
        }
        ctx.helpersUsed.add('useSignal')
        ctx.needsCtx = true
        return t.callExpression(runtimeIdentifier(ctx, 'useSignal'), [
          contextIdentifier(ctx),
          ...args,
        ])
      }
      if (expr.callee.kind === 'Identifier') {
        const memoCalleeName = deSSAVarName(expr.callee.name)
        const isMemoMacro =
          expr.macro === 'memo' ||
          (!ctx.strictMacroBindings && ctx.memoMacroNames?.has(memoCalleeName))
        if (isMemoMacro) {
          const args = lowerCallArguments(expr.arguments)
          const includeDevtools = ctx.options?.dev !== false
          if (includeDevtools && expr.arguments.length === 1) {
            const options: BabelCore.types.ObjectProperty[] = []
            if (ctx.currentAssignmentName) {
              options.push(
                t.objectProperty(t.identifier('name'), t.stringLiteral(ctx.currentAssignmentName)),
              )
            }
            if (expr.loc) {
              const source = `${ctx.options?.filename ?? ''}:${expr.loc.start.line}:${expr.loc.start.column}`
              options.push(
                t.objectProperty(t.identifier('devToolsSource'), t.stringLiteral(source)),
              )
            }
            if (options.length > 0) {
              args.push(t.objectExpression(options))
            }
          }
          return t.callExpression(
            lowerExpression(expr.callee, ctx) as BabelCore.types.Expression,
            args,
          )
        }
      }
      const effectCalleeName =
        expr.callee.kind === 'Identifier' ? deSSAVarName(expr.callee.name) : null
      const isEffectMacro =
        expr.macro === 'effect' || (!ctx.strictMacroBindings && effectCalleeName === '$effect')
      if (isEffectMacro) {
        const args = lowerCallArguments(expr.arguments, arg =>
          arg.kind === 'ArrowFunction' || arg.kind === 'FunctionExpression'
            ? withNonReactiveScope(ctx, () => lowerExpression(arg, ctx))
            : lowerExpression(arg, ctx),
        )
        const includeDevtools = ctx.options?.dev !== false
        if (includeDevtools && expr.loc) {
          const source = `${ctx.options?.filename ?? ''}:${expr.loc.start.line}:${expr.loc.start.column}`
          const sourceProp = t.objectProperty(
            t.identifier('devToolsSource'),
            t.stringLiteral(source),
          )

          if (args.length === 1) {
            args.push(t.objectExpression([sourceProp]))
          } else if (args.length > 1 && t.isObjectExpression(args[1])) {
            const hasSourceProp = args[1].properties.some(
              prop =>
                t.isObjectProperty(prop) &&
                t.isIdentifier(prop.key) &&
                prop.key.name === 'devToolsSource',
            )
            if (!hasSourceProp) {
              args[1].properties.push(sourceProp)
            }
          }
        }
        if (ctx.inModule) {
          ctx.helpersUsed.add('effect')
          return t.callExpression(runtimeIdentifier(ctx, 'effect'), args)
        }
        ctx.helpersUsed.add('useEffect')
        ctx.needsCtx = true
        return t.callExpression(runtimeIdentifier(ctx, 'useEffect'), [
          contextIdentifier(ctx),
          ...args,
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '__fictObjectRest') {
        const sourceArg = expr.arguments[0]
        const isComponentPropsRest =
          ctx.isComponentFn === true &&
          ctx.propsParamName !== undefined &&
          sourceArg?.kind === 'Identifier' &&
          deSSAVarName(sourceArg.name) === ctx.propsParamName
        const args = lowerCallArguments(expr.arguments)
        if (isComponentPropsRest) {
          ctx.helpersUsed.add('propsRest')
          return t.callExpression(runtimeIdentifier(ctx, 'propsRest'), args)
        }
        ctx.helpersUsed.add('objectRest')
        return t.callExpression(runtimeIdentifier(ctx, 'objectRest'), args)
      }
      const isIIFE =
        (expr.callee.kind === 'ArrowFunction' || expr.callee.kind === 'FunctionExpression') &&
        expr.arguments.length === 0 &&
        expr.callee.params.length === 0
      const calleeName = expr.callee.kind === 'Identifier' ? deSSAVarName(expr.callee.name) : null
      const calleeIsFunctionVar = !!calleeName && (ctx.functionVars?.has(calleeName) ?? false)
      const calleeIsPropAccessor =
        !!calleeName &&
        !calleeIsFunctionVar &&
        (ctx.resumablePropAccessors?.has(calleeName) ?? false)
      const calleeIsMemoAccessor =
        !!calleeName && !calleeIsFunctionVar && ctx.memoVars?.has(calleeName)
      const calleeIsSignalLike =
        !!calleeName && (ctx.signalVars?.has(calleeName) || ctx.storeVars?.has(calleeName))
      const calleeIsCallableSignal =
        !!calleeName &&
        (ctx.signalVars?.has(calleeName) ?? false) &&
        (ctx.callableSignalVars?.has(calleeName) ?? false)
      if (calleeIsCallableSignal) {
        return withCallCacheBarrier(
          t.callExpression(
            t.callExpression(t.identifier(calleeName), []),
            lowerCallArguments(expr.arguments),
          ),
        )
      }
      if (calleeIsPropAccessor) {
        const propValue = t.callExpression(t.identifier(calleeName), [])
        const loweredArgs = lowerCallArguments(expr.arguments)
        return withCallCacheBarrier(t.callExpression(propValue, loweredArgs))
      }
      if (calleeIsMemoAccessor && !calleeIsSignalLike && expr.arguments.length > 0) {
        const loweredArgs = lowerCallArguments(expr.arguments)
        return withCallCacheBarrier(
          t.callExpression(t.callExpression(t.identifier(calleeName), []), loweredArgs),
        )
      }
      const lowerCallee = () =>
        isIIFE
          ? withNonReactiveScope(ctx, () => lowerExpression(expr.callee, ctx))
          : lowerCallCalleeExpression(expr.callee)
      const isIteratingMethod =
        expr.callee.kind === 'MemberExpression' &&
        ((expr.callee.property.kind === 'Identifier' &&
          ['map', 'reduce', 'forEach', 'filter', 'flatMap', 'some', 'every', 'find'].includes(
            expr.callee.property.name,
          )) ||
          (expr.callee.property.kind === 'Literal' &&
            ['map', 'reduce', 'forEach', 'filter', 'flatMap', 'some', 'every', 'find'].includes(
              String(expr.callee.property.value),
            )))
      const loweredArgs = lowerCallArguments(expr.arguments, (a, idx) => {
        if (idx === 0) {
          const componentArg = lowerComponentWrapperFunctionArgument(a, ctx)
          if (componentArg) return componentArg
        }
        if (
          idx === 0 &&
          isIteratingMethod &&
          (a.kind === 'ArrowFunction' || a.kind === 'FunctionExpression')
        ) {
          return withNoMemoAndDynamicHooks(ctx, () => lowerExpression(a, ctx))
        }
        return lowerExpression(a, ctx)
      })
      return withCallCacheBarrier(t.callExpression(lowerCallee(), loweredArgs))
    }

    case 'MemberExpression':
      // Key constification: replace row().id with __key when it matches the key expression
      if (!ctx.listKeyConstificationDisabled && matchesListKeyPattern(expr, ctx)) {
        return t.identifier(ctx.listKeyParamName!)
      }
      if (expr.object.kind === 'Identifier') {
        const nsMeta = getImportedNamespaceMetadata(expr.object.name, ctx)
        if (nsMeta) {
          const propName = getStaticMemberMetadataKey(expr.property as Expression, expr.computed)
          if (propName !== null) {
            const kind = nsMeta.exports[propName]
            if (kind === 'signal' || kind === 'memo') {
              const member = t.memberExpression(
                t.identifier(deSSAVarName(expr.object.name)),
                expr.computed ? t.stringLiteral(propName) : t.identifier(propName),
                expr.computed,
                expr.optional,
              )
              if (ctx.preserveHookReturnAccessors) {
                return member
              }
              return t.callExpression(member, [])
            }
          }
        }
      }
      if (
        expr.object.kind === 'Identifier' ||
        expr.object.kind === 'CallExpression' ||
        expr.object.kind === 'OptionalCallExpression'
      ) {
        const accessorKind = resolveHookReturnMemberAccessorKind(expr, ctx)
        if (isCallableHookAccessorKind(accessorKind)) {
          return t.callExpression(lowerMemberExpressionWithoutAccessorCall(expr), [])
        }
      }
      return t.memberExpression(
        lowerExpression(expr.object, ctx),
        expr.computed
          ? lowerExpression(expr.property, ctx)
          : expr.property.kind === 'Identifier'
            ? t.identifier(expr.property.name) // Property names are NOT SSA-versioned
            : t.stringLiteral(
                String(expr.property.kind === 'Literal' ? (expr.property.value ?? '') : ''),
              ),
        expr.computed,
        expr.optional,
      )

    case 'BinaryExpression':
      return t.binaryExpression(
        expr.operator as BabelCore.types.BinaryExpression['operator'],
        lowerExpression(expr.left, ctx),
        lowerExpression(expr.right, ctx),
      )

    case 'UnaryExpression':
      return t.unaryExpression(
        expr.operator as BabelCore.types.UnaryExpression['operator'],
        expr.operator === 'delete'
          ? lowerDeleteArgument(expr.argument)
          : lowerExpression(expr.argument, ctx),
        expr.prefix,
      )

    case 'LogicalExpression':
      return t.logicalExpression(
        expr.operator as BabelCore.types.LogicalExpression['operator'],
        lowerExpressionComponentCandidate(expr.left, ctx),
        lowerExpressionComponentCandidate(expr.right, ctx),
      )

    case 'ConditionalExpression':
      return t.conditionalExpression(
        lowerExpression(expr.test, ctx),
        lowerExpressionComponentCandidate(expr.consequent, ctx),
        lowerExpressionComponentCandidate(expr.alternate, ctx),
      )

    case 'ArrayExpression':
      return t.arrayExpression(
        expr.elements.map(el =>
          !el
            ? null
            : el.kind === 'SpreadElement'
              ? t.spreadElement(lowerExpression(el.argument, ctx))
              : lowerExpressionComponentCandidate(el, ctx),
        ),
      )

    case 'ObjectExpression':
      return t.objectExpression(
        expr.properties.map(p => {
          if (p.kind === 'SpreadElement') {
            return t.spreadElement(lowerExpression(p.argument, ctx))
          }
          const segment = getStaticObjectPropertySegment(p)
          const propertyPath =
            ctx.objectLiteralPath && segment ? [...ctx.objectLiteralPath, segment] : undefined
          const lowerObjectPropertyValue = (): BabelCore.types.Expression => {
            const loweredComponentValue = lowerJSXMemberComponentFunctionValue(
              p.value,
              propertyPath,
              ctx,
            )
            if (loweredComponentValue) return loweredComponentValue
            const loweredComponentExpressionValue = lowerComponentExpressionFunctionValue(
              p.value,
              ctx,
            )
            if (loweredComponentExpressionValue) return loweredComponentExpressionValue
            return withObjectLiteralPath(
              ctx,
              p.value.kind === 'ObjectExpression' ? propertyPath : undefined,
              () => lowerExpression(p.value, ctx),
            )
          }
          const keyIsIdentifier = !p.computed && p.key.kind === 'Identifier'
          const keyIdent = keyIsIdentifier && p.key.kind === 'Identifier' ? p.key.name : ''
          const keyNode = p.computed
            ? lowerExpression(p.key, ctx)
            : keyIsIdentifier
              ? t.identifier(keyIdent)
              : lowerExpression(p.key, ctx)

          if (p.propertyKind && p.propertyKind !== 'init') {
            const valueExpr = lowerObjectPropertyValue()
            if (!t.isFunctionExpression(valueExpr)) {
              throw new HIRError(
                `Object method property did not lower to function expression.`,
                'CODEGEN_ERROR',
              )
            }
            const method = t.objectMethod(
              p.propertyKind === 'method' ? 'method' : p.propertyKind,
              keyNode as BabelCore.types.Expression,
              valueExpr.params as BabelCore.types.FunctionParameter[],
              valueExpr.body,
              !!p.computed,
            )
            method.async = valueExpr.async
            method.generator = valueExpr.generator
            return method
          }
          // For shorthand properties, ensure key matches the de-versioned value name
          const usesTracked =
            !!ctx.inPropsContext &&
            (!ctx.nonReactiveScopeDepth || ctx.nonReactiveScopeDepth === 0) &&
            p.value.kind !== 'ArrowFunction' &&
            p.value.kind !== 'FunctionExpression' &&
            expressionUsesTracked(p.value, ctx)
          const valueExprRaw = usesTracked
            ? (lowerTrackedExpression(p.value as Expression, ctx) as BabelCore.types.Expression)
            : lowerObjectPropertyValue()
          const shouldMemoProp =
            usesTracked &&
            !t.isIdentifier(valueExprRaw) &&
            !t.isMemberExpression(valueExprRaw) &&
            !t.isLiteral(valueExprRaw)
          const valueExpr =
            usesTracked && ctx.t.isExpression(valueExprRaw)
              ? (() => {
                  if (shouldMemoProp) {
                    ctx.helpersUsed.add('prop')
                    return t.callExpression(runtimeIdentifier(ctx, 'prop'), [
                      t.arrowFunctionExpression([], valueExprRaw),
                    ])
                  }
                  ctx.helpersUsed.add('propGetter')
                  return t.callExpression(runtimeIdentifier(ctx, 'propGetter'), [
                    t.arrowFunctionExpression([], valueExprRaw),
                  ])
                })()
              : valueExprRaw
          // If shorthand and value is identifier, use de-versioned name for key too
          const useShorthand =
            p.shorthand &&
            t.isIdentifier(valueExpr) &&
            keyIsIdentifier &&
            deSSAVarName(keyIdent) === valueExpr.name
          const forceComputedProtoKey =
            p.shorthand &&
            !useShorthand &&
            keyIsIdentifier &&
            deSSAVarName(keyIdent) === '__proto__'

          return t.objectProperty(
            forceComputedProtoKey
              ? t.stringLiteral('__proto__')
              : useShorthand
                ? t.identifier(valueExpr.name)
                : keyNode,
            valueExpr,
            forceComputedProtoKey ? true : !!p.computed,
            forceComputedProtoKey ? false : useShorthand,
          )
        }),
      )

    case 'JSXElement':
      return lowerJSXElement(expr, ctx)

    case 'ArrowFunction': {
      const componentLowered = lowerComponentExpressionFunctionValue(expr, ctx)
      if (componentLowered) return componentLowered
      const reactiveLowered = lowerReactiveScopeExpression(expr)
      if (reactiveLowered) return reactiveLowered
      const paramIds = buildFunctionParams(expr.params, expr.rawParams, ctx)
      const shadowed = new Set(expr.params.map(p => deSSAVarName(p.name)))
      const localDeclared = collectLocalDeclaredNames(
        expr.params,
        Array.isArray(expr.body) ? (expr.body as BasicBlock[]) : null,
        t,
      )
      // Arrow functions are always reactivity boundaries - prevent statements inside
      // from being wrapped in $effect/__fictUseEffect (like FunctionExpression)
      return withNonReactiveScope(ctx, () =>
        withFunctionScope(
          shadowed,
          () =>
            withListKeyConstificationScope(shadowed, localDeclared, () => {
              const prevNoMemo = ctx.noMemo
              const prevHookFlag = ctx.currentFnIsHook
              const prevIsComponent = ctx.isComponentFn
              ctx.noMemo = !!(prevNoMemo || expr.noMemo)
              ctx.currentFnIsHook = false
              ctx.isComponentFn = false
              let fn: BabelCore.types.ArrowFunctionExpression

              try {
                if (expr.isExpression && !Array.isArray(expr.body)) {
                  // Rule L: Enable getter caching for sync arrow functions with expression body
                  const disabledGetters = expressionHasCallBarrier(expr.body as Expression)
                    ? collectCacheableGetterNames()
                    : undefined
                  const { result: bodyExpr, cacheDeclarations } = withOptionalGetterCache(
                    !(expr.isAsync ?? false),
                    () => lowerTrackedExpression(expr.body as Expression, ctx),
                    disabledGetters,
                  )
                  if (cacheDeclarations.length > 0) {
                    // Need to convert to block body to include cache declarations
                    fn = t.arrowFunctionExpression(
                      paramIds,
                      t.blockStatement([...cacheDeclarations, t.returnStatement(bodyExpr)]),
                    )
                  } else {
                    fn = t.arrowFunctionExpression(paramIds, bodyExpr)
                  }
                } else if (Array.isArray(expr.body)) {
                  // Rule L: Enable getter caching for sync arrow functions with block body
                  const bodyBlocks = expr.body as BasicBlock[]
                  const disabledGetters = collectDisabledGetterNames(bodyBlocks)
                  const { result: stmts, cacheDeclarations } = withOptionalGetterCache(
                    !(expr.isAsync ?? false),
                    () => lowerStructuredBlocks(bodyBlocks, expr.params, paramIds),
                    disabledGetters,
                  )
                  fn = t.arrowFunctionExpression(
                    paramIds,
                    t.blockStatement([...cacheDeclarations, ...stmts]),
                  )
                } else {
                  fn = t.arrowFunctionExpression(paramIds, t.blockStatement([]))
                }
                fn.async = expr.isAsync ?? false
                return fn
              } finally {
                ctx.noMemo = prevNoMemo
                ctx.currentFnIsHook = prevHookFlag
                ctx.isComponentFn = prevIsComponent
              }
            }),
          localDeclared,
        ),
      )
    }

    case 'FunctionExpression': {
      const componentLowered = lowerComponentExpressionFunctionValue(expr, ctx)
      if (componentLowered) return componentLowered
      const reactiveLowered = lowerReactiveScopeExpression(expr)
      if (reactiveLowered) return reactiveLowered
      const paramIds = buildFunctionParams(expr.params, expr.rawParams, ctx)
      const shadowed = new Set(expr.params.map(p => deSSAVarName(p.name)))
      if (expr.name) {
        shadowed.add(deSSAVarName(expr.name))
      }
      const localDeclared = collectLocalDeclaredNames(expr.params, expr.body as BasicBlock[], t)
      return withNonReactiveScope(ctx, () =>
        withFunctionScope(
          shadowed,
          () =>
            withListKeyConstificationScope(shadowed, localDeclared, () => {
              const prevNoMemo = ctx.noMemo
              const prevHookFlag = ctx.currentFnIsHook
              const prevIsComponent = ctx.isComponentFn
              ctx.noMemo = !!(prevNoMemo || expr.noMemo)
              ctx.currentFnIsHook = expr.name ? isHookName(deSSAVarName(expr.name)) : false
              ctx.isComponentFn = false
              let fn: BabelCore.types.FunctionExpression
              try {
                if (Array.isArray(expr.body)) {
                  // Rule L: Enable getter caching for sync function expressions
                  const bodyBlocks = expr.body as BasicBlock[]
                  const disabledGetters = collectDisabledGetterNames(bodyBlocks)
                  const hasYieldBoundary =
                    (expr.isGenerator ?? false) ||
                    functionHasYield({ params: expr.params, blocks: bodyBlocks })
                  const { result: stmts, cacheDeclarations } = withOptionalGetterCache(
                    !(expr.isAsync ?? false) && !hasYieldBoundary,
                    () => lowerStructuredBlocks(bodyBlocks, expr.params, paramIds),
                    disabledGetters,
                  )
                  fn = t.functionExpression(
                    expr.name ? t.identifier(deSSAVarName(expr.name)) : null,
                    paramIds,
                    t.blockStatement([...cacheDeclarations, ...stmts]),
                  )
                } else {
                  fn = t.functionExpression(
                    expr.name ? t.identifier(deSSAVarName(expr.name)) : null,
                    paramIds,
                    t.blockStatement([]),
                  )
                }
                fn.async = expr.isAsync ?? false
                fn.generator = expr.isGenerator ?? false
                return fn
              } finally {
                ctx.noMemo = prevNoMemo
                ctx.currentFnIsHook = prevHookFlag
                ctx.isComponentFn = prevIsComponent
              }
            }),
          localDeclared,
        ),
      )
    }

    case 'AssignmentExpression':
      propagateHookFunctionMemberAssignment(expr, ctx)
      {
        const hookMemberAssignment = lowerHookReturnSignalMemberAssignment(expr)
        if (hookMemberAssignment) return hookMemberAssignment
      }
      if (expr.left.kind === 'Identifier') {
        const baseName = deSSAVarName(expr.left.name)
        if (ctx.trackedVars.has(baseName) && !(ctx.localValueVars?.has(baseName) ?? false)) {
          assertWritableImportedReactiveIdentifier(baseName, ctx, expr.loc)
          markCallableSignalAssignmentValue(expr, ctx)
          const callee = t.identifier(baseName)
          const current = t.callExpression(t.identifier(baseName), [])
          const right = lowerExpression(expr.right, ctx)
          return lowerTrackedAssignmentWrite(
            callee,
            expr.operator as BabelCore.types.AssignmentExpression['operator'],
            current,
            right,
          )
        }
      }

      if (expr.left.kind === 'MemberExpression' || expr.left.kind === 'OptionalMemberExpression') {
        assertWritableImportedNamespaceMember(expr.left, ctx)
        const assignedComponentValue =
          expr.operator === '='
            ? lowerJSXMemberComponentFunctionValue(
                expr.right,
                getStaticMemberPath(expr.left) ?? undefined,
                ctx,
              )
            : null
        return t.assignmentExpression(
          expr.operator as BabelCore.types.AssignmentExpression['operator'],
          lowerMemberExpressionForAssignmentTarget(expr.left, ctx) as BabelCore.types.LVal,
          assignedComponentValue ?? lowerExpression(expr.right, ctx),
        )
      }

      return t.assignmentExpression(
        expr.operator as BabelCore.types.AssignmentExpression['operator'],
        lowerExpression(expr.left, ctx) as BabelCore.types.LVal,
        lowerExpression(expr.right, ctx),
      )

    case 'UpdateExpression':
      {
        const hookMemberUpdate = lowerHookReturnSignalMemberUpdate(expr)
        if (hookMemberUpdate) return hookMemberUpdate
      }
      if (expr.argument.kind === 'Identifier') {
        const baseName = deSSAVarName(expr.argument.name)
        if (ctx.trackedVars.has(baseName) && !(ctx.localValueVars?.has(baseName) ?? false)) {
          assertWritableImportedReactiveIdentifier(baseName, ctx, expr.loc)
          return lowerTrackedUpdateCall(t.identifier(baseName), expr.operator, expr.prefix)
        }
      }

      if (
        expr.argument.kind === 'MemberExpression' ||
        expr.argument.kind === 'OptionalMemberExpression'
      ) {
        assertWritableImportedNamespaceMember(expr.argument, ctx)
        return t.updateExpression(
          expr.operator,
          lowerMemberExpressionForAssignmentTarget(expr.argument, ctx),
          expr.prefix,
        )
      }

      return t.updateExpression(
        expr.operator,
        lowerExpression(expr.argument, ctx) as BabelCore.types.Expression,
        expr.prefix,
      )

    case 'TemplateLiteral':
      return t.templateLiteral(
        expr.quasis.map((q, i) => lowerTemplateElement(q, i === expr.quasis.length - 1, t)),
        expr.expressions.map(e => lowerExpression(e, ctx)),
      )

    case 'SpreadElement':
      // SpreadElement is handled specially in ObjectExpression/ArrayExpression
      // When encountered as a standalone expression, lower its argument
      return lowerExpression(expr.argument, ctx)

    case 'AwaitExpression':
      return t.awaitExpression(lowerExpression(expr.argument, ctx))

    case 'NewExpression':
      return withCallCacheBarrier(
        t.newExpression(lowerExpression(expr.callee, ctx), lowerCallArguments(expr.arguments)),
      )

    case 'SequenceExpression':
      return t.sequenceExpression(
        expr.expressions.map((e, index) => {
          const isLast = index === expr.expressions.length - 1
          if (isLast) return lowerExpressionComponentCandidate(e, ctx, valueUsed)
          return lowerExpression(e, ctx, false)
        }),
      )

    case 'YieldExpression':
      return t.yieldExpression(
        expr.argument ? lowerExpression(expr.argument, ctx) : null,
        expr.delegate,
      )

    case 'OptionalCallExpression':
      if (expr.callee.kind === 'Identifier') {
        const calleeName = deSSAVarName(expr.callee.name)
        const calleeIsFunctionVar = ctx.functionVars?.has(calleeName) ?? false
        const calleeIsPropAccessor =
          !calleeIsFunctionVar && (ctx.resumablePropAccessors?.has(calleeName) ?? false)
        const calleeIsCallableSignal =
          (ctx.signalVars?.has(calleeName) ?? false) &&
          (ctx.callableSignalVars?.has(calleeName) ?? false)
        const calleeIsMemoAccessor =
          !calleeIsFunctionVar &&
          (ctx.memoVars?.has(calleeName) ?? false) &&
          !(ctx.signalVars?.has(calleeName) ?? false) &&
          !(ctx.storeVars?.has(calleeName) ?? false)
        if (calleeIsPropAccessor) {
          return withCallCacheBarrier(
            t.optionalCallExpression(
              t.callExpression(t.identifier(calleeName), []),
              lowerCallArguments(expr.arguments),
              expr.optional,
            ),
          )
        }
        if (calleeIsCallableSignal) {
          return withCallCacheBarrier(
            t.optionalCallExpression(
              t.callExpression(t.identifier(calleeName), []),
              lowerCallArguments(expr.arguments),
              expr.optional,
            ),
          )
        }
        if (calleeIsMemoAccessor) {
          return withCallCacheBarrier(
            t.optionalCallExpression(
              t.callExpression(t.identifier(calleeName), []),
              lowerCallArguments(expr.arguments),
              expr.optional,
            ),
          )
        }
      }
      return withCallCacheBarrier(
        t.optionalCallExpression(
          lowerCallCalleeExpression(expr.callee),
          lowerCallArguments(expr.arguments),
          expr.optional,
        ),
      )

    case 'TaggedTemplateExpression':
      return t.taggedTemplateExpression(
        lowerExpression(expr.tag, ctx),
        t.templateLiteral(
          expr.quasi.quasis.map((q, i) =>
            lowerTemplateElement(q, i === expr.quasi.quasis.length - 1, t),
          ),
          expr.quasi.expressions.map(e => lowerExpression(e, ctx)),
        ),
      )

    case 'ClassExpression': {
      // Class bodies are stored as Babel AST, so patch tracked writes before read overrides run.
      const prevShadowed = ctx.shadowedNames
      if (expr.name) {
        const classShadowed = new Set(prevShadowed ?? [])
        classShadowed.add(deSSAVarName(expr.name))
        ctx.shadowedNames = classShadowed
      }
      try {
        return t.classExpression(
          expr.name ? t.identifier(expr.name) : null,
          expr.superClass ? lowerExpression(expr.superClass, ctx) : null,
          t.classBody(
            (expr.body ?? []).map(member =>
              lowerRawClassReactiveWrites(
                lowerRawJSXInBabelNode(t.cloneNode(member, true) as BabelClassMember, ctx),
              ),
            ),
          ),
          expr.decorators?.map(decorator => t.cloneNode(decorator, true)) ?? null,
        )
      } finally {
        ctx.shadowedNames = prevShadowed
      }
    }

    case 'ThisExpression':
      return t.thisExpression()

    case 'SuperExpression':
      return t.super()

    case 'OptionalMemberExpression': {
      const optionalMember = expr as HIROptionalMemberExpression
      if (shouldUnwrapOptionalAccessorMember(optionalMember)) {
        return t.optionalCallExpression(
          lowerMemberExpressionWithoutAccessorCall(optionalMember),
          [],
          true,
        )
      }
      return t.optionalMemberExpression(
        lowerExpression(optionalMember.object, ctx),
        optionalMember.computed
          ? lowerExpression(optionalMember.property, ctx)
          : optionalMember.property.kind === 'Identifier'
            ? t.identifier(optionalMember.property.name)
            : t.stringLiteral(
                String(
                  optionalMember.property.kind === 'Literal'
                    ? (optionalMember.property.value ?? '')
                    : '',
                ),
              ),
        optionalMember.computed,
        optionalMember.optional,
      )
    }

    default:
      return voidZero(t)
  }
}

/**
 * Lower an expression intended for DOM bindings, applying RegionMetadata overrides.
 */
function lowerDomExpression(
  expr: Expression,
  ctx: CodegenContext,
  region?: RegionInfo | null,
  options?: {
    skipHookAccessors?: boolean | undefined
    skipRegionRootOverride?: boolean | undefined
  },
): BabelCore.types.Expression {
  let lowered = lowerExpression(expr, ctx)
  const skipHookAccessors = options?.skipHookAccessors ?? false
  if (
    !skipHookAccessors &&
    (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') &&
    isCallableHookAccessorKind(resolveHookReturnMemberAccessorKind(expr, ctx)) &&
    ctx.t.isMemberExpression(lowered) &&
    ctx.t.isIdentifier(lowered.object)
  ) {
    lowered = ctx.t.callExpression(lowered, [])
  } else if (!skipHookAccessors && ctx.t.isIdentifier(lowered)) {
    const hookName = getHookResultNameForLocal(lowered.name, ctx)
    if (hookName) {
      const info = getHookReturnInfo(hookName, ctx)
      if (isCallableHookAccessorKind(info?.directAccessor)) {
        lowered = ctx.t.callExpression(ctx.t.identifier(deSSAVarName(lowered.name)), [])
      }
    }
  }
  return applyRegionMetadataToExpression(lowered, ctx, region, {
    skipRootOverride: options?.skipRegionRootOverride,
  })
}

function lowerJSXChildNonFineGrained(
  child: JSXChild,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  if (child.kind === 'text') {
    return t.stringLiteral(child.value)
  }
  if (child.kind === 'element') {
    return lowerJSXElement(child.value, ctx)
  }
  const expr = child.value
  const lowered = lowerDomExpression(expr, ctx)
  if (isExpressionReactive(expr, ctx)) {
    return markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], lowered))
  }
  return lowered
}

function lowerIntrinsicElementAsVNode(
  jsx: JSXElementExpression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  const props: (BabelCore.types.ObjectProperty | BabelCore.types.SpreadElement)[] = []
  let keyExpr: BabelCore.types.Expression | null = null
  const toPropKey = (name: string) =>
    /^[a-zA-Z_$][\w$]*$/.test(name) ? t.identifier(name) : t.stringLiteral(name)
  const toPropObjectProperty = (name: string, value: BabelCore.types.Expression) =>
    name === '__proto__'
      ? t.objectProperty(t.stringLiteral(name), value, true)
      : t.objectProperty(toPropKey(name), value)

  for (const attr of jsx.attributes) {
    if (attr.isSpread && attr.spreadExpr) {
      props.push(t.spreadElement(lowerDomExpression(attr.spreadExpr, ctx)))
      continue
    }

    const name = attr.name
    if (name === 'key') {
      keyExpr = attr.value ? lowerDomExpression(attr.value, ctx) : t.booleanLiteral(true)
      continue
    }

    const isEvent = name.startsWith('on') && name.length > 2 && name[2] === name[2]?.toUpperCase()
    const prevWrapTracked = ctx.wrapTrackedExpressions
    if (isEvent) {
      ctx.wrapTrackedExpressions = false
    }
    const rawExpr = attr.value ? lowerDomExpression(attr.value, ctx) : t.booleanLiteral(true)
    ctx.wrapTrackedExpressions = prevWrapTracked
    let valueExpr = rawExpr

    if (attr.value) {
      if (isEvent) {
        if (
          !(t.isArrowFunctionExpression(rawExpr) || t.isFunctionExpression(rawExpr)) &&
          eventHandlerExpressionNeedsReactiveGetter(attr.value, ctx)
        ) {
          valueExpr = markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], rawExpr))
        }
      } else if (isExpressionReactive(attr.value, ctx)) {
        valueExpr = markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], rawExpr))
      }
    }

    props.push(toPropObjectProperty(name, valueExpr))
  }

  const children = jsx.children.map(child => lowerJSXChildNonFineGrained(child, ctx))
  if (children.length === 1 && children[0]) {
    props.push(t.objectProperty(t.identifier('children'), children[0]))
  } else if (children.length > 1) {
    props.push(t.objectProperty(t.identifier('children'), t.arrayExpression(children)))
  }

  const propsExpr = props.length > 0 ? t.objectExpression(props) : t.nullLiteral()

  const vnodeProps: (BabelCore.types.ObjectProperty | BabelCore.types.SpreadElement)[] = [
    t.objectProperty(t.identifier('type'), t.stringLiteral(String(jsx.tagName))),
    t.objectProperty(t.identifier('props'), propsExpr),
  ]
  if (keyExpr) {
    vnodeProps.push(t.objectProperty(t.identifier('key'), keyExpr))
  }
  return t.objectExpression(vnodeProps)
}

/**
 * Lower a JSX Element expression to fine-grained DOM operations
 */
function lowerJSXElement(
  jsx: JSXElementExpression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx

  if (jsx.isComponent) {
    // Only source fragment syntax (`<>`) uses the built-in Fragment path.
    const isFragment = jsx.isFragmentSyntax === true

    if (isFragment) {
      // Fragment - create VNode directly for runtime to handle
      ctx.helpersUsed.add('createElement')
      ctx.helpersUsed.add('fragment')
      const children = jsx.children.map(c => lowerJSXChild(c, ctx))

      // Create VNode: { type: Fragment, props: { children: [...] } }
      const childrenProp =
        children.length === 1
          ? children[0]
          : children.length > 1
            ? t.arrayExpression(children)
            : t.nullLiteral()

      return t.callExpression(t.identifier('createElement'), [
        t.objectExpression([
          t.objectProperty(t.identifier('type'), runtimeIdentifier(ctx, 'fragment')),
          t.objectProperty(
            t.identifier('props'),
            children.length > 0 && childrenProp
              ? t.objectExpression([t.objectProperty(t.identifier('children'), childrenProp)])
              : t.nullLiteral(),
          ),
        ]),
      ])
    }

    // Component - create VNode {type, props} for runtime createElement
    assertSupportedJSXComponentTag(jsx, ctx)
    ctx.helpersUsed.add('createElement')
    const children = jsx.children.map(c => ({
      value: lowerJSXChild(c, ctx),
      ...(c.kind === 'expression' ? { source: c.value } : null),
    }))
    let keyExpr: BabelCore.types.Expression | null = null
    const propsAttributes = jsx.attributes.filter(attr => {
      if (!attr.isSpread && attr.name === 'key') {
        keyExpr = attr.value ? lowerDomExpression(attr.value, ctx) : t.booleanLiteral(true)
        return false
      }
      return true
    })
    const propsExpr = buildPropsExpression(propsAttributes, children, ctx, {
      lowerDomExpression,
      lowerTrackedExpression,
      expressionUsesTracked,
      deSSAVarName,
    })

    const componentRef =
      typeof jsx.tagName === 'string'
        ? t.identifier(jsx.tagName)
        : lowerExpression(jsx.tagName, ctx)

    // Create VNode: { type: Component, props: {...} }
    // Return VNode object directly - runtime render()/insert() will call createElement on it
    const vnodeProps: (BabelCore.types.ObjectProperty | BabelCore.types.SpreadElement)[] = [
      t.objectProperty(t.identifier('type'), componentRef),
      t.objectProperty(t.identifier('props'), propsExpr ?? t.nullLiteral()),
    ]
    if (keyExpr) {
      vnodeProps.push(t.objectProperty(t.identifier('key'), keyExpr))
    }
    return t.objectExpression(vnodeProps)
  }

  const useFineGrainedDom = (ctx.options?.fineGrainedDom ?? true) && !ctx.noMemo
  if (!useFineGrainedDom) {
    return lowerIntrinsicElementAsVNode(jsx, ctx)
  }

  // Intrinsic element - use fine-grained DOM
  return lowerIntrinsicElement(jsx, ctx)
}

/**
 * Apply RegionMetadata dependency overrides to a lowered expression.
 * This mirrors fine-grained-dom's applyRegionMetadata, but guards against
 * double-invoking callees by skipping overrides on call targets.
 */
export function applyRegionMetadataToExpression(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
  regionOverride?: RegionInfo | null,
  options?: { skipRootOverride?: boolean | undefined },
): BabelCore.types.Expression {
  if (ctx.inReturn && ctx.currentFnIsHook) {
    return expr
  }
  const region = regionOverride ?? ctx.currentRegion
  if (!region) return expr
  const skipRootOverride = options?.skipRootOverride ?? false

  const metadata = regionInfoToMetadata(region)
  const state: { identifierOverrides?: RegionOverrideMap | undefined } = {}

  applyRegionMetadata(state, {
    region: metadata,
    dependencyGetter: name => buildDependencyGetter(name, ctx),
  })

  const overrides = state.identifierOverrides ?? (Object.create(null) as RegionOverrideMap)
  state.identifierOverrides = overrides
  const hasOverride = (key: string): boolean => Object.prototype.hasOwnProperty.call(overrides, key)

  const shadowed = ctx.shadowedNames
  const _isReactiveAccessor = (name: string): boolean =>
    ctx.trackedVars.has(name) ||
    !!(ctx.signalVars?.has(name) || ctx.memoVars?.has(name) || ctx.aliasVars?.has(name))
  const isNonReactiveFunction = (name: string): boolean =>
    (ctx.functionVars?.has(name) ?? false) && !(ctx.resumablePropAccessors?.has(name) ?? false)

  if (shadowed && Object.keys(overrides).length > 0) {
    for (const key of Object.keys(overrides)) {
      const base = normalizeDependencyKey(key).split('.')[0] ?? key
      if (shadowed.has(base)) {
        delete overrides[key]
      }
    }
  }

  if (Object.keys(overrides).length > 0) {
    for (const key of Object.keys(overrides)) {
      const base = normalizeDependencyKey(key).split('.')[0] ?? key
      if (isNonReactiveFunction(base)) {
        delete overrides[key]
      }
    }
  }

  if (ctx.inReturn && ctx.currentFnIsHook) {
    for (const key of Object.keys(overrides)) {
      const base = normalizeDependencyKey(key).split('.')[0] ?? key
      if (ctx.trackedVars.has(base) || ctx.memoVars?.has(base) || ctx.signalVars?.has(base)) {
        delete overrides[key]
      }
    }
  }

  // Ensure tracked variables are also covered even if region metadata missed them
  const trackedNames = new Set(ctx.trackedVars)
  if (ctx.memoVars) {
    ctx.memoVars.forEach(dep => trackedNames.add(dep))
  }
  for (const dep of trackedNames) {
    const key = normalizeDependencyKey(dep)
    const base = key.split('.')[0] ?? key
    if (shadowed && shadowed.has(base)) continue
    if (isNonReactiveFunction(base)) continue
    if (ctx.inReturn && ctx.currentFnIsHook) continue
    if (!hasOverride(key)) {
      overrides[key] = () => buildDependencyGetter(dep, ctx)
    }
  }

  if (Object.keys(overrides).length === 0) {
    return expr
  }

  if (!skipRootOverride && ctx.t.isIdentifier(expr)) {
    const key = normalizeDependencyKey(expr.name)
    const direct = hasOverride(key)
      ? overrides[key]
      : hasOverride(expr.name)
        ? overrides[expr.name]
        : undefined
    if (direct) {
      return direct()
    }
  }

  const cloned = ctx.t.cloneNode(expr, true) as BabelCore.types.Expression
  replaceIdentifiersWithOverrides(cloned, overrides, ctx.t, undefined, undefined, skipRootOverride)
  return cloned
}

export function buildDependencyGetter(
  name: string,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  // Support simple dotted paths: foo.bar -> foo().bar if foo is tracked
  const parts = name.split('.')
  const base = parts.shift()!
  const baseId = t.identifier(base)
  // Only signal/memo/alias variables are actual getter functions that need () calls
  // trackedVars includes all reactive dependencies but may contain plain values
  const isActualGetter = !!(
    ctx.signalVars?.has(base) ||
    ctx.memoVars?.has(base) ||
    ctx.aliasVars?.has(base) ||
    ctx.resumablePropAccessors?.has(base)
  )
  // $store variables use proxy-based reactivity, don't convert to getter calls
  const isStore = ctx.storeVars?.has(base) ?? false
  const isNonReactiveFunction =
    (ctx.functionVars?.has(base) ?? false) && !(ctx.resumablePropAccessors?.has(base) ?? false)

  let baseExpr: BabelCore.types.Expression
  if (isActualGetter && !isStore && !isNonReactiveFunction) {
    // Rule L: Use getter cache when enabled to avoid redundant getter calls
    const getterCall = t.callExpression(baseId, [])
    baseExpr = getCachedGetterExpression(ctx, base, getterCall)
  } else {
    // For store variables and non-tracked variables, use identifier directly
    // Stores use proxy-based path-level reactivity internally
    baseExpr = baseId
  }

  return parts.reduce<BabelCore.types.Expression>((acc, prop) => {
    const numericValue = Number(prop)
    const useNumeric = Number.isSafeInteger(numericValue) && String(numericValue) === prop
    const key = useNumeric
      ? t.numericLiteral(numericValue)
      : /^[a-zA-Z_$][\w$]*$/.test(prop)
        ? t.identifier(prop)
        : t.stringLiteral(prop)
    return t.memberExpression(acc, key, !t.isIdentifier(key))
  }, baseExpr)
}

function unwrapAccessorCalls(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  const isAccessorName = (name: string) =>
    ctx.signalVars?.has(name) || ctx.memoVars?.has(name) || ctx.aliasVars?.has(name)
  const isNamespaceAccessorMember = (
    member: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
  ): boolean => {
    if (!t.isIdentifier(member.object)) return false
    const nsMeta = getImportedNamespaceMetadata(member.object.name, ctx)
    if (!nsMeta) return false
    const propName = !member.computed
      ? t.isIdentifier(member.property)
        ? member.property.name
        : null
      : t.isStringLiteral(member.property) || t.isNumericLiteral(member.property)
        ? String(member.property.value)
        : null
    if (!propName) return false
    const kind = nsMeta.exports[propName]
    return kind === 'signal' || kind === 'memo'
  }

  if (t.isCallExpression(expr) && t.isIdentifier(expr.callee) && expr.arguments.length === 0) {
    if (isAccessorName(expr.callee.name)) {
      return t.identifier(expr.callee.name)
    }
  }
  if (
    t.isCallExpression(expr) &&
    (t.isMemberExpression(expr.callee) || t.isOptionalMemberExpression(expr.callee)) &&
    expr.arguments.length === 0 &&
    isNamespaceAccessorMember(expr.callee)
  ) {
    return t.cloneNode(expr.callee, true) as BabelCore.types.Expression
  }

  if (t.isObjectExpression(expr)) {
    const props = expr.properties.map(p => {
      if (t.isObjectProperty(p)) {
        const value = unwrapAccessorCalls(p.value as BabelCore.types.Expression, ctx)
        return t.objectProperty(p.key, value, p.computed, p.shorthand)
      }
      return p
    })
    return t.objectExpression(props)
  }

  if (t.isArrayExpression(expr)) {
    const elements = expr.elements.map(el =>
      el && t.isExpression(el) ? unwrapAccessorCalls(el, ctx) : el,
    )
    return t.arrayExpression(elements)
  }

  if (t.isConditionalExpression(expr)) {
    return t.conditionalExpression(
      expr.test,
      unwrapAccessorCalls(expr.consequent, ctx),
      unwrapAccessorCalls(expr.alternate, ctx),
    )
  }

  if (t.isLogicalExpression(expr)) {
    return t.logicalExpression(
      expr.operator,
      unwrapAccessorCalls(expr.left, ctx),
      unwrapAccessorCalls(expr.right, ctx),
    )
  }

  if (t.isSequenceExpression(expr)) {
    return t.sequenceExpression(expr.expressions.map(child => unwrapAccessorCalls(child, ctx)))
  }

  if (
    t.isCallExpression(expr) &&
    expr.arguments.length === 0 &&
    (t.isArrowFunctionExpression(expr.callee) || t.isFunctionExpression(expr.callee)) &&
    expr.callee.params.length === 0
  ) {
    const callee = t.cloneNode(expr.callee, true)
    if (t.isArrowFunctionExpression(callee)) {
      if (t.isExpression(callee.body)) {
        callee.body = unwrapAccessorCalls(callee.body, ctx)
      } else {
        callee.body = preserveHookReturnAccessorsInStatement(
          callee.body,
          ctx,
        ) as BabelCore.types.BlockStatement
      }
    } else {
      callee.body = preserveHookReturnAccessorsInStatement(
        callee.body,
        ctx,
      ) as BabelCore.types.BlockStatement
    }
    return t.callExpression(callee, [])
  }

  return expr
}

function preserveHookReturnAccessorsInStatement(
  stmt: BabelCore.types.Statement,
  ctx: CodegenContext,
): BabelCore.types.Statement {
  const { t } = ctx
  if (t.isFunctionDeclaration(stmt)) {
    stmt.body = preserveHookReturnAccessorsInStatement(
      stmt.body,
      ctx,
    ) as BabelCore.types.BlockStatement
    return stmt
  }
  if (t.isReturnStatement(stmt)) {
    if (stmt.argument && t.isExpression(stmt.argument)) {
      stmt.argument = unwrapAccessorCalls(stmt.argument, ctx)
    }
    return stmt
  }
  if (t.isBlockStatement(stmt)) {
    stmt.body = stmt.body.map(child => preserveHookReturnAccessorsInStatement(child, ctx))
    return stmt
  }
  if (t.isIfStatement(stmt)) {
    stmt.consequent = preserveHookReturnAccessorsInStatement(stmt.consequent, ctx)
    if (stmt.alternate) {
      stmt.alternate = preserveHookReturnAccessorsInStatement(stmt.alternate, ctx)
    }
    return stmt
  }
  if (t.isSwitchStatement(stmt)) {
    for (const switchCase of stmt.cases) {
      switchCase.consequent = switchCase.consequent.map(child =>
        preserveHookReturnAccessorsInStatement(child, ctx),
      )
    }
    return stmt
  }
  if (t.isTryStatement(stmt)) {
    stmt.block = preserveHookReturnAccessorsInStatement(
      stmt.block,
      ctx,
    ) as BabelCore.types.BlockStatement
    if (stmt.handler) {
      stmt.handler.body = preserveHookReturnAccessorsInStatement(
        stmt.handler.body,
        ctx,
      ) as BabelCore.types.BlockStatement
    }
    if (stmt.finalizer) {
      stmt.finalizer = preserveHookReturnAccessorsInStatement(
        stmt.finalizer,
        ctx,
      ) as BabelCore.types.BlockStatement
    }
    return stmt
  }
  if (t.isLabeledStatement(stmt)) {
    stmt.body = preserveHookReturnAccessorsInStatement(stmt.body, ctx)
    return stmt
  }
  if (t.isWhileStatement(stmt) || t.isDoWhileStatement(stmt)) {
    stmt.body = preserveHookReturnAccessorsInStatement(stmt.body, ctx)
    return stmt
  }
  if (t.isForStatement(stmt) || t.isForInStatement(stmt) || t.isForOfStatement(stmt)) {
    stmt.body = preserveHookReturnAccessorsInStatement(stmt.body, ctx)
    return stmt
  }
  return stmt
}

function preserveTopLevelHookReturnAccessorsInStatement(
  stmt: BabelCore.types.Statement,
  ctx: CodegenContext,
): BabelCore.types.Statement {
  const { t } = ctx
  if (t.isFunctionDeclaration(stmt) && isHookName(stmt.id?.name)) {
    return preserveHookReturnAccessorsInStatement(stmt, ctx)
  }
  if (
    t.isExportNamedDeclaration(stmt) &&
    stmt.declaration &&
    t.isFunctionDeclaration(stmt.declaration) &&
    isHookName(stmt.declaration.id?.name)
  ) {
    stmt.declaration = preserveHookReturnAccessorsInStatement(
      stmt.declaration,
      ctx,
    ) as BabelCore.types.FunctionDeclaration
    return stmt
  }
  if (
    t.isExportDefaultDeclaration(stmt) &&
    t.isFunctionDeclaration(stmt.declaration) &&
    isHookName(stmt.declaration.id?.name)
  ) {
    stmt.declaration = preserveHookReturnAccessorsInStatement(
      stmt.declaration,
      ctx,
    ) as BabelCore.types.FunctionDeclaration
    return stmt
  }
  return stmt
}

function collectModuleBindingKinds(
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): Map<string, ModuleBindingKind> {
  const bindings = new Map<string, ModuleBindingKind>()
  const addPatternNames = (
    pattern: BabelCore.types.LVal | BabelCore.types.PatternLike,
    kind: ModuleBindingKind,
  ): void => {
    if (t.isIdentifier(pattern)) {
      bindings.set(pattern.name, kind)
      return
    }
    if (t.isAssignmentPattern(pattern)) {
      addPatternNames(pattern.left as BabelCore.types.PatternLike, kind)
      return
    }
    if (t.isRestElement(pattern)) {
      addPatternNames(pattern.argument as BabelCore.types.PatternLike, kind)
      return
    }
    if (t.isObjectPattern(pattern)) {
      for (const prop of pattern.properties) {
        if (t.isRestElement(prop)) {
          addPatternNames(prop.argument as BabelCore.types.PatternLike, kind)
        } else if (t.isObjectProperty(prop)) {
          addPatternNames(prop.value as BabelCore.types.PatternLike, kind)
        }
      }
      return
    }
    if (t.isArrayPattern(pattern)) {
      for (const el of pattern.elements) {
        if (el && t.isPatternLike(el)) addPatternNames(el as BabelCore.types.PatternLike, kind)
      }
    }
  }
  const addVariableDeclaration = (decl: BabelCore.types.VariableDeclaration): void => {
    const declKind: ModuleBindingKind =
      decl.kind === 'const' || decl.kind === 'let' || decl.kind === 'var' ? decl.kind : 'unknown'
    for (const item of decl.declarations) {
      addPatternNames(item.id, item.init && t.isClassExpression(item.init) ? 'class' : declKind)
    }
  }

  for (const stmt of body) {
    if (t.isImportDeclaration(stmt)) {
      if ((stmt as { importKind?: string | null }).importKind === 'type') continue
      for (const spec of stmt.specifiers) {
        if (t.isImportSpecifier(spec) && spec.importKind === 'type') continue
        bindings.set(spec.local.name, 'import')
      }
      continue
    }
    if (t.isFunctionDeclaration(stmt) && stmt.id) {
      bindings.set(stmt.id.name, 'function')
      continue
    }
    if (t.isClassDeclaration(stmt) && stmt.id) {
      bindings.set(stmt.id.name, 'class')
      continue
    }
    if (t.isVariableDeclaration(stmt)) {
      addVariableDeclaration(stmt)
      continue
    }
    if (t.isExpressionStatement(stmt)) {
      const expr = stmt.expression
      if (
        t.isAssignmentExpression(expr) &&
        expr.operator === '=' &&
        t.isIdentifier(expr.left) &&
        t.isClassExpression(expr.right)
      ) {
        bindings.set(expr.left.name, 'class')
      }
      continue
    }
    if (t.isExportNamedDeclaration(stmt)) {
      if (stmt.declaration) {
        const decl = stmt.declaration
        if (t.isFunctionDeclaration(decl) && decl.id) bindings.set(decl.id.name, 'function')
        if (t.isClassDeclaration(decl) && decl.id) bindings.set(decl.id.name, 'class')
        if (t.isVariableDeclaration(decl)) addVariableDeclaration(decl)
      } else {
        const kind: ModuleBindingKind = stmt.source ? 'import' : 'unknown'
        for (const spec of stmt.specifiers) {
          if ((spec as { exportKind?: string | null }).exportKind === 'type') continue
          if (t.isExportSpecifier(spec) && !bindings.has(spec.local.name)) {
            bindings.set(spec.local.name, kind)
          }
        }
      }
      continue
    }
    if (t.isExportDefaultDeclaration(stmt)) {
      const decl = stmt.declaration
      if (t.isFunctionDeclaration(decl) && decl.id) bindings.set(decl.id.name, 'function')
      if (t.isClassDeclaration(decl) && decl.id) bindings.set(decl.id.name, 'class')
    }
  }

  return bindings
}

function getStaticBabelPropertyName(
  node: BabelCore.types.Node,
  computed: boolean | undefined,
  t: typeof BabelCore.types,
): string | null {
  if (!computed && t.isIdentifier(node)) return node.name
  if (t.isStringLiteral(node)) return node.value
  if (t.isNumericLiteral(node)) return String(node.value)
  return null
}

function getStaticBabelMemberPath(
  node: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): string[] | null {
  if (t.isIdentifier(node)) return [deSSAVarName(node.name)]
  if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) return null
  const objectPath = getStaticBabelMemberPath(node.object as BabelCore.types.Expression, t)
  if (!objectPath) return null
  const propName = getStaticBabelPropertyName(node.property, node.computed, t)
  if (propName === null) return null
  return [...objectPath, propName]
}

function getStaticBabelObjectPropertySegment(
  prop: BabelCore.types.ObjectProperty | BabelCore.types.ObjectMethod,
  t: typeof BabelCore.types,
): string | null {
  return getStaticBabelPropertyName(prop.key, prop.computed, t)
}

function resolveBabelHookFunctionAliasSource(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): string | null {
  if (t.isIdentifier(expr)) return resolveHookFunctionNameForAliasSource(expr.name, ctx)
  if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
    const path = getStaticBabelMemberPath(expr, t)
    return path
      ? (ctx.hookFunctionMemberAliases?.get(hookFunctionMemberAliasKey(path)) ?? null)
      : null
  }
  if (t.isSequenceExpression(expr) && expr.expressions.length > 0) {
    const last = expr.expressions[expr.expressions.length - 1]
    return t.isExpression(last) ? resolveBabelHookFunctionAliasSource(last, ctx, t) : null
  }
  return null
}

function copyHookFunctionMemberAliasesFromBabelExpression(
  targetPath: string[],
  value: BabelCore.types.Expression,
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): void {
  const sourcePath = getStaticBabelMemberPath(value, t)
  if (!sourcePath) return
  copyHookFunctionMemberAliases(sourcePath, targetPath, ctx)
}

function propagateBabelHookFunctionMemberAliases(
  targetPath: string[],
  value: BabelCore.types.Expression | null | undefined,
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): void {
  clearHookFunctionMemberAliasesForPath(targetPath, ctx)
  if (!value) return
  copyHookFunctionMemberAliasesFromBabelExpression(targetPath, value, ctx, t)

  if (!t.isObjectExpression(value)) return
  for (const prop of value.properties) {
    if (t.isSpreadElement(prop)) continue
    if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) continue
    const segment = getStaticBabelObjectPropertySegment(prop, t)
    if (!segment) continue
    const propertyPath = [...targetPath, segment]
    if (t.isObjectMethod(prop)) {
      clearHookFunctionMemberAliasesForPath(propertyPath, ctx)
      continue
    }
    const sourceHookName = resolveBabelHookFunctionAliasSource(
      prop.value as BabelCore.types.Expression,
      ctx,
      t,
    )
    if (sourceHookName) {
      setHookFunctionMemberAlias(propertyPath, sourceHookName, ctx)
    }
    if (t.isObjectExpression(prop.value)) {
      propagateBabelHookFunctionMemberAliases(propertyPath, prop.value, ctx, t)
    } else {
      copyHookFunctionMemberAliasesFromBabelExpression(
        propertyPath,
        prop.value as BabelCore.types.Expression,
        ctx,
        t,
      )
    }
  }
}

function propagateBabelHookFunctionMemberAssignment(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): void {
  if (!t.isAssignmentExpression(expr)) return
  if (!t.isMemberExpression(expr.left) && !t.isOptionalMemberExpression(expr.left)) return
  const path = getStaticBabelMemberPath(expr.left, t)
  if (!path || path.length < 2) return
  clearHookFunctionMemberAliasesForPath(path, ctx)
  if (expr.operator !== '=') return
  const sourceHookName = resolveBabelHookFunctionAliasSource(expr.right, ctx, t)
  if (sourceHookName) {
    setHookFunctionMemberAlias(path, sourceHookName, ctx)
  }
}

function propagateLocalHookAliasMetadata(
  body: BabelCore.types.Statement[],
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): void {
  const aliasPairs: { target: string; source: string }[] = []
  const objectAliasOps: (
    | { kind: 'assign'; targetPath: string[]; value: BabelCore.types.Expression | null | undefined }
    | { kind: 'memberAssign'; expr: BabelCore.types.Expression }
  )[] = []
  const reassignedAliases = new Set<string>()
  const collectDeclaration = (decl: BabelCore.types.VariableDeclaration): void => {
    for (const item of decl.declarations) {
      if (!t.isIdentifier(item.id)) continue
      objectAliasOps.push({
        kind: 'assign',
        targetPath: [deSSAVarName(item.id.name)],
        value: item.init,
      })
      if (!item.init || !t.isIdentifier(item.init)) continue
      aliasPairs.push({
        target: deSSAVarName(item.id.name),
        source: deSSAVarName(item.init.name),
      })
    }
  }
  const collectReassignment = (stmt: BabelCore.types.Statement): void => {
    if (!t.isExpressionStatement(stmt)) return
    const expr = stmt.expression
    if (!t.isAssignmentExpression(expr) || expr.operator !== '=' || !t.isIdentifier(expr.left)) {
      return
    }
    reassignedAliases.add(deSSAVarName(expr.left.name))
    objectAliasOps.push({
      kind: 'assign',
      targetPath: [deSSAVarName(expr.left.name)],
      value: expr.right,
    })
  }

  for (const stmt of body) {
    if (t.isVariableDeclaration(stmt)) {
      collectDeclaration(stmt)
      continue
    }
    if (
      t.isExportNamedDeclaration(stmt) &&
      stmt.declaration &&
      t.isVariableDeclaration(stmt.declaration)
    ) {
      collectDeclaration(stmt.declaration)
      continue
    }
    collectReassignment(stmt)
    if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
      objectAliasOps.push({ kind: 'memberAssign', expr: stmt.expression })
    }
  }

  ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
  reassignedAliases.forEach(name => clearHookFunctionAlias(name, ctx))
  let changed = true
  while (changed) {
    changed = false
    for (const { target, source } of aliasPairs) {
      if (reassignedAliases.has(target)) continue
      if (ctx.hookReturnInfo.has(target)) continue
      const sourceInfo = ctx.hookReturnInfo.get(source)
      if (!sourceInfo) continue
      ctx.hookReturnInfo.set(target, sourceInfo)
      ctx.hookFunctionAliases = ctx.hookFunctionAliases ?? new Map()
      ctx.hookFunctionAliases.set(target, ctx.hookFunctionAliases.get(source) ?? source)
      if (ctx.importedHookReturnInfoNames?.has(source)) {
        markImportedHookReturnInfoName(target, ctx)
      }
      changed = true
    }
  }

  for (const op of objectAliasOps) {
    if (op.kind === 'assign') {
      propagateBabelHookFunctionMemberAliases(op.targetPath, op.value, ctx, t)
    } else {
      propagateBabelHookFunctionMemberAssignment(op.expr, ctx, t)
    }
  }
}

function seedSameFileHookAliasMetadata(
  program: HIRProgram,
  originalBody: BabelCore.types.Statement[],
  ctx: CodegenContext,
  t: typeof BabelCore.types,
): void {
  propagateLocalHookAliasMetadata(originalBody, ctx, t)
  for (const fn of program.functions) {
    if (!fn.name || !isHookName(fn.name)) continue
    getHookReturnInfo(fn.name, ctx)
  }
  propagateLocalHookAliasMetadata(originalBody, ctx, t)
}

function preserveHookReturnAccessorsInStatements(
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): BabelCore.types.Statement[] {
  return statements.map(stmt => preserveHookReturnAccessorsInStatement(stmt, ctx))
}

/**
 * Lower an intrinsic HTML element to fine-grained DOM operations.
 * Uses template extraction and RegionMetadata for optimized updates.
 * Aligned with fine-grained-dom.ts approach.
 */
function lowerIntrinsicElement(
  jsx: JSXElementExpression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  const statements: BabelCore.types.Statement[] = []

  // Extract static HTML with bindings, passing namespace context
  // This allows proper namespace detection for elements inside SVG/MathML
  const { html, bindings, isSVG, isMathML } = extractHIRStaticHtml(
    jsx,
    ctx,
    {
      isLikelyTextExpression: (expr, context) =>
        isLikelyTextExpression(expr, context, { getHookReturnInfo }),
    },
    [],
    ctx.namespaceContext ?? null,
  )

  // Collect all dependencies from bindings to find containing region
  const allDeps = new Set<string>()
  for (const binding of bindings) {
    if (binding.expr) collectExpressionDependencies(binding.expr, allDeps)
  }

  // Find the containing region and apply it to the context
  let containingRegion = findContainingRegion(allDeps, ctx)
  if (!containingRegion && allDeps.size > 0) {
    containingRegion = {
      id: (ctx.regions?.length ?? 0) + 1000,
      dependencies: new Set(Array.from(allDeps).map(d => deSSAVarName(d))),
      declarations: new Set<string>(),
      hasControlFlow: false,
      hasReactiveWrites: false,
    }
  }
  const prevRegion = applyRegionToContext(ctx, containingRegion)
  const regionMeta = containingRegion ? regionInfoToMetadata(containingRegion) : null
  const canUseRenderMemo = !!(ctx.inModule || ctx.isComponentFn || ctx.currentFnIsHook)
  const shouldMemo =
    canUseRenderMemo &&
    !ctx.inListRender &&
    !(ctx.inConditional && ctx.inConditional > 0) &&
    regionMeta
      ? shouldMemoizeRegion(regionMeta)
      : false
  if (shouldMemo) {
    if (ctx.inModule) {
      ctx.helpersUsed.add('memo')
    } else {
      ctx.helpersUsed.add('useMemo')
      ctx.needsCtx = true
    }
  }

  // Create template with full static HTML
  // For list render context, try to hoist template to avoid repeated HTML parsing
  // Pass namespace flags for SVG/MathML support
  const hoistedTmplId = getOrCreateHoistedTemplate(html, ctx, isSVG, isMathML)
  const rootId = genTemp(ctx, 'root')

  if (hoistedTmplId) {
    // Use hoisted template (already declared outside list callback)
    statements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(rootId, t.callExpression(t.identifier(hoistedTmplId.name), [])),
      ]),
    )
  } else {
    // Create template inline (non-list context)
    ctx.helpersUsed.add('template')
    const tmplId = genTemp(ctx, 'tmpl')

    // Build template call arguments with namespace flags
    const templateArgs: BabelCore.types.Expression[] = [t.stringLiteral(html)]
    if (isSVG || isMathML) {
      // template(html, isImportNode, isSVG, isMathML)
      templateArgs.push(t.unaryExpression('void', t.numericLiteral(0))) // isImportNode
      templateArgs.push(
        isSVG ? t.booleanLiteral(true) : t.unaryExpression('void', t.numericLiteral(0)),
      )
      if (isMathML) {
        templateArgs.push(t.booleanLiteral(true))
      }
    }

    statements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          tmplId,
          t.callExpression(runtimeIdentifier(ctx, 'template'), templateArgs),
        ),
      ]),
    )
    statements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(rootId, t.callExpression(t.identifier(tmplId.name), [])),
      ]),
    )
  }
  // Note: template() already returns content.firstChild, so rootId IS the root element
  // We use rootId directly as elId
  const elId = rootId

  // Build a cache for resolved node paths
  const nodeCache = new Map<string, BabelCore.types.Identifier>()
  nodeCache.set('', elId)
  const hasAuthoredChildren = jsx.hasAuthoredChildren === true || jsx.children.length > 0

  // Determine and set namespace context for this element's children
  // This allows dynamic child expressions to know they're inside SVG/MathML
  const tagName = typeof jsx.tagName === 'string' ? jsx.tagName : null
  const prevNamespace = ctx.namespaceContext
  if (tagName) {
    const elementNamespace = resolveNamespaceContext(
      tagName,
      ctx.namespaceContext ?? null,
      jsx.attributes,
    )
    ctx.namespaceContext = elementNamespace
  }

  // Precompute node references before any binding mutates the DOM tree
  const pathStatements: BabelCore.types.Statement[] = []
  for (const binding of bindings) {
    resolveHIRBindingPath(binding.path, nodeCache, pathStatements, ctx, genTemp)
  }
  statements.push(...pathStatements)

  const optimizeLevel = ctx.options?.optimizeLevel ?? 'safe'
  interface FusedPatchEntry {
    patch: BabelCore.types.Statement
    fallback: BabelCore.types.Statement
    patchHelper: 'setText' | 'setTextContent' | 'setAttr' | 'setProp' | 'setClass' | 'setStyle'
    fallbackHelper:
      | 'bindText'
      | 'bindTextContent'
      | 'bindAttribute'
      | 'bindProperty'
      | 'bindClass'
      | 'bindStyle'
  }

  const fusedPatchGroups = new Map<string, FusedPatchEntry[]>()
  let fusedUniqueId = 0

  const isFusibleBindingExpression = (expr: Expression): boolean => {
    switch (expr.kind) {
      case 'Identifier':
      case 'Literal':
      case 'ThisExpression':
      case 'SuperExpression':
        return true
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        return (
          isFusibleBindingExpression(expr.object) &&
          (!expr.computed || isFusibleBindingExpression(expr.property))
        )
      case 'BinaryExpression':
      case 'LogicalExpression':
        return (
          isFusibleBindingExpression(expr.left as Expression) &&
          isFusibleBindingExpression(expr.right as Expression)
        )
      case 'UnaryExpression':
        return expr.operator !== 'delete' && isFusibleBindingExpression(expr.argument as Expression)
      case 'ConditionalExpression':
        return (
          isFusibleBindingExpression(expr.test as Expression) &&
          isFusibleBindingExpression(expr.consequent as Expression) &&
          isFusibleBindingExpression(expr.alternate as Expression)
        )
      case 'ArrayExpression':
        return expr.elements.every(el => !el || isFusibleBindingExpression(el as Expression))
      case 'ObjectExpression':
        return expr.properties.every(prop => {
          if (prop.kind === 'SpreadElement') {
            return isFusibleBindingExpression(prop.argument as Expression)
          }
          if (prop.key.kind === 'Identifier' || prop.key.kind === 'Literal') {
            return isFusibleBindingExpression(prop.value as Expression)
          }
          return isFusibleBindingExpression(prop.value as Expression)
        })
      case 'TemplateLiteral':
        return expr.expressions.every(e => isFusibleBindingExpression(e as Expression))
      default:
        return false
    }
  }

  const getFusedPatchGroupKey = (expr: Expression): string => {
    if (optimizeLevel === 'full') return '__full__'
    const deps = getReactiveDependencies(expr, ctx)
    if (deps.size === 0) {
      fusedUniqueId += 1
      return `__dep_empty_${fusedUniqueId}`
    }
    return Array.from(deps).sort().join('|')
  }

  const queueFusedPatch = (expr: Expression, entry: FusedPatchEntry): boolean => {
    if (!isFusibleBindingExpression(expr)) return false
    const key = getFusedPatchGroupKey(expr)
    const group = fusedPatchGroups.get(key)
    if (group) {
      group.push(entry)
    } else {
      fusedPatchGroups.set(key, [entry])
    }
    return true
  }

  const lowerBindingValueExpression = (expr?: Expression): BabelCore.types.Expression => {
    const valueExpr = expr
      ? lowerDomExpression(expr, ctx, containingRegion)
      : t.booleanLiteral(true)
    const valueIdentifier = t.isIdentifier(valueExpr) ? deSSAVarName(valueExpr.name) : undefined
    const isAccessorIdentifier =
      valueIdentifier &&
      ((ctx.signalVars?.has(valueIdentifier) ?? false) ||
        (ctx.memoVars?.has(valueIdentifier) ?? false) ||
        (ctx.aliasVars?.has(valueIdentifier) ?? false) ||
        (ctx.resumablePropAccessors?.has(valueIdentifier) ?? false))
    return valueIdentifier &&
      (regionMeta?.dependencies.has(valueIdentifier) ||
        ctx.trackedVars.has(valueIdentifier) ||
        isAccessorIdentifier)
      ? buildDependencyGetter(valueIdentifier, ctx)
      : valueExpr
  }

  const refExpressionUsesReactiveSource = (expr?: Expression): boolean => {
    if (!expr) return false
    let usesReactiveSource = false
    const isReactiveRefDependency = (name: string): boolean => {
      const baseName = deSSAVarName(name).split('.')[0] ?? name
      if (ctx.functionVars?.has(baseName)) return false
      return (
        ctx.signalVars?.has(baseName) ||
        ctx.memoVars?.has(baseName) ||
        ctx.aliasVars?.has(baseName) ||
        ctx.trackedVars.has(baseName)
      )
    }

    walkExpression(
      expr,
      node => {
        if (usesReactiveSource) return
        if (node.kind === 'Identifier') {
          usesReactiveSource = isReactiveRefDependency(node.name)
          return
        }
        if (node.kind === 'MemberExpression' || node.kind === 'OptionalMemberExpression') {
          usesReactiveSource = !!resolveHookReturnMemberAccessorKind(node, ctx)
        }
      },
      { includeFunctionBodies: false },
    )
    return usesReactiveSource
  }

  const buildDangerouslySetInnerHTMLStatements = (
    targetId: BabelCore.types.Identifier,
    valueExpr: BabelCore.types.Expression,
  ): BabelCore.types.Statement[] => {
    const htmlValueId = genTemp(ctx, 'html')
    const hasHtmlValue = t.logicalExpression(
      '&&',
      t.binaryExpression('!=', t.cloneNode(htmlValueId), t.nullLiteral()),
      t.logicalExpression(
        '&&',
        t.binaryExpression(
          '===',
          t.unaryExpression('typeof', t.cloneNode(htmlValueId)),
          t.stringLiteral('object'),
        ),
        t.binaryExpression('in', t.stringLiteral('__html'), t.cloneNode(htmlValueId)),
      ),
    )
    const htmlMember = t.memberExpression(t.cloneNode(htmlValueId), t.identifier('__html'))

    return [
      t.variableDeclaration('const', [t.variableDeclarator(htmlValueId, valueExpr)]),
      t.ifStatement(
        hasHtmlValue,
        t.expressionStatement(
          t.callExpression(runtimeIdentifier(ctx, 'setProp'), [
            t.cloneNode(targetId),
            t.stringLiteral('innerHTML'),
            htmlMember,
          ]),
        ),
      ),
    ]
  }

  const buildBooleanAttributeStatements = (
    targetId: BabelCore.types.Identifier,
    attrName: string,
    valueExpr: BabelCore.types.Expression,
  ): BabelCore.types.Statement[] => [
    t.ifStatement(
      valueExpr,
      t.expressionStatement(
        t.callExpression(t.memberExpression(t.cloneNode(targetId), t.identifier('setAttribute')), [
          t.stringLiteral(attrName),
          t.stringLiteral(''),
        ]),
      ),
      t.expressionStatement(
        t.callExpression(
          t.memberExpression(t.cloneNode(targetId), t.identifier('removeAttribute')),
          [t.stringLiteral(attrName)],
        ),
      ),
    ),
  ]

  const flushFusedPatchGroups = (): void => {
    if (fusedPatchGroups.size === 0) return
    for (const groupEntries of fusedPatchGroups.values()) {
      if (optimizeLevel !== 'full' && groupEntries.length === 1) {
        const single = groupEntries[0]!
        ctx.helpersUsed.add(single.fallbackHelper)
        statements.push(single.fallback)
        continue
      }

      ctx.helpersUsed.add('renderEffect')
      const patchStatements: BabelCore.types.Statement[] = []
      for (const entry of groupEntries) {
        ctx.helpersUsed.add(entry.patchHelper)
        patchStatements.push(entry.patch)
      }
      statements.push(
        t.expressionStatement(
          t.callExpression(runtimeIdentifier(ctx, 'renderEffect'), [
            t.arrowFunctionExpression([], t.blockStatement(patchStatements)),
          ]),
        ),
      )
    }
    fusedPatchGroups.clear()
  }

  // Apply bindings using path navigation
  for (const binding of bindings) {
    const targetId = resolveHIRBindingPath(binding.path, nodeCache, statements, ctx, genTemp)

    if (binding.type === 'spread' && binding.expr) {
      // Spread ordering must follow source order, so flush pending fused patches first.
      flushFusedPatchGroups()
      ctx.helpersUsed.add('spread')
      const spreadValueExpr = lowerDomExpression(binding.expr, ctx, containingRegion)
      // Always wrap spread expressions so function-valued expressions are treated
      // as values, not invoked as runtime spread getters.
      const spreadGetter = markCompilerReactiveGetter(
        ctx,
        t.arrowFunctionExpression([], spreadValueExpr),
      )
      const isSVGSpreadTarget = binding.namespace === 'svg'
      const spreadArgs: BabelCore.types.Expression[] = [
        targetId,
        spreadGetter,
        t.booleanLiteral(isSVGSpreadTarget),
        t.booleanLiteral(hasAuthoredChildren),
      ]
      if (binding.exclude && binding.exclude.length > 0) {
        spreadArgs.push(t.arrayExpression(binding.exclude.map(name => t.stringLiteral(name))))
      }
      statements.push(
        t.expressionStatement(t.callExpression(runtimeIdentifier(ctx, 'spread'), spreadArgs)),
      )
    } else if (binding.type === 'event' && binding.expr && binding.name) {
      // Event binding
      const eventName = binding.name
      const hasEventOptions =
        binding.eventOptions &&
        (binding.eventOptions.capture || binding.eventOptions.passive || binding.eventOptions.once)
      const isDelegated = DelegatedEvents.has(eventName) && !hasEventOptions
      const loaderObservesResumableEvent = DelegatedEvents.has(eventName)
      if (binding.resumableExplicit && hasEventOptions) {
        const modifiers = [
          binding.eventOptions?.capture ? 'capture' : null,
          binding.eventOptions?.passive ? 'passive' : null,
          binding.eventOptions?.once ? 'once' : null,
        ].filter((value): value is string => value !== null)
        const loc = binding.expr.loc?.start
        throw new HIRError(
          `Resumable event handler on:${eventName} does not support event options (${modifiers.join(', ')}). Remove the '$' suffix or the event modifier.`,
          'BUILD_ERROR',
          {
            file: ctx.options?.filename ?? '<unknown>',
            line: loc?.line,
            variable: eventName,
          },
        )
      }
      if (binding.resumableExplicit && !loaderObservesResumableEvent) {
        const loc = binding.expr.loc?.start
        throw new HIRError(
          `Resumable event handler on:${eventName} is not observed by the default loader. Remove the '$' suffix or configure the loader to listen for this event.`,
          'BUILD_ERROR',
          {
            file: ctx.options?.filename ?? '<unknown>',
            line: loc?.line,
            variable: eventName,
          },
        )
      }

      if (binding.resumable && !hasEventOptions && loaderObservesResumableEvent) {
        const emitted = emitResumableEventBinding(
          targetId,
          eventName,
          binding.expr,
          statements,
          ctx,
          containingRegion,
          createResumableEventBindingOps(),
          { explicit: binding.resumableExplicit === true },
        )
        if (emitted) continue
      }

      // Try to extract handler and data from HIR before lowering
      // This preserves function references without transforming them to call expressions
      const hirDataBinding =
        isDelegated && binding.expr ? extractDelegatedEventDataFromHIR(binding.expr, ctx) : null

      if (hirDataBinding) {
        // Optimized path - handler and data extracted from HIR
        // Pattern: onClick={() => select(__key)} compiles to:
        //   $$click = select
        //   $$clickData = () => __key
        // This avoids creating per-item closures in lists while maintaining
        // the runtime's (data, event) calling convention
        ctx.delegatedEventsUsed?.add(eventName)

        // Lower handler as a simple identifier (not as getter call)
        const handlerExpr = markSkipRegionOverride(
          hirDataBinding.handler.kind === 'Identifier'
            ? t.identifier(hirDataBinding.handler.name)
            : lowerExpression(hirDataBinding.handler, ctx),
        )

        // Lower data with proper tracking (wrapped in getter for reactivity)
        const dataExpr = lowerDomExpression(hirDataBinding.data, ctx, containingRegion, {
          skipHookAccessors: false,
          skipRegionRootOverride: true,
        })

        const dataValue = isStaticDelegatedDataExpression(hirDataBinding.data, ctx)
          ? dataExpr
          : markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], dataExpr))
        ctx.helpersUsed.add('addEventListener')
        statements.push(
          t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'addEventListener'), [
              targetId,
              t.stringLiteral(eventName),
              t.arrayExpression([
                handlerExpr,
                dataValue,
                t.stringLiteral(DELEGATED_DATA_PLAIN_MARKER),
              ]),
              t.booleanLiteral(true),
            ]),
          ),
        )
      } else {
        const explicitEventTuple =
          binding.expr.kind === 'ArrayExpression' &&
          binding.expr.elements.length === 2 &&
          binding.expr.elements[0] &&
          binding.expr.elements[1]
            ? {
                handler: binding.expr.elements[0],
                data: binding.expr.elements[1],
              }
            : null

        if (explicitEventTuple) {
          const tupleHandler = markSkipRegionOverride(
            explicitEventTuple.handler.kind === 'Identifier'
              ? t.identifier(deSSAVarName(explicitEventTuple.handler.name))
              : lowerExpression(explicitEventTuple.handler, ctx),
          )
          const tupleData = lowerDomExpression(explicitEventTuple.data, ctx, containingRegion, {
            skipHookAccessors: false,
            skipRegionRootOverride: true,
          })
          const tupleDataValue = isStaticDelegatedDataExpression(explicitEventTuple.data, ctx)
            ? tupleData
            : markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], tupleData))
          const tupleValue = t.arrayExpression([tupleHandler, tupleDataValue])

          if (isDelegated) {
            ctx.delegatedEventsUsed?.add(eventName)
            ctx.helpersUsed.add('addEventListener')
            statements.push(
              t.expressionStatement(
                t.callExpression(runtimeIdentifier(ctx, 'addEventListener'), [
                  targetId,
                  t.stringLiteral(eventName),
                  tupleValue,
                  t.booleanLiteral(true),
                ]),
              ),
            )
          } else {
            ctx.helpersUsed.add('bindEvent')
            ctx.helpersUsed.add('onDestroy')
            const cleanupId = genTemp(ctx, 'evt')
            const args: BabelCore.types.Expression[] = [
              targetId,
              t.stringLiteral(eventName),
              tupleValue,
            ]
            if (hasEventOptions && binding.eventOptions) {
              const optionProps: BabelCore.types.ObjectProperty[] = []
              if (binding.eventOptions.capture) {
                optionProps.push(t.objectProperty(t.identifier('capture'), t.booleanLiteral(true)))
              }
              if (binding.eventOptions.passive) {
                optionProps.push(t.objectProperty(t.identifier('passive'), t.booleanLiteral(true)))
              }
              if (binding.eventOptions.once) {
                optionProps.push(t.objectProperty(t.identifier('once'), t.booleanLiteral(true)))
              }
              if (optionProps.length > 0) {
                args.push(t.objectExpression(optionProps))
              }
            }
            statements.push(
              t.variableDeclaration('const', [
                t.variableDeclarator(
                  cleanupId,
                  t.callExpression(runtimeIdentifier(ctx, 'bindEvent'), args),
                ),
              ]),
            )
            statements.push(
              t.expressionStatement(
                t.callExpression(runtimeIdentifier(ctx, 'onDestroy'), [cleanupId]),
              ),
            )
          }
          continue
        }

        // Standard path - lower the entire expression
        const shouldWrapHandler = eventHandlerExpressionNeedsReactiveGetter(binding.expr, ctx)
        const prevWrapTracked = ctx.wrapTrackedExpressions
        ctx.wrapTrackedExpressions = false
        const valueExpr = lowerDomExpression(binding.expr, ctx, containingRegion, {
          skipHookAccessors: true,
          skipRegionRootOverride: true,
        })
        ctx.wrapTrackedExpressions = prevWrapTracked
        const eventParam = t.identifier('_e')
        const isFn = t.isArrowFunctionExpression(valueExpr) || t.isFunctionExpression(valueExpr)
        const isReactiveGetterName = (name: string): boolean =>
          !!(
            ctx.signalVars?.has(name) ||
            ctx.callableSignalVars?.has(name) ||
            ctx.memoVars?.has(name) ||
            ctx.aliasVars?.has(name)
          )
        const reactiveGetterIdentifierName = (() => {
          if (binding.expr.kind === 'Identifier') {
            const name = deSSAVarName(binding.expr.name)
            if (isReactiveGetterName(name)) return name
          }
          if (
            t.isCallExpression(valueExpr) &&
            t.isIdentifier(valueExpr.callee) &&
            valueExpr.arguments.length === 0 &&
            isReactiveGetterName(valueExpr.callee.name)
          ) {
            return valueExpr.callee.name
          }
          return null
        })()
        const listItemHandlerName =
          binding.expr.kind === 'Identifier' &&
          ctx.inListRender &&
          ctx.listItemAccessorParamNames?.has(deSSAVarName(binding.expr.name))
            ? deSSAVarName(binding.expr.name)
            : null
        const shouldEvaluateHandlerAtSetup =
          !shouldWrapHandler &&
          !reactiveGetterIdentifierName &&
          !listItemHandlerName &&
          !isFn &&
          !t.isIdentifier(valueExpr) &&
          !t.isMemberExpression(valueExpr) &&
          !t.isOptionalMemberExpression(valueExpr)
        let handlerValueExpr = valueExpr
        if (shouldEvaluateHandlerAtSetup) {
          const handlerValueId = genTemp(ctx, 'handler')
          statements.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(handlerValueId, handlerValueExpr),
            ]),
          )
          handlerValueExpr = handlerValueId
        }
        const ensureHandlerParam = (fn: BabelCore.types.Expression): BabelCore.types.Expression => {
          if (t.isArrowFunctionExpression(fn)) {
            return fn
          }
          if (t.isFunctionExpression(fn)) {
            return fn
          }
          // Don't wrap identifiers and member expressions in arrow functions.
          // Arrow functions don't respect .call() for `this` binding.
          // The runtime's callEventHandler uses .call(element, event) to set `this` to the element.
          // By passing the function directly, the `this` binding works correctly.
          if (t.isIdentifier(fn) || t.isMemberExpression(fn)) {
            return fn
          }
          // For other expressions (e.g., conditional, call expression), wrap in a function
          // and defer invocation semantics to runtime callEventHandler.
          return t.functionExpression(
            null,
            [],
            t.blockStatement([t.returnStatement(fn as BabelCore.types.Expression)]),
          )
        }
        const shouldTreatAsReactiveHandler =
          !!reactiveGetterIdentifierName || !!listItemHandlerName || (!isFn && shouldWrapHandler)
        const handlerExpr = listItemHandlerName
          ? markCompilerReactiveGetter(
              ctx,
              t.arrowFunctionExpression(
                [],
                t.callExpression(t.identifier(listItemHandlerName), []),
              ),
            )
          : reactiveGetterIdentifierName
            ? t.identifier(reactiveGetterIdentifierName)
            : !isFn && shouldWrapHandler
              ? markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], valueExpr))
              : ensureHandlerParam(handlerValueExpr)

        let dataBinding =
          isDelegated && !shouldTreatAsReactiveHandler
            ? extractDelegatedEventData(handlerValueExpr, t, {
                isKnownHandlerIdentifier: name => {
                  const normalized = deSSAVarName(name)
                  return (
                    (ctx.functionVars?.has(normalized) ?? false) &&
                    !(ctx.mutatedVars?.has(normalized) ?? false) &&
                    !(ctx.componentFunctionMutations?.has(normalized) ?? false)
                  )
                },
              })
            : null
        if (dataBinding && t.isIdentifier(dataBinding.handler)) {
          const handlerName = dataBinding.handler.name
          if (
            ctx.signalVars?.has(handlerName) ||
            ctx.memoVars?.has(handlerName) ||
            ctx.aliasVars?.has(handlerName) ||
            ctx.storeVars?.has(handlerName) ||
            ctx.trackedVars.has(handlerName)
          ) {
            dataBinding = null
          }
        }

        // Attempt data-binding for delegated events to avoid per-node closures
        if (isDelegated) {
          // Optimization: Direct property assignment for delegated events
          // This avoids creating cleanup functions and onDestroy registrations
          // The runtime's global event handler will pick up handlers stored as $$eventName
          ctx.delegatedEventsUsed?.add(eventName)

          const finalHandler = handlerExpr

          const normalizeHandler = (
            expr: BabelCore.types.Expression,
          ): BabelCore.types.Expression => {
            return expr
          }

          const normalizedDataHandler =
            dataBinding !== null
              ? normalizeHandler(
                  (dataBinding?.handler ?? handlerExpr) as BabelCore.types.Expression,
                )
              : null

          const dataForDelegate =
            dataBinding?.data &&
            (t.isArrowFunctionExpression(dataBinding.data) ||
            t.isFunctionExpression(dataBinding.data)
              ? dataBinding.data
              : isStaticDelegatedDataAst(dataBinding.data, ctx)
                ? dataBinding.data
                : markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], dataBinding.data)))

          const handlerForDelegate =
            normalizedDataHandler ??
            (dataBinding
              ? normalizeHandler(handlerExpr as BabelCore.types.Expression)
              : finalHandler)
          const handlerIsCallableExpr =
            t.isArrowFunctionExpression(handlerForDelegate) ||
            t.isFunctionExpression(handlerForDelegate) ||
            t.isIdentifier(handlerForDelegate) ||
            t.isMemberExpression(handlerForDelegate) ||
            shouldTreatAsReactiveHandler

          const handlerToAssign: BabelCore.types.Expression = markSkipRegionOverride(
            handlerIsCallableExpr
              ? handlerForDelegate
              : t.arrowFunctionExpression([eventParam], handlerForDelegate),
          )

          ctx.helpersUsed.add('addEventListener')
          const delegatedValue = dataForDelegate
            ? t.arrayExpression([
                handlerToAssign,
                dataForDelegate,
                t.stringLiteral(DELEGATED_DATA_ONLY_MARKER),
              ])
            : handlerToAssign
          statements.push(
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'addEventListener'), [
                targetId,
                t.stringLiteral(eventName),
                delegatedValue,
                t.booleanLiteral(true),
              ]),
            ),
          )
        } else {
          // Fallback: Use bindEvent for non-delegated events or events with options
          ctx.helpersUsed.add('bindEvent')
          ctx.helpersUsed.add('onDestroy')
          const cleanupId = genTemp(ctx, 'evt')
          const args: BabelCore.types.Expression[] = [
            targetId,
            t.stringLiteral(eventName),
            markSkipRegionOverride(handlerExpr),
          ]
          if (hasEventOptions && binding.eventOptions) {
            const optionProps: BabelCore.types.ObjectProperty[] = []
            if (binding.eventOptions.capture) {
              optionProps.push(t.objectProperty(t.identifier('capture'), t.booleanLiteral(true)))
            }
            if (binding.eventOptions.passive) {
              optionProps.push(t.objectProperty(t.identifier('passive'), t.booleanLiteral(true)))
            }
            if (binding.eventOptions.once) {
              optionProps.push(t.objectProperty(t.identifier('once'), t.booleanLiteral(true)))
            }
            args.push(t.objectExpression(optionProps))
          }
          statements.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(
                cleanupId,
                t.callExpression(runtimeIdentifier(ctx, 'bindEvent'), args),
              ),
            ]),
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'onDestroy'), [cleanupId]),
            ),
          )
        }
      }
    } else if (binding.type === 'attr' && binding.name) {
      // Attribute binding
      const attrName = binding.name
      const forcedBinding = parseForcedBindingName(attrName)
      const isPropertyBinding = binding.bindingTarget === 'property'
      const valueWithRegion = lowerBindingValueExpression(binding.expr)
      const isReactiveAttr =
        !!binding.expr &&
        !isListKeyConstExpression(binding.expr, ctx) &&
        isExpressionReactive(binding.expr, ctx)

      if (attrName === 'dangerouslySetInnerHTML') {
        if (binding.hasChildren) {
          const loc = binding.expr?.loc?.start
          throw new HIRError(
            'dangerouslySetInnerHTML cannot be used with JSX children in fine-grained DOM output.',
            'BUILD_ERROR',
            {
              file: ctx.options?.filename ?? '<unknown>',
              line: loc?.line,
              variable: attrName,
            },
          )
        }
        if (!binding.expr) continue

        ctx.helpersUsed.add('setProp')
        const patchStatements = buildDangerouslySetInnerHTMLStatements(targetId, valueWithRegion)
        if (isReactiveAttr) {
          ctx.helpersUsed.add('renderEffect')
          statements.push(
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'renderEffect'), [
                t.arrowFunctionExpression([], t.blockStatement(patchStatements)),
              ]),
            ),
          )
        } else {
          statements.push(...patchStatements)
        }
      } else if (forcedBinding?.prefix === 'attr') {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'setAttr'), [
              targetId,
              t.stringLiteral(forcedBinding.name),
              valueWithRegion,
            ]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'bindAttribute'), [
              targetId,
              t.stringLiteral(forcedBinding.name),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setAttr',
              fallbackHelper: 'bindAttribute',
            })
          ) {
            ctx.helpersUsed.add('bindAttribute')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setAttr')
          statements.push(
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'setAttr'), [
                targetId,
                t.stringLiteral(forcedBinding.name),
                valueWithRegion,
              ]),
            ),
          )
        }
      } else if (forcedBinding?.prefix === 'bool') {
        const patchStatements = buildBooleanAttributeStatements(
          targetId,
          forcedBinding.name,
          valueWithRegion,
        )
        if (isReactiveAttr) {
          ctx.helpersUsed.add('renderEffect')
          statements.push(
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'renderEffect'), [
                t.arrowFunctionExpression([], t.blockStatement(patchStatements)),
              ]),
            ),
          )
        } else {
          statements.push(...patchStatements)
        }
      } else if (forcedBinding?.prefix === 'prop') {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'setProp'), [
              targetId,
              t.stringLiteral(forcedBinding.name),
              valueWithRegion,
            ]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'bindProperty'), [
              targetId,
              t.stringLiteral(forcedBinding.name),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setProp',
              fallbackHelper: 'bindProperty',
            })
          ) {
            ctx.helpersUsed.add('bindProperty')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setProp')
          statements.push(
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'setProp'), [
                targetId,
                t.stringLiteral(forcedBinding.name),
                valueWithRegion,
              ]),
            ),
          )
        }
      } else if (attrName === 'ref') {
        ctx.helpersUsed.add('bindRef')
        const refValue = refExpressionUsesReactiveSource(binding.expr)
          ? markCompilerReactiveGetter(ctx, t.arrowFunctionExpression([], valueWithRegion))
          : valueWithRegion
        statements.push(
          t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'bindRef'), [targetId, refValue]),
          ),
        )
      } else if (attrName === 'class' || attrName === 'className' || attrName === 'classList') {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'setClass'), [targetId, valueWithRegion]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'bindClass'), [
              targetId,
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setClass',
              fallbackHelper: 'bindClass',
            })
          ) {
            ctx.helpersUsed.add('bindClass')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setClass')
          statements.push(
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'setClass'), [targetId, valueWithRegion]),
            ),
          )
        }
      } else if (attrName === 'style') {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'setStyle'), [targetId, valueWithRegion]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'bindStyle'), [
              targetId,
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setStyle',
              fallbackHelper: 'bindStyle',
            })
          ) {
            ctx.helpersUsed.add('bindStyle')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setStyle')
          statements.push(
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'setStyle'), [targetId, valueWithRegion]),
            ),
          )
        }
      } else if (isPropertyBinding || isDOMProperty(attrName)) {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'setProp'), [
              targetId,
              t.stringLiteral(attrName),
              valueWithRegion,
            ]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'bindProperty'), [
              targetId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setProp',
              fallbackHelper: 'bindProperty',
            })
          ) {
            ctx.helpersUsed.add('bindProperty')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setProp')
          statements.push(
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'setProp'), [
                targetId,
                t.stringLiteral(attrName),
                valueWithRegion,
              ]),
            ),
          )
        }
      } else {
        if (isReactiveAttr && binding.expr) {
          const patch = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'setAttr'), [
              targetId,
              t.stringLiteral(attrName),
              valueWithRegion,
            ]),
          )
          const fallback = t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'bindAttribute'), [
              targetId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          )
          if (
            !queueFusedPatch(binding.expr, {
              patch,
              fallback,
              patchHelper: 'setAttr',
              fallbackHelper: 'bindAttribute',
            })
          ) {
            ctx.helpersUsed.add('bindAttribute')
            statements.push(fallback)
          }
        } else {
          ctx.helpersUsed.add('setAttr')
          statements.push(
            t.expressionStatement(
              t.callExpression(runtimeIdentifier(ctx, 'setAttr'), [
                targetId,
                t.stringLiteral(attrName),
                valueWithRegion,
              ]),
            ),
          )
        }
      }
    } else if (binding.type === 'key' && binding.expr) {
      if (!shouldSuppressListKeyBindingExpression(binding.expr, ctx)) {
        statements.push(
          t.expressionStatement(lowerDomExpression(binding.expr, ctx, containingRegion)),
        )
      }
    } else if (binding.type === 'text' && binding.expr) {
      const valueExpr = lowerDomExpression(binding.expr, ctx, containingRegion)
      // Only use bindText for reactive expressions; static text uses direct assignment
      if (!isListKeyConstExpression(binding.expr, ctx) && isExpressionReactive(binding.expr, ctx)) {
        const patch = t.expressionStatement(
          t.callExpression(runtimeIdentifier(ctx, 'setText'), [targetId, valueExpr]),
        )
        const fallback = t.expressionStatement(
          t.callExpression(runtimeIdentifier(ctx, 'bindText'), [
            targetId,
            t.arrowFunctionExpression([], valueExpr),
          ]),
        )
        if (
          !queueFusedPatch(binding.expr, {
            patch,
            fallback,
            patchHelper: 'setText',
            fallbackHelper: 'bindText',
          })
        ) {
          ctx.helpersUsed.add('bindText')
          statements.push(fallback)
        }
      } else {
        // Static text: use the runtime formatter without creating an effect.
        ctx.helpersUsed.add('setText')
        statements.push(
          t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'setText'), [targetId, valueExpr]),
          ),
        )
      }
    } else if (binding.type === 'textContent' && binding.expr) {
      const valueExpr = lowerDomExpression(binding.expr, ctx, containingRegion)
      if (!isListKeyConstExpression(binding.expr, ctx) && isExpressionReactive(binding.expr, ctx)) {
        const patch = t.expressionStatement(
          t.callExpression(runtimeIdentifier(ctx, 'setTextContent'), [targetId, valueExpr]),
        )
        const fallback = t.expressionStatement(
          t.callExpression(runtimeIdentifier(ctx, 'bindTextContent'), [
            targetId,
            t.arrowFunctionExpression([], valueExpr),
          ]),
        )
        if (
          !queueFusedPatch(binding.expr, {
            patch,
            fallback,
            patchHelper: 'setTextContent',
            fallbackHelper: 'bindTextContent',
          })
        ) {
          ctx.helpersUsed.add('bindTextContent')
          statements.push(fallback)
        }
      } else {
        ctx.helpersUsed.add('setTextContent')
        statements.push(
          t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'setTextContent'), [targetId, valueExpr]),
          ),
        )
      }
    } else if (binding.type === 'child' && binding.expr) {
      // Child binding (dynamic expression at placeholder)
      // Pass the binding's namespace to ensure correct SVG/MathML context
      emitHIRChildBinding(
        targetId,
        binding.expr,
        statements,
        ctx,
        containingRegion,
        createHIRChildBindingOps(),
        binding.namespace,
      )
    }
  }

  flushFusedPatchGroups()

  // Restore previous region
  applyRegionToContext(ctx, prevRegion ?? null)

  // Restore previous namespace context
  ctx.namespaceContext = prevNamespace

  // Return element
  statements.push(t.returnStatement(elId))

  const body = t.blockStatement(statements)

  // Wrap in memo if region suggests memoization
  if (shouldMemo && containingRegion) {
    // __fictUseMemo returns a getter function - invoke it to get the actual DOM element
    const memoBody = t.arrowFunctionExpression([], body)
    if (ctx.inModule) {
      return t.callExpression(t.callExpression(runtimeIdentifier(ctx, 'memo'), [memoBody]), [])
    }
    const memoArgs: BabelCore.types.Expression[] = [contextIdentifier(ctx), memoBody]
    if (ctx.isComponentFn) {
      const slot = reserveHookSlot(ctx)
      if (slot >= 0) {
        memoArgs.push(t.numericLiteral(slot))
      }
    }
    return t.callExpression(t.callExpression(runtimeIdentifier(ctx, 'useMemo'), memoArgs), [])
  }

  // Wrap in IIFE
  return t.callExpression(t.arrowFunctionExpression([], body), [])
}

/**
 * Lower a JSX child to a Babel expression
 */
function lowerJSXChild(child: JSXChild, ctx: CodegenContext): BabelCore.types.Expression {
  const { t } = ctx

  if (child.kind === 'text') {
    return t.stringLiteral(child.value)
  } else if (child.kind === 'element') {
    return lowerJSXElement(child.value, ctx)
  } else {
    return applyRegionMetadataToExpression(lowerExpression(child.value, ctx), ctx)
  }
}

/**
 * Enhanced codegen that uses reactive scope information
 * This is the main entry point for HIR → fine-grained DOM generation
 */
export function codegenWithScopes(
  program: HIRProgram,
  scopes: ReactiveScopeResult | undefined,
  t: typeof BabelCore.types,
): BabelCore.types.File {
  const ctx = createCodegenContext(t)
  const originalBody = (program.originalBody ?? []) as BabelCore.types.Statement[]
  ctx.resumableEnabled = ctx.options?.resumable === true
  ctx.autoExtractEnabled = ctx.options?.autoExtractHandlers ?? ctx.resumableEnabled
  ctx.autoExtractThreshold = ctx.options?.autoExtractThreshold ?? 3
  ctx.programFunctions = new Map(
    program.functions.filter(fn => !!fn.name).map(fn => [fn.name as string, fn]),
  )
  ctx.jsxComponentNames = collectJSXComponentNames(originalBody, t)
  for (const name of collectExportedComponentNames(originalBody, t)) {
    ctx.jsxComponentNames.add(name)
  }
  ctx.jsxMemberComponentPaths = collectJSXMemberComponentPaths(originalBody, t)
  ctx.classComponentPaths = collectClassComponentPaths(originalBody, t)
  ctx.staticRestExclusionKeys = collectStaticRestExclusionKeys(originalBody, t)
  addDestructuredJSXComponentSourcePaths(program, ctx)
  seedSameFileHookAliasMetadata(program, originalBody, ctx, t)
  ctx.scopes = scopes

  // Mark tracked variables based on scope analysis
  if (scopes) {
    for (const scope of scopes.scopes) {
      for (const decl of scope.declarations) {
        const baseName = deSSAVarName(decl)
        ctx.trackedVars.add(baseName)
        // Derived variables (those with dependencies) are memos - shouldn't be cached
        if (scope.dependencies.size > 0) {
          ctx.memoVars?.add(baseName)
        }
      }
    }
  }

  const body: BabelCore.types.Statement[] = []
  for (const fn of program.functions) {
    const funcStmt = lowerFunctionWithScopes(fn, ctx)
    if (funcStmt) body.push(funcStmt)
  }

  return t.file(buildProgram(program, body, t))
}

/**
 * Lower a function with reactive scope information
 */
function lowerFunctionWithScopes(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  const prevKnownArrayVars = ctx.knownArrayVars
  const prevImportedReactiveKinds = ctx.importedReactiveKinds
  const prevHookFunctionAliases = ctx.hookFunctionAliases
  const prevHookFunctionMemberAliases = ctx.hookFunctionMemberAliases
  ctx.knownArrayVars = new Set(prevKnownArrayVars ?? [])
  ctx.importedReactiveKinds = new Map(prevImportedReactiveKinds ?? [])
  ctx.hookFunctionAliases = new Map(prevHookFunctionAliases ?? [])
  ctx.hookFunctionMemberAliases = new Map(prevHookFunctionMemberAliases ?? [])
  fn.params.forEach(p => ctx.knownArrayVars?.delete(deSSAVarName(p.name)))
  fn.params.forEach(p => ctx.importedReactiveKinds?.delete(deSSAVarName(p.name)))
  for (const name of collectLocalDeclaredNames(fn.params, fn.blocks, t)) {
    ctx.importedReactiveKinds?.delete(name)
  }
  const params = buildOutputParams(fn, ctx)
  const statements: BabelCore.types.Statement[] = []

  // Emit instructions with scope-aware transformations
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      const stmt = lowerInstructionWithScopes(instr, ctx)
      if (stmt) statements.push(stmt)
    }
    statements.push(...lowerTerminator(block, ctx))
  }

  const result = setNodeLoc(
    t.functionDeclaration(
      t.identifier(fn.name ?? 'fn'),
      params,
      buildFunctionBlock(fn, statements, t),
    ),
    fn.loc,
  )
  result.async = !!fn.meta?.isAsync || functionHasAsyncAwait(fn)
  result.generator = !!fn.meta?.isGenerator || functionHasYield(fn)
  ctx.knownArrayVars = prevKnownArrayVars
  ctx.importedReactiveKinds = prevImportedReactiveKinds
  ctx.hookFunctionAliases = prevHookFunctionAliases
  ctx.hookFunctionMemberAliases = prevHookFunctionMemberAliases
  return result
}

/**
 * Lower an instruction with reactive scope awareness
 */
function lowerInstructionWithScopes(
  instr: Instruction,
  ctx: CodegenContext,
): BabelCore.types.Statement | null {
  const { t } = ctx
  const applyLoc = <T extends BabelCore.types.Statement | null>(stmt: T): T => {
    if (!stmt) return stmt
    const baseLoc =
      instr.loc ??
      (instr.kind === 'Assign' || instr.kind === 'Expression' ? instr.value.loc : undefined)
    return setNodeLoc(stmt, baseLoc) as T
  }

  if (instr.kind === 'Assign') {
    const targetName = instr.target.name
    const targetBase = deSSAVarName(targetName)
    const isFunctionDecl =
      instr.value.kind === 'FunctionExpression' &&
      (instr.declarationKind === 'function' ||
        (!instr.declarationKind && !instr.isMutation && instr.value.name === targetBase))
    if (isFunctionDecl) {
      const loweredFn = lowerExpression(instr.value, ctx)
      if (t.isFunctionExpression(loweredFn)) {
        return applyLoc(
          t.functionDeclaration(
            t.identifier(targetBase),
            loweredFn.params as BabelCore.types.Identifier[],
            loweredFn.body as BabelCore.types.BlockStatement,
            loweredFn.generator ?? false,
            loweredFn.async ?? false,
          ),
        )
      }
    }
    const declKind = instr.declarationKind === 'function' ? undefined : instr.declarationKind
    if (!declKind) {
      assertWritableImportedReactiveIdentifier(targetBase, ctx, instr.loc ?? instr.value.loc)
    }
    const listKeyAliasReplacement = declKind
      ? getListKeyAliasReplacementName(targetBase, ctx)
      : null
    if (declKind && listKeyAliasReplacement) {
      markKnownArrayInitializer(targetBase, instr.value, ctx, true)
      return applyLoc(
        t.variableDeclaration(declKind, [
          t.variableDeclarator(t.identifier(targetBase), t.identifier(listKeyAliasReplacement)),
        ]),
      )
    }
    markKnownArrayInitializer(targetBase, instr.value, ctx, !!declKind)
    let valueExpr: BabelCore.types.Expression
    const lowerInitializerExpression = (): BabelCore.types.Expression => {
      const prevObjectLiteralPath = ctx.objectLiteralPath
      const prevComponentWrapperName = ctx.componentWrapperName
      if (instr.value.kind === 'ObjectExpression') {
        ctx.objectLiteralPath = [targetBase]
      }
      if (isComponentName(targetBase) && isJSXIdentifierComponentName(targetBase, ctx)) {
        ctx.componentWrapperName = targetBase
      }
      try {
        return lowerExpression(instr.value, ctx)
      } finally {
        ctx.objectLiteralPath = prevObjectLiteralPath
        ctx.componentWrapperName = prevComponentWrapperName
      }
    }
    if (declKind && getReactiveCallKind(instr.value, ctx) === 'signal') {
      ctx.signalVars?.add(targetBase)
      ctx.trackedVars.add(targetBase)
      markCallableSignalIfFunctionValue(targetBase, instr.value, ctx)
      markNonSerializableSignalIfFunctionValue(targetBase, instr.value, ctx)
      ctx.currentAssignmentName = targetBase
      try {
        valueExpr = lowerInitializerExpression()
      } finally {
        ctx.currentAssignmentName = undefined
      }
    } else {
      valueExpr = lowerInitializerExpression()
    }

    // Check if target is a tracked variable (use de-versioned name for lookup)
    if (ctx.trackedVars.has(targetBase) && !(ctx.functionVars?.has(targetBase) ?? false)) {
      if (expressionNeedsAsyncContext(instr.value)) {
        if (declKind) {
          return applyLoc(
            t.variableDeclaration(declKind, [
              t.variableDeclarator(t.identifier(targetName), valueExpr),
            ]),
          )
        }
        return applyLoc(
          t.expressionStatement(t.assignmentExpression('=', t.identifier(targetName), valueExpr)),
        )
      }
      // Wrap in memo if it depends on other tracked vars
      ctx.helpersUsed.add('useMemo')
      return applyLoc(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(targetName),
            t.callExpression(runtimeIdentifier(ctx, 'useMemo'), [
              t.arrowFunctionExpression([], valueExpr),
            ]),
          ),
        ]),
      )
    }

    // Check if this is a declaration or just an assignment
    if (declKind) {
      // Actual declaration - emit variableDeclaration
      return applyLoc(
        t.variableDeclaration(declKind, [
          t.variableDeclarator(t.identifier(targetName), valueExpr),
        ]),
      )
    } else {
      // Pure assignment (e.g. api = {...}) - emit assignmentExpression to update existing variable
      return applyLoc(
        t.expressionStatement(t.assignmentExpression('=', t.identifier(targetName), valueExpr)),
      )
    }
  }

  if (instr.kind === 'Expression') {
    return applyLoc(t.expressionStatement(lowerExpression(instr.value, ctx)))
  }

  if (instr.kind === 'Debugger') {
    return applyLoc(t.debuggerStatement())
  }

  return applyLoc(null)
}

// ============================================================================
// Region-Based Codegen (P0 Integration)
// ============================================================================

interface MacroAliases {
  state?: Set<string>
  effect?: Set<string>
  memo?: Set<string>
  store?: Set<string>
  strictMacroBindings?: boolean
}

interface GeneratedFunctionEntry {
  fn: HIRFunction
  stmt: BabelCore.types.FunctionDeclaration
}

function buildFunctionDeclaratorExpression(
  entry: GeneratedFunctionEntry,
  t: typeof BabelCore.types,
): BabelCore.types.FunctionExpression | BabelCore.types.ArrowFunctionExpression {
  const { fn, stmt } = entry
  const isAsync = !!(fn.meta?.isAsync || stmt.async)
  const isGenerator = !!(fn.meta?.isGenerator || stmt.generator)

  if (fn.meta?.fromExpression && fn.meta.isArrow) {
    let arrowBody: BabelCore.types.BlockStatement | BabelCore.types.Expression = stmt.body
    if (fn.meta.hasExpressionBody) {
      const bodyStatements = stmt.body.body
      if (
        bodyStatements.length === 1 &&
        t.isReturnStatement(bodyStatements[0]) &&
        bodyStatements[0].argument
      ) {
        arrowBody = bodyStatements[0].argument
      }
    }
    const arrow = t.arrowFunctionExpression(stmt.params, arrowBody)
    arrow.async = isAsync
    return arrow
  }

  if (fn.meta?.fromExpression) {
    const expressionName = fn.meta.functionExpressionName
    return t.functionExpression(
      expressionName ? t.identifier(expressionName) : null,
      stmt.params,
      stmt.body,
      isGenerator,
      isAsync,
    )
  }

  return t.functionExpression(
    stmt.id ? t.identifier(stmt.id.name) : null,
    stmt.params,
    stmt.body,
    isGenerator,
    isAsync,
  )
}

function buildDefaultExportFunctionDeclaration(
  entry: GeneratedFunctionEntry,
  t: typeof BabelCore.types,
): BabelCore.types.FunctionDeclaration {
  if (!entry.fn.meta?.anonymousDefaultExport) {
    return entry.stmt
  }
  const decl = t.functionDeclaration(
    null,
    entry.stmt.params,
    entry.stmt.body,
    entry.stmt.generator,
    entry.stmt.async,
  )
  if (entry.stmt.loc !== undefined) {
    decl.loc = entry.stmt.loc
  }
  return decl
}

/**
 * Lower HIR to Babel AST with full region-based reactive scope analysis.
 * This is the P0 integration point that bridges:
 * - HIR analysis passes (scopes, shapes, control flow)
 * - Region generation (scope-to-region conversion)
 * - Fine-grained DOM helpers (memo wrappers, bindings)
 */
export function lowerHIRWithRegions(
  program: HIRProgram,
  t: typeof BabelCore.types,
  options?: FictCompilerOptions,
  macroAliases?: MacroAliases,
): BabelCore.types.File {
  const ctx = createCodegenContext(t)
  ctx.programFunctions = new Map(
    program.functions.filter(fn => !!fn.name).map(fn => [fn.name as string, fn]),
  )
  ctx.options = options
  const originalBody = (program.originalBody ?? []) as BabelCore.types.Statement[]
  ctx.jsxComponentNames = collectJSXComponentNames(originalBody, t)
  for (const name of collectExportedComponentNames(originalBody, t)) {
    ctx.jsxComponentNames.add(name)
  }
  ctx.jsxMemberComponentPaths = collectJSXMemberComponentPaths(originalBody, t)
  ctx.classComponentPaths = collectClassComponentPaths(originalBody, t)
  ctx.staticRestExclusionKeys = collectStaticRestExclusionKeys(originalBody, t)
  addDestructuredJSXComponentSourcePaths(program, ctx)
  ctx.resumableEnabled = options?.resumable === true
  // Auto-extract defaults to true when resumable is enabled, unless explicitly disabled
  ctx.autoExtractEnabled = options?.autoExtractHandlers ?? options?.resumable === true
  ctx.autoExtractThreshold = options?.autoExtractThreshold ?? 3
  const body: BabelCore.types.Statement[] = []
  const topLevelAliases = new Set<string>()
  let topLevelCtxInjected = false
  const emittedFunctionNames = new Set<string>()
  ctx.moduleDeclaredNames = collectDeclaredNames(originalBody, t)
  ctx.moduleBindingKinds = collectModuleBindingKinds(originalBody, t)
  const runtimeImports = collectRuntimeImports(originalBody, t)
  ctx.moduleRuntimeNames = runtimeImports.names
  ctx.moduleRuntimeImportMap = runtimeImports.importMap
  ctx.moduleRuntimeImportSources = runtimeImports.importSources
  ctx.moduleRuntimeNamespaceImports = runtimeImports.namespaces
  ctx.moduleRuntimeNamespaceImportSources = runtimeImports.namespaceSources
  applyImportedReactiveMetadata(originalBody, ctx, t, options, {
    markImportedHook(localName, hasMetadata) {
      const base = deSSAVarName(localName)
      ctx.opaqueImportedHookNames = ctx.opaqueImportedHookNames ?? new Set()
      if (hasMetadata) {
        ctx.opaqueImportedHookNames.delete(base)
      } else {
        ctx.opaqueImportedHookNames.add(base)
      }
    },
    setImportedHookInfo(localName, info) {
      const baseName = deSSAVarName(localName)
      ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
      ctx.hookReturnInfo.set(baseName, deserializeHookReturnInfo(info))
      markImportedHookReturnInfoName(baseName, ctx)
    },
  })
  const stateMacroNames = new Set<string>(['$state', ...(macroAliases?.state ?? [])])
  const memoMacroNames = new Set<string>(macroAliases?.memo ?? ctx.memoMacroNames ?? [])
  if (!memoMacroNames.has('$memo')) memoMacroNames.add('$memo')
  if (!memoMacroNames.has('createMemo')) memoMacroNames.add('createMemo')
  const storeMacroNames = new Set<string>(macroAliases?.store ?? ctx.storeMacroNames ?? [])
  if (!storeMacroNames.has('$store')) storeMacroNames.add('$store')
  ctx.stateMacroNames = stateMacroNames
  ctx.memoMacroNames = memoMacroNames
  ctx.storeMacroNames = storeMacroNames
  ctx.strictMacroBindings = macroAliases?.strictMacroBindings ?? false
  seedSameFileHookAliasMetadata(program, originalBody, ctx, t)

  // Pre-mark top-level tracked variables so nested functions can treat captured signals as reactive
  for (const stmt of originalBody) {
    const declaration = t.isVariableDeclaration(stmt)
      ? stmt
      : t.isExportNamedDeclaration(stmt) &&
          stmt.declaration &&
          t.isVariableDeclaration(stmt.declaration)
        ? stmt.declaration
        : null
    if (!declaration) continue
    for (const decl of declaration.declarations) {
      if (
        t.isIdentifier(decl.id) &&
        decl.init &&
        (t.isCallExpression(decl.init) || t.isOptionalCallExpression(decl.init))
      ) {
        const callKind = getReactiveCallKindFromBabel(decl.init, ctx, t)
        markHookReactiveLocal(decl.id.name, callKind, ctx)
      }
    }
  }
  const ensureTopLevelCtx = () => {
    if (topLevelCtxInjected) return
    ctx.helpersUsed.add('pushContext')
    body.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          moduleContextIdentifier(ctx),
          t.callExpression(runtimeIdentifier(ctx, 'pushContext'), []),
        ),
      ]),
    )
    topLevelCtxInjected = true
  }

  // Map generated functions by name for replacement when walking original body
  const generatedFunctions = new Map<string, GeneratedFunctionEntry>()
  for (const fn of program.functions) {
    const funcStmt = lowerFunctionWithRegions(fn, ctx)
    if (funcStmt && fn.name) {
      const stmt = isHookName(fn.name)
        ? (preserveHookReturnAccessorsInStatement(
            funcStmt,
            ctx,
          ) as BabelCore.types.FunctionDeclaration)
        : funcStmt
      generatedFunctions.set(fn.name, { fn, stmt })
    } else if (funcStmt && !fn.name) {
      // Anonymous function - emit immediately
      body.push(funcStmt)
    }
  }

  const lowerableBuffer: BabelCore.types.Statement[] = []
  let segmentCounter = 0

  const flushLowerableBuffer = () => {
    if (lowerableBuffer.length === 0) return
    const { statements, aliases } = lowerTopLevelStatementBlock(
      lowerableBuffer,
      ctx,
      t,
      `__module_segment_${segmentCounter++}`,
      topLevelAliases,
    )
    topLevelAliases.clear()
    aliases.forEach(a => topLevelAliases.add(a))
    if (statements.length > 0 && ctx.needsCtx && !topLevelCtxInjected) {
      ensureTopLevelCtx()
    }
    body.push(...statements)
    lowerableBuffer.length = 0
  }
  const takeDefaultExportExpression = (): GeneratedFunctionEntry | null => {
    for (const [name, entry] of generatedFunctions.entries()) {
      if (entry.fn.meta?.defaultExportExpression) {
        generatedFunctions.delete(name)
        return entry
      }
    }
    return null
  }
  const lowerRawStatement = <T extends BabelCore.types.Statement>(stmt: T): T =>
    lowerRawJSXInBabelNode(t.cloneNode(stmt, true) as T, ctx)

  // Rebuild program body preserving original order
  for (const stmt of originalBody as BabelCore.types.Statement[]) {
    if (isTypeOnlyRuntimeOmittedStatement(stmt, t)) {
      flushLowerableBuffer()
      continue
    }

    if (isTypeScriptOnlyTopLevelStatement(stmt, t)) {
      flushLowerableBuffer()
      body.push(stmt)
      continue
    }

    if (t.isImportDeclaration(stmt)) {
      flushLowerableBuffer()
      const runtimeImport = runtimeImportDeclaration(stmt, t)
      if (runtimeImport) body.push(runtimeImport)
      continue
    }

    if (t.isBlockStatement(stmt)) {
      flushLowerableBuffer()
      const { statements, aliases } = lowerTopLevelStatementBlock(
        stmt.body as BabelCore.types.Statement[],
        ctx,
        t,
        `__block_segment_${segmentCounter++}`,
        topLevelAliases,
      )
      topLevelAliases.clear()
      aliases.forEach(a => topLevelAliases.add(a))
      body.push(t.blockStatement(statements))
      continue
    }

    // Function declarations
    if (t.isFunctionDeclaration(stmt) && stmt.id?.name) {
      flushLowerableBuffer()
      const generated = generatedFunctions.get(stmt.id.name)
      if (generated) {
        body.push(generated.stmt)
        generatedFunctions.delete(stmt.id.name)
        emittedFunctionNames.add(stmt.id.name)
        continue
      }
      body.push(stmt)
      emittedFunctionNames.add(stmt.id.name)
      continue
    }

    // Export named with function declaration
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
      flushLowerableBuffer()
      const runtimeExport = runtimeExportNamedDeclaration(stmt, t)
      if (!runtimeExport) {
        continue
      }
      if (runtimeExport !== stmt) {
        body.push(lowerRawStatement(runtimeExport))
        continue
      }
      if (isTypeScriptOnlyTopLevelStatement(stmt.declaration, t)) {
        body.push(lowerRawStatement(stmt))
        continue
      }
      if (t.isFunctionDeclaration(stmt.declaration) && stmt.declaration.id?.name) {
        const name = stmt.declaration.id.name
        const generated = generatedFunctions.get(name)
        if (generated) {
          body.push(t.exportNamedDeclaration(generated.stmt, []))
          generatedFunctions.delete(name)
          emittedFunctionNames.add(name)
          continue
        }
      }
      if (t.isVariableDeclaration(stmt.declaration)) {
        const rebuiltDeclarators: typeof stmt.declaration.declarations = []
        let rebuilt = false

        for (const decl of stmt.declaration.declarations) {
          if (t.isIdentifier(decl.id)) {
            const found = generatedFunctions.get(decl.id.name)
            if (found) {
              rebuilt = true
              rebuiltDeclarators.push(
                t.variableDeclarator(decl.id, buildFunctionDeclaratorExpression(found, t)),
              )
              generatedFunctions.delete(decl.id.name)
              emittedFunctionNames.add(decl.id.name)
              continue
            }
          }
          rebuiltDeclarators.push(decl)
        }

        if (rebuilt) {
          body.push(
            t.exportNamedDeclaration(
              t.variableDeclaration(stmt.declaration.kind, rebuiltDeclarators),
              [],
            ),
          )
          continue
        }

        const { statements, aliases } = lowerTopLevelStatementBlock(
          [stmt.declaration],
          ctx,
          t,
          `__export_segment_${segmentCounter++}`,
          topLevelAliases,
        )
        topLevelAliases.clear()
        aliases.forEach(a => topLevelAliases.add(a))
        if (statements.length > 0) {
          if (ctx.needsCtx && !topLevelCtxInjected) {
            ensureTopLevelCtx()
          }
          statements
            .filter(s => t.isDeclaration(s))
            .forEach(d => body.push(t.exportNamedDeclaration(d as BabelCore.types.Declaration, [])))
          continue
        }
      }
      body.push(lowerRawStatement(stmt))
      continue
    }

    if (t.isExportNamedDeclaration(stmt)) {
      flushLowerableBuffer()
      const runtimeExport = runtimeExportNamedDeclaration(stmt, t)
      if (runtimeExport) body.push(lowerRawStatement(runtimeExport))
      continue
    }

    // Export default function declaration
    if (t.isExportDefaultDeclaration(stmt) && t.isFunctionDeclaration(stmt.declaration)) {
      flushLowerableBuffer()
      const name = stmt.declaration.id?.name ?? '__default'
      const generated = generatedFunctions.get(name)
      if (generated) {
        body.push(t.exportDefaultDeclaration(buildDefaultExportFunctionDeclaration(generated, t)))
        generatedFunctions.delete(name)
        emittedFunctionNames.add(name)
        continue
      }
      body.push(lowerRawStatement(stmt))
      if (stmt.declaration.id?.name) emittedFunctionNames.add(stmt.declaration.id.name)
      continue
    }

    if (
      t.isExportDefaultDeclaration(stmt) &&
      (t.isArrowFunctionExpression(stmt.declaration) || t.isFunctionExpression(stmt.declaration))
    ) {
      flushLowerableBuffer()
      const generated = takeDefaultExportExpression()
      if (generated) {
        body.push(t.exportDefaultDeclaration(buildFunctionDeclaratorExpression(generated, t)))
        if (generated.fn.name) emittedFunctionNames.add(generated.fn.name)
        continue
      }
      body.push(lowerRawStatement(stmt))
      continue
    }

    if (t.isExportDefaultDeclaration(stmt) && t.isExpression(stmt.declaration)) {
      flushLowerableBuffer()
      const defaultExpr = stmt.declaration
      const isStaticImportedNamespaceMemberDefault =
        t.isMemberExpression(defaultExpr) &&
        t.isIdentifier(defaultExpr.object) &&
        getImportedNamespaceMetadata(defaultExpr.object.name, ctx) !== undefined &&
        ((!defaultExpr.computed && t.isIdentifier(defaultExpr.property)) ||
          t.isStringLiteral(defaultExpr.property) ||
          t.isNumericLiteral(defaultExpr.property))
      if (isStaticImportedNamespaceMemberDefault) {
        body.push(lowerRawStatement(stmt))
        continue
      }
      const name = `__default_export_value_${segmentCounter++}`
      const declaration = t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(name), defaultExpr),
      ])
      const { statements, aliases } = lowerTopLevelStatementBlock(
        [declaration],
        ctx,
        t,
        `__default_export_segment_${segmentCounter++}`,
        topLevelAliases,
      )
      topLevelAliases.clear()
      aliases.forEach(a => topLevelAliases.add(a))
      if (statements.length > 0) {
        if (ctx.needsCtx && !topLevelCtxInjected) {
          ensureTopLevelCtx()
        }
        body.push(...statements)
        body.push(t.exportDefaultDeclaration(t.identifier(name)))
        continue
      }
      body.push(lowerRawStatement(stmt))
      continue
    }

    if (t.isExportDefaultDeclaration(stmt)) {
      flushLowerableBuffer()
      body.push(lowerRawStatement(stmt))
      continue
    }

    if (t.isExportAllDeclaration(stmt)) {
      flushLowerableBuffer()
      if (!isTypeOnlyKind(stmt.exportKind)) {
        body.push(lowerRawStatement(stmt))
      }
      continue
    }

    // Variable declarations that were converted to generated functions
    if (t.isVariableDeclaration(stmt)) {
      const remainingDeclarators: typeof stmt.declarations = []
      let rebuilt = false
      const rebuiltDeclarators: typeof stmt.declarations = []

      for (const decl of stmt.declarations) {
        if (t.isIdentifier(decl.id)) {
          const found = generatedFunctions.get(decl.id.name)
          if (found) {
            rebuilt = true
            const funcExpr = buildFunctionDeclaratorExpression(found, t)
            rebuiltDeclarators.push(t.variableDeclarator(decl.id, funcExpr))
            generatedFunctions.delete(decl.id.name)
            continue
          }
        }
        remainingDeclarators.push(decl)
        rebuiltDeclarators.push(decl)
      }

      if (rebuilt) {
        flushLowerableBuffer()
        if (rebuiltDeclarators.length > 0) {
          lowerableBuffer.push(t.variableDeclaration(stmt.kind, rebuiltDeclarators))
        } else if (remainingDeclarators.length > 0) {
          lowerableBuffer.push(t.variableDeclaration(stmt.kind, remainingDeclarators))
        }
        continue
      }
    }

    lowerableBuffer.push(stmt)
  }

  flushLowerableBuffer()

  if (
    ctx.resumableEnabled &&
    ctx.hoistedResumableStatements &&
    ctx.hoistedResumableStatements.length > 0
  ) {
    body.push(...ctx.hoistedResumableStatements)
  }

  // Emit any remaining generated functions (not present in original order)
  for (const func of generatedFunctions.values()) {
    body.push(func.stmt)
    if (func.stmt.id?.name) emittedFunctionNames.add(func.stmt.id.name)
  }

  if (topLevelCtxInjected) {
    ctx.helpersUsed.add('popContext')
    body.push(t.expressionStatement(t.callExpression(runtimeIdentifier(ctx, 'popContext'), [])))
  }

  for (let index = 0; index < body.length; index++) {
    body[index] = preserveTopLevelHookReturnAccessorsInStatement(body[index]!, ctx)
  }

  propagateLocalHookAliasMetadata(originalBody, ctx, t)

  const moduleMeta = buildModuleReactiveMetadata(originalBody, ctx, t, options, {
    getLocalHookInfo(localName) {
      const info = getHookReturnInfo(localName, ctx)
      return info ? serializeHookReturnInfo(info) : undefined
    },
  })
  setModuleMetadata(options?.filename, moduleMeta, options)
  return t.file(buildProgram(program, attachHelperImports(ctx, body, t), t))
}

/**
 * Lower a sequence of top-level statements (non-import/export) using the HIR region path.
 */
function lowerTopLevelStatementBlock(
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  t: typeof BabelCore.types,
  name = '__module_segment',
  existingAliases?: Set<string>,
): { statements: BabelCore.types.Statement[]; aliases: Set<string> } {
  if (statements.length === 0) return { statements: [], aliases: new Set() }

  const reactiveScopes = ctx.options?.reactiveScopes
  const fn = convertStatementsToHIRFunction(
    name,
    statements,
    reactiveScopes && reactiveScopes.length > 0
      ? { reactiveScopes: new Set(reactiveScopes) }
      : undefined,
  )
  addDestructuredJSXComponentSourcePathsFromFunctions([fn], ctx)
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  detectDerivedCycles(fn, scopeResult, ctx)
  ctx.scopes = scopeResult

  const regionResult = generateRegions(fn, scopeResult)
  ctx.regions = flattenRegions(regionResult.topLevelRegions)
  if (ctx.nextHookSlot === undefined) {
    ctx.nextHookSlot = HOOK_SLOT_BASE
  }
  const aliasVars = existingAliases ? new Set(existingAliases) : new Set<string>()
  ctx.aliasVars = aliasVars

  const functionVars = ctx.functionVars ?? new Set<string>()
  const functionBindingKinds = ctx.functionBindingKinds ?? new Map<string, ModuleBindingKind>()
  const signalVars = ctx.signalVars ?? new Set<string>()
  const callableSignalVars = ctx.callableSignalVars ?? new Set<string>()
  const nonSerializableSignalVars = ctx.nonSerializableSignalVars ?? new Set<string>()
  const storeVars = ctx.storeVars ?? new Set<string>()
  const memoVars = ctx.memoVars ?? new Set<string>()
  const mutatedVars = new Set<string>()
  const memberMutatedVars = new Set<string>()
  ctx.functionVars = functionVars
  ctx.functionBindingKinds = functionBindingKinds
  ctx.signalVars = signalVars
  ctx.callableSignalVars = callableSignalVars
  ctx.nonSerializableSignalVars = nonSerializableSignalVars
  ctx.storeVars = storeVars
  ctx.memoVars = memoVars
  ctx.mutatedVars = mutatedVars
  ctx.memberMutatedVars = memberMutatedVars

  // Initialize componentFunctionDefs for this component to track function definitions
  // These may need to be hoisted for handler dependency resolution
  const componentFunctionDefs = ctx.componentFunctionDefs ?? new Map<string, Expression>()
  const componentFunctionMutations = ctx.componentFunctionMutations ?? new Map<string, string[]>()
  ctx.componentFunctionDefs = componentFunctionDefs
  ctx.componentFunctionMutations = componentFunctionMutations

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        if (instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression') {
          functionVars.add(target)
          functionBindingKinds.set(target, instr.declarationKind ?? 'unknown')
          // Store the HIR expression for potential hoisting in handlers
          componentFunctionDefs.set(target, instr.value)
          if (signalVars.has(target)) {
            callableSignalVars.add(target)
            nonSerializableSignalVars.add(target)
          }
        }
        if (
          instr.value.kind === 'CallExpression' ||
          instr.value.kind === 'OptionalCallExpression'
        ) {
          const callKind = getReactiveCallKind(instr.value, ctx)
          if (callKind === 'signal') {
            signalVars.add(target)
            if (isCallableSignalInitializer(instr.value, ctx)) {
              callableSignalVars.add(target)
            }
            if (isNonSerializableSignalInitializer(instr.value, ctx)) {
              nonSerializableSignalVars.add(target)
            }
          } else if (callKind === 'store') {
            storeVars.add(target)
          } else if (callKind === 'memo') {
            memoVars.add(target)
          }
        }
        if (!instr.declarationKind) {
          mutatedVars.add(target)
        }
      } else if (instr.kind === 'Expression') {
        markCallableSignalAssignmentValue(instr.value, ctx)
      } else if (instr.kind === 'Phi') {
        mutatedVars.add(deSSAVarName(instr.target.name))
      }
    }
  }
  collectMutatedIdentifiers(fn).forEach(name => mutatedVars.add(name))
  collectMemberMutatedIdentifiers(fn).forEach(name => memberMutatedVars.add(name))
  for (const [name, mutations] of collectFunctionDependencyMutations(fn, functionVars)) {
    componentFunctionMutations.set(name, mutations)
  }

  const reactive = computeReactiveAccessors(fn, ctx)
  ctx.trackedVars = reactive.tracked
  ctx.memoVars = reactive.memo
  ctx.controlDepsByInstr = reactive.controlDepsByInstr
  if (fn.name && isHookName(fn.name)) {
    const info = analyzeHookReturnInfo(fn, ctx)
    if (info) {
      ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
      ctx.hookReturnInfo.set(fn.name, info)
    }
  }

  const prevInModule = ctx.inModule
  const prevLocalDeclared = ctx.localDeclaredNames
  const prevCurrentFunctionDeclared = ctx.currentFunctionDeclaredNames
  const currentFunctionDeclared = collectLocalDeclaredNames(fn.params, fn.blocks, t)
  const topLevelDeclared = new Set(prevLocalDeclared ?? [])
  for (const declaredName of currentFunctionDeclared) {
    topLevelDeclared.add(declaredName)
  }
  ctx.localDeclaredNames = topLevelDeclared
  ctx.currentFunctionDeclaredNames = currentFunctionDeclared
  ctx.inModule = true
  try {
    const lowered = generateRegionCode(fn, scopeResult, t, ctx)
    return { statements: lowered, aliases: aliasVars }
  } finally {
    ctx.inModule = prevInModule
    ctx.localDeclaredNames = prevLocalDeclared
    ctx.currentFunctionDeclaredNames = prevCurrentFunctionDeclared
  }
}

function transformControlFlowReturns(
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): BabelCore.types.Statement[] | null {
  if (ctx.options?.lazyConditional === false) {
    return null
  }

  const { t } = ctx
  const reactiveAccessorNames = new Set<string>([
    ...ctx.trackedVars,
    ...(ctx.signalVars ?? []),
    ...(ctx.memoVars ?? []),
    ...(ctx.aliasVars ?? []),
    ...(ctx.storeVars ?? []),
  ])

  const toStatements = (node: BabelCore.types.Statement | BabelCore.types.BlockStatement) =>
    t.isBlockStatement(node) ? node.body : [node]

  const endsWithReturn = (stmts: BabelCore.types.Statement[]): boolean => {
    if (stmts.length === 0) return false
    const tail = stmts[stmts.length - 1]!
    if (t.isReturnStatement(tail)) return true
    if (t.isBlockStatement(tail)) {
      return endsWithReturn(tail.body)
    }
    if (t.isIfStatement(tail) && tail.consequent && tail.alternate) {
      const conseqStmts = toStatements(tail.consequent)
      const altStmts = toStatements(tail.alternate)
      return endsWithReturn(conseqStmts) && endsWithReturn(altStmts)
    }
    if (t.isTryStatement(tail)) {
      if (tail.finalizer && endsWithReturn(tail.finalizer.body)) return true
      if (!tail.handler) return false
      return endsWithReturn(tail.block.body) && endsWithReturn(tail.handler.body.body)
    }
    return false
  }

  function hasNodeMatch(
    nodes: BabelCore.types.Node[],
    predicate: (node: BabelCore.types.Node) => boolean,
    options?: { skipNestedFunctions?: boolean },
  ): boolean {
    let found = false

    const visit = (node: BabelCore.types.Node | null | undefined, isRoot = false): void => {
      if (!node || found) return
      if (
        !isRoot &&
        options?.skipNestedFunctions &&
        (t.isFunctionExpression(node) ||
          t.isArrowFunctionExpression(node) ||
          t.isFunctionDeclaration(node) ||
          t.isObjectMethod(node) ||
          t.isClassMethod(node))
      ) {
        return
      }
      if (predicate(node)) {
        found = true
        return
      }

      const keys = (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS
      const visitorKeys = keys?.[(node as { type: string }).type] ?? []
      for (const key of visitorKeys) {
        const value = (node as unknown as Record<string, unknown>)[key]
        if (Array.isArray(value)) {
          for (const child of value) {
            if (child && typeof child === 'object' && 'type' in (child as object)) {
              visit(child as BabelCore.types.Node)
            }
            if (found) return
          }
        } else if (value && typeof value === 'object' && 'type' in (value as object)) {
          visit(value as BabelCore.types.Node)
        }
        if (found) return
      }
    }

    for (const node of nodes) {
      visit(node, true)
      if (found) return true
    }

    return found
  }

  const containsReturnStatement = (nodes: BabelCore.types.Node[]) =>
    hasNodeMatch(nodes, node => t.isReturnStatement(node))
  const containsNonNestedReturnStatement = (nodes: BabelCore.types.Node[]) =>
    hasNodeMatch(nodes, node => t.isReturnStatement(node), { skipNestedFunctions: true })

  const getMemberRootIdentifier = (
    expr: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
  ): BabelCore.types.Identifier | null => {
    let current: BabelCore.types.Expression = expr.object as BabelCore.types.Expression
    while (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) {
      current = current.object as BabelCore.types.Expression
    }
    return t.isIdentifier(current) ? current : null
  }
  const getStaticBabelPropertyName = (
    property: BabelCore.types.Expression | BabelCore.types.PrivateName,
    computed: boolean | null | undefined,
  ): string | null => {
    if (!computed && t.isIdentifier(property)) return property.name
    if (t.isStringLiteral(property) || t.isNumericLiteral(property)) return String(property.value)
    return null
  }
  const isNamespaceStoreMemberExpression = (
    expr: BabelCore.types.Expression | null | undefined,
  ): boolean => {
    if (!expr) return false
    if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
      if (t.isIdentifier(expr.object)) {
        const nsMeta = getImportedNamespaceMetadata(expr.object.name, ctx)
        const propName = getStaticBabelPropertyName(expr.property, expr.computed)
        if (nsMeta && propName && nsMeta.exports[propName] === 'store') {
          return true
        }
      }
      return isNamespaceStoreMemberExpression(expr.object as BabelCore.types.Expression)
    }
    return false
  }

  const containsReactiveAccessorRead = (
    nodes: BabelCore.types.Node[],
    options?: { skipNestedFunctions?: boolean },
  ) =>
    hasNodeMatch(
      nodes,
      node => {
        if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
          const callee = node.callee
          return t.isIdentifier(callee) && reactiveAccessorNames.has(callee.name)
        }
        if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
          const root = getMemberRootIdentifier(node)
          return (
            !!(root && reactiveAccessorNames.has(root.name)) ||
            isNamespaceStoreMemberExpression(node)
          )
        }
        return false
      },
      options,
    )

  const containsReactiveControlFlowRead = (nodes: BabelCore.types.Node[]): boolean =>
    hasNodeMatch(
      nodes,
      node => {
        if (t.isIfStatement(node)) {
          return containsReactiveAccessorRead([node.test], { skipNestedFunctions: true })
        }
        if (t.isSwitchStatement(node)) {
          return containsReactiveAccessorRead([node.discriminant], { skipNestedFunctions: true })
        }
        if (t.isConditionalExpression(node)) {
          return containsReactiveAccessorRead([node.test], { skipNestedFunctions: true })
        }
        if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
          return containsReactiveAccessorRead([node.test], { skipNestedFunctions: true })
        }
        if (t.isForStatement(node)) {
          const parts: BabelCore.types.Node[] = []
          if (node.init) parts.push(node.init)
          if (node.test) parts.push(node.test)
          if (node.update) parts.push(node.update)
          return (
            parts.length > 0 && containsReactiveAccessorRead(parts, { skipNestedFunctions: true })
          )
        }
        if (t.isForOfStatement(node) || t.isForInStatement(node)) {
          return containsReactiveAccessorRead([node.right], { skipNestedFunctions: true })
        }
        return false
      },
      { skipNestedFunctions: true },
    )

  const findUnsafeReactiveLoopReturn = (
    nodes: BabelCore.types.Node[],
  ): BabelCore.types.Statement | null => {
    let found: BabelCore.types.Statement | null = null
    hasNodeMatch(
      nodes,
      node => {
        if (
          !(
            t.isForStatement(node) ||
            t.isWhileStatement(node) ||
            t.isDoWhileStatement(node) ||
            t.isForOfStatement(node) ||
            t.isForInStatement(node)
          )
        ) {
          return false
        }
        if (!containsNonNestedReturnStatement([node.body])) {
          return false
        }
        if (!containsReactiveAccessorRead([node], { skipNestedFunctions: true })) {
          return false
        }
        found = node
        return true
      },
      { skipNestedFunctions: true },
    )
    return found
  }

  const hasRiskyBranchControlFlow = (stmts: BabelCore.types.Statement[]): boolean => {
    if (stmts.length === 0) return false
    return containsReactiveControlFlowRead(stmts)
  }

  const isJSXLikeNode = (node: BabelCore.types.Node | null | undefined): boolean =>
    !!node && (t.isJSXElement(node) || t.isJSXFragment(node))

  const isStoreSourceExpression = (expr: BabelCore.types.Expression): boolean => {
    if (t.isIdentifier(expr)) {
      return !!ctx.storeVars?.has(expr.name)
    }
    if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) {
      if (isNamespaceStoreMemberExpression(expr)) return true
      const root = getMemberRootIdentifier(expr)
      return !!(root && ctx.storeVars?.has(root.name))
    }
    return false
  }

  const hasRiskyStoreDestructureRead = (stmt: BabelCore.types.Statement): boolean => {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (!decl.init) continue
        const hasPattern = t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)
        if (!hasPattern) continue
        if (isStoreSourceExpression(decl.init as BabelCore.types.Expression)) {
          return true
        }
      }
      return false
    }

    if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
      const assignment = stmt.expression
      const isPatternLhs = t.isObjectPattern(assignment.left) || t.isArrayPattern(assignment.left)
      if (!isPatternLhs) return false
      return isStoreSourceExpression(assignment.right as BabelCore.types.Expression)
    }

    return false
  }

  const hasRiskyBranchPreludeReads = (stmts: BabelCore.types.Statement[]): boolean => {
    for (const stmt of stmts) {
      if (hasRiskyStoreDestructureRead(stmt)) {
        return true
      }
      if (t.isReturnStatement(stmt)) {
        const arg = stmt.argument
        if (!arg || isJSXLikeNode(arg)) continue
        if (containsReactiveAccessorRead([arg], { skipNestedFunctions: true })) {
          return true
        }
        continue
      }
      if (containsReactiveAccessorRead([stmt], { skipNestedFunctions: true })) {
        return true
      }
    }
    return false
  }

  const hasRiskyImmediateInvocationReads = (stmts: BabelCore.types.Statement[]): boolean =>
    hasNodeMatch(
      stmts,
      node => {
        if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return false
        const callee = node.callee
        if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) {
          return false
        }
        const bodyNodes = t.isBlockStatement(callee.body) ? callee.body.body : [callee.body]
        return containsReactiveAccessorRead(bodyNodes, { skipNestedFunctions: true })
      },
      { skipNestedFunctions: true },
    )

  const needsTrackedBranchReads = (stmts: BabelCore.types.Statement[]): boolean => {
    if (stmts.length === 0) return false
    return (
      hasRiskyBranchControlFlow(stmts) ||
      hasRiskyBranchPreludeReads(stmts) ||
      hasRiskyImmediateInvocationReads(stmts)
    )
  }

  const emitControlFlowFallbackWarning = (
    node: BabelCore.types.Node,
    kind: 'if' | 'switch',
  ): void => {
    const onWarn = ctx.options?.onWarn
    if (!onWarn) return
    const loc = node.loc?.start
    onWarn({
      code: DiagnosticCode.FICT_R003,
      message:
        `Reactive ${kind}-return lowering was skipped for this branch. ` +
        `The branch structure will not update reactively; refactor to a supported ` +
        `${kind} form or use explicit runtime conditionals.`,
      fileName: ctx.options?.filename ?? '<unknown>',
      line: loc?.line ?? 0,
      column: loc ? loc.column + 1 : 0,
    })
  }

  function buildReturnBlock(
    stmts: BabelCore.types.Statement[],
  ): BabelCore.types.Statement[] | null {
    if (stmts.length === 0) return null
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]
      if (!t.isIfStatement(stmt)) continue
      const conditionalExpr = buildConditionalExpr(stmt, stmts.slice(i + 1))
      if (conditionalExpr) {
        const prefix = stmts.slice(0, i)
        return [...prefix, t.returnStatement(conditionalExpr)]
      }
    }
    if (!endsWithReturn(stmts)) return null
    return stmts
  }

  function buildBranchFunction(
    stmts: BabelCore.types.Statement[],
    options?: { disallowRenderHooks?: boolean },
  ): BabelCore.types.ArrowFunctionExpression | null {
    const block = buildReturnBlock(stmts)
    if (!block) return null
    if (options?.disallowRenderHooks && containsRenderOnlyHooks(block)) return null
    return t.arrowFunctionExpression([], t.blockStatement(block))
  }

  function containsRenderOnlyHooks(nodes: BabelCore.types.Node[]): boolean {
    let found = false

    const visit = (node: BabelCore.types.Node | null | undefined): void => {
      if (!node || found) return

      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const callee = node.callee
        if (t.isIdentifier(callee) && callee.name.startsWith('__fictUse')) {
          if (callee.name !== '__fictUseEffect') {
            found = true
            return
          }
        }
      }

      const keys = (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS
      const visitorKeys = keys?.[(node as { type: string }).type] ?? []
      for (const key of visitorKeys) {
        const value = (node as unknown as Record<string, unknown>)[key]
        if (Array.isArray(value)) {
          for (const child of value) {
            if (child && typeof child === 'object' && 'type' in (child as object)) {
              visit(child as BabelCore.types.Node)
            }
            if (found) return
          }
        } else if (value && typeof value === 'object' && 'type' in (value as object)) {
          visit(value as BabelCore.types.Node)
        }
        if (found) return
      }
    }

    for (const node of nodes) {
      visit(node)
      if (found) break
    }

    return found
  }

  function buildConditionalBindingExpr(
    testExpr: BabelCore.types.Expression,
    trueFn: BabelCore.types.ArrowFunctionExpression,
    falseFn: BabelCore.types.ArrowFunctionExpression,
    options?: { trackBranchReads?: boolean },
  ): BabelCore.types.Expression {
    ctx.helpersUsed.add('conditional')
    ctx.helpersUsed.add('createElement')
    ctx.helpersUsed.add('onDestroy')
    const bindingId = genTemp(ctx, 'cond')
    const args: BabelCore.types.Expression[] = [
      t.arrowFunctionExpression([], testExpr),
      trueFn,
      runtimeIdentifier(ctx, 'createElement'),
      falseFn,
    ]
    if (options?.trackBranchReads) {
      const undefinedExpr = t.unaryExpression('void', t.numericLiteral(0))
      args.push(
        undefinedExpr,
        t.cloneNode(undefinedExpr) as BabelCore.types.Expression,
        t.objectExpression([
          t.objectProperty(t.identifier('trackBranchReads'), t.booleanLiteral(true)),
        ]),
      )
    }
    const bindingCall = t.callExpression(runtimeIdentifier(ctx, 'conditional'), args)

    return t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement([
          t.variableDeclaration('const', [t.variableDeclarator(bindingId, bindingCall)]),
          t.expressionStatement(
            t.callExpression(runtimeIdentifier(ctx, 'onDestroy'), [
              t.memberExpression(bindingId, t.identifier('dispose')),
            ]),
          ),
          t.returnStatement(bindingId),
        ]),
      ),
      [],
    )
  }

  const cloneExpression = (expr: BabelCore.types.Expression): BabelCore.types.Expression =>
    t.cloneNode(expr, true) as BabelCore.types.Expression

  function buildExpressionReturnValue(
    expr: BabelCore.types.Expression,
  ): BabelCore.types.Expression {
    return buildExpressionConditionalExpr(expr) ?? cloneExpression(expr)
  }

  function buildExpressionReturnFunction(
    expr: BabelCore.types.Expression,
  ): BabelCore.types.ArrowFunctionExpression {
    return t.arrowFunctionExpression(
      [],
      t.blockStatement([t.returnStatement(buildExpressionReturnValue(expr))]),
    )
  }

  function buildExpressionConditionalExpr(
    expr: BabelCore.types.Expression,
  ): BabelCore.types.Expression | null {
    if (t.isConditionalExpression(expr)) {
      if (!containsReactiveAccessorRead([expr.test], { skipNestedFunctions: true })) return null
      const trueFn = buildExpressionReturnFunction(expr.consequent as BabelCore.types.Expression)
      const falseFn = buildExpressionReturnFunction(expr.alternate as BabelCore.types.Expression)
      const shouldTrackBranchReads =
        containsReactiveAccessorRead([expr.consequent], { skipNestedFunctions: true }) ||
        containsReactiveAccessorRead([expr.alternate], { skipNestedFunctions: true })
      return buildConditionalBindingExpr(
        cloneExpression(expr.test as BabelCore.types.Expression),
        trueFn,
        falseFn,
        shouldTrackBranchReads ? { trackBranchReads: true } : undefined,
      )
    }

    if (t.isLogicalExpression(expr) && (expr.operator === '&&' || expr.operator === '||')) {
      if (!containsReactiveAccessorRead([expr.left], { skipNestedFunctions: true })) return null
      const left = expr.left as BabelCore.types.Expression
      const right = expr.right as BabelCore.types.Expression
      const trueFn =
        expr.operator === '&&'
          ? buildExpressionReturnFunction(right)
          : buildExpressionReturnFunction(left)
      const falseFn =
        expr.operator === '&&'
          ? buildExpressionReturnFunction(left)
          : buildExpressionReturnFunction(right)
      const shouldTrackBranchReads = containsReactiveAccessorRead([right], {
        skipNestedFunctions: true,
      })
      return buildConditionalBindingExpr(
        cloneExpression(left),
        trueFn,
        falseFn,
        shouldTrackBranchReads ? { trackBranchReads: true } : undefined,
      )
    }

    return null
  }

  function buildConditionalExpr(
    ifStmt: BabelCore.types.IfStatement,
    rest: BabelCore.types.Statement[],
  ): BabelCore.types.Expression | null {
    const consequentStmts = toStatements(ifStmt.consequent)
    if (!endsWithReturn(consequentStmts)) return null

    let alternateStmts: BabelCore.types.Statement[]
    if (ifStmt.alternate) {
      if (rest.length > 0) return null
      alternateStmts = toStatements(ifStmt.alternate)
      if (!endsWithReturn(alternateStmts)) return null
    } else {
      if (rest.length === 0) return null
      alternateStmts = rest
      if (!buildReturnBlock(alternateStmts)) return null
    }

    const trueFn = buildBranchFunction(consequentStmts)
    const falseFn = buildBranchFunction(alternateStmts)
    if (!trueFn || !falseFn) return null
    const shouldTrackBranchReads =
      needsTrackedBranchReads(consequentStmts) || needsTrackedBranchReads(alternateStmts)

    return buildConditionalBindingExpr(
      ifStmt.test as BabelCore.types.Expression,
      trueFn,
      falseFn,
      shouldTrackBranchReads ? { trackBranchReads: true } : undefined,
    )
  }

  function isSupportedSwitchDiscriminant(_expr: BabelCore.types.Expression): boolean {
    // Any expression can participate in switch lowering; the discriminant will be
    // re-used in branch predicates just like a lowered if/else chain.
    return true
  }

  function buildSwitchConditionalExpr(
    switchStmt: BabelCore.types.SwitchStatement,
    rest: BabelCore.types.Statement[],
  ): BabelCore.types.Expression | null {
    const discriminant = switchStmt.discriminant as BabelCore.types.Expression
    if (!isSupportedSwitchDiscriminant(discriminant)) return null

    interface SwitchBranch {
      tests: BabelCore.types.Expression[]
      statements: BabelCore.types.Statement[]
    }

    const trailingStatements = rest.length > 0 ? buildReturnBlock([...rest]) : []
    if (rest.length > 0 && !trailingStatements) return null

    const caseEntryCache = new Map<number, BabelCore.types.Statement[] | null>()
    const resolveCaseEntry = (startIndex: number): BabelCore.types.Statement[] | null => {
      if (caseEntryCache.has(startIndex)) {
        return caseEntryCache.get(startIndex) ?? null
      }

      const entry: BabelCore.types.Statement[] = []
      for (let i = startIndex; i < switchStmt.cases.length; i++) {
        const currentCase = switchStmt.cases[i]!
        const consequent = currentCase.consequent

        for (let stmtIndex = 0; stmtIndex < consequent.length; stmtIndex++) {
          const stmt = consequent[stmtIndex]!
          if (t.isBreakStatement(stmt)) {
            if (stmt.label || stmtIndex !== consequent.length - 1) {
              caseEntryCache.set(startIndex, null)
              return null
            }
            if (endsWithReturn(entry)) {
              caseEntryCache.set(startIndex, entry)
              return entry
            }
            if (!trailingStatements || trailingStatements.length === 0) {
              caseEntryCache.set(startIndex, null)
              return null
            }
            const withTrailing = [...entry, ...trailingStatements]
            caseEntryCache.set(startIndex, withTrailing)
            return withTrailing
          }
          if (t.isContinueStatement(stmt)) {
            caseEntryCache.set(startIndex, null)
            return null
          }
          entry.push(stmt)
        }

        if (endsWithReturn(entry)) {
          caseEntryCache.set(startIndex, entry)
          return entry
        }
      }

      if (!trailingStatements || trailingStatements.length === 0) {
        caseEntryCache.set(startIndex, null)
        return null
      }
      const withTrailing = [...entry, ...trailingStatements]
      caseEntryCache.set(startIndex, withTrailing)
      return withTrailing
    }

    const branches: SwitchBranch[] = []
    let defaultStatements: BabelCore.types.Statement[] | null = null
    for (let i = 0; i < switchStmt.cases.length; i++) {
      const caseNode = switchStmt.cases[i]!
      const statements = resolveCaseEntry(i)
      if (!statements) return null

      if (caseNode.test) {
        branches.push({
          tests: [caseNode.test as BabelCore.types.Expression],
          statements,
        })
      } else {
        defaultStatements = statements
      }
    }

    if (branches.length === 0 && !defaultStatements) return null

    const fallbackStatements = defaultStatements ?? trailingStatements
    if (!fallbackStatements || fallbackStatements.length === 0) return null
    const fallbackFn = buildBranchFunction(fallbackStatements, { disallowRenderHooks: true })
    if (!fallbackFn) return null

    // Preserve switch discriminant semantics: compute once per reactive evaluation
    // and reuse across case predicate checks.
    ctx.helpersUsed.add('memo')
    const discriminantAccessor = genTemp(ctx, 'switchDisc')
    const discriminantMemoDecl = t.variableDeclaration('const', [
      t.variableDeclarator(
        discriminantAccessor,
        t.callExpression(runtimeIdentifier(ctx, 'memo'), [
          t.arrowFunctionExpression(
            [],
            t.cloneNode(discriminant, true) as BabelCore.types.Expression,
          ),
        ]),
      ),
    ])

    let currentExpr: BabelCore.types.Expression = t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement((fallbackFn.body as BabelCore.types.BlockStatement).body),
      ),
      [],
    )
    let currentExprNeedsTrackedBranchReads = needsTrackedBranchReads(fallbackStatements)

    for (let i = branches.length - 1; i >= 0; i--) {
      const branch = branches[i]!
      const trueFn = buildBranchFunction(branch.statements, { disallowRenderHooks: true })
      if (!trueFn) return null
      const trueBranchNeedsTrackedBranchReads = needsTrackedBranchReads(branch.statements)
      const trackBranchReads =
        trueBranchNeedsTrackedBranchReads || currentExprNeedsTrackedBranchReads

      const falseFn = t.arrowFunctionExpression(
        [],
        t.blockStatement([t.returnStatement(currentExpr)]),
      )
      const comparisons: BabelCore.types.Expression[] = branch.tests.map(test =>
        t.binaryExpression(
          '===',
          t.callExpression(t.cloneNode(discriminantAccessor), []),
          t.cloneNode(test, true) as BabelCore.types.Expression,
        ),
      )
      if (comparisons.length === 0) return null
      const testExpr = comparisons
        .slice(1)
        .reduce<BabelCore.types.Expression>(
          (acc, expr) => t.logicalExpression('||', acc, expr),
          comparisons[0]!,
        )
      currentExpr = buildConditionalBindingExpr(
        testExpr,
        trueFn,
        falseFn,
        trackBranchReads ? { trackBranchReads: true } : undefined,
      )
      currentExprNeedsTrackedBranchReads = trackBranchReads
    }

    return t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement([discriminantMemoDecl, t.returnStatement(currentExpr)]),
      ),
      [],
    )
  }

  let nestedChanged = false
  const rewrittenStatements = statements.map(stmt => {
    if (!t.isTryStatement(stmt)) return stmt

    const transformedTryBlock = transformControlFlowReturns(stmt.block.body, ctx)
    const nextTryBlockBody = transformedTryBlock ?? stmt.block.body

    let nextHandler = stmt.handler
    if (stmt.handler) {
      const transformedCatchBlock = transformControlFlowReturns(stmt.handler.body.body, ctx)
      if (transformedCatchBlock) {
        nextHandler = t.catchClause(
          stmt.handler.param
            ? (t.cloneNode(stmt.handler.param, true) as BabelCore.types.CatchClause['param'])
            : null,
          t.blockStatement(transformedCatchBlock),
        )
      }
    }

    let nextFinalizer = stmt.finalizer
    if (stmt.finalizer) {
      const transformedFinalizer = transformControlFlowReturns(stmt.finalizer.body, ctx)
      if (transformedFinalizer) {
        nextFinalizer = t.blockStatement(transformedFinalizer)
      }
    }

    if (!transformedTryBlock && nextHandler === stmt.handler && nextFinalizer === stmt.finalizer) {
      return stmt
    }

    nestedChanged = true
    return t.tryStatement(
      t.blockStatement(nextTryBlockBody),
      nextHandler,
      nextFinalizer ? (t.cloneNode(nextFinalizer, true) as BabelCore.types.BlockStatement) : null,
    )
  })

  const unsafeLoopReturn = findUnsafeReactiveLoopReturn(rewrittenStatements)
  if (unsafeLoopReturn) {
    const loc = unsafeLoopReturn.loc?.start
    throw new HIRError(
      `Unsafe reactive loop return: return branches inside reactive loops cannot be lowered ` +
        `to reactive conditionals yet and would render stale output.`,
      'BUILD_ERROR',
      {
        file: ctx.options?.filename,
        line: loc?.line,
      },
    )
  }

  function isGeneratedPropNullishGuard(stmt: BabelCore.types.Statement): boolean {
    if (!t.isIfStatement(stmt)) return false
    if (
      !t.isBinaryExpression(stmt.test) ||
      stmt.test.operator !== '==' ||
      !t.isNullLiteral(stmt.test.right)
    ) {
      return false
    }

    const consequent = t.isBlockStatement(stmt.consequent)
      ? stmt.consequent.body.length === 1
        ? stmt.consequent.body[0]
        : null
      : stmt.consequent
    if (!consequent || !t.isThrowStatement(consequent)) return false

    const argument = consequent.argument
    if (!t.isNewExpression(argument) || !t.isIdentifier(argument.callee, { name: 'TypeError' })) {
      return false
    }

    const [message] = argument.arguments
    return (
      t.isStringLiteral(message) &&
      message.value.startsWith('Cannot destructure prop "') &&
      message.value.endsWith('" because it is nullish')
    )
  }

  for (let i = 0; i < rewrittenStatements.length; i++) {
    const stmt = rewrittenStatements[i]
    if (!t.isReturnStatement(stmt) || !stmt.argument || !t.isExpression(stmt.argument)) continue
    const conditionalExpr = buildExpressionConditionalExpr(stmt.argument)
    if (!conditionalExpr) continue
    const prefix = rewrittenStatements.slice(0, i)
    return [...prefix, t.returnStatement(conditionalExpr)]
  }

  for (let i = 0; i < rewrittenStatements.length; i++) {
    const stmt = rewrittenStatements[i]
    if (!t.isIfStatement(stmt)) continue
    if (isGeneratedPropNullishGuard(stmt)) continue
    const rest = rewrittenStatements.slice(i + 1)
    const conditionalExpr = buildConditionalExpr(stmt, rest)
    if (!conditionalExpr) {
      const hasReturn = containsReturnStatement([stmt, ...rest])
      const hasReactiveReads = containsReactiveAccessorRead([stmt, ...rest])
      if (hasReturn && hasReactiveReads) {
        emitControlFlowFallbackWarning(stmt, 'if')
      }
      continue
    }
    const prefix = rewrittenStatements.slice(0, i)
    return [...prefix, t.returnStatement(conditionalExpr)]
  }

  for (let i = 0; i < rewrittenStatements.length; i++) {
    const stmt = rewrittenStatements[i]
    if (!t.isSwitchStatement(stmt)) continue
    const rest = rewrittenStatements.slice(i + 1)
    const conditionalExpr = buildSwitchConditionalExpr(stmt, rest)
    if (!conditionalExpr) {
      const hasReturn = containsReturnStatement([stmt, ...rest])
      const hasReactiveReads = containsReactiveAccessorRead([stmt, ...rest])
      if (hasReturn && hasReactiveReads) {
        emitControlFlowFallbackWarning(stmt, 'switch')
      }
      continue
    }
    const prefix = rewrittenStatements.slice(0, i)
    return [...prefix, t.returnStatement(conditionalExpr)]
  }

  return nestedChanged ? rewrittenStatements : null
}

function compareSourcePositions(
  a: { line: number; column: number } | undefined,
  b: { line: number; column: number } | undefined,
): number | null {
  if (!a || !b) return null
  if (a.line !== b.line) return a.line - b.line
  return a.column - b.column
}

function getSingleLexicalDeclaration(
  stmt: BabelCore.types.Statement,
  t: typeof BabelCore.types,
): {
  name: string
  loc: BabelCore.types.SourceLocation
  dependencies: Set<string>
} | null {
  if (!t.isVariableDeclaration(stmt)) return null
  if (stmt.kind !== 'const' && stmt.kind !== 'let') return null
  if (stmt.declarations.length !== 1) return null
  const decl = stmt.declarations[0]
  if (!decl || !t.isIdentifier(decl.id) || !stmt.loc) return null
  return {
    name: decl.id.name,
    loc: stmt.loc,
    dependencies: collectReferencedIdentifiers(decl.init, t),
  }
}

function collectReferencedIdentifiers(
  node: BabelCore.types.Node | null | undefined,
  t: typeof BabelCore.types,
): Set<string> {
  const names = new Set<string>()
  const visitorKeys =
    (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS ?? {}

  const visit = (
    current: BabelCore.types.Node | null | undefined,
    parent: BabelCore.types.Node | null = null,
  ): void => {
    if (!current) return
    if (
      parent &&
      (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
      parent.property === current &&
      !parent.computed
    ) {
      return
    }
    if (
      parent &&
      t.isObjectProperty(parent) &&
      parent.key === current &&
      !(parent.shorthand && parent.value === current) &&
      !parent.computed
    ) {
      return
    }
    if (
      t.isFunctionDeclaration(current) ||
      t.isFunctionExpression(current) ||
      t.isArrowFunctionExpression(current) ||
      t.isObjectMethod(current) ||
      t.isClassMethod(current)
    ) {
      return
    }
    if (t.isIdentifier(current)) {
      names.add(current.name)
      return
    }
    const keys = visitorKeys[(current as { type: string }).type] ?? []
    for (const key of keys) {
      const value = (current as unknown as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && 'type' in child) {
            visit(child as BabelCore.types.Node, current)
          }
        }
      } else if (value && typeof value === 'object' && 'type' in value) {
        visit(value as BabelCore.types.Node, current)
      }
    }
  }

  visit(node)
  return names
}

function collectAssignmentTargetRootNames(
  node: BabelCore.types.Node | null | undefined,
  t: typeof BabelCore.types,
  names: Set<string>,
): void {
  if (!node) return
  if (t.isIdentifier(node)) {
    names.add(node.name)
    return
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    collectAssignmentTargetRootNames(node.object, t, names)
    return
  }
  if (t.isAssignmentPattern(node)) {
    collectAssignmentTargetRootNames(node.left, t, names)
    return
  }
  if (t.isRestElement(node)) {
    collectAssignmentTargetRootNames(node.argument, t, names)
    return
  }
  if (t.isObjectPattern(node) || t.isArrayPattern(node)) {
    const ids = t.getBindingIdentifiers(node)
    Object.keys(ids).forEach(name => names.add(name))
  }
}

function statementMutatesAnyIdentifier(
  stmt: BabelCore.types.Statement,
  names: Set<string>,
  t: typeof BabelCore.types,
): boolean {
  if (names.size === 0) return false
  const visitorKeys =
    (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS ?? {}
  let found = false

  const checkTargets = (targets: Set<string>): void => {
    for (const target of targets) {
      if (names.has(target)) {
        found = true
        return
      }
    }
  }

  const visit = (node: BabelCore.types.Node | null | undefined, isRoot = false): void => {
    if (!node || found) return
    if (
      !isRoot &&
      (t.isFunctionDeclaration(node) ||
        t.isFunctionExpression(node) ||
        t.isArrowFunctionExpression(node) ||
        t.isObjectMethod(node) ||
        t.isClassMethod(node))
    ) {
      return
    }
    if (t.isAssignmentExpression(node)) {
      const targets = new Set<string>()
      collectAssignmentTargetRootNames(node.left, t, targets)
      checkTargets(targets)
      if (found) return
    } else if (t.isUpdateExpression(node)) {
      const targets = new Set<string>()
      collectAssignmentTargetRootNames(node.argument, t, targets)
      checkTargets(targets)
      if (found) return
    }

    const keys = visitorKeys[(node as { type: string }).type] ?? []
    for (const key of keys) {
      const value = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && 'type' in child) {
            visit(child as BabelCore.types.Node)
            if (found) return
          }
        }
      } else if (value && typeof value === 'object' && 'type' in value) {
        visit(value as BabelCore.types.Node)
      }
      if (found) return
    }
  }

  visit(stmt, true)
  return found
}

function statementReferencesIdentifier(
  stmt: BabelCore.types.Statement,
  name: string,
  t: typeof BabelCore.types,
): boolean {
  let found = false
  const visitorKeys =
    (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS ?? {}

  const visit = (node: BabelCore.types.Node | null | undefined, isRoot = false): void => {
    if (!node || found) return
    if (
      !isRoot &&
      (t.isFunctionDeclaration(node) ||
        t.isFunctionExpression(node) ||
        t.isArrowFunctionExpression(node) ||
        t.isObjectMethod(node) ||
        t.isClassMethod(node))
    ) {
      return
    }
    if (t.isIdentifier(node) && node.name === name) {
      found = true
      return
    }
    const keys = visitorKeys[(node as { type: string }).type] ?? []
    for (const key of keys) {
      const value = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && 'type' in child) {
            visit(child as BabelCore.types.Node)
            if (found) return
          }
        }
      } else if (value && typeof value === 'object' && 'type' in value) {
        visit(value as BabelCore.types.Node)
      }
      if (found) return
    }
  }

  visit(stmt, true)
  return found
}

function restoreLexicalDeclarationUseOrder(
  statements: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): BabelCore.types.Statement[] {
  const ordered = [...statements]
  for (let index = 0; index < ordered.length; index++) {
    const stmt = ordered[index]
    if (!stmt) continue
    const declaration = getSingleLexicalDeclaration(stmt, t)
    if (!declaration) continue

    let insertionIndex = -1
    for (let candidateIndex = 0; candidateIndex < index; candidateIndex++) {
      const candidate = ordered[candidateIndex]
      if (!candidate?.loc) continue
      const sourceOrder = compareSourcePositions(declaration.loc.start, candidate.loc.start)
      if (sourceOrder === null || sourceOrder >= 0) continue
      if (
        statementReferencesIdentifier(candidate, declaration.name, t) ||
        statementMutatesAnyIdentifier(candidate, declaration.dependencies, t)
      ) {
        insertionIndex = candidateIndex
        break
      }
    }

    if (insertionIndex >= 0) {
      ordered.splice(index, 1)
      ordered.splice(insertionIndex, 0, stmt)
    }
  }
  return ordered
}

/**
 * Lower a function with region-based code generation
 */
function lowerFunctionWithRegions(
  fn: HIRFunction,
  ctx: CodegenContext,
  options?: { forceHookContext?: boolean; forceComponentContext?: boolean },
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  const prevTracked = ctx.trackedVars
  const prevSignalVars = ctx.signalVars
  const prevKnownArrayVars = ctx.knownArrayVars
  const prevCallableSignalVars = ctx.callableSignalVars
  const prevNonSerializableSignalVars = ctx.nonSerializableSignalVars
  const prevFunctionVars = ctx.functionVars
  const prevFunctionBindingKinds = ctx.functionBindingKinds
  const prevMemoVars = ctx.memoVars
  const prevStoreVars = ctx.storeVars
  const prevNamespaceStoreAliasVars = ctx.namespaceStoreAliasVars
  const prevMutatedVars = ctx.mutatedVars
  const prevMemberMutatedVars = ctx.memberMutatedVars
  const prevAliasVars = ctx.aliasVars
  const prevNoMemo = ctx.noMemo
  const prevWrapTracked = ctx.wrapTrackedExpressions
  const prevIsComponent = ctx.isComponentFn
  const prevHookResultVarMap = ctx.hookResultVarMap
  const prevHookFunctionAliases = ctx.hookFunctionAliases
  const prevHookFunctionMemberAliases = ctx.hookFunctionMemberAliases
  const prevInModule = ctx.inModule
  const prevContextLocalName = ctx.contextLocalName
  const prevLocalValueVars = ctx.localValueVars
  const prevMutablePropVars = ctx.mutablePropVars
  const prevImportedReactiveKinds = ctx.importedReactiveKinds
  const scopedTracked = new Set(ctx.trackedVars)
  const shadowedParams = new Set(fn.params.map(p => deSSAVarName(p.name)))
  fn.params.forEach(p => scopedTracked.delete(deSSAVarName(p.name)))
  ctx.trackedVars = scopedTracked
  ctx.localValueVars = new Set(prevLocalValueVars ?? [])
  ctx.mutablePropVars = new Set()
  ctx.knownArrayVars = new Set(prevKnownArrayVars ?? [])
  fn.params.forEach(p => ctx.knownArrayVars?.delete(deSSAVarName(p.name)))
  const prevNeedsCtx = ctx.needsCtx
  ctx.needsCtx = false
  ctx.contextLocalName = undefined
  ctx.inModule = false
  const prevShadowed = ctx.shadowedNames
  const functionShadowed = new Set(prevShadowed ?? [])
  shadowedParams.forEach(n => functionShadowed.add(n))
  ctx.shadowedNames = functionShadowed
  const prevLocalDeclared = ctx.localDeclaredNames
  const prevCurrentFunctionDeclared = ctx.currentFunctionDeclaredNames
  const currentFunctionDeclared = collectLocalDeclaredNames(fn.params, fn.blocks, t)
  const localDeclared = new Set(prevLocalDeclared ?? [])
  for (const name of currentFunctionDeclared) {
    localDeclared.add(name)
  }
  ctx.localDeclaredNames = localDeclared
  ctx.currentFunctionDeclaredNames = currentFunctionDeclared
  ctx.importedReactiveKinds = new Map(prevImportedReactiveKinds ?? [])
  shadowedParams.forEach(name => ctx.importedReactiveKinds?.delete(name))
  for (const name of currentFunctionDeclared) {
    ctx.importedReactiveKinds?.delete(name)
  }
  const prevExternalTracked = ctx.externalTracked
  const inheritedTracked = new Set(ctx.trackedVars)
  ctx.externalTracked = inheritedTracked
  // Always ensure context exists to support memo/region wrappers
  ctx.aliasVars = new Set(prevAliasVars ?? [])
  ctx.signalVars = new Set(prevSignalVars ?? [])
  ctx.callableSignalVars = new Set(prevCallableSignalVars ?? [])
  ctx.nonSerializableSignalVars = new Set(prevNonSerializableSignalVars ?? [])
  shadowedParams.forEach(name => ctx.callableSignalVars?.delete(name))
  shadowedParams.forEach(name => ctx.nonSerializableSignalVars?.delete(name))
  for (const name of localDeclared) {
    ctx.callableSignalVars?.delete(name)
    ctx.nonSerializableSignalVars?.delete(name)
  }
  ctx.functionVars = new Set(prevFunctionVars ?? [])
  ctx.functionBindingKinds = new Map(prevFunctionBindingKinds ?? [])
  ctx.memoVars = new Set(prevMemoVars ?? [])
  ctx.storeVars = new Set(prevStoreVars ?? [])
  ctx.namespaceStoreAliasVars = new Set(prevNamespaceStoreAliasVars ?? [])
  ctx.mutatedVars = new Set()
  ctx.memberMutatedVars = new Set()
  ctx.noMemo = !!(prevNoMemo || fn.meta?.noMemo)
  ctx.hookResultVarMap = new Map()
  ctx.hookFunctionAliases = new Map(prevHookFunctionAliases ?? [])
  ctx.hookFunctionMemberAliases = new Map(prevHookFunctionMemberAliases ?? [])
  // Save and initialize componentFunctionDefs for this function scope
  const prevComponentFunctionDefs = ctx.componentFunctionDefs
  const prevComponentFunctionMutations = ctx.componentFunctionMutations
  const prevHoistedFunctionDepNames = ctx.hoistedFunctionDepNames
  ctx.componentFunctionDefs = new Map()
  ctx.componentFunctionMutations = new Map()
  ctx.hoistedFunctionDepNames = new Map()
  const hookResultVars = new Set<string>()
  const hookAccessorAliases = new Set<string>()
  const prevPropsParam = ctx.propsParamName
  const prevPropAccessors = ctx.propAccessorDecls
  const prevResumablePropAccessors = ctx.resumablePropAccessors
  const prevResumablePropRests = ctx.resumablePropRests
  ctx.propAccessorDecls = new Map()
  ctx.resumablePropAccessors = new Map()
  ctx.resumablePropRests = new Map()
  const prevDelegatedEventsUsed = ctx.delegatedEventsUsed
  ctx.delegatedEventsUsed = new Set()
  const propDestructureRootNames = new Set<string>()
  if (fn.rawParams && fn.rawParams.length === 1) {
    const rawParam = fn.rawParams[0]
    const pattern =
      rawParam &&
      (rawParam.type === 'ObjectPattern' ||
        (rawParam.type === 'AssignmentPattern' && rawParam.left?.type === 'ObjectPattern'))
        ? rawParam.type === 'AssignmentPattern'
          ? rawParam.left
          : rawParam
        : null
    if (pattern && pattern.type === 'ObjectPattern') {
      Object.keys(t.getBindingIdentifiers(pattern)).forEach(name =>
        propDestructureRootNames.add(name),
      )
    }
  }
  const calledIdentifiers = collectCalledIdentifiers(fn, propDestructureRootNames)
  const jsxPropValueReadNames = (() => {
    const names = new Set<string>()
    if (propDestructureRootNames.size === 0) return names

    const isEventLikeAttrName = (name: string): boolean =>
      name.startsWith('on:') ||
      name.startsWith('oncapture:') ||
      (name.startsWith('on') && name.length > 2 && /^[A-Z]$/.test(name[2] ?? ''))

    const visit = (
      expr: Expression | null | undefined,
      inCallCallee = false,
      collectReads = false,
    ): void => {
      if (!expr) return
      switch (expr.kind) {
        case 'Identifier': {
          const name = deSSAVarName(expr.name)
          if (collectReads && !inCallCallee && propDestructureRootNames.has(name)) {
            names.add(name)
          }
          return
        }
        case 'CallExpression':
        case 'OptionalCallExpression':
          visit(expr.callee as Expression, true, collectReads)
          expr.arguments.forEach(arg => visit(arg as Expression, false, collectReads))
          return
        case 'MemberExpression':
        case 'OptionalMemberExpression':
          visit(expr.object as Expression, inCallCallee, collectReads)
          if (expr.computed) visit(expr.property as Expression, false, collectReads)
          return
        case 'ArrowFunction':
        case 'FunctionExpression':
          return
        case 'ArrayExpression':
          expr.elements.forEach(element => visit(element as Expression | null, false, collectReads))
          return
        case 'ObjectExpression':
          expr.properties.forEach(prop => {
            if (prop.kind === 'SpreadElement') {
              visit(prop.argument as Expression, false, collectReads)
            } else {
              if (prop.computed) visit(prop.key as Expression, false, collectReads)
              visit(prop.value as Expression, false, collectReads)
            }
          })
          return
        case 'JSXElement':
          expr.attributes.forEach(attr => {
            if (attr.isSpread) {
              visit(attr.spreadExpr, false, true)
            } else if (attr.value && attr.name !== 'ref' && !isEventLikeAttrName(attr.name)) {
              visit(attr.value, false, true)
            }
          })
          expr.children.forEach(child => {
            if (child.kind === 'expression') {
              visit(child.value, false, true)
            } else if (child.kind === 'element') {
              visit(child.value, false, true)
            }
          })
          return
        case 'BinaryExpression':
        case 'LogicalExpression':
          visit(expr.left as Expression, false, collectReads)
          visit(expr.right as Expression, false, collectReads)
          return
        case 'UnaryExpression':
        case 'AwaitExpression':
          visit(expr.argument as Expression, false, collectReads)
          return
        case 'ConditionalExpression':
          visit(expr.test as Expression, false, collectReads)
          visit(expr.consequent as Expression, false, collectReads)
          visit(expr.alternate as Expression, false, collectReads)
          return
        case 'AssignmentExpression':
          visit(expr.left as Expression, false, collectReads)
          visit(expr.right as Expression, false, collectReads)
          return
        case 'UpdateExpression':
          visit(expr.argument as Expression, false, collectReads)
          return
        case 'TemplateLiteral':
          expr.expressions.forEach(item => visit(item as Expression, false, collectReads))
          return
        case 'TaggedTemplateExpression':
          visit(expr.tag as Expression, true, collectReads)
          expr.quasi.expressions.forEach(item => visit(item as Expression, false, collectReads))
          return
        case 'SequenceExpression':
          expr.expressions.forEach(item => visit(item as Expression, false, collectReads))
          return
        case 'SpreadElement':
          visit(expr.argument as Expression, false, collectReads)
          return
        case 'NewExpression':
          visit(expr.callee as Expression, true, collectReads)
          expr.arguments.forEach(arg => visit(arg as Expression, false, collectReads))
          return
        case 'YieldExpression':
          visit(expr.argument as Expression | null, false, collectReads)
          return
        case 'ImportExpression':
          visit(expr.source as Expression, false, collectReads)
          visit(expr.options as Expression | null, false, collectReads)
          return
        case 'ClassExpression':
          visit(expr.superClass as Expression | null, false, collectReads)
          return
        case 'Literal':
        case 'MetaProperty':
        case 'ThisExpression':
        case 'SuperExpression':
          return
        default:
          return
      }
    }

    for (const block of fn.blocks) {
      block.instructions.forEach(instr => {
        if (instr.kind === 'Assign' || instr.kind === 'Expression') {
          visit(instr.value)
        }
      })
      const term = block.terminator
      if (term.kind === 'Return') {
        visit(term.argument ?? null)
      } else if (term.kind === 'Throw') {
        visit(term.argument)
      } else if (term.kind === 'Branch') {
        visit(term.test)
      } else if (term.kind === 'Switch') {
        visit(term.discriminant)
        term.cases.forEach(item => visit(item.test ?? null))
      }
    }

    return names
  })()
  const calledPropValueNames = new Set<string>()
  const calledPropFunctionVars = new Set<string>()
  const propsPlanAliases = new Set<string>()
  let propsDestructurePlan: {
    statements: BabelCore.types.Statement[]
    usesProp: boolean
    usesPropsRest: boolean
  } | null = null
  let propsSourceName: string | null = null
  let propsDefaultParamName: string | null = null

  // Collect function-valued bindings, signals, and mutation info in this function
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        markKnownArrayInitializer(target, instr.value, ctx, !!instr.declarationKind)
        propagateHookResultAlias(target, instr.value, ctx)
        if (ctx.hookResultVarMap?.has(target)) {
          hookResultVars.add(target)
        } else {
          hookResultVars.delete(target)
        }
        if (instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression') {
          ctx.functionVars?.add(target)
          ctx.functionBindingKinds?.set(target, instr.declarationKind ?? 'unknown')
          // Store HIR expression for potential hoisting in resumable handlers
          ctx.componentFunctionDefs?.set(target, instr.value)
          if (ctx.signalVars?.has(target)) {
            ctx.callableSignalVars?.add(target)
            ctx.nonSerializableSignalVars?.add(target)
          }
        }
        if (
          instr.value.kind === 'CallExpression' ||
          instr.value.kind === 'OptionalCallExpression'
        ) {
          const callKind = getReactiveCallKind(instr.value, ctx)
          if (callKind === 'signal') {
            ctx.signalVars?.add(target)
            if (isCallableSignalInitializer(instr.value, ctx)) {
              ctx.callableSignalVars?.add(target)
            }
            if (isNonSerializableSignalInitializer(instr.value, ctx)) {
              ctx.nonSerializableSignalVars?.add(target)
            }
          } else if (callKind === 'store') {
            ctx.storeVars?.add(target)
          } else if (callKind === 'memo') {
            ctx.memoVars?.add(target)
          }
        }
        const directHookCall = resolveDirectHookCallInfo(instr.value, ctx)
        if (directHookCall && directHookCall.hookName.indexOf('.') === -1) {
          hookResultVars.add(target)
          ctx.hookResultVarMap?.set(target, directHookCall.hookName)
        }
        const namespaceHookCall = resolveNamespaceHookCallInfo(instr.value, ctx)
        if (namespaceHookCall) {
          hookResultVars.add(target)
          ctx.hookResultVarMap?.set(target, namespaceHookCall.hookName)
        }
        const hookMemberKind =
          instr.value.kind === 'MemberExpression' &&
          instr.value.object.kind === 'Identifier' &&
          hookResultVars.has(deSSAVarName(instr.value.object.name))
            ? resolveHookReturnMemberAccessorKind(instr.value, ctx)
            : null
        if (hookMemberKind) {
          if (isCallableHookAccessorKind(hookMemberKind)) {
            hookAccessorAliases.add(target)
          } else {
            markHookReactiveLocal(target, hookMemberKind, ctx)
          }
        }
        if (!instr.declarationKind) {
          ctx.mutatedVars?.add(target)
        }
      } else if (instr.kind === 'Expression') {
        markCallableSignalAssignmentValue(instr.value, ctx)
      } else if (instr.kind === 'Phi') {
        ctx.mutatedVars?.add(deSSAVarName(instr.target.name))
      }
    }
  }
  collectMutatedIdentifiers(fn).forEach(name => ctx.mutatedVars?.add(name))
  collectMemberMutatedIdentifiers(fn).forEach(name => ctx.memberMutatedVars?.add(name))
  ctx.componentFunctionMutations = collectFunctionDependencyMutations(
    fn,
    ctx.functionVars ?? new Set(),
  )
  hookAccessorAliases.forEach(name => {
    ctx.aliasVars?.add(name)
    ctx.trackedVars.add(name)
  })

  const inferredHook = options?.forceHookContext ? true : isHookLikeFunction(fn)
  // Analyze reactive scopes with SSA/CFG awareness
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  detectDerivedCycles(fn, scopeResult, ctx)
  ctx.scopes = scopeResult

  // Generate region result for metadata
  const regionResult = generateRegions(fn, scopeResult)
  const hasJSX = regionResult.regions.some(r => r.hasJSX) || functionContainsJSX(fn)

  const prevHookFlag = ctx.currentFnIsHook
  ctx.currentFnIsHook = inferredHook
  const isComponent =
    options?.forceComponentContext === true ||
    (isComponentName(fn.name ? deSSAVarName(fn.name) : undefined) &&
      (hasJSX || functionUsesComponentContextPrimitives(fn)))
  ctx.isComponentFn = isComponent
  // Non-component, non-hook functions should use non-hook-based primitives (createSignal, createMemo)
  // to avoid requiring hook context. Only component functions and hooks use hook-based APIs.
  if (!isComponent && !inferredHook) {
    ctx.inModule = true
  }
  const rawPropsParam =
    fn.params.length === 1 && fn.params[0] ? deSSAVarName(fn.params[0].name) : undefined
  if (isComponent && rawPropsParam) {
    ctx.propsParamName = rawPropsParam
    ctx.trackedVars.add(rawPropsParam)
    scopedTracked.add(rawPropsParam)
  } else {
    ctx.propsParamName = undefined
  }

  // Build RegionInfo array for DOM integration (with de-versioned names, flattened with children)
  ctx.regions = flattenRegions(regionResult.topLevelRegions)
  if (ctx.nextHookSlot === undefined) {
    ctx.nextHookSlot = HOOK_SLOT_BASE
  }

  // Precompute a reactive props destructuring plan for component params
  if (isComponent && fn.rawParams && fn.rawParams.length === 1) {
    const rawParam = fn.rawParams[0]
    const pattern =
      rawParam &&
      (rawParam.type === 'ObjectPattern' ||
        (rawParam.type === 'AssignmentPattern' && rawParam.left?.type === 'ObjectPattern'))
        ? rawParam.type === 'AssignmentPattern'
          ? rawParam.left
          : rawParam
        : null

    if (pattern && pattern.type === 'ObjectPattern') {
      propsSourceName = reservePreferredFunctionLocalName(ctx, '__props')
      if (rawParam?.type === 'AssignmentPattern') {
        propsDefaultParamName = reservePreferredFunctionLocalName(ctx, '__propsParam')
      }
      const stmts: BabelCore.types.Statement[] = []
      const excludeKeys: BabelCore.types.Expression[] = []
      let supported = true
      let usesProp = false
      let usesPropsRest = false
      let warnedNested = false
      const reportedPatternNodes = new Set<BabelCore.types.Node>()

      const reportPatternDiagnostic = (node: BabelCore.types.Node, code: DiagnosticCode): void => {
        if (reportedPatternNodes.has(node)) return
        reportedPatternNodes.add(node)
        reportDiagnostic(ctx, code, node)
      }

      const reportPropsPatternIssues = (
        objectPattern: BabelCore.types.ObjectPattern,
        allowRest: boolean,
      ): void => {
        for (const prop of objectPattern.properties) {
          if (t.isObjectProperty(prop)) {
            if (prop.computed) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P003)
              continue
            }
            const keyName = t.isIdentifier(prop.key)
              ? prop.key.name
              : t.isStringLiteral(prop.key)
                ? prop.key.value
                : t.isNumericLiteral(prop.key)
                  ? String(prop.key.value)
                  : null
            if (!keyName) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P003)
              continue
            }

            const value = prop.value
            if (t.isIdentifier(value)) {
              continue
            }
            if (t.isObjectPattern(value)) {
              reportPropsPatternIssues(value, false)
              continue
            }
            if (t.isAssignmentPattern(value)) {
              if (t.isIdentifier(value.left)) {
                continue
              }
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
              continue
            }
            if (t.isArrayPattern(value)) {
              const hasRest = value.elements.some(el => t.isRestElement(el))
              reportPatternDiagnostic(
                value,
                hasRest ? DiagnosticCode.FICT_P002 : DiagnosticCode.FICT_P001,
              )
              continue
            }

            reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
            continue
          }

          if (t.isRestElement(prop)) {
            if (!allowRest || !t.isIdentifier(prop.argument)) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
            }
            continue
          }

          reportPatternDiagnostic(prop as BabelCore.types.Node, DiagnosticCode.FICT_P004)
        }
      }

      const memberExprForKey = (
        base: BabelCore.types.Expression,
        key: string,
      ): BabelCore.types.MemberExpression => {
        if (t.isValidIdentifier(key)) {
          return t.memberExpression(base, t.identifier(key), false)
        }
        const numericKey = Number(key)
        const keyExpr =
          Number.isFinite(numericKey) && String(numericKey) === key
            ? t.numericLiteral(numericKey)
            : t.stringLiteral(key)
        return t.memberExpression(base, keyExpr, true)
      }
      const buildDefaultValueExpression = (
        valueExpr: BabelCore.types.Expression,
        defaultExpr: BabelCore.types.Expression,
      ): BabelCore.types.Expression => {
        const valueId = genTemp(ctx, 'propDefault')
        return t.callExpression(
          t.arrowFunctionExpression(
            [valueId],
            t.conditionalExpression(
              t.binaryExpression('===', t.cloneNode(valueId), voidZero(t)),
              defaultExpr,
              t.cloneNode(valueId),
            ),
          ),
          [valueExpr],
        )
      }
      const propAccessorEagerReads = new Map<
        string,
        { index: number; valueExpr: BabelCore.types.Expression }
      >()
      const propAccessorSnapshots = new Map<string, BabelCore.types.Identifier>()
      const emitEagerPropRead = (name: string, valueExpr: BabelCore.types.Expression): void => {
        const index = stmts.length
        stmts.push(t.expressionStatement(t.cloneNode(valueExpr, true)))
        propAccessorEagerReads.set(name, { index, valueExpr })
      }
      const ensurePropAccessorSnapshot = (name: string): BabelCore.types.Identifier => {
        const existing = propAccessorSnapshots.get(name)
        if (existing) return t.cloneNode(existing)

        const snapshotId = genTemp(ctx, 'propValue')
        const eagerRead = propAccessorEagerReads.get(name)
        if (eagerRead) {
          stmts[eagerRead.index] = t.variableDeclaration('const', [
            t.variableDeclarator(snapshotId, t.cloneNode(eagerRead.valueExpr, true)),
          ])
        } else {
          stmts.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(snapshotId, t.callExpression(t.identifier(name), [])),
            ]),
          )
        }
        propAccessorSnapshots.set(name, snapshotId)
        return t.cloneNode(snapshotId)
      }
      const lowerPropDefaultExpression = (
        defaultExpr: BabelCore.types.Expression,
      ): BabelCore.types.Expression => {
        const overrides: RegionOverrideMap = Object.create(null) as RegionOverrideMap
        for (const name of propsPlanAliases) {
          overrides[name] = () => ensurePropAccessorSnapshot(name)
        }
        const lowered = t.cloneNode(defaultExpr, true) as BabelCore.types.Expression
        const loweredDefault = lowerRawJSXInBabelNode(lowered, ctx)
        replaceIdentifiersWithOverrides(
          loweredDefault,
          overrides,
          t,
          undefined,
          undefined,
          false,
          true,
        )
        return loweredDefault
      }
      const buildEagerDefaultedPropAccessor = (
        valueExpr: BabelCore.types.Expression,
        defaultExpr: BabelCore.types.Expression,
      ): BabelCore.types.Expression => {
        const defaultId = genTemp(ctx, 'propDefault')
        stmts.push(
          t.variableDeclaration('const', [
            t.variableDeclarator(
              defaultId,
              t.conditionalExpression(
                t.binaryExpression('===', t.cloneNode(valueExpr, true), voidZero(t)),
                lowerPropDefaultExpression(defaultExpr),
                voidZero(t),
              ),
            ),
          ]),
        )
        return t.callExpression(runtimeIdentifier(ctx, 'prop'), [
          t.arrowFunctionExpression(
            [],
            t.conditionalExpression(
              t.binaryExpression('===', t.cloneNode(valueExpr, true), voidZero(t)),
              t.cloneNode(defaultId),
              t.cloneNode(valueExpr, true),
            ),
          ),
        ])
      }
      const emitNestedObjectCheck = (
        valueExpr: BabelCore.types.Expression,
        keyName: string,
      ): void => {
        const objectId = genTemp(ctx, 'propObject')
        stmts.push(
          t.variableDeclaration('const', [
            t.variableDeclarator(objectId, t.cloneNode(valueExpr, true)),
          ]),
          t.ifStatement(
            t.binaryExpression('==', t.cloneNode(objectId), t.nullLiteral()),
            t.throwStatement(
              t.newExpression(t.identifier('TypeError'), [
                t.stringLiteral(`Cannot destructure prop "${keyName}" because it is nullish`),
              ]),
            ),
          ),
        )
      }
      const buildDestructure = (
        objectPattern: BabelCore.types.ObjectPattern,
        baseExpr: BabelCore.types.Expression,
        allowRest: boolean,
        propPath: string[] = [],
      ): void => {
        const isMutatedPropBinding = (name: string): boolean => ctx.mutatedVars?.has(name) ?? false

        for (const prop of objectPattern.properties) {
          if (t.isObjectProperty(prop)) {
            if (prop.computed) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P003)
              supported = false
              warnedNested = true
              break
            }
            const keyName = t.isIdentifier(prop.key)
              ? prop.key.name
              : t.isStringLiteral(prop.key)
                ? prop.key.value
                : t.isNumericLiteral(prop.key)
                  ? String(prop.key.value)
                  : null
            if (!keyName) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P003)
              supported = false
              warnedNested = true
              break
            }
            if (allowRest) {
              excludeKeys.push(t.stringLiteral(keyName))
            }
            const member = memberExprForKey(baseExpr, keyName)
            const nextPropPath = [...propPath, keyName]
            const value = prop.value

            if (t.isIdentifier(value)) {
              const isMutatedBinding = isMutatedPropBinding(value.name)
              if (isMutatedBinding) {
                ctx.mutablePropVars?.add(value.name)
                ctx.localValueVars?.add(value.name)
              }
              const shouldWrapProp =
                !isMutatedBinding &&
                (jsxPropValueReadNames.has(value.name) || !calledIdentifiers.has(value.name))
              if (shouldWrapProp) {
                usesProp = true
                propsPlanAliases.add(value.name)
                ctx.resumablePropAccessors?.set(value.name, { path: nextPropPath })
                emitEagerPropRead(value.name, member)
              } else if (!isMutatedBinding && calledIdentifiers.has(value.name)) {
                calledPropValueNames.add(value.name)
              }
              stmts.push(
                t.variableDeclaration(isMutatedBinding ? 'var' : 'const', [
                  t.variableDeclarator(
                    t.identifier(value.name),
                    shouldWrapProp
                      ? t.callExpression(runtimeIdentifier(ctx, 'prop'), [
                          t.arrowFunctionExpression([], member),
                        ])
                      : member,
                  ),
                ]),
              )
              continue
            }

            if (t.isObjectPattern(value)) {
              emitNestedObjectCheck(member, keyName)
              buildDestructure(value, member, false, nextPropPath)
              if (!supported) break
              continue
            }

            if (t.isAssignmentPattern(value)) {
              if (t.isIdentifier(value.left)) {
                const isMutatedBinding = isMutatedPropBinding(value.left.name)
                if (isMutatedBinding) {
                  ctx.mutablePropVars?.add(value.left.name)
                  ctx.localValueVars?.add(value.left.name)
                }
                const shouldWrapProp =
                  !isMutatedBinding &&
                  (jsxPropValueReadNames.has(value.left.name) ||
                    !calledIdentifiers.has(value.left.name))
                if (shouldWrapProp) {
                  usesProp = true
                  propsPlanAliases.add(value.left.name)
                  ctx.resumablePropAccessors?.set(value.left.name, {
                    path: nextPropPath,
                    defaultValue: t.cloneNode(value.right, true) as BabelCore.types.Expression,
                  })
                } else if (!isMutatedBinding && calledIdentifiers.has(value.left.name)) {
                  calledPropValueNames.add(value.left.name)
                }
                const loweredDefault = lowerPropDefaultExpression(value.right)
                const baseInit = buildDefaultValueExpression(member, loweredDefault)
                const init = shouldWrapProp
                  ? buildEagerDefaultedPropAccessor(member, loweredDefault)
                  : baseInit
                stmts.push(
                  t.variableDeclaration(isMutatedBinding ? 'var' : 'const', [
                    t.variableDeclarator(t.identifier(value.left.name), init),
                  ]),
                )
                continue
              }
              supported = false
              if (!warnedNested) {
                reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
                warnedNested = true
              }
              break
            }

            if (t.isArrayPattern(value)) {
              const hasRest = value.elements.some(el => t.isRestElement(el))
              reportPatternDiagnostic(
                value,
                hasRest ? DiagnosticCode.FICT_P002 : DiagnosticCode.FICT_P001,
              )
              supported = false
              warnedNested = true
              break
            }

            supported = false
            if (!warnedNested) {
              reportPatternDiagnostic(prop, DiagnosticCode.FICT_P004)
              warnedNested = true
            }
            break
          } else if (t.isRestElement(prop) && allowRest && t.isIdentifier(prop.argument)) {
            usesPropsRest = true
            ctx.resumablePropRests?.set(prop.argument.name, {
              excludedKeys: excludeKeys
                .filter((key): key is BabelCore.types.StringLiteral => t.isStringLiteral(key))
                .map(key => key.value),
            })
            stmts.push(
              t.variableDeclaration('const', [
                t.variableDeclarator(
                  t.identifier(prop.argument.name),
                  t.callExpression(runtimeIdentifier(ctx, 'propsRest'), [
                    baseExpr,
                    t.arrayExpression(excludeKeys),
                  ]),
                ),
              ]),
            )
            continue
          } else {
            supported = false
            if (!warnedNested) {
              reportPatternDiagnostic(prop as BabelCore.types.Node, DiagnosticCode.FICT_P004)
              warnedNested = true
            }
            break
          }
        }
      }

      reportPropsPatternIssues(pattern, true)

      // Build destructuring for top-level pattern
      buildDestructure(pattern, t.identifier(propsSourceName), true)

      if (supported) {
        propsDestructurePlan = {
          statements: stmts,
          usesProp,
          usesPropsRest,
        }
        propsPlanAliases.forEach(name => {
          ctx.aliasVars?.add(name)
          ctx.trackedVars.add(name)
          ctx.shadowedNames?.delete(name)
        })
        calledPropValueNames.forEach(name => {
          calledPropFunctionVars.add(name)
          ctx.functionVars?.add(name)
        })
        collectIdentifierAliasesFromRoots(fn, calledPropValueNames, calledIdentifiers).forEach(
          name => {
            calledPropFunctionVars.add(name)
            ctx.functionVars?.add(name)
          },
        )
      } else {
        ctx.resumablePropAccessors?.clear()
        ctx.resumablePropRests?.clear()
      }
    }
  }

  const reactive = computeReactiveAccessors(fn, ctx)
  ctx.trackedVars = reactive.tracked
  ctx.memoVars = reactive.memo
  calledPropFunctionVars.forEach(name => {
    ctx.functionVars?.add(name)
    ctx.trackedVars.delete(name)
    ctx.memoVars?.delete(name)
    ctx.aliasVars?.delete(name)
  })
  ctx.controlDepsByInstr = reactive.controlDepsByInstr
  if (fn.name && isHookName(fn.name)) {
    const info = analyzeHookReturnInfo(fn, ctx)
    if (info) {
      ctx.hookReturnInfo = ctx.hookReturnInfo ?? new Map()
      ctx.hookReturnInfo.set(fn.name, info)
    }
  }
  if (fn.name === 'Counter') {
    debugLog('region', 'Tracked vars for Counter', Array.from(ctx.trackedVars))
    debugLog('region', 'Memo vars for Counter', Array.from(ctx.memoVars))
  }

  // Ensure hook call results that return direct accessors are treated as reactive aliases
  hookResultVars.forEach(varName => {
    const hookName = ctx.hookResultVarMap?.get(varName)
    const info = hookName ? getHookReturnInfo(hookName, ctx) : null
    markHookReactiveLocal(varName, info?.directAccessor, ctx)
  })

  emitReactiveControlFlowReexecutionWarning(fn, scopeResult, ctx, { hasJSX, isComponent })
  ctx.wrapTrackedExpressions = hasJSX
  const hasTrackedValues =
    ctx.trackedVars.size > 0 ||
    (ctx.signalVars?.size ?? 0) > 0 ||
    (ctx.storeVars?.size ?? 0) > 0 ||
    (ctx.memoVars?.size ?? 0) > 0 ||
    (ctx.aliasVars?.size ?? 0) > 0
  const isAsync = !!fn.meta?.isAsync || functionHasAsyncAwait(fn)
  const isGenerator = !!fn.meta?.isGenerator || functionHasYield(fn)
  if (isGenerator && (isComponent || inferredHook)) {
    throwGeneratorComponentOrHook(fn, ctx, isComponent ? 'component' : 'hook')
  }
  if (isAsync && isComponent) {
    throwAsyncComponent(fn, ctx)
  }
  if (
    isAsync &&
    (isComponent || inferredHook) &&
    asyncFunctionCreatesRenderHookAfterAwait(fn, ctx)
  ) {
    throwAsyncRenderHookAfterAwait(fn, ctx, isComponent ? 'component' : 'hook')
  }
  if (!hasJSX && !hasTrackedValues) {
    // For pure functions without JSX or tracked values, check if we can safely lower from HIR.
    // We skip functions with complex control flow (loops, async) as the simple lowering
    // doesn't handle all cases correctly.
    const structured = structurizeCFG(fn)
    const hasComplexControlFlow = structuredNodeHasComplexControlFlow(structured)

    if (!hasComplexControlFlow && !isAsync) {
      // For simple pure functions, generate code from optimized HIR
      // This ensures constant propagation, DCE, and algebraic simplifications are applied
      const pureDeclaredVars = new Set<string>()
      const pureStatements = lowerStructuredNodeWithoutRegions(structured, t, ctx, pureDeclaredVars)
      if (ctx.needsCtx) {
        ctx.helpersUsed.add('useContext')
        pureStatements.unshift(
          t.variableDeclaration('const', [
            t.variableDeclarator(
              contextIdentifier(ctx),
              t.callExpression(runtimeIdentifier(ctx, 'useContext'), []),
            ),
          ]),
        )
      }
      const params = buildOutputParams(fn, ctx)
      const funcDecl = setNodeLoc(
        t.functionDeclaration(
          t.identifier(fn.name ?? 'fn'),
          params,
          buildFunctionBlock(fn, pureStatements, t),
        ),
        fn.loc,
      )
      funcDecl.async = isAsync
      funcDecl.generator = isGenerator
      ctx.needsCtx = prevNeedsCtx
      ctx.shadowedNames = prevShadowed
      ctx.localDeclaredNames = prevLocalDeclared
      ctx.currentFunctionDeclaredNames = prevCurrentFunctionDeclared
      ctx.localValueVars = prevLocalValueVars
      ctx.importedReactiveKinds = prevImportedReactiveKinds
      ctx.mutablePropVars = prevMutablePropVars
      ctx.trackedVars = prevTracked
      ctx.externalTracked = prevExternalTracked
      ctx.signalVars = prevSignalVars
      ctx.knownArrayVars = prevKnownArrayVars
      ctx.callableSignalVars = prevCallableSignalVars
      ctx.nonSerializableSignalVars = prevNonSerializableSignalVars
      ctx.functionVars = prevFunctionVars
      ctx.functionBindingKinds = prevFunctionBindingKinds
      ctx.componentFunctionDefs = prevComponentFunctionDefs
      ctx.componentFunctionMutations = prevComponentFunctionMutations
      ctx.hoistedFunctionDepNames = prevHoistedFunctionDepNames
      ctx.memoVars = prevMemoVars
      ctx.storeVars = prevStoreVars
      ctx.mutatedVars = prevMutatedVars
      ctx.memberMutatedVars = prevMemberMutatedVars
      ctx.aliasVars = prevAliasVars
      ctx.noMemo = prevNoMemo
      ctx.wrapTrackedExpressions = prevWrapTracked
      ctx.hookResultVarMap = prevHookResultVarMap
      ctx.hookFunctionAliases = prevHookFunctionAliases
      ctx.hookFunctionMemberAliases = prevHookFunctionMemberAliases
      ctx.inModule = prevInModule
      ctx.contextLocalName = prevContextLocalName
      ctx.resumablePropAccessors = prevResumablePropAccessors
      ctx.resumablePropRests = prevResumablePropRests
      return funcDecl
    }

    // Fall back to returning null for complex functions
    ctx.needsCtx = prevNeedsCtx
    ctx.shadowedNames = prevShadowed
    ctx.localDeclaredNames = prevLocalDeclared
    ctx.currentFunctionDeclaredNames = prevCurrentFunctionDeclared
    ctx.localValueVars = prevLocalValueVars
    ctx.importedReactiveKinds = prevImportedReactiveKinds
    ctx.mutablePropVars = prevMutablePropVars
    ctx.trackedVars = prevTracked
    ctx.externalTracked = prevExternalTracked
    ctx.signalVars = prevSignalVars
    ctx.callableSignalVars = prevCallableSignalVars
    ctx.nonSerializableSignalVars = prevNonSerializableSignalVars
    ctx.functionVars = prevFunctionVars
    ctx.functionBindingKinds = prevFunctionBindingKinds
    ctx.componentFunctionDefs = prevComponentFunctionDefs
    ctx.componentFunctionMutations = prevComponentFunctionMutations
    ctx.hoistedFunctionDepNames = prevHoistedFunctionDepNames
    ctx.memoVars = prevMemoVars
    ctx.storeVars = prevStoreVars
    ctx.mutatedVars = prevMutatedVars
    ctx.memberMutatedVars = prevMemberMutatedVars
    ctx.aliasVars = prevAliasVars
    ctx.noMemo = prevNoMemo
    ctx.wrapTrackedExpressions = prevWrapTracked
    ctx.hookResultVarMap = prevHookResultVarMap
    ctx.hookFunctionAliases = prevHookFunctionAliases
    ctx.hookFunctionMemberAliases = prevHookFunctionMemberAliases
    ctx.inModule = prevInModule
    ctx.contextLocalName = prevContextLocalName
    ctx.resumablePropAccessors = prevResumablePropAccessors
    ctx.resumablePropRests = prevResumablePropRests
    return null
  }

  // Generate region-based statements (JSX-bearing functions)
  let statements: BabelCore.types.Statement[]
  statements = generateRegionCode(fn, scopeResult, t, ctx)
  statements = restoreLexicalDeclarationUseOrder(statements, t)

  if (inferredHook) {
    statements = preserveHookReturnAccessorsInStatements(statements, ctx)
  }

  // Ensure context if signals/effects are used in HIR path
  if (ctx.needsCtx) {
    ctx.helpersUsed.add('useContext')
    statements.unshift(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          contextIdentifier(ctx),
          t.callExpression(runtimeIdentifier(ctx, 'useContext'), []),
        ),
      ]),
    )
  }

  // Handle props destructuring pattern for component functions
  // If first rawParam is ObjectPattern, emit __props and add destructuring
  let finalParams = buildOutputParams(fn, ctx)
  const propsDestructuring: BabelCore.types.Statement[] = []

  if (isComponent && fn.rawParams && fn.rawParams.length === 1) {
    const rawParam = fn.rawParams[0]
    // Check if it's an ObjectPattern or AssignmentPattern with ObjectPattern
    if (
      rawParam &&
      (rawParam.type === 'ObjectPattern' ||
        (rawParam.type === 'AssignmentPattern' && rawParam.left?.type === 'ObjectPattern'))
    ) {
      const pattern = rawParam.type === 'AssignmentPattern' ? rawParam.left : rawParam
      const defaultExpr = rawParam.type === 'AssignmentPattern' ? rawParam.right : null
      const propsName = propsSourceName ?? '__props'
      if (defaultExpr) {
        const propsParamName = propsDefaultParamName ?? '__propsParam'
        finalParams = [t.identifier(propsParamName)]
        propsDestructuring.push(
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier(propsName),
              t.conditionalExpression(
                t.binaryExpression('===', t.identifier(propsParamName), voidZero(t)),
                t.cloneNode(defaultExpr, true) as BabelCore.types.Expression,
                t.identifier(propsParamName),
              ),
            ),
          ]),
        )
      } else {
        // Replace params with __props
        finalParams = [t.identifier(propsName)]
      }
      // Add destructuring statement at start of function
      if (propsDestructurePlan) {
        if (propsDestructurePlan.usesProp) {
          ctx.helpersUsed.add('prop')
        }
        if (propsDestructurePlan.usesPropsRest) {
          ctx.helpersUsed.add('propsRest')
        }
        propsDestructuring.push(...propsDestructurePlan.statements)
      } else {
        propsDestructuring.push(
          t.variableDeclaration('const', [t.variableDeclarator(pattern, t.identifier(propsName))]),
        )
      }
    }
  }

  // Add props destructuring before other statements
  if (propsDestructuring.length > 0) {
    statements.unshift(...propsDestructuring)
  }

  if (isComponent && !ctx.noMemo) {
    const transformed = transformControlFlowReturns(statements, ctx)
    if (transformed) {
      statements = transformed
    }
  }

  // De-version param names for clean output
  const params = finalParams
  const funcDecl = setNodeLoc(
    t.functionDeclaration(
      t.identifier(fn.name ?? 'fn'),
      params,
      buildFunctionBlock(fn, statements, t),
    ),
    fn.loc,
  )
  funcDecl.async = isAsync
  funcDecl.generator = isGenerator
  if (isComponent && fn.name) {
    registerResumableComponent(fn.name, ctx)
  }
  ctx.needsCtx = prevNeedsCtx
  ctx.shadowedNames = prevShadowed
  ctx.localDeclaredNames = prevLocalDeclared
  ctx.currentFunctionDeclaredNames = prevCurrentFunctionDeclared
  ctx.localValueVars = prevLocalValueVars
  ctx.importedReactiveKinds = prevImportedReactiveKinds
  ctx.mutablePropVars = prevMutablePropVars
  ctx.trackedVars = prevTracked
  ctx.externalTracked = prevExternalTracked
  ctx.signalVars = prevSignalVars
  ctx.knownArrayVars = prevKnownArrayVars
  ctx.callableSignalVars = prevCallableSignalVars
  ctx.nonSerializableSignalVars = prevNonSerializableSignalVars
  ctx.functionVars = prevFunctionVars
  ctx.functionBindingKinds = prevFunctionBindingKinds
  ctx.componentFunctionDefs = prevComponentFunctionDefs
  ctx.componentFunctionMutations = prevComponentFunctionMutations
  ctx.hoistedFunctionDepNames = prevHoistedFunctionDepNames
  ctx.memoVars = prevMemoVars
  ctx.storeVars = prevStoreVars
  ctx.namespaceStoreAliasVars = prevNamespaceStoreAliasVars
  ctx.mutatedVars = prevMutatedVars
  ctx.memberMutatedVars = prevMemberMutatedVars
  ctx.aliasVars = prevAliasVars
  ctx.noMemo = prevNoMemo
  ctx.wrapTrackedExpressions = prevWrapTracked
  ctx.currentFnIsHook = prevHookFlag
  ctx.isComponentFn = prevIsComponent
  ctx.hookResultVarMap = prevHookResultVarMap
  ctx.hookFunctionAliases = prevHookFunctionAliases
  ctx.hookFunctionMemberAliases = prevHookFunctionMemberAliases
  ctx.propsParamName = prevPropsParam
  ctx.propAccessorDecls = prevPropAccessors
  ctx.resumablePropAccessors = prevResumablePropAccessors
  ctx.resumablePropRests = prevResumablePropRests
  ctx.delegatedEventsUsed = prevDelegatedEventsUsed
  ctx.inModule = prevInModule
  ctx.contextLocalName = prevContextLocalName
  return funcDecl
}

/**
 * Flatten region tree into a list of RegionInfo with de-SSA names.
 * Children are ordered before parents so narrower regions are preferred when matching.
 */
function flattenRegions(regions: Region[]): RegionInfo[] {
  const result: RegionInfo[] = []

  const visit = (region: Region) => {
    const info: RegionInfo = {
      id: region.id,
      dependencies: new Set(Array.from(region.dependencies).map(d => deSSAVarName(d))),
      declarations: new Set(Array.from(region.declarations).map(d => deSSAVarName(d))),
      hasControlFlow: region.hasControlFlow,
      hasReactiveWrites: region.declarations.size > 0,
    }
    // Visit children first so that more specific regions are matched earlier
    region.children.forEach(child => visit(child))
    result.push(info)
  }

  regions.forEach(region => visit(region))

  // Prefer smaller regions when searching for containment
  return result.sort((a, b) => {
    const aSize = a.dependencies.size + a.declarations.size
    const bSize = b.dependencies.size + b.declarations.size
    if (aSize === bSize) return a.id - b.id
    return aSize - bSize
  })
}

/**
 * Get region metadata for fine-grained DOM integration.
 * Returns RegionMetadata[] that can be passed to applyRegionMetadata.
 */
export function getRegionMetadataForFunction(fn: HIRFunction): RegionMetadata[] {
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  const regionResult = generateRegions(fn, scopeResult)
  return regionResult.topLevelRegions.map(r => regionToMetadata(r))
}

/**
 * Check if a function has reactive regions that need memoization.
 */
export function hasReactiveRegions(fn: HIRFunction): boolean {
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  return scopeResult.scopes.some(s => s.shouldMemoize)
}

/**
 * Get helper functions used during codegen.
 */
export function getHelpersUsed(ctx: CodegenContext): Set<string> {
  return ctx.helpersUsed
}
