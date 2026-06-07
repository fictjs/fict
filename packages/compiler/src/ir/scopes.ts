import { extractDependencyPath, getSSABaseName, pathToString } from './hir'
import type { BlockId, DependencyPath, Expression, HIRFunction, Instruction } from './hir'
import { analyzeCFG } from './ssa'
/**
 * Get the base name of a variable, stripping any SSA version suffix.
 * Uses the centralized SSA naming utilities from hir.ts.
 */
function baseName(name: string): string {
  return getSSABaseName(name)
}

type BabelNodeLike = {
  type?: string
  [key: string]: unknown
}

function isBabelNodeLike(value: unknown): value is BabelNodeLike {
  return !!value && typeof value === 'object' && typeof (value as BabelNodeLike).type === 'string'
}

function isIgnoredBabelTraversalKey(key: string): boolean {
  return (
    key === 'type' ||
    key === 'loc' ||
    key === 'start' ||
    key === 'end' ||
    key === 'leadingComments' ||
    key === 'innerComments' ||
    key === 'trailingComments'
  )
}

function collectBabelPatternBindingNames(node: unknown, into: Set<string>): void {
  if (!isBabelNodeLike(node)) return
  switch (node.type) {
    case 'Identifier':
      if (typeof node.name === 'string') into.add(baseName(node.name))
      return
    case 'RestElement':
      collectBabelPatternBindingNames(node.argument, into)
      return
    case 'AssignmentPattern':
      collectBabelPatternBindingNames(node.left, into)
      return
    case 'ArrayPattern':
      ;(Array.isArray(node.elements) ? node.elements : []).forEach(element =>
        collectBabelPatternBindingNames(element, into),
      )
      return
    case 'ObjectPattern':
      ;(Array.isArray(node.properties) ? node.properties : []).forEach(prop => {
        if (!isBabelNodeLike(prop)) return
        if (prop.type === 'ObjectProperty') {
          collectBabelPatternBindingNames(prop.value, into)
        } else if (prop.type === 'RestElement') {
          collectBabelPatternBindingNames(prop.argument, into)
        }
      })
      return
    case 'TSParameterProperty':
      collectBabelPatternBindingNames(node.parameter, into)
      return
    default:
      return
  }
}

function collectBabelStatementBindingNames(node: unknown, into: Set<string>): void {
  if (!isBabelNodeLike(node)) return
  switch (node.type) {
    case 'VariableDeclaration':
      ;(Array.isArray(node.declarations) ? node.declarations : []).forEach(decl => {
        if (isBabelNodeLike(decl)) collectBabelPatternBindingNames(decl.id, into)
      })
      return
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      if (isBabelNodeLike(node.id) && node.id.type === 'Identifier') {
        collectBabelPatternBindingNames(node.id, into)
      }
      return
    default:
      return
  }
}

function getBabelStaticPropertyName(node: unknown): string | null {
  if (!isBabelNodeLike(node)) return null
  switch (node.type) {
    case 'Identifier':
      return typeof node.name === 'string' ? node.name : null
    case 'StringLiteral':
      return typeof node.value === 'string' ? node.value : null
    case 'NumericLiteral':
      return typeof node.value === 'number' ? String(node.value) : null
    case 'BigIntLiteral':
      return typeof node.value === 'string' ? node.value : null
    default:
      return null
  }
}

function extractBabelDependencyPath(node: unknown): DependencyPath | null {
  if (!isBabelNodeLike(node)) return null
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    return { base: node.name, segments: [], hasOptional: false }
  }
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
    return null
  }

  const segments: DependencyPath['segments'] = []
  let hasOptional = false
  let current: unknown = node
  while (
    isBabelNodeLike(current) &&
    (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression')
  ) {
    const propertyName = getBabelStaticPropertyName(current.property)
    if (!propertyName) return null
    const optional = current.type === 'OptionalMemberExpression' && current.optional === true
    segments.unshift({
      property: propertyName,
      optional,
      computed: current.computed === true,
    })
    if (optional) hasOptional = true
    current = current.object
  }

  if (
    !isBabelNodeLike(current) ||
    current.type !== 'Identifier' ||
    typeof current.name !== 'string'
  ) {
    return null
  }
  return { base: current.name, segments, hasOptional }
}

function collectBabelReadIdentifier(
  name: unknown,
  into: Set<string>,
  paths: Map<string, DependencyPath[]> | undefined,
  bound: Set<string>,
): void {
  if (typeof name !== 'string') return
  if (bound.has(baseName(name))) return
  into.add(name)
  if (paths) addPath(paths, name, { base: name, segments: [], hasOptional: false })
}

function collectBabelMemberReads(
  node: BabelNodeLike,
  into: Set<string>,
  paths: Map<string, DependencyPath[]> | undefined,
  bound: Set<string>,
): void {
  const depPath = extractBabelDependencyPath(node)
  if (depPath) {
    if (bound.has(baseName(depPath.base))) return
    into.add(depPath.base)
    if (paths) addPath(paths, depPath.base, depPath)
    return
  }

  collectBabelDefinitionReads(node.object, into, paths, bound)
  if (node.computed) collectBabelDefinitionReads(node.property, into, paths, bound)
}

function collectBabelAssignmentTargetReads(
  node: unknown,
  into: Set<string>,
  paths: Map<string, DependencyPath[]> | undefined,
  bound: Set<string>,
): void {
  if (!isBabelNodeLike(node)) return
  switch (node.type) {
    case 'Identifier':
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectBabelDefinitionReads(node.object, into, paths, bound)
      if (node.computed) collectBabelDefinitionReads(node.property, into, paths, bound)
      return
    case 'ObjectPattern':
      ;(Array.isArray(node.properties) ? node.properties : []).forEach(prop => {
        if (!isBabelNodeLike(prop)) return
        if (prop.type === 'ObjectProperty') {
          if (prop.computed) collectBabelDefinitionReads(prop.key, into, paths, bound)
          collectBabelAssignmentTargetReads(prop.value, into, paths, bound)
        } else if (prop.type === 'RestElement') {
          collectBabelAssignmentTargetReads(prop.argument, into, paths, bound)
        }
      })
      return
    case 'ArrayPattern':
      ;(Array.isArray(node.elements) ? node.elements : []).forEach(element =>
        collectBabelAssignmentTargetReads(element, into, paths, bound),
      )
      return
    case 'AssignmentPattern':
      collectBabelAssignmentTargetReads(node.left, into, paths, bound)
      collectBabelDefinitionReads(node.right, into, paths, bound)
      return
    case 'RestElement':
      collectBabelAssignmentTargetReads(node.argument, into, paths, bound)
      return
    default:
      collectBabelDefinitionReads(node, into, paths, bound)
  }
}

function collectBabelStatementListReads(
  statements: unknown,
  into: Set<string>,
  paths: Map<string, DependencyPath[]> | undefined,
  bound: Set<string>,
): void {
  const items = Array.isArray(statements) ? statements : []
  const blockBound = new Set(bound)
  items.forEach(stmt => collectBabelStatementBindingNames(stmt, blockBound))
  items.forEach(stmt => collectBabelDefinitionReads(stmt, into, paths, blockBound))
}

function collectBabelClassMemberDefinitionReads(
  member: unknown,
  into: Set<string>,
  paths: Map<string, DependencyPath[]> | undefined,
  bound: Set<string>,
): void {
  if (Array.isArray(member)) {
    member.forEach(item => collectBabelClassMemberDefinitionReads(item, into, paths, bound))
    return
  }
  if (!isBabelNodeLike(member)) return
  switch (member.type) {
    case 'ClassMethod':
    case 'ClassPrivateMethod':
      collectBabelDefinitionReads(member.decorators, into, paths, bound)
      if (member.computed) collectBabelDefinitionReads(member.key, into, paths, bound)
      return
    case 'ClassProperty':
    case 'ClassPrivateProperty':
    case 'ClassAccessorProperty':
      collectBabelDefinitionReads(member.decorators, into, paths, bound)
      if (member.computed) collectBabelDefinitionReads(member.key, into, paths, bound)
      if (member.static) collectBabelDefinitionReads(member.value, into, paths, bound)
      return
    case 'StaticBlock':
      collectBabelStatementListReads(member.body, into, paths, bound)
      return
    default:
      collectBabelDefinitionReads(member, into, paths, bound)
  }
}

function collectBabelClassLikeDefinitionReads(
  node: BabelNodeLike,
  into: Set<string>,
  paths: Map<string, DependencyPath[]> | undefined,
  bound: Set<string>,
): void {
  collectBabelDefinitionReads(node.superClass, into, paths, bound)
  collectBabelDefinitionReads(node.decorators, into, paths, bound)
  const classBound = new Set(bound)
  if (
    isBabelNodeLike(node.id) &&
    node.id.type === 'Identifier' &&
    typeof node.id.name === 'string'
  ) {
    classBound.add(baseName(node.id.name))
  }
  if (isBabelNodeLike(node.body)) {
    collectBabelClassMemberDefinitionReads(node.body.body, into, paths, classBound)
  }
}

function collectBabelDefinitionReads(
  node: unknown,
  into: Set<string>,
  paths: Map<string, DependencyPath[]> | undefined,
  bound: Set<string>,
): void {
  if (Array.isArray(node)) {
    node.forEach(item => collectBabelDefinitionReads(item, into, paths, bound))
    return
  }
  if (!isBabelNodeLike(node)) return

  switch (node.type) {
    case 'Identifier':
      collectBabelReadIdentifier(node.name, into, paths, bound)
      return
    case 'PrivateName':
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'RegExpLiteral':
    case 'ThisExpression':
    case 'Super':
    case 'MetaProperty':
      return
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ObjectMethod':
      return
    case 'Decorator':
      collectBabelDefinitionReads(node.expression, into, paths, bound)
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectBabelMemberReads(node, into, paths, bound)
      return
    case 'CallExpression':
    case 'OptionalCallExpression':
      collectBabelDefinitionReads(node.callee, into, paths, bound)
      collectBabelDefinitionReads(node.arguments, into, paths, bound)
      return
    case 'NewExpression':
      collectBabelDefinitionReads(node.callee, into, paths, bound)
      collectBabelDefinitionReads(node.arguments, into, paths, bound)
      return
    case 'ImportExpression':
      collectBabelDefinitionReads(node.source, into, paths, bound)
      collectBabelDefinitionReads(node.options, into, paths, bound)
      return
    case 'AssignmentExpression':
      collectBabelAssignmentTargetReads(node.left, into, paths, bound)
      collectBabelDefinitionReads(node.right, into, paths, bound)
      return
    case 'UpdateExpression':
      collectBabelDefinitionReads(node.argument, into, paths, bound)
      return
    case 'VariableDeclaration':
      collectBabelStatementListReads(node.declarations, into, paths, bound)
      return
    case 'VariableDeclarator':
      collectBabelDefinitionReads(node.init, into, paths, bound)
      return
    case 'ExpressionStatement':
      collectBabelDefinitionReads(node.expression, into, paths, bound)
      return
    case 'BlockStatement':
      collectBabelStatementListReads(node.body, into, paths, bound)
      return
    case 'ReturnStatement':
    case 'ThrowStatement':
      collectBabelDefinitionReads(node.argument, into, paths, bound)
      return
    case 'IfStatement':
      collectBabelDefinitionReads(node.test, into, paths, bound)
      collectBabelDefinitionReads(node.consequent, into, paths, bound)
      collectBabelDefinitionReads(node.alternate, into, paths, bound)
      return
    case 'ForOfStatement':
      collectBabelDefinitionReads(node.right, into, paths, bound)
      collectBabelDefinitionReads(node.body, into, paths, bound)
      return
    case 'ForInStatement':
      collectBabelDefinitionReads(node.right, into, paths, bound)
      collectBabelDefinitionReads(node.body, into, paths, bound)
      return
    case 'ObjectExpression':
      collectBabelDefinitionReads(node.properties, into, paths, bound)
      return
    case 'ObjectProperty':
      if (node.computed) collectBabelDefinitionReads(node.key, into, paths, bound)
      collectBabelDefinitionReads(node.value, into, paths, bound)
      return
    case 'ArrayExpression':
      collectBabelDefinitionReads(node.elements, into, paths, bound)
      return
    case 'BinaryExpression':
    case 'LogicalExpression':
      collectBabelDefinitionReads(node.left, into, paths, bound)
      collectBabelDefinitionReads(node.right, into, paths, bound)
      return
    case 'UnaryExpression':
    case 'AwaitExpression':
      collectBabelDefinitionReads(node.argument, into, paths, bound)
      return
    case 'YieldExpression':
      collectBabelDefinitionReads(node.argument, into, paths, bound)
      return
    case 'ConditionalExpression':
      collectBabelDefinitionReads(node.test, into, paths, bound)
      collectBabelDefinitionReads(node.consequent, into, paths, bound)
      collectBabelDefinitionReads(node.alternate, into, paths, bound)
      return
    case 'SequenceExpression':
      collectBabelDefinitionReads(node.expressions, into, paths, bound)
      return
    case 'TemplateLiteral':
      collectBabelDefinitionReads(node.expressions, into, paths, bound)
      return
    case 'TaggedTemplateExpression':
      collectBabelDefinitionReads(node.tag, into, paths, bound)
      collectBabelDefinitionReads(node.quasi, into, paths, bound)
      return
    case 'ClassExpression':
    case 'ClassDeclaration':
      collectBabelClassLikeDefinitionReads(node, into, paths, bound)
      return
    case 'ClassMethod':
    case 'ClassPrivateMethod':
    case 'ClassProperty':
    case 'ClassPrivateProperty':
    case 'ClassAccessorProperty':
    case 'StaticBlock':
      collectBabelClassMemberDefinitionReads(node, into, paths, bound)
      return
    default:
      for (const [key, value] of Object.entries(node)) {
        if (!isIgnoredBabelTraversalKey(key)) {
          collectBabelDefinitionReads(value, into, paths, bound)
        }
      }
  }
}

/**
 * Analysis result for control flow reads.
 * Distinguishes reads in condition positions (if/while tests) from pure expression reads.
 * This drives the decision between re-executing blocks vs updating bindings.
 */
export interface ControlFlowReadAnalysis {
  /** Variables read in control flow conditions (if tests, while tests, switch discriminants) */
  controlFlowReads: Set<string>
  /** Variables read only in pure expression positions (assignments, return values) */
  expressionOnlyReads: Set<string>
  /** Variables read in both positions */
  mixedReads: Set<string>
  /** Whether the function has reactive control flow (conditions depend on reactive vars) */
  hasReactiveControlFlow: boolean
}

export interface ReactiveScope {
  id: number
  declarations: Set<string>
  writes: Set<string>
  reads: Set<string>
  blocks: Set<number>
  /** Dependencies: variables this scope depends on */
  dependencies: Set<string>
  /** Detailed dependency paths (for optional chain analysis) */
  dependencyPaths: Map<string, DependencyPath[]>
  /** Whether this scope has external effects (escapes) */
  hasExternalEffect: boolean
  /** Whether this scope should be memoized */
  shouldMemoize: boolean
  /** Merged scope IDs (for tracking) */
  mergedFrom?: Set<number>
}

export interface ReactiveScopeResult {
  scopes: ReactiveScope[]
  byName: Map<string, ReactiveScope>
  /** Map of variable to its defining scope */
  definitionScope: Map<string, ReactiveScope>
  /** Variables that escape to external contexts (return, props, etc.) */
  escapingVars: Set<string>
}

/**
 * Experimental reactive scope analysis (CFG-aware):
 * - Tracks per-variable scopes across blocks that write the same variable.
 * - Collects reads/writes and block membership.
 * - Calculates dependencies between scopes.
 * - Determines which scopes have external effects.
 * - Supports scope merging and pruning.
 */
export function analyzeReactiveScopes(fn: HIRFunction): ReactiveScopeResult {
  const scopes: ReactiveScope[] = []
  const byName = new Map<string, ReactiveScope>()
  const definitionScope = new Map<string, ReactiveScope>()
  const entryBlockId = fn.blocks[0]?.id
  let nextId = 0

  const getScope = (name: string) => {
    let scope = byName.get(name)
    if (!scope) {
      scope = {
        id: nextId++,
        declarations: new Set([name]),
        writes: new Set(),
        reads: new Set(),
        blocks: new Set(),
        dependencies: new Set(),
        dependencyPaths: new Map(),
        hasExternalEffect: false,
        shouldMemoize: false,
      }
      byName.set(name, scope)
      scopes.push(scope)
    }
    return scope
  }

  // First pass: collect writes and reads with dependency paths
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const scope = getScope(instr.target.name)
        scope.writes.add(instr.target.name)
        scope.blocks.add(block.id)
        definitionScope.set(instr.target.name, scope)
        // Collect reads with dependency paths for optional chain analysis
        collectReads(instr, scope.reads, scope.dependencyPaths)
      } else if (instr.kind === 'Phi') {
        const scope = getScope(instr.target.name)
        scope.writes.add(instr.target.name)
        scope.blocks.add(block.id)
        definitionScope.set(instr.target.name, scope)
        instr.sources.forEach(s => scope.reads.add(s.id.name))
      } else {
        collectReads(instr, accumulateAllReads(byName))
      }
    }
  }

  // Detect escaping variables from return statements
  const escapingVars = new Set<string>()
  for (const block of fn.blocks) {
    const term = block.terminator
    if (term.kind === 'Return' && term.argument) {
      collectExprReads(term.argument, escapingVars, undefined, new Set(), true)
    }
  }
  propagateEscapingReads(scopes, escapingVars)

  // Second pass: calculate dependencies and external effects
  for (const scope of scopes) {
    for (const read of scope.reads) {
      // Only add as dependency if it's defined elsewhere
      if (!scope.declarations.has(read) && byName.has(read)) {
        scope.dependencies.add(read)
      }
    }

    // Check for external effects
    for (const decl of scope.declarations) {
      if (escapingVars.has(decl)) {
        scope.hasExternalEffect = true
        break
      }
    }
  }

  // Determine which scopes should be memoized
  for (const scope of scopes) {
    scope.shouldMemoize = shouldMemoizeScope(scope, byName, entryBlockId)
  }

  // Merge overlapping scopes
  const mergedScopes = mergeOverlappingScopes(scopes, byName)

  // Prune non-escaping scopes that have no dependencies
  const prunedScopes = pruneNonEscapingScopes(mergedScopes, escapingVars)

  // Rebuild byName map
  const finalByName = new Map<string, ReactiveScope>()
  for (const scope of prunedScopes) {
    for (const decl of scope.declarations) {
      finalByName.set(decl, scope)
    }
  }

  return { scopes: prunedScopes, byName: finalByName, definitionScope, escapingVars }
}

/**
 * Determine if a scope should be memoized based on its characteristics
 */
function shouldMemoizeScope(
  scope: ReactiveScope,
  byName: Map<string, ReactiveScope>,
  entryBlockId?: number,
): boolean {
  const touchesEntry = entryBlockId !== undefined && scope.blocks.has(entryBlockId)

  // Memoize if it has reactive dependencies
  if (scope.dependencies.size > 0) {
    for (const dep of scope.dependencies) {
      const depScope = byName.get(dep)
      if (
        depScope &&
        (depScope.writes.size > 0 || depScope.dependencies.size > 0) &&
        (scope.blocks.size > 1 || scope.hasExternalEffect || touchesEntry)
      ) {
        return true
      }
    }
  }

  // Memoize if it spans multiple blocks (likely has control flow)
  if (scope.blocks.size > 1) {
    return true
  }

  return false
}

function propagateEscapingReads(scopes: ReactiveScope[], escapingVars: Set<string>): void {
  let changed = true

  while (changed) {
    changed = false

    for (const scope of scopes) {
      const escapes = Array.from(scope.declarations).some(decl => escapingVars.has(decl))
      if (!escapes) continue

      for (const read of scope.reads) {
        if (!escapingVars.has(read)) {
          escapingVars.add(read)
          changed = true
        }
      }
    }
  }
}

/**
 * Merge scopes that invalidate together (share dependencies or co-mutate)
 */
function mergeOverlappingScopes(
  scopes: ReactiveScope[],
  _byName: Map<string, ReactiveScope>,
): ReactiveScope[] {
  // Use union-find for efficient merging
  const parent = new Map<number, number>()

  const find = (id: number): number => {
    if (!parent.has(id)) parent.set(id, id)
    if (parent.get(id) !== id) {
      parent.set(id, find(parent.get(id)!))
    }
    return parent.get(id)!
  }

  const union = (a: number, b: number) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) {
      parent.set(rootB, rootA)
    }
  }

  // Merge scopes that share blocks (co-mutation)
  const blockToScopes = new Map<number, ReactiveScope[]>()
  for (const scope of scopes) {
    for (const blockId of scope.blocks) {
      const list = blockToScopes.get(blockId) ?? []
      list.push(scope)
      blockToScopes.set(blockId, list)
    }
  }

  for (const [_, scopesInBlock] of blockToScopes) {
    if (scopesInBlock.length > 1) {
      const firstScope = scopesInBlock[0]
      if (!firstScope) continue
      for (let i = 1; i < scopesInBlock.length; i++) {
        const otherScope = scopesInBlock[i]
        if (!otherScope) continue
        // Preserve the established same-block merge behavior.
        const hasOverlap = hasOverlappingDependencies(firstScope, otherScope)
        if (hasOverlap) {
          union(firstScope.id, otherScope.id)
        }
      }

      for (let i = 0; i < scopesInBlock.length; i++) {
        const leftScope = scopesInBlock[i]
        if (!leftScope || !scopeIncludesDestructuringTemp(leftScope)) continue
        for (let j = 0; j < scopesInBlock.length; j++) {
          if (i === j) continue
          const rightScope = scopesInBlock[j]
          if (!rightScope) continue
          if (hasOverlappingDependencies(leftScope, rightScope)) {
            union(leftScope.id, rightScope.id)
          }
        }
      }
    }
  }

  // Group scopes by root
  const groups = new Map<number, ReactiveScope[]>()
  for (const scope of scopes) {
    const root = find(scope.id)
    const group = groups.get(root) ?? []
    group.push(scope)
    groups.set(root, group)
  }

  // Merge each group into single scope
  const mergedScopes: ReactiveScope[] = []
  for (const [rootId, group] of groups) {
    const firstInGroup = group[0]
    if (group.length === 1 && firstInGroup) {
      mergedScopes.push(firstInGroup)
    } else {
      const merged: ReactiveScope = {
        id: rootId,
        declarations: new Set(),
        writes: new Set(),
        reads: new Set(),
        blocks: new Set(),
        dependencies: new Set(),
        dependencyPaths: new Map(),
        hasExternalEffect: false,
        shouldMemoize: false,
        mergedFrom: new Set(group.map(s => s.id)),
      }

      for (const scope of group) {
        scope.declarations.forEach(d => merged.declarations.add(d))
        scope.writes.forEach(w => merged.writes.add(w))
        scope.reads.forEach(r => merged.reads.add(r))
        scope.blocks.forEach(b => merged.blocks.add(b))
        scope.dependencies.forEach(d => merged.dependencies.add(d))
        // Merge dependency paths
        for (const [base, paths] of scope.dependencyPaths) {
          for (const path of paths) {
            addPath(merged.dependencyPaths, base, path)
          }
        }
        merged.hasExternalEffect = merged.hasExternalEffect || scope.hasExternalEffect
        merged.shouldMemoize = merged.shouldMemoize || scope.shouldMemoize
      }

      // Remove internal dependencies (declarations within the merged scope)
      for (const decl of merged.declarations) {
        merged.dependencies.delete(decl)
      }

      mergedScopes.push(merged)
    }
  }

  return mergedScopes
}

/**
 * Check if two scopes have overlapping dependencies
 */
function hasOverlappingDependencies(a: ReactiveScope, b: ReactiveScope): boolean {
  for (const dep of a.dependencies) {
    if (b.dependencies.has(dep)) return true
  }
  for (const dep of b.dependencies) {
    if (a.dependencies.has(dep)) return true
  }
  // Also consider if one writes what the other reads
  for (const write of a.writes) {
    if (b.reads.has(write)) return true
  }
  for (const write of b.writes) {
    if (a.reads.has(write)) return true
  }
  return false
}

function scopeIncludesDestructuringTemp(scope: ReactiveScope): boolean {
  for (const name of scope.declarations) {
    if (isDestructuringTempName(name)) return true
  }
  for (const name of scope.writes) {
    if (isDestructuringTempName(name)) return true
  }
  return false
}

function isDestructuringTempName(name: string): boolean {
  const base = baseName(name)
  return base.startsWith('__destruct_') || /^_(?:[A-Za-z$][\w$]*|)$/.test(base)
}

/**
 * Prune scopes that don't escape and have no downstream effects
 */
function pruneNonEscapingScopes(
  scopes: ReactiveScope[],
  _escapingVars: Set<string>,
): ReactiveScope[] {
  // Build dependency graph (which scopes depend on which)
  const dependsOn = new Map<number, Set<number>>()
  const scopeById = new Map<number, ReactiveScope>()
  const declToScope = new Map<string, ReactiveScope>()

  for (const scope of scopes) {
    scopeById.set(scope.id, scope)
    for (const decl of scope.declarations) {
      declToScope.set(decl, scope)
    }
  }

  for (const scope of scopes) {
    const deps = new Set<number>()
    for (const dep of scope.dependencies) {
      const depScope = declToScope.get(dep)
      if (depScope && depScope.id !== scope.id) {
        deps.add(depScope.id)
      }
    }
    dependsOn.set(scope.id, deps)
  }

  // Find all scopes that are reachable from escaping scopes
  const reachable = new Set<number>()
  const queue: number[] = []

  // Start with scopes that have external effects
  for (const scope of scopes) {
    if (scope.hasExternalEffect) {
      reachable.add(scope.id)
      queue.push(scope.id)
    }
  }

  // BFS to find all scopes that contribute to escaping values
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const depId of dependsOn.get(current) ?? []) {
      if (!reachable.has(depId)) {
        reachable.add(depId)
        queue.push(depId)
      }
    }
  }

  // Keep scopes that are reachable or that we want to track for other reasons
  return scopes.filter(scope => {
    // Always keep if it has external effects
    if (scope.hasExternalEffect) return true

    // Keep if it contributes to an escaping value
    if (reachable.has(scope.id)) return true

    // Keep if it should be memoized (user may observe side effects)
    if (scope.shouldMemoize) return true

    // Prune otherwise
    return false
  })
}

function collectReads(
  instr: Instruction,
  into: Set<string>,
  paths?: Map<string, DependencyPath[]>,
  bound?: Set<string>,
) {
  if (instr.kind === 'Assign') {
    collectExprReads(instr.value, into, paths, bound)
  } else if (instr.kind === 'Expression') {
    collectExprReads(instr.value, into, paths, bound)
  }
}

function collectAssignmentTargetExprReads(
  expr: Expression | null | undefined,
  into: Set<string>,
  paths?: Map<string, DependencyPath[]>,
  bound = new Set<string>(),
) {
  if (!expr || typeof expr !== 'object') return
  switch (expr.kind) {
    case 'Identifier':
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectExprReads(expr.object, into, paths, bound)
      if (expr.computed) collectExprReads(expr.property, into, paths, bound)
      return
    default:
      collectExprReads(expr, into, paths, bound)
  }
}

function accumulateAllReads(byName: Map<string, ReactiveScope>): Set<string> {
  const set = new Set<string>()
  for (const scope of byName.values()) {
    scope.reads.forEach(r => set.add(r))
  }
  return set
}

function collectExprReads(
  expr: Expression | null | undefined,
  into: Set<string>,
  paths?: Map<string, DependencyPath[]>,
  bound = new Set<string>(),
  includeFunctionBodies = false,
) {
  if (!expr || typeof expr !== 'object') return
  switch (expr.kind) {
    case 'Identifier':
      if (bound.has(baseName(expr.name))) return
      into.add(expr.name)
      if (paths) {
        const path: DependencyPath = {
          base: expr.name,
          segments: [],
          hasOptional: false,
        }
        addPath(paths, expr.name, path)
      }
      return
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const isMacroCallee =
        expr.callee.kind === 'Identifier' &&
        (expr.callee.name === '$state' ||
          expr.callee.name === '$effect' ||
          expr.callee.name === '$store')

      if (!isMacroCallee) {
        collectExprReads(expr.callee, into, paths, bound)
      }

      expr.arguments?.forEach(arg => collectExprReads(arg, into, paths, bound))
      return
    }
    case 'ImportExpression':
      collectExprReads(expr.source, into, paths, bound)
      if (expr.options) collectExprReads(expr.options, into, paths, bound)
      return
    case 'SpreadElement':
      collectExprReads(expr.argument, into, paths, bound)
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      // Extract full dependency path for optional chain analysis
      const depPath = extractDependencyPath(expr)
      if (depPath) {
        if (bound.has(baseName(depPath.base))) return
        into.add(depPath.base)
        if (paths) {
          addPath(paths, depPath.base, depPath)
        }
      } else {
        // Fallback to simple collection
        collectExprReads(expr.object, into, paths, bound)
        if (expr.computed) {
          collectExprReads(expr.property, into, paths, bound)
        }
      }
      return
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      collectExprReads(expr.left, into, paths, bound)
      collectExprReads(expr.right, into, paths, bound)
      return
    case 'UnaryExpression':
      collectExprReads(expr.argument, into, paths, bound)
      return
    case 'AssignmentExpression':
      collectAssignmentTargetExprReads(expr.left, into, paths, bound)
      collectExprReads(expr.right, into, paths, bound)
      return
    case 'UpdateExpression':
      collectExprReads(expr.argument, into, paths, bound)
      return
    case 'ConditionalExpression':
      collectExprReads(expr.test, into, paths, bound)
      collectExprReads(expr.consequent, into, paths, bound)
      collectExprReads(expr.alternate, into, paths, bound)
      return
    case 'SequenceExpression':
      expr.expressions.forEach(item => collectExprReads(item, into, paths, bound))
      return
    case 'TemplateLiteral':
      expr.expressions.forEach(item => collectExprReads(item, into, paths, bound))
      return
    case 'TaggedTemplateExpression':
      collectExprReads(expr.tag, into, paths, bound)
      collectExprReads(expr.quasi, into, paths, bound)
      return
    case 'AwaitExpression':
      collectExprReads(expr.argument, into, paths, bound)
      return
    case 'YieldExpression':
      if (expr.argument) collectExprReads(expr.argument, into, paths, bound)
      return
    case 'NewExpression':
      collectExprReads(expr.callee, into, paths, bound)
      expr.arguments.forEach(arg => collectExprReads(arg, into, paths, bound))
      return
    case 'ArrayExpression':
      expr.elements?.forEach(element => collectExprReads(element, into, paths, bound))
      return
    case 'ObjectExpression':
      expr.properties?.forEach(property => {
        if (property.kind === 'SpreadElement') {
          collectExprReads(property.argument, into, paths, bound)
          return
        }

        // Only collect computed keys; static keys are not dependencies
        if (property.computed) {
          collectExprReads(property.key, into, paths, bound)
        }

        collectExprReads(property.value, into, paths, bound)
      })
      return
    case 'ArrowFunction': {
      if (!includeFunctionBodies) return
      const nextBound = new Set(bound)
      expr.params?.forEach(param => nextBound.add(baseName(param.name)))
      if (expr.isExpression && expr.body && !Array.isArray(expr.body)) {
        collectExprReads(expr.body, into, paths, nextBound, includeFunctionBodies)
      } else if (Array.isArray(expr.body)) {
        for (const block of expr.body) {
          for (const instr of block.instructions) {
            if (instr.kind === 'Assign') {
              collectExprReads(instr.value, into, paths, nextBound, includeFunctionBodies)
            } else if (instr.kind === 'Expression') {
              collectExprReads(instr.value, into, paths, nextBound, includeFunctionBodies)
            } else if (instr.kind === 'Phi') {
              instr.sources.forEach(src => {
                if (!nextBound.has(baseName(src.id.name))) {
                  into.add(src.id.name)
                }
              })
            }
          }
          const term = block.terminator
          if (term.kind === 'Branch') {
            collectExprReads(term.test, into, paths, nextBound, includeFunctionBodies)
          } else if (term.kind === 'Switch') {
            collectExprReads(term.discriminant, into, paths, nextBound, includeFunctionBodies)
            term.cases.forEach(caseItem => {
              if (caseItem.test) {
                collectExprReads(caseItem.test, into, paths, nextBound, includeFunctionBodies)
              }
            })
          } else if (term.kind === 'ForOf') {
            collectExprReads(term.iterable, into, paths, nextBound, includeFunctionBodies)
          } else if (term.kind === 'ForIn') {
            collectExprReads(term.object, into, paths, nextBound, includeFunctionBodies)
          } else if (term.kind === 'Return' && term.argument) {
            collectExprReads(term.argument, into, paths, nextBound, includeFunctionBodies)
          } else if (term.kind === 'Throw') {
            collectExprReads(term.argument, into, paths, nextBound, includeFunctionBodies)
          }
        }
      }
      return
    }
    case 'FunctionExpression': {
      if (!includeFunctionBodies) return
      const nextBound = new Set(bound)
      expr.params?.forEach(param => nextBound.add(baseName(param.name)))
      for (const block of expr.body ?? []) {
        for (const instr of block.instructions) {
          if (instr.kind === 'Assign') {
            collectExprReads(instr.value, into, paths, nextBound, includeFunctionBodies)
          } else if (instr.kind === 'Expression') {
            collectExprReads(instr.value, into, paths, nextBound, includeFunctionBodies)
          } else if (instr.kind === 'Phi') {
            instr.sources.forEach(src => {
              if (!nextBound.has(baseName(src.id.name))) {
                into.add(src.id.name)
              }
            })
          }
        }
        const term = block.terminator
        if (term.kind === 'Branch') {
          collectExprReads(term.test, into, paths, nextBound, includeFunctionBodies)
        } else if (term.kind === 'Switch') {
          collectExprReads(term.discriminant, into, paths, nextBound, includeFunctionBodies)
          term.cases.forEach(caseItem => {
            if (caseItem.test) {
              collectExprReads(caseItem.test, into, paths, nextBound, includeFunctionBodies)
            }
          })
        } else if (term.kind === 'ForOf') {
          collectExprReads(term.iterable, into, paths, nextBound, includeFunctionBodies)
        } else if (term.kind === 'ForIn') {
          collectExprReads(term.object, into, paths, nextBound, includeFunctionBodies)
        } else if (term.kind === 'Return' && term.argument) {
          collectExprReads(term.argument, into, paths, nextBound, includeFunctionBodies)
        } else if (term.kind === 'Throw') {
          collectExprReads(term.argument, into, paths, nextBound, includeFunctionBodies)
        }
      }
      return
    }
    case 'ClassExpression': {
      collectExprReads(expr.superClass, into, paths, bound)
      collectBabelDefinitionReads(expr.decorators, into, paths, bound)
      const classBound = new Set(bound)
      if (expr.name) classBound.add(baseName(expr.name))
      collectBabelClassMemberDefinitionReads(expr.body, into, paths, classBound)
      return
    }
    case 'JSXElement':
      // Collect from JSX attributes and children
      expr.attributes?.forEach(attr => {
        if (attr.value) collectExprReads(attr.value, into, paths, bound)
        if (attr.spreadExpr) collectExprReads(attr.spreadExpr, into, paths, bound)
      })
      expr.children?.forEach(child => {
        if (child.kind === 'expression') collectExprReads(child.value, into, paths, bound)
        if (child.kind === 'element') collectExprReads(child.value, into, paths, bound)
      })
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

/**
 * Add a dependency path to the paths map
 */
function addPath(paths: Map<string, DependencyPath[]>, base: string, path: DependencyPath) {
  const existing = paths.get(base) ?? []
  // Avoid duplicates
  const pathStr = pathToString(path)
  if (!existing.some(p => pathToString(p) === pathStr)) {
    existing.push(path)
    paths.set(base, existing)
  }
}

/**
 * Analysis result for optional chain subscriptions.
 * Determines which parts of a dependency path need reactive subscriptions.
 */
export interface OptionalChainAnalysis {
  /** Base variables that need subscription (always accessed) */
  requiredSubscriptions: Set<string>
  /** Base variables that are optional-only (can short-circuit) */
  optionalOnlySubscriptions: Set<string>
  /** Paths that can be statically analyzed vs needing runtime checks */
  staticPaths: Map<string, DependencyPath[]>
  /** Paths that need runtime short-circuit evaluation */
  runtimePaths: Map<string, DependencyPath[]>
}

/**
 * Analyze optional chain dependencies to determine subscription strategy.
 *
 * For paths like `a?.b?.c`:
 * - If 'a' can be null/undefined, we only need to subscribe to 'a'
 * - The rest of the path is guarded by the optional chain
 *
 * For paths like `a.b?.c`:
 * - We need to subscribe to 'a' (required)
 * - 'b' is optional-only
 */
export function analyzeOptionalChainDependencies(scope: ReactiveScope): OptionalChainAnalysis {
  const result: OptionalChainAnalysis = {
    requiredSubscriptions: new Set(),
    optionalOnlySubscriptions: new Set(),
    staticPaths: new Map(),
    runtimePaths: new Map(),
  }

  for (const [base, paths] of scope.dependencyPaths) {
    // Check if any path from this base has optional segments
    const hasOptional = paths.some(p => p.hasOptional)

    if (!hasOptional) {
      // All paths are required - subscribe to base
      result.requiredSubscriptions.add(base)
      result.staticPaths.set(base, paths)
    } else {
      // Analyze each path
      let hasRequiredPath = false
      let hasOptionalOnlyPath = false

      for (const path of paths) {
        if (!path.hasOptional) {
          // This path has no optional segments - required
          hasRequiredPath = true
        } else {
          // Check if first segment is optional
          const firstOptionalIndex = path.segments.findIndex(s => s.optional)
          if (firstOptionalIndex === 0) {
            // First access is optional - entire path can short-circuit
            hasOptionalOnlyPath = true
          } else if (firstOptionalIndex > 0) {
            // Some prefix is required, rest is optional
            hasRequiredPath = true
          }
        }
      }

      if (hasRequiredPath) {
        result.requiredSubscriptions.add(base)
        // Separate static and runtime paths
        const staticPaths = paths.filter(p => !p.hasOptional)
        const runtimePaths = paths.filter(p => p.hasOptional)
        if (staticPaths.length > 0) result.staticPaths.set(base, staticPaths)
        if (runtimePaths.length > 0) result.runtimePaths.set(base, runtimePaths)
      } else if (hasOptionalOnlyPath) {
        result.optionalOnlySubscriptions.add(base)
        result.runtimePaths.set(base, paths)
      }
    }
  }

  return result
}

/**
 * Get the minimal subscription set for a scope.
 * This determines which variables actually need to trigger re-computation.
 */
export function getMinimalSubscriptionSet(scope: ReactiveScope): Set<string> {
  const analysis = analyzeOptionalChainDependencies(scope)

  // Required subscriptions always need to be tracked
  const subscriptions = new Set(analysis.requiredSubscriptions)

  // For optional-only subscriptions, we still need to track the base
  // but the runtime can short-circuit evaluation
  for (const base of analysis.optionalOnlySubscriptions) {
    subscriptions.add(base)
  }

  return subscriptions
}

/**
 * Generate a dependency tracking expression for a scope.
 * Returns the variables that should be passed to useMemo dependencies.
 */
export function getScopeDependencies(scope: ReactiveScope): string[] {
  const minSet = getMinimalSubscriptionSet(scope)
  return Array.from(minSet).sort()
}

/**
 * Analyze control flow reads in an HIR function.
 * Distinguishes reads in condition positions from pure expression reads.
 */
export function analyzeControlFlowReads(
  fn: HIRFunction,
  reactiveVars?: Set<string>,
): ControlFlowReadAnalysis {
  const controlFlowReads = new Set<string>()
  const expressionReads = new Set<string>()

  // Collect reads from all blocks
  for (const block of fn.blocks) {
    // Expression reads: from instructions
    for (const instr of block.instructions) {
      collectExprReads(
        instr.kind === 'Assign' ? instr.value : instr.kind === 'Expression' ? instr.value : null,
        expressionReads,
      )
    }

    // Control flow reads: from terminator conditions
    const term = block.terminator
    if (term.kind === 'Branch' && term.test) {
      collectExprReads(term.test, controlFlowReads)
    } else if (term.kind === 'Switch' && term.discriminant) {
      collectExprReads(term.discriminant, controlFlowReads)
    } else if (term.kind === 'ForOf' && term.iterable) {
      // ForOf iterable is a control flow read - changes to iterable affect loop execution
      collectExprReads(term.iterable, controlFlowReads)
      if (term.assignmentTarget) collectExprReads(term.assignmentTarget, controlFlowReads)
    } else if (term.kind === 'ForIn' && term.object) {
      // ForIn object is a control flow read - changes to object affect loop execution
      collectExprReads(term.object, controlFlowReads)
      if (term.assignmentTarget) collectExprReads(term.assignmentTarget, controlFlowReads)
    }
    // Return/Throw arguments are expression reads
    if (term.kind === 'Return' && term.argument) {
      collectExprReads(term.argument, expressionReads)
    } else if (term.kind === 'Throw' && term.argument) {
      collectExprReads(term.argument, expressionReads)
    }
  }

  // Categorize reads
  const expressionOnlyReads = new Set<string>()
  const mixedReads = new Set<string>()

  for (const name of expressionReads) {
    if (controlFlowReads.has(name)) {
      mixedReads.add(name)
    } else {
      expressionOnlyReads.add(name)
    }
  }

  // Remove mixed reads from control flow set
  const pureControlFlowReads = new Set<string>()
  for (const name of controlFlowReads) {
    if (!expressionReads.has(name)) {
      pureControlFlowReads.add(name)
    }
  }

  // Determine if there's reactive control flow
  let hasReactiveControlFlow = false
  if (reactiveVars) {
    for (const name of controlFlowReads) {
      if (reactiveVars.has(name)) {
        hasReactiveControlFlow = true
        break
      }
    }
  }

  return {
    controlFlowReads: pureControlFlowReads,
    expressionOnlyReads,
    mixedReads,
    hasReactiveControlFlow,
  }
}

/**
 * Check if a variable requires re-execution when changed.
 * Variables used in control flow conditions require re-execution.
 * Variables only used in expressions can use binding updates.
 */
export function requiresReExecution(varName: string, analysis: ControlFlowReadAnalysis): boolean {
  return analysis.controlFlowReads.has(varName) || analysis.mixedReads.has(varName)
}

/**
 * Get the optimal update strategy for a reactive scope.
 */
export interface UpdateStrategy {
  /** Variables that require full scope re-execution */
  reExecuteOn: Set<string>
  /** Variables that can use binding updates */
  bindingUpdateOn: Set<string>
}

export function getUpdateStrategy(
  scope: ReactiveScope,
  controlFlowAnalysis: ControlFlowReadAnalysis,
): UpdateStrategy {
  const reExecuteOn = new Set<string>()
  const bindingUpdateOn = new Set<string>()

  for (const dep of scope.dependencies) {
    if (requiresReExecution(dep, controlFlowAnalysis)) {
      reExecuteOn.add(dep)
    } else {
      bindingUpdateOn.add(dep)
    }
  }

  return { reExecuteOn, bindingUpdateOn }
}

// ============================================================================
// SSA-Enhanced Reactive Scope Analysis
// ============================================================================

/**
 * Enhanced scope result with SSA/CFG information
 */
export interface SSAEnhancedScopeResult extends ReactiveScopeResult {
  /** CFG analysis results */
  cfgAnalysis: {
    /** Loop headers identified in the function */
    loopHeaders: Set<BlockId>
    /** Back-edges in the CFG (source->target format) */
    backEdges: Set<string>
    /** Dominance information */
    dominatorTree: {
      idom: Map<BlockId, BlockId>
      children: Map<BlockId, BlockId[]>
    }
  }
  /** Control flow read analysis */
  controlFlowAnalysis: ControlFlowReadAnalysis
  /** Scopes that are inside loops */
  loopDependentScopes: Set<number>
}

/**
 * Analyze reactive scopes with SSA/CFG awareness.
 * Provides enhanced information for better code generation decisions.
 */
export function analyzeReactiveScopesWithSSA(fn: HIRFunction): SSAEnhancedScopeResult {
  // Get basic scope analysis
  const baseResult = analyzeReactiveScopes(fn)

  // Get CFG analysis
  const cfgAnalysis = analyzeCFG(fn.blocks)

  // Get control flow read analysis
  const controlFlowAnalysis = analyzeControlFlowReads(fn)

  // Identify scopes that are inside loops
  const loopDependentScopes = new Set<number>()

  for (const scope of baseResult.scopes) {
    // Check if any block in this scope is dominated by a loop header
    for (const blockId of scope.blocks) {
      if (isInLoop(blockId, cfgAnalysis.loopHeaders, cfgAnalysis.dominatorTree.idom)) {
        loopDependentScopes.add(scope.id)
        break
      }
    }
  }

  return {
    ...baseResult,
    cfgAnalysis: {
      loopHeaders: cfgAnalysis.loopHeaders,
      backEdges: cfgAnalysis.backEdges,
      dominatorTree: cfgAnalysis.dominatorTree,
    },
    controlFlowAnalysis,
    loopDependentScopes,
  }
}

/**
 * Check if a block is inside a loop (dominated by a loop header)
 */
function isInLoop(
  blockId: BlockId,
  loopHeaders: Set<BlockId>,
  idom: Map<BlockId, BlockId>,
): boolean {
  // Walk up the dominator tree
  let current: BlockId | undefined = blockId
  while (current !== undefined) {
    if (loopHeaders.has(current)) {
      return true
    }
    const parent = idom.get(current)
    if (parent === current || parent === undefined) {
      break
    }
    current = parent
  }
  return false
}

/**
 * Get scopes that need special handling due to loop dependencies.
 * Loop-dependent scopes may need versioned memoization.
 */
export function getLoopDependentScopes(result: SSAEnhancedScopeResult): ReactiveScope[] {
  return result.scopes.filter(s => result.loopDependentScopes.has(s.id))
}

/**
 * Determine if a scope needs versioned memoization (for loops).
 */
export function needsVersionedMemo(scope: ReactiveScope, result: SSAEnhancedScopeResult): boolean {
  // Scope inside loop with dependencies = needs versioning
  if (result.loopDependentScopes.has(scope.id) && scope.dependencies.size > 0) {
    return true
  }
  return false
}
