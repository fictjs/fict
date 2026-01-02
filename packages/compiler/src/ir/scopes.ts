import type { BlockId, HIRFunction, Instruction, DependencyPath } from './hir'
import { extractDependencyPath, pathToString, getSSABaseName } from './hir'

/**
 * Get the base name of a variable, stripping any SSA version suffix.
 * Uses the centralized SSA naming utilities from hir.ts.
 */
function baseName(name: string): string {
  return getSSABaseName(name)
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
    scope.shouldMemoize = shouldMemoizeScope(scope, byName)
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
function shouldMemoizeScope(scope: ReactiveScope, byName: Map<string, ReactiveScope>): boolean {
  // Memoize if it has reactive dependencies
  if (scope.dependencies.size > 0) {
    for (const dep of scope.dependencies) {
      const depScope = byName.get(dep)
      if (depScope && (depScope.writes.size > 0 || depScope.dependencies.size > 0)) {
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
        // Only merge if they have overlapping dependencies
        const hasOverlap = hasOverlappingDependencies(firstScope, otherScope)
        if (hasOverlap) {
          union(firstScope.id, otherScope.id)
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
    collectExprReads(instr.value as any, into, paths, bound)
  } else if (instr.kind === 'Expression') {
    collectExprReads(instr.value as any, into, paths, bound)
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
  expr: any,
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
    case 'CallExpression': {
      const isMacroCallee =
        expr.callee.kind === 'Identifier' &&
        (expr.callee.name === '$state' ||
          expr.callee.name === '$effect' ||
          expr.callee.name === '$store')

      if (!isMacroCallee) {
        collectExprReads(expr.callee, into, paths, bound)
      }

      expr.arguments?.forEach((a: any) => collectExprReads(a, into, paths, bound))
      return
    }
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
    case 'ConditionalExpression':
      collectExprReads(expr.test, into, paths, bound)
      collectExprReads(expr.consequent, into, paths, bound)
      collectExprReads(expr.alternate, into, paths, bound)
      return
    case 'ArrayExpression':
      expr.elements?.forEach((el: any) => collectExprReads(el, into, paths, bound))
      return
    case 'ObjectExpression':
      expr.properties?.forEach((p: any) => {
        if (p.kind === 'SpreadElement') {
          collectExprReads(p.argument, into, paths, bound)
          return
        }

        // Only collect computed keys; static keys are not dependencies
        if (p.computed) {
          collectExprReads(p.key, into, paths, bound)
        }

        collectExprReads(p.value, into, paths, bound)
      })
      return
    case 'ArrowFunction': {
      if (!includeFunctionBodies) return
      const nextBound = new Set(bound)
      expr.params?.forEach((p: any) => nextBound.add(baseName(p.name)))
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
              instr.sources.forEach((src: any) => {
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
            term.cases.forEach((c: any) => {
              if (c.test) collectExprReads(c.test, into, paths, nextBound, includeFunctionBodies)
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
      expr.params?.forEach((p: any) => nextBound.add(baseName(p.name)))
      for (const block of expr.body ?? []) {
        for (const instr of block.instructions) {
          if (instr.kind === 'Assign') {
            collectExprReads(instr.value, into, paths, nextBound, includeFunctionBodies)
          } else if (instr.kind === 'Expression') {
            collectExprReads(instr.value, into, paths, nextBound, includeFunctionBodies)
          } else if (instr.kind === 'Phi') {
            instr.sources.forEach((src: any) => {
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
          term.cases.forEach((c: any) => {
            if (c.test) collectExprReads(c.test, into, paths, nextBound, includeFunctionBodies)
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
    case 'JSXElement':
      // Collect from JSX attributes and children
      expr.attributes?.forEach((attr: any) => {
        if (attr.value) collectExprReads(attr.value, into, paths, bound)
        if (attr.spreadExpr) collectExprReads(attr.spreadExpr, into, paths, bound)
      })
      expr.children?.forEach((child: any) => {
        if (child.kind === 'expression') collectExprReads(child.value, into, paths, bound)
        if (child.kind === 'element') collectExprReads(child.value, into, paths, bound)
      })
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
    } else if (term.kind === 'ForIn' && term.object) {
      // ForIn object is a control flow read - changes to object affect loop execution
      collectExprReads(term.object, controlFlowReads)
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

import { analyzeCFG } from './ssa'

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
