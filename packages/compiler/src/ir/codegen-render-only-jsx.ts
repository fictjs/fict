import { getSSABaseName, type BasicBlock, type Expression, type HIRFunction } from './hir'
import { walkExpression } from './walk-expression'

const baseName = (name: string): string => getSSABaseName(name)

function isRenderOnlyJSXLocalUse(
  identifier: Expression & { kind: 'Identifier' },
  rootIsRenderValue: boolean,
  parents: Map<Expression, Expression | null>,
): boolean {
  let current: Expression = identifier
  while (true) {
    const parent = parents.get(current) ?? null
    if (!parent) return rootIsRenderValue

    if (parent.kind === 'JSXElement') {
      const isChildValue = parent.children.some(
        child => child.kind === 'expression' && child.value === current,
      )
      if (isChildValue) return true
      return parent.attributes.some(
        attr => !attr.isSpread && attr.name === 'children' && attr.value === current,
      )
    }
    if (parent.kind === 'ArrayExpression') {
      current = parent
      continue
    }
    if (parent.kind === 'ConditionalExpression') {
      if (parent.test === current) return false
      current = parent
      continue
    }
    if (parent.kind === 'LogicalExpression') {
      if (parent.left === current) return false
      current = parent
      continue
    }
    if (parent.kind === 'SequenceExpression') {
      if (parent.expressions[parent.expressions.length - 1] !== current) return false
      current = parent
      continue
    }
    if (parent.kind === 'SpreadElement') {
      current = parent
      continue
    }
    return false
  }
}

/**
 * Delay a JSX local only when every read is a render value. Member, call,
 * alias, condition, and ordinary JavaScript uses retain DOM-valued semantics.
 */
export function collectRenderOnlyJSXLocalNames(fn: HIRFunction): Set<string> {
  const candidates = new Set<string>()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' && instr.value.kind === 'JSXElement') {
        candidates.add(baseName(instr.target.name))
      }
    }
  }
  if (candidates.size === 0) return candidates

  const unsafe = new Set<string>()
  type NestedFunctionExpression = Extract<
    Expression,
    { kind: 'ArrowFunction' | 'FunctionExpression' }
  >

  const scanNestedExpression = (expr: Expression, shadowed: ReadonlySet<string>): void => {
    walkExpression(
      expr,
      node => {
        if (node.kind === 'Identifier') {
          const name = baseName(node.name)
          if (candidates.has(name) && !shadowed.has(name)) unsafe.add(name)
          return
        }
        if (node.kind === 'ArrowFunction' || node.kind === 'FunctionExpression') {
          scanNestedFunction(node, shadowed)
        }
      },
      { includeFunctionBodies: false },
    )
  }

  const scanNestedBlocks = (blocks: readonly BasicBlock[], shadowed: ReadonlySet<string>): void => {
    for (const block of blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign' || instr.kind === 'Expression') {
          scanNestedExpression(instr.value, shadowed)
        } else if (instr.kind === 'Phi') {
          instr.sources.forEach(source => scanNestedExpression(source.id, shadowed))
        }
      }
      const term = block.terminator
      switch (term.kind) {
        case 'Return':
          if (term.argument) scanNestedExpression(term.argument, shadowed)
          break
        case 'Throw':
          scanNestedExpression(term.argument, shadowed)
          break
        case 'Branch':
          scanNestedExpression(term.test, shadowed)
          break
        case 'Switch':
          scanNestedExpression(term.discriminant, shadowed)
          term.cases.forEach(item => {
            if (item.test) scanNestedExpression(item.test, shadowed)
          })
          break
        case 'ForOf':
          scanNestedExpression(term.iterable, shadowed)
          if (term.assignmentTarget) scanNestedExpression(term.assignmentTarget, shadowed)
          break
        case 'ForIn':
          scanNestedExpression(term.object, shadowed)
          if (term.assignmentTarget) scanNestedExpression(term.assignmentTarget, shadowed)
          break
        case 'Jump':
        case 'Unreachable':
        case 'Break':
        case 'Continue':
        case 'Try':
          break
      }
    }
  }

  const scanNestedFunction = (
    nested: NestedFunctionExpression,
    inheritedShadowed: ReadonlySet<string>,
  ): void => {
    const shadowed = new Set(inheritedShadowed)
    nested.params.forEach(param => shadowed.add(baseName(param.name)))
    if (nested.kind === 'FunctionExpression' && nested.name) {
      shadowed.add(baseName(nested.name))
    }

    if (nested.kind === 'ArrowFunction' && nested.isExpression && !Array.isArray(nested.body)) {
      scanNestedExpression(nested.body, shadowed)
      return
    }

    const blocks = nested.body as BasicBlock[]
    // Function-scoped declarations shadow captures throughout the nested function.
    for (const block of blocks) {
      for (const instr of block.instructions) {
        if (
          instr.kind === 'Assign' &&
          (instr.declarationKind === 'var' ||
            (instr.declarationKind === 'function' && !instr.blockScopedFunction))
        ) {
          shadowed.add(baseName(instr.target.name))
        }
      }
      const term = block.terminator
      if (
        (term.kind === 'ForOf' || term.kind === 'ForIn') &&
        term.leftKind === 'declaration' &&
        term.variableKind === 'var'
      ) {
        shadowed.add(baseName(term.variable))
      }
    }
    scanNestedBlocks(blocks, shadowed)
  }

  const scan = (expr: Expression, rootIsRenderValue: boolean): void => {
    const parents = new Map<Expression, Expression | null>()
    const identifiers: (Expression & { kind: 'Identifier' })[] = []
    walkExpression(
      expr,
      (node, state) => {
        parents.set(node, state.parent)
        if (node.kind === 'Identifier' && candidates.has(baseName(node.name))) {
          identifiers.push(node)
        }
        if (node.kind === 'ArrowFunction' || node.kind === 'FunctionExpression') {
          scanNestedFunction(node, new Set())
        }
      },
      { includeFunctionBodies: false },
    )
    for (const identifier of identifiers) {
      if (!isRenderOnlyJSXLocalUse(identifier, rootIsRenderValue, parents)) {
        unsafe.add(baseName(identifier.name))
      }
    }
  }

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        scan(instr.value, false)
      } else if (instr.kind === 'Phi') {
        instr.sources.forEach(source => scan(source.id, false))
      }
    }
    const term = block.terminator
    switch (term.kind) {
      case 'Return':
        if (term.argument) scan(term.argument, true)
        break
      case 'Throw':
        scan(term.argument, false)
        break
      case 'Branch':
        scan(term.test, false)
        break
      case 'Switch':
        scan(term.discriminant, false)
        term.cases.forEach(item => {
          if (item.test) scan(item.test, false)
        })
        break
      case 'ForOf':
        scan(term.iterable, false)
        if (term.assignmentTarget) scan(term.assignmentTarget, false)
        break
      case 'ForIn':
        scan(term.object, false)
        if (term.assignmentTarget) scan(term.assignmentTarget, false)
        break
      case 'Jump':
      case 'Unreachable':
      case 'Break':
      case 'Continue':
      case 'Try':
        break
    }
  }

  unsafe.forEach(name => candidates.delete(name))
  return candidates
}
