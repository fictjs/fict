import { transformFromAstSync } from '@babel/core'
import type * as BabelCore from '@babel/core'
import transformDestructuring from '@babel/plugin-transform-destructuring'
import traverseModule from '@babel/traverse'
import * as t from '@babel/types'

import type { CompilerWarning, ReactiveExportKind } from '../types'
import { isLogicalAssignmentOperator } from '../utils'

import {
  HIRError,
  type ArrayExpression as HArrayExpression,
  type ArrowFunctionExpression as HArrowFunctionExpression,
  type AssignmentExpression as HAssignmentExpression,
  type BabelDirective,
  type BabelStatement,
  type BasicBlock,
  type BinaryExpression as HBinaryExpression,
  type CallExpression as HCallExpression,
  type ConditionalExpression as HConditionalExpression,
  type Expression,
  type FunctionExpression as HFunctionExpression,
  type HIRFunction,
  type HIRProgram,
  type Identifier as HIdentifier,
  type Instruction,
  type JSXAttribute as HJSXAttribute,
  type JSXChild as HJSXChild,
  type JSXElementExpression as HJSXElementExpression,
  type LabeledStatementMeta,
  type Literal as HLiteral,
  type LogicalExpression as HLogicalExpression,
  type MemberExpression as HMemberExpression,
  type ObjectExpression as HObjectExpression,
  type PostambleItem,
  type PreambleItem,
  type SpreadElement as HSpreadElement,
  type TemplateLiteral as HTemplateLiteral,
  type UnaryExpression as HUnaryExpression,
  type UpdateExpression as HUpdateExpression,
  resetGeneratedSSANames,
} from './hir'
import { getFictMacroKind, type FictMacroKind } from './macro-bindings'

export interface BuildHIROptions {
  dev?: boolean
  fileName?: string
  onWarn?: (warning: CompilerWarning) => void
  reactiveScopes?: Set<string>
}

interface BlockBuilder {
  block: BasicBlock
  sealed: boolean
}

let destructuringTempCounter = 0
let activeBuildOptions: BuildHIROptions | undefined

export function resetDestructuringTempCounter(): void {
  destructuringTempCounter = 0
}

const getLoc = (node?: BabelCore.types.Node | null): BabelCore.types.SourceLocation | null => {
  return node?.loc ?? null
}

const resolveDestructuringPlugin = (): BabelCore.PluginItem => {
  const mod = transformDestructuring as unknown as { default?: BabelCore.PluginItem }
  return mod.default ?? (transformDestructuring as unknown as BabelCore.PluginItem)
}

const resolveTraverse = (): typeof traverseModule => {
  const mod = traverseModule as unknown as { default?: typeof traverseModule }
  return mod.default ?? traverseModule
}

const OBJECT_REST_HELPERS = new Set(['_objectWithoutProperties', '_objectWithoutPropertiesLoose'])
const OBJECT_DESTRUCTURING_EMPTY_HELPER = '_objectDestructuringEmpty'
const EXTENDS_HELPER = '_extends'

const isExpressionOrSpreadElement = (
  value: BabelCore.types.Node | null | undefined,
): value is BabelCore.types.Expression | BabelCore.types.SpreadElement => {
  return !!value && (t.isExpression(value) || t.isSpreadElement(value))
}

const toFunctionExpressionParams = (
  params:
    | BabelCore.types.FunctionDeclaration['params']
    | BabelCore.types.FunctionExpression['params']
    | BabelCore.types.ArrowFunctionExpression['params'],
): BabelCore.types.FunctionExpression['params'] => {
  return params.map(param => {
    if (t.isTSParameterProperty(param)) {
      return reportUnsupportedExpression(
        param,
        'TypeScript parameter properties are not supported in HIR conversion.',
      )
    }
    return param
  })
}

const isSameIdentifier = (
  left: BabelCore.types.Expression | BabelCore.types.SpreadElement,
  right: BabelCore.types.Expression | BabelCore.types.SpreadElement,
): boolean => {
  return t.isIdentifier(left) && t.isIdentifier(right) && left.name === right.name
}

const rewriteObjectRestHelpers = (ast: BabelCore.types.File): void => {
  const traverse = resolveTraverse()
  const isGeneratedBinding = (path: BabelCore.NodePath, name: string): boolean => {
    const binding = path.scope.getBinding(name)
    return !!binding && !binding.path.node.loc
  }

  traverse(ast, {
    CallExpression(path: BabelCore.NodePath<BabelCore.types.CallExpression>) {
      const { callee, arguments: args } = path.node
      if (
        t.isIdentifier(callee) &&
        OBJECT_REST_HELPERS.has(callee.name) &&
        isGeneratedBinding(path, callee.name)
      ) {
        path.node.callee = t.identifier('__fictObjectRest')
        return
      }

      if (
        t.isIdentifier(callee) &&
        callee.name === EXTENDS_HELPER &&
        isGeneratedBinding(path, callee.name) &&
        args.length === 2 &&
        t.isObjectExpression(args[0]) &&
        args[0].properties.length === 0 &&
        t.isSequenceExpression(args[1]) &&
        args[1].expressions.length === 2
      ) {
        const [checkExpr, sourceExpr] = args[1].expressions
        if (
          t.isCallExpression(checkExpr) &&
          t.isIdentifier(checkExpr.callee) &&
          checkExpr.callee.name === OBJECT_DESTRUCTURING_EMPTY_HELPER &&
          isGeneratedBinding(path, checkExpr.callee.name) &&
          checkExpr.arguments.length === 1
        ) {
          const checkArg = checkExpr.arguments[0]
          if (
            checkArg &&
            sourceExpr &&
            isExpressionOrSpreadElement(checkArg) &&
            isSameIdentifier(checkArg, sourceExpr)
          ) {
            const restCall = t.callExpression(t.identifier('__fictObjectRest'), [
              t.cloneNode(sourceExpr, true),
              t.arrayExpression([]),
            ])
            path.replaceWith(t.sequenceExpression([checkExpr, restCall]))
          }
        }
      }
    },
  })
}

const expandDestructuringAssignments = (ast: BabelCore.types.File): BabelCore.types.File => {
  const pluginFactory = resolveDestructuringPlugin()
  if (typeof pluginFactory !== 'function') {
    throw new Error('Expected @babel/plugin-transform-destructuring to export a function')
  }
  const result = transformFromAstSync(ast, undefined, {
    configFile: false,
    babelrc: false,
    ast: true,
    code: false,
    plugins: [pluginFactory],
  })
  const expanded = (result?.ast as BabelCore.types.File) ?? ast
  rewriteObjectRestHelpers(expanded)
  return expanded
}

const reportUnsupportedExpression = (
  node: BabelCore.types.Node,
  overrideMessage?: string,
): never => {
  const loc = getLoc(node)
  const line = loc?.start.line ?? 0
  const column = loc ? loc.start.column + 1 : 0
  const fileName = activeBuildOptions?.fileName ?? '<unknown>'
  const message = overrideMessage ?? `Unsupported expression '${node.type}' in HIR conversion`

  if (activeBuildOptions?.onWarn) {
    activeBuildOptions.onWarn({
      code: 'FICT-HIR-UNSUPPORTED',
      message,
      fileName,
      line,
      column,
    })
  }

  throw new HIRError(message, 'BUILD_ERROR', {
    file: fileName,
    line: loc?.start.line,
  })
}

const reportUserFacingUnsupportedExpression = (
  node: BabelCore.types.Node,
  message: string,
): never => {
  const loc = getLoc(node)
  const line = loc?.start.line ?? 0
  const column = loc ? loc.start.column + 1 : 0
  const fileName = activeBuildOptions?.fileName ?? '<unknown>'

  if (activeBuildOptions?.onWarn) {
    activeBuildOptions.onWarn({
      code: 'FICT-HIR-UNSUPPORTED',
      message,
      fileName,
      line,
      column,
    })
  }

  throw new Error(message)
}

function unsupportedTypeScriptRuntimeDeclarationMessage(node: BabelCore.types.Node): string | null {
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

function rejectUnsupportedTypeScriptRuntimeDeclaration(node: BabelCore.types.Node): void {
  const message = unsupportedTypeScriptRuntimeDeclarationMessage(node)
  if (message) reportUnsupportedExpression(node, message)
}

interface MacroAliases {
  state?: Set<string>
  effect?: Set<string>
  strictMacroBindings?: boolean
}

interface ResolvedMacroAliases {
  state: Set<string>
  effect: Set<string>
  strictMacroBindings: boolean
}

const DEFAULT_MACRO_ALIASES: ResolvedMacroAliases = {
  state: new Set(['$state']),
  effect: new Set(['$effect']),
  strictMacroBindings: false,
}

let activeMacroAliases: ResolvedMacroAliases = DEFAULT_MACRO_ALIASES

function resolveMacroAliases(aliases?: MacroAliases): ResolvedMacroAliases {
  return {
    state: new Set([...(aliases?.state ?? []), ...DEFAULT_MACRO_ALIASES.state]),
    effect: new Set([...(aliases?.effect ?? []), ...DEFAULT_MACRO_ALIASES.effect]),
    strictMacroBindings: aliases?.strictMacroBindings ?? false,
  }
}

function getCallMacroKind(
  call: BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression,
): FictMacroKind | null {
  const marked = getFictMacroKind(call)
  if (marked) return marked
  if (activeMacroAliases.strictMacroBindings) return null

  const callee = call.callee
  if (!t.isIdentifier(callee)) return null
  if (activeMacroAliases.state.has(callee.name)) {
    return 'state'
  }
  if (activeMacroAliases.effect.has(callee.name)) {
    return 'effect'
  }
  return null
}

function normalizeMacroCallee(
  call: BabelCore.types.CallExpression | BabelCore.types.OptionalCallExpression,
  callee: BabelCore.types.Expression,
): BabelCore.types.Expression {
  const macroKind = getCallMacroKind(call)
  if (macroKind === 'state') {
    return t.identifier('$state')
  }
  if (macroKind === 'effect') {
    return t.identifier('$effect')
  }
  return callee
}

function normalizeVarKind(
  kind: BabelCore.types.VariableDeclaration['kind'],
): 'const' | 'let' | 'var' {
  if ((kind as string) === 'using' || (kind as string) === 'await using') {
    throw new HIRError(
      '`using` and `await using` declarations are not supported by the Fict compiler yet. Resource disposal semantics would otherwise be lost.',
      'BUILD_ERROR',
    )
  }
  return kind === 'const' || kind === 'let' || kind === 'var' ? kind : 'let'
}

function functionDeclarationToAssign(
  stmt: BabelCore.types.FunctionDeclaration,
  options?: { blockScoped?: boolean },
): Instruction | null {
  if (!stmt.id) return null
  const fnExpr = t.functionExpression(
    stmt.id,
    toFunctionExpressionParams(stmt.params),
    stmt.body,
    stmt.generator,
    stmt.async,
  )
  return {
    kind: 'Assign',
    target: { kind: 'Identifier', name: stmt.id.name },
    value: convertExpression(fnExpr),
    declarationKind: 'function',
    blockScopedFunction: options?.blockScoped ? true : undefined,
    loc: stmt.loc,
  }
}

function emitHoistedFunctionDeclarations(
  statements: BabelCore.types.Statement[],
  push: (instr: Instruction) => void,
  options?: { blockScoped?: boolean },
): void {
  for (const stmt of statements) {
    if (!t.isFunctionDeclaration(stmt)) continue
    const instr = functionDeclarationToAssign(stmt, options)
    if (instr) push(instr)
  }
}

function bindingNamesFromPattern(
  pattern: BabelCore.types.LVal | BabelCore.types.PatternLike,
): string[] {
  return Object.keys(t.getBindingIdentifiers(pattern as BabelCore.types.Node))
}

function bindingOnlyVariableDeclaration(
  kind: 'const' | 'let' | 'var',
  names: string[],
  loc?: BabelCore.types.SourceLocation | null,
): BabelStatement | null {
  const uniqueNames = Array.from(new Set(names))
  if (uniqueNames.length === 0) return null
  const declaration = t.variableDeclaration(
    kind,
    uniqueNames.map(name =>
      t.variableDeclarator(
        t.identifier(name),
        kind === 'const' ? t.unaryExpression('void', t.numericLiteral(0), true) : null,
      ),
    ),
  )
  declaration.loc = loc ?? null
  return declaration
}

function bindingOnlyClassDeclaration(
  stmt: BabelCore.types.ClassDeclaration,
): BabelStatement | null {
  if (!stmt.id) return null
  const declaration = t.classDeclaration(t.identifier(stmt.id.name), null, t.classBody([]), null)
  declaration.loc = stmt.loc ?? null
  return declaration
}

function collectBabelIdentifierNames(
  node: BabelCore.types.Node | null | undefined,
  into: Set<string>,
): void {
  if (!node) return
  if (t.isIdentifier(node)) {
    into.add(node.name)
  }

  const visitorKeys =
    (t as unknown as { VISITOR_KEYS?: Record<string, string[]> }).VISITOR_KEYS?.[node.type] ?? []
  for (const key of visitorKeys) {
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) {
          collectBabelIdentifierNames(child as BabelCore.types.Node, into)
        }
      }
      continue
    }
    if (value && typeof value === 'object' && 'type' in value) {
      collectBabelIdentifierNames(value as BabelCore.types.Node, into)
    }
  }
}

function isVoidZeroExpression(node: BabelCore.types.Node): boolean {
  return (
    t.isUnaryExpression(node) &&
    node.operator === 'void' &&
    t.isNumericLiteral(node.argument) &&
    node.argument.value === 0
  )
}

function destructuringDefaultTempName(init: BabelCore.types.Expression): string | null {
  if (!t.isConditionalExpression(init)) return null
  if (!t.isIdentifier(init.alternate)) return null

  const test = init.test
  if (!t.isBinaryExpression(test) || (test.operator !== '===' && test.operator !== '==')) {
    return null
  }

  const alternateName = init.alternate.name
  const leftMatches =
    t.isIdentifier(test.left, { name: alternateName }) && isVoidZeroExpression(test.right)
  const rightMatches =
    t.isIdentifier(test.right, { name: alternateName }) && isVoidZeroExpression(test.left)

  return leftMatches || rightMatches ? alternateName : null
}

function collectEagerDestructuringDeclaratorNames(
  declaration: BabelCore.types.VariableDeclaration,
): Set<string> {
  const eager = new Set<string>()
  const initByName = new Map<string, BabelCore.types.Expression | null | undefined>()
  const priorNames = new Set<string>()
  const priorGeneratedNames = new Set<string>()

  for (const declarator of declaration.declarations) {
    if (!t.isIdentifier(declarator.id)) continue
    const name = declarator.id.name
    initByName.set(name, declarator.init)

    if (declarator.init) {
      const tempName = destructuringDefaultTempName(declarator.init)
      if (tempName && priorNames.has(tempName)) {
        eager.add(name)
        eager.add(tempName)
      }

      const deps = new Set<string>()
      collectBabelIdentifierNames(declarator.init, deps)
      for (const dep of deps) {
        if (!priorGeneratedNames.has(dep)) continue
        eager.add(name)
        eager.add(dep)
      }
    }

    if (!declarator.id.loc) {
      priorGeneratedNames.add(name)
    }
    priorNames.add(name)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const [name, init] of initByName) {
      if (!eager.has(name) || !init) continue
      const deps = new Set<string>()
      collectBabelIdentifierNames(init, deps)
      for (const dep of deps) {
        if (!initByName.has(dep) || eager.has(dep)) continue
        eager.add(dep)
        changed = true
      }
    }
  }

  return eager
}

function collectVarBindingDeclarationsFromStatement(
  stmt: BabelCore.types.Statement,
): BabelStatement[] {
  if (t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt)) {
    return []
  }
  if (t.isVariableDeclaration(stmt)) {
    const declKind = normalizeVarKind(stmt.kind)
    if (declKind !== 'var') return []
    const names = stmt.declarations.flatMap(decl => bindingNamesFromPattern(decl.id))
    const declaration = bindingOnlyVariableDeclaration('var', names, stmt.loc)
    return declaration ? [declaration] : []
  }
  if (t.isBlockStatement(stmt)) {
    return stmt.body.flatMap(child => collectVarBindingDeclarationsFromStatement(child))
  }
  if (t.isLabeledStatement(stmt)) {
    return collectVarBindingDeclarationsFromStatement(stmt.body as BabelCore.types.Statement)
  }
  if (t.isIfStatement(stmt)) {
    return [
      ...collectVarBindingDeclarationsFromStatement(stmt.consequent as BabelCore.types.Statement),
      ...(stmt.alternate
        ? collectVarBindingDeclarationsFromStatement(stmt.alternate as BabelCore.types.Statement)
        : []),
    ]
  }
  if (t.isWhileStatement(stmt) || t.isDoWhileStatement(stmt)) {
    return collectVarBindingDeclarationsFromStatement(stmt.body as BabelCore.types.Statement)
  }
  if (t.isForStatement(stmt)) {
    const declarations: BabelStatement[] = []
    if (stmt.init && t.isVariableDeclaration(stmt.init)) {
      const declKind = normalizeVarKind(stmt.init.kind)
      if (declKind === 'var') {
        const names = stmt.init.declarations.flatMap(decl => bindingNamesFromPattern(decl.id))
        const declaration = bindingOnlyVariableDeclaration('var', names, stmt.init.loc)
        if (declaration) declarations.push(declaration)
      }
    }
    declarations.push(
      ...collectVarBindingDeclarationsFromStatement(stmt.body as BabelCore.types.Statement),
    )
    return declarations
  }
  if (t.isForInStatement(stmt) || t.isForOfStatement(stmt)) {
    const declarations: BabelStatement[] = []
    if (t.isVariableDeclaration(stmt.left)) {
      const declKind = normalizeVarKind(stmt.left.kind)
      if (declKind === 'var') {
        const names = stmt.left.declarations.flatMap(decl => bindingNamesFromPattern(decl.id))
        const declaration = bindingOnlyVariableDeclaration('var', names, stmt.left.loc)
        if (declaration) declarations.push(declaration)
      }
    }
    declarations.push(
      ...collectVarBindingDeclarationsFromStatement(stmt.body as BabelCore.types.Statement),
    )
    return declarations
  }
  if (t.isSwitchStatement(stmt)) {
    return stmt.cases.flatMap(switchCase =>
      switchCase.consequent.flatMap(child => collectVarBindingDeclarationsFromStatement(child)),
    )
  }
  if (t.isTryStatement(stmt)) {
    return [
      ...collectVarBindingDeclarationsFromStatement(stmt.block),
      ...(stmt.handler ? collectVarBindingDeclarationsFromStatement(stmt.handler.body) : []),
      ...(stmt.finalizer ? collectVarBindingDeclarationsFromStatement(stmt.finalizer) : []),
    ]
  }
  if (t.isWithStatement(stmt)) {
    return collectVarBindingDeclarationsFromStatement(stmt.body as BabelCore.types.Statement)
  }
  return []
}

function collectPostTerminatorDeclarations(
  statements: BabelCore.types.Statement[],
): BabelStatement[] {
  const declarations: BabelStatement[] = []
  for (const stmt of statements) {
    if (t.isFunctionDeclaration(stmt)) {
      continue
    }
    if (t.isVariableDeclaration(stmt)) {
      const declKind = normalizeVarKind(stmt.kind)
      const names = stmt.declarations.flatMap(decl => bindingNamesFromPattern(decl.id))
      const declaration = bindingOnlyVariableDeclaration(declKind, names, stmt.loc)
      if (declaration) declarations.push(declaration)
      continue
    }
    if (t.isClassDeclaration(stmt)) {
      const declaration = bindingOnlyClassDeclaration(stmt)
      if (declaration) declarations.push(declaration)
      continue
    }
    declarations.push(...collectVarBindingDeclarationsFromStatement(stmt))
  }
  return declarations
}

function appendPostTerminatorDeclarations(
  block: BasicBlock,
  statements: BabelCore.types.Statement[],
): void {
  const declarations = collectPostTerminatorDeclarations(statements)
  if (declarations.length === 0) return
  block.postTerminatorStatements = [...(block.postTerminatorStatements ?? []), ...declarations]
}

function hasNoMemoDirective(directives?: BabelCore.types.Directive[] | null): boolean {
  if (!directives) return false
  return directives.some(d => d.value.value === 'use no memo')
}

function hasNoMemoDirectiveInStatements(body: BabelCore.types.Statement[]): boolean {
  const first = body[0]
  return !!(
    first &&
    t.isExpressionStatement(first) &&
    t.isStringLiteral(first.expression) &&
    first.expression.value === 'use no memo'
  )
}

const PURE_DIRECTIVE_TEXT = 'use pure'

function hasPureDirective(directives?: BabelCore.types.Directive[] | null): boolean {
  if (!directives) return false
  return directives.some(d => d.value.value === PURE_DIRECTIVE_TEXT)
}

function hasPureDirectiveInStatements(body: BabelCore.types.Statement[]): boolean {
  const first = body[0]
  return !!(
    first &&
    t.isExpressionStatement(first) &&
    t.isStringLiteral(first.expression) &&
    first.expression.value === PURE_DIRECTIVE_TEXT
  )
}

function isConsumedFictDirective(value: string): boolean {
  return value === 'use no memo' || value === PURE_DIRECTIVE_TEXT
}

function clonePreservedDirectives(
  directives?: BabelCore.types.Directive[] | null,
): BabelDirective[] {
  return (directives ?? [])
    .filter(directive => !isConsumedFictDirective(directive.value.value))
    .map(directive => t.cloneNode(directive, true) as BabelDirective)
}

function hasPureAnnotation(node: BabelCore.types.Node | null | undefined): boolean {
  if (!node) return false
  const comments = node.leadingComments ?? []
  return comments.some(c => /@__PURE__|#__PURE__/.test(c.value))
}

/**
 * Parsed @fictReturn annotation result.
 */
export interface ParsedFictReturn {
  objectProps?: Map<string, ReactiveExportKind>
  arrayProps?: Map<number, ReactiveExportKind>
  directAccessor?: ReactiveExportKind
}

function normalizeJSDocComment(value: string): string {
  return value
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
}

function extractBalancedFictReturnPayload(
  rest: string,
  open: string,
  close: string,
): string | null {
  let quote: '"' | "'" | null = null
  let escaped = false
  let depth = 0

  for (let i = 0; i < rest.length; i++) {
    const char = rest[i]
    if (!char) continue

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === open) {
      depth++
      continue
    }
    if (char === close) {
      depth--
      if (depth === 0) return rest.slice(0, i + 1).trim()
    }
  }

  return null
}

function extractFictReturnPayload(commentValue: string): string | null {
  const normalized = normalizeJSDocComment(commentValue)
  const markerIndex = normalized.indexOf('@fictReturn')
  if (markerIndex < 0) return null

  const rest = normalized.slice(markerIndex + '@fictReturn'.length).trimStart()
  if (!rest) return null
  if (rest.startsWith('{')) return extractBalancedFictReturnPayload(rest, '{', '}')
  if (rest.startsWith('[')) return extractBalancedFictReturnPayload(rest, '[', ']')
  return rest.split(/\r?\n/, 1)[0]?.trim() ?? null
}

/**
 * Parse @fictReturn JSDoc annotation from one or more nodes.
 *
 * Supported formats:
 * - Object return: @fictReturn { count: 'signal', double: 'memo' }
 * - Array return: @fictReturn [0: 'signal', 1: 'memo']
 * - Direct reactive return: @fictReturn 'signal', @fictReturn 'memo', or @fictReturn 'store'
 * - Direct accessor object: @fictReturn { directAccessor: 'signal' }
 *
 * @param node - The function node to parse annotations from
 * @returns Parsed return info or null if no annotation found
 */
export function parseFictReturnAnnotation(
  node: BabelCore.types.Node | null | undefined | (BabelCore.types.Node | null | undefined)[],
): ParsedFictReturn | null {
  if (!node) return null

  const nodes = Array.isArray(node) ? node : [node]
  for (const current of nodes) {
    if (!current) continue
    const comments = current.leadingComments ?? []
    for (const comment of comments) {
      const content = extractFictReturnPayload(comment.value)
      if (!content) continue

      // Direct reactive return: 'signal', 'memo', or 'store'
      if (content === "'signal'" || content === '"signal"') {
        return { directAccessor: 'signal' }
      }
      if (content === "'memo'" || content === '"memo"') {
        return { directAccessor: 'memo' }
      }
      if (content === "'store'" || content === '"store"') {
        return { directAccessor: 'store' }
      }

      // Empty object format: {}
      if (/^\{\s*\}$/.test(content)) {
        return { objectProps: new Map() }
      }

      // Object format: { key: 'signal', key2: 'memo' }
      const objectMatch = content.match(/^\{([^}]+)\}$/)
      if (objectMatch) {
        const objectProps = new Map<string, ReactiveExportKind>()
        const propsStr = objectMatch[1]
        if (!propsStr) continue
        const directAccessorMatch = propsStr.match(
          /^\s*directAccessor\s*:\s*(?:"(signal|memo|store)"|'(signal|memo|store)'|(signal|memo|store))\s*,?\s*$/,
        )
        if (directAccessorMatch) {
          return {
            directAccessor: (directAccessorMatch[1] ??
              directAccessorMatch[2] ??
              directAccessorMatch[3]) as ReactiveExportKind,
          }
        }
        // Parse key: 'value' pairs. Keys may be identifiers, numeric keys, or quoted strings.
        const propPattern =
          /(?:([A-Za-z_$][\w$]*|\d+)|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*:\s*(?:"(signal|memo|store)"|'(signal|memo|store)'|(signal|memo|store))(?=\s*(?:,|$))/g
        let propMatch
        while ((propMatch = propPattern.exec(propsStr)) !== null) {
          const key =
            propMatch[1] ??
            propMatch[2]?.replace(/\\(['"\\])/g, '$1') ??
            propMatch[3]?.replace(/\\(['"\\])/g, '$1')
          const value = propMatch[4] ?? propMatch[5] ?? propMatch[6]
          if (!key || (value !== 'signal' && value !== 'memo' && value !== 'store')) continue
          objectProps.set(key, value)
        }
        if (objectProps.size > 0) {
          return { objectProps }
        }
      }

      // Array format: [0: 'signal', 1: 'memo']
      const arrayMatch = content.match(/^\[([^\]]+)\]$/)
      if (arrayMatch) {
        const arrayProps = new Map<number, ReactiveExportKind>()
        const propsStr = arrayMatch[1]
        if (!propsStr) continue
        // Parse index: 'value' pairs
        const propPattern =
          /(\d+)\s*:\s*(?:"(signal|memo|store)"|'(signal|memo|store)'|(signal|memo|store))(?=\s*(?:,|$))/g
        let propMatch
        while ((propMatch = propPattern.exec(propsStr)) !== null) {
          const index = propMatch[1]
          const value = propMatch[2] ?? propMatch[3] ?? propMatch[4]
          if (!index || (value !== 'signal' && value !== 'memo' && value !== 'store')) continue
          arrayProps.set(parseInt(index, 10), value)
        }
        if (arrayProps.size > 0) {
          return { arrayProps }
        }
      }
    }
  }

  return null
}

/**
 * Extract identifiers from destructuring patterns.
 * Handles object patterns, array patterns, rest elements, and assignment patterns.
 */
function extractIdentifiersFromPattern(pattern: BabelCore.types.PatternLike): HIdentifier[] {
  const ids: HIdentifier[] = []

  if (t.isRestElement(pattern)) {
    if (t.isIdentifier(pattern.argument)) {
      ids.push({ kind: 'Identifier', name: pattern.argument.name })
    } else if (t.isPatternLike(pattern.argument)) {
      ids.push(...extractIdentifiersFromPattern(pattern.argument))
    }
    return ids
  }

  if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isObjectProperty(prop)) {
        if (t.isIdentifier(prop.value)) {
          ids.push({ kind: 'Identifier', name: prop.value.name })
        } else if (t.isAssignmentPattern(prop.value)) {
          // Handle default values: { a = 1 }
          if (t.isIdentifier(prop.value.left)) {
            ids.push({ kind: 'Identifier', name: prop.value.left.name })
          } else if (t.isPatternLike(prop.value.left)) {
            ids.push(...extractIdentifiersFromPattern(prop.value.left))
          }
        } else if (t.isPatternLike(prop.value)) {
          ids.push(...extractIdentifiersFromPattern(prop.value))
        }
      } else if (t.isRestElement(prop)) {
        if (t.isIdentifier(prop.argument)) {
          ids.push({ kind: 'Identifier', name: prop.argument.name })
        } else if (t.isPatternLike(prop.argument)) {
          ids.push(...extractIdentifiersFromPattern(prop.argument))
        }
      }
    }
  } else if (t.isArrayPattern(pattern)) {
    for (const elem of pattern.elements) {
      if (!elem) continue
      if (t.isIdentifier(elem)) {
        ids.push({ kind: 'Identifier', name: elem.name })
      } else if (t.isRestElement(elem)) {
        if (t.isIdentifier(elem.argument)) {
          ids.push({ kind: 'Identifier', name: elem.argument.name })
        } else if (t.isPatternLike(elem.argument)) {
          ids.push(...extractIdentifiersFromPattern(elem.argument))
        }
      } else if (t.isPatternLike(elem)) {
        ids.push(...extractIdentifiersFromPattern(elem))
      }
    }
  } else if (t.isAssignmentPattern(pattern)) {
    if (t.isIdentifier(pattern.left)) {
      ids.push({ kind: 'Identifier', name: pattern.left.name })
    } else if (t.isPatternLike(pattern.left)) {
      ids.push(...extractIdentifiersFromPattern(pattern.left))
    }
  }

  return ids
}

type BabelJSXChild =
  | BabelCore.types.JSXText
  | BabelCore.types.JSXExpressionContainer
  | BabelCore.types.JSXSpreadChild
  | BabelCore.types.JSXElement
  | BabelCore.types.JSXFragment

interface AppendJSXChildOptions {
  preserveWhitespaceText?: boolean
}

function isMeaningfulJSXText(text: string, preserveWhitespaceText = false): boolean {
  if (text.length === 0) return false
  if (text.trim().length > 0) return true
  if (preserveWhitespaceText) return true
  return !/[\r\n]/.test(text)
}

function appendJSXChild(
  children: HJSXChild[],
  child: BabelJSXChild,
  options: AppendJSXChildOptions = {},
): void {
  if (t.isJSXText(child)) {
    const text = child.value
    if (isMeaningfulJSXText(text, options.preserveWhitespaceText)) {
      children.push({ kind: 'text', value: text, loc: getLoc(child) })
    }
    return
  }

  if (t.isJSXExpressionContainer(child)) {
    if (!t.isJSXEmptyExpression(child.expression)) {
      children.push({
        kind: 'expression',
        value: convertExpression(child.expression as BabelCore.types.Expression),
        loc: getLoc(child),
      })
    }
    return
  }

  if (t.isJSXElement(child)) {
    children.push({
      kind: 'element',
      value: convertJSXElement(child),
      loc: getLoc(child),
    })
    return
  }

  if (t.isJSXSpreadChild(child)) {
    return reportUserFacingUnsupportedExpression(
      child,
      'JSX spread children are not supported. Use an expression child like {children} or map the values explicitly.',
    )
  }

  for (const fragmentChild of child.children) {
    appendJSXChild(children, fragmentChild, options)
  }
}

function hasAuthoredJSXChild(child: BabelJSXChild): boolean {
  if (t.isJSXText(child)) {
    return child.value.length > 0
  }
  return true
}

function isWhitespaceSensitiveJSXTag(tagName: string | Expression): boolean {
  return (
    typeof tagName === 'string' &&
    (tagName === 'pre' || tagName === 'textarea' || tagName === 'script' || tagName === 'style')
  )
}

/**
 * Build a simple list of BasicBlocks from a list of statements.
 * This is a simplified version for arrow function block bodies.
 * Does not handle complex control flow (use convertFunction for that).
 */
/**
 * Build basic blocks from a list of statements (simplified version for nested functions).
 * This version handles common control flow structures to properly capture arrow function bodies.
 */
function _buildBlocksFromStatements(statements: BabelCore.types.Statement[]): BasicBlock[] {
  const blocks: BasicBlock[] = []
  let nextBlockId = 0
  let tempCounter = 0

  const createBlock = (): BasicBlock => ({
    id: nextBlockId++,
    instructions: [],
    terminator: { kind: 'Unreachable' },
  })

  const currentBlock = createBlock()
  blocks.push(currentBlock)

  // Simple recursive processor for nested statements
  const processStmts = (stmts: BabelCore.types.Statement[], target: BasicBlock): void => {
    emitHoistedFunctionDeclarations(stmts, instr => target.instructions.push(instr))
    for (let index = 0; index < stmts.length; index++) {
      const stmt = stmts[index]
      if (t.isFunctionDeclaration(stmt)) {
        continue
      }
      if (t.isDebuggerStatement(stmt)) {
        target.instructions.push({
          kind: 'Debugger',
          loc: stmt.loc,
        })
        continue
      }
      if (t.isReturnStatement(stmt)) {
        target.terminator = {
          kind: 'Return',
          argument: stmt.argument ? convertExpression(stmt.argument) : undefined,
        }
        appendPostTerminatorDeclarations(target, stmts.slice(index + 1))
        return // Stop processing after return
      }
      if (t.isThrowStatement(stmt)) {
        target.terminator = {
          kind: 'Throw',
          argument: convertExpression(stmt.argument as BabelCore.types.Expression),
        }
        appendPostTerminatorDeclarations(target, stmts.slice(index + 1))
        return // Stop processing after throw
      }
      if (t.isExpressionStatement(stmt)) {
        const handled = handleExpressionStatement(stmt.expression, instr =>
          target.instructions.push(instr),
        )
        if (!handled) {
          target.instructions.push({
            kind: 'Expression',
            value: convertExpression(stmt.expression),
            loc: stmt.loc,
          })
        }
        continue
      }
      if (t.isVariableDeclaration(stmt)) {
        const eagerDestructuringNames = collectEagerDestructuringDeclaratorNames(stmt)
        for (const decl of stmt.declarations) {
          const declKind = normalizeVarKind(stmt.kind)
          if (t.isIdentifier(decl.id)) {
            target.instructions.push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: decl.id.name },
              value: decl.init
                ? convertExpression(decl.init)
                : ({ kind: 'Literal', value: undefined } as HLiteral),
              declarationKind: declKind,
              preserveEagerEvaluation: eagerDestructuringNames.has(decl.id.name) || undefined,
            })
            continue
          }

          if (t.isObjectPattern(decl.id)) {
            const tempName = `__destruct_${tempCounter++}`
            target.instructions.push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: tempName },
              value: decl.init
                ? convertExpression(decl.init)
                : ({ kind: 'Literal', value: undefined } as HLiteral),
              declarationKind: declKind,
            })

            const excludeKeys: BabelCore.types.Expression[] = []

            decl.id.properties.forEach(prop => {
              if (t.isObjectProperty(prop)) {
                if (prop.computed) {
                  reportUnsupportedExpression(
                    prop.key,
                    'Computed keys in object destructuring are not supported in HIR conversion.',
                  )
                  return
                }
                const keyName = t.isIdentifier(prop.key)
                  ? prop.key.name
                  : t.isStringLiteral(prop.key)
                    ? prop.key.value
                    : t.isNumericLiteral(prop.key)
                      ? String(prop.key.value)
                      : null
                if (!keyName) {
                  reportUnsupportedExpression(
                    prop.key,
                    'Unsupported object destructuring key in HIR conversion.',
                  )
                  return
                }
                excludeKeys.push(t.stringLiteral(keyName))
                if (t.isIdentifier(prop.value)) {
                  const memberExpr = t.memberExpression(
                    t.identifier(tempName),
                    t.identifier(keyName),
                    false,
                  )
                  target.instructions.push({
                    kind: 'Assign',
                    target: { kind: 'Identifier', name: prop.value.name },
                    value: convertExpression(memberExpr),
                    declarationKind: declKind,
                  })
                } else {
                  reportUnsupportedExpression(
                    prop.value as unknown as BabelCore.types.Node,
                    'Unsupported object destructuring pattern in HIR conversion.',
                  )
                  return
                }
              } else if (t.isRestElement(prop)) {
                if (!t.isIdentifier(prop.argument)) {
                  reportUnsupportedExpression(
                    prop.argument as unknown as BabelCore.types.Node,
                    'Rest destructuring patterns must be identifiers in HIR conversion.',
                  )
                  return
                }
                const restExpr = t.callExpression(t.identifier('__fictObjectRest'), [
                  t.identifier(tempName),
                  t.arrayExpression(excludeKeys),
                ])
                target.instructions.push({
                  kind: 'Assign',
                  target: { kind: 'Identifier', name: prop.argument.name },
                  value: convertExpression(restExpr),
                  declarationKind: declKind,
                })
              } else {
                reportUnsupportedExpression(
                  prop as unknown as BabelCore.types.Node,
                  'Unsupported object destructuring property in HIR conversion.',
                )
                return
              }
            })
          }

          if (t.isArrayPattern(decl.id)) {
            const tempName = `__destruct_${tempCounter++}`
            target.instructions.push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: tempName },
              value: decl.init
                ? convertExpression(decl.init)
                : ({ kind: 'Literal', value: undefined } as HLiteral),
              declarationKind: declKind,
            })

            decl.id.elements.forEach((elem, index) => {
              if (!elem) return
              if (t.isIdentifier(elem)) {
                const memberExpr = t.memberExpression(
                  t.identifier(tempName),
                  t.numericLiteral(index),
                  true,
                )
                target.instructions.push({
                  kind: 'Assign',
                  target: { kind: 'Identifier', name: elem.name },
                  value: convertExpression(memberExpr),
                  declarationKind: declKind,
                })
              } else if (t.isRestElement(elem)) {
                if (!t.isIdentifier(elem.argument)) {
                  reportUnsupportedExpression(
                    elem.argument as unknown as BabelCore.types.Node,
                    'Rest destructuring patterns must be identifiers in HIR conversion.',
                  )
                  return
                }
                const sliceCall = t.callExpression(
                  t.memberExpression(t.identifier(tempName), t.identifier('slice')),
                  [t.numericLiteral(index)],
                )
                target.instructions.push({
                  kind: 'Assign',
                  target: { kind: 'Identifier', name: elem.argument.name },
                  value: convertExpression(sliceCall),
                  declarationKind: declKind,
                })
              } else {
                reportUnsupportedExpression(
                  elem as unknown as BabelCore.types.Node,
                  'Unsupported array destructuring pattern in HIR conversion.',
                )
                return
              }
            })
          }
        }
        continue
      }
      if (t.isBlockStatement(stmt)) {
        // Process nested block statements
        processStmts(stmt.body, target)
        continue
      }
      if (t.isIfStatement(stmt)) {
        // For if statements in nested functions, create proper branch structure
        const consequentBlock = createBlock()
        const alternateBlock = createBlock()
        const joinBlock = createBlock()

        blocks.push(consequentBlock, alternateBlock, joinBlock)

        target.terminator = {
          kind: 'Branch',
          test: convertExpression(stmt.test as BabelCore.types.Expression),
          consequent: consequentBlock.id,
          alternate: alternateBlock.id,
        }

        // Process consequent
        if (t.isBlockStatement(stmt.consequent)) {
          processStmts(stmt.consequent.body, consequentBlock)
        } else {
          processStmts([stmt.consequent], consequentBlock)
        }
        if (consequentBlock.terminator.kind === 'Unreachable') {
          consequentBlock.terminator = { kind: 'Jump', target: joinBlock.id }
        }

        // Process alternate
        if (stmt.alternate) {
          if (t.isBlockStatement(stmt.alternate)) {
            processStmts(stmt.alternate.body, alternateBlock)
          } else {
            processStmts([stmt.alternate], alternateBlock)
          }
          if (alternateBlock.terminator.kind === 'Unreachable') {
            alternateBlock.terminator = { kind: 'Jump', target: joinBlock.id }
          }
        } else {
          alternateBlock.terminator = { kind: 'Jump', target: joinBlock.id }
        }

        const remaining = stmts.slice(index + 1)
        if (remaining.length > 0) {
          processStmts(remaining, joinBlock)
        }
        return
      }
      // For other statement types (for, while, etc.), convert to expression if possible
      // or skip to keep the builder total
    }
  }

  processStmts(statements, currentBlock)
  return blocks
}

/**
 * Experimental: Build a high-level IR from a Babel AST.
 *
 * This is intentionally minimal but now emits a simple CFG:
 * - Collects top-level function declarations or const function expressions.
 * - Preserves import/export statements in preamble/postamble.
 * - Emits basic blocks, branching on IfStatement into separate blocks with a join.
 * - Unhandled constructs are represented as undefined literals to keep traversal total.
 *
 * Future work will expand this into a full CFG + SSA builder.
 */
export function buildHIR(
  ast: BabelCore.types.File,
  macroAliases?: MacroAliases,
  options?: BuildHIROptions,
): HIRProgram {
  resetGeneratedSSANames()
  resetDestructuringTempCounter()
  const prevMacroAliases = activeMacroAliases
  const prevOptions = activeBuildOptions
  activeMacroAliases = resolveMacroAliases(macroAliases)
  activeBuildOptions = options
  try {
    const expandedAst = expandDestructuringAssignments(ast)
    const functions: HIRFunction[] = []
    const preamble: PreambleItem[] = []
    const postamble: PostambleItem[] = []
    const originalBody = [...expandedAst.program.body] as BabelStatement[]
    const directives = clonePreservedDirectives(expandedAst.program.directives)
    const programNoMemo =
      hasNoMemoDirective(expandedAst.program.directives) ||
      hasNoMemoDirectiveInStatements(expandedAst.program.body as BabelCore.types.Statement[])
    const programPure =
      hasPureDirective(expandedAst.program.directives) ||
      hasPureDirectiveInStatements(expandedAst.program.body as BabelCore.types.Statement[])

    // Track which function names we've processed to avoid duplicates in export
    const processedFunctions = new Set<string>()
    let defaultExportExpressionCounter = 0

    for (const stmt of expandedAst.program.body) {
      rejectUnsupportedTypeScriptRuntimeDeclaration(stmt)

      // Import declarations go to preamble
      if (t.isImportDeclaration(stmt)) {
        preamble.push(stmt)
        continue
      }

      // Function declarations
      if (t.isFunctionDeclaration(stmt) && stmt.body) {
        const name = stmt.id?.name
        if (name) processedFunctions.add(name)
        functions.push(
          convertFunction(name, stmt.params, stmt.body.body, {
            noMemo: programNoMemo,
            pure: programPure,
            directives: stmt.body.directives,
            loc: getLoc(stmt),
            isAsync: stmt.async,
            isGenerator: stmt.generator,
            astNode: stmt,
          }),
        )
        continue
      }

      // Export named declarations
      if (t.isExportNamedDeclaration(stmt)) {
        const decl = stmt.declaration
        if (decl) rejectUnsupportedTypeScriptRuntimeDeclaration(decl)
        if (decl && t.isFunctionDeclaration(decl) && decl.body) {
          // Export function declaration - convert to HIR and preserve export wrapper
          const name = decl.id?.name
          if (name) processedFunctions.add(name)
          functions.push(
            convertFunction(name, decl.params, decl.body.body, {
              noMemo: programNoMemo,
              pure: programPure,
              directives: decl.body.directives,
              loc: getLoc(decl),
              isAsync: decl.async,
              isGenerator: decl.generator,
              astNode: [decl, stmt],
            }),
          )
          // We'll recreate the export in codegen
          postamble.push({ kind: 'ExportFunction', name })
        } else if (decl && t.isVariableDeclaration(decl)) {
          // Check if it's a function expression
          let hasFunction = false
          for (const v of decl.declarations) {
            if (!t.isIdentifier(v.id)) continue
            const name = v.id.name
            if (t.isFunctionExpression(v.init) || t.isArrowFunctionExpression(v.init)) {
              hasFunction = true
              processedFunctions.add(name)
              const body = v.init.body
              const params = v.init.params
              const isArrow = t.isArrowFunctionExpression(v.init)
              const hasExpressionBody = isArrow && !t.isBlockStatement(body)
              const fnHIR = t.isBlockStatement(body)
                ? convertFunction(name, params, body.body, {
                    noMemo: programNoMemo,
                    pure: programPure,
                    directives: body.directives,
                    loc: getLoc(v.init ?? v),
                    isAsync: v.init.async,
                    isGenerator: t.isFunctionExpression(v.init) ? v.init.generator : false,
                    astNode: [v.init, v, decl, stmt],
                  })
                : convertFunction(name, params, [t.returnStatement(body)], {
                    noMemo: programNoMemo,
                    pure: programPure,
                    loc: getLoc(v.init ?? v),
                    isAsync: v.init.async,
                    isGenerator: false,
                    astNode: [v.init, v, decl, stmt],
                  })
              fnHIR.meta = {
                ...(fnHIR.meta ?? {}),
                fromExpression: true,
                ...(!isArrow && t.isFunctionExpression(v.init) && v.init.id
                  ? { functionExpressionName: v.init.id.name }
                  : null),
                isArrow,
                hasExpressionBody,
                ...(!isArrow && t.isFunctionExpression(v.init) && v.init.generator
                  ? { isGenerator: true }
                  : null),
              }
              functions.push(fnHIR)
              postamble.push({ kind: 'ExportFunction', name })
            }
          }
          if (!hasFunction) {
            // Non-function export - preserve as-is
            postamble.push(stmt)
          }
        } else if (!decl && stmt.specifiers.length > 0) {
          // Export specifiers (e.g., export { foo, bar })
          postamble.push(stmt)
        } else {
          postamble.push(stmt)
        }
        continue
      }

      // Export default declaration
      if (t.isExportDefaultDeclaration(stmt)) {
        const decl = stmt.declaration
        if (t.isFunctionDeclaration(decl) && decl.body) {
          const name = decl.id?.name || '__default'
          processedFunctions.add(name)
          const fnHIR = convertFunction(name, decl.params, decl.body.body, {
            noMemo: programNoMemo,
            pure: programPure,
            directives: decl.body.directives,
            loc: getLoc(decl),
            isAsync: decl.async,
            isGenerator: decl.generator,
            astNode: [decl, stmt],
          })
          if (!decl.id) {
            fnHIR.meta = {
              ...(fnHIR.meta ?? {}),
              anonymousDefaultExport: true,
            }
          }
          functions.push(fnHIR)
          postamble.push({ kind: 'ExportDefault', name })
        } else if (t.isArrowFunctionExpression(decl) || t.isFunctionExpression(decl)) {
          const name = `__default_export_${defaultExportExpressionCounter++}`
          processedFunctions.add(name)
          const body = decl.body
          const params = decl.params
          const isArrow = t.isArrowFunctionExpression(decl)
          const hasExpressionBody = isArrow && !t.isBlockStatement(body)
          const fnHIR = t.isBlockStatement(body)
            ? convertFunction(name, params, body.body, {
                noMemo: programNoMemo,
                pure: programPure,
                directives: body.directives,
                loc: getLoc(decl),
                isAsync: decl.async,
                isGenerator: t.isFunctionExpression(decl) ? decl.generator : false,
                astNode: [decl, stmt],
              })
            : convertFunction(
                name,
                params,
                [t.returnStatement(body as BabelCore.types.Expression)],
                {
                  noMemo: programNoMemo,
                  pure: programPure,
                  loc: getLoc(decl),
                  isAsync: decl.async,
                  isGenerator: false,
                  astNode: [decl, stmt],
                },
              )
          fnHIR.meta = {
            ...(fnHIR.meta ?? {}),
            fromExpression: true,
            defaultExportExpression: true,
            ...(!isArrow && t.isFunctionExpression(decl) && decl.id
              ? { functionExpressionName: decl.id.name }
              : null),
            isArrow,
            hasExpressionBody,
            ...(!isArrow && t.isFunctionExpression(decl) && decl.generator
              ? { isGenerator: true }
              : null),
          }
          functions.push(fnHIR)
          postamble.push({ kind: 'ExportDefault', name })
        } else if (t.isIdentifier(decl)) {
          postamble.push({ kind: 'ExportDefault', name: decl.name })
        } else {
          postamble.push(stmt)
        }
        continue
      }

      // Variable declarations - check for function expressions
      if (t.isVariableDeclaration(stmt)) {
        let hasFunction = false
        for (const decl of stmt.declarations) {
          if (!t.isIdentifier(decl.id)) continue
          const name = decl.id.name
          if (t.isFunctionExpression(decl.init) || t.isArrowFunctionExpression(decl.init)) {
            hasFunction = true
            processedFunctions.add(name)
            const body = decl.init.body
            const params = decl.init.params
            const isArrow = t.isArrowFunctionExpression(decl.init)
            const hasExpressionBody = isArrow && !t.isBlockStatement(body)
            const fnHIR = t.isBlockStatement(body)
              ? convertFunction(name, params, body.body, {
                  noMemo: programNoMemo,
                  pure: programPure,
                  directives: body.directives,
                  loc: getLoc(decl.init ?? decl),
                  isAsync: decl.init.async,
                  isGenerator: t.isFunctionExpression(decl.init) ? decl.init.generator : false,
                  astNode: [decl.init, decl, stmt],
                })
              : convertFunction(
                  name,
                  params,
                  [t.returnStatement(body as BabelCore.types.Expression)],
                  {
                    noMemo: programNoMemo,
                    pure: programPure,
                    loc: getLoc(decl.init ?? decl),
                    isAsync: decl.init.async,
                    isGenerator: false,
                    astNode: [decl.init, decl, stmt],
                  },
                )
            fnHIR.meta = {
              ...(fnHIR.meta ?? {}),
              fromExpression: true,
              ...(!isArrow && t.isFunctionExpression(decl.init) && decl.init.id
                ? { functionExpressionName: decl.init.id.name }
                : null),
              isArrow,
              hasExpressionBody,
              ...(!isArrow && t.isFunctionExpression(decl.init) && decl.init.generator
                ? { isGenerator: true }
                : null),
            }
            functions.push(fnHIR)
          }
        }
        if (!hasFunction) {
          // Non-function variable declaration - preserve
          postamble.push(stmt)
        }
        continue
      }

      // Other statements go to postamble
      postamble.push(stmt)
    }

    return {
      functions,
      preamble,
      postamble,
      originalBody,
      ...(directives.length > 0 ? { directives } : null),
    }
  } finally {
    activeMacroAliases = prevMacroAliases
    activeBuildOptions = prevOptions
  }
}

function convertFunction(
  name: string | undefined,
  params: BabelCore.types.Node[],
  body: BabelCore.types.Statement[],
  options?: {
    noMemo?: boolean
    pure?: boolean
    directives?: BabelCore.types.Directive[] | null
    loc?: BabelCore.types.SourceLocation | null
    isAsync?: boolean
    isGenerator?: boolean
    /** Original AST node(s) for parsing @fictReturn annotations */
    astNode?: BabelCore.types.Node | null | (BabelCore.types.Node | null | undefined)[]
  },
): HIRFunction {
  const paramIds: HIdentifier[] = []
  for (const p of params) {
    if (t.isIdentifier(p)) {
      paramIds.push({ kind: 'Identifier', name: p.name })
    } else if (t.isObjectPattern(p) || t.isArrayPattern(p)) {
      // Handle destructuring parameters: ({ a, b }) or ([first, second])
      paramIds.push(...extractIdentifiersFromPattern(p))
    } else if (t.isAssignmentPattern(p)) {
      // Handle default value patterns: (a = 1) or ({ x } = {})
      if (t.isIdentifier(p.left)) {
        paramIds.push({ kind: 'Identifier', name: p.left.name })
      } else if (t.isObjectPattern(p.left) || t.isArrayPattern(p.left)) {
        paramIds.push(...extractIdentifiersFromPattern(p.left))
      }
    } else if (t.isRestElement(p)) {
      // Handle rest parameters: (...args) or rest patterns
      if (t.isIdentifier(p.argument)) {
        paramIds.push({ kind: 'Identifier', name: p.argument.name })
      } else if (t.isPattern(p.argument)) {
        paramIds.push(...extractIdentifiersFromPattern(p.argument))
      }
    }
    // Other unsupported patterns are skipped to keep builder total
  }

  const bodyStatements = [...body]
  const hasNoMemoInBody = hasNoMemoDirectiveInStatements(bodyStatements)
  const hasPureInBody = hasPureDirectiveInStatements(bodyStatements)
  while (hasNoMemoDirectiveInStatements(bodyStatements)) {
    bodyStatements.shift()
  }
  while (hasPureDirectiveInStatements(bodyStatements)) {
    bodyStatements.shift()
  }

  const blocks: BasicBlock[] = []
  let nextBlockId = 0

  const createBlock = (): BlockBuilder => ({
    block: { id: nextBlockId++, instructions: [], terminator: { kind: 'Unreachable' } },
    sealed: false,
  })

  let current = createBlock()
  blocks.push(current.block)

  const sealCurrent = (terminator: BasicBlock['terminator']) => {
    if (current.sealed) return
    current.block.terminator = terminator
    current.sealed = true
  }

  const startNewBlock = (): BlockBuilder => {
    const bb = createBlock()
    blocks.push(bb.block)
    current = bb
    return bb
  }

  // Create CFG build context for nested control flow support
  const cfgContext: CFGBuildContext = {
    blocks,
    nextBlockId: () => nextBlockId++,
    createBlock,
    loopStack: [],
    labeledStatements: new Map(),
  }

  emitHoistedFunctionDeclarations(bodyStatements, instr => current.block.instructions.push(instr))

  for (let index = 0; index < bodyStatements.length; index++) {
    const stmt = bodyStatements[index]!
    if (t.isFunctionDeclaration(stmt)) {
      continue
    }
    if (t.isDebuggerStatement(stmt)) {
      current.block.instructions.push({
        kind: 'Debugger',
        loc: stmt.loc,
      })
      continue
    }
    if (t.isReturnStatement(stmt)) {
      const returnExpr = stmt.argument ? convertExpression(stmt.argument) : undefined
      sealCurrent({ kind: 'Return', argument: returnExpr })
      appendPostTerminatorDeclarations(current.block, bodyStatements.slice(index + 1))
      break
    }
    if (t.isExpressionStatement(stmt)) {
      const handled = handleExpressionStatement(stmt.expression, instr =>
        current.block.instructions.push(instr),
      )
      if (!handled) {
        current.block.instructions.push({
          kind: 'Expression',
          value: convertExpression(stmt.expression),
          loc: stmt.loc,
        })
      }
      continue
    }
    if (t.isVariableDeclaration(stmt)) {
      const declKind = normalizeVarKind(stmt.kind)
      const eagerDestructuringNames = collectEagerDestructuringDeclaratorNames(stmt)
      for (const decl of stmt.declarations) {
        if (t.isIdentifier(decl.id)) {
          current.block.instructions.push({
            kind: 'Assign',
            target: { kind: 'Identifier', name: decl.id.name },
            value: decl.init
              ? convertExpression(decl.init)
              : ({ kind: 'Literal', value: undefined } as HLiteral),
            declarationKind: declKind,
            loc: decl.loc ?? stmt.loc,
            preserveEagerEvaluation: eagerDestructuringNames.has(decl.id.name) || undefined,
          })
          continue
        }

        if (t.isObjectPattern(decl.id)) {
          const useTemp = !(decl.init && t.isIdentifier(decl.init))
          const tempName = `__destruct_${destructuringTempCounter++}`
          // When useTemp is true, we convert and store the HIR expression
          // When useTemp is false, we keep the Babel expression for member access
          const hirExpr: Expression | undefined =
            useTemp && decl.init ? convertExpression(decl.init) : undefined
          const babelSourceExpr: BabelCore.types.Expression | undefined =
            decl.init && !useTemp ? (decl.init as BabelCore.types.Expression) : undefined

          if (useTemp) {
            current.block.instructions.push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: tempName },
              value: hirExpr ?? ({ kind: 'Literal', value: undefined } as HLiteral),
              declarationKind: declKind,
            })
          }

          const excludeKeys: BabelCore.types.Expression[] = []

          decl.id.properties.forEach(prop => {
            if (t.isObjectProperty(prop)) {
              if (prop.computed) {
                reportUnsupportedExpression(
                  prop.key,
                  'Computed keys in object destructuring are not supported in HIR conversion.',
                )
                return
              }
              const keyName = t.isIdentifier(prop.key)
                ? prop.key.name
                : t.isStringLiteral(prop.key)
                  ? prop.key.value
                  : t.isNumericLiteral(prop.key)
                    ? String(prop.key.value)
                    : null
              if (!keyName) {
                reportUnsupportedExpression(
                  prop.key,
                  'Unsupported object destructuring key in HIR conversion.',
                )
                return
              }
              excludeKeys.push(t.stringLiteral(keyName))
              if (t.isIdentifier(prop.value)) {
                const memberExpr = t.memberExpression(
                  useTemp
                    ? t.identifier(tempName)
                    : (babelSourceExpr as BabelCore.types.Expression),
                  t.identifier(keyName),
                  false,
                )
                current.block.instructions.push({
                  kind: 'Assign',
                  target: { kind: 'Identifier', name: prop.value.name },
                  value: convertExpression(memberExpr),
                  declarationKind: declKind,
                })
              } else {
                reportUnsupportedExpression(
                  prop.value as unknown as BabelCore.types.Node,
                  'Unsupported object destructuring pattern in HIR conversion.',
                )
                return
              }
            } else if (t.isRestElement(prop)) {
              if (!t.isIdentifier(prop.argument)) {
                reportUnsupportedExpression(
                  prop.argument as unknown as BabelCore.types.Node,
                  'Rest destructuring patterns must be identifiers in HIR conversion.',
                )
                return
              }
              const restExpr = t.callExpression(t.identifier('__fictObjectRest'), [
                useTemp ? t.identifier(tempName) : (babelSourceExpr as BabelCore.types.Expression),
                t.arrayExpression(excludeKeys),
              ])
              current.block.instructions.push({
                kind: 'Assign',
                target: { kind: 'Identifier', name: prop.argument.name },
                value: convertExpression(restExpr),
                declarationKind: declKind,
              })
            } else {
              reportUnsupportedExpression(
                prop as unknown as BabelCore.types.Node,
                'Unsupported object destructuring property in HIR conversion.',
              )
              return
            }
          })
        }

        if (t.isArrayPattern(decl.id)) {
          const tempName = `__destruct_${destructuringTempCounter++}`
          current.block.instructions.push({
            kind: 'Assign',
            target: { kind: 'Identifier', name: tempName },
            value: decl.init
              ? convertExpression(decl.init)
              : ({ kind: 'Literal', value: undefined } as HLiteral),
            declarationKind: declKind,
          })

          decl.id.elements.forEach((elem, index) => {
            if (!elem) return
            if (t.isIdentifier(elem)) {
              const memberExpr = t.memberExpression(
                t.identifier(tempName),
                t.numericLiteral(index),
                true,
              )
              current.block.instructions.push({
                kind: 'Assign',
                target: { kind: 'Identifier', name: elem.name },
                value: convertExpression(memberExpr),
                declarationKind: declKind,
              })
            } else if (t.isRestElement(elem)) {
              if (!t.isIdentifier(elem.argument)) {
                reportUnsupportedExpression(
                  elem.argument as unknown as BabelCore.types.Node,
                  'Rest destructuring patterns must be identifiers in HIR conversion.',
                )
                return
              }
              const sliceCall = t.callExpression(
                t.memberExpression(t.identifier(tempName), t.identifier('slice')),
                [t.numericLiteral(index)],
              )
              current.block.instructions.push({
                kind: 'Assign',
                target: { kind: 'Identifier', name: elem.argument.name },
                value: convertExpression(sliceCall),
                declarationKind: declKind,
              })
            } else {
              reportUnsupportedExpression(
                elem as unknown as BabelCore.types.Node,
                'Unsupported array destructuring pattern in HIR conversion.',
              )
              return
            }
          })
        }
      }
      continue
    }
    if (t.isBlockStatement(stmt)) {
      current = processLexicalBlockStatement(stmt, current, cfgContext)
      continue
    }
    if (t.isIfStatement(stmt)) {
      const branchSource = current
      const consequentBlock = createBlock()
      const alternateBlock = createBlock()
      const joinBlock = createBlock()

      blocks.push(consequentBlock.block, alternateBlock.block, joinBlock.block)

      // Set branch terminator on source block
      const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
      branchSource.block.terminator = {
        kind: 'Branch',
        test: testExpr,
        consequent: consequentBlock.block.id,
        alternate: alternateBlock.block.id,
      }
      branchSource.sealed = true

      // Fill consequent with nested control flow support
      fillStatements(stmt.consequent, consequentBlock, joinBlock.block.id, cfgContext)
      // Fill alternate
      if (stmt.alternate) {
        fillStatements(stmt.alternate, alternateBlock, joinBlock.block.id, cfgContext)
      } else {
        // empty alternate jumps to join
        alternateBlock.block.terminator = { kind: 'Jump', target: joinBlock.block.id }
        alternateBlock.sealed = true
      }

      current = joinBlock as BlockBuilder
      continue
    }
    if (t.isWhileStatement(stmt)) {
      const condBlock = createBlock()
      const bodyBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(condBlock.block, bodyBlock.block, exitBlock.block)
      condBlock.block.sourceLoop = {
        kind: 'while',
        body: bodyBlock.block.id,
        exit: exitBlock.block.id,
      }

      // jump from current to condition
      current.block.terminator = { kind: 'Jump', target: condBlock.block.id }
      current.sealed = true

      // condition branch
      const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
      condBlock.block.terminator = {
        kind: 'Branch',
        test: testExpr,
        consequent: bodyBlock.block.id,
        alternate: exitBlock.block.id,
      }
      condBlock.sealed = true

      // Push loop context for break/continue
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: condBlock.block.id,
      })

      // body: after body, jump back to condition (with nested control flow support)
      fillStatements(stmt.body, bodyBlock, condBlock.block.id, cfgContext)

      // Pop loop context
      cfgContext.loopStack.pop()

      current = exitBlock as BlockBuilder
      continue
    }
    if (t.isForStatement(stmt)) {
      const condBlock = createBlock()
      const bodyBlock = createBlock()
      const updateBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(condBlock.block, bodyBlock.block, updateBlock.block, exitBlock.block)
      const initInstructions: Instruction[] = []

      // init in current block
      if (stmt.init && t.isVariableDeclaration(stmt.init)) {
        const initKind = normalizeVarKind(stmt.init.kind)
        for (const decl of stmt.init.declarations) {
          if (!t.isIdentifier(decl.id)) continue
          const instr: Instruction = {
            kind: 'Assign',
            target: { kind: 'Identifier', name: decl.id.name },
            value: decl.init
              ? convertExpression(decl.init)
              : ({ kind: 'Literal', value: undefined } as HLiteral),
            declarationKind: initKind,
          }
          current.block.instructions.push(instr)
          initInstructions.push(instr)
        }
      } else if (stmt.init && t.isExpression(stmt.init)) {
        current.block.instructions.push({
          kind: 'Expression',
          value: convertExpression(stmt.init),
        })
      }
      condBlock.block.sourceLoop = {
        kind: 'for',
        body: bodyBlock.block.id,
        update: updateBlock.block.id,
        exit: exitBlock.block.id,
        ...(initInstructions.length > 0 ? { init: initInstructions } : null),
      }

      // jump to condition
      current.block.terminator = { kind: 'Jump', target: condBlock.block.id }
      current.sealed = true

      // condition
      const testExpr = stmt.test
        ? convertExpression(stmt.test as BabelCore.types.Expression)
        : undefined
      if (testExpr) {
        condBlock.block.terminator = {
          kind: 'Branch',
          test: testExpr,
          consequent: bodyBlock.block.id,
          alternate: exitBlock.block.id,
        }
      } else {
        // no test means always true
        condBlock.block.terminator = {
          kind: 'Jump',
          target: bodyBlock.block.id,
        }
      }
      condBlock.sealed = true

      // Push loop context for break/continue
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: updateBlock.block.id, // continue goes to update in for loop
      })

      // body (with nested control flow support)
      fillStatements(stmt.body, bodyBlock, updateBlock.block.id, cfgContext)

      // Pop loop context
      cfgContext.loopStack.pop()

      // update
      if (stmt.update && t.isExpression(stmt.update)) {
        updateBlock.block.instructions.push({
          kind: 'Expression',
          value: convertExpression(stmt.update),
        })
      }
      updateBlock.block.terminator = { kind: 'Jump', target: condBlock.block.id }
      updateBlock.sealed = true

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle do-while at top level
    if (t.isDoWhileStatement(stmt)) {
      const bodyBlock = createBlock()
      const condBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(bodyBlock.block, condBlock.block, exitBlock.block)
      bodyBlock.block.sourceLoop = {
        kind: 'doWhile',
        condition: condBlock.block.id,
        exit: exitBlock.block.id,
      }

      // Jump directly to body
      current.block.terminator = { kind: 'Jump', target: bodyBlock.block.id }
      current.sealed = true

      // Push loop context for break/continue BEFORE processing body
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: condBlock.block.id,
      })

      // Body goes to condition (with nested control flow support)
      fillStatements(stmt.body, bodyBlock, condBlock.block.id, cfgContext)

      // Pop loop context AFTER processing body
      cfgContext.loopStack.pop()

      // Condition branches back to body or exits
      const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
      condBlock.block.terminator = {
        kind: 'Branch',
        test: testExpr,
        consequent: bodyBlock.block.id,
        alternate: exitBlock.block.id,
      }
      condBlock.sealed = true

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle switch at top level
    if (t.isSwitchStatement(stmt)) {
      const exitBlock = createBlock()
      blocks.push(exitBlock.block)

      const caseBlocks = stmt.cases.map(() => createBlock())
      for (const caseBlock of caseBlocks) {
        blocks.push(caseBlock.block)
      }

      const cases: { test?: Expression; target: number; syntheticDefault?: boolean }[] = []
      let hasDefault = false

      for (let index = 0; index < stmt.cases.length; index++) {
        const switchCase = stmt.cases[index]!
        const caseBlock = caseBlocks[index]!
        if (switchCase.test) {
          cases.push({
            test: convertExpression(switchCase.test as BabelCore.types.Expression),
            target: caseBlock.block.id,
          })
        } else {
          hasDefault = true
          cases.push({
            target: caseBlock.block.id,
          })
        }
      }

      // Allow `break` inside switch cases (including nested block statements)
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
      })

      for (let index = 0; index < stmt.cases.length; index++) {
        const switchCase = stmt.cases[index]!
        const caseBlock = caseBlocks[index]!
        const nextCaseBlock = caseBlocks[index + 1]
        const fallthroughTarget = nextCaseBlock ? nextCaseBlock.block.id : exitBlock.block.id
        // Process case statements
        let caseBuilder: BlockBuilder = caseBlock
        for (let stmtIndex = 0; stmtIndex < switchCase.consequent.length; stmtIndex++) {
          const s = switchCase.consequent[stmtIndex]!
          if (caseBuilder.sealed) break
          caseBuilder = processStatement(s, caseBuilder, exitBlock.block.id, cfgContext)
          if (caseBuilder.sealed) {
            const termKind = caseBuilder.block.terminator.kind
            if (termKind === 'Return' || termKind === 'Throw') {
              appendPostTerminatorDeclarations(
                caseBuilder.block,
                switchCase.consequent.slice(stmtIndex + 1),
              )
            }
          }
        }

        // Fall through if not sealed
        if (!caseBuilder.sealed) {
          caseBuilder.block.terminator = { kind: 'Jump', target: fallthroughTarget }
          caseBuilder.sealed = true
        }
      }

      cfgContext.loopStack.pop()

      // Add default case
      if (!hasDefault) {
        cases.push({ target: exitBlock.block.id, syntheticDefault: true })
      }

      current.block.terminator = {
        kind: 'Switch',
        discriminant: convertExpression(stmt.discriminant as BabelCore.types.Expression),
        cases,
      }
      current.sealed = true

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle for-of at top level
    if (t.isForOfStatement(stmt)) {
      const bodyBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(bodyBlock.block, exitBlock.block)

      // Get the iteration variable info (name, kind, pattern)
      const left = stmt.left
      let varName = '_item'
      let varKind: 'const' | 'let' | 'var' = 'const'
      let pattern: BabelCore.types.LVal | undefined
      let leftKind: 'declaration' | 'assignment' = 'declaration'
      let assignmentTarget: Expression | undefined

      if (t.isVariableDeclaration(left) && left.declarations[0]) {
        varKind = left.kind as 'const' | 'let' | 'var'
        const decl = left.declarations[0]
        if (t.isIdentifier(decl.id)) {
          varName = decl.id.name
        } else if (t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)) {
          // Destructuring pattern - store the pattern and generate a temp name
          varName = `__forOf_${bodyBlock.block.id}`
          pattern = decl.id
        }
      } else if (t.isIdentifier(left)) {
        varName = left.name
        varKind = 'let' // Existing variable assignment
        leftKind = 'assignment'
      } else if (t.isMemberExpression(left)) {
        assignmentTarget = convertExpression(left)
        leftKind = 'assignment'
      }

      // Create ForOf terminator
      const iterableExpr = convertExpression(stmt.right as BabelCore.types.Expression)

      current.block.terminator = {
        kind: 'ForOf',
        variable: varName,
        leftKind,
        variableKind: varKind,
        pattern,
        ...(assignmentTarget ? { assignmentTarget } : null),
        ...(stmt.await ? { await: true } : null),
        iterable: iterableExpr,
        body: bodyBlock.block.id,
        exit: exitBlock.block.id,
      }
      current.sealed = true

      // Push loop context
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: bodyBlock.block.id,
      })

      // Process body
      fillStatements(stmt.body, bodyBlock, exitBlock.block.id, cfgContext)

      // Pop loop context
      cfgContext.loopStack.pop()

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle for-in at top level
    if (t.isForInStatement(stmt)) {
      const bodyBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(bodyBlock.block, exitBlock.block)

      // Get the iteration variable info (name, kind, pattern)
      const left = stmt.left
      let varName = '_item'
      let varKind: 'const' | 'let' | 'var' = 'const'
      let pattern: BabelCore.types.LVal | undefined
      let leftKind: 'declaration' | 'assignment' = 'declaration'
      let assignmentTarget: Expression | undefined

      if (t.isVariableDeclaration(left) && left.declarations[0]) {
        varKind = left.kind as 'const' | 'let' | 'var'
        const decl = left.declarations[0]
        if (t.isIdentifier(decl.id)) {
          varName = decl.id.name
        } else if (t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)) {
          // Destructuring pattern - store the pattern and generate a temp name
          varName = `__forIn_${bodyBlock.block.id}`
          pattern = decl.id
        }
      } else if (t.isIdentifier(left)) {
        varName = left.name
        varKind = 'let' // Existing variable assignment
        leftKind = 'assignment'
      } else if (t.isMemberExpression(left)) {
        assignmentTarget = convertExpression(left)
        leftKind = 'assignment'
      }

      // Create ForIn terminator
      const objectExpr = convertExpression(stmt.right as BabelCore.types.Expression)

      current.block.terminator = {
        kind: 'ForIn',
        variable: varName,
        leftKind,
        variableKind: varKind,
        pattern,
        ...(assignmentTarget ? { assignmentTarget } : null),
        object: objectExpr,
        body: bodyBlock.block.id,
        exit: exitBlock.block.id,
      }
      current.sealed = true

      // Push loop context
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: bodyBlock.block.id,
      })

      // Process body
      fillStatements(stmt.body, bodyBlock, exitBlock.block.id, cfgContext)

      // Pop loop context
      cfgContext.loopStack.pop()

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle try-catch-finally at top level
    if (t.isTryStatement(stmt)) {
      const tryBlock = createBlock()
      const catchBlock = stmt.handler ? createBlock() : null
      const finallyBlock = stmt.finalizer ? createBlock() : null
      const exitBlock = createBlock()

      blocks.push(tryBlock.block, exitBlock.block)
      if (catchBlock) blocks.push(catchBlock.block)
      if (finallyBlock) blocks.push(finallyBlock.block)

      // Get catch param name
      const catchParamInfo = getCatchParamInfo(stmt.handler)

      // Create Try terminator
      current.block.terminator = {
        kind: 'Try',
        tryBlock: tryBlock.block.id,
        catchBlock: catchBlock?.block.id,
        catchParam: catchParamInfo.catchParam,
        catchPattern: catchParamInfo.catchPattern,
        finallyBlock: finallyBlock?.block.id,
        exit: exitBlock.block.id,
      }
      current.sealed = true

      // Process try block
      fillStatements(stmt.block, tryBlock, finallyBlock?.block.id ?? exitBlock.block.id, cfgContext)

      // Process catch block
      if (catchBlock && stmt.handler) {
        fillStatements(
          stmt.handler.body,
          catchBlock,
          finallyBlock?.block.id ?? exitBlock.block.id,
          cfgContext,
        )
      }

      // Process finally block
      if (finallyBlock && stmt.finalizer) {
        fillStatements(stmt.finalizer, finallyBlock, exitBlock.block.id, cfgContext)
      }

      current = exitBlock as BlockBuilder
      continue
    }

    // Route any remaining statement kinds through the generic statement handler.
    // This prevents silent statement loss when top-level handling misses a node kind.
    current = processStatement(stmt, current, current.block.id, cfgContext)
    if (current.sealed) {
      const termKind = current.block.terminator.kind
      if (termKind === 'Return' || termKind === 'Throw') {
        appendPostTerminatorDeclarations(current.block, bodyStatements.slice(index + 1))
        break
      }
      current = startNewBlock()
    }
  }

  // Seal final block if not sealed
  if (!current.sealed) {
    current.block.terminator = { kind: 'Unreachable' }
    current.sealed = true
  }

  const hasNoMemo =
    !!options?.noMemo || hasNoMemoDirective(options?.directives ?? null) || hasNoMemoInBody
  const hasPure = !!options?.pure || hasPureDirective(options?.directives ?? null) || hasPureInBody
  const directives = clonePreservedDirectives(options?.directives ?? null)
  const isAsync = !!options?.isAsync
  const isGenerator = !!options?.isGenerator

  // Parse @fictReturn annotation for cross-module hook return info
  const fictReturnInfo = parseFictReturnAnnotation(options?.astNode)

  const hasLabeledStatements = cfgContext.labeledStatements.size > 0
  const hasMeta =
    hasNoMemo ||
    hasPure ||
    directives.length > 0 ||
    fictReturnInfo ||
    isAsync ||
    isGenerator ||
    hasLabeledStatements

  return {
    rawParams: params,
    name,
    params: paramIds,
    blocks,
    meta: hasMeta
      ? {
          ...(hasNoMemo ? { noMemo: true } : null),
          ...(hasPure ? { pure: true } : null),
          ...(directives.length > 0 ? { directives } : null),
          ...(fictReturnInfo ? { hookReturnInfo: fictReturnInfo } : null),
          ...(isAsync ? { isAsync: true } : null),
          ...(isGenerator ? { isGenerator: true } : null),
          ...(hasLabeledStatements
            ? { labeledStatements: new Map(cfgContext.labeledStatements) }
            : null),
        }
      : undefined,
    loc: options?.loc ?? null,
  }
}

/**
 * Build an HIR function from a list of statements.
 * Useful for lowering top-level (non-export) statement sequences with the same codegen path as functions.
 */
export function convertStatementsToHIRFunction(
  name: string,
  statements: BabelCore.types.Statement[],
  options?: BuildHIROptions,
): HIRFunction {
  resetDestructuringTempCounter()
  const prevOptions = activeBuildOptions
  if (options) {
    activeBuildOptions = options
  }
  try {
    return convertFunction(name, [], statements, { loc: getLoc(statements[0]) })
  } finally {
    if (options) {
      activeBuildOptions = prevOptions
    }
  }
}

function convertAssignmentValue(expr: BabelCore.types.AssignmentExpression): Expression {
  const right = convertExpression(expr.right as BabelCore.types.Expression)
  if (expr.operator === '=') return right

  const operatorMap: Record<string, string> = {
    '+=': '+',
    '-=': '-',
    '*=': '*',
    '/=': '/',
    '%=': '%',
    '**=': '**',
    '<<=': '<<',
    '>>=': '>>',
    '>>>=': '>>>',
    '|=': '|',
    '^=': '^',
    '&=': '&',
  }
  const mapped = operatorMap[expr.operator]
  if (mapped && t.isIdentifier(expr.left)) {
    return {
      kind: 'BinaryExpression',
      operator: mapped,
      left: { kind: 'Identifier', name: expr.left.name },
      right,
    }
  }

  return right
}

type InstructionPush = (instr: BasicBlock['instructions'][number]) => void

function unwrapExpression(expr: BabelCore.types.Expression): BabelCore.types.Expression {
  let current: BabelCore.types.Expression = expr
  while (true) {
    if (
      t.isTSAsExpression(current) ||
      t.isTSTypeAssertion(current) ||
      t.isTSNonNullExpression(current) ||
      t.isTSSatisfiesExpression(current) ||
      t.isTSInstantiationExpression(current) ||
      t.isTypeCastExpression(current)
    ) {
      current = current.expression as BabelCore.types.Expression
      continue
    }
    if (t.isParenthesizedExpression(current)) {
      current = current.expression as BabelCore.types.Expression
      continue
    }
    return current
  }
}

function handleExpressionStatement(
  expr: BabelCore.types.Expression,
  push: InstructionPush,
): boolean {
  const unwrapped = unwrapExpression(expr)
  if (!t.isAssignmentExpression(unwrapped)) return false
  if (isLogicalAssignmentOperator(unwrapped.operator)) return false

  if (unwrapped.operator === '=' && t.isObjectPattern(unwrapped.left)) {
    const useTemp = !t.isIdentifier(unwrapped.right)
    const tempName = `__destruct_${destructuringTempCounter++}`
    const sourceExpr = useTemp
      ? t.identifier(tempName)
      : (unwrapped.right as BabelCore.types.Expression)

    if (useTemp) {
      push({
        kind: 'Assign',
        target: { kind: 'Identifier', name: tempName },
        value: convertExpression(unwrapped.right as BabelCore.types.Expression),
        declarationKind: 'const',
      })
    }

    const excludeKeys: BabelCore.types.Expression[] = []
    for (const prop of unwrapped.left.properties) {
      if (t.isObjectProperty(prop)) {
        if (prop.computed) {
          reportUnsupportedExpression(
            prop.key,
            'Computed keys in object destructuring are not supported in HIR conversion.',
          )
          return true
        }
        const keyName = t.isIdentifier(prop.key)
          ? prop.key.name
          : t.isStringLiteral(prop.key)
            ? prop.key.value
            : t.isNumericLiteral(prop.key)
              ? String(prop.key.value)
              : null
        if (!keyName) {
          reportUnsupportedExpression(
            prop.key,
            'Unsupported object destructuring key in HIR conversion.',
          )
          return true
        }
        excludeKeys.push(t.stringLiteral(keyName))
        if (!t.isIdentifier(prop.value)) {
          reportUnsupportedExpression(
            prop.value as unknown as BabelCore.types.Node,
            'Unsupported object destructuring pattern in HIR conversion.',
          )
          return true
        }
        const memberExpr = t.memberExpression(sourceExpr, t.identifier(keyName), false)
        push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: prop.value.name },
          value: convertExpression(memberExpr),
          isMutation: true,
        })
        continue
      }
      if (t.isRestElement(prop)) {
        if (!t.isIdentifier(prop.argument)) {
          reportUnsupportedExpression(
            prop.argument as unknown as BabelCore.types.Node,
            'Rest destructuring patterns must be identifiers in HIR conversion.',
          )
          return true
        }
        const restExpr = t.callExpression(t.identifier('__fictObjectRest'), [
          sourceExpr,
          t.arrayExpression(excludeKeys),
        ])
        push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: prop.argument.name },
          value: convertExpression(restExpr),
          isMutation: true,
        })
        continue
      }
      reportUnsupportedExpression(
        prop as unknown as BabelCore.types.Node,
        'Unsupported object destructuring property in HIR conversion.',
      )
      return true
    }
    return true
  }

  if (t.isIdentifier(unwrapped.left)) {
    push({
      kind: 'Assign',
      target: { kind: 'Identifier', name: unwrapped.left.name },
      value: convertAssignmentValue(unwrapped),
      isMutation: true,
    })
    return true
  }

  return false
}

/**
 * Context for building nested control flow structures.
 * This enables recursive handling of if/for/while inside branches.
 */
interface LoopContext {
  breakTarget: number
  continueTarget?: number | undefined
  label?: string | undefined
}

interface CFGBuildContext {
  blocks: BasicBlock[]
  nextBlockId: () => number
  createBlock: () => BlockBuilder
  loopStack: LoopContext[]
  labeledStatements: Map<number, LabeledStatementMeta>
}

function markLabeledStatement(
  ctx: CFGBuildContext | undefined,
  blockId: number,
  label: string | undefined,
  exitBlock?: number,
): void {
  if (!ctx || !label) return
  ctx.labeledStatements.set(blockId, { label, ...(exitBlock !== undefined ? { exitBlock } : null) })
}

function findBreakContext(ctx: CFGBuildContext, label?: string): LoopContext | undefined {
  if (label) {
    for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
      const entry = ctx.loopStack[i]
      if (entry?.label === label) return entry
    }
    return undefined
  }
  return ctx.loopStack[ctx.loopStack.length - 1]
}

function findContinueContext(ctx: CFGBuildContext, label?: string): LoopContext | undefined {
  if (label) {
    for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
      const entry = ctx.loopStack[i]
      if (entry?.label === label && entry.continueTarget !== undefined) return entry
    }
    return undefined
  }
  for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
    const entry = ctx.loopStack[i]
    if (entry?.continueTarget !== undefined) return entry
  }
  return undefined
}

function getCatchParamInfo(handler: BabelCore.types.CatchClause | null | undefined): {
  catchParam?: string | undefined
  catchPattern?: BabelCore.types.LVal | undefined
} {
  const param = handler?.param
  if (!param) return {}
  return {
    ...(t.isIdentifier(param) ? { catchParam: param.name } : null),
    catchPattern: t.cloneNode(param, true) as BabelCore.types.LVal,
  }
}

/**
 * Fill statements into a block, handling nested control flow recursively.
 * Returns the final block after processing all statements.
 */
function fillStatements(
  stmt: BabelCore.types.Statement,
  bb: BlockBuilder,
  jumpTarget: number,
  ctx?: CFGBuildContext,
): BlockBuilder {
  // Note: push and seal are not used directly here but kept for consistency
  // with processStatement. The function delegates to processStatement.

  if (t.isBlockStatement(stmt)) {
    let current = bb
    emitHoistedFunctionDeclarations(stmt.body, instr => current.block.instructions.push(instr), {
      blockScoped: true,
    })
    for (let index = 0; index < stmt.body.length; index++) {
      const s = stmt.body[index]!
      if (t.isFunctionDeclaration(s)) {
        continue
      }
      current = processStatement(s, current, jumpTarget, ctx)
      if (current.sealed) {
        const termKind = current.block.terminator.kind
        if (termKind === 'Return' || termKind === 'Throw') {
          appendPostTerminatorDeclarations(current.block, stmt.body.slice(index + 1))
        }
        return current
      }
    }
    if (!current.sealed) {
      current.block.terminator = { kind: 'Jump', target: jumpTarget }
      current.sealed = true
    }
    return current
  }

  const result = processStatement(stmt, bb, jumpTarget, ctx)
  if (!result.sealed) {
    result.block.terminator = { kind: 'Jump', target: jumpTarget }
    result.sealed = true
  }
  return result
}

function processLexicalBlockStatement(
  stmt: BabelCore.types.BlockStatement,
  bb: BlockBuilder,
  ctx: CFGBuildContext,
): BlockBuilder {
  const bodyBlock = ctx.createBlock()
  const exitBlock = ctx.createBlock()
  bodyBlock.block.lexicalScopeExit = exitBlock.block.id
  ctx.blocks.push(bodyBlock.block, exitBlock.block)

  bb.block.terminator = { kind: 'Jump', target: bodyBlock.block.id }
  bb.sealed = true

  const bodyEnd = fillStatements(stmt, bodyBlock, exitBlock.block.id, ctx)
  if (bodyEnd.sealed) {
    const term = bodyEnd.block.terminator
    if (
      term.kind === 'Return' ||
      term.kind === 'Throw' ||
      term.kind === 'Break' ||
      term.kind === 'Continue'
    ) {
      return bodyEnd
    }
  }

  return exitBlock
}

/**
 * Process a single statement, potentially creating new blocks for control flow.
 */
function processStatement(
  stmt: BabelCore.types.Statement,
  bb: BlockBuilder,
  jumpTarget: number,
  ctx?: CFGBuildContext,
  labelOverride?: string,
): BlockBuilder {
  const push = (instr: BasicBlock['instructions'][number]) => bb.block.instructions.push(instr)

  if (t.isLabeledStatement(stmt) && ctx) {
    const label = stmt.label.name
    const body = stmt.body as BabelCore.types.Statement
    if (
      t.isWhileStatement(body) ||
      t.isForStatement(body) ||
      t.isDoWhileStatement(body) ||
      t.isForInStatement(body) ||
      t.isForOfStatement(body) ||
      t.isSwitchStatement(body)
    ) {
      return processStatement(body, bb, jumpTarget, ctx, label)
    }

    const bodyBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()
    ctx.blocks.push(bodyBlock.block, exitBlock.block)
    markLabeledStatement(ctx, bodyBlock.block.id, label, exitBlock.block.id)

    bb.block.terminator = { kind: 'Jump', target: bodyBlock.block.id }
    bb.sealed = true

    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      label,
    })
    try {
      fillStatements(body, bodyBlock, exitBlock.block.id, ctx)
      return exitBlock
    } finally {
      ctx.loopStack.pop()
    }
  }

  if (t.isEmptyStatement(stmt)) {
    return bb
  }

  if (t.isDebuggerStatement(stmt)) {
    push({ kind: 'Debugger', loc: stmt.loc })
    return bb
  }

  // Preserve semantics of lexical blocks (e.g. switch case `{ ... }` consequents)
  // by recursively lowering contained statements.
  if (t.isBlockStatement(stmt)) {
    if (ctx) {
      return processLexicalBlockStatement(stmt, bb, ctx)
    }
    let current = bb
    emitHoistedFunctionDeclarations(stmt.body, instr => current.block.instructions.push(instr), {
      blockScoped: true,
    })
    for (let index = 0; index < stmt.body.length; index++) {
      const inner = stmt.body[index]!
      if (t.isFunctionDeclaration(inner)) {
        continue
      }
      current = processStatement(inner, current, jumpTarget, ctx, labelOverride)
      if (current.sealed) {
        const termKind = current.block.terminator.kind
        if (termKind === 'Return' || termKind === 'Throw') {
          appendPostTerminatorDeclarations(current.block, stmt.body.slice(index + 1))
        }
        return current
      }
    }
    return current
  }

  if (t.isExpressionStatement(stmt)) {
    if (!handleExpressionStatement(stmt.expression, push)) {
      push({ kind: 'Expression', value: convertExpression(stmt.expression), loc: stmt.loc })
    }
    return bb
  }

  if (t.isVariableDeclaration(stmt)) {
    const eagerDestructuringNames = collectEagerDestructuringDeclaratorNames(stmt)
    for (const decl of stmt.declarations) {
      const declKind = normalizeVarKind(stmt.kind)
      if (t.isIdentifier(decl.id)) {
        push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: decl.id.name },
          value: decl.init
            ? convertExpression(decl.init)
            : ({ kind: 'Literal', value: undefined } as HLiteral),
          declarationKind: declKind,
          loc: decl.loc ?? stmt.loc,
          preserveEagerEvaluation: eagerDestructuringNames.has(decl.id.name) || undefined,
        })
        continue
      }
      if (t.isObjectPattern(decl.id)) {
        const tempName = `__destruct_${destructuringTempCounter++}`
        push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: tempName },
          value: decl.init
            ? convertExpression(decl.init)
            : ({ kind: 'Literal', value: undefined } as HLiteral),
          declarationKind: declKind,
        })
        const excludeKeys: BabelCore.types.Expression[] = []
        decl.id.properties.forEach(prop => {
          if (t.isObjectProperty(prop)) {
            const keyName = t.isIdentifier(prop.key)
              ? prop.key.name
              : t.isStringLiteral(prop.key)
                ? prop.key.value
                : t.isNumericLiteral(prop.key)
                  ? String(prop.key.value)
                  : null
            if (!keyName) return
            excludeKeys.push(t.stringLiteral(keyName))
            if (t.isIdentifier(prop.value)) {
              const memberExpr = t.memberExpression(
                t.identifier(tempName),
                t.identifier(keyName),
                false,
              )
              push({
                kind: 'Assign',
                target: { kind: 'Identifier', name: prop.value.name },
                value: convertExpression(memberExpr),
                declarationKind: declKind,
              })
            }
          } else if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
            const restExpr = t.callExpression(t.identifier('__fictObjectRest'), [
              t.identifier(tempName),
              t.arrayExpression(excludeKeys),
            ])
            push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: prop.argument.name },
              value: convertExpression(restExpr),
              declarationKind: declKind,
            })
          }
        })
      }
      if (t.isArrayPattern(decl.id)) {
        const tempName = `__destruct_${destructuringTempCounter++}`
        push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: tempName },
          value: decl.init
            ? convertExpression(decl.init)
            : ({ kind: 'Literal', value: undefined } as HLiteral),
          declarationKind: declKind,
        })
        decl.id.elements.forEach((elem, index) => {
          if (!elem) return
          if (t.isIdentifier(elem)) {
            const memberExpr = t.memberExpression(
              t.identifier(tempName),
              t.numericLiteral(index),
              true,
            )
            push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: elem.name },
              value: convertExpression(memberExpr),
              declarationKind: declKind,
            })
          } else if (t.isRestElement(elem) && t.isIdentifier(elem.argument)) {
            const sliceCall = t.callExpression(
              t.memberExpression(t.identifier(tempName), t.identifier('slice')),
              [t.numericLiteral(index)],
            )
            push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: elem.argument.name },
              value: convertExpression(sliceCall),
              declarationKind: declKind,
            })
          }
        })
      }
    }
    return bb
  }

  if (t.isFunctionDeclaration(stmt) && stmt.id) {
    const fnExpr = t.functionExpression(
      stmt.id,
      toFunctionExpressionParams(stmt.params),
      stmt.body,
      stmt.generator,
      stmt.async,
    )
    push({
      kind: 'Assign',
      target: { kind: 'Identifier', name: stmt.id.name },
      value: convertExpression(fnExpr),
      declarationKind: 'function',
    })
    return bb
  }

  if (t.isClassDeclaration(stmt) && stmt.id) {
    const classExpr = t.classExpression(
      stmt.id,
      stmt.superClass as BabelCore.types.Expression | null | undefined,
      stmt.body,
      stmt.decorators ?? null,
    )
    push({
      kind: 'Assign',
      target: { kind: 'Identifier', name: stmt.id.name },
      value: convertExpression(classExpr),
      declarationKind: 'let',
    })
    return bb
  }

  if (t.isReturnStatement(stmt)) {
    bb.block.terminator = {
      kind: 'Return',
      argument: stmt.argument ? convertExpression(stmt.argument) : undefined,
    }
    bb.sealed = true
    return bb
  }

  if (t.isThrowStatement(stmt)) {
    bb.block.terminator = {
      kind: 'Throw',
      argument: convertExpression(stmt.argument as BabelCore.types.Expression),
    }
    bb.sealed = true
    return bb
  }

  // Handle break statement
  if (t.isBreakStatement(stmt) && ctx) {
    const label = stmt.label?.name
    const loopCtx = findBreakContext(ctx, label)
    if (loopCtx) {
      bb.block.terminator = { kind: 'Break', target: loopCtx.breakTarget, label }
      bb.sealed = true
    } else {
      // Break statement outside of loop or labeled statement
      const message = label
        ? `Break statement with label '${label}' is not within a labeled statement`
        : 'Break statement is not within a loop or switch statement'
      throw new HIRError(message, 'BUILD_ERROR', { blockId: bb.block.id })
    }
    return bb
  }

  // Handle continue statement
  if (t.isContinueStatement(stmt) && ctx) {
    const label = stmt.label?.name
    const loopCtx = findContinueContext(ctx, label)
    if (loopCtx) {
      bb.block.terminator = { kind: 'Continue', target: loopCtx.continueTarget!, label }
      bb.sealed = true
    } else {
      // Continue statement outside of loop
      const message = label
        ? `Continue statement with label '${label}' is not within a labeled loop`
        : 'Continue statement is not within a loop'
      throw new HIRError(message, 'BUILD_ERROR', { blockId: bb.block.id })
    }
    return bb
  }

  // Handle nested if statement
  if (t.isIfStatement(stmt) && ctx) {
    const consequentBlock = ctx.createBlock()
    const alternateBlock = ctx.createBlock()
    const joinBlock = ctx.createBlock()

    ctx.blocks.push(consequentBlock.block, alternateBlock.block, joinBlock.block)

    // Branch from current block
    const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
    bb.block.terminator = {
      kind: 'Branch',
      test: testExpr,
      consequent: consequentBlock.block.id,
      alternate: alternateBlock.block.id,
    }
    bb.sealed = true

    // Fill consequent
    fillStatements(stmt.consequent, consequentBlock, joinBlock.block.id, ctx)

    // Fill alternate
    if (stmt.alternate) {
      fillStatements(stmt.alternate, alternateBlock, joinBlock.block.id, ctx)
    } else {
      alternateBlock.block.terminator = { kind: 'Jump', target: joinBlock.block.id }
      alternateBlock.sealed = true
    }

    return joinBlock
  }

  // Handle nested while statement
  if (t.isWhileStatement(stmt) && ctx) {
    const condBlock = ctx.createBlock()
    const bodyBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(condBlock.block, bodyBlock.block, exitBlock.block)
    condBlock.block.sourceLoop = {
      kind: 'while',
      body: bodyBlock.block.id,
      exit: exitBlock.block.id,
    }
    markLabeledStatement(ctx, condBlock.block.id, labelOverride)

    // Jump to condition
    bb.block.terminator = { kind: 'Jump', target: condBlock.block.id }
    bb.sealed = true

    // Condition branch
    const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
    condBlock.block.terminator = {
      kind: 'Branch',
      test: testExpr,
      consequent: bodyBlock.block.id,
      alternate: exitBlock.block.id,
    }
    condBlock.sealed = true

    // Push loop context for break/continue (while has no label here, but could be wrapped by LabeledStatement)
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: condBlock.block.id,
      label: labelOverride,
    })

    // Body loops back to condition
    fillStatements(stmt.body, bodyBlock, condBlock.block.id, ctx)

    // Pop loop context
    ctx.loopStack.pop()

    return exitBlock
  }

  // Handle nested for statement
  if (t.isForStatement(stmt) && ctx) {
    const condBlock = ctx.createBlock()
    const bodyBlock = ctx.createBlock()
    const updateBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(condBlock.block, bodyBlock.block, updateBlock.block, exitBlock.block)
    markLabeledStatement(ctx, condBlock.block.id, labelOverride)
    const initInstructions: Instruction[] = []

    // Init in current block
    if (stmt.init && t.isVariableDeclaration(stmt.init)) {
      const initKind = normalizeVarKind(stmt.init.kind)
      for (const decl of stmt.init.declarations) {
        if (!t.isIdentifier(decl.id)) continue
        const instr: Instruction = {
          kind: 'Assign',
          target: { kind: 'Identifier', name: decl.id.name },
          value: decl.init
            ? convertExpression(decl.init)
            : ({ kind: 'Literal', value: undefined } as HLiteral),
          declarationKind: initKind,
        }
        push(instr)
        initInstructions.push(instr)
      }
    } else if (stmt.init && t.isExpression(stmt.init)) {
      push({
        kind: 'Expression',
        value: convertExpression(stmt.init),
      })
    }
    condBlock.block.sourceLoop = {
      kind: 'for',
      body: bodyBlock.block.id,
      update: updateBlock.block.id,
      exit: exitBlock.block.id,
      ...(initInstructions.length > 0 ? { init: initInstructions } : null),
    }

    // Jump to condition
    bb.block.terminator = { kind: 'Jump', target: condBlock.block.id }
    bb.sealed = true

    // Condition
    const testExpr = stmt.test
      ? convertExpression(stmt.test as BabelCore.types.Expression)
      : undefined
    if (testExpr) {
      condBlock.block.terminator = {
        kind: 'Branch',
        test: testExpr,
        consequent: bodyBlock.block.id,
        alternate: exitBlock.block.id,
      }
    } else {
      condBlock.block.terminator = { kind: 'Jump', target: bodyBlock.block.id }
    }
    condBlock.sealed = true

    // Push loop context for break/continue
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: updateBlock.block.id, // continue goes to update in for loop
      label: labelOverride,
    })

    // Body goes to update
    fillStatements(stmt.body, bodyBlock, updateBlock.block.id, ctx)

    // Pop loop context
    ctx.loopStack.pop()

    // Update loops back to condition
    if (stmt.update && t.isExpression(stmt.update)) {
      updateBlock.block.instructions.push({
        kind: 'Expression',
        value: convertExpression(stmt.update),
      })
    }
    updateBlock.block.terminator = { kind: 'Jump', target: condBlock.block.id }
    updateBlock.sealed = true

    return exitBlock
  }

  // Handle do-while statement
  if (t.isDoWhileStatement(stmt) && ctx) {
    const bodyBlock = ctx.createBlock()
    const condBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(bodyBlock.block, condBlock.block, exitBlock.block)
    bodyBlock.block.sourceLoop = {
      kind: 'doWhile',
      condition: condBlock.block.id,
      exit: exitBlock.block.id,
    }
    markLabeledStatement(ctx, condBlock.block.id, labelOverride)

    // Jump directly to body (do-while executes body first)
    bb.block.terminator = { kind: 'Jump', target: bodyBlock.block.id }
    bb.sealed = true

    // Push loop context for break/continue BEFORE processing body
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: condBlock.block.id,
      label: labelOverride,
    })

    // Body goes to condition
    fillStatements(stmt.body, bodyBlock, condBlock.block.id, ctx)

    // Pop loop context AFTER processing body
    ctx.loopStack.pop()

    // Condition branches back to body or exits
    const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
    condBlock.block.terminator = {
      kind: 'Branch',
      test: testExpr,
      consequent: bodyBlock.block.id,
      alternate: exitBlock.block.id,
    }
    condBlock.sealed = true

    return exitBlock
  }

  // Handle for-in statement
  if (t.isForInStatement(stmt) && ctx) {
    const bodyBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(bodyBlock.block, exitBlock.block)
    markLabeledStatement(ctx, bb.block.id, labelOverride)

    // Get the iteration variable info (name, kind, pattern)
    const left = stmt.left
    let varName = '_item'
    let varKind: 'const' | 'let' | 'var' = 'const'
    let pattern: BabelCore.types.LVal | undefined
    let leftKind: 'declaration' | 'assignment' = 'declaration'
    let assignmentTarget: Expression | undefined

    if (t.isVariableDeclaration(left) && left.declarations[0]) {
      varKind = left.kind as 'const' | 'let' | 'var'
      const decl = left.declarations[0]
      if (t.isIdentifier(decl.id)) {
        varName = decl.id.name
      } else if (t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)) {
        varName = `__forIn_${bodyBlock.block.id}`
        pattern = decl.id
      }
    } else if (t.isIdentifier(left)) {
      varName = left.name
      varKind = 'let'
      leftKind = 'assignment'
    } else if (t.isMemberExpression(left)) {
      assignmentTarget = convertExpression(left)
      leftKind = 'assignment'
    }

    // Create ForIn terminator
    const objectExpr = convertExpression(stmt.right as BabelCore.types.Expression)

    bb.block.terminator = {
      kind: 'ForIn',
      variable: varName,
      leftKind,
      variableKind: varKind,
      pattern,
      ...(assignmentTarget ? { assignmentTarget } : null),
      object: objectExpr,
      body: bodyBlock.block.id,
      exit: exitBlock.block.id,
    }
    bb.sealed = true

    // Push loop context
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: bodyBlock.block.id,
      label: labelOverride,
    })

    // Process body
    fillStatements(stmt.body, bodyBlock, exitBlock.block.id, ctx)

    // Pop loop context
    ctx.loopStack.pop()

    return exitBlock
  }

  // Handle for-of statement
  if (t.isForOfStatement(stmt) && ctx) {
    const bodyBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(bodyBlock.block, exitBlock.block)
    markLabeledStatement(ctx, bb.block.id, labelOverride)

    // Get the iteration variable info (name, kind, pattern)
    const left = stmt.left
    let varName = '_item'
    let varKind: 'const' | 'let' | 'var' = 'const'
    let pattern: BabelCore.types.LVal | undefined
    let leftKind: 'declaration' | 'assignment' = 'declaration'
    let assignmentTarget: Expression | undefined

    if (t.isVariableDeclaration(left) && left.declarations[0]) {
      varKind = left.kind as 'const' | 'let' | 'var'
      const decl = left.declarations[0]
      if (t.isIdentifier(decl.id)) {
        varName = decl.id.name
      } else if (t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)) {
        varName = `__forOf_${bodyBlock.block.id}`
        pattern = decl.id
      }
    } else if (t.isIdentifier(left)) {
      varName = left.name
      varKind = 'let'
      leftKind = 'assignment'
    } else if (t.isMemberExpression(left)) {
      assignmentTarget = convertExpression(left)
      leftKind = 'assignment'
    }

    // Create ForOf terminator
    const iterableExpr = convertExpression(stmt.right as BabelCore.types.Expression)

    bb.block.terminator = {
      kind: 'ForOf',
      variable: varName,
      leftKind,
      variableKind: varKind,
      pattern,
      ...(assignmentTarget ? { assignmentTarget } : null),
      ...(stmt.await ? { await: true } : null),
      iterable: iterableExpr,
      body: bodyBlock.block.id,
      exit: exitBlock.block.id,
    }
    bb.sealed = true

    // Push loop context
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: bodyBlock.block.id,
      label: labelOverride,
    })

    // Process body
    fillStatements(stmt.body, bodyBlock, exitBlock.block.id, ctx)

    // Pop loop context
    ctx.loopStack.pop()

    return exitBlock
  }

  // Handle switch statement
  if (t.isSwitchStatement(stmt) && ctx) {
    const exitBlock = ctx.createBlock()
    ctx.blocks.push(exitBlock.block)
    markLabeledStatement(ctx, bb.block.id, labelOverride)

    const caseBlocks = stmt.cases.map(() => ctx.createBlock())
    for (const caseBlock of caseBlocks) {
      ctx.blocks.push(caseBlock.block)
    }

    const cases: { test?: Expression; target: number; syntheticDefault?: boolean }[] = []
    let hasDefault = false

    for (let index = 0; index < stmt.cases.length; index++) {
      const switchCase = stmt.cases[index]!
      const caseBlock = caseBlocks[index]!
      if (switchCase.test) {
        cases.push({
          test: convertExpression(switchCase.test as BabelCore.types.Expression),
          target: caseBlock.block.id,
        })
      } else {
        hasDefault = true
        cases.push({
          target: caseBlock.block.id,
        })
      }
    }

    // Allow `break` inside switch cases (including nested block statements)
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      label: labelOverride,
    })

    for (let index = 0; index < stmt.cases.length; index++) {
      const switchCase = stmt.cases[index]!
      const caseBlock = caseBlocks[index]!
      const nextCaseBlock = caseBlocks[index + 1]
      const fallthroughTarget = nextCaseBlock ? nextCaseBlock.block.id : exitBlock.block.id
      // Process case statements
      let current = caseBlock
      for (const s of switchCase.consequent) {
        if (current.sealed) break
        current = processStatement(s, current, exitBlock.block.id, ctx)
      }

      // Fall through to next case if not sealed
      if (!current.sealed) {
        current.block.terminator = { kind: 'Jump', target: fallthroughTarget }
        current.sealed = true
      }
    }

    ctx.loopStack.pop()

    // Add default case if not present
    if (!hasDefault) {
      cases.push({ target: exitBlock.block.id, syntheticDefault: true })
    }

    bb.block.terminator = {
      kind: 'Switch',
      discriminant: convertExpression(stmt.discriminant as BabelCore.types.Expression),
      cases,
    }
    bb.sealed = true

    return exitBlock
  }

  // Handle try-catch-finally
  if (t.isTryStatement(stmt) && ctx) {
    const tryBlock = ctx.createBlock()
    const catchBlock = stmt.handler ? ctx.createBlock() : null
    const finallyBlock = stmt.finalizer ? ctx.createBlock() : null
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(tryBlock.block, exitBlock.block)
    if (catchBlock) ctx.blocks.push(catchBlock.block)
    if (finallyBlock) ctx.blocks.push(finallyBlock.block)

    // Get catch param name
    const catchParamInfo = getCatchParamInfo(stmt.handler)

    // Create Try terminator
    bb.block.terminator = {
      kind: 'Try',
      tryBlock: tryBlock.block.id,
      catchBlock: catchBlock?.block.id,
      catchParam: catchParamInfo.catchParam,
      catchPattern: catchParamInfo.catchPattern,
      finallyBlock: finallyBlock?.block.id,
      exit: exitBlock.block.id,
    }
    bb.sealed = true

    // Process try block
    fillStatements(stmt.block, tryBlock, finallyBlock?.block.id ?? exitBlock.block.id, ctx)

    // Process catch block
    if (catchBlock && stmt.handler) {
      fillStatements(
        stmt.handler.body,
        catchBlock,
        finallyBlock?.block.id ?? exitBlock.block.id,
        ctx,
      )
    }

    // Process finally block
    if (finallyBlock && stmt.finalizer) {
      fillStatements(stmt.finalizer, finallyBlock, exitBlock.block.id, ctx)
    }

    return exitBlock
  }

  throw new HIRError(`Unsupported statement in HIR lowering: ${stmt.type}`, 'BUILD_ERROR', {
    blockId: bb.block.id,
  })
}

export function convertExpression(
  node: BabelCore.types.Expression | BabelCore.types.JSXFragment,
  options?: { reactiveScope?: string },
): Expression {
  const loc = getLoc(node)
  const unwrapTransparentExpression = (
    expr: BabelCore.types.Expression,
  ): BabelCore.types.Expression => {
    let current = expr
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
  const convertCallArguments = (
    args: (
      | BabelCore.types.Expression
      | BabelCore.types.SpreadElement
      | BabelCore.types.ArgumentPlaceholder
    )[],
    reactiveScope?: string,
  ): Expression[] => {
    const converted: Expression[] = []
    for (const arg of args) {
      if (t.isSpreadElement(arg)) {
        converted.push({
          kind: 'SpreadElement',
          argument: convertExpression(arg.argument as BabelCore.types.Expression),
          loc: getLoc(arg),
        } as HSpreadElement)
        continue
      }
      if (t.isExpression(arg)) {
        const unwrappedArg =
          reactiveScope && arg === args[0] ? unwrapTransparentExpression(arg) : arg
        if (
          reactiveScope &&
          arg === args[0] &&
          (t.isArrowFunctionExpression(unwrappedArg) || t.isFunctionExpression(unwrappedArg))
        ) {
          converted.push(convertExpression(unwrappedArg, { reactiveScope }))
          continue
        }
        converted.push(convertExpression(arg))
        continue
      }
      if (t.isArgumentPlaceholder?.(arg)) {
        return reportUnsupportedExpression(
          arg,
          'Argument placeholders are not supported in HIR conversion.',
        )
      }
      return reportUnsupportedExpression(arg, 'Unsupported call argument in HIR conversion.')
    }
    return converted
  }

  const resolveReactiveScope = (
    callee: BabelCore.types.Expression | BabelCore.types.V8IntrinsicIdentifier,
  ): string | undefined => {
    const reactiveScopes = activeBuildOptions?.reactiveScopes
    if (!reactiveScopes || reactiveScopes.size === 0) return undefined
    if (t.isIdentifier(callee)) {
      return reactiveScopes.has(callee.name) ? callee.name : undefined
    }
    if (
      (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
      !callee.computed &&
      t.isIdentifier(callee.property)
    ) {
      return reactiveScopes.has(callee.property.name) ? callee.property.name : undefined
    }
    return undefined
  }

  const chainCandidate = node as unknown as { type?: string; expression?: BabelCore.types.Node }
  if (
    chainCandidate.type === 'ChainExpression' &&
    chainCandidate.expression !== undefined &&
    t.isExpression(chainCandidate.expression)
  ) {
    return convertExpression(chainCandidate.expression, options)
  }

  if (t.isParenthesizedExpression(node) && t.isExpression(node.expression)) {
    return convertExpression(node.expression, options)
  }
  if (
    (t.isTSAsExpression(node) ||
      t.isTSTypeAssertion(node) ||
      t.isTSNonNullExpression(node) ||
      t.isTSSatisfiesExpression(node) ||
      t.isTSInstantiationExpression(node) ||
      t.isTypeCastExpression(node)) &&
    t.isExpression(node.expression)
  ) {
    return convertExpression(node.expression, options)
  }

  if (t.isImportExpression(node)) {
    return {
      kind: 'ImportExpression',
      source: convertExpression(node.source as BabelCore.types.Expression),
      ...(node.options ? { options: convertExpression(node.options) } : null),
      loc,
    }
  }

  if (t.isMetaProperty(node)) {
    return {
      kind: 'MetaProperty',
      meta: { kind: 'Identifier', name: node.meta.name, loc: getLoc(node.meta) } as HIdentifier,
      property: {
        kind: 'Identifier',
        name: node.property.name,
        loc: getLoc(node.property),
      } as HIdentifier,
      loc,
    }
  }

  if (t.isIdentifier(node)) return { kind: 'Identifier', name: node.name, loc }
  if (t.isBigIntLiteral(node)) {
    return { kind: 'Literal', value: BigInt(node.value), loc } as HLiteral
  }
  if (t.isNullLiteral(node)) return { kind: 'Literal', value: null, loc } as HLiteral
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) {
    return { kind: 'Literal', value: node.value, loc } as HLiteral
  }
  if (t.isRegExpLiteral(node)) {
    return {
      kind: 'Literal',
      value: new RegExp(node.pattern, node.flags ?? ''),
      loc,
    } as HLiteral
  }
  if (t.isCallExpression(node) && t.isImport(node.callee)) {
    const firstArg = node.arguments[0]
    const secondArg = node.arguments[1]
    const source = t.isExpression(firstArg)
      ? convertExpression(firstArg)
      : ({ kind: 'Literal', value: undefined, loc } as HLiteral)
    const options = t.isExpression(secondArg) ? convertExpression(secondArg) : undefined
    return { kind: 'ImportExpression', source, ...(options ? { options } : null), loc }
  }
  if (t.isCallExpression(node)) {
    const callee = normalizeMacroCallee(node, node.callee as BabelCore.types.Expression)
    const macroKind = getCallMacroKind(node)
    const pure = hasPureAnnotation(node) || hasPureAnnotation(node.callee)
    const reactiveScope = resolveReactiveScope(node.callee as BabelCore.types.Expression)
    const call: HCallExpression = {
      kind: 'CallExpression',
      callee: convertExpression(callee),
      arguments: convertCallArguments(node.arguments, reactiveScope),
      ...(macroKind ? { macro: macroKind } : null),
      ...(pure ? { pure: true } : null),
      loc,
    }
    return call
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (t.isPrivateName(node.property)) {
      return reportUnsupportedExpression(
        node.property,
        'Private field access is not supported in HIR conversion.',
      )
    }
    const propertyNode = node.property as BabelCore.types.Node
    const isOptional = t.isOptionalMemberExpression(node)
    const object = convertExpression(node.object as BabelCore.types.Expression)
    const property = t.isExpression(propertyNode)
      ? convertExpression(propertyNode)
      : ({ kind: 'Literal', value: undefined } as HLiteral)

    if (isOptional) {
      // Use OptionalMemberExpression for proper dependency tracking
      const optionalMember: Expression = {
        kind: 'OptionalMemberExpression',
        object,
        property,
        computed: node.computed,
        optional: node.optional ?? true,
        loc,
      }
      return optionalMember
    }

    const member: HMemberExpression = {
      kind: 'MemberExpression',
      object,
      property,
      computed: node.computed,
      optional: false,
      loc,
    }
    return member
  }
  if (t.isBinaryExpression(node)) {
    const bin: HBinaryExpression = {
      kind: 'BinaryExpression',
      operator: node.operator,
      left: convertExpression(node.left as BabelCore.types.Expression),
      right: convertExpression(node.right as BabelCore.types.Expression),
      loc,
    }
    return bin
  }
  if (t.isUnaryExpression(node)) {
    const un: HUnaryExpression = {
      kind: 'UnaryExpression',
      operator: node.operator,
      argument: convertExpression(node.argument as BabelCore.types.Expression),
      prefix: node.prefix,
      loc,
    }
    return un
  }
  if (t.isLogicalExpression(node)) {
    const log: HLogicalExpression = {
      kind: 'LogicalExpression',
      operator: node.operator as HLogicalExpression['operator'],
      left: convertExpression(node.left as BabelCore.types.Expression),
      right: convertExpression(node.right as BabelCore.types.Expression),
      loc,
    }
    return log
  }
  if (t.isConditionalExpression(node)) {
    const cond: HConditionalExpression = {
      kind: 'ConditionalExpression',
      test: convertExpression(node.test as BabelCore.types.Expression),
      consequent: convertExpression(node.consequent as BabelCore.types.Expression),
      alternate: convertExpression(node.alternate as BabelCore.types.Expression),
      loc,
    }
    return cond
  }
  if (t.isArrayExpression(node)) {
    const elements: HArrayExpression['elements'] = []
    for (const el of node.elements ?? []) {
      if (!el) {
        elements.push(null)
        continue
      }
      if (t.isSpreadElement(el)) {
        elements.push({
          kind: 'SpreadElement',
          argument: convertExpression(el.argument as BabelCore.types.Expression),
          loc: getLoc(el),
        } as HSpreadElement)
        continue
      }
      if (t.isExpression(el)) {
        elements.push(convertExpression(el))
        continue
      }
      return reportUnsupportedExpression(el, 'Unsupported array literal element in HIR conversion.')
    }
    const arr: HArrayExpression = {
      kind: 'ArrayExpression',
      elements,
      loc,
    }
    return arr
  }
  if (t.isObjectExpression(node)) {
    const properties: HObjectExpression['properties'] = []
    const obj: HObjectExpression = {
      kind: 'ObjectExpression',
      properties,
      loc,
    }
    for (const prop of node.properties) {
      if (t.isSpreadElement(prop)) {
        properties.push({
          kind: 'SpreadElement',
          argument: convertExpression(prop.argument as BabelCore.types.Expression),
          loc: getLoc(prop),
        } as HSpreadElement)
        continue
      }
      if (t.isObjectMethod(prop)) {
        const keyExpr = prop.computed
          ? t.isExpression(prop.key)
            ? convertExpression(prop.key)
            : undefined
          : t.isIdentifier(prop.key)
            ? ({ kind: 'Identifier', name: prop.key.name } as HIdentifier)
            : t.isStringLiteral(prop.key)
              ? ({ kind: 'Literal', value: prop.key.value } as HLiteral)
              : t.isNumericLiteral(prop.key)
                ? ({ kind: 'Literal', value: prop.key.value } as HLiteral)
                : t.isBigIntLiteral(prop.key)
                  ? ({ kind: 'Literal', value: BigInt(prop.key.value) } as HLiteral)
                  : undefined
        if (!keyExpr) {
          return reportUnsupportedExpression(
            prop.key,
            'Unsupported object literal key in HIR conversion.',
          )
        }
        const fnExpr = t.functionExpression(
          null,
          prop.params,
          prop.body,
          prop.generator,
          prop.async,
        )
        properties.push({
          kind: 'Property',
          key: keyExpr,
          value: convertExpression(fnExpr),
          computed: prop.computed,
          propertyKind: prop.kind ?? 'method',
          loc: getLoc(prop),
        })
        continue
      }
      if (t.isObjectProperty(prop)) {
        const keyExpr = prop.computed
          ? t.isExpression(prop.key)
            ? convertExpression(prop.key)
            : undefined
          : t.isIdentifier(prop.key)
            ? ({ kind: 'Identifier', name: prop.key.name } as HIdentifier)
            : t.isStringLiteral(prop.key)
              ? ({ kind: 'Literal', value: prop.key.value } as HLiteral)
              : t.isNumericLiteral(prop.key)
                ? ({ kind: 'Literal', value: prop.key.value } as HLiteral)
                : t.isBigIntLiteral(prop.key)
                  ? ({ kind: 'Literal', value: BigInt(prop.key.value) } as HLiteral)
                  : undefined
        if (!keyExpr) {
          return reportUnsupportedExpression(
            prop.key,
            'Unsupported object literal key in HIR conversion.',
          )
        }
        if (!t.isExpression(prop.value)) {
          return reportUnsupportedExpression(
            prop.value as unknown as BabelCore.types.Node,
            'Unsupported object literal value in HIR conversion.',
          )
        }
        properties.push({
          kind: 'Property',
          key: keyExpr,
          value: convertExpression(prop.value),
          computed: prop.computed,
          shorthand: prop.shorthand && t.isIdentifier(prop.value),
          loc: getLoc(prop),
        })
        continue
      }
      return reportUnsupportedExpression(
        prop,
        'Unsupported object literal property in HIR conversion.',
      )
    }
    return obj
  }

  // JSX Element
  if (t.isJSXElement(node)) {
    return convertJSXElement(node)
  }

  // JSX Fragment - return as Fragment VNode with children
  if (t.isJSXFragment(node)) {
    const children: HJSXChild[] = []
    for (const child of node.children) {
      appendJSXChild(children, child)
    }
    // Return as JSXElement with Fragment type
    return {
      kind: 'JSXElement',
      tagName: { kind: 'Identifier', name: 'Fragment', loc: getLoc(node) } as HIdentifier,
      isComponent: true,
      isFragmentSyntax: true,
      hasAuthoredChildren: node.children.some(hasAuthoredJSXChild),
      attributes: [],
      children,
      loc: getLoc(node),
    } as HJSXElementExpression
  }

  // Arrow Function Expression
  if (t.isArrowFunctionExpression(node)) {
    if (t.isBlockStatement(node.body)) {
      const nested = convertFunction(undefined, node.params, node.body.body, {
        noMemo: hasNoMemoDirectiveInStatements(node.body.body),
        pure: hasPureDirectiveInStatements(node.body.body),
        directives: node.body.directives,
        loc: getLoc(node),
        astNode: node,
      })
      const arrow: HArrowFunctionExpression = {
        kind: 'ArrowFunction',
        params: nested.params,
        rawParams: nested.rawParams ?? node.params,
        body: nested.blocks,
        isExpression: false,
        isAsync: node.async,
        noMemo: nested.meta?.noMemo,
        pure: nested.meta?.pure,
        reactiveScope: options?.reactiveScope,
        loc,
      }
      return arrow
    } else {
      const arrow: HArrowFunctionExpression = {
        kind: 'ArrowFunction',
        params: node.params
          .map(p =>
            t.isPattern(p)
              ? extractIdentifiersFromPattern(p)
              : t.isIdentifier(p)
                ? [{ kind: 'Identifier' as const, name: p.name }]
                : [],
          )
          .flat(),
        rawParams: node.params,
        body: convertExpression(node.body as BabelCore.types.Expression),
        isExpression: true,
        isAsync: node.async,
        reactiveScope: options?.reactiveScope,
        loc,
      }
      return arrow
    }
  }

  // Function Expression
  if (t.isFunctionExpression(node)) {
    const nested = convertFunction(undefined, node.params, node.body.body, {
      noMemo: hasNoMemoDirectiveInStatements(node.body.body),
      pure: hasPureDirectiveInStatements(node.body.body),
      directives: node.body.directives,
      loc: getLoc(node),
      astNode: node,
    })
    const fn: HFunctionExpression = {
      kind: 'FunctionExpression',
      name: node.id?.name ?? '',
      params: nested.params,
      rawParams: nested.rawParams ?? node.params,
      body: nested.blocks,
      isAsync: node.async,
      isGenerator: node.generator,
      noMemo: nested.meta?.noMemo,
      pure: nested.meta?.pure,
      reactiveScope: options?.reactiveScope,
      loc,
    }
    return fn
  }

  // Assignment Expression
  if (t.isAssignmentExpression(node)) {
    if (!t.isExpression(node.left)) {
      const isDestructuring = t.isArrayPattern(node.left) || t.isObjectPattern(node.left)
      const message = isDestructuring
        ? 'Destructuring assignment should have been expanded before HIR conversion.'
        : `Unsupported assignment target '${node.left.type}' in HIR conversion`
      return reportUnsupportedExpression(node.left, message)
    }
    const assign: HAssignmentExpression = {
      kind: 'AssignmentExpression',
      operator: node.operator,
      left: convertExpression(node.left as BabelCore.types.Expression),
      right: convertExpression(node.right as BabelCore.types.Expression),
      loc,
    }
    return assign
  }

  // Update Expression
  if (t.isUpdateExpression(node)) {
    const update: HUpdateExpression = {
      kind: 'UpdateExpression',
      operator: node.operator as '++' | '--',
      argument: convertExpression(node.argument as BabelCore.types.Expression),
      prefix: node.prefix,
      loc,
    }
    return update
  }

  // Template Literal
  if (t.isTemplateLiteral(node)) {
    const template: HTemplateLiteral = {
      kind: 'TemplateLiteral',
      quasis: node.quasis.map(q => ({ raw: q.value.raw, cooked: q.value.cooked ?? null })),
      expressions: node.expressions.map(e => convertExpression(e as BabelCore.types.Expression)),
      loc,
    }
    return template
  }

  // Await Expression
  if (t.isAwaitExpression(node)) {
    return {
      kind: 'AwaitExpression',
      argument: convertExpression(node.argument as BabelCore.types.Expression),
      loc,
    }
  }

  // New Expression
  if (t.isNewExpression(node)) {
    return {
      kind: 'NewExpression',
      callee: convertExpression(node.callee as BabelCore.types.Expression),
      arguments: convertCallArguments(node.arguments),
      loc,
    }
  }

  // Sequence Expression
  if (t.isSequenceExpression(node)) {
    return {
      kind: 'SequenceExpression',
      expressions: node.expressions.map(e => convertExpression(e)),
      loc,
    }
  }

  // Yield Expression
  if (t.isYieldExpression(node)) {
    return {
      kind: 'YieldExpression',
      argument: node.argument ? convertExpression(node.argument) : null,
      delegate: node.delegate,
      loc,
    }
  }

  // Optional Call Expression
  if (t.isOptionalCallExpression(node)) {
    const callee = normalizeMacroCallee(node, node.callee as BabelCore.types.Expression)
    const macroKind = getCallMacroKind(node)
    const reactiveScope = resolveReactiveScope(node.callee as BabelCore.types.Expression)
    return {
      kind: 'OptionalCallExpression',
      callee: convertExpression(callee),
      arguments: convertCallArguments(node.arguments, reactiveScope),
      optional: node.optional,
      ...(macroKind ? { macro: macroKind } : null),
      ...(hasPureAnnotation(node) || hasPureAnnotation(node.callee) ? { pure: true } : null),
      loc,
    }
  }

  // Tagged Template Expression
  if (t.isTaggedTemplateExpression(node)) {
    return {
      kind: 'TaggedTemplateExpression',
      tag: convertExpression(node.tag),
      quasi: {
        kind: 'TemplateLiteral',
        quasis: node.quasi.quasis.map(q => ({
          raw: q.value.raw,
          cooked: q.value.cooked ?? null,
        })),
        expressions: node.quasi.expressions.map(e =>
          convertExpression(e as BabelCore.types.Expression),
        ),
        loc: getLoc(node.quasi),
      },
      loc,
    }
  }

  // Class Expression
  if (t.isClassExpression(node)) {
    return {
      kind: 'ClassExpression',
      name: node.id?.name,
      superClass: node.superClass ? convertExpression(node.superClass) : undefined,
      decorators: node.decorators?.map(decorator => t.cloneNode(decorator, true)),
      body: node.body.body, // Store as Babel AST for now
      loc,
    }
  }

  // This Expression
  if (t.isThisExpression(node)) {
    return { kind: 'ThisExpression', loc }
  }

  // Super Expression
  if (t.isSuper(node)) {
    return { kind: 'SuperExpression', loc }
  }

  return reportUnsupportedExpression(node)
}

function convertJSXElement(node: BabelCore.types.JSXElement): HJSXElementExpression {
  const opening = node.openingElement
  let tagName: string | Expression
  let isComponent = false

  if (t.isJSXIdentifier(opening.name)) {
    const name = opening.name.name
    const firstChar = name[0]
    if (firstChar && firstChar === firstChar.toUpperCase()) {
      // Component
      tagName = { kind: 'Identifier', name, loc: getLoc(opening.name) } as HIdentifier
      isComponent = true
    } else {
      // Intrinsic element
      tagName = name
    }
  } else if (t.isJSXMemberExpression(opening.name)) {
    // Component.SubComponent
    tagName = convertJSXMemberExpr(opening.name)
    isComponent = true
  } else if (t.isJSXNamespacedName(opening.name)) {
    tagName = `${opening.name.namespace.name}:${opening.name.name.name}`
  } else {
    const unsupportedName = opening.name as BabelCore.types.Node
    return reportUnsupportedExpression(
      unsupportedName,
      `Unsupported JSX tag syntax '${unsupportedName.type}' in HIR conversion`,
    )
  }

  const attributes: HJSXAttribute[] = []
  for (const attr of opening.attributes) {
    if (t.isJSXSpreadAttribute(attr)) {
      attributes.push({
        name: '',
        value: null,
        isSpread: true,
        spreadExpr: convertExpression(attr.argument as BabelCore.types.Expression),
        loc: getLoc(attr),
      })
    } else if (t.isJSXAttribute(attr)) {
      const nameNode = attr.name as BabelCore.types.Node
      let attrName: string
      if (t.isJSXIdentifier(attr.name)) {
        attrName = attr.name.name
      } else if (t.isJSXNamespacedName(attr.name)) {
        attrName = `${attr.name.namespace.name}:${attr.name.name.name}`
      } else {
        return reportUnsupportedExpression(
          nameNode,
          'Unsupported JSX attribute name in HIR conversion',
        )
      }
      let value: Expression | null = null
      if (attr.value) {
        if (t.isStringLiteral(attr.value)) {
          value = { kind: 'Literal', value: attr.value.value, loc: getLoc(attr.value) } as HLiteral
        } else if (
          t.isJSXExpressionContainer(attr.value) &&
          !t.isJSXEmptyExpression(attr.value.expression)
        ) {
          value = convertExpression(attr.value.expression as BabelCore.types.Expression)
        } else if (t.isJSXElement(attr.value)) {
          value = convertJSXElement(attr.value)
        } else if (t.isJSXFragment(attr.value)) {
          value = convertExpression(attr.value as unknown as BabelCore.types.Expression)
        }
      }
      attributes.push({
        name: attrName,
        value,
        loc: getLoc(attr),
      })
    }
  }

  const children: HJSXChild[] = []
  const childOptions = { preserveWhitespaceText: isWhitespaceSensitiveJSXTag(tagName) }
  for (const child of node.children) {
    appendJSXChild(children, child, childOptions)
  }

  return {
    kind: 'JSXElement',
    tagName,
    isComponent,
    hasAuthoredChildren: node.children.some(hasAuthoredJSXChild),
    attributes,
    children,
    loc: getLoc(node),
  }
}

function convertJSXMemberExpr(node: BabelCore.types.JSXMemberExpression): Expression {
  let object: Expression
  if (t.isJSXIdentifier(node.object)) {
    object = { kind: 'Identifier', name: node.object.name, loc: getLoc(node.object) } as HIdentifier
  } else {
    object = convertJSXMemberExpr(node.object)
  }
  return {
    kind: 'MemberExpression',
    object,
    property: {
      kind: 'Identifier',
      name: node.property.name,
      loc: getLoc(node.property),
    } as HIdentifier,
    computed: false,
    loc: getLoc(node),
  }
}
