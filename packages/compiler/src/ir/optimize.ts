import * as t from '@babel/types'

import type {
  BasicBlock,
  Expression,
  HIRFunction,
  HIRProgram,
  Identifier,
  Instruction,
  Terminator,
  JSXElementExpression,
  BlockId,
} from './hir'
import { getSSABaseName, makeSSAName } from './hir'
import { isHookLikeFunction } from './hook-utils'
import { analyzeReactiveScopesWithSSA, type ReactiveScopeResult } from './scopes'
import { analyzeCFG, enterSSA } from './ssa'

type ConstantValue = string | number | boolean | null | undefined
type ConstObjectFields = Map<string, ConstantValue>
type ConstArrayElements = Map<number, ConstantValue>

const UNKNOWN_CONST = Symbol('unknown-const')

interface DefLocation {
  blockId: number
  instrIndex: number
  kind: 'Assign' | 'Phi'
}

interface UseLocation {
  blockId: number
  instrIndex: number
  kind: 'Assign' | 'Expression' | 'Phi' | 'Terminator'
  inFunctionBody: boolean
}

interface DefUseInfo {
  def?: DefLocation
  defs?: DefLocation[]
  uses: UseLocation[]
  useScopes?: Set<number>
}

interface PurityContext {
  functionPure?: boolean
  impureIdentifiers?: Set<string>
}

const PURE_MATH_METHODS = new Set([
  'abs',
  'ceil',
  'floor',
  'round',
  'trunc',
  'sign',
  'min',
  'max',
  'pow',
  'sqrt',
  'cbrt',
  'hypot',
  'log',
  'log10',
  'log2',
  'exp',
  'sin',
  'cos',
  'tan',
])

const STABLE_MEMBER_ACCESS = new Map<string, Set<string>>([
  ['Math', new Set(['E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2'])],
  [
    'Number',
    new Set([
      'EPSILON',
      'MAX_SAFE_INTEGER',
      'MIN_SAFE_INTEGER',
      'MAX_VALUE',
      'MIN_VALUE',
      'NaN',
      'POSITIVE_INFINITY',
      'NEGATIVE_INFINITY',
    ]),
  ],
  [
    'Symbol',
    new Set([
      'asyncIterator',
      'hasInstance',
      'isConcatSpreadable',
      'iterator',
      'match',
      'matchAll',
      'replace',
      'search',
      'species',
      'split',
      'toPrimitive',
      'toStringTag',
      'unscopables',
    ]),
  ],
])

const PURE_CALLEES = new Set(['String', 'Number', 'Boolean', 'BigInt', 'parseInt', 'parseFloat'])
const IMPURE_CALLEES = new Set([
  '$state',
  '$effect',
  '$memo',
  '$store',
  'createSignal',
  'createEffect',
  'createMemo',
  'createStore',
  'onMount',
  'startTransition',
  'render',
])

export interface OptimizeOptions {
  memoMacroNames?: Set<string>
  inlineDerivedMemos?: boolean
}

export function optimizeHIR(program: HIRProgram, options: OptimizeOptions = {}): HIRProgram {
  const exportedNames = collectExportedNames(program)
  const functions = program.functions.map(fn => {
    if (isPureOptimizationCandidate(fn)) {
      const ssaProgram = enterSSA({
        functions: [fn],
        preamble: [],
        postamble: [],
        originalBody: [],
      })
      const ssaFn = ssaProgram.functions[0]
      return ssaFn ? optimizeSSAFunction(ssaFn) : fn
    }
    if (isReactiveOptimizationCandidate(fn)) {
      return optimizeReactiveFunction(fn, exportedNames, options)
    }
    return fn
  })
  return {
    ...program,
    functions,
  }
}

function optimizeSSAFunction(fn: HIRFunction): HIRFunction {
  let current = fn
  current = propagateConstants(current)
  const purity = buildPurityContext(current)
  current = eliminateCommonSubexpressions(current, purity)
  current = inlineSingleUse(current, purity)
  current = eliminateDeadCode(current, purity)
  current = eliminatePhiNodes(current)
  return current
}

type ReactiveNodeKind =
  | 'signal'
  | 'store'
  | 'memo'
  | 'derived'
  | 'function'
  | 'effect'
  | 'binding'
  | 'return'
  | 'impure'

interface ReactiveGraphNode {
  id: string
  kind: ReactiveNodeKind
  deps: Set<string>
  name?: string
  pure?: boolean
  explicit?: boolean
}

interface ReactiveGraph {
  nodes: Map<string, ReactiveGraphNode>
  roots: Set<string>
  varNodes: Set<string>
}

const DEFAULT_MEMO_MACRO_NAMES = new Set(['$memo', 'createMemo'])
const EFFECT_ROOT_NAMES = new Set(['$effect', 'createEffect', 'onMount', 'render'])

function buildReactiveGraph(
  fn: HIRFunction,
  exportedNames: Set<string>,
  purity: PurityContext,
  options: OptimizeOptions,
  scopeResult?: ReactiveScopeResult,
): ReactiveGraph {
  const nodes = new Map<string, ReactiveGraphNode>()
  const roots = new Set<string>()
  const varNodes = new Set<string>()
  let rootIndex = 0

  const memoMacroNames = new Set<string>([
    ...DEFAULT_MEMO_MACRO_NAMES,
    ...(options.memoMacroNames ?? []),
  ])

  const resolvedScopeResult = scopeResult ?? analyzeReactiveScopesWithSSA(fn)
  const derivedVars = new Set<string>()
  for (const [name, scope] of resolvedScopeResult.definitionScope.entries()) {
    if (scope.shouldMemoize) {
      derivedVars.add(getSSABaseName(name))
    }
  }

  const addVarNode = (
    name: string,
    kind: ReactiveNodeKind,
    deps: Set<string>,
    meta?: { pure?: boolean; explicit?: boolean },
  ) => {
    const id = `var:${name}`
    const existing = nodes.get(id)
    if (existing) {
      if (existing.kind === 'signal' || existing.kind === 'store') return
      if (existing.kind === 'memo' && kind === 'derived') return
      if (existing.kind === kind) return
    }
    nodes.set(id, { id, kind, deps, name, pure: meta?.pure, explicit: meta?.explicit })
    varNodes.add(name)
  }

  const addRootNode = (kind: ReactiveNodeKind, deps: Set<string>) => {
    const id = `root:${kind}:${rootIndex++}`
    nodes.set(id, { id, kind, deps })
    roots.add(id)
  }

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = getSSABaseName(instr.target.name)
        const calleeName = getCallCalleeName(instr.value)
        if (calleeName === '$state' || calleeName === 'createSignal') {
          addVarNode(target, 'signal', new Set())
        } else if (calleeName === '$store' || calleeName === 'createStore') {
          addVarNode(target, 'store', new Set())
        } else if (calleeName && memoMacroNames.has(calleeName)) {
          const memoDeps = collectDependenciesFromMemo(instr.value)
          const valuePure =
            instr.value.kind === 'CallExpression' || instr.value.kind === 'OptionalCallExpression'
              ? instr.value.pure
              : undefined
          addVarNode(target, 'memo', memoDeps, {
            pure: !!(valuePure || purity.functionPure),
            explicit: true,
          })
        } else if (derivedVars.has(target)) {
          const deps = collectDependenciesShallow(instr.value)
          addVarNode(target, 'derived', deps)
        }
        if (instr.value.kind === 'ArrowFunction' || instr.value.kind === 'FunctionExpression') {
          const deps = collectDependenciesDeep(instr.value)
          addVarNode(target, 'function', deps)
        }

        if (!isPureExpression(instr.value, purity)) {
          addRootNode('impure', collectDependenciesDeep(instr.value))
        }

        collectRootNodesFromExpression(
          instr.value,
          deps => addRootNode('binding', deps),
          deps => addRootNode('effect', deps),
        )
      } else if (instr.kind === 'Expression') {
        if (!isPureExpression(instr.value, purity)) {
          addRootNode('impure', collectDependenciesDeep(instr.value))
        }
        collectRootNodesFromExpression(
          instr.value,
          deps => addRootNode('binding', deps),
          deps => addRootNode('effect', deps),
        )
      } else if (instr.kind === 'Phi') {
        const target = getSSABaseName(instr.target.name)
        if (derivedVars.has(target) && !varNodes.has(target)) {
          const deps = new Set<string>()
          instr.sources.forEach(src => deps.add(getSSABaseName(src.id.name)))
          addVarNode(target, 'derived', deps)
        }
      }
    }

    const term = block.terminator
    if (term.kind === 'Return' && term.argument) {
      const deps = collectDependenciesDeep(term.argument)
      addRootNode('return', deps)
      collectRootNodesFromExpression(
        term.argument,
        deps2 => addRootNode('binding', deps2),
        deps2 => addRootNode('effect', deps2),
      )
    } else if (term.kind === 'Branch') {
      addRootNode('binding', collectDependenciesDeep(term.test))
    } else if (term.kind === 'Switch') {
      addRootNode('binding', collectDependenciesDeep(term.discriminant))
      term.cases.forEach(c => {
        if (c.test) {
          addRootNode('binding', collectDependenciesDeep(c.test))
        }
      })
    } else if (term.kind === 'ForOf') {
      addRootNode('binding', collectDependenciesDeep(term.iterable))
    } else if (term.kind === 'ForIn') {
      addRootNode('binding', collectDependenciesDeep(term.object))
    } else if (term.kind === 'Throw' && term.argument) {
      addRootNode('impure', collectDependenciesDeep(term.argument))
    }
  }

  for (const name of exportedNames) {
    const base = getSSABaseName(name)
    if (varNodes.has(base)) {
      roots.add(`var:${base}`)
    }
  }

  return { nodes, roots, varNodes }
}

function computeReactiveReachability(graph: ReactiveGraph): Set<string> {
  const live = new Set<string>()
  const queue: string[] = Array.from(graph.roots)
  while (queue.length > 0) {
    const id = queue.pop()!
    if (live.has(id)) continue
    live.add(id)
    const node = graph.nodes.get(id)
    if (!node) continue
    for (const dep of node.deps) {
      if (!graph.varNodes.has(dep)) continue
      const depId = `var:${dep}`
      if (!live.has(depId)) queue.push(depId)
    }
  }
  return live
}

function buildDerivedPurityContext(
  purity: PurityContext,
  reactive: ReactiveContext,
): PurityContext {
  if (!purity.impureIdentifiers) return purity
  const filtered = new Set(purity.impureIdentifiers)
  reactive.reactiveSources.forEach(name => filtered.delete(name))
  reactive.storeVars.forEach(name => filtered.delete(name))
  return { ...purity, impureIdentifiers: filtered }
}

function applyReactiveGraphDCE(
  fn: HIRFunction,
  graph: ReactiveGraph,
  purity: PurityContext,
  reactive: ReactiveContext,
): HIRFunction {
  const live = computeReactiveReachability(graph)
  const assignmentCounts = countAssignmentsByBase(fn)
  const derivedPurity = buildDerivedPurityContext(purity, reactive)
  const blocks = fn.blocks.map(block => {
    const instructions = block.instructions.filter(instr => {
      if (instr.kind !== 'Assign') return true
      const target = getSSABaseName(instr.target.name)
      const nodeId = `var:${target}`
      const node = graph.nodes.get(nodeId)
      if (!node) return true
      if (live.has(nodeId)) return true
      if (instr.declarationKind !== 'const') return true
      if ((assignmentCounts.get(target) ?? 0) !== 1) return true
      if (node.kind === 'derived' && !isPureExpression(instr.value, derivedPurity)) return true
      if (node.kind === 'memo' && !isPureExpression(instr.value, purity)) return true
      if (node.kind === 'memo') {
        return !node.pure
      }
      if (node.kind === 'derived') {
        return false
      }
      return true
    })
    return { ...block, instructions }
  })
  return { ...fn, blocks }
}

function collectRootNodesFromExpression(
  expr: Expression,
  onBinding: (deps: Set<string>) => void,
  onEffect: (deps: Set<string>) => void,
): void {
  const visit = (node: Expression, shadowed: Set<string>) => {
    switch (node.kind) {
      case 'JSXElement': {
        onBinding(collectDependenciesShallow(node))
        if (typeof node.tagName !== 'string') {
          visit(node.tagName as Expression, shadowed)
        }
        node.attributes.forEach(attr => {
          if (attr.isSpread && attr.spreadExpr) {
            visit(attr.spreadExpr as Expression, shadowed)
          } else if (attr.value) {
            visit(attr.value as Expression, shadowed)
          }
        })
        node.children.forEach(child => {
          if (child.kind === 'expression') {
            visit(child.value as Expression, shadowed)
          } else if (child.kind === 'element') {
            visit(child.value as Expression, shadowed)
          }
        })
        return
      }
      case 'CallExpression':
      case 'OptionalCallExpression': {
        const calleeName = getCallCalleeName(node)
        if (calleeName && EFFECT_ROOT_NAMES.has(calleeName)) {
          const deps = new Set<string>()
          node.arguments.forEach(arg => {
            collectDependenciesDeep(arg as Expression).forEach(dep => deps.add(dep))
          })
          onEffect(deps)
        }
        visit(node.callee as Expression, shadowed)
        node.arguments.forEach(arg => visit(arg as Expression, shadowed))
        return
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visit(node.object as Expression, shadowed)
        if (node.computed) visit(node.property as Expression, shadowed)
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
        visit(node.left as Expression, shadowed)
        visit(node.right as Expression, shadowed)
        return
      case 'UnaryExpression':
        visit(node.argument as Expression, shadowed)
        return
      case 'ConditionalExpression':
        visit(node.test as Expression, shadowed)
        visit(node.consequent as Expression, shadowed)
        visit(node.alternate as Expression, shadowed)
        return
      case 'ArrayExpression':
        node.elements.forEach(el => {
          if (el) visit(el as Expression, shadowed)
        })
        return
      case 'ObjectExpression':
        node.properties.forEach(prop => {
          if (prop.kind === 'SpreadElement') {
            visit(prop.argument as Expression, shadowed)
          } else {
            visit(prop.value as Expression, shadowed)
          }
        })
        return
      case 'TemplateLiteral':
        node.expressions.forEach(e => visit(e as Expression, shadowed))
        return
      case 'SpreadElement':
        visit(node.argument as Expression, shadowed)
        return
      case 'SequenceExpression':
        node.expressions.forEach(e => visit(e as Expression, shadowed))
        return
      case 'AwaitExpression':
        visit(node.argument as Expression, shadowed)
        return
      case 'NewExpression':
        visit(node.callee as Expression, shadowed)
        node.arguments.forEach(arg => visit(arg as Expression, shadowed))
        return
      case 'AssignmentExpression':
        visit(node.left as Expression, shadowed)
        visit(node.right as Expression, shadowed)
        return
      case 'UpdateExpression':
        visit(node.argument as Expression, shadowed)
        return
      case 'ArrowFunction':
      case 'FunctionExpression':
        return
      default:
        return
    }
  }

  visit(expr, new Set())
}

function collectDependenciesShallow(expr: Expression): Set<string> {
  return collectDependencies(expr, false)
}

function collectDependenciesDeep(expr: Expression): Set<string> {
  return collectDependencies(expr, true)
}

function collectDependencies(expr: Expression, includeFunctionBodies: boolean): Set<string> {
  const deps = new Set<string>()
  collectDependenciesFromExpression(expr, deps, includeFunctionBodies, new Set())
  return deps
}

function collectDependenciesFromExpression(
  expr: Expression,
  deps: Set<string>,
  includeFunctionBodies: boolean,
  shadowed: Set<string>,
): void {
  if (!expr) return
  switch (expr.kind) {
    case 'Identifier': {
      const base = getSSABaseName(expr.name)
      if (!shadowed.has(base)) deps.add(base)
      return
    }
    case 'CallExpression':
    case 'OptionalCallExpression':
      collectDependenciesFromExpression(
        expr.callee as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      expr.arguments.forEach(arg =>
        collectDependenciesFromExpression(arg as Expression, deps, includeFunctionBodies, shadowed),
      )
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectDependenciesFromExpression(
        expr.object as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      if (expr.computed) {
        collectDependenciesFromExpression(
          expr.property as Expression,
          deps,
          includeFunctionBodies,
          shadowed,
        )
      }
      return
    case 'BinaryExpression':
    case 'LogicalExpression':
      collectDependenciesFromExpression(
        expr.left as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      collectDependenciesFromExpression(
        expr.right as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      return
    case 'UnaryExpression':
      collectDependenciesFromExpression(
        expr.argument as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      return
    case 'ConditionalExpression':
      collectDependenciesFromExpression(
        expr.test as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      collectDependenciesFromExpression(
        expr.consequent as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      collectDependenciesFromExpression(
        expr.alternate as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      return
    case 'ArrayExpression':
      expr.elements.forEach(el => {
        if (el) {
          collectDependenciesFromExpression(el as Expression, deps, includeFunctionBodies, shadowed)
        }
      })
      return
    case 'ObjectExpression':
      expr.properties.forEach(prop => {
        if (prop.kind === 'SpreadElement') {
          collectDependenciesFromExpression(
            prop.argument as Expression,
            deps,
            includeFunctionBodies,
            shadowed,
          )
        } else {
          collectDependenciesFromExpression(
            prop.value as Expression,
            deps,
            includeFunctionBodies,
            shadowed,
          )
        }
      })
      return
    case 'TemplateLiteral':
      expr.expressions.forEach(e =>
        collectDependenciesFromExpression(e as Expression, deps, includeFunctionBodies, shadowed),
      )
      return
    case 'SpreadElement':
      collectDependenciesFromExpression(
        expr.argument as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      return
    case 'SequenceExpression':
      expr.expressions.forEach(e =>
        collectDependenciesFromExpression(e as Expression, deps, includeFunctionBodies, shadowed),
      )
      return
    case 'AwaitExpression':
      collectDependenciesFromExpression(
        expr.argument as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      return
    case 'NewExpression':
      collectDependenciesFromExpression(
        expr.callee as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      expr.arguments.forEach(arg =>
        collectDependenciesFromExpression(arg as Expression, deps, includeFunctionBodies, shadowed),
      )
      return
    case 'AssignmentExpression':
      collectDependenciesFromExpression(
        expr.left as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      collectDependenciesFromExpression(
        expr.right as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      return
    case 'UpdateExpression':
      collectDependenciesFromExpression(
        expr.argument as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      return
    case 'JSXElement':
      if (typeof expr.tagName !== 'string') {
        collectDependenciesFromExpression(
          expr.tagName as Expression,
          deps,
          includeFunctionBodies,
          shadowed,
        )
      }
      expr.attributes.forEach(attr => {
        if (attr.isSpread && attr.spreadExpr) {
          collectDependenciesFromExpression(
            attr.spreadExpr as Expression,
            deps,
            includeFunctionBodies,
            shadowed,
          )
        } else if (attr.value) {
          collectDependenciesFromExpression(
            attr.value as Expression,
            deps,
            includeFunctionBodies,
            shadowed,
          )
        }
      })
      expr.children.forEach(child => {
        if (child.kind === 'expression') {
          collectDependenciesFromExpression(
            child.value as Expression,
            deps,
            includeFunctionBodies,
            shadowed,
          )
        } else if (child.kind === 'element') {
          collectDependenciesFromExpression(
            child.value as Expression,
            deps,
            includeFunctionBodies,
            shadowed,
          )
        }
      })
      return
    case 'ArrowFunction': {
      if (!includeFunctionBodies) return
      const nextShadowed = new Set(shadowed)
      expr.params.forEach(param => nextShadowed.add(getSSABaseName(param.name)))
      if (expr.isExpression) {
        collectDependenciesFromExpression(
          expr.body as Expression,
          deps,
          includeFunctionBodies,
          nextShadowed,
        )
        return
      }
      collectDependenciesFromBlocks(
        expr.body as BasicBlock[],
        deps,
        includeFunctionBodies,
        nextShadowed,
      )
      return
    }
    case 'FunctionExpression': {
      if (!includeFunctionBodies) return
      const nextShadowed = new Set(shadowed)
      expr.params.forEach(param => nextShadowed.add(getSSABaseName(param.name)))
      collectDependenciesFromBlocks(expr.body, deps, includeFunctionBodies, nextShadowed)
      return
    }
    default:
      return
  }
}

function collectDependenciesFromBlocks(
  blocks: BasicBlock[],
  deps: Set<string>,
  includeFunctionBodies: boolean,
  shadowed: Set<string>,
): void {
  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        collectDependenciesFromExpression(
          instr.value as Expression,
          deps,
          includeFunctionBodies,
          shadowed,
        )
      } else if (instr.kind === 'Phi') {
        instr.sources.forEach(src => {
          const base = getSSABaseName(src.id.name)
          if (!shadowed.has(base)) deps.add(base)
        })
      }
    }
    const term = block.terminator
    if (term.kind === 'Return' && term.argument) {
      collectDependenciesFromExpression(
        term.argument as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
    } else if (term.kind === 'Throw') {
      collectDependenciesFromExpression(
        term.argument as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
    } else if (term.kind === 'Branch') {
      collectDependenciesFromExpression(
        term.test as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
    } else if (term.kind === 'Switch') {
      collectDependenciesFromExpression(
        term.discriminant as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
      term.cases.forEach(c => {
        if (c.test) {
          collectDependenciesFromExpression(
            c.test as Expression,
            deps,
            includeFunctionBodies,
            shadowed,
          )
        }
      })
    } else if (term.kind === 'ForOf') {
      collectDependenciesFromExpression(
        term.iterable as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
    } else if (term.kind === 'ForIn') {
      collectDependenciesFromExpression(
        term.object as Expression,
        deps,
        includeFunctionBodies,
        shadowed,
      )
    }
  }
}

function getCallCalleeName(expr: Expression): string | null {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
  if (expr.callee.kind === 'Identifier') return expr.callee.name
  return null
}

function collectDependenciesFromMemo(expr: Expression): Set<string> {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') {
    return new Set()
  }
  const deps = new Set<string>()
  expr.arguments.forEach(arg => {
    collectDependenciesDeep(arg as Expression).forEach(dep => deps.add(dep))
  })
  return deps
}

function optimizeReactiveFunction(
  fn: HIRFunction,
  exportedNames: Set<string>,
  options: OptimizeOptions,
): HIRFunction {
  const scopeResult = analyzeReactiveScopesWithSSA(fn)
  const reactive = buildReactiveContext(fn)
  const purity = buildPurityContext(fn)
  const hookLike = isHookLikeFunction(fn)
  const transformedBlocks = fn.blocks.map(block => optimizeReactiveBlock(block, reactive, purity))
  let transformed = { ...fn, blocks: transformedBlocks }
  if (isCrossBlockConstPropagationEnabled()) {
    transformed = propagateCrossBlockConstants(transformed, reactive, purity, scopeResult)
  }
  transformed = eliminateCrossBlockCSE(transformed, reactive, purity)
  transformed = inlineSingleUseDerivedMemos(
    transformed,
    reactive,
    purity,
    scopeResult,
    options.inlineDerivedMemos ?? false,
    hookLike,
  )
  const graph = buildReactiveGraph(transformed, exportedNames, purity, options, scopeResult)
  transformed = applyReactiveGraphDCE(transformed, graph, purity, reactive)
  const usageCounts = countIdentifierUses(transformed)
  const assignmentCounts = countAssignments(transformed)
  const blocks = transformed.blocks.map(block => {
    const instructions = block.instructions.filter(instr => {
      if (instr.kind !== 'Assign') return true
      const target = instr.target.name
      if (exportedNames.has(target)) return true
      if (!isCompilerGeneratedName(target)) return true
      if ((assignmentCounts.get(target) ?? 0) !== 1) return true
      if ((usageCounts.get(target) ?? 0) > 0) return true
      if (!isPureExpression(instr.value, purity)) return true
      if (isExplicitMemoCall(instr.value, purity)) return true
      if (expressionDependsOnReactive(instr.value, reactive)) return true
      return false
    })
    return { ...block, instructions }
  })
  return { ...transformed, blocks }
}

function optimizeReactiveBlock(
  block: BasicBlock,
  reactive: ReactiveContext,
  purity: PurityContext,
): BasicBlock {
  const constants = new Map<string, ConstantValue>()
  const constObjects = new Map<string, ConstObjectFields>()
  const constArrays = new Map<string, ConstArrayElements>()
  const cseMap = new Map<string, { name: string; deps: Set<string> }>()
  const instructions: Instruction[] = []

  const invalidateCSE = (name: string) => {
    const toDelete: string[] = []
    for (const [hash, entry] of cseMap.entries()) {
      if (entry.name === name || entry.deps.has(name)) {
        toDelete.push(hash)
      }
    }
    toDelete.forEach(hash => cseMap.delete(hash))
  }

  for (const instr of block.instructions) {
    if (instr.kind === 'Assign') {
      const target = instr.target.name
      const declKind = instr.declarationKind
      invalidateCSE(target)
      constants.delete(target)
      constObjects.delete(target)
      constArrays.delete(target)
      const sideWrites = collectWriteTargets(instr.value)
      for (const name of sideWrites) {
        if (name !== target) {
          constants.delete(name)
          invalidateCSE(name)
        }
        constObjects.delete(name)
        constArrays.delete(name)
      }
      const memberCalls = collectMemberCallTargets(instr.value)
      for (const name of memberCalls) {
        constObjects.delete(name)
        constArrays.delete(name)
      }
      const dependsOnReactiveValue = expressionDependsOnReactive(instr.value, reactive)
      let value = dependsOnReactiveValue
        ? instr.value
        : foldExpressionWithConstants(instr.value, constants, constObjects, constArrays)
      const allowCSE = isCompilerGeneratedName(target) && (!declKind || declKind === 'const')

      if (
        allowCSE &&
        isPureExpression(value, purity) &&
        !isExplicitMemoCall(value, purity) &&
        !dependsOnReactiveValue &&
        isCSESafeExpression(value, purity)
      ) {
        const deps = collectExpressionIdentifiers(value, true)
        const hash = `${hashExpression(value)}|${[...deps].sort().join(',')}`
        const existing = cseMap.get(hash)
        if (existing && existing.name !== target) {
          value = { kind: 'Identifier', name: existing.name, loc: value.loc }
        }
        cseMap.set(hash, { name: target, deps })
      }

      const constValue = evaluateLiteral(value, constants)
      if (
        constValue !== UNKNOWN_CONST &&
        isPureExpression(value, purity) &&
        !dependsOnReactiveValue
      ) {
        constants.set(target, constValue as ConstantValue)
      }
      if (!dependsOnReactiveValue && declKind === 'const') {
        const objectFields = extractConstObjectFields(value, constants)
        if (objectFields) {
          constObjects.set(target, objectFields)
          constArrays.delete(target)
        } else {
          const arrayElements = extractConstArrayElements(value, constants)
          if (arrayElements) {
            constArrays.set(target, arrayElements)
            constObjects.delete(target)
          } else {
            constObjects.delete(target)
            constArrays.delete(target)
          }
        }
      }

      instructions.push(value === instr.value ? instr : { ...instr, value })
      continue
    }

    if (instr.kind === 'Expression') {
      const writes = collectWriteTargets(instr.value)
      for (const name of writes) {
        constants.delete(name)
        invalidateCSE(name)
        constObjects.delete(name)
        constArrays.delete(name)
      }
      const memberCalls = collectMemberCallTargets(instr.value)
      for (const name of memberCalls) {
        constObjects.delete(name)
        constArrays.delete(name)
      }
      const dependsOnReactiveValue = expressionDependsOnReactive(instr.value, reactive)
      const value = dependsOnReactiveValue
        ? instr.value
        : foldExpressionWithConstants(instr.value, constants, constObjects, constArrays)
      instructions.push(value === instr.value ? instr : { ...instr, value })
      continue
    }

    instructions.push(instr)
  }

  const terminator = foldTerminatorWithConstants(
    block.terminator,
    constants,
    reactive,
    constObjects,
    constArrays,
  )
  const inlined = inlineSingleUseInBlock(instructions, terminator, reactive, purity)
  return { ...block, ...inlined }
}

interface CrossBlockCSEEntry {
  name: string
  deps: Set<string>
  blockId: BlockId
}

type CrossBlockCSEMap = Map<string, CrossBlockCSEEntry>

function invalidateCrossBlockCSE(map: CrossBlockCSEMap, writes: Set<string>): void {
  if (writes.size === 0) return
  for (const [hash, entry] of map.entries()) {
    if (writes.has(entry.name)) {
      map.delete(hash)
      continue
    }
    for (const dep of entry.deps) {
      if (writes.has(dep)) {
        map.delete(hash)
        break
      }
    }
  }
}

function isStraightLinePath(
  cfg: ReturnType<typeof analyzeCFG>,
  from: BlockId,
  to: BlockId,
): boolean {
  if (from === to) {
    const succ = cfg.successors.get(from) ?? []
    return succ.length <= 1 && !cfg.loopHeaders.has(from)
  }
  let current: BlockId | undefined = to
  while (current !== undefined && current !== from) {
    if (cfg.loopHeaders.has(current)) return false
    const preds = cfg.predecessors.get(current) ?? []
    if (preds.length !== 1) return false
    const parent = cfg.dominatorTree.idom.get(current)
    if (parent === undefined || parent === current) return false
    const parentSucc = cfg.successors.get(parent) ?? []
    if (parentSucc.length > 1) return false
    current = parent
  }
  if (current !== from) return false
  const fromSucc = cfg.successors.get(from) ?? []
  if (fromSucc.length > 1) return false
  if (cfg.loopHeaders.has(from)) return false
  return true
}

function eliminateCrossBlockCSE(
  fn: HIRFunction,
  reactive: ReactiveContext,
  purity: PurityContext,
): HIRFunction {
  const cfg = analyzeCFG(fn.blocks)
  const blockMap = new Map<number, BasicBlock>()
  fn.blocks.forEach(block => blockMap.set(block.id, block))
  const newBlocks = new Map<number, BasicBlock>()

  const walk = (blockId: number, incoming: CrossBlockCSEMap) => {
    const block = blockMap.get(blockId)
    if (!block) return
    const cseMap = new Map(incoming)
    const updatedInstructions = [...block.instructions]
    let changed = false

    for (let i = 0; i < updatedInstructions.length; i++) {
      const instr = updatedInstructions[i]
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        if (!isPureExpression(instr.value, purity) || isExplicitMemoCall(instr.value, purity)) {
          cseMap.clear()
        }
      }

      if (instr.kind === 'Assign') {
        const target = instr.target.name
        let value = instr.value
        const dependsOnReactiveValue = expressionDependsOnReactive(value, reactive)
        const allowCSE =
          isCompilerGeneratedName(target) &&
          (!instr.declarationKind || instr.declarationKind === 'const')

        let usedExisting = false
        if (
          allowCSE &&
          !dependsOnReactiveValue &&
          isPureExpression(value, purity) &&
          !isExplicitMemoCall(value, purity) &&
          isCSESafeExpression(value, purity)
        ) {
          const deps = collectExpressionIdentifiers(value, true)
          const hash = `${hashExpression(value)}|${[...deps].sort().join(',')}`
          const existing = cseMap.get(hash)
          if (
            existing &&
            existing.name !== target &&
            dominates(cfg.dominatorTree.idom, existing.blockId, block.id) &&
            isStraightLinePath(cfg, existing.blockId, block.id)
          ) {
            value = { kind: 'Identifier', name: existing.name, loc: value.loc }
            usedExisting = true
            if (value !== instr.value) {
              updatedInstructions[i] = { ...instr, value }
              changed = true
            }
          }
        }

        const writes = new Set<string>([target])
        collectWriteTargets(value).forEach(name => writes.add(name))
        collectMemberCallTargets(value).forEach(name => writes.add(name))
        invalidateCrossBlockCSE(cseMap, writes)

        if (
          !usedExisting &&
          allowCSE &&
          !dependsOnReactiveValue &&
          isPureExpression(value, purity) &&
          !isExplicitMemoCall(value, purity) &&
          isCSESafeExpression(value, purity)
        ) {
          const deps = collectExpressionIdentifiers(value, true)
          const hash = `${hashExpression(value)}|${[...deps].sort().join(',')}`
          cseMap.set(hash, { name: target, deps, blockId: block.id })
        }
      } else if (instr.kind === 'Expression') {
        const writes = collectWriteTargets(instr.value)
        collectMemberCallTargets(instr.value).forEach(name => writes.add(name))
        invalidateCrossBlockCSE(cseMap, writes)
      } else if (instr.kind === 'Phi') {
        const writes = new Set<string>([instr.target.name])
        invalidateCrossBlockCSE(cseMap, writes)
      }
    }

    newBlocks.set(blockId, changed ? { ...block, instructions: updatedInstructions } : block)

    for (const child of cfg.dominatorTree.children.get(blockId) ?? []) {
      walk(child, cseMap)
    }
  }

  const entryId = fn.blocks[0]?.id
  if (entryId !== undefined) {
    walk(entryId, new Map())
  }

  const blocks = fn.blocks.map(block => newBlocks.get(block.id) ?? block)
  return { ...fn, blocks }
}

function inlineSingleUseDerivedMemos(
  fn: HIRFunction,
  reactive: ReactiveContext,
  purity: PurityContext,
  scopeResult: ReactiveScopeResult,
  allowUserNames: boolean,
  isHookLike: boolean,
): HIRFunction {
  const defUse = buildDefUse(fn, scopeResult)
  const assignmentCounts = countAssignments(fn)
  const cfg = analyzeCFG(fn.blocks)
  const derivedPurity = buildDerivedPurityContext(purity, reactive)
  const blockMap = new Map<number, BasicBlock>()
  fn.blocks.forEach(block => blockMap.set(block.id, block))
  const updatedBlocks = new Map<number, BasicBlock>()

  for (const block of fn.blocks) {
    const baseBlock = updatedBlocks.get(block.id) ?? block
    let instructions = [...baseBlock.instructions]
    let terminator = baseBlock.terminator
    let changed = false

    for (let i = 0; i < instructions.length; i++) {
      const instr = instructions[i]
      if (instr.kind !== 'Assign') continue
      const target = instr.target.name
      if (!allowUserNames && !isCompilerGeneratedName(target)) continue
      if (isHookLike && !isCompilerGeneratedName(target)) continue
      const scope = scopeResult.definitionScope.get(target)
      if (!scope || !scope.shouldMemoize) continue
      if (instr.declarationKind && instr.declarationKind !== 'const') continue
      if ((assignmentCounts.get(target) ?? 0) !== 1) continue
      const info = defUse.get(target)
      if (!info || info.uses.length !== 1) continue
      const use = info.uses[0]
      if (use.inFunctionBody || use.kind === 'Phi') continue
      if (!isPureExpression(instr.value, derivedPurity)) continue
      if (isExplicitMemoCall(instr.value, purity)) continue
      if (
        !dominates(cfg.dominatorTree.idom, block.id, use.blockId) ||
        !isStraightLinePath(cfg, block.id, use.blockId)
      ) {
        continue
      }

      if (use.blockId === block.id && use.instrIndex <= i) continue
      const useBlock = updatedBlocks.get(use.blockId) ?? blockMap.get(use.blockId)
      if (!useBlock) continue

      if (use.kind === 'Assign' || use.kind === 'Expression') {
        if (use.blockId === block.id) {
          const useInstr = instructions[use.instrIndex]
          if (useInstr?.kind === 'Assign') {
            const replaced = replaceIdentifier(useInstr.value, target, instr.value, false)
            instructions[use.instrIndex] = { ...useInstr, value: replaced }
            changed = true
          } else if (useInstr?.kind === 'Expression') {
            const replaced = replaceIdentifier(useInstr.value, target, instr.value, false)
            instructions[use.instrIndex] = { ...useInstr, value: replaced }
            changed = true
          }
        } else {
          const useInstructions = [...useBlock.instructions]
          const useInstr = useInstructions[use.instrIndex]
          if (useInstr?.kind === 'Assign') {
            const replaced = replaceIdentifier(useInstr.value, target, instr.value, false)
            useInstructions[use.instrIndex] = { ...useInstr, value: replaced }
          } else if (useInstr?.kind === 'Expression') {
            const replaced = replaceIdentifier(useInstr.value, target, instr.value, false)
            useInstructions[use.instrIndex] = { ...useInstr, value: replaced }
          }
          updatedBlocks.set(use.blockId, { ...useBlock, instructions: useInstructions })
        }
      } else if (use.kind === 'Terminator') {
        if (use.blockId === block.id) {
          terminator = replaceIdentifierInTerminator(terminator, target, instr.value)
          changed = true
        } else {
          updatedBlocks.set(use.blockId, {
            ...useBlock,
            terminator: replaceIdentifierInTerminator(useBlock.terminator, target, instr.value),
          })
        }
      }

      instructions[i] = null as unknown as Instruction
      changed = true
    }

    if (changed) {
      instructions = instructions.filter(Boolean)
      updatedBlocks.set(block.id, { ...baseBlock, instructions, terminator })
    }
  }

  const blocks = fn.blocks.map(block => updatedBlocks.get(block.id) ?? block)
  return { ...fn, blocks }
}

function isCrossBlockConstPropagationEnabled(): boolean {
  const raw = process.env.FICT_OPT_CROSS_BLOCK_CONST
  if (raw === undefined) return true
  return !(raw === '0' || raw.toLowerCase() === 'false')
}

function propagateCrossBlockConstants(
  fn: HIRFunction,
  reactive: ReactiveContext,
  purity: PurityContext,
  scopeResult?: ReactiveScopeResult,
): HIRFunction {
  const cfg = analyzeCFG(fn.blocks)
  const assignCounts = countAssignments(fn)
  const defUse = buildDefUse(fn, scopeResult)
  const constantDefs = new Map<string, { blockId: BlockId; instrIndex: number; expr: Expression }>()

  for (const block of fn.blocks) {
    for (let index = 0; index < block.instructions.length; index++) {
      const instr = block.instructions[index]
      if (instr.kind !== 'Assign') continue
      const target = instr.target.name
      if (!isCompilerGeneratedName(target)) continue
      if ((assignCounts.get(target) ?? 0) !== 1) continue
      if (instr.declarationKind && instr.declarationKind !== 'const') continue
      if (!isPureExpression(instr.value, purity)) continue
      if (isExplicitMemoCall(instr.value, purity)) continue
      if (expressionDependsOnReactive(instr.value, reactive)) continue
      if (isInLoop(block.id, cfg.loopHeaders, cfg.dominatorTree.idom)) continue
      const useInfo = defUse.get(target)
      if (useInfo?.uses.some(use => use.inFunctionBody)) continue
      if (useInfo?.useScopes && useInfo.useScopes.size > 1) continue
      const replacement = getCrossBlockConstantReplacement(instr.value)
      if (!replacement) continue
      constantDefs.set(target, { blockId: block.id, instrIndex: index, expr: replacement })
    }
  }

  if (constantDefs.size === 0) return fn

  const blocks = fn.blocks.map(block => {
    if (isInLoop(block.id, cfg.loopHeaders, cfg.dominatorTree.idom)) {
      return block
    }
    const entryConsts = new Map<string, Expression>()
    for (const [name, def] of constantDefs) {
      if (def.blockId === block.id) continue
      if (!dominates(cfg.dominatorTree.idom, def.blockId, block.id)) continue
      entryConsts.set(name, def.expr)
    }

    const activeConsts = new Map(entryConsts)
    const instructions = block.instructions.map((instr, index) => {
      let nextInstr = instr
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        if (activeConsts.size > 0) {
          const value = replaceExpressionWithConstMap(instr.value, activeConsts)
          if (value !== instr.value) {
            nextInstr = { ...instr, value } as Instruction
          }
        }
      }

      if (instr.kind === 'Assign') {
        const def = constantDefs.get(instr.target.name)
        if (def && def.blockId === block.id && def.instrIndex === index) {
          activeConsts.set(instr.target.name, def.expr)
        } else if (activeConsts.has(instr.target.name)) {
          activeConsts.delete(instr.target.name)
        }
      }

      return nextInstr
    })

    const terminator =
      activeConsts.size > 0
        ? replaceTerminatorWithConstMap(block.terminator, activeConsts)
        : block.terminator

    return { ...block, instructions, terminator }
  })

  return { ...fn, blocks }
}

function getCrossBlockConstantReplacement(expr: Expression): Expression | null {
  const value = evaluateLiteral(expr, new Map())
  if (value !== UNKNOWN_CONST) return { kind: 'Literal', value, loc: expr.loc }
  if (isStableMemberExpression(expr)) return expr
  return null
}

function replaceExpressionWithConstMap(
  expr: Expression,
  constants: Map<string, Expression>,
): Expression {
  let next = expr
  for (const [name, replacement] of constants.entries()) {
    next = replaceIdentifier(next, name, replacement, false)
  }
  return next
}

function replaceTerminatorWithConstMap(
  term: Terminator,
  constants: Map<string, Expression>,
): Terminator {
  let next = term
  for (const [name, replacement] of constants.entries()) {
    next = replaceIdentifierInTerminator(next, name, replacement)
  }
  return next
}

function dominates(idom: Map<BlockId, BlockId>, a: BlockId, b: BlockId): boolean {
  let current: BlockId | undefined = b
  while (current !== undefined) {
    if (current === a) return true
    const parent = idom.get(current)
    if (parent === undefined || parent === current) break
    current = parent
  }
  return false
}

function isInLoop(
  blockId: BlockId,
  loopHeaders: Set<BlockId>,
  idom: Map<BlockId, BlockId>,
): boolean {
  let current: BlockId | undefined = blockId
  while (current !== undefined) {
    if (loopHeaders.has(current)) return true
    const parent = idom.get(current)
    if (parent === undefined || parent === current) break
    current = parent
  }
  return false
}

function inlineSingleUseInBlock(
  instructions: Instruction[],
  terminator: Terminator,
  reactive: ReactiveContext,
  purity: PurityContext,
): { instructions: Instruction[]; terminator: Terminator } {
  const assignCounts = new Map<string, number>()
  instructions.forEach(instr => {
    if (instr.kind !== 'Assign') return
    assignCounts.set(instr.target.name, (assignCounts.get(instr.target.name) ?? 0) + 1)
  })

  const useInfo = collectBlockUseInfo(instructions, terminator)
  const toRemove = new Set<number>()
  let nextTerminator = terminator
  const updated = [...instructions]

  for (let i = 0; i < updated.length; i++) {
    const instr = updated[i]
    if (!instr || instr.kind !== 'Assign') continue
    const target = instr.target.name
    if (!isCompilerGeneratedName(target)) continue
    if (instr.declarationKind && instr.declarationKind !== 'const') continue
    if ((assignCounts.get(target) ?? 0) !== 1) continue
    const info = useInfo.get(target)
    if (!info || info.total !== 1 || info.topLevel !== 1 || !info.firstTopLevel) continue
    if (collectExpressionIdentifiers(instr.value, true).has(target)) continue
    if (!isPureExpression(instr.value, purity)) continue
    if (isExplicitMemoCall(instr.value, purity)) continue
    if (expressionDependsOnReactive(instr.value, reactive)) continue

    const use = info.firstTopLevel
    const useIndex = use.kind === 'Terminator' ? updated.length : use.instrIndex
    if (useIndex <= i) continue
    if (hasSideEffectsBetween(updated, i + 1, useIndex, purity)) continue

    if (use.kind === 'Assign' || use.kind === 'Expression') {
      const useInstr = updated[use.instrIndex]
      if (useInstr?.kind === 'Assign') {
        updated[use.instrIndex] = {
          ...useInstr,
          value: replaceIdentifier(useInstr.value, target, instr.value, false),
        }
      } else if (useInstr?.kind === 'Expression') {
        updated[use.instrIndex] = {
          ...useInstr,
          value: replaceIdentifier(useInstr.value, target, instr.value, false),
        }
      }
    } else if (use.kind === 'Terminator') {
      nextTerminator = replaceIdentifierInTerminator(nextTerminator, target, instr.value)
    }

    toRemove.add(i)
  }

  const filtered = updated.filter((_, idx) => !toRemove.has(idx))
  return { instructions: filtered, terminator: nextTerminator }
}

function collectBlockUseInfo(
  instructions: Instruction[],
  terminator: Terminator,
): Map<string, { total: number; topLevel: number; firstTopLevel?: UseLocation }> {
  const info = new Map<string, { total: number; topLevel: number; firstTopLevel?: UseLocation }>()
  const bump = (name: string, location: UseLocation) => {
    const entry = info.get(name) ?? { total: 0, topLevel: 0 }
    entry.total += 1
    if (!location.inFunctionBody) {
      entry.topLevel += 1
      if (!entry.firstTopLevel) entry.firstTopLevel = location
    }
    info.set(name, entry)
  }

  instructions.forEach((instr, index) => {
    if (instr.kind === 'Assign') {
      collectUsesFromExpression(instr.value, (name, inFunctionBody) => {
        bump(name, { blockId: 0, instrIndex: index, kind: 'Assign', inFunctionBody })
      })
      return
    }
    if (instr.kind === 'Expression') {
      collectUsesFromExpression(instr.value, (name, inFunctionBody) => {
        bump(name, { blockId: 0, instrIndex: index, kind: 'Expression', inFunctionBody })
      })
      return
    }
    if (instr.kind === 'Phi') {
      instr.sources.forEach(src => {
        bump(src.id.name, {
          blockId: 0,
          instrIndex: index,
          kind: 'Phi',
          inFunctionBody: false,
        })
      })
    }
  })

  collectUsesFromTerminator(terminator, (name, inFunctionBody) => {
    bump(name, {
      blockId: 0,
      instrIndex: Number.POSITIVE_INFINITY,
      kind: 'Terminator',
      inFunctionBody,
    })
  })

  return info
}

function buildPurityContext(fn: HIRFunction): PurityContext {
  const base: PurityContext = { functionPure: fn.meta?.pure }
  const impureIdentifiers = computeImpureIdentifiers(fn, base)
  return { ...base, impureIdentifiers }
}

function computeImpureIdentifiers(fn: HIRFunction, base: PurityContext): Set<string> {
  const impure = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    const ctx: PurityContext = { ...base, impureIdentifiers: impure }
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind !== 'Assign') continue
        const target = instr.target.name
        if (impure.has(target)) continue
        if (!isPureExpression(instr.value, ctx)) {
          impure.add(target)
          changed = true
        }
      }
    }
  }
  return impure
}

function isPureOptimizationCandidate(fn: HIRFunction): boolean {
  if (fn.meta?.pure) return true
  return !functionContainsImpureMarkers(fn)
}

function isReactiveOptimizationCandidate(_fn: HIRFunction): boolean {
  return true
}

function functionContainsImpureMarkers(fn: HIRFunction): boolean {
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        if (expressionContainsImpureMarkers(instr.value)) return true
      } else if (instr.kind === 'Phi') {
        continue
      }
    }
    if (terminatorContainsImpureMarkers(block.terminator)) return true
  }
  return false
}

function collectExportedNames(program: HIRProgram): Set<string> {
  const names = new Set<string>()
  for (const item of program.postamble ?? []) {
    if (item && typeof item === 'object' && 'kind' in item) {
      if (item.kind === 'ExportFunction' && item.name) {
        names.add(item.name)
      } else if (item.kind === 'ExportDefault' && item.name) {
        names.add(item.name)
      }
      continue
    }

    if (t.isExportNamedDeclaration(item)) {
      if (item.declaration) {
        collectDeclaredNames(item.declaration, names)
      }
      for (const spec of item.specifiers) {
        if (t.isExportSpecifier(spec) && t.isIdentifier(spec.local)) {
          names.add(spec.local.name)
        }
      }
      continue
    }

    if (t.isExportDefaultDeclaration(item)) {
      const decl = item.declaration
      if (t.isIdentifier(decl)) {
        names.add(decl.name)
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        names.add(decl.id.name)
      } else if (t.isClassDeclaration(decl) && decl.id) {
        names.add(decl.id.name)
      }
    }
  }
  return names
}

function collectDeclaredNames(decl: t.Declaration, into: Set<string>): void {
  if (t.isFunctionDeclaration(decl) && decl.id) {
    into.add(decl.id.name)
    return
  }
  if (t.isClassDeclaration(decl) && decl.id) {
    into.add(decl.id.name)
    return
  }
  if (t.isVariableDeclaration(decl)) {
    for (const d of decl.declarations) {
      if (t.isPatternLike(d.id)) {
        collectPatternNames(d.id, into)
      }
    }
  }
}

function collectPatternNames(pattern: t.PatternLike, into: Set<string>): void {
  if (t.isIdentifier(pattern)) {
    into.add(pattern.name)
    return
  }
  if (t.isRestElement(pattern)) {
    if (t.isIdentifier(pattern.argument)) into.add(pattern.argument.name)
    else collectPatternNames(pattern.argument as t.PatternLike, into)
    return
  }
  if (t.isAssignmentPattern(pattern)) {
    collectPatternNames(pattern.left as t.PatternLike, into)
    return
  }
  if (t.isArrayPattern(pattern)) {
    for (const elem of pattern.elements) {
      if (elem) collectPatternNames(elem as t.PatternLike, into)
    }
    return
  }
  if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isObjectProperty(prop)) {
        collectPatternNames(prop.value as t.PatternLike, into)
      } else if (t.isRestElement(prop)) {
        collectPatternNames(prop.argument as t.PatternLike, into)
      }
    }
  }
}

interface ReactiveContext {
  reactiveSources: Set<string>
  reactiveVars: Set<string>
  storeVars: Set<string>
}

function buildReactiveContext(fn: HIRFunction): ReactiveContext {
  const reactiveSources = new Set<string>()
  const storeVars = new Set<string>()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const calleeName = getAssignedCalleeName(instr.value)
      if (!calleeName) continue
      if (calleeName === '$state' || calleeName === 'createSignal') {
        reactiveSources.add(instr.target.name)
      } else if (calleeName === '$store' || calleeName === 'createStore') {
        reactiveSources.add(instr.target.name)
        storeVars.add(instr.target.name)
      } else if (calleeName === '$memo' || calleeName === 'createMemo') {
        reactiveSources.add(instr.target.name)
      }
    }
  }

  const reactiveVars = new Set(reactiveSources)
  let changed = true
  while (changed) {
    changed = false
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind !== 'Assign') continue
        if (reactiveVars.has(instr.target.name)) continue
        if (
          expressionDependsOnReactive(instr.value, { reactiveSources, reactiveVars, storeVars })
        ) {
          reactiveVars.add(instr.target.name)
          changed = true
        }
      }
    }
  }

  return { reactiveSources, reactiveVars, storeVars }
}

function getAssignedCalleeName(expr: Expression): string | null {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return null
  if (expr.callee.kind === 'Identifier') return expr.callee.name
  return getCalleeName(expr.callee) ?? null
}

function expressionDependsOnReactive(expr: Expression, ctx: ReactiveContext): boolean {
  switch (expr.kind) {
    case 'Identifier':
      return ctx.reactiveVars.has(expr.name)
    case 'CallExpression':
    case 'OptionalCallExpression': {
      if (expressionDependsOnReactive(expr.callee as Expression, ctx)) return true
      return expr.arguments.some(arg => expressionDependsOnReactive(arg as Expression, ctx))
    }
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      if (expr.object.kind === 'Identifier' && ctx.storeVars.has(expr.object.name)) return true
      if (expressionDependsOnReactive(expr.object as Expression, ctx)) return true
      if (expr.computed && expressionDependsOnReactive(expr.property as Expression, ctx))
        return true
      return false
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        expressionDependsOnReactive(expr.left as Expression, ctx) ||
        expressionDependsOnReactive(expr.right as Expression, ctx)
      )
    case 'UnaryExpression':
      return expressionDependsOnReactive(expr.argument as Expression, ctx)
    case 'ConditionalExpression':
      return (
        expressionDependsOnReactive(expr.test as Expression, ctx) ||
        expressionDependsOnReactive(expr.consequent as Expression, ctx) ||
        expressionDependsOnReactive(expr.alternate as Expression, ctx)
      )
    case 'ArrayExpression':
      return expr.elements.some(el =>
        el ? expressionDependsOnReactive(el as Expression, ctx) : false,
      )
    case 'ObjectExpression':
      return expr.properties.some(prop => {
        if (prop.kind === 'SpreadElement') {
          return expressionDependsOnReactive(prop.argument as Expression, ctx)
        }
        // HIR ObjectProperty doesn't have computed keys - computed is only on MemberExpression
        return expressionDependsOnReactive(prop.value as Expression, ctx)
      })
    case 'TemplateLiteral':
      return expr.expressions.some(e => expressionDependsOnReactive(e as Expression, ctx))
    case 'SpreadElement':
      return expressionDependsOnReactive(expr.argument as Expression, ctx)
    case 'SequenceExpression':
      return expr.expressions.some(e => expressionDependsOnReactive(e as Expression, ctx))
    case 'AwaitExpression':
      return expressionDependsOnReactive(expr.argument as Expression, ctx)
    case 'NewExpression':
      if (expressionDependsOnReactive(expr.callee as Expression, ctx)) return true
      return expr.arguments.some(arg => expressionDependsOnReactive(arg as Expression, ctx))
    case 'ArrowFunction':
    case 'FunctionExpression':
      return false
    case 'AssignmentExpression':
      return (
        expressionDependsOnReactive(expr.left as Expression, ctx) ||
        expressionDependsOnReactive(expr.right as Expression, ctx)
      )
    case 'UpdateExpression':
      return expressionDependsOnReactive(expr.argument as Expression, ctx)
    case 'JSXElement':
      return true
    default:
      return false
  }
}

function getMemberBaseIdentifier(expr: Expression): Identifier | null {
  if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return null
  let current: Expression = expr.object as Expression
  while (current.kind === 'MemberExpression' || current.kind === 'OptionalMemberExpression') {
    current = current.object as Expression
  }
  return current.kind === 'Identifier' ? current : null
}

function collectWriteTargets(expr: Expression): Set<string> {
  const writes = new Set<string>()
  const visit = (node: Expression): void => {
    switch (node.kind) {
      case 'AssignmentExpression': {
        const left = node.left as Expression
        if (left.kind === 'Identifier') {
          writes.add(left.name)
        } else if (left.kind === 'MemberExpression' || left.kind === 'OptionalMemberExpression') {
          const base = getMemberBaseIdentifier(left)
          if (base) writes.add(base.name)
        } else {
          visit(left)
        }
        visit(node.right as Expression)
        return
      }
      case 'UpdateExpression': {
        const arg = node.argument as Expression
        if (arg.kind === 'Identifier') {
          writes.add(arg.name)
          return
        }
        if (arg.kind === 'MemberExpression' || arg.kind === 'OptionalMemberExpression') {
          const base = getMemberBaseIdentifier(arg)
          if (base) {
            writes.add(base.name)
            return
          }
        }
        visit(arg)
        return
      }
      case 'CallExpression':
      case 'OptionalCallExpression':
        visit(node.callee as Expression)
        node.arguments.forEach(arg => visit(arg as Expression))
        return
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visit(node.object as Expression)
        if (node.computed) visit(node.property as Expression)
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
        visit(node.left as Expression)
        visit(node.right as Expression)
        return
      case 'UnaryExpression':
        visit(node.argument as Expression)
        return
      case 'ConditionalExpression':
        visit(node.test as Expression)
        visit(node.consequent as Expression)
        visit(node.alternate as Expression)
        return
      case 'ArrayExpression':
        node.elements.forEach(el => {
          if (el) visit(el as Expression)
        })
        return
      case 'ObjectExpression':
        node.properties.forEach(prop => {
          if (prop.kind === 'SpreadElement') {
            visit(prop.argument as Expression)
          } else {
            visit(prop.value as Expression)
          }
        })
        return
      case 'TemplateLiteral':
        node.expressions.forEach(e => visit(e as Expression))
        return
      case 'SpreadElement':
        visit(node.argument as Expression)
        return
      case 'SequenceExpression':
        node.expressions.forEach(e => visit(e as Expression))
        return
      case 'AwaitExpression':
        visit(node.argument as Expression)
        return
      case 'NewExpression':
        visit(node.callee as Expression)
        node.arguments.forEach(arg => visit(arg as Expression))
        return
      case 'ArrowFunction':
      case 'FunctionExpression':
        return
      default:
        return
    }
  }
  visit(expr)
  return writes
}

function collectMemberCallTargets(expr: Expression): Set<string> {
  const targets = new Set<string>()
  const visit = (node: Expression): void => {
    switch (node.kind) {
      case 'CallExpression':
      case 'OptionalCallExpression': {
        const callee = node.callee as Expression
        if (callee.kind === 'MemberExpression' || callee.kind === 'OptionalMemberExpression') {
          const base = getMemberBaseIdentifier(callee)
          if (base) targets.add(base.name)
        }
        visit(callee)
        node.arguments.forEach(arg => visit(arg as Expression))
        return
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visit(node.object as Expression)
        if (node.computed) visit(node.property as Expression)
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
        visit(node.left as Expression)
        visit(node.right as Expression)
        return
      case 'UnaryExpression':
        visit(node.argument as Expression)
        return
      case 'ConditionalExpression':
        visit(node.test as Expression)
        visit(node.consequent as Expression)
        visit(node.alternate as Expression)
        return
      case 'ArrayExpression':
        node.elements.forEach(el => {
          if (el) visit(el as Expression)
        })
        return
      case 'ObjectExpression':
        node.properties.forEach(prop => {
          if (prop.kind === 'SpreadElement') {
            visit(prop.argument as Expression)
          } else {
            visit(prop.value as Expression)
          }
        })
        return
      case 'TemplateLiteral':
        node.expressions.forEach(e => visit(e as Expression))
        return
      case 'SpreadElement':
        visit(node.argument as Expression)
        return
      case 'SequenceExpression':
        node.expressions.forEach(e => visit(e as Expression))
        return
      case 'AwaitExpression':
        visit(node.argument as Expression)
        return
      case 'NewExpression':
        visit(node.callee as Expression)
        node.arguments.forEach(arg => visit(arg as Expression))
        return
      case 'AssignmentExpression':
        visit(node.left as Expression)
        visit(node.right as Expression)
        return
      case 'UpdateExpression':
        visit(node.argument as Expression)
        return
      case 'ArrowFunction':
      case 'FunctionExpression':
        return
      default:
        return
    }
  }
  visit(expr)
  return targets
}

function countAssignments(fn: HIRFunction): Map<string, number> {
  const counts = new Map<string, number>()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      counts.set(instr.target.name, (counts.get(instr.target.name) ?? 0) + 1)
    }
  }
  return counts
}

function countAssignmentsByBase(fn: HIRFunction): Map<string, number> {
  const counts = new Map<string, number>()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const base = getSSABaseName(instr.target.name)
      counts.set(base, (counts.get(base) ?? 0) + 1)
    }
  }
  return counts
}

function countIdentifierUses(fn: HIRFunction): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        collectExpressionIdentifiers(instr.value, true).forEach(add)
      } else if (instr.kind === 'Expression') {
        collectExpressionIdentifiers(instr.value, true).forEach(add)
      } else if (instr.kind === 'Phi') {
        instr.sources.forEach(src => add(src.id.name))
      }
    }
    collectTerminatorIdentifiers(block.terminator).forEach(add)
  }
  return counts
}

function terminatorContainsImpureMarkers(term: Terminator): boolean {
  switch (term.kind) {
    case 'Return':
      return term.argument ? expressionContainsImpureMarkers(term.argument) : false
    case 'Throw':
      return expressionContainsImpureMarkers(term.argument)
    case 'Branch':
      return expressionContainsImpureMarkers(term.test)
    case 'Switch':
      if (expressionContainsImpureMarkers(term.discriminant)) return true
      return term.cases.some(c => (c.test ? expressionContainsImpureMarkers(c.test) : false))
    case 'ForOf':
      return expressionContainsImpureMarkers(term.iterable)
    case 'ForIn':
      return expressionContainsImpureMarkers(term.object)
    default:
      return false
  }
}

function expressionContainsImpureMarkers(expr: Expression): boolean {
  switch (expr.kind) {
    case 'JSXElement':
      return true
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const calleeName =
        expr.callee.kind === 'Identifier' ? expr.callee.name : getCalleeName(expr.callee)
      if (calleeName && IMPURE_CALLEES.has(calleeName)) return true
      if (expressionContainsImpureMarkers(expr.callee as Expression)) return true
      return expr.arguments.some(arg => expressionContainsImpureMarkers(arg as Expression))
    }
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      if (expressionContainsImpureMarkers(expr.object as Expression)) return true
      if (expr.computed && expressionContainsImpureMarkers(expr.property as Expression)) return true
      return false
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        expressionContainsImpureMarkers(expr.left as Expression) ||
        expressionContainsImpureMarkers(expr.right as Expression)
      )
    case 'UnaryExpression':
      return expressionContainsImpureMarkers(expr.argument as Expression)
    case 'ConditionalExpression':
      return (
        expressionContainsImpureMarkers(expr.test as Expression) ||
        expressionContainsImpureMarkers(expr.consequent as Expression) ||
        expressionContainsImpureMarkers(expr.alternate as Expression)
      )
    case 'ArrayExpression':
      return expr.elements.some(el =>
        el ? expressionContainsImpureMarkers(el as Expression) : false,
      )
    case 'ObjectExpression':
      return expr.properties.some(prop => {
        if (prop.kind === 'SpreadElement') {
          return expressionContainsImpureMarkers(prop.argument as Expression)
        }
        return expressionContainsImpureMarkers(prop.value as Expression)
      })
    case 'TemplateLiteral':
      return expr.expressions.some(e => expressionContainsImpureMarkers(e as Expression))
    case 'SpreadElement':
      return expressionContainsImpureMarkers(expr.argument as Expression)
    case 'SequenceExpression':
      return expr.expressions.some(e => expressionContainsImpureMarkers(e as Expression))
    case 'AwaitExpression':
      return expressionContainsImpureMarkers(expr.argument as Expression)
    case 'NewExpression':
      if (expressionContainsImpureMarkers(expr.callee as Expression)) return true
      return expr.arguments.some(arg => expressionContainsImpureMarkers(arg as Expression))
    case 'ArrowFunction':
      if (expr.isExpression) {
        return expressionContainsImpureMarkers(expr.body as Expression)
      }
      return blocksContainImpureMarkers(expr.body as BasicBlock[])
    case 'FunctionExpression':
      return blocksContainImpureMarkers(expr.body)
    case 'AssignmentExpression':
      return (
        expressionContainsImpureMarkers(expr.left as Expression) ||
        expressionContainsImpureMarkers(expr.right as Expression)
      )
    case 'UpdateExpression':
      return expressionContainsImpureMarkers(expr.argument as Expression)
    default:
      return false
  }
}

function blocksContainImpureMarkers(blocks: BasicBlock[]): boolean {
  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        if (expressionContainsImpureMarkers(instr.value)) return true
      }
    }
    if (terminatorContainsImpureMarkers(block.terminator)) return true
  }
  return false
}

function propagateConstants(fn: HIRFunction): HIRFunction {
  const constants = computeConstantMap(fn)
  if (constants.size === 0) return fn
  const blocks = fn.blocks.map(block => ({
    ...block,
    instructions: block.instructions.map(instr => {
      if (instr.kind === 'Assign') {
        const replaced = replaceIdentifiersWithConstants(instr.value, constants)
        const folded = foldExpression(replaced, constants)
        return { ...instr, value: folded }
      }
      if (instr.kind === 'Expression') {
        const replaced = replaceIdentifiersWithConstants(instr.value, constants)
        const folded = foldExpression(replaced, constants)
        return { ...instr, value: folded }
      }
      if (instr.kind === 'Phi') {
        return instr
      }
      return instr
    }),
    terminator: replaceConstantsInTerminator(block.terminator, constants),
  }))
  return { ...fn, blocks }
}

function computeConstantMap(fn: HIRFunction): Map<string, ConstantValue> {
  const constants = new Map<string, ConstantValue>()
  let changed = true
  let iterations = 0
  const maxIterations = 10
  while (changed && iterations < maxIterations) {
    iterations += 1
    changed = false
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign') {
          const value = evaluateConstant(instr.value, constants)
          if (value !== UNKNOWN_CONST) {
            const existing = constants.get(instr.target.name)
            if (!constants.has(instr.target.name) || existing !== value) {
              constants.set(instr.target.name, value as ConstantValue)
              changed = true
            }
          }
        } else if (instr.kind === 'Phi') {
          const resolved = resolvePhiConstant(instr, constants)
          if (resolved !== UNKNOWN_CONST) {
            const existing = constants.get(instr.target.name)
            if (!constants.has(instr.target.name) || existing !== resolved) {
              constants.set(instr.target.name, resolved as ConstantValue)
              changed = true
            }
          }
        }
      }
    }
  }
  return constants
}

function resolvePhiConstant(
  instr: Instruction & { kind: 'Phi' },
  constants: Map<string, ConstantValue>,
): ConstantValue | typeof UNKNOWN_CONST {
  if (instr.sources.length === 0) return UNKNOWN_CONST
  let candidate: ConstantValue | typeof UNKNOWN_CONST = UNKNOWN_CONST
  for (const src of instr.sources) {
    if (!constants.has(src.id.name)) return UNKNOWN_CONST
    const value = constants.get(src.id.name)
    if (candidate === UNKNOWN_CONST) {
      candidate = value
      continue
    }
    if (candidate !== value) return UNKNOWN_CONST
  }
  return candidate
}

function evaluateConstant(
  expr: Expression,
  constants: Map<string, ConstantValue>,
): ConstantValue | typeof UNKNOWN_CONST {
  const value = evaluateLiteral(expr, constants)
  if (value === UNKNOWN_CONST) return UNKNOWN_CONST
  return value
}

function evaluateLiteral(
  expr: Expression,
  constants: Map<string, ConstantValue>,
): ConstantValue | typeof UNKNOWN_CONST {
  switch (expr.kind) {
    case 'Literal':
      if (expr.value instanceof RegExp || typeof expr.value === 'bigint') return UNKNOWN_CONST
      return expr.value
    case 'Identifier':
      return constants.has(expr.name) ? (constants.get(expr.name) as ConstantValue) : UNKNOWN_CONST
    case 'UnaryExpression': {
      const arg = evaluateLiteral(expr.argument as Expression, constants)
      if (arg === UNKNOWN_CONST) return UNKNOWN_CONST
      switch (expr.operator) {
        case '!':
          return !arg
        case '+':
          return typeof arg === 'number' ? +arg : Number(arg)
        case '-':
          return typeof arg === 'number' ? -arg : -Number(arg)
        case '~':
          return typeof arg === 'number' ? ~arg : UNKNOWN_CONST
        default:
          return UNKNOWN_CONST
      }
    }
    case 'BinaryExpression': {
      const left = evaluateLiteral(expr.left as Expression, constants)
      if (left === UNKNOWN_CONST) return UNKNOWN_CONST
      const right = evaluateLiteral(expr.right as Expression, constants)
      if (right === UNKNOWN_CONST) return UNKNOWN_CONST
      return evaluateBinary(expr.operator, left, right)
    }
    case 'LogicalExpression': {
      const left = evaluateLiteral(expr.left as Expression, constants)
      if (left === UNKNOWN_CONST) return UNKNOWN_CONST
      if (expr.operator === '&&') {
        return left ? evaluateLiteral(expr.right as Expression, constants) : left
      }
      if (expr.operator === '||') {
        return left ? left : evaluateLiteral(expr.right as Expression, constants)
      }
      if (expr.operator === '??') {
        return left ?? evaluateLiteral(expr.right as Expression, constants)
      }
      return UNKNOWN_CONST
    }
    case 'ConditionalExpression': {
      const test = evaluateLiteral(expr.test as Expression, constants)
      if (test === UNKNOWN_CONST) return UNKNOWN_CONST
      return test
        ? evaluateLiteral(expr.consequent as Expression, constants)
        : evaluateLiteral(expr.alternate as Expression, constants)
    }
    case 'TemplateLiteral': {
      const parts: string[] = []
      for (let i = 0; i < expr.quasis.length; i++) {
        parts.push(expr.quasis[i] ?? '')
        if (i < expr.expressions.length) {
          const value = evaluateLiteral(expr.expressions[i] as Expression, constants)
          if (value === UNKNOWN_CONST) return UNKNOWN_CONST
          parts.push(String(value))
        }
      }
      return parts.join('')
    }
    case 'SequenceExpression': {
      if (expr.expressions.length === 0) return UNKNOWN_CONST
      let value: ConstantValue | typeof UNKNOWN_CONST = UNKNOWN_CONST
      for (const item of expr.expressions) {
        value = evaluateLiteral(item as Expression, constants)
        if (value === UNKNOWN_CONST) return UNKNOWN_CONST
      }
      return value
    }
    default:
      return UNKNOWN_CONST
  }
}

function getObjectLiteralKey(key: Expression): string | null {
  if (key.kind === 'Identifier') return key.name
  if (key.kind === 'Literal') {
    if (typeof key.value === 'string' || typeof key.value === 'number') {
      return String(key.value)
    }
  }
  return null
}

function extractConstObjectFields(
  expr: Expression,
  constants: Map<string, ConstantValue>,
): ConstObjectFields | null {
  if (expr.kind !== 'ObjectExpression') return null
  const fields: ConstObjectFields = new Map()
  for (const prop of expr.properties) {
    if (prop.kind === 'SpreadElement') return null
    const key = getObjectLiteralKey(prop.key as Expression)
    if (!key) return null
    const value = evaluateLiteral(prop.value as Expression, constants)
    if (value === UNKNOWN_CONST) return null
    fields.set(key, value as ConstantValue)
  }
  return fields
}

function extractConstArrayElements(
  expr: Expression,
  constants: Map<string, ConstantValue>,
): ConstArrayElements | null {
  if (expr.kind !== 'ArrayExpression') return null
  const elements: ConstArrayElements = new Map()
  for (let i = 0; i < expr.elements.length; i++) {
    const value = evaluateLiteral(expr.elements[i] as Expression, constants)
    if (value === UNKNOWN_CONST) return null
    elements.set(i, value as ConstantValue)
  }
  return elements
}

function getStaticMemberKey(expr: Expression, computed: boolean): string | number | null {
  if (!computed && expr.kind === 'Identifier') return expr.name
  if (expr.kind === 'Literal') {
    if (typeof expr.value === 'string' || typeof expr.value === 'number') {
      return expr.value
    }
  }
  return null
}

function replaceConstMemberExpressions(
  expr: Expression,
  constObjects: Map<string, ConstObjectFields>,
  constArrays: Map<string, ConstArrayElements>,
): Expression {
  switch (expr.kind) {
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const object = replaceConstMemberExpressions(
        expr.object as Expression,
        constObjects,
        constArrays,
      )
      const property = expr.computed
        ? replaceConstMemberExpressions(expr.property as Expression, constObjects, constArrays)
        : expr.property
      if (object.kind === 'Identifier') {
        const key = getStaticMemberKey(property as Expression, expr.computed)
        if (key !== null) {
          const objectFields = constObjects.get(object.name)
          if (objectFields && objectFields.has(String(key))) {
            return { kind: 'Literal', value: objectFields.get(String(key)), loc: expr.loc }
          }
          const arrayElements = constArrays.get(object.name)
          if (arrayElements) {
            if (key === 'length') {
              return { kind: 'Literal', value: arrayElements.size, loc: expr.loc }
            }
            if (typeof key === 'number' && arrayElements.has(key)) {
              return { kind: 'Literal', value: arrayElements.get(key), loc: expr.loc }
            }
          }
        }
      }
      return { ...expr, object, property }
    }
    case 'CallExpression':
      return {
        ...expr,
        callee: replaceConstMemberExpressions(expr.callee as Expression, constObjects, constArrays),
        arguments: expr.arguments.map(arg =>
          replaceConstMemberExpressions(arg as Expression, constObjects, constArrays),
        ),
      }
    case 'OptionalCallExpression':
      return {
        ...expr,
        callee: replaceConstMemberExpressions(expr.callee as Expression, constObjects, constArrays),
        arguments: expr.arguments.map(arg =>
          replaceConstMemberExpressions(arg as Expression, constObjects, constArrays),
        ),
      }
    case 'BinaryExpression':
    case 'LogicalExpression':
      return {
        ...expr,
        left: replaceConstMemberExpressions(expr.left as Expression, constObjects, constArrays),
        right: replaceConstMemberExpressions(expr.right as Expression, constObjects, constArrays),
      }
    case 'UnaryExpression':
      return {
        ...expr,
        argument: replaceConstMemberExpressions(
          expr.argument as Expression,
          constObjects,
          constArrays,
        ),
      }
    case 'ConditionalExpression':
      return {
        ...expr,
        test: replaceConstMemberExpressions(expr.test as Expression, constObjects, constArrays),
        consequent: replaceConstMemberExpressions(
          expr.consequent as Expression,
          constObjects,
          constArrays,
        ),
        alternate: replaceConstMemberExpressions(
          expr.alternate as Expression,
          constObjects,
          constArrays,
        ),
      }
    case 'ArrayExpression':
      return {
        ...expr,
        elements: expr.elements.map(el =>
          replaceConstMemberExpressions(el as Expression, constObjects, constArrays),
        ),
      }
    case 'ObjectExpression':
      return {
        ...expr,
        properties: expr.properties.map(prop => {
          if (prop.kind === 'SpreadElement') {
            return {
              ...prop,
              argument: replaceConstMemberExpressions(
                prop.argument as Expression,
                constObjects,
                constArrays,
              ),
            }
          }
          return {
            ...prop,
            value: replaceConstMemberExpressions(
              prop.value as Expression,
              constObjects,
              constArrays,
            ),
          }
        }),
      }
    case 'TemplateLiteral':
      return {
        ...expr,
        expressions: expr.expressions.map(e =>
          replaceConstMemberExpressions(e as Expression, constObjects, constArrays),
        ),
      }
    case 'SpreadElement':
      return {
        ...expr,
        argument: replaceConstMemberExpressions(
          expr.argument as Expression,
          constObjects,
          constArrays,
        ),
      }
    case 'SequenceExpression':
      return {
        ...expr,
        expressions: expr.expressions.map(e =>
          replaceConstMemberExpressions(e as Expression, constObjects, constArrays),
        ),
      }
    case 'AwaitExpression':
      return {
        ...expr,
        argument: replaceConstMemberExpressions(
          expr.argument as Expression,
          constObjects,
          constArrays,
        ),
      }
    case 'NewExpression':
      return {
        ...expr,
        callee: replaceConstMemberExpressions(expr.callee as Expression, constObjects, constArrays),
        arguments: expr.arguments.map(arg =>
          replaceConstMemberExpressions(arg as Expression, constObjects, constArrays),
        ),
      }
    case 'AssignmentExpression':
      return {
        ...expr,
        left: replaceConstMemberExpressions(expr.left as Expression, constObjects, constArrays),
        right: replaceConstMemberExpressions(expr.right as Expression, constObjects, constArrays),
      }
    case 'UpdateExpression':
      return {
        ...expr,
        argument: replaceConstMemberExpressions(
          expr.argument as Expression,
          constObjects,
          constArrays,
        ),
      }
    case 'ArrowFunction':
    case 'FunctionExpression':
      return expr
    default:
      return expr
  }
}

function evaluateBinary(
  operator: string,
  left: ConstantValue,
  right: ConstantValue,
): ConstantValue | typeof UNKNOWN_CONST {
  try {
    switch (operator) {
      case '+':
        return (left as any) + (right as any)
      case '-':
        return (left as any) - (right as any)
      case '*':
        return (left as any) * (right as any)
      case '/':
        return (left as any) / (right as any)
      case '%':
        return (left as any) % (right as any)
      case '**':
        return (left as any) ** (right as any)
      case '===':
        return left === right
      case '!==':
        return left !== right
      case '==':
        return (left as any) == (right as any)
      case '!=':
        return (left as any) != (right as any)
      case '<':
        return (left as any) < (right as any)
      case '<=':
        return (left as any) <= (right as any)
      case '>':
        return (left as any) > (right as any)
      case '>=':
        return (left as any) >= (right as any)
      case '|':
        return (left as any) | (right as any)
      case '&':
        return (left as any) & (right as any)
      case '^':
        return (left as any) ^ (right as any)
      case '<<':
        return (left as any) << (right as any)
      case '>>':
        return (left as any) >> (right as any)
      case '>>>':
        return (left as any) >>> (right as any)
      default:
        return UNKNOWN_CONST
    }
  } catch {
    return UNKNOWN_CONST
  }
}

function foldExpression(expr: Expression, constants: Map<string, ConstantValue>): Expression {
  const value = evaluateConstant(expr, constants)
  if (value === UNKNOWN_CONST) {
    // Try algebraic simplification if constant folding failed
    return simplifyAlgebraically(expr, constants)
  }
  return { kind: 'Literal', value, loc: expr.loc }
}

/**
 * Algebraic simplification pass.
 * Applies conservative identity rules for arithmetic/logical operations.
 *
 * Arithmetic simplifications are intentionally limited here to avoid
 * changing JS coercion or special-case semantics without numeric proof.
 * Fully-constant expressions are handled by constant folding.
 *
 * Logical identities:
 *   true && x = x
 *   false || x = x
 *   false && x = false
 *   true || x = true
 *
 * Conditional identities:
 *   true ? a : b = a
 *   false ? a : b = b
 *   x ? a : a = (x, a) (preserve test evaluation)
 *
 * Comparison identities:
 *   x === x = true (for literals)
 *   x !== x = false (for literals)
 */
function simplifyAlgebraically(
  expr: Expression,
  constants: Map<string, ConstantValue>,
): Expression {
  // First, recursively simplify children
  const simplified = simplifyChildren(expr, constants)

  if (simplified.kind === 'BinaryExpression') {
    const { operator, left, right, loc } = simplified

    switch (operator) {
      case '===':
      case '==':
        // x === x for same literal values
        if (left.kind === 'Literal' && right.kind === 'Literal' && left.value === right.value) {
          return { kind: 'Literal', value: true, loc }
        }
        break

      case '!==':
      case '!=':
        // x !== x for same literal values
        if (left.kind === 'Literal' && right.kind === 'Literal' && left.value === right.value) {
          return { kind: 'Literal', value: false, loc }
        }
        break
    }
  }

  if (simplified.kind === 'LogicalExpression') {
    const { operator, left, right, loc } = simplified
    const leftConst = left.kind === 'Literal' ? left.value : undefined

    switch (operator) {
      case '&&':
        // true && x = x
        if (leftConst === true) return right
        // false && x = false
        if (leftConst === false) return { kind: 'Literal', value: false, loc }
        // x && false = false (but x might have side effects, so keep as-is)
        break

      case '||':
        // false || x = x
        if (leftConst === false) return right
        // true || x = true
        if (leftConst === true) return { kind: 'Literal', value: true, loc }
        // x || true = true (but x might have side effects, so keep as-is)
        break

      case '??':
        // non-nullish ?? x = non-nullish
        if (leftConst !== null && leftConst !== undefined && left.kind === 'Literal') {
          return left
        }
        // null ?? x = x, undefined ?? x = x
        if (leftConst === null || leftConst === undefined) return right
        break
    }
  }

  if (simplified.kind === 'UnaryExpression') {
    const { operator, argument, loc } = simplified

    switch (operator) {
      case '!':
        // !!x simplification (double negation)
        if (argument.kind === 'UnaryExpression' && argument.operator === '!' && argument.prefix) {
          // !!x where x is boolean literal
          const inner = argument.argument
          if (inner.kind === 'Literal' && typeof inner.value === 'boolean') {
            return inner
          }
        }
        // !true = false, !false = true
        if (argument.kind === 'Literal') {
          if (argument.value === true) return { kind: 'Literal', value: false, loc }
          if (argument.value === false) return { kind: 'Literal', value: true, loc }
        }
        break

      case '-':
        // --x = x (double negation for numbers)
        if (argument.kind === 'UnaryExpression' && argument.operator === '-' && argument.prefix) {
          return argument.argument
        }
        // -0 = 0 (but -0 is different in JS, so be careful)
        break

      case '+':
        // +x where x is already a number literal = x
        if (argument.kind === 'Literal' && typeof argument.value === 'number') {
          return argument
        }
        break
    }
  }

  if (simplified.kind === 'ConditionalExpression') {
    const { test, consequent, alternate, loc } = simplified

    // true ? a : b = a
    if (test.kind === 'Literal' && test.value === true) {
      return consequent
    }
    // false ? a : b = b
    if (test.kind === 'Literal' && test.value === false) {
      return alternate
    }
    // x ? a : a = a (when consequent and alternate are identical literals)
    if (
      consequent.kind === 'Literal' &&
      alternate.kind === 'Literal' &&
      consequent.value === alternate.value
    ) {
      return { kind: 'SequenceExpression', expressions: [test, consequent], loc }
    }
  }

  return simplified
}

/**
 * Recursively simplify children of an expression.
 */
function simplifyChildren(expr: Expression, constants: Map<string, ConstantValue>): Expression {
  switch (expr.kind) {
    case 'BinaryExpression':
      return {
        ...expr,
        left: simplifyAlgebraically(expr.left as Expression, constants),
        right: simplifyAlgebraically(expr.right as Expression, constants),
      }
    case 'LogicalExpression':
      return {
        ...expr,
        left: simplifyAlgebraically(expr.left as Expression, constants),
        right: simplifyAlgebraically(expr.right as Expression, constants),
      }
    case 'UnaryExpression':
      return {
        ...expr,
        argument: simplifyAlgebraically(expr.argument as Expression, constants),
      }
    case 'ConditionalExpression':
      return {
        ...expr,
        test: simplifyAlgebraically(expr.test as Expression, constants),
        consequent: simplifyAlgebraically(expr.consequent as Expression, constants),
        alternate: simplifyAlgebraically(expr.alternate as Expression, constants),
      }
    case 'ArrayExpression':
      return {
        ...expr,
        elements: expr.elements.map(el =>
          el ? simplifyAlgebraically(el as Expression, constants) : el,
        ),
      }
    case 'ObjectExpression':
      return {
        ...expr,
        properties: expr.properties.map(prop => {
          if (prop.kind === 'Property') {
            return {
              ...prop,
              value: simplifyAlgebraically(prop.value as Expression, constants),
            }
          }
          if (prop.kind === 'SpreadElement') {
            return {
              ...prop,
              argument: simplifyAlgebraically(prop.argument as Expression, constants),
            }
          }
          return prop
        }),
      }
    case 'CallExpression':
    case 'OptionalCallExpression':
      return {
        ...expr,
        arguments: expr.arguments.map(arg => simplifyAlgebraically(arg, constants)),
      }
    case 'ImportExpression':
      return {
        ...expr,
        source: simplifyAlgebraically(expr.source as Expression, constants),
      }
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return {
        ...expr,
        object: simplifyAlgebraically(expr.object as Expression, constants),
        property: expr.computed
          ? simplifyAlgebraically(expr.property as Expression, constants)
          : expr.property,
      }
    default:
      return expr
  }
}

function foldExpressionWithConstants(
  expr: Expression,
  constants: Map<string, ConstantValue>,
  constObjects?: Map<string, ConstObjectFields>,
  constArrays?: Map<string, ConstArrayElements>,
): Expression {
  const replaced = replaceIdentifiersWithConstants(expr, constants)
  if (!constObjects && !constArrays) {
    return foldExpression(replaced, constants)
  }
  const memberReplaced = replaceConstMemberExpressions(
    replaced,
    constObjects ?? new Map(),
    constArrays ?? new Map(),
  )
  return foldExpression(memberReplaced, constants)
}

function replaceIdentifiersWithConstants(
  expr: Expression,
  constants: Map<string, ConstantValue>,
  context: { inCallee?: boolean } = {},
): Expression {
  switch (expr.kind) {
    case 'Identifier':
      if (!context.inCallee && constants.has(expr.name)) {
        return { kind: 'Literal', value: constants.get(expr.name), loc: expr.loc }
      }
      return expr
    case 'CallExpression':
      return {
        ...expr,
        callee: replaceIdentifiersWithConstants(expr.callee as Expression, constants, {
          inCallee: true,
        }),
        arguments: expr.arguments.map(arg => replaceIdentifiersWithConstants(arg, constants)),
      }
    case 'OptionalCallExpression':
      return {
        ...expr,
        callee: replaceIdentifiersWithConstants(expr.callee as Expression, constants, {
          inCallee: true,
        }),
        arguments: expr.arguments.map(arg => replaceIdentifiersWithConstants(arg, constants)),
      }
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const member = expr
      return {
        ...member,
        object: replaceIdentifiersWithConstants(member.object as Expression, constants, {
          inCallee: false,
        }),
        property: member.computed
          ? replaceIdentifiersWithConstants(member.property as Expression, constants)
          : member.property,
      }
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      return {
        ...expr,
        left: replaceIdentifiersWithConstants(expr.left as Expression, constants),
        right: replaceIdentifiersWithConstants(expr.right as Expression, constants),
      }
    case 'UnaryExpression':
      return {
        ...expr,
        argument: replaceIdentifiersWithConstants(expr.argument as Expression, constants),
      }
    case 'ConditionalExpression':
      return {
        ...expr,
        test: replaceIdentifiersWithConstants(expr.test as Expression, constants),
        consequent: replaceIdentifiersWithConstants(expr.consequent as Expression, constants),
        alternate: replaceIdentifiersWithConstants(expr.alternate as Expression, constants),
      }
    case 'ArrayExpression':
      return {
        ...expr,
        elements: expr.elements.map(el =>
          el ? replaceIdentifiersWithConstants(el as Expression, constants) : el,
        ),
      }
    case 'ObjectExpression':
      return {
        ...expr,
        properties: expr.properties.map(prop => {
          if (prop.kind === 'SpreadElement') {
            return {
              ...prop,
              argument: replaceIdentifiersWithConstants(prop.argument as Expression, constants),
            }
          }
          return {
            ...prop,
            value: replaceIdentifiersWithConstants(prop.value as Expression, constants),
            key: prop.key,
          }
        }),
      }
    case 'TemplateLiteral':
      return {
        ...expr,
        expressions: expr.expressions.map(e =>
          replaceIdentifiersWithConstants(e as Expression, constants),
        ),
      }
    case 'SpreadElement':
      return {
        ...expr,
        argument: replaceIdentifiersWithConstants(expr.argument as Expression, constants),
      }
    case 'SequenceExpression':
      return {
        ...expr,
        expressions: expr.expressions.map(e =>
          replaceIdentifiersWithConstants(e as Expression, constants),
        ),
      }
    case 'AwaitExpression':
      return {
        ...expr,
        argument: replaceIdentifiersWithConstants(expr.argument as Expression, constants),
      }
    case 'NewExpression':
      return {
        ...expr,
        callee: replaceIdentifiersWithConstants(expr.callee as Expression, constants, {
          inCallee: true,
        }),
        arguments: expr.arguments.map(arg => replaceIdentifiersWithConstants(arg, constants)),
      }
    case 'ImportExpression':
      return {
        ...expr,
        source: replaceIdentifiersWithConstants(expr.source as Expression, constants),
      }
    default:
      return expr
  }
}

function replaceConstantsInTerminator(
  term: Terminator,
  constants: Map<string, ConstantValue>,
): Terminator {
  switch (term.kind) {
    case 'Return':
      return {
        ...term,
        argument: term.argument
          ? replaceIdentifiersWithConstants(term.argument as Expression, constants)
          : term.argument,
      }
    case 'Throw':
      return {
        ...term,
        argument: replaceIdentifiersWithConstants(term.argument as Expression, constants),
      }
    case 'Branch':
      return {
        ...term,
        test: replaceIdentifiersWithConstants(term.test as Expression, constants),
      }
    case 'Switch':
      return {
        ...term,
        discriminant: replaceIdentifiersWithConstants(term.discriminant as Expression, constants),
        cases: term.cases.map(c => ({
          ...c,
          test: c.test ? replaceIdentifiersWithConstants(c.test as Expression, constants) : c.test,
        })),
      }
    case 'ForOf':
      return {
        ...term,
        iterable: replaceIdentifiersWithConstants(term.iterable as Expression, constants),
      }
    case 'ForIn':
      return {
        ...term,
        object: replaceIdentifiersWithConstants(term.object as Expression, constants),
      }
    case 'Try':
      return term
    default:
      return term
  }
}

function foldTerminatorWithConstants(
  term: Terminator,
  constants: Map<string, ConstantValue>,
  reactive?: ReactiveContext,
  constObjects?: Map<string, ConstObjectFields>,
  constArrays?: Map<string, ConstArrayElements>,
): Terminator {
  const fold = (expr: Expression) => {
    if (reactive && expressionDependsOnReactive(expr, reactive)) return expr
    return foldExpressionWithConstants(expr, constants, constObjects, constArrays)
  }
  switch (term.kind) {
    case 'Return':
      return {
        ...term,
        argument: term.argument ? fold(term.argument as Expression) : term.argument,
      }
    case 'Throw':
      return { ...term, argument: fold(term.argument as Expression) }
    case 'Branch':
      return { ...term, test: fold(term.test as Expression) }
    case 'Switch':
      return {
        ...term,
        discriminant: fold(term.discriminant as Expression),
        cases: term.cases.map(c => ({
          ...c,
          test: c.test ? fold(c.test as Expression) : c.test,
        })),
      }
    case 'ForOf':
      return { ...term, iterable: fold(term.iterable as Expression) }
    case 'ForIn':
      return { ...term, object: fold(term.object as Expression) }
    case 'Try':
      return term
    default:
      return term
  }
}

function eliminateCommonSubexpressions(fn: HIRFunction, purity: PurityContext): HIRFunction {
  const blocks = fn.blocks.map(block => {
    const cseMap = new Map<string, string>()
    const newInstructions = block.instructions.map(instr => {
      if (instr.kind !== 'Assign') return instr
      if (!isPureExpression(instr.value, purity)) return instr
      if (isExplicitMemoCall(instr.value, purity)) return instr
      const deps = collectExpressionIdentifiers(instr.value)
      const hash = `${hashExpression(instr.value)}|${[...deps].sort().join(',')}`
      const existing = cseMap.get(hash)
      if (existing && existing !== instr.target.name) {
        return {
          ...instr,
          value: { kind: 'Identifier', name: existing, loc: instr.value.loc } as Identifier,
        }
      }
      cseMap.set(hash, instr.target.name)
      return instr
    })
    return { ...block, instructions: newInstructions }
  })
  return { ...fn, blocks }
}

function inlineSingleUse(fn: HIRFunction, purity: PurityContext): HIRFunction {
  const defUse = buildDefUse(fn)
  const blockMap = new Map<number, BasicBlock>()
  fn.blocks.forEach(block => blockMap.set(block.id, block))
  const newBlocks: BasicBlock[] = fn.blocks.map(block => {
    const instructions = [...block.instructions]
    const toRemove = new Set<number>()
    for (let i = 0; i < instructions.length; i++) {
      const instr = instructions[i]
      if (instr.kind !== 'Assign') continue
      const target = instr.target.name
      const info = defUse.get(target)
      if (!info || info.uses.length !== 1) continue
      if (!isPureExpression(instr.value, purity)) continue
      if (isExplicitMemoCall(instr.value, purity)) continue
      const use = info.uses[0]!
      if (use.inFunctionBody) continue
      if (use.blockId !== block.id) continue
      if (use.kind === 'Phi') continue
      const useIndex = use.kind === 'Terminator' ? Number.POSITIVE_INFINITY : use.instrIndex
      if (useIndex <= i) continue
      if (hasSideEffectsBetween(instructions, i + 1, useIndex, purity)) continue
      // Inline into use location
      if (use.kind === 'Assign') {
        const useInstr = instructions[use.instrIndex]
        if (useInstr && useInstr.kind === 'Assign') {
          instructions[use.instrIndex] = {
            ...useInstr,
            value: replaceIdentifier(useInstr.value, target, instr.value, false),
          }
        }
      } else if (use.kind === 'Expression') {
        const useInstr = instructions[use.instrIndex]
        if (useInstr && useInstr.kind === 'Expression') {
          instructions[use.instrIndex] = {
            ...useInstr,
            value: replaceIdentifier(useInstr.value, target, instr.value, false),
          }
        }
      } else if (use.kind === 'Terminator') {
        const term = block.terminator
        block.terminator = replaceIdentifierInTerminator(term, target, instr.value)
      }
      toRemove.add(i)
    }
    const filtered = instructions.filter((_, idx) => !toRemove.has(idx))
    return { ...block, instructions: filtered }
  })
  return { ...fn, blocks: newBlocks }
}

function hasSideEffectsBetween(
  instructions: Instruction[],
  start: number,
  end: number,
  purity: PurityContext,
): boolean {
  for (let i = start; i < Math.min(end, instructions.length); i++) {
    const instr = instructions[i]
    if (instr.kind === 'Expression') {
      if (!isPureExpression(instr.value, purity)) return true
    } else if (instr.kind === 'Assign') {
      if (!isPureExpression(instr.value, purity)) return true
    }
  }
  return false
}

function eliminateDeadCode(fn: HIRFunction, purity: PurityContext): HIRFunction {
  const depsByVar = buildDependencyGraph(fn)
  const live = computeLiveVariables(fn, depsByVar, purity)
  const blocks = fn.blocks.map(block => {
    const instructions = block.instructions.filter(instr => {
      if (instr.kind === 'Assign') {
        const name = instr.target.name
        if (live.has(name)) return true
        return !isPureExpression(instr.value, purity) || isExplicitMemoCall(instr.value, purity)
      }
      if (instr.kind === 'Phi') {
        return live.has(instr.target.name)
      }
      return true
    })
    return { ...block, instructions }
  })
  return { ...fn, blocks }
}

function buildDependencyGraph(fn: HIRFunction): Map<string, Set<string>> {
  const depsByVar = new Map<string, Set<string>>()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        depsByVar.set(instr.target.name, collectExpressionIdentifiers(instr.value, true))
      } else if (instr.kind === 'Phi') {
        const deps = new Set<string>()
        instr.sources.forEach(src => deps.add(src.id.name))
        depsByVar.set(instr.target.name, deps)
      }
    }
  }
  return depsByVar
}

function computeLiveVariables(
  fn: HIRFunction,
  depsByVar: Map<string, Set<string>>,
  purity: PurityContext,
): Set<string> {
  const roots = new Set<string>()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Expression') {
        collectExpressionIdentifiers(instr.value, true).forEach(dep => roots.add(dep))
      } else if (instr.kind === 'Assign') {
        if (!isPureExpression(instr.value, purity)) {
          collectExpressionIdentifiers(instr.value, true).forEach(dep => roots.add(dep))
        } else if (isExplicitMemoCall(instr.value, purity)) {
          collectExpressionIdentifiers(instr.value, true).forEach(dep => roots.add(dep))
          roots.add(instr.target.name)
        }
      }
    }
    collectTerminatorIdentifiers(block.terminator).forEach(dep => roots.add(dep))
  }

  const live = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const name = stack.pop()!
    if (live.has(name)) continue
    live.add(name)
    const deps = depsByVar.get(name)
    if (!deps) continue
    deps.forEach(dep => {
      if (!live.has(dep)) stack.push(dep)
    })
  }
  return live
}

function eliminatePhiNodes(fn: HIRFunction): HIRFunction {
  const predecessors = collectPredecessors(fn.blocks)
  const phiMap = new Map<number, Instruction[]>()
  fn.blocks.forEach(block => {
    const phis = block.instructions.filter(instr => instr.kind === 'Phi')
    if (phis.length > 0) {
      phiMap.set(block.id, phis)
    }
  })

  const copiesByPred = new Map<number, { from: string; to: string }[]>()
  for (const [blockId, phis] of phiMap.entries()) {
    const preds = predecessors.get(blockId) ?? []
    for (const pred of preds) {
      for (const phi of phis) {
        if (phi.kind !== 'Phi') continue
        const source = phi.sources.find(s => s.block === pred)
        if (!source) continue
        if (source.id.name === phi.target.name) continue
        const arr = copiesByPred.get(pred) ?? []
        arr.push({ from: source.id.name, to: phi.target.name })
        copiesByPred.set(pred, arr)
      }
    }
  }

  const blocks = fn.blocks.map(block => {
    const extraCopies = copiesByPred.get(block.id)
    const extraInstr =
      extraCopies && extraCopies.length > 0 ? resolveParallelCopies(extraCopies) : []
    const filtered = block.instructions.filter(instr => instr.kind !== 'Phi')
    return {
      ...block,
      instructions: [...filtered, ...extraInstr],
    }
  })
  return { ...fn, blocks }
}

function resolveParallelCopies(copies: { from: string; to: string }[]): Instruction[] {
  const pending = copies.filter(c => c.from !== c.to).map(c => ({ from: c.from, to: c.to }))
  const result: Instruction[] = []
  let tempIndex = 0

  const emitAssign = (to: string, from: string, declKind?: 'const' | 'let') => {
    result.push({
      kind: 'Assign',
      target: { kind: 'Identifier', name: to },
      value: { kind: 'Identifier', name: from },
      declarationKind: declKind,
    })
  }

  while (pending.length > 0) {
    const dests = new Set(pending.map(c => c.to))
    const acyclicIndex = pending.findIndex(c => !dests.has(c.from))
    if (acyclicIndex >= 0) {
      const [copy] = pending.splice(acyclicIndex, 1)
      emitAssign(copy.to, copy.from)
      continue
    }
    const cycle = pending[0]!
    const tempName = makeSSAName('__phi_tmp', tempIndex++)
    emitAssign(tempName, cycle.from, 'const')
    for (const copy of pending) {
      if (copy.from === cycle.from) {
        copy.from = tempName
      }
    }
  }

  return result
}

function collectPredecessors(blocks: BasicBlock[]): Map<number, number[]> {
  const preds = new Map<number, number[]>()
  const add = (from: number, to: number) => {
    const arr = preds.get(to) ?? []
    arr.push(from)
    preds.set(to, arr)
  }
  for (const block of blocks) {
    switch (block.terminator.kind) {
      case 'Jump':
        add(block.id, block.terminator.target)
        break
      case 'Branch':
        add(block.id, block.terminator.consequent)
        add(block.id, block.terminator.alternate)
        break
      case 'Switch':
        block.terminator.cases.forEach(c => add(block.id, c.target))
        break
      case 'Break':
        add(block.id, block.terminator.target)
        break
      case 'Continue':
        add(block.id, block.terminator.target)
        break
      case 'ForOf':
        add(block.id, block.terminator.body)
        add(block.id, block.terminator.exit)
        break
      case 'ForIn':
        add(block.id, block.terminator.body)
        add(block.id, block.terminator.exit)
        break
      case 'Try':
        add(block.id, block.terminator.tryBlock)
        if (block.terminator.catchBlock !== undefined) {
          add(block.id, block.terminator.catchBlock)
        }
        if (block.terminator.finallyBlock !== undefined) {
          add(block.id, block.terminator.finallyBlock)
        }
        add(block.id, block.terminator.exit)
        break
      default:
        break
    }
  }
  return preds
}

function buildBlockScopeMap(scopeResult: ReactiveScopeResult): Map<number, Set<number>> {
  const blockScopes = new Map<number, Set<number>>()
  for (const scope of scopeResult.scopes) {
    for (const blockId of scope.blocks) {
      const entry = blockScopes.get(blockId) ?? new Set<number>()
      entry.add(scope.id)
      blockScopes.set(blockId, entry)
    }
  }
  return blockScopes
}

function buildDefUse(fn: HIRFunction, scopeResult?: ReactiveScopeResult): Map<string, DefUseInfo> {
  const map = new Map<string, DefUseInfo>()
  const blockScopes = scopeResult ? buildBlockScopeMap(scopeResult) : null
  const ensure = (name: string) => {
    const info = map.get(name)
    if (info) return info
    const created: DefUseInfo = { uses: [] }
    map.set(name, created)
    return created
  }
  const noteUseScopes = (info: DefUseInfo, blockId: number) => {
    if (!blockScopes) return
    const scopes = blockScopes.get(blockId)
    if (!scopes || scopes.size === 0) return
    const dest = info.useScopes ?? new Set<number>()
    scopes.forEach(id => dest.add(id))
    info.useScopes = dest
  }

  for (const block of fn.blocks) {
    block.instructions.forEach((instr, index) => {
      if (instr.kind === 'Assign') {
        const info = ensure(instr.target.name)
        const def: DefLocation = { blockId: block.id, instrIndex: index, kind: 'Assign' }
        info.def = info.def ?? def
        if (info.defs) {
          info.defs.push(def)
        } else {
          info.defs = [def]
        }
        collectUsesFromExpression(instr.value, (name, inFunctionBody) => {
          const useInfo = ensure(name)
          useInfo.uses.push({
            blockId: block.id,
            instrIndex: index,
            kind: 'Assign',
            inFunctionBody,
          })
          noteUseScopes(useInfo, block.id)
        })
      } else if (instr.kind === 'Phi') {
        const info = ensure(instr.target.name)
        const def: DefLocation = { blockId: block.id, instrIndex: index, kind: 'Phi' }
        info.def = info.def ?? def
        if (info.defs) {
          info.defs.push(def)
        } else {
          info.defs = [def]
        }
        instr.sources.forEach(source => {
          const useInfo = ensure(source.id.name)
          useInfo.uses.push({
            blockId: block.id,
            instrIndex: index,
            kind: 'Phi',
            inFunctionBody: false,
          })
          noteUseScopes(useInfo, block.id)
        })
      } else if (instr.kind === 'Expression') {
        collectUsesFromExpression(instr.value, (name, inFunctionBody) => {
          const useInfo = ensure(name)
          useInfo.uses.push({
            blockId: block.id,
            instrIndex: index,
            kind: 'Expression',
            inFunctionBody,
          })
          noteUseScopes(useInfo, block.id)
        })
      }
    })
    collectUsesFromTerminator(block.terminator, (name, inFunctionBody) => {
      const useInfo = ensure(name)
      useInfo.uses.push({
        blockId: block.id,
        instrIndex: Number.POSITIVE_INFINITY,
        kind: 'Terminator',
        inFunctionBody,
      })
      noteUseScopes(useInfo, block.id)
    })
  }

  return map
}

function collectUsesFromTerminator(
  term: Terminator,
  add: (name: string, inFunctionBody: boolean) => void,
  inFunctionBody = false,
): void {
  switch (term.kind) {
    case 'Return':
      if (term.argument) collectUsesFromExpression(term.argument as Expression, add, inFunctionBody)
      return
    case 'Throw':
      collectUsesFromExpression(term.argument as Expression, add, inFunctionBody)
      return
    case 'Branch':
      collectUsesFromExpression(term.test as Expression, add, inFunctionBody)
      return
    case 'Switch':
      collectUsesFromExpression(term.discriminant as Expression, add, inFunctionBody)
      term.cases.forEach(c => {
        if (c.test) collectUsesFromExpression(c.test as Expression, add, inFunctionBody)
      })
      return
    case 'ForOf':
      collectUsesFromExpression(term.iterable as Expression, add, inFunctionBody)
      return
    case 'ForIn':
      collectUsesFromExpression(term.object as Expression, add, inFunctionBody)
      return
    case 'Try':
      return
    default:
      return
  }
}

function collectUsesFromExpression(
  expr: Expression,
  add: (name: string, inFunctionBody: boolean) => void,
  inFunctionBody = false,
): void {
  walkExpression(expr, add, { inFunctionBody, shadowed: new Set() })
}

function walkExpression(
  expr: Expression,
  add: (name: string, inFunctionBody: boolean) => void,
  ctx: { inFunctionBody: boolean; shadowed: Set<string> },
): void {
  switch (expr.kind) {
    case 'Identifier':
      if (!ctx.shadowed.has(expr.name)) add(expr.name, ctx.inFunctionBody)
      return
    case 'CallExpression':
    case 'OptionalCallExpression':
      walkExpression(expr.callee as Expression, add, ctx)
      expr.arguments.forEach(arg => walkExpression(arg as Expression, add, ctx))
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      walkExpression(expr.object as Expression, add, ctx)
      if (expr.computed) walkExpression(expr.property as Expression, add, ctx)
      return
    case 'BinaryExpression':
    case 'LogicalExpression':
      walkExpression(expr.left as Expression, add, ctx)
      walkExpression(expr.right as Expression, add, ctx)
      return
    case 'UnaryExpression':
      walkExpression(expr.argument as Expression, add, ctx)
      return
    case 'ConditionalExpression':
      walkExpression(expr.test as Expression, add, ctx)
      walkExpression(expr.consequent as Expression, add, ctx)
      walkExpression(expr.alternate as Expression, add, ctx)
      return
    case 'ArrayExpression':
      expr.elements.forEach(el => {
        if (el) walkExpression(el as Expression, add, ctx)
      })
      return
    case 'ObjectExpression':
      expr.properties.forEach(prop => {
        if (prop.kind === 'SpreadElement') {
          walkExpression(prop.argument as Expression, add, ctx)
        } else {
          walkExpression(prop.value as Expression, add, ctx)
        }
      })
      return
    case 'TemplateLiteral':
      expr.expressions.forEach(e => walkExpression(e as Expression, add, ctx))
      return
    case 'SpreadElement':
      walkExpression(expr.argument as Expression, add, ctx)
      return
    case 'SequenceExpression':
      expr.expressions.forEach(e => walkExpression(e as Expression, add, ctx))
      return
    case 'AwaitExpression':
      walkExpression(expr.argument as Expression, add, ctx)
      return
    case 'NewExpression':
      walkExpression(expr.callee as Expression, add, ctx)
      expr.arguments.forEach(arg => walkExpression(arg as Expression, add, ctx))
      return
    case 'ArrowFunction': {
      const shadowed = new Set(ctx.shadowed)
      expr.params.forEach(p => shadowed.add(p.name))
      if (expr.isExpression) {
        walkExpression(expr.body as Expression, add, { inFunctionBody: true, shadowed })
        return
      }
      walkBlocks(expr.body as BasicBlock[], add, { inFunctionBody: true, shadowed })
      return
    }
    case 'FunctionExpression': {
      const shadowed = new Set(ctx.shadowed)
      expr.params.forEach(p => shadowed.add(p.name))
      walkBlocks(expr.body, add, { inFunctionBody: true, shadowed })
      return
    }
    case 'AssignmentExpression':
      walkExpression(expr.left as Expression, add, ctx)
      walkExpression(expr.right as Expression, add, ctx)
      return
    case 'UpdateExpression':
      walkExpression(expr.argument as Expression, add, ctx)
      return
    case 'JSXElement':
      if (typeof expr.tagName !== 'string') {
        walkExpression(expr.tagName as Expression, add, ctx)
      }
      expr.attributes.forEach(attr => {
        if (attr.isSpread && attr.spreadExpr) {
          walkExpression(attr.spreadExpr as Expression, add, ctx)
        } else if (attr.value) {
          walkExpression(attr.value as Expression, add, ctx)
        }
      })
      expr.children.forEach(child => {
        if (child.kind === 'expression') {
          walkExpression(child.value as Expression, add, ctx)
        } else if (child.kind === 'element') {
          walkExpression(child.value as Expression, add, ctx)
        }
      })
      return
    default:
      return
  }
}

function walkBlocks(
  blocks: BasicBlock[],
  add: (name: string, inFunctionBody: boolean) => void,
  ctx: { inFunctionBody: boolean; shadowed: Set<string> },
): void {
  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        walkExpression(instr.value, add, ctx)
        if (instr.declarationKind) {
          ctx.shadowed.add(instr.target.name)
        }
      } else if (instr.kind === 'Expression') {
        walkExpression(instr.value, add, ctx)
      } else if (instr.kind === 'Phi') {
        instr.sources.forEach(src => {
          if (!ctx.shadowed.has(src.id.name)) add(src.id.name, ctx.inFunctionBody)
        })
      }
    }
    collectUsesFromTerminator(
      block.terminator,
      (name, inFunctionBody) => {
        if (!ctx.shadowed.has(name)) add(name, inFunctionBody)
      },
      ctx.inFunctionBody,
    )
  }
}

function collectExpressionIdentifiers(expr: Expression, deep = false): Set<string> {
  const deps = new Set<string>()
  const collect = (name: string) => deps.add(name)
  walkExpression(expr, (name, _inFunctionBody) => collect(name), {
    inFunctionBody: deep,
    shadowed: new Set(),
  })
  return deps
}

function collectTerminatorIdentifiers(term: Terminator): Set<string> {
  const deps = new Set<string>()
  collectUsesFromTerminator(term, (name, _inFunctionBody) => deps.add(name))
  return deps
}

function hashExpression(expr: Expression): string {
  switch (expr.kind) {
    case 'Identifier':
      return `id:${expr.name}`
    case 'Literal':
      return `lit:${typeof expr.value}:${String(expr.value)}`
    case 'CallExpression':
      return `call:${hashExpression(expr.callee as Expression)}(${expr.arguments
        .map(a => hashExpression(a as Expression))
        .join(',')})`
    case 'OptionalCallExpression':
      return `ocall:${hashExpression(expr.callee as Expression)}(${expr.arguments
        .map(a => hashExpression(a as Expression))
        .join(',')})`
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const member = expr
      const prop = member.computed
        ? hashExpression(member.property as Expression)
        : member.property.kind === 'Identifier'
          ? member.property.name
          : hashExpression(member.property as Expression)
      return `mem:${hashExpression(member.object as Expression)}:${prop}:${
        member.computed ? 'c' : 's'
      }`
    }
    case 'BinaryExpression':
      return `bin:${expr.operator}:${hashExpression(expr.left as Expression)}:${hashExpression(
        expr.right as Expression,
      )}`
    case 'LogicalExpression':
      return `log:${expr.operator}:${hashExpression(expr.left as Expression)}:${hashExpression(
        expr.right as Expression,
      )}`
    case 'UnaryExpression':
      return `un:${expr.operator}:${hashExpression(expr.argument as Expression)}`
    case 'ConditionalExpression':
      return `cond:${hashExpression(expr.test as Expression)}:${hashExpression(
        expr.consequent as Expression,
      )}:${hashExpression(expr.alternate as Expression)}`
    case 'ArrayExpression':
      return `arr:${expr.elements
        .map(el => (el ? hashExpression(el as Expression) : 'null'))
        .join(',')}`
    case 'ObjectExpression':
      return `obj:${expr.properties
        .map(p =>
          p.kind === 'SpreadElement'
            ? `...${hashExpression(p.argument as Expression)}`
            : `${hashExpression(p.key as Expression)}:${hashExpression(p.value as Expression)}`,
        )
        .join(',')}`
    case 'TemplateLiteral':
      return `tpl:${expr.quasis.join('|')}:${expr.expressions
        .map(e => hashExpression(e as Expression))
        .join('|')}`
    case 'SpreadElement':
      return `spread:${hashExpression(expr.argument as Expression)}`
    case 'SequenceExpression':
      return `seq:${expr.expressions.map(e => hashExpression(e as Expression)).join(',')}`
    case 'AwaitExpression':
      return `await:${hashExpression(expr.argument as Expression)}`
    case 'NewExpression':
      return `new:${hashExpression(expr.callee as Expression)}(${expr.arguments
        .map(a => hashExpression(a as Expression))
        .join(',')})`
    case 'ArrowFunction':
    case 'FunctionExpression':
      return `${expr.kind}`
    default:
      return expr.kind
  }
}

function isExplicitMemoCall(expr: Expression, ctx: PurityContext): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  const callee = expr.callee.kind === 'Identifier' ? expr.callee.name : getCalleeName(expr.callee)
  if (!callee) return false
  return (callee === '$memo' || callee === 'createMemo') && !(expr.pure || ctx.functionPure)
}

function isPureExpression(expr: Expression, ctx: PurityContext): boolean {
  switch (expr.kind) {
    case 'Literal':
      return true
    case 'Identifier':
      if (ctx.impureIdentifiers?.has(expr.name)) return false
      return true
    case 'ThisExpression':
    case 'SuperExpression':
      return true
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        isPureExpression(expr.left as Expression, ctx) &&
        isPureExpression(expr.right as Expression, ctx)
      )
    case 'UnaryExpression':
      return isPureExpression(expr.argument as Expression, ctx)
    case 'ConditionalExpression':
      return (
        isPureExpression(expr.test as Expression, ctx) &&
        isPureExpression(expr.consequent as Expression, ctx) &&
        isPureExpression(expr.alternate as Expression, ctx)
      )
    case 'ArrayExpression':
      return expr.elements.every(el => (el ? isPureExpression(el as Expression, ctx) : true))
    case 'ObjectExpression':
      return expr.properties.every(prop => {
        if (prop.kind === 'SpreadElement') return isPureExpression(prop.argument as Expression, ctx)
        return isPureExpression(prop.value as Expression, ctx)
      })
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      if (isStableMemberExpression(expr)) return true
      if (!ctx.functionPure) return false
      return (
        isPureExpression(expr.object as Expression, ctx) &&
        (expr.computed ? isPureExpression(expr.property as Expression, ctx) : true)
      )
    case 'TemplateLiteral':
      return expr.expressions.every(e => isPureExpression(e as Expression, ctx))
    case 'SpreadElement':
      return isPureExpression(expr.argument as Expression, ctx)
    case 'SequenceExpression':
      return expr.expressions.every(e => isPureExpression(e as Expression, ctx))
    case 'ArrowFunction':
    case 'FunctionExpression':
      return true
    case 'CallExpression':
    case 'OptionalCallExpression':
      return isPureCall(expr, ctx) && expr.arguments.every(arg => isPureExpression(arg, ctx))
    default:
      return false
  }
}

function isCSESafeExpression(expr: Expression, ctx: PurityContext): boolean {
  switch (expr.kind) {
    case 'Literal':
    case 'Identifier':
      return true
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      if (isStableMemberExpression(expr)) return true
      if (!ctx.functionPure) return false
      return (
        isCSESafeExpression(expr.object as Expression, ctx) &&
        (expr.computed ? isCSESafeExpression(expr.property as Expression, ctx) : true)
      )
    case 'UnaryExpression':
      return isCSESafeExpression(expr.argument as Expression, ctx)
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        isCSESafeExpression(expr.left as Expression, ctx) &&
        isCSESafeExpression(expr.right as Expression, ctx)
      )
    case 'ConditionalExpression':
      return (
        isCSESafeExpression(expr.test as Expression, ctx) &&
        isCSESafeExpression(expr.consequent as Expression, ctx) &&
        isCSESafeExpression(expr.alternate as Expression, ctx)
      )
    case 'TemplateLiteral':
      return expr.expressions.every(e => isCSESafeExpression(e as Expression, ctx))
    case 'SequenceExpression':
      return expr.expressions.every(e => isCSESafeExpression(e as Expression, ctx))
    case 'CallExpression':
    case 'OptionalCallExpression':
      return (
        isCSESafeCall(expr, ctx) &&
        expr.arguments.every(arg => isCSESafeExpression(arg as Expression, ctx))
      )
    default:
      return false
  }
}

function isCSESafeCall(expr: Expression, ctx: PurityContext): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  const calleeName =
    expr.callee.kind === 'Identifier' ? expr.callee.name : getCalleeName(expr.callee)
  if (calleeName && IMPURE_CALLEES.has(calleeName)) {
    if (calleeName === '$memo' || calleeName === 'createMemo') {
      return !!(ctx.functionPure || expr.pure)
    }
    return false
  }
  if (expr.pure) return true
  if (!calleeName) return false
  if (PURE_CALLEES.has(calleeName)) return true
  if (ctx.functionPure) return true
  if (calleeName.startsWith('Math.')) {
    const method = calleeName.slice('Math.'.length)
    return PURE_MATH_METHODS.has(method)
  }
  return false
}

function isCompilerGeneratedName(name: string): boolean {
  return name.startsWith('__')
}

function isStableMemberExpression(expr: Expression): boolean {
  if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return false
  if (expr.computed) return false
  if (expr.object.kind !== 'Identifier' || expr.property.kind !== 'Identifier') return false
  const stable = STABLE_MEMBER_ACCESS.get(expr.object.name)
  if (!stable) return false
  return stable.has(expr.property.name)
}

function isPureCall(expr: Expression, ctx: PurityContext): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  const calleeName =
    expr.callee.kind === 'Identifier' ? expr.callee.name : getCalleeName(expr.callee)

  if (calleeName && IMPURE_CALLEES.has(calleeName)) {
    if (calleeName === '$memo' || calleeName === 'createMemo') {
      return !!(ctx.functionPure || expr.pure)
    }
    return false
  }
  if (expr.pure) return true
  if (!calleeName) return false
  if (PURE_CALLEES.has(calleeName)) return true
  if (ctx.functionPure) return true
  if (calleeName.startsWith('Math.')) {
    const method = calleeName.slice('Math.'.length)
    return PURE_MATH_METHODS.has(method)
  }
  return false
}

function getCalleeName(callee: Expression): string | null {
  if (callee.kind === 'Identifier') return callee.name
  if (callee.kind === 'MemberExpression' && !callee.computed) {
    if (callee.object.kind === 'Identifier' && callee.property.kind === 'Identifier') {
      return `${callee.object.name}.${callee.property.name}`
    }
  }
  return null
}

function functionBodyDeclaresName(blocks: BasicBlock[], targetBase: string): boolean {
  for (const block of blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' && instr.declarationKind) {
        if (getSSABaseName(instr.target.name) === targetBase) return true
      }
    }
    const term = block.terminator
    if (term.kind === 'ForOf' || term.kind === 'ForIn') {
      if (getSSABaseName(term.variable) === targetBase) return true
    } else if (term.kind === 'Try') {
      if (term.catchParam && getSSABaseName(term.catchParam) === targetBase) return true
    }
  }
  return false
}

function replaceIdentifier(
  expr: Expression,
  target: string,
  replacement: Expression,
  inFunctionBody: boolean,
): Expression {
  switch (expr.kind) {
    case 'Identifier':
      return expr.name === target ? replacement : expr
    case 'CallExpression':
      return {
        ...expr,
        callee: replaceIdentifier(expr.callee as Expression, target, replacement, inFunctionBody),
        arguments: expr.arguments.map(arg =>
          replaceIdentifier(arg as Expression, target, replacement, inFunctionBody),
        ),
      }
    case 'OptionalCallExpression':
      return {
        ...expr,
        callee: replaceIdentifier(expr.callee as Expression, target, replacement, inFunctionBody),
        arguments: expr.arguments.map(arg =>
          replaceIdentifier(arg as Expression, target, replacement, inFunctionBody),
        ),
      }
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const member = expr
      return {
        ...member,
        object: replaceIdentifier(member.object as Expression, target, replacement, inFunctionBody),
        property: member.computed
          ? replaceIdentifier(member.property as Expression, target, replacement, inFunctionBody)
          : member.property,
      }
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      return {
        ...expr,
        left: replaceIdentifier(expr.left as Expression, target, replacement, inFunctionBody),
        right: replaceIdentifier(expr.right as Expression, target, replacement, inFunctionBody),
      }
    case 'UnaryExpression':
      return {
        ...expr,
        argument: replaceIdentifier(
          expr.argument as Expression,
          target,
          replacement,
          inFunctionBody,
        ),
      }
    case 'ConditionalExpression':
      return {
        ...expr,
        test: replaceIdentifier(expr.test as Expression, target, replacement, inFunctionBody),
        consequent: replaceIdentifier(
          expr.consequent as Expression,
          target,
          replacement,
          inFunctionBody,
        ),
        alternate: replaceIdentifier(
          expr.alternate as Expression,
          target,
          replacement,
          inFunctionBody,
        ),
      }
    case 'ArrayExpression':
      return {
        ...expr,
        elements: expr.elements.map(el =>
          el ? replaceIdentifier(el as Expression, target, replacement, inFunctionBody) : el,
        ),
      }
    case 'ObjectExpression':
      return {
        ...expr,
        properties: expr.properties.map(prop => {
          if (prop.kind === 'SpreadElement') {
            return {
              ...prop,
              argument: replaceIdentifier(
                prop.argument as Expression,
                target,
                replacement,
                inFunctionBody,
              ),
            }
          }
          return {
            ...prop,
            key: prop.key,
            value: replaceIdentifier(prop.value as Expression, target, replacement, inFunctionBody),
          }
        }),
      }
    case 'TemplateLiteral':
      return {
        ...expr,
        expressions: expr.expressions.map(e =>
          replaceIdentifier(e as Expression, target, replacement, inFunctionBody),
        ),
      }
    case 'SpreadElement':
      return {
        ...expr,
        argument: replaceIdentifier(
          expr.argument as Expression,
          target,
          replacement,
          inFunctionBody,
        ),
      }
    case 'SequenceExpression':
      return {
        ...expr,
        expressions: expr.expressions.map(e =>
          replaceIdentifier(e as Expression, target, replacement, inFunctionBody),
        ),
      }
    case 'AwaitExpression':
      return {
        ...expr,
        argument: replaceIdentifier(
          expr.argument as Expression,
          target,
          replacement,
          inFunctionBody,
        ),
      }
    case 'NewExpression':
      return {
        ...expr,
        callee: replaceIdentifier(expr.callee as Expression, target, replacement, inFunctionBody),
        arguments: expr.arguments.map(arg =>
          replaceIdentifier(arg as Expression, target, replacement, inFunctionBody),
        ),
      }
    case 'ArrowFunction':
      {
        const targetBase = getSSABaseName(target)
        if (expr.params.some(p => getSSABaseName(p.name) === targetBase)) return expr
        if (!expr.isExpression && functionBodyDeclaresName(expr.body as BasicBlock[], targetBase)) {
          return expr
        }
      }
      if (expr.isExpression) {
        return {
          ...expr,
          body: replaceIdentifier(expr.body as Expression, target, replacement, true),
        }
      }
      return {
        ...expr,
        body: (expr.body as BasicBlock[]).map(block => ({
          ...block,
          instructions: block.instructions.map(instr => {
            if (instr.kind === 'Assign') {
              return {
                ...instr,
                value: replaceIdentifier(instr.value, target, replacement, true),
              }
            }
            if (instr.kind === 'Expression') {
              return {
                ...instr,
                value: replaceIdentifier(instr.value, target, replacement, true),
              }
            }
            return instr
          }),
          terminator: replaceIdentifierInTerminator(block.terminator, target, replacement),
        })),
      }
    case 'FunctionExpression':
      {
        const targetBase = getSSABaseName(target)
        if (expr.name && getSSABaseName(expr.name) === targetBase) return expr
        if (expr.params.some(p => getSSABaseName(p.name) === targetBase)) return expr
        if (functionBodyDeclaresName(expr.body, targetBase)) return expr
      }
      return {
        ...expr,
        body: expr.body.map(block => ({
          ...block,
          instructions: block.instructions.map(instr => {
            if (instr.kind === 'Assign') {
              return {
                ...instr,
                value: replaceIdentifier(instr.value, target, replacement, true),
              }
            }
            if (instr.kind === 'Expression') {
              return {
                ...instr,
                value: replaceIdentifier(instr.value, target, replacement, true),
              }
            }
            return instr
          }),
          terminator: replaceIdentifierInTerminator(block.terminator, target, replacement),
        })),
      }
    case 'AssignmentExpression':
      return {
        ...expr,
        left: replaceIdentifier(expr.left as Expression, target, replacement, inFunctionBody),
        right: replaceIdentifier(expr.right as Expression, target, replacement, inFunctionBody),
      }
    case 'UpdateExpression':
      return {
        ...expr,
        argument: replaceIdentifier(
          expr.argument as Expression,
          target,
          replacement,
          inFunctionBody,
        ),
      }
    case 'JSXElement':
      return {
        ...expr,
        tagName:
          typeof expr.tagName === 'string'
            ? expr.tagName
            : (replaceIdentifier(
                expr.tagName as Expression,
                target,
                replacement,
                inFunctionBody,
              ) as Identifier | string),
        attributes: expr.attributes.map(attr => {
          if (attr.isSpread && attr.spreadExpr) {
            return {
              ...attr,
              spreadExpr: replaceIdentifier(
                attr.spreadExpr as Expression,
                target,
                replacement,
                inFunctionBody,
              ),
            }
          }
          if (attr.value) {
            return {
              ...attr,
              value: replaceIdentifier(
                attr.value as Expression,
                target,
                replacement,
                inFunctionBody,
              ),
            }
          }
          return attr
        }),
        children: expr.children.map(child => {
          if (child.kind === 'expression') {
            return {
              ...child,
              value: replaceIdentifier(
                child.value as Expression,
                target,
                replacement,
                inFunctionBody,
              ),
            }
          }
          if (child.kind === 'element') {
            return {
              ...child,
              value: replaceIdentifier(
                child.value,
                target,
                replacement,
                inFunctionBody,
              ) as JSXElementExpression,
            }
          }
          return child
        }),
      }
    default:
      return expr
  }
}

function replaceIdentifierInTerminator(
  term: Terminator,
  target: string,
  replacement: Expression,
): Terminator {
  switch (term.kind) {
    case 'Return':
      return {
        ...term,
        argument: term.argument
          ? replaceIdentifier(term.argument as Expression, target, replacement, false)
          : term.argument,
      }
    case 'Throw':
      return {
        ...term,
        argument: replaceIdentifier(term.argument as Expression, target, replacement, false),
      }
    case 'Branch':
      return {
        ...term,
        test: replaceIdentifier(term.test as Expression, target, replacement, false),
      }
    case 'Switch':
      return {
        ...term,
        discriminant: replaceIdentifier(
          term.discriminant as Expression,
          target,
          replacement,
          false,
        ),
        cases: term.cases.map(c => ({
          ...c,
          test: c.test
            ? replaceIdentifier(c.test as Expression, target, replacement, false)
            : c.test,
        })),
      }
    case 'ForOf':
      return {
        ...term,
        iterable: replaceIdentifier(term.iterable as Expression, target, replacement, false),
      }
    case 'ForIn':
      return {
        ...term,
        object: replaceIdentifier(term.object as Expression, target, replacement, false),
      }
    case 'Try':
      return term
    default:
      return term
  }
}
