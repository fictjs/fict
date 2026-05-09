import type { HIRFunction, HIRProgram } from '../src/ir/hir'

export function firstFunction(hir: HIRProgram): HIRFunction {
  return functionAt(hir, 0)
}

export function functionAt(hir: HIRProgram, index: number): HIRFunction {
  const indexed = hir.functions[index]
  if (!indexed) {
    throw new Error(`Expected HIR fixture to contain function at index ${index}`)
  }
  return indexed
}

export function namedFunction(hir: HIRProgram, name: string, fallbackIndex = 0): HIRFunction {
  const fn = hir.functions.find(current => current.name === name)
  if (!fn) {
    return functionAt(hir, fallbackIndex)
  }
  return fn
}
