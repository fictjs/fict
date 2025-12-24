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
  /** Identifiers shadowed in the current lowering scope (params/locals) */
  shadowedNames?: Set<string>
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
  /** Alias variables that point to tracked signals (for reassignment guards) */
  aliasVars?: Set<string>
  /** Tracked bindings that exist outside the current lowering scope (e.g., captured signals) */
  externalTracked?: Set<string>
  /** Variables initialized with $store (need path-level reactivity, no getter transformation) */
  storeVars?: Set<string>
  /**
   * Rule L: Getter cache for sync blocks.
   * Maps getter expression keys to their cached variable names.
   * When enabled, repeated reads of the same getter within a sync function
   * will use a cached value instead of calling the getter multiple times.
   */
  getterCache?: Map<string, string>
  /** Pending cache declarations to insert at the start of a function body */
  getterCacheDeclarations?: Map<string, BabelCore.types.Expression>
  /** Whether getter caching is enabled for the current scope */
  getterCacheEnabled?: boolean
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
    shadowedNames: new Set(),
    needsForOfHelper: false,
    needsForInHelper: false,
    aliasVars: new Set(),
    externalTracked: new Set(),
    storeVars: new Set(),
    getterCache: new Map(),
    getterCacheDeclarations: new Map(),
    getterCacheEnabled: false,
  }
}

/**
 * Rule L: Enable getter caching for a sync function scope.
 * Returns a function to collect the cache declarations after processing.
 */
function withGetterCache<T>(
  ctx: CodegenContext,
  fn: () => T,
): { result: T; cacheDeclarations: BabelCore.types.Statement[] } {
  const prevCache = ctx.getterCache
  const prevDeclarations = ctx.getterCacheDeclarations
  const prevEnabled = ctx.getterCacheEnabled

  ctx.getterCache = new Map()
  ctx.getterCacheDeclarations = new Map()
  ctx.getterCacheEnabled = true

  const result = fn()

  // Collect cache declarations
  const cacheDeclarations: BabelCore.types.Statement[] = []
  if (ctx.getterCacheDeclarations && ctx.getterCacheDeclarations.size > 0) {
    for (const [varName, initExpr] of ctx.getterCacheDeclarations) {
      cacheDeclarations.push(
        ctx.t.variableDeclaration('const', [
          ctx.t.variableDeclarator(ctx.t.identifier(varName), initExpr),
        ]),
      )
    }
  }

  // Restore previous state
  ctx.getterCache = prevCache
  ctx.getterCacheDeclarations = prevDeclarations
  ctx.getterCacheEnabled = prevEnabled

  return { result, cacheDeclarations }
}

/**
 * Get or create a cached getter expression.
 * If the getter was already accessed, return the cached variable.
 * Otherwise, record it for caching and return the call expression.
 */
function getCachedGetterExpression(
  ctx: CodegenContext,
  getterName: string,
  callExpr: BabelCore.types.Expression,
): BabelCore.types.Expression {
  if (!ctx.getterCacheEnabled || !ctx.getterCache || !ctx.getterCacheDeclarations) {
    return callExpr
  }

  const existingCache = ctx.getterCache.get(getterName)
  if (existingCache) {
    // Already cached, return the cached variable
    return ctx.t.identifier(existingCache)
  }

  // First access - record for caching
  const cacheVar = `__cached_${getterName}_${ctx.tempCounter++}`
  ctx.getterCache.set(getterName, cacheVar)
  ctx.getterCacheDeclarations.set(cacheVar, callExpr)

  // Return the cache variable (will be declared at function start)
  return ctx.t.identifier(cacheVar)
}

function detectDerivedCycles(fn: HIRFunction, scopeResult: ReactiveScopeResult): void {
  if (process.env.DEBUG_CYCLES_THROW) {
    throw new Error('cycle check invoked')
  }
  const declared = new Map<
    string,
    { isState: boolean; isStore: boolean; declaredHere: boolean; count: number }
  >()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const target = deSSAVarName(instr.target.name)
      const isStateCall =
        instr.value.kind === 'CallExpression' &&
        instr.value.callee.kind === 'Identifier' &&
        instr.value.callee.name === '$state'
      const isStoreCall =
        instr.value.kind === 'CallExpression' &&
        instr.value.callee.kind === 'Identifier' &&
        instr.value.callee.name === '$store'
      const prev = declared.get(target)
      declared.set(target, {
        isState: (prev?.isState ?? false) || isStateCall,
        isStore: (prev?.isStore ?? false) || isStoreCall,
        declaredHere: prev?.declaredHere || !!instr.declarationKind,
        count: (prev?.count ?? 0) + 1,
      })
    }
  }

  const graph = new Map<string, Set<string>>()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const target = deSSAVarName(instr.target.name)
      const declInfo = declared.get(target)
      if (declInfo?.isState || !declInfo?.declaredHere) continue
      if ((declInfo.count ?? 0) !== 1) continue
      const deps = graph.get(target) ?? new Set<string>()
      const rawDeps = new Set<string>()
      collectExpressionDependencies(instr.value, rawDeps)
      for (const dep of rawDeps) {
        const base = deSSAVarName(dep.split('.')[0] ?? dep)
        const depInfo = declared.get(base)
        if (depInfo && depInfo.declaredHere && !depInfo.isState && (depInfo.count ?? 0) === 1) {
          deps.add(base)
        }
      }
      graph.set(target, deps)
    }
  }
  if (graph.size === 0) return

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (node: string) => {
    if (visiting.has(node)) {
      const idx = stack.indexOf(node)
      const cycle = idx >= 0 ? [...stack.slice(idx), node] : [...stack, node]
      throw new Error(`Detected cyclic derived dependency: ${cycle.join(' -> ')}`)
    }
    if (visited.has(node)) return
    visiting.add(node)
    stack.push(node)
    for (const dep of graph.get(node) ?? []) {
      visit(dep)
    }
    stack.pop()
    visiting.delete(node)
    visited.add(node)
  }

  for (const node of graph.keys()) {
    visit(node)
  }

  if (process.env.DEBUG_CYCLES) {
    // eslint-disable-next-line no-console
    console.error(
      'cycle graph',
      Array.from(graph.entries()).map(([k, v]) => [k, Array.from(v)]),
    )
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

  return t.file(t.program(attachHelperImports(ctx, filteredBody, t)))
}

function lowerFunction(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  const prevTracked = ctx.trackedVars
  const scopedTracked = new Set(ctx.trackedVars)
  fn.params.forEach(p => scopedTracked.delete(deSSAVarName(p.name)))
  ctx.trackedVars = scopedTracked
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

  const result = t.functionDeclaration(
    t.identifier(fn.name ?? 'fn'),
    params,
    t.blockStatement(statements),
  )
  ctx.trackedVars = prevTracked
  return result
}

function lowerTrackedExpression(expr: Expression, ctx: CodegenContext): BabelCore.types.Expression {
  const regionOverride =
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
  const lowered = lowerExpression(expr, ctx)
  return applyRegionMetadataToExpression(lowered, ctx, regionOverride ?? undefined)
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
        lowerTrackedExpression(instr.value, ctx),
      ),
    )
  }
  if (instr.kind === 'Expression') {
    return t.expressionStatement(lowerTrackedExpression(instr.value, ctx))
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
          block.terminator.argument ? lowerTrackedExpression(block.terminator.argument, ctx) : null,
        ),
      ]
    case 'Throw':
      return [t.throwStatement(lowerTrackedExpression(block.terminator.argument, ctx))]
    case 'Jump':
      return [t.expressionStatement(t.stringLiteral(`jump ${block.terminator.target}`))]
    case 'Branch':
      return [
        t.ifStatement(
          lowerTrackedExpression(block.terminator.test, ctx),
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
          lowerTrackedExpression(block.terminator.discriminant, ctx),
          block.terminator.cases.map(({ test, target }) =>
            t.switchCase(test ? lowerTrackedExpression(test, ctx) : null, [
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
  const mapParams = (params: { name: string }[]) =>
    params.map(p => t.identifier(deSSAVarName(p.name)))
  const withFunctionScope = <T>(paramNames: Set<string>, fn: () => T): T => {
    const prevTracked = ctx.trackedVars
    const prevAlias = ctx.aliasVars
    const prevExternal = ctx.externalTracked
    const prevShadowed = ctx.shadowedNames
    const scoped = new Set(ctx.trackedVars)
    paramNames.forEach(n => scoped.delete(deSSAVarName(n)))
    ctx.trackedVars = scoped
    ctx.aliasVars = new Set(ctx.aliasVars)
    ctx.externalTracked = new Set(prevTracked)
    const shadowed = new Set(prevShadowed ?? [])
    paramNames.forEach(n => shadowed.add(deSSAVarName(n)))
    ctx.shadowedNames = shadowed
    const result = fn()
    ctx.trackedVars = prevTracked
    ctx.aliasVars = prevAlias
    ctx.externalTracked = prevExternal
    ctx.shadowedNames = prevShadowed
    return result
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

    case 'ArrowFunction': {
      const paramIds = mapParams(expr.params)
      const shadowed = new Set(expr.params.map(p => deSSAVarName(p.name)))
      return withFunctionScope(shadowed, () => {
        let fn: BabelCore.types.ArrowFunctionExpression
        if (expr.isExpression && !Array.isArray(expr.body)) {
          // Rule L: Enable getter caching for sync arrow functions with expression body
          const { result: bodyExpr, cacheDeclarations } = withGetterCache(ctx, () =>
            lowerTrackedExpression(expr.body as Expression, ctx),
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
          const { result: stmts, cacheDeclarations } = withGetterCache(ctx, () =>
            lowerBlocksToStatements(expr.body as BasicBlock[]),
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
      })
    }

    case 'FunctionExpression': {
      const paramIds = mapParams(expr.params)
      const shadowed = new Set(expr.params.map(p => deSSAVarName(p.name)))
      return withFunctionScope(shadowed, () => {
        let fn: BabelCore.types.FunctionExpression
        if (Array.isArray(expr.body)) {
          // Rule L: Enable getter caching for sync function expressions
          const { result: stmts, cacheDeclarations } = withGetterCache(ctx, () =>
            lowerBlocksToStatements(expr.body as BasicBlock[]),
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
        return fn
      })
    }

    case 'AssignmentExpression':
      if (expr.left.kind === 'Identifier') {
        const baseName = deSSAVarName(expr.left.name)
        if (ctx.trackedVars.has(baseName)) {
          const id = t.identifier(baseName)
          const current = t.callExpression(t.identifier(baseName), [])
          const right = lowerExpression(expr.right, ctx)
          let next: BabelCore.types.Expression
          switch (expr.operator) {
            case '=':
              next = right
              break
            case '+=':
              next = t.binaryExpression('+', current, right)
              break
            case '-=':
              next = t.binaryExpression('-', current, right)
              break
            case '*=':
              next = t.binaryExpression('*', current, right)
              break
            case '/=':
              next = t.binaryExpression('/', current, right)
              break
            default:
              next = right
          }
          return t.callExpression(id, [next])
        }
      }

      return t.assignmentExpression(
        expr.operator as any,
        lowerExpression(expr.left, ctx) as any,
        lowerExpression(expr.right, ctx),
      )

    case 'UpdateExpression':
      if (expr.argument.kind === 'Identifier') {
        const baseName = deSSAVarName(expr.argument.name)
        if (ctx.trackedVars.has(baseName)) {
          const id = t.identifier(baseName)
          const current = t.callExpression(t.identifier(baseName), [])
          const delta = t.numericLiteral(1)
          const next =
            expr.operator === '++'
              ? t.binaryExpression('+', current, delta)
              : t.binaryExpression('-', current, delta)
          return t.callExpression(id, [next])
        }
      }

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

    case 'AwaitExpression':
      return t.awaitExpression(lowerExpression(expr.argument, ctx))

    case 'NewExpression':
      return t.newExpression(
        lowerExpression(expr.callee, ctx),
        expr.arguments.map(a => lowerExpression(a, ctx)),
      )

    case 'SequenceExpression':
      return t.sequenceExpression(expr.expressions.map(e => lowerExpression(e, ctx)))

    case 'YieldExpression':
      return t.yieldExpression(
        expr.argument ? lowerExpression(expr.argument, ctx) : null,
        expr.delegate,
      )

    case 'OptionalCallExpression':
      return t.optionalCallExpression(
        lowerExpression(expr.callee, ctx),
        expr.arguments.map(a => lowerExpression(a, ctx)),
        expr.optional,
      )

    case 'TaggedTemplateExpression':
      return t.taggedTemplateExpression(
        lowerExpression(expr.tag, ctx),
        t.templateLiteral(
          expr.quasi.quasis.map((q, i) =>
            t.templateElement({ raw: q, cooked: q }, i === expr.quasi.quasis.length - 1),
          ),
          expr.quasi.expressions.map(e => lowerExpression(e, ctx)),
        ),
      )

    case 'ClassExpression':
      // For now, just return the class body as-is (stored as Babel AST)
      return t.classExpression(
        expr.name ? t.identifier(expr.name) : null,
        expr.superClass ? lowerExpression(expr.superClass, ctx) : null,
        t.classBody(expr.body ?? []),
      )

    case 'ThisExpression':
      return t.thisExpression()

    case 'SuperExpression':
      return t.super()

    case 'OptionalMemberExpression':
      return t.optionalMemberExpression(
        lowerExpression(expr.object, ctx),
        expr.computed
          ? lowerExpression(expr.property, ctx)
          : expr.property.kind === 'Identifier'
            ? t.identifier(expr.property.name)
            : t.stringLiteral(String((expr.property as any).value ?? '')),
        expr.computed,
        expr.optional,
      )

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

function normalizeDependencyKey(name: string): string {
  return name
    .split('.')
    .map(part => deSSAVarName(part))
    .join('.')
}

function getDependencyPathFromNode(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): string | null {
  if (t.isIdentifier(node)) {
    return normalizeDependencyKey(node.name)
  }

  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node as any)) {
    const object = (node as any).object as BabelCore.types.Node
    const property = (node as any).property as BabelCore.types.Node
    const objectPath = getDependencyPathFromNode(object, t)
    if (!objectPath) return null

    let propName: string | null = null
    if ((node as any).computed) {
      if (t.isStringLiteral(property) || t.isNumericLiteral(property)) {
        propName = String((property as any).value)
      }
    } else if (t.isIdentifier(property)) {
      propName = property.name
    }

    if (!propName) return objectPath
    return `${objectPath}.${propName}`
  }

  return null
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
): BabelCore.types.Expression {
  const region = regionOverride ?? ctx.currentRegion
  if (!region) return expr

  const metadata = regionInfoToMetadata(region)
  const state: { identifierOverrides?: RegionOverrideMap } = {}

  applyRegionMetadata(state as any, {
    region: metadata,
    dependencyGetter: name => buildDependencyGetter(name, ctx),
  })

  const overrides = state.identifierOverrides ?? {}
  state.identifierOverrides = overrides

  const shadowed = ctx.shadowedNames

  if (shadowed && Object.keys(overrides).length > 0) {
    for (const key of Object.keys(overrides)) {
      const base = normalizeDependencyKey(key).split('.')[0] ?? key
      if (shadowed.has(base)) {
        delete overrides[key]
      }
    }
  }

  // Ensure tracked variables are also covered even if region metadata missed them
  for (const dep of ctx.trackedVars) {
    const key = normalizeDependencyKey(dep)
    const base = key.split('.')[0] ?? key
    if (shadowed && shadowed.has(base)) continue
    if (!overrides[key]) {
      overrides[key] = () => buildDependencyGetter(dep, ctx)
    }
  }

  if (Object.keys(overrides).length === 0) {
    return expr
  }

  if (ctx.t.isIdentifier(expr)) {
    const key = normalizeDependencyKey(expr.name)
    const direct = overrides[key] ?? overrides[expr.name]
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
  const isCallTarget =
    parentKey === 'callee' &&
    (parentKind === 'CallExpression' || parentKind === 'OptionalCallExpression')

  const collectParamNames = (params: BabelCore.types.Function['params']): Set<string> => {
    const names = new Set<string>()
    const addName = (n: string | undefined) => {
      if (n) names.add(normalizeDependencyKey(n).split('.')[0] ?? n)
    }
    const visitPattern = (p: BabelCore.types.LVal | BabelCore.types.PatternLike) => {
      if (t.isIdentifier(p)) {
        addName(p.name)
      } else if (t.isTSParameterProperty(p)) {
        visitPattern(p.parameter as any)
      } else if (t.isRestElement(p) && t.isIdentifier(p.argument)) {
        addName(p.argument.name)
      } else if (t.isAssignmentPattern(p)) {
        visitPattern(p.left)
      } else if (t.isObjectPattern(p)) {
        p.properties.forEach(prop => {
          if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
            addName(prop.argument.name)
          } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.value)) {
            addName(prop.value.name)
          } else if (t.isObjectProperty(prop) && t.isPatternLike(prop.value)) {
            visitPattern(prop.value as BabelCore.types.PatternLike)
          }
        })
      } else if (t.isArrayPattern(p)) {
        p.elements.forEach(el => {
          if (t.isIdentifier(el)) addName(el.name)
          else if (el && t.isPatternLike(el)) visitPattern(el as any)
        })
      }
    }
    params.forEach(p => visitPattern(p))
    return names
  }

  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node as any)) {
    const path = getDependencyPathFromNode(node, t)
    const normalized = path ? normalizeDependencyKey(path) : null
    const override = (normalized && overrides[normalized]) || (path ? overrides[path] : undefined)
    if (override && !isCallTarget) {
      const replacement = override()
      Object.assign(node, replacement)
      return
    }
  }

  if (t.isIdentifier(node)) {
    const key = normalizeDependencyKey(node.name)
    const override = overrides[key] ?? overrides[node.name]
    if (override && !isCallTarget) {
      const replacement = override()
      Object.assign(node, replacement)
      return
    }
  }

  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    const paramNames = collectParamNames(node.params)
    let scopedOverrides = overrides
    if (paramNames.size > 0) {
      scopedOverrides = {}
      for (const key of Object.keys(overrides)) {
        const base = normalizeDependencyKey(key).split('.')[0] ?? key
        if (!paramNames.has(base)) {
          scopedOverrides[key] = overrides[key]
        }
      }
    }
    // Avoid replacing parameter identifiers; only walk the body
    if (t.isBlockStatement(node.body)) {
      replaceIdentifiersWithOverrides(node.body, scopedOverrides, t, node.type, 'body')
    } else {
      replaceIdentifiersWithOverrides(node.body, scopedOverrides, t, node.type, 'body')
    }
    return
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
    if (t.isObjectProperty(node as any) && key === 'key' && !(node as any).computed) {
      continue
    }
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
  const isTracked = ctx.trackedVars.has(base) || ctx.currentRegion?.dependencies.has(base)
  // $store variables use proxy-based reactivity, don't convert to getter calls
  const isStore = ctx.storeVars?.has(base) ?? false

  let baseExpr: BabelCore.types.Expression
  if (isTracked && !isStore) {
    // Rule L: Use getter cache when enabled to avoid redundant getter calls
    const cached = getCachedGetterExpression(base, ctx)
    if (cached) {
      baseExpr = cached
    } else {
      baseExpr = t.callExpression(baseId, [])
    }
  } else {
    // For store variables and non-tracked variables, use identifier directly
    // Stores use proxy-based path-level reactivity internally
    baseExpr = baseId
  }

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

  const depList = Array.from(deps).map(d => normalizeDependencyKey(d))

  // Find a region whose declarations cover all the dependencies
  for (const region of ctx.regions) {
    let allCovered = true
    for (const dep of depList) {
      const coveredByRegion =
        dependencyCoveredByRegion(dep, region) ||
        dependencyCoveredByDeclarations(dep, region) ||
        ctx.trackedVars.has(dep)
      if (!coveredByRegion) {
        allCovered = false
        break
      }
    }
    if (allCovered) return region
  }
  return null
}

function dependencyCoveredByRegion(dep: string, region: RegionInfo): boolean {
  for (const rDep of region.dependencies) {
    const normalized = normalizeDependencyKey(rDep)
    if (dep === normalized) return true
    if (dep.startsWith(`${normalized}.`)) return true
    if (normalized.startsWith(`${dep}.`)) return true
  }
  return false
}

function dependencyCoveredByDeclarations(dep: string, region: RegionInfo): boolean {
  for (const decl of region.declarations) {
    const normalized = normalizeDependencyKey(decl)
    if (dep === normalized) return true
    if (dep.startsWith(`${normalized}.`)) return true
    if (normalized.startsWith(`${dep}.`)) return true
  }
  return false
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

// ============================================================================
// HIR Template Extraction (aligned with fine-grained-dom.ts)
// ============================================================================

interface HIRBinding {
  type: 'attr' | 'child' | 'event'
  path: number[] // path to navigate from root to target node
  name?: string // for attributes/events
  expr?: Expression // the dynamic expression
  eventOptions?: { capture?: boolean; passive?: boolean; once?: boolean }
}

interface HIRTemplateExtractionResult {
  html: string
  bindings: HIRBinding[]
}

/**
 * Check if an expression is static (can be included in template HTML).
 */
function isStaticValue(expr: Expression | null): expr is Expression & { kind: 'Literal' } {
  if (!expr) return false
  return expr.kind === 'Literal'
}

/**
 * Normalize attribute names for special cases.
 */
function normalizeHIRAttrName(name: string): string {
  if (name === 'className') return 'class'
  if (name === 'htmlFor') return 'for'
  return name
}

/**
 * Extract static HTML from HIR JSXElementExpression.
 * Similar to extractStaticHtml from fine-grained-dom.ts but works with HIR types.
 */
function extractHIRStaticHtml(
  jsx: JSXElementExpression,
  parentPath: number[] = [],
): HIRTemplateExtractionResult {
  const tagName = jsx.tagName as string
  let html = `<${tagName}`
  const bindings: HIRBinding[] = []

  // Process attributes
  for (const attr of jsx.attributes) {
    if (attr.isSpread) {
      // Spread attributes are always dynamic - skip in template
      continue
    }

    const name = normalizeHIRAttrName(attr.name)

    // Skip key attribute
    if (name === 'key') continue

    // Event handlers are always dynamic
    if (name.startsWith('on') && name.length > 2 && name[2] === name[2]?.toUpperCase()) {
      let eventName = name.slice(2)
      let capture = false
      let passive = false
      let once = false

      // Parse event modifiers
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

      bindings.push({
        type: 'event',
        path: [...parentPath],
        name: eventName.toLowerCase(),
        expr: attr.value ?? undefined,
        eventOptions: { capture, passive, once },
      })
      continue
    }

    // ref is always dynamic
    if (name === 'ref') {
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name: 'ref',
        expr: attr.value ?? undefined,
      })
      continue
    }

    // Check if value is static
    if (isStaticValue(attr.value)) {
      const value = attr.value.value
      if (typeof value === 'string') {
        // Escape HTML attribute value
        const escaped = String(value).replace(/"/g, '&quot;')
        html += ` ${name}="${escaped}"`
      } else if (typeof value === 'boolean' && value) {
        html += ` ${name}`
      } else if (typeof value === 'number') {
        html += ` ${name}="${value}"`
      }
    } else if (attr.value === null) {
      // Boolean attribute without value
      html += ` ${name}`
    } else {
      // Dynamic attribute
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name,
        expr: attr.value ?? undefined,
      })
    }
  }

  html += '>'

  // Process children
  let childIndex = 0
  for (const child of jsx.children) {
    if (child.kind === 'text') {
      const text = child.value
      if (text.trim()) {
        html += text
        childIndex++
      }
    } else if (child.kind === 'element') {
      const childPath = [...parentPath, childIndex]
      const childResult = extractHIRStaticHtml(child.value, childPath)
      html += childResult.html
      bindings.push(...childResult.bindings)
      childIndex++
    } else if (child.kind === 'expression') {
      // Dynamic expression - insert placeholder comment
      html += '<!---->'
      bindings.push({
        type: 'child',
        path: [...parentPath, childIndex],
        expr: child.value,
      })
      childIndex++
    }
  }

  html += `</${tagName}>`

  return { html, bindings }
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

  // Extract static HTML with bindings (aligned with fine-grained-dom.ts)
  const { html, bindings } = extractHIRStaticHtml(jsx)

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
  const shouldMemo = regionMeta ? shouldMemoizeRegion(regionMeta) : false
  if (shouldMemo) {
    ctx.helpersUsed.add('useMemo')
    ctx.needsCtx = true
  }

  // Create template with full static HTML
  ctx.helpersUsed.add('template')
  const tmplId = genTemp(ctx, 'tmpl')
  const rootId = genTemp(ctx, 'root')
  statements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        tmplId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.template), [t.stringLiteral(html)]),
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

  // Build a cache for resolved node paths
  const nodeCache = new Map<string, BabelCore.types.Identifier>()
  nodeCache.set('', elId)

  // Apply bindings using path navigation
  for (const binding of bindings) {
    const targetId = resolveHIRBindingPath(binding.path, nodeCache, statements, ctx)

    if (binding.type === 'event' && binding.expr && binding.name) {
      // Event binding
      ctx.helpersUsed.add('bindEvent')
      ctx.helpersUsed.add('onDestroy')
      const valueExpr = lowerDomExpression(binding.expr, ctx, containingRegion)
      const cleanupId = genTemp(ctx, 'evt')
      const args: BabelCore.types.Expression[] = [
        targetId,
        t.stringLiteral(binding.name),
        valueExpr,
      ]
      if (
        binding.eventOptions &&
        (binding.eventOptions.capture || binding.eventOptions.passive || binding.eventOptions.once)
      ) {
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
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindEvent), args),
          ),
        ]),
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [cleanupId]),
        ),
      )
    } else if (binding.type === 'attr' && binding.name) {
      // Attribute binding
      const attrName = binding.name
      const valueExpr = binding.expr
        ? lowerDomExpression(binding.expr, ctx, containingRegion)
        : t.booleanLiteral(true)
      const valueIdentifier = ctx.t.isIdentifier(valueExpr)
        ? deSSAVarName(valueExpr.name)
        : undefined
      const valueWithRegion =
        valueIdentifier &&
        (regionMeta?.dependencies.has(valueIdentifier) || ctx.trackedVars.has(valueIdentifier))
          ? buildDependencyGetter(valueIdentifier, ctx)
          : valueExpr

      if (attrName === 'ref') {
        ctx.helpersUsed.add('bindRef')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindRef), [targetId, valueExpr]),
          ),
        )
      } else if (attrName === 'class' || attrName === 'className') {
        ctx.helpersUsed.add('bindClass')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindClass), [
              targetId,
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      } else if (attrName === 'style') {
        ctx.helpersUsed.add('bindStyle')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindStyle), [
              targetId,
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      } else if (isDOMProperty(attrName)) {
        ctx.helpersUsed.add('bindProperty')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindProperty), [
              targetId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      } else {
        ctx.helpersUsed.add('bindAttribute')
        statements.push(
          t.expressionStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.bindAttribute), [
              targetId,
              t.stringLiteral(attrName),
              t.arrowFunctionExpression([], valueWithRegion),
            ]),
          ),
        )
      }
    } else if (binding.type === 'child' && binding.expr) {
      // Child binding (dynamic expression at placeholder)
      emitHIRChildBinding(targetId, binding.expr, statements, ctx, containingRegion)
    }
  }

  // Restore previous region
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
 * Resolve a path to a DOM node using firstChild/nextSibling navigation.
 * Caches intermediate nodes for efficiency.
 */
function resolveHIRBindingPath(
  path: number[],
  cache: Map<string, BabelCore.types.Identifier>,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
): BabelCore.types.Identifier {
  const key = path.join(',')
  if (cache.has(key)) return cache.get(key)!

  const { t } = ctx

  // Find closest ancestor in cache
  const ancestorPath = [...path]
  let ancestorId: BabelCore.types.Identifier | undefined
  let relativePath: number[] = []

  while (ancestorPath.length > 0) {
    ancestorPath.pop()
    const ancestorKey = ancestorPath.join(',')
    if (cache.has(ancestorKey)) {
      ancestorId = cache.get(ancestorKey)
      relativePath = path.slice(ancestorPath.length)
      break
    }
  }

  if (!ancestorId) {
    ancestorId = cache.get('')!
    relativePath = path
  }

  // Navigate relative path using firstChild/nextSibling
  let currentExpr: BabelCore.types.Expression = ancestorId
  for (const index of relativePath) {
    currentExpr = t.memberExpression(currentExpr, t.identifier('firstChild'))
    for (let i = 0; i < index; i++) {
      currentExpr = t.memberExpression(currentExpr, t.identifier('nextSibling'))
    }
  }

  const varId = genTemp(ctx, 'el')
  statements.push(t.variableDeclaration('const', [t.variableDeclarator(varId, currentExpr)]))
  cache.set(key, varId)
  return varId
}

/**
 * Emit a child binding at a placeholder comment node.
 */
function emitHIRChildBinding(
  markerId: BabelCore.types.Identifier,
  expr: Expression,
  statements: BabelCore.types.Statement[],
  ctx: CodegenContext,
  containingRegion: RegionInfo | null,
): void {
  const { t } = ctx
  const parentId = t.memberExpression(markerId, t.identifier('parentNode'))

  // Check if it's a conditional
  if (
    expr.kind === 'ConditionalExpression' ||
    (expr.kind === 'LogicalExpression' && expr.operator === '&&')
  ) {
    emitConditionalChild(parentId, expr, statements, ctx)
    return
  }

  // Check if it's a list (.map call)
  if (expr.kind === 'CallExpression') {
    const callee = expr.callee
    if (
      callee.kind === 'MemberExpression' &&
      callee.property.kind === 'Identifier' &&
      callee.property.name === 'map'
    ) {
      emitListChild(parentId, expr, statements, ctx)
      return
    }
  }

  // Check if it's a JSX element
  if (expr.kind === 'JSXElement') {
    const childExpr = lowerJSXElement(expr, ctx)
    ctx.helpersUsed.add('insert')
    ctx.helpersUsed.add('createElement')
    statements.push(
      t.expressionStatement(
        t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
          parentId,
          t.arrowFunctionExpression([], childExpr),
          markerId,
          t.identifier(RUNTIME_ALIASES.createElement),
        ]),
      ),
    )
    return
  }

  // Default: insert dynamic expression
  const valueExpr = lowerDomExpression(expr, ctx, containingRegion)
  ctx.helpersUsed.add('insert')
  ctx.helpersUsed.add('createElement')
  statements.push(
    t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
        parentId,
        t.arrowFunctionExpression([], valueExpr),
        markerId,
        t.identifier(RUNTIME_ALIASES.createElement),
      ]),
    ),
  )
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
  let callbackExpr = applyRegionMetadataToExpression(lowerExpression(mapCallback, ctx), ctx)

  if (t.isArrowFunctionExpression(callbackExpr) || t.isFunctionExpression(callbackExpr)) {
    const firstParam = callbackExpr.params[0]
    if (t.isIdentifier(firstParam)) {
      const overrides: RegionOverrideMap = {
        [firstParam.name]: () => t.callExpression(t.identifier(firstParam.name), []),
      }
      if (t.isBlockStatement(callbackExpr.body)) {
        replaceIdentifiersWithOverrides(callbackExpr.body, overrides, t, callbackExpr.type, 'body')
      } else {
        const newBody = t.cloneNode(callbackExpr.body, true) as BabelCore.types.Expression
        replaceIdentifiersWithOverrides(newBody, overrides, t, callbackExpr.type, 'body')
        callbackExpr = t.arrowFunctionExpression(callbackExpr.params, newBody)
      }
    }
  }

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

import { convertStatementsToHIRFunction } from './build-hir'
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
  const topLevelAliases = new Set<string>()
  let topLevelCtxInjected = false
  const emittedFunctionNames = new Set<string>()
  const originalBody = (program.originalBody ?? []) as BabelCore.types.Statement[]

  // Pre-mark top-level tracked variables so nested functions can treat captured signals as reactive
  for (const stmt of originalBody) {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (
          t.isIdentifier(decl.id) &&
          decl.init &&
          t.isCallExpression(decl.init) &&
          t.isIdentifier(decl.init.callee) &&
          decl.init.callee.name === '$state'
        ) {
          ctx.trackedVars.add(decl.id.name)
        }
      }
    }
  }
  const ensureTopLevelCtx = () => {
    if (topLevelCtxInjected) return
    ctx.helpersUsed.add('useContext')
    body.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('__fictCtx'),
          t.callExpression(t.identifier(RUNTIME_ALIASES.useContext), []),
        ),
      ]),
    )
    topLevelCtxInjected = true
  }

  // Map generated functions by name for replacement when walking original body
  const generatedFunctions = new Map<
    string,
    { fn: HIRFunction; stmt: BabelCore.types.FunctionDeclaration }
  >()
  for (const fn of program.functions) {
    const funcStmt = lowerFunctionWithRegions(fn, ctx)
    if (funcStmt && fn.name) {
      generatedFunctions.set(fn.name, { fn, stmt: funcStmt })
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

  // Rebuild program body preserving original order
  for (const stmt of originalBody as BabelCore.types.Statement[]) {
    if (t.isImportDeclaration(stmt)) {
      flushLowerableBuffer()
      body.push(stmt)
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
        // Split generated function declarations from remaining declarators
        const remainingDeclarators: typeof stmt.declaration.declarations = []
        const generated: { fn: HIRFunction; stmt: BabelCore.types.FunctionDeclaration }[] = []

        for (const decl of stmt.declaration.declarations) {
          if (t.isIdentifier(decl.id)) {
            const found = generatedFunctions.get(decl.id.name)
            if (found) {
              generated.push(found)
              generatedFunctions.delete(decl.id.name)
              continue
            }
          }
          remainingDeclarators.push(decl)
        }

        if (generated.length > 0) {
          flushLowerableBuffer()
          for (const entry of generated) {
            body.push(t.exportNamedDeclaration(entry.stmt, []))
            if (entry.stmt.id?.name) emittedFunctionNames.add(entry.stmt.id.name)
          }
          if (remainingDeclarators.length > 0) {
            body.push(
              t.exportNamedDeclaration(
                t.variableDeclaration(stmt.declaration.kind, remainingDeclarators),
                [],
              ),
            )
          }
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
      body.push(stmt)
      continue
    }

    if (t.isExportNamedDeclaration(stmt)) {
      flushLowerableBuffer()
      body.push(stmt)
      continue
    }

    // Export default function declaration
    if (t.isExportDefaultDeclaration(stmt) && t.isFunctionDeclaration(stmt.declaration)) {
      flushLowerableBuffer()
      const name = stmt.declaration.id?.name ?? '__default'
      const generated = generatedFunctions.get(name)
      if (generated) {
        body.push(t.exportDefaultDeclaration(generated.stmt))
        generatedFunctions.delete(name)
        emittedFunctionNames.add(name)
        continue
      }
      body.push(stmt)
      if (stmt.declaration.id?.name) emittedFunctionNames.add(stmt.declaration.id.name)
      continue
    }

    if (t.isExportDefaultDeclaration(stmt) || t.isExportAllDeclaration(stmt)) {
      flushLowerableBuffer()
      body.push(stmt)
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
            let arrowBody: BabelCore.types.BlockStatement | BabelCore.types.Expression =
              found.stmt.body
            if (found.fn.meta?.isArrow && t.isBlockStatement(found.stmt.body)) {
              const bodyStatements = found.stmt.body.body
              if (
                bodyStatements.length === 1 &&
                t.isReturnStatement(bodyStatements[0]) &&
                bodyStatements[0].argument
              ) {
                arrowBody = bodyStatements[0].argument
              }
            }
            const shouldUseArrow = !!(found.fn.meta?.isArrow && found.fn.meta?.hasExpressionBody)
            const funcExpr = found.fn.meta?.fromExpression
              ? found.fn.meta.isArrow
                ? shouldUseArrow
                  ? t.arrowFunctionExpression(found.stmt.params, arrowBody)
                  : t.functionExpression(
                      t.isIdentifier(decl.id) ? t.identifier(decl.id.name) : null,
                      found.stmt.params,
                      found.stmt.body,
                    )
                : t.functionExpression(null, found.stmt.params, found.stmt.body)
              : t.functionExpression(
                  found.stmt.id ? t.identifier(found.stmt.id.name) : null,
                  found.stmt.params,
                  found.stmt.body,
                  found.stmt.generator,
                  found.stmt.async,
                )
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

  // Emit any remaining generated functions (not present in original order)
  for (const func of generatedFunctions.values()) {
    body.push(func.stmt)
    if (func.stmt.id?.name) emittedFunctionNames.add(func.stmt.id.name)
  }

  return t.file(t.program(attachHelperImports(ctx, body, t)))
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

  const fn = convertStatementsToHIRFunction(name, statements)
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  detectDerivedCycles(fn, scopeResult)
  ctx.scopes = scopeResult

  const regionResult = generateRegions(fn, scopeResult)
  ctx.regions = flattenRegions(regionResult.topLevelRegions)
  const aliasVars = existingAliases ? new Set(existingAliases) : new Set<string>()
  ctx.aliasVars = aliasVars

  // Track region dependencies/declarations for reactive lookups
  if (ctx.regions) {
    for (const region of ctx.regions) {
      region.dependencies.forEach(dep => ctx.trackedVars.add(dep))
      region.declarations.forEach(decl => ctx.trackedVars.add(decl))
    }
  }

  // Mark tracked variables from scope analysis
  for (const scope of scopeResult.scopes) {
    if (scope.dependencies.size > 0) {
      for (const decl of scope.declarations) {
        ctx.trackedVars.add(deSSAVarName(decl))
      }
    }
  }

  // Track $state variables not captured in scopes
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' && instr.value.kind === 'CallExpression') {
        const call = instr.value
        if (call.callee.kind === 'Identifier' && call.callee.name === '$state') {
          ctx.trackedVars.add(deSSAVarName(instr.target.name))
        }
        // Track $store variables for path-level reactivity
        if (call.callee.kind === 'Identifier' && call.callee.name === '$store') {
          ctx.storeVars?.add(deSSAVarName(instr.target.name))
        }
      }
    }
  }

  const lowered = generateRegionCode(fn, scopeResult, t, ctx)
  return { statements: lowered, aliases: aliasVars }
}

/**
 * Lower a function with region-based code generation
 */
function lowerFunctionWithRegions(
  fn: HIRFunction,
  ctx: CodegenContext,
): BabelCore.types.FunctionDeclaration | null {
  const { t } = ctx
  const prevTracked = ctx.trackedVars
  const scopedTracked = new Set(ctx.trackedVars)
  const shadowedParams = new Set(fn.params.map(p => deSSAVarName(p.name)))
  fn.params.forEach(p => scopedTracked.delete(deSSAVarName(p.name)))
  ctx.trackedVars = scopedTracked
  const prevNeedsCtx = ctx.needsCtx
  ctx.needsCtx = false
  const prevShadowed = ctx.shadowedNames
  const functionShadowed = new Set(prevShadowed ?? [])
  shadowedParams.forEach(n => functionShadowed.add(n))
  ctx.shadowedNames = functionShadowed
  const prevExternalTracked = ctx.externalTracked
  const inheritedTracked = new Set(ctx.trackedVars)
  ctx.externalTracked = inheritedTracked
  // Always ensure context exists to support memo/region wrappers
  ctx.aliasVars = new Set()

  // Analyze reactive scopes with SSA/CFG awareness
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  detectDerivedCycles(fn, scopeResult)
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
    if (scope.dependencies.size > 0) {
      for (const decl of scope.declarations) {
        ctx.trackedVars.add(deSSAVarName(decl))
      }
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
        // Track $store variables for path-level reactivity
        if (call.callee.kind === 'Identifier' && call.callee.name === '$store') {
          ctx.storeVars?.add(deSSAVarName(instr.target.name))
        }
      }
    }
  }

  shadowedParams.forEach(n => ctx.trackedVars.delete(n))

  // Generate region-based statements
  const statements = generateRegionCode(fn, scopeResult, t, ctx)

  // Ensure context if signals/effects are used in experimental path
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

  // Handle props destructuring pattern for component functions
  // If first rawParam is ObjectPattern, emit __props and add destructuring
  let finalParams = fn.params.map(p => t.identifier(deSSAVarName(p.name)))
  const propsDestructuring: BabelCore.types.Statement[] = []

  const isComponent = fn.name && fn.name[0] === fn.name[0].toUpperCase()
  if (isComponent && fn.rawParams && fn.rawParams.length === 1) {
    const rawParam = fn.rawParams[0]
    // Check if it's an ObjectPattern or AssignmentPattern with ObjectPattern
    if (
      rawParam &&
      (rawParam.type === 'ObjectPattern' ||
        (rawParam.type === 'AssignmentPattern' && rawParam.left?.type === 'ObjectPattern'))
    ) {
      // Replace params with __props
      finalParams = [t.identifier('__props')]
      // Add destructuring statement at start of function
      const pattern = rawParam.type === 'AssignmentPattern' ? rawParam.left : rawParam
      propsDestructuring.push(
        t.variableDeclaration('const', [t.variableDeclarator(pattern, t.identifier('__props'))]),
      )
    }
  }

  // Add props destructuring before other statements
  if (propsDestructuring.length > 0) {
    statements.unshift(...propsDestructuring)
  }

  // De-version param names for clean output
  const params = finalParams
  const funcDecl = t.functionDeclaration(
    t.identifier(fn.name ?? 'fn'),
    params,
    t.blockStatement(statements),
  )
  ctx.needsCtx = prevNeedsCtx
  ctx.shadowedNames = prevShadowed
  ctx.trackedVars = prevTracked
  ctx.externalTracked = prevExternalTracked
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
