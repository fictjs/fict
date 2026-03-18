import { debugExplicitlyEnabled, debugLog } from '../debug'

import type { CodegenContext } from './codegen'
import { collectExpressionDependencies } from './codegen-expression-deps'
import { getReactiveCallKind } from './codegen-reactive-kind'
import { HIRError, type HIRFunction } from './hir'
import { deSSAVarName } from './regions'
import type { ReactiveScopeResult } from './scopes'

export function detectDerivedCycles(
  fn: HIRFunction,
  _scopeResult: ReactiveScopeResult,
  ctx: CodegenContext,
): void {
  if (debugExplicitlyEnabled('cycles_throw')) {
    throw new Error('cycle check invoked')
  }
  const declared = new Map<
    string,
    { isSignal: boolean; isStore: boolean; declaredHere: boolean; count: number }
  >()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      const target = deSSAVarName(instr.target.name)
      const callKind = getReactiveCallKind(instr.value, ctx)
      const isSignalCall = callKind === 'signal'
      const isStoreCall = callKind === 'store'
      const prev = declared.get(target)
      declared.set(target, {
        isSignal: (prev?.isSignal ?? false) || isSignalCall,
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
      if (declInfo?.isSignal || declInfo?.isStore || !declInfo?.declaredHere) continue
      if ((declInfo.count ?? 0) !== 1) continue
      const deps = graph.get(target) ?? new Set<string>()
      const rawDeps = new Set<string>()
      collectExpressionDependencies(instr.value, rawDeps)
      for (const dep of rawDeps) {
        const base = deSSAVarName(dep.split('.')[0] ?? dep)
        const depInfo = declared.get(base)
        if (
          depInfo &&
          depInfo.declaredHere &&
          !depInfo.isSignal &&
          !depInfo.isStore &&
          (depInfo.count ?? 0) === 1
        ) {
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
      throw new HIRError(
        `Detected cyclic derived dependency: ${cycle.join(' -> ')}\n\n` +
          `Tip: This usually happens when derived values depend on each other in a loop.\n` +
          `Consider:\n` +
          `  - Using untrack() to break the dependency cycle\n` +
          `  - Restructuring your derived values to avoid circular dependencies\n` +
          `  - Moving one of the values to $state if it should be independently mutable`,
        'BUILD_ERROR',
        {
          file: ctx.options?.filename,
        },
      )
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

  debugLog(
    'cycles',
    'cycle graph',
    Array.from(graph.entries()).map(([k, v]) => [k, Array.from(v)]),
  )
}
