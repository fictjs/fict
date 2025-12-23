import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES, RUNTIME_HELPERS, RUNTIME_MODULE } from '../constants'

import type {
  BasicBlock,
  Expression,
  HIRFunction,
  HIRProgram,
  Instruction,
  JSXAttribute,
  JSXChild,
  JSXElementExpression,
} from './hir'
import type { ReactiveScope, ReactiveScopeResult } from './scopes'
import { deSSAVarName, type Region } from './regions'

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

  // Mark region declarations as tracked for reactive detection
  if (region) {
    region.declarations.forEach(decl => ctx.trackedVars.add(decl))
    region.dependencies.forEach(dep => ctx.trackedVars.add(dep))
  }

  return prevRegion
}

/**
 * Codegen context for tracking state during code generation
 */
export interface CodegenContext {
  t: typeof BabelCore.types
  /** Tracks which runtime helpers are used */
  helpersUsed: Set<string>
  /** Counter for generating unique identifiers */
  tempCounter: number
  /** Set of tracked/reactive variable names (de-versioned) */
  trackedVars: Set<string>
  /** Reactive scope analysis results */
  scopes?: ReactiveScopeResult | undefined
  /** Whether a context object (__fictCtx) is needed */
  needsCtx?: boolean
  /** Whether local for-of helper is needed */
  needsForOfHelper?: boolean
  /** Whether local for-in helper is needed */
  needsForInHelper?: boolean
  /** Current region info for fine-grained DOM optimization */
  currentRegion?: RegionInfo
  /** All regions for the current function */
  regions?: RegionInfo[]
}

/**
 * Creates a fresh codegen context
 */
export function createCodegenContext(t: typeof BabelCore.types): CodegenContext {
  return {
    t,
    helpersUsed: new Set(),
    tempCounter: 0,
    trackedVars: new Set(),
    needsForOfHelper: false,
    needsForInHelper: false,
  }
}

/**
 * Generate a unique temporary identifier
 */
function genTemp(ctx: CodegenContext, prefix = 'tmp'): BabelCore.types.Identifier {
  return ctx.t.identifier(`__${prefix}_${ctx.tempCounter++}`)
}

/**
 * Normalized attribute information for HIR codegen
 */
interface NormalizedAttribute {
  name: string
  kind: 'attr' | 'class' | 'style' | 'event' | 'ref' | 'property' | 'skip'
  eventName?: string
  capture?: boolean
  passive?: boolean
  once?: boolean
}

/**
 * Normalize an attribute name for HIR codegen
 * Mirrors the logic from fine-grained-dom.ts normalizeAttributeName
 */
function normalizeAttribute(name: string): NormalizedAttribute {
  // Event handlers: onClick, onSubmit, etc.
  if (name.length > 2 && name.startsWith('on') && name[2]?.toUpperCase() === name[2]) {
    let eventName = name.slice(2)
    let capture = false
    let passive = false
    let once = false

    // Support suffix modifiers (Capture/Passive/Once)
    let changed = true
    while (changed) {
      changed = false
      if (eventName.endsWith('Capture')) {
        eventName = eventName.slice(0, -7)
        capture = true
        changed = true
      }
      if (eventName.endsWith('Passive')) {
        eventName = eventName.slice(0, -7)
        passive = true
        changed = true
      }
      if (eventName.endsWith('Once')) {
        eventName = eventName.slice(0, -4)
        once = true
        changed = true
      }
    }

    return {
      name,
      kind: 'event',
      eventName: eventName.toLowerCase(),
      capture,
      passive,
      once,
    }
  }

  switch (name) {
    case 'key':
      return { name, kind: 'skip' }
    case 'ref':
      return { name, kind: 'ref' }
    case 'value':
    case 'checked':
    case 'selected':
    case 'disabled':
    case 'readOnly':
    case 'multiple':
    case 'muted':
      return { name, kind: 'property' }
    case 'class':
    case 'className':
      return { name: 'class', kind: 'class' }
    case 'style':
      return { name: 'style', kind: 'style' }
    case 'htmlFor':
      return { name: 'for', kind: 'attr' }
    default:
      return { name, kind: 'attr' }
  }
}

/**
 * Extract key attribute value from JSX attributes
 */
function extractKeyFromAttributes(attributes: JSXAttribute[]): Expression | undefined {
  for (const attr of attributes) {
    if (attr.name === 'key' && attr.value) {
      return attr.value
    }
  }
  return undefined
}

/**
 * Minimal lowering from HIR back to Babel AST.
 * - Emits a single function declaration per HIR function.
 * - Linearizes blocks in order and reconstructs statements best-effort.
 * - Unsupported instructions become empty statements.
 * - Placeholder for region→fine-grained DOM mapping (not implemented yet).
 *
 * This is for experimental mode only; legacy pipeline remains the source of truth.
 */
export function lowerHIRToBabel(
  program: HIRProgram,
  t: typeof BabelCore.types,
): BabelCore.types.File {
  const ctx = createCodegenContext(t)
  const body: BabelCore.types.Statement[] = []
  for (const fn of program.functions) {
    const funcStmt = lowerFunction(fn, ctx)
    if (funcStmt) body.push(funcStmt)
  }
  return t.file(t.program(attachHelperImports(ctx, body, t)))
}

function lowerFunction(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  ctx.needsCtx = false
  const params = fn.params.map(p => t.identifier(p.name))
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
          t.identifier('__fictCtx'),
          t.callExpression(t.identifier(RUNTIME_ALIASES.useContext), []),
        ),
      ]),
    )
  }

  return t.functionDeclaration(t.identifier(fn.name ?? 'fn'), params, t.blockStatement(statements))
}

function lowerInstruction(
  instr: Instruction,
  ctx: CodegenContext,
): BabelCore.types.Statement | null {
  const { t } = ctx
  if (instr.kind === 'Assign') {
    return t.expressionStatement(
      t.assignmentExpression(
        '=',
        t.identifier(instr.target.name),
        lowerExpression(instr.value, ctx),
      ),
    )
  }
  if (instr.kind === 'Expression') {
    return t.expressionStatement(lowerExpression(instr.value, ctx))
  }
  if (instr.kind === 'Phi') {
    // Phi nodes are typically eliminated in SSA-out pass; emit comment for debugging
    return null
  }
  return null
}

function lowerTerminator(block: BasicBlock, ctx: CodegenContext): BabelCore.types.Statement[] {
  const { t } = ctx
  switch (block.terminator.kind) {
    case 'Return':
      return [
        t.returnStatement(
          block.terminator.argument ? lowerExpression(block.terminator.argument, ctx) : null,
        ),
      ]
    case 'Throw':
      return [t.throwStatement(lowerExpression(block.terminator.argument, ctx))]
    case 'Jump':
      return [t.expressionStatement(t.stringLiteral(`jump ${block.terminator.target}`))]
    case 'Branch':
      return [
        t.ifStatement(
          lowerExpression(block.terminator.test, ctx),
          t.blockStatement([
            t.expressionStatement(t.stringLiteral(`goto ${block.terminator.consequent}`)),
          ]),
          t.blockStatement([
            t.expressionStatement(t.stringLiteral(`goto ${block.terminator.alternate}`)),
          ]),
        ),
      ]
    case 'Switch':
      return [
        t.switchStatement(
          lowerExpression(block.terminator.discriminant, ctx),
          block.terminator.cases.map(({ test, target }) =>
            t.switchCase(test ? lowerExpression(test, ctx) : null, [
              t.expressionStatement(t.stringLiteral(`goto ${target}`)),
            ]),
          ),
        ),
      ]
    case 'ForOf': {
      const term = block.terminator
      const varKind = term.variableKind ?? 'const'
      const leftPattern = term.pattern ? term.pattern : t.identifier(term.variable)
      return [
        t.forOfStatement(
          t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)]),
          lowerExpression(term.iterable, ctx),
          t.blockStatement([t.expressionStatement(t.stringLiteral(`body ${term.body}`))]),
        ),
      ]
    }
    case 'ForIn': {
      const term = block.terminator
      const varKind = term.variableKind ?? 'const'
      const leftPattern = term.pattern ? term.pattern : t.identifier(term.variable)
      return [
        t.forInStatement(
          t.variableDeclaration(varKind, [t.variableDeclarator(leftPattern)]),
          lowerExpression(term.object, ctx),
          t.blockStatement([t.expressionStatement(t.stringLiteral(`body ${term.body}`))]),
        ),
      ]
    }
    case 'Try': {
      const term = block.terminator
      const tryBlock = t.blockStatement([
        t.expressionStatement(t.stringLiteral(`try ${term.tryBlock}`)),
      ])
      const catchClause =
        term.catchBlock !== undefined
          ? t.catchClause(
              term.catchParam ? t.identifier(term.catchParam) : null,
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
      return [t.tryStatement(tryBlock, catchClause, finallyBlock)]
    }
    case 'Unreachable':
      return []
    case 'Break':
      return [
        t.breakStatement(block.terminator.label ? t.identifier(block.terminator.label) : null),
      ]
    case 'Continue':
      return [
        t.continueStatement(block.terminator.label ? t.identifier(block.terminator.label) : null),
      ]
    default:
      return []
  }
}

/**
 * Attach runtime helper imports used during codegen.
 */
function attachHelperImports(
  ctx: CodegenContext,
  body: BabelCore.types.Statement[],
  t: typeof BabelCore.types,
): BabelCore.types.Statement[] {
  if (ctx.helpersUsed.size === 0) return body

  const specifiers: BabelCore.types.ImportSpecifier[] = []

  for (const name of ctx.helpersUsed) {
    const alias = (RUNTIME_ALIASES as Record<string, string>)[name]
    const helper = (RUNTIME_HELPERS as Record<string, string>)[name]
    if (alias && helper) {
      specifiers.push(t.importSpecifier(t.identifier(alias), t.identifier(helper)))
    }
  }

  if (specifiers.length === 0) return body

  const importDecl = t.importDeclaration(specifiers, t.stringLiteral(RUNTIME_MODULE))

  const helpers: BabelCore.types.Statement[] = []
  if (ctx.needsForOfHelper) {
    const itemId = t.identifier('item')
    const iterableId = t.identifier('iterable')
    const cbId = t.identifier('cb')
    helpers.push(
      t.functionDeclaration(
        t.identifier('__fictForOf'),
        [iterableId, cbId],
        t.blockStatement([
          t.forOfStatement(
            t.variableDeclaration('const', [t.variableDeclarator(itemId)]),
            iterableId,
            t.blockStatement([t.expressionStatement(t.callExpression(cbId, [itemId]))]),
          ),
        ]),
      ),
    )
  }
  if (ctx.needsForInHelper) {
    const keyId = t.identifier('key')
    const objId = t.identifier('obj')
    const cbId = t.identifier('cb')
    helpers.push(
      t.functionDeclaration(
        t.identifier('__fictForIn'),
        [objId, cbId],
        t.blockStatement([
          t.forInStatement(
            t.variableDeclaration('const', [t.variableDeclarator(keyId)]),
            objId,
            t.blockStatement([t.expressionStatement(t.callExpression(cbId, [keyId]))]),
          ),
        ]),
      ),
    )
  }

  return [importDecl, ...helpers, ...body]
}

/**
 * Lower an HIR Expression to a Babel AST Expression.
 * All SSA-versioned variable names are automatically de-versioned to their original names.
 */
export function lowerExpression(expr: Expression, ctx: CodegenContext): BabelCore.types.Expression {
  const { t } = ctx

  switch (expr.kind) {
    case 'Identifier':
      // Apply SSA de-versioning to restore original variable names
      return t.identifier(deSSAVarName(expr.name))

    case 'Literal':
      if (expr.value === null) return t.nullLiteral()
      if (expr.value === undefined) return t.identifier('undefined')
      if (typeof expr.value === 'string') return t.stringLiteral(expr.value)
      if (typeof expr.value === 'number') return t.numericLiteral(expr.value)
      if (typeof expr.value === 'boolean') return t.booleanLiteral(expr.value)
      return t.identifier('undefined')

    case 'CallExpression':
      // Handle Fict macros in experimental path
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '$state') {
        ctx.helpersUsed.add('useSignal')
        ctx.needsCtx = true
        return t.callExpression(t.identifier(RUNTIME_ALIASES.useSignal), [
          t.identifier('__fictCtx'),
          ...expr.arguments.map(a => lowerExpression(a, ctx)),
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '$effect') {
        ctx.helpersUsed.add('useEffect')
        ctx.needsCtx = true
        return t.callExpression(t.identifier(RUNTIME_ALIASES.useEffect), [
          t.identifier('__fictCtx'),
          ...expr.arguments.map(a => lowerExpression(a, ctx)),
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '__forOf') {
        ctx.needsForOfHelper = true
        const [iterable, cb] = expr.arguments.map(a => lowerExpression(a, ctx))
        return t.callExpression(t.identifier('__fictForOf'), [
          iterable ?? t.identifier('undefined'),
          cb ?? t.arrowFunctionExpression([], t.identifier('undefined')),
        ])
      }
      if (expr.callee.kind === 'Identifier' && expr.callee.name === '__forIn') {
        ctx.needsForInHelper = true
        const [obj, cb] = expr.arguments.map(a => lowerExpression(a, ctx))
        return t.callExpression(t.identifier('__fictForIn'), [
          obj ?? t.identifier('undefined'),
          cb ?? t.arrowFunctionExpression([], t.identifier('undefined')),
        ])
      }
      return t.callExpression(
        lowerExpression(expr.callee, ctx),
        expr.arguments.map(a => lowerExpression(a, ctx)),
      )

    case 'MemberExpression':
      return t.memberExpression(
        lowerExpression(expr.object, ctx),
        expr.computed
          ? lowerExpression(expr.property, ctx)
          : expr.property.kind === 'Identifier'
            ? t.identifier(expr.property.name) // Property names are NOT SSA-versioned
            : t.stringLiteral(String((expr.property as any).value ?? '')),
        expr.computed,
        expr.optional,
      )

    case 'BinaryExpression':
      return t.binaryExpression(
        expr.operator as any,
        lowerExpression(expr.left, ctx),
        lowerExpression(expr.right, ctx),
      )

    case 'UnaryExpression':
      return t.unaryExpression(
        expr.operator as any,
        lowerExpression(expr.argument, ctx),
        expr.prefix,
      )

    case 'LogicalExpression':
      return t.logicalExpression(
        expr.operator as any,
        lowerExpression(expr.left, ctx),
        lowerExpression(expr.right, ctx),
      )

    case 'ConditionalExpression':
      return t.conditionalExpression(
        lowerExpression(expr.test, ctx),
        lowerExpression(expr.consequent, ctx),
        lowerExpression(expr.alternate, ctx),
      )

    case 'ArrayExpression':
      return t.arrayExpression(expr.elements.map(el => lowerExpression(el, ctx)))

    case 'ObjectExpression':
      return t.objectExpression(
        expr.properties.map(p => {
          if (p.kind === 'SpreadElement') {
            return t.spreadElement(lowerExpression(p.argument, ctx))
          }
          // For shorthand properties, ensure key matches the de-versioned value name
          const valueExpr = lowerExpression(p.value, ctx)
          const keyName = p.key.kind === 'Identifier' ? p.key.name : String(p.key.value ?? '')
          const keyNode =
            p.key.kind === 'Identifier' ? t.identifier(keyName) : t.stringLiteral(keyName)

          // If shorthand and value is identifier, use de-versioned name for key too
          const useShorthand =
            p.shorthand &&
            t.isIdentifier(valueExpr) &&
            p.key.kind === 'Identifier' &&
            deSSAVarName(keyName) === valueExpr.name

          return t.objectProperty(
            useShorthand ? t.identifier(valueExpr.name) : keyNode,
            valueExpr,
            false,
            useShorthand,
          )
        }),
      )

    case 'JSXElement':
      return lowerJSXElement(expr, ctx)

    case 'ArrowFunction':
      if (expr.isExpression && !Array.isArray(expr.body)) {
        return t.arrowFunctionExpression(
          expr.params.map(p => t.identifier(deSSAVarName(p.name))),
          lowerExpression(expr.body, ctx),
        )
      } else {
        // Block body - simplified
        return t.arrowFunctionExpression(
          expr.params.map(p => t.identifier(deSSAVarName(p.name))),
          t.blockStatement([]),
        )
      }

    case 'FunctionExpression':
      return t.functionExpression(
        expr.name ? t.identifier(deSSAVarName(expr.name)) : null,
        expr.params.map(p => t.identifier(deSSAVarName(p.name))),
        t.blockStatement([]),
      )

    case 'AssignmentExpression':
      return t.assignmentExpression(
        expr.operator as any,
        lowerExpression(expr.left, ctx) as any,
        lowerExpression(expr.right, ctx),
      )

    case 'UpdateExpression':
      return t.updateExpression(
        expr.operator,
        lowerExpression(expr.argument, ctx) as any,
        expr.prefix,
      )

    case 'TemplateLiteral':
      return t.templateLiteral(
        expr.quasis.map((q, i) =>
          t.templateElement({ raw: q, cooked: q }, i === expr.quasis.length - 1),
        ),
        expr.expressions.map(e => lowerExpression(e, ctx)),
      )

    case 'SpreadElement':
      // SpreadElement is handled specially in ObjectExpression/ArrayExpression
      // When encountered as a standalone expression, lower its argument
      return lowerExpression(expr.argument, ctx)

    default:
      return t.identifier('undefined')
  }
}

/**
 * Lower an expression intended for DOM bindings, applying RegionMetadata overrides.
 */
function lowerDomExpression(
  expr: Expression,
  ctx: CodegenContext,
  region?: RegionInfo | null,
): BabelCore.types.Expression {
  const lowered = lowerExpression(expr, ctx)
  return applyRegionMetadataToExpression(lowered, ctx, region)
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
    // Component - use createElement
    ctx.helpersUsed.add('createElement')
    const props = buildPropsObject(jsx.attributes, ctx)
    const children = jsx.children.map(c => lowerJSXChild(c, ctx))

    const args: BabelCore.types.Expression[] = [
      typeof jsx.tagName === 'string'
        ? t.identifier(jsx.tagName)
        : lowerExpression(jsx.tagName, ctx),
    ]

    if (props || children.length > 0) {
      args.push(props ?? t.nullLiteral())
    }
    args.push(...children)

    return t.callExpression(t.identifier('createElement'), args)
  }

  // Intrinsic element - use fine-grained DOM
  return lowerIntrinsicElement(jsx, ctx)
}

/**
 * Collect all dependency variable names from an expression (de-versioned).
 */
function getMemberDependencyPath(expr: any): string | undefined {
  if (expr.kind === 'MemberExpression') {
    const prop = expr.property
    let propName: string | undefined
    if (!expr.computed && prop.kind === 'Identifier') {
      propName = prop.name
    } else if (prop.kind === 'Literal' && typeof prop.value === 'string') {
      propName = prop.value
    }
    if (!propName) return undefined
    const object = expr.object
    if (object.kind === 'Identifier') {
      return `${deSSAVarName(object.name)}.${propName}`
    }
    if (object.kind === 'MemberExpression') {
      const parent = getMemberDependencyPath(object)
      return parent ? `${parent}.${propName}` : undefined
    }
  }
  return undefined
}

function collectExpressionDependencies(expr: Expression, deps: Set<string>): void {
  if (expr.kind === 'Identifier') {
    deps.add(deSSAVarName(expr.name))
    return
  }
  if (expr.kind === 'MemberExpression') {
    const path = getMemberDependencyPath(expr)
    if (path) deps.add(path)
    collectExpressionDependencies(expr.object, deps)
    if (expr.computed && expr.property.kind !== 'Literal') {
      collectExpressionDependencies(expr.property, deps)
    }
    return
  }
  if (expr.kind === 'CallExpression') {
    collectExpressionDependencies(expr.callee, deps)
    expr.arguments.forEach(a => collectExpressionDependencies(a, deps))
    return
  }
  if (expr.kind === 'BinaryExpression' || expr.kind === 'LogicalExpression') {
    collectExpressionDependencies(expr.left, deps)
    collectExpressionDependencies(expr.right, deps)
    return
  }
  if (expr.kind === 'ConditionalExpression') {
    collectExpressionDependencies(expr.test, deps)
    collectExpressionDependencies(expr.consequent, deps)
    collectExpressionDependencies(expr.alternate, deps)
    return
  }
  if (expr.kind === 'UnaryExpression') {
    collectExpressionDependencies(expr.argument, deps)
    return
  }
  if (expr.kind === 'ArrayExpression') {
    expr.elements.forEach(el => collectExpressionDependencies(el, deps))
    return
  }
  if (expr.kind === 'ObjectExpression') {
    expr.properties.forEach(p => {
      if (p.kind === 'SpreadElement') {
        collectExpressionDependencies(p.argument, deps)
      } else {
        collectExpressionDependencies(p.value, deps)
      }
    })
    return
  }
  if (expr.kind === 'TemplateLiteral') {
    expr.expressions.forEach(e => collectExpressionDependencies(e, deps))
    return
  }
}

type RegionOverrideMap = Record<string, () => BabelCore.types.Expression>

/**
 * Apply RegionMetadata dependency overrides to a lowered expression.
 * This mirrors fine-grained-dom's applyRegionMetadata, but guards against
 * double-invoking callees by skipping overrides on call targets.
 */
function applyRegionMetadataToExpression(
  expr: BabelCore.types.Expression,
  ctx: CodegenContext,
  regionOverride?: RegionInfo | null,
): BabelCore.types.Expression {
  const region = regionOverride ?? ctx.currentRegion
  if (!region) return expr

  const metadata = regionInfoToMetadata(region)
  const state: { identifierOverrides?: RegionOverrideMap } = {}

  applyRegionMetadata(state as any, {
    region: metadata,
    dependencyGetter: name => buildDependencyGetter(name, ctx),
  })

  const overrides = state.identifierOverrides
  if (!overrides || Object.keys(overrides).length === 0) {
    return expr
  }

  if (ctx.t.isIdentifier(expr)) {
    const direct = overrides[expr.name]
    if (direct) {
      return direct()
    }
  }

  const cloned = ctx.t.cloneNode(expr, true) as BabelCore.types.Expression
  replaceIdentifiersWithOverrides(cloned, overrides, ctx.t)
  return cloned
}

/**
 * Replace identifiers using overrides while skipping call/optional call callees.
 * This is adapted from fine-grained-dom's replaceIdentifiers helper.
 */
function replaceIdentifiersWithOverrides(
  node: BabelCore.types.Node,
  overrides: RegionOverrideMap,
  t: typeof BabelCore.types,
  parentKind?: string,
  parentKey?: string,
): void {
  if (t.isIdentifier(node)) {
    const override = overrides[node.name]
    const isCallTarget =
      parentKey === 'callee' &&
      (parentKind === 'CallExpression' || parentKind === 'OptionalCallExpression')
    if (override && !isCallTarget) {
      const replacement = override()
      Object.assign(node, replacement)
    }
    return
  }

  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    // Avoid replacing parameter identifiers; only walk the body
    if (t.isBlockStatement(node.body)) {
      replaceIdentifiersWithOverrides(node.body, overrides, t, node.type, 'body')
    } else {
      replaceIdentifiersWithOverrides(node.body, overrides, t, node.type, 'body')
    }
    return
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && 'type' in (item as any)) {
          replaceIdentifiersWithOverrides(
            item as BabelCore.types.Node,
            overrides,
            t,
            node.type,
            key,
          )
        }
      }
    } else if (value && typeof value === 'object' && 'type' in (value as any)) {
      replaceIdentifiersWithOverrides(value as BabelCore.types.Node, overrides, t, node.type, key)
    }
  }
}

function buildDependencyGetter(name: string, ctx: CodegenContext): BabelCore.types.Expression {
  const { t } = ctx
  // Support simple dotted paths: foo.bar -> foo().bar if foo is tracked
  const parts = name.split('.')
  const base = parts.shift()!
  const baseId = t.identifier(base)
  const baseExpr =
    ctx.trackedVars.has(base) || ctx.currentRegion?.dependencies.has(base)
      ? t.callExpression(baseId, [])
      : baseId

  return parts.reduce<BabelCore.types.Expression>((acc, prop) => {
    const key = /^[a-zA-Z_$][\w$]*$/.test(prop) ? t.identifier(prop) : t.stringLiteral(prop)
    return t.memberExpression(acc, key, t.isStringLiteral(key))
  }, baseExpr)
}

function regionInfoToMetadata(region: RegionInfo): RegionMetadata {
  return {
    id: region.id,
    dependencies: new Set(region.dependencies),
    declarations: new Set(region.declarations),
    hasControlFlow: region.hasControlFlow,
    hasReactiveWrites: region.hasReactiveWrites ?? region.declarations.size > 0,
  }
}

/**
 * Find the region that contains all dependencies of an expression.
 * Returns the region if all deps are covered by a single region, null otherwise.
 */
function findContainingRegion(deps: Set<string>, ctx: CodegenContext): RegionInfo | null {
  if (!ctx.regions || ctx.regions.length === 0 || deps.size === 0) return null

  // Find a region whose declarations cover all the dependencies
  for (const region of ctx.regions) {
    let allCovered = true
    for (const dep of deps) {
      // Check if this dep is either a region declaration or a region dependency
      if (!region.declarations.has(dep) && !region.dependencies.has(dep)) {
        // Also check if it's a tracked var (signal) - those are fine
        if (!ctx.trackedVars.has(dep)) {
          allCovered = false
          break
        }
      }
    }
    if (allCovered) return region
  }
  return null
}

/**
 * Check if an HIR expression references a tracked/reactive variable.
 * Uses de-versioned names for matching.
 * Also considers region membership for more precise reactivity detection.
 */
function isExpressionReactive(expr: Expression, ctx: CodegenContext): boolean {
  // First collect all dependencies
  const deps = new Set<string>()
  collectExpressionDependencies(expr, deps)

  const regionsToCheck = ctx.currentRegion ? [ctx.currentRegion] : (ctx.regions ?? [])

  // Check if any dependency is tracked
  for (const dep of deps) {
    if (ctx.trackedVars.has(dep)) return true
  }

  // Check if any dependency is in a reactive region's declarations
  for (const region of regionsToCheck) {
    for (const dep of deps) {
      if (region.declarations.has(dep) || region.dependencies.has(dep)) {
        return true
      }
    }
  }

  return false
}

/**
 * Get the reactive dependencies of an expression that require binding.
 * Returns the set of tracked variables that the expression depends on.
 */
function getReactiveDependencies(expr: Expression, ctx: CodegenContext): Set<string> {
  const deps = new Set<string>()
  collectExpressionDependencies(expr, deps)

  const regionsToCheck = ctx.currentRegion ? [ctx.currentRegion] : (ctx.regions ?? [])

  const reactiveDeps = new Set<string>()
  for (const dep of deps) {
    if (ctx.trackedVars.has(dep)) {
      reactiveDeps.add(dep)
    }
  }

  // Also check region declarations
  for (const region of regionsToCheck) {
    for (const dep of deps) {
      if (region.declarations.has(dep) || region.dependencies.has(dep)) {
        reactiveDeps.add(dep)
      }
    }
  }

  return reactiveDeps
}

/**
 * Lower an intrinsic HTML element to fine-grained DOM operations.
 * Uses RegionMetadata to determine reactive bindings and optimize updates.
 */
function lowerIntrinsicElement(
  jsx: JSXElementExpression,
  ctx: CodegenContext,
): BabelCore.types.Expression {
  const { t } = ctx
  const tagName = jsx.tagName as string
  const statements: BabelCore.types.Statement[] = []

  // Collect all dependencies from this JSX element to find containing region
  const allDeps = new Set<string>()
  for (const attr of jsx.attributes) {
    if (attr.value) collectExpressionDependencies(attr.value, allDeps)
  }
  for (const child of jsx.children) {
    if (child.kind === 'JSXExpressionChild' && child.expression) {
      collectExpressionDependencies(child.expression, allDeps)
    }
  }

  // Find the containing region and apply it to the context
  // This is the HIR equivalent of calling applyRegionMetadata
  let containingRegion = findContainingRegion(allDeps, ctx)
  if (!containingRegion && allDeps.size > 0) {
    // Fallback synthetic region to ensure dependency overrides/memo are applied
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
  const shouldMemo = regionMeta ? shouldMemoizeRegion(regionMeta) : false
  if (shouldMemo) {
    ctx.helpersUsed.add('useMemo')
    ctx.needsCtx = true
  }

  // Use template helper to create nodes
  ctx.helpersUsed.add('template')
  const tmplId = genTemp(ctx, 'tmpl')
  const rootId = genTemp(ctx, 'root')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        tmplId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.template), [
          t.templateLiteral(
            [
              t.templateElement(
                { raw: `<${tagName}></${tagName}>`, cooked: `<${tagName}></${tagName}>` },
                true,
              ),
            ],
            [],
          ),
        ]),
      ),
    ]),
  )
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(rootId, t.callExpression(t.identifier(tmplId.name), [])),
    ]),
  )
  const elId = genTemp(ctx, 'el')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(elId, t.memberExpression(rootId, t.identifier('firstChild'))),
    ]),
  )

  // Handle attributes
  for (const attr of jsx.attributes) {
    if (attr.isSpread && attr.spreadExpr) {
      // Spread attributes - TODO: implement spread handling
      continue
    }

    const attrName = normalizeAttrName(attr.name)
    const valueExpr = attr.value
      ? lowerDomExpression(attr.value, ctx, containingRegion)
      : t.booleanLiteral(true)
    const valueIdentifier = ctx.t.isIdentifier(valueExpr) ? deSSAVarName(valueExpr.name) : undefined
    const valueWithRegion =
      valueIdentifier &&
      (regionMeta?.dependencies.has(valueIdentifier) || ctx.trackedVars.has(valueIdentifier))
        ? buildDependencyGetter(valueIdentifier, ctx)
        : valueExpr
    // Check if value is static (literal) or needs reactive binding
    // Use region-aware tracking for more precise reactivity detection
    const isStatic = attr.value
      ? attr.value.kind === 'Literal' || !isExpressionReactive(attr.value, ctx)
      : true

    if (attrName.startsWith('on')) {
      // Event handler
      const eventName = attrName.slice(2).toLowerCase()
      ctx.helpersUsed.add('bindEvent')
      ctx.helpersUsed.add('onDestroy')

      const cleanupId = genTemp(ctx, 'evt')
      statements.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            cleanupId,
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindEvent), [
              elId,
              t.stringLiteral(eventName),
              valueExpr,
            ]),
          ),
        ]),
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [cleanupId]),
        ),
      )
    } else if (attrName === 'class' || attrName === 'className') {
      ctx.helpersUsed.add('bindClass')
      statements.push(
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.bindClass), [
            elId,
            t.arrowFunctionExpression([], valueWithRegion),
          ]),
        ),
      )
    } else if (attrName === 'style') {
      if (isStatic) {
        // treat static style as a string setter
        const cssText =
          t.isStringLiteral(valueExpr) || t.isTemplateLiteral(valueExpr)
            ? valueExpr
            : t.callExpression(t.identifier('String'), [valueExpr])
        statements.push(
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(
                t.memberExpression(elId, t.identifier('style')),
                t.identifier('cssText'),
              ),
              cssText,
            ),
          ),
        )
      } else {
        ctx.helpersUsed.add('bindStyle')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindStyle), [
              elId,
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      }
    } else if (attrName === 'ref') {
      ctx.helpersUsed.add('bindRef')
      statements.push(
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.bindRef), [elId, valueExpr]),
        ),
      )
    } else if (isDOMProperty(attrName)) {
      // DOM property
      if (isStatic) {
        statements.push(
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(elId, t.identifier(attrName)),
              valueWithRegion,
            ),
          ),
        )
      } else {
        ctx.helpersUsed.add('bindProperty')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindProperty), [
              elId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      }
    } else {
      // Regular attribute
      if (isStatic) {
        statements.push(
          t.expressionStatement(
            t.callExpression(t.memberExpression(elId, t.identifier('setAttribute')), [
              t.stringLiteral(attrName),
              valueWithRegion,
            ]),
          ),
        )
      } else {
        ctx.helpersUsed.add('bindAttribute')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindAttribute), [
              elId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      }
    }
  }

  // Handle children
  for (const child of jsx.children) {
    emitChild(elId, child, statements, ctx)
  }

  // Restore previous region (after applyRegionToContext)
  applyRegionToContext(ctx, prevRegion ?? null)

  // Return element
  statements.push(t.returnStatement(elId))

  const body = t.blockStatement(statements)

  // Wrap in memo if region suggests memoization
  if (shouldMemo && containingRegion) {
    return t.callExpression(t.identifier(RUNTIME_ALIASES.useMemo), [
      t.identifier('__fictCtx'),
      t.arrowFunctionExpression([], body),
      t.numericLiteral(containingRegion.id),
    ])
  }

  // Wrap in IIFE
  return t.callExpression(t.arrowFunctionExpression([], body), [])
}

/**
 * Emit a JSX child to the parent element
 */
function emitChild(
  parentId: BabelCore.types.Identifier,
  child: JSXChild,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): void {
  const { t } = ctx

  if (child.kind === 'text') {
    // Static text node
    ctx.helpersUsed.add('insert')
    statements.push(
      t.expressionStatement(
        t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
          parentId,
          t.arrowFunctionExpression([], t.stringLiteral(child.value)),
          t.nullLiteral(),
          t.identifier(RUNTIME_ALIASES.createElement),
        ]),
      ),
    )
  } else if (child.kind === 'element') {
    // Nested element
    const childExpr = lowerJSXElement(child.value, ctx)
    ctx.helpersUsed.add('insert')
    ctx.helpersUsed.add('createElement')
    statements.push(
      t.expressionStatement(
        t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
          parentId,
          t.arrowFunctionExpression([], childExpr),
          t.nullLiteral(),
          t.identifier(RUNTIME_ALIASES.createElement),
        ]),
      ),
    )
  } else if (child.kind === 'expression') {
    // Dynamic expression
    const expr = child.value

    // Check if it's a conditional
    if (
      expr.kind === 'ConditionalExpression' ||
      (expr.kind === 'LogicalExpression' && expr.operator === '&&')
    ) {
      emitConditionalChild(parentId, expr, statements, ctx)
    } else if (expr.kind === 'CallExpression') {
      // Check if it's a map call (list rendering)
      if (
        expr.callee.kind === 'MemberExpression' &&
        expr.callee.property.kind === 'Identifier' &&
        (expr.callee.property as any).name === 'map'
      ) {
        emitListChild(parentId, expr, statements, ctx)
      } else {
        emitDynamicTextChild(parentId, expr, statements, ctx)
      }
    } else {
      emitDynamicTextChild(parentId, expr, statements, ctx)
    }
  }
}

/**
 * Emit a conditional child expression
 */
function emitConditionalChild(
  parentId: BabelCore.types.Identifier,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): void {
  const { t } = ctx
  ctx.helpersUsed.add('conditional')
  ctx.helpersUsed.add('createElement')
  ctx.helpersUsed.add('onDestroy')
  ctx.helpersUsed.add('toNodeArray')
  ctx.helpersUsed.add('insert')

  let condition: BabelCore.types.Expression
  let consequent: BabelCore.types.Expression
  let alternate: BabelCore.types.Expression | null = null

  if (expr.kind === 'ConditionalExpression') {
    condition = lowerDomExpression(expr.test, ctx)
    consequent = lowerDomExpression(expr.consequent, ctx)
    alternate = lowerDomExpression(expr.alternate, ctx)
  } else if (expr.kind === 'LogicalExpression' && expr.operator === '&&') {
    condition = lowerDomExpression(expr.left, ctx)
    consequent = lowerDomExpression(expr.right, ctx)
  } else {
    return
  }

  const bindingId = genTemp(ctx, 'cond')
  const args: BabelCore.types.Expression[] = [
    t.arrowFunctionExpression([], condition),
    t.arrowFunctionExpression([], consequent),
    t.identifier(RUNTIME_ALIASES.createElement),
  ]
  if (alternate) {
    args.push(t.arrowFunctionExpression([], alternate))
  }

  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        bindingId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.conditional), args),
      ),
    ]),
  )

  // Insert markers
  const markersId = genTemp(ctx, 'markers')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        markersId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.toNodeArray), [
          t.memberExpression(bindingId, t.identifier('marker')),
        ]),
      ),
    ]),
  )

  const mId = genTemp(ctx, 'm')
  statements.push(
    t.forOfStatement(
      t.variableDeclaration('const', [t.variableDeclarator(mId)]),
      markersId,
      t.blockStatement([
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
            parentId,
            mId,
            t.nullLiteral(),
            t.identifier(RUNTIME_ALIASES.createElement),
          ]),
        ),
      ]),
    ),
  )

  // Flush and cleanup
  statements.push(
    t.expressionStatement(
      t.optionalCallExpression(
        t.optionalMemberExpression(bindingId, t.identifier('flush'), false, true),
        [],
        true,
      ),
    ),
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
        t.memberExpression(bindingId, t.identifier('dispose')),
      ]),
    ),
  )
}

/**
 * Emit a list rendering child (array.map)
 */
function emitListChild(
  parentId: BabelCore.types.Identifier,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): void {
  const { t } = ctx

  if (expr.kind !== 'CallExpression' || expr.callee.kind !== 'MemberExpression') {
    return
  }

  ctx.helpersUsed.add('list')
  ctx.helpersUsed.add('onDestroy')
  ctx.helpersUsed.add('toNodeArray')
  ctx.helpersUsed.add('keyedList')
  ctx.helpersUsed.add('insert')

  const arrayExpr = lowerDomExpression(expr.callee.object, ctx)
  const mapCallback = expr.arguments[0]
  if (!mapCallback) {
    throw new Error('map callback is required')
  }
  const callbackExpr = applyRegionMetadataToExpression(lowerExpression(mapCallback, ctx), ctx)

  const listId = genTemp(ctx, 'list')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        listId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.keyedList), [
          t.arrowFunctionExpression([], arrayExpr),
          callbackExpr,
        ]),
      ),
    ]),
  )

  // Insert markers
  const markersId = genTemp(ctx, 'markers')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        markersId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.toNodeArray), [
          t.memberExpression(listId, t.identifier('marker')),
        ]),
      ),
    ]),
  )

  const mId = genTemp(ctx, 'm')
  statements.push(
    t.forOfStatement(
      t.variableDeclaration('const', [t.variableDeclarator(mId)]),
      markersId,
      t.blockStatement([
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
            parentId,
            mId,
            t.nullLiteral(),
            t.identifier(RUNTIME_ALIASES.createElement),
          ]),
        ),
      ]),
    ),
  )

  // Flush and cleanup
  statements.push(
    t.expressionStatement(
      t.optionalCallExpression(
        t.optionalMemberExpression(listId, t.identifier('flush'), false, true),
        [],
        true,
      ),
    ),
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
        t.memberExpression(listId, t.identifier('dispose')),
      ]),
    ),
  )
}

/**
 * Emit a dynamic text child
 */
function emitDynamicTextChild(
  parentId: BabelCore.types.Identifier,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): void {
  const { t } = ctx
  ctx.helpersUsed.add('bindText')
  ctx.helpersUsed.add('insert')
  ctx.helpersUsed.add('createElement')

  statements.push(
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
        parentId,
        t.arrowFunctionExpression(
          [],
          applyRegionMetadataToExpression(lowerExpression(expr, ctx), ctx),
        ),
        t.nullLiteral(),
        t.identifier(RUNTIME_ALIASES.createElement),
      ]),
    ),
  )
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
 * Build props object from JSX attributes
 */
function buildPropsObject(
  attributes: JSXElementExpression['attributes'],
  ctx: CodegenContext,
): BabelCore.types.Expression | null {
  const { t } = ctx

  if (attributes.length === 0) return null

  const properties: BabelCore.types.ObjectProperty[] = []
  const spreads: BabelCore.types.SpreadElement[] = []

  for (const attr of attributes) {
    if (attr.isSpread && attr.spreadExpr) {
      spreads.push(t.spreadElement(lowerExpression(attr.spreadExpr, ctx)))
    } else if (attr.value) {
      properties.push(t.objectProperty(t.identifier(attr.name), lowerExpression(attr.value, ctx)))
    } else {
      // Boolean attribute
      properties.push(t.objectProperty(t.identifier(attr.name), t.booleanLiteral(true)))
    }
  }

  if (spreads.length > 0) {
    return t.objectExpression([...spreads, ...properties])
  }

  return t.objectExpression(properties)
}

/**
 * Normalize attribute name from JSX to DOM
 */
function normalizeAttrName(name: string): string {
  if (name === 'className') return 'class'
  if (name === 'htmlFor') return 'for'
  return name
}

/**
 * Check if an attribute should be set as a DOM property
 */
function isDOMProperty(name: string): boolean {
  return ['value', 'checked', 'selected', 'disabled', 'readOnly', 'multiple', 'muted'].includes(
    name,
  )
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
  ctx.scopes = scopes

  // Mark tracked variables based on scope analysis
  if (scopes) {
    for (const scope of scopes.scopes) {
      for (const decl of scope.declarations) {
        ctx.trackedVars.add(decl)
      }
    }
  }

  const body: BabelCore.types.Statement[] = []
  for (const fn of program.functions) {
    const funcStmt = lowerFunctionWithScopes(fn, ctx)
    if (funcStmt) body.push(funcStmt)
  }

  return t.file(t.program(body))
}

/**
 * Lower a function with reactive scope information
 */
function lowerFunctionWithScopes(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  const params = fn.params.map(p => t.identifier(p.name))
  const statements: BabelCore.types.Statement[] = []

  // Emit instructions with scope-aware transformations
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      const stmt = lowerInstructionWithScopes(instr, ctx)
      if (stmt) statements.push(stmt)
    }
    statements.push(...lowerTerminator(block, ctx))
  }

  return t.functionDeclaration(t.identifier(fn.name ?? 'fn'), params, t.blockStatement(statements))
}

/**
 * Lower an instruction with reactive scope awareness
 */
function lowerInstructionWithScopes(
  instr: Instruction,
  ctx: CodegenContext,
): BabelCore.types.Statement | null {
  const { t } = ctx

  if (instr.kind === 'Assign') {
    const targetName = instr.target.name
    const valueExpr = lowerExpression(instr.value, ctx)

    // Check if target is a tracked variable
    if (ctx.trackedVars.has(targetName)) {
      // Wrap in memo if it depends on other tracked vars
      ctx.helpersUsed.add('useMemo')
      return t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier(targetName),
          t.callExpression(t.identifier('__fictUseMemo'), [
            t.arrowFunctionExpression([], valueExpr),
          ]),
        ),
      ])
    }

    return t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier(targetName), valueExpr),
    ])
  }

  if (instr.kind === 'Expression') {
    return t.expressionStatement(lowerExpression(instr.value, ctx))
  }

  return null
}

// ============================================================================
// Region-Based Codegen (P0 Integration)
// ============================================================================

import { analyzeReactiveScopesWithSSA } from './scopes'
import { generateRegions, generateRegionCode, regionToMetadata } from './regions'

import { applyRegionMetadata, shouldMemoizeRegion, type RegionMetadata } from '../fine-grained-dom'

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
): BabelCore.types.File {
  const ctx = createCodegenContext(t)
  const body: BabelCore.types.Statement[] = []

  // Map generated functions by name for replacement when walking original body
  const generatedFunctions = new Map<string, BabelCore.types.FunctionDeclaration>()
  for (const fn of program.functions) {
    const funcStmt = lowerFunctionWithRegions(fn, ctx)
    if (funcStmt && fn.name) {
      generatedFunctions.set(fn.name, funcStmt)
    } else if (funcStmt && !fn.name) {
      // Anonymous function - emit immediately
      body.push(funcStmt)
    }
  }

  const originalBody = program.originalBody ?? []

  // Rebuild program body preserving original order
  for (const stmt of originalBody as BabelCore.types.Statement[]) {
    if (t.isImportDeclaration(stmt)) {
      body.push(stmt)
      continue
    }

    // Function declarations
    if (t.isFunctionDeclaration(stmt) && stmt.id?.name) {
      const generated = generatedFunctions.get(stmt.id.name)
      if (generated) {
        body.push(generated)
        generatedFunctions.delete(stmt.id.name)
        continue
      }
    }

    // Export named with function declaration
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
      if (t.isFunctionDeclaration(stmt.declaration) && stmt.declaration.id?.name) {
        const name = stmt.declaration.id.name
        const generated = generatedFunctions.get(name)
        if (generated) {
          body.push(t.exportNamedDeclaration(generated, []))
          generatedFunctions.delete(name)
          continue
        }
      }
    }

    // Export default function declaration
    if (t.isExportDefaultDeclaration(stmt) && t.isFunctionDeclaration(stmt.declaration)) {
      const name = stmt.declaration.id?.name ?? '__default'
      const generated = generatedFunctions.get(name)
      if (generated) {
        body.push(t.exportDefaultDeclaration(generated))
        generatedFunctions.delete(name)
        continue
      }
    }

    body.push(stmt)
  }

  // Emit any remaining generated functions (not present in original order)
  for (const func of generatedFunctions.values()) {
    body.push(func)
  }

  return t.file(t.program(attachHelperImports(ctx, body, t)))
}

/**
 * Lower a function with region-based code generation
 */
function lowerFunctionWithRegions(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  // Always ensure context exists to support memo/region wrappers
  ctx.needsCtx = true

  // Analyze reactive scopes with SSA/CFG awareness
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  ctx.scopes = scopeResult

  // Generate region result for metadata
  const regionResult = generateRegions(fn, scopeResult)

  // Build RegionInfo array for DOM integration (with de-versioned names, flattened with children)
  ctx.regions = flattenRegions(regionResult.topLevelRegions)

  // Track region dependencies globally for reactive binding lookups
  for (const region of ctx.regions) {
    region.dependencies.forEach(dep => ctx.trackedVars.add(dep))
  }

  // Mark tracked variables (de-versioned for consistent lookups)
  for (const scope of scopeResult.scopes) {
    for (const decl of scope.declarations) {
      ctx.trackedVars.add(deSSAVarName(decl))
    }
  }

  // Also track $state variables that may not be in any scope
  // (e.g., signals used directly in JSX without derived values)
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' && instr.value.kind === 'CallExpression') {
        const call = instr.value
        if (call.callee.kind === 'Identifier' && call.callee.name === '$state') {
          ctx.trackedVars.add(deSSAVarName(instr.target.name))
        }
      }
    }
  }

  // Generate region-based statements
  const statements = generateRegionCode(fn, scopeResult, t, ctx)

  // Ensure context if signals/effects are used in experimental path
  ctx.helpersUsed.add('useContext')
  statements.unshift(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('__fictCtx'),
        t.callExpression(t.identifier(RUNTIME_ALIASES.useContext), []),
      ),
    ]),
  )

  // Regions rely on memo
  ctx.helpersUsed.add('useMemo')

  // De-version param names for clean output
  const params = fn.params.map(p => t.identifier(deSSAVarName(p.name)))
  return t.functionDeclaration(t.identifier(fn.name ?? 'fn'), params, t.blockStatement(statements))
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
