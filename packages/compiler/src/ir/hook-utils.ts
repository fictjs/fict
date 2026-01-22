import type { Expression, HIRFunction } from './hir'

export const HOOK_NAME_PREFIX = 'use'

export function isHookName(name: string | undefined): boolean {
  return !!name && name.startsWith(HOOK_NAME_PREFIX)
}

export function isComponentName(name: string | undefined): boolean {
  return !!name && name[0] === name[0]?.toUpperCase()
}

function isReactivePrimitiveCall(expr: Expression): boolean {
  if (expr.kind !== 'CallExpression' && expr.kind !== 'OptionalCallExpression') return false
  if (expr.callee.kind !== 'Identifier') return false
  const name = expr.callee.name
  return name === '$state' || name === 'createSignal' || name === '$store' || name === 'createStore'
}

export function isHookLikeFunction(fn: HIRFunction): boolean {
  if (isHookName(fn.name)) return true
  if (isComponentName(fn.name)) return false
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign') continue
      if (isReactivePrimitiveCall(instr.value)) return true
    }
  }
  return false
}
