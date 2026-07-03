import type { Expression, HIRFunction } from './hir'

export const HOOK_NAME_PATTERN = /^use[A-Z0-9_]/
export const COMPONENT_NAME_PATTERN = /^[A-Z]/

export function isHookName(name: string | undefined): boolean {
  return !!name && HOOK_NAME_PATTERN.test(name)
}

export function isComponentName(name: string | undefined): boolean {
  return !!name && COMPONENT_NAME_PATTERN.test(name)
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
