import type { LVal } from '@babel/types'

import type { BasicBlock, Expression, HIRFunction, Instruction, Terminator } from './hir'
import { deSSAVarName } from './regions'
import type { StructuredNode } from './structurize'
import { walkExpression } from './walk-expression'

const hasInstructionArray = (value: unknown): value is { instructions: Instruction[] } => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { instructions?: unknown }
  return Array.isArray(candidate.instructions)
}

const expressionContainsJSXCache = new WeakMap<object, boolean>()

function assertNever(value: never): never {
  throw new Error(`Unhandled terminator in codegen analysis: ${JSON.stringify(value)}`)
}

function instructionContainsJSX(instr: Instruction): boolean {
  return instr.kind === 'Assign' || instr.kind === 'Expression'
    ? expressionContainsJSX(instr.value)
    : false
}

function terminatorContainsJSX(term: Terminator): boolean {
  switch (term.kind) {
    case 'Return':
      return term.argument ? expressionContainsJSX(term.argument) : false
    case 'Throw':
      return expressionContainsJSX(term.argument)
    case 'Branch':
      return expressionContainsJSX(term.test)
    case 'Switch':
      return (
        expressionContainsJSX(term.discriminant) ||
        term.cases.some(switchCase =>
          switchCase.test ? expressionContainsJSX(switchCase.test) : false,
        )
      )
    case 'ForOf':
      return (
        expressionContainsJSX(term.iterable) ||
        (term.assignmentTarget ? expressionContainsJSX(term.assignmentTarget) : false)
      )
    case 'ForIn':
      return (
        expressionContainsJSX(term.object) ||
        (term.assignmentTarget ? expressionContainsJSX(term.assignmentTarget) : false)
      )
    case 'Jump':
    case 'Unreachable':
    case 'Break':
    case 'Continue':
    case 'Try':
      return false
    default:
      assertNever(term)
  }
}

function blockContainsJSX(block: BasicBlock): boolean {
  return block.instructions.some(instructionContainsJSX) || terminatorContainsJSX(block.terminator)
}

function expressionContainsJSX(expr: unknown): boolean {
  if (!expr || typeof expr !== 'object') return false
  const cached = expressionContainsJSXCache.get(expr)
  if (cached !== undefined) return cached

  let result: boolean
  if (Array.isArray(expr)) {
    result = expr.some(item => expressionContainsJSX(item))
    expressionContainsJSXCache.set(expr, result)
    return result
  }
  const candidate = expr as Expression

  if (hasInstructionArray(expr)) {
    result = blockContainsJSX(expr as BasicBlock)
    expressionContainsJSXCache.set(expr, result)
    return result
  }

  if (typeof candidate.kind !== 'string') {
    expressionContainsJSXCache.set(expr, false)
    return false
  }
  result = false
  walkExpression(candidate, node => {
    if (node.kind === 'JSXElement') result = true
  })

  expressionContainsJSXCache.set(expr, result)
  return result
}

export function functionContainsJSX(fn: HIRFunction): boolean {
  for (const block of fn.blocks) {
    if (blockContainsJSX(block)) {
      return true
    }
  }
  return false
}

export function structuredNodeHasComplexControlFlow(node: StructuredNode): boolean {
  switch (node.kind) {
    case 'labeled':
      return structuredNodeHasComplexControlFlow(node.statement)
    case 'while':
    case 'doWhile':
    case 'for':
    case 'forOf':
    case 'forIn':
    case 'switch':
    case 'try':
    case 'stateMachine':
      return true
    case 'sequence':
      return node.nodes.some(structuredNodeHasComplexControlFlow)
    case 'block':
      return node.statements.some(structuredNodeHasComplexControlFlow)
    case 'if':
      return (
        structuredNodeHasComplexControlFlow(node.consequent) ||
        (node.alternate !== null && structuredNodeHasComplexControlFlow(node.alternate))
      )
    default:
      return false
  }
}

function terminatorHasAwait(term: BasicBlock['terminator']): boolean {
  switch (term.kind) {
    case 'Branch':
      return expressionHasAwait(term.test)
    case 'Switch':
      if (expressionHasAwait(term.discriminant)) return true
      return term.cases.some(c => (c.test ? expressionHasAwait(c.test) : false))
    case 'ForOf':
      return (
        !!term.await ||
        expressionHasAwait(term.iterable) ||
        (!!term.assignmentTarget && expressionHasAwait(term.assignmentTarget))
      )
    case 'ForIn':
      return (
        expressionHasAwait(term.object) ||
        (!!term.assignmentTarget && expressionHasAwait(term.assignmentTarget))
      )
    case 'Return':
      return term.argument ? expressionHasAwait(term.argument) : false
    case 'Throw':
      return expressionHasAwait(term.argument)
    default:
      return false
  }
}

function expressionHasAwait(expr: Expression): boolean {
  switch (expr.kind) {
    case 'AwaitExpression':
      return true
    case 'CallExpression':
    case 'OptionalCallExpression':
      return (
        expressionHasAwait(expr.callee as Expression) ||
        expr.arguments.some(arg => expressionHasAwait(arg as Expression))
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return (
        expressionHasAwait(expr.object as Expression) ||
        expressionHasAwait(expr.property as Expression)
      )
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        expressionHasAwait(expr.left as Expression) || expressionHasAwait(expr.right as Expression)
      )
    case 'UnaryExpression':
      return expressionHasAwait(expr.argument as Expression)
    case 'ConditionalExpression':
      return (
        expressionHasAwait(expr.test as Expression) ||
        expressionHasAwait(expr.consequent as Expression) ||
        expressionHasAwait(expr.alternate as Expression)
      )
    case 'ArrayExpression':
      return expr.elements.some(el => el && expressionHasAwait(el as Expression))
    case 'ObjectExpression':
      return expr.properties.some(
        prop =>
          (prop.kind === 'Property' &&
            (((prop.computed ?? false) && expressionHasAwait(prop.key as Expression)) ||
              expressionHasAwait(prop.value as Expression))) ||
          (prop.kind === 'SpreadElement' && expressionHasAwait(prop.argument as Expression)),
      )
    case 'TemplateLiteral':
      return expr.expressions.some(ex => expressionHasAwait(ex as Expression))
    case 'SequenceExpression':
      return expr.expressions.some(ex => expressionHasAwait(ex as Expression))
    case 'SpreadElement':
      return expressionHasAwait(expr.argument as Expression)
    case 'AssignmentExpression':
      return (
        expressionHasAwait(expr.left as Expression) || expressionHasAwait(expr.right as Expression)
      )
    case 'UpdateExpression':
      return expressionHasAwait(expr.argument as Expression)
    case 'NewExpression':
      return (
        expressionHasAwait(expr.callee as Expression) ||
        expr.arguments.some(arg => expressionHasAwait(arg as Expression))
      )
    case 'ImportExpression':
      return (
        expressionHasAwait(expr.source as Expression) ||
        (!!expr.options && expressionHasAwait(expr.options as Expression))
      )
    case 'YieldExpression':
      return expr.argument ? expressionHasAwait(expr.argument as Expression) : false
    case 'TaggedTemplateExpression':
      return (
        expressionHasAwait(expr.tag as Expression) ||
        expr.quasi.expressions.some(ex => expressionHasAwait(ex as Expression))
      )
    case 'ClassExpression':
      return expr.superClass ? expressionHasAwait(expr.superClass as Expression) : false
    case 'ArrowFunction':
    case 'FunctionExpression':
      return false
    default:
      return false
  }
}

export function functionHasAsyncAwait(fn: HIRFunction): boolean {
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if ((instr.kind === 'Assign' || instr.kind === 'Expression') && instr.value) {
        if (expressionHasAwait(instr.value)) return true
      }
    }
    if (terminatorHasAwait(block.terminator)) return true
  }
  return false
}

function expressionHasYield(expr: Expression): boolean {
  switch (expr.kind) {
    case 'Identifier':
    case 'Literal':
    case 'ThisExpression':
    case 'SuperExpression':
      return false
    case 'CallExpression':
    case 'OptionalCallExpression':
      return (
        expressionHasYield(expr.callee as Expression) ||
        expr.arguments.some(arg => expressionHasYield(arg as Expression))
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return (
        expressionHasYield(expr.object as Expression) ||
        (expr.computed ? expressionHasYield(expr.property as Expression) : false)
      )
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        expressionHasYield(expr.left as Expression) || expressionHasYield(expr.right as Expression)
      )
    case 'UnaryExpression':
      return expressionHasYield(expr.argument as Expression)
    case 'ConditionalExpression':
      return (
        expressionHasYield(expr.test as Expression) ||
        expressionHasYield(expr.consequent as Expression) ||
        expressionHasYield(expr.alternate as Expression)
      )
    case 'ArrayExpression':
      return expr.elements.some(el => (el ? expressionHasYield(el as Expression) : false))
    case 'ObjectExpression':
      return expr.properties.some(prop =>
        prop.kind === 'SpreadElement'
          ? expressionHasYield(prop.argument as Expression)
          : (prop.computed && expressionHasYield(prop.key as Expression)) ||
            expressionHasYield(prop.value as Expression),
      )
    case 'TemplateLiteral':
      return expr.expressions.some(e => expressionHasYield(e as Expression))
    case 'SpreadElement':
      return expressionHasYield(expr.argument as Expression)
    case 'SequenceExpression':
      return expr.expressions.some(e => expressionHasYield(e as Expression))
    case 'AwaitExpression':
      return expressionHasYield(expr.argument as Expression)
    case 'NewExpression':
      return (
        expressionHasYield(expr.callee as Expression) ||
        expr.arguments.some(arg => expressionHasYield(arg as Expression))
      )
    case 'ImportExpression':
      return (
        expressionHasYield(expr.source as Expression) ||
        (!!expr.options && expressionHasYield(expr.options as Expression))
      )
    case 'YieldExpression':
      return true
    case 'TaggedTemplateExpression':
      return (
        expressionHasYield(expr.tag as Expression) ||
        expr.quasi.expressions.some(ex => expressionHasYield(ex as Expression))
      )
    case 'ClassExpression':
      return expr.superClass ? expressionHasYield(expr.superClass as Expression) : false
    case 'AssignmentExpression':
      return (
        expressionHasYield(expr.left as Expression) || expressionHasYield(expr.right as Expression)
      )
    case 'UpdateExpression':
      return expressionHasYield(expr.argument as Expression)
    case 'ArrowFunction':
    case 'FunctionExpression':
      return false
    default:
      return false
  }
}

function terminatorHasYield(term: Terminator): boolean {
  switch (term.kind) {
    case 'Return':
      return term.argument ? expressionHasYield(term.argument as Expression) : false
    case 'Throw':
      return expressionHasYield(term.argument as Expression)
    case 'Branch':
      return expressionHasYield(term.test as Expression)
    case 'Switch':
      return (
        expressionHasYield(term.discriminant as Expression) ||
        term.cases.some(c => (c.test ? expressionHasYield(c.test as Expression) : false))
      )
    case 'ForOf':
      return (
        expressionHasYield(term.iterable as Expression) ||
        (!!term.assignmentTarget && expressionHasYield(term.assignmentTarget as Expression))
      )
    case 'ForIn':
      return (
        expressionHasYield(term.object as Expression) ||
        (!!term.assignmentTarget && expressionHasYield(term.assignmentTarget as Expression))
      )
    case 'Try':
    case 'Jump':
    case 'Break':
    case 'Continue':
    case 'Unreachable':
      return false
    default:
      return false
  }
}

export function functionHasYield(fn: HIRFunction): boolean {
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if ((instr.kind === 'Assign' || instr.kind === 'Expression') && instr.value) {
        if (expressionHasYield(instr.value)) return true
      }
    }
    if (terminatorHasYield(block.terminator)) return true
  }
  return false
}

export function collectStableIdentifierAliases(fn: HIRFunction): Map<string, string> {
  const mutatedAliases = collectMutatedIdentifiers(fn)
  const invalidAliases = new Set<string>()

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        if (!instr.declarationKind) {
          mutatedAliases.add(target)
          invalidAliases.add(target)
        }
      } else if (instr.kind === 'Phi') {
        const target = deSSAVarName(instr.target.name)
        mutatedAliases.add(target)
        invalidAliases.add(target)
      }
    }
  }

  const aliasSources = new Map<string, string>()
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind !== 'Assign' || !instr.declarationKind) continue
      if (instr.value.kind !== 'Identifier') continue

      const target = deSSAVarName(instr.target.name)
      if (mutatedAliases.has(target) || invalidAliases.has(target)) continue

      const source = deSSAVarName(instr.value.name)
      if (source === target) continue
      const previous = aliasSources.get(target)
      if (previous !== undefined && previous !== source) {
        invalidAliases.add(target)
        aliasSources.delete(target)
        continue
      }
      aliasSources.set(target, source)
    }
  }

  return aliasSources
}

export function collectIdentifierAliasesFromRoots(
  fn: HIRFunction,
  roots: Set<string>,
  allowedAliases?: Set<string>,
): Set<string> {
  const aliases = new Set<string>()
  const aliasSources = collectStableIdentifierAliases(fn)

  let changed = true
  while (changed) {
    changed = false
    for (const [alias, source] of aliasSources) {
      if (allowedAliases && !allowedAliases.has(alias)) continue
      if ((roots.has(source) || aliases.has(source)) && !aliases.has(alias)) {
        aliases.add(alias)
        changed = true
      }
    }
  }

  return aliases
}

function getIdentifierRootName(expr: Expression): string | null {
  if (expr.kind === 'Identifier') return deSSAVarName(expr.name)
  if (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') {
    return getIdentifierRootName(expr.object)
  }
  return null
}

function getStaticMemberName(
  expr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
): string {
  if (!expr.computed && expr.property.kind === 'Identifier') return expr.property.name
  if (expr.property.kind === 'Literal') {
    if (typeof expr.property.value === 'string' || typeof expr.property.value === 'number') {
      return String(expr.property.value)
    }
  }
  return '*'
}

function formatMemberMutationPath(expr: Expression): string | null {
  if (expr.kind === 'Identifier') return deSSAVarName(expr.name)
  if (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') {
    const base = formatMemberMutationPath(expr.object)
    if (!base) return null
    return `${base}.${getStaticMemberName(expr)}`
  }
  return null
}

function getCallMemberName(expr: Expression): { objectName: string; propertyName: string } | null {
  if (expr.kind !== 'MemberExpression' && expr.kind !== 'OptionalMemberExpression') return null
  if (expr.object.kind !== 'Identifier') return null
  return {
    objectName: deSSAVarName(expr.object.name),
    propertyName: getStaticMemberName(expr),
  }
}

function collectFunctionMutationExpression(
  expr: Expression | null | undefined,
  ownerByName: Map<string, string>,
  mutations: Map<string, Set<string>>,
  shadowed = new Set<string>(),
): void {
  if (!expr) return
  const recordNameMutation = (
    name: string,
    detail: string,
    activeShadowed: Set<string> = shadowed,
  ): void => {
    const normalized = deSSAVarName(name)
    if (activeShadowed.has(normalized)) return
    const owner = ownerByName.get(normalized)
    if (!owner) return
    const details = mutations.get(owner) ?? new Set<string>()
    details.add(detail)
    mutations.set(owner, details)
  }
  const recordTarget = (target: Expression, detail: string): void => {
    const root = getIdentifierRootName(target)
    if (!root) return
    recordNameMutation(root, detail)
  }
  const recordMutationTarget = (target: Expression, kind: string): void => {
    const path = formatMemberMutationPath(target) ?? getIdentifierRootName(target) ?? '*'
    recordTarget(target, `${kind} ${path}`)
  }
  const collectBlockMutations = (blocks: BasicBlock[], inheritedShadowed: Set<string>): void => {
    const localShadowed = new Set(inheritedShadowed)
    for (const block of blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign' && instr.declarationKind) {
          localShadowed.add(deSSAVarName(instr.target.name))
        }
      }
    }

    for (const block of blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign' && !instr.declarationKind) {
          const targetName = deSSAVarName(instr.target.name)
          recordNameMutation(targetName, `= ${targetName}`, localShadowed)
        }
        if (instr.kind === 'Assign' || instr.kind === 'Expression') {
          collectFunctionMutationExpression(instr.value, ownerByName, mutations, localShadowed)
        }
      }
      switch (block.terminator.kind) {
        case 'Return':
          collectFunctionMutationExpression(
            block.terminator.argument ?? null,
            ownerByName,
            mutations,
            localShadowed,
          )
          break
        case 'Throw':
          collectFunctionMutationExpression(
            block.terminator.argument,
            ownerByName,
            mutations,
            localShadowed,
          )
          break
        case 'Branch':
          collectFunctionMutationExpression(
            block.terminator.test,
            ownerByName,
            mutations,
            localShadowed,
          )
          break
        case 'Switch':
          collectFunctionMutationExpression(
            block.terminator.discriminant,
            ownerByName,
            mutations,
            localShadowed,
          )
          block.terminator.cases.forEach(item =>
            collectFunctionMutationExpression(
              item.test ?? null,
              ownerByName,
              mutations,
              localShadowed,
            ),
          )
          break
        case 'ForOf':
          collectFunctionMutationExpression(
            block.terminator.iterable,
            ownerByName,
            mutations,
            localShadowed,
          )
          collectFunctionMutationExpression(
            block.terminator.assignmentTarget ?? null,
            ownerByName,
            mutations,
            localShadowed,
          )
          break
        case 'ForIn':
          collectFunctionMutationExpression(
            block.terminator.object,
            ownerByName,
            mutations,
            localShadowed,
          )
          collectFunctionMutationExpression(
            block.terminator.assignmentTarget ?? null,
            ownerByName,
            mutations,
            localShadowed,
          )
          break
        default:
          break
      }
    }
  }

  walkExpression(
    expr,
    node => {
      if (node.kind === 'ArrowFunction') {
        const nextShadowed = new Set(shadowed)
        node.params.forEach(param => nextShadowed.add(deSSAVarName(param.name)))
        if (node.isExpression && !Array.isArray(node.body)) {
          collectFunctionMutationExpression(node.body, ownerByName, mutations, nextShadowed)
        } else if (Array.isArray(node.body)) {
          collectBlockMutations(node.body, nextShadowed)
        }
        return
      }
      if (node.kind === 'FunctionExpression') {
        const nextShadowed = new Set(shadowed)
        if (node.name) nextShadowed.add(deSSAVarName(node.name))
        node.params.forEach(param => nextShadowed.add(deSSAVarName(param.name)))
        collectBlockMutations(node.body, nextShadowed)
        return
      }
      if (node.kind === 'AssignmentExpression') {
        recordMutationTarget(node.left, node.operator)
        return
      }
      if (node.kind === 'UpdateExpression') {
        recordMutationTarget(node.argument, node.operator)
        return
      }
      if (node.kind === 'UnaryExpression' && node.operator === 'delete') {
        recordMutationTarget(node.argument, 'delete')
        return
      }
      if (node.kind !== 'CallExpression' && node.kind !== 'OptionalCallExpression') return
      const member = getCallMemberName(node.callee)
      if (!member) return
      const firstArg = node.arguments[0]
      if (!firstArg) return
      if (member.objectName === 'Object' && member.propertyName === 'defineProperty') {
        recordTarget(firstArg, 'Object.defineProperty')
        return
      }
      if (member.objectName === 'Object' && member.propertyName === 'assign') {
        recordTarget(firstArg, 'Object.assign')
      }
    },
    { includeFunctionBodies: false },
  )
}

export function collectFunctionDependencyMutations(
  fn: HIRFunction,
  functionNames: Set<string>,
): Map<string, string[]> {
  const aliasSources = collectStableIdentifierAliases(fn)
  const ownerByName = new Map<string, string>()
  for (const name of functionNames) {
    ownerByName.set(name, name)
  }

  const resolveOwner = (name: string, seen = new Set<string>()): string | null => {
    if (ownerByName.has(name)) return ownerByName.get(name) ?? null
    if (seen.has(name)) return null
    seen.add(name)
    const source = aliasSources.get(name)
    if (!source) return null
    const owner = resolveOwner(source, seen)
    if (owner) ownerByName.set(name, owner)
    return owner
  }

  for (const alias of aliasSources.keys()) {
    resolveOwner(alias)
  }

  const mutations = new Map<string, Set<string>>()
  const recordBindingMutation = (name: string, detail: string): void => {
    const owner = resolveOwner(name)
    if (!owner) return
    const details = mutations.get(owner) ?? new Set<string>()
    details.add(detail)
    mutations.set(owner, details)
  }
  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' && !instr.declarationKind) {
        const targetName = deSSAVarName(instr.target.name)
        recordBindingMutation(targetName, `= ${targetName}`)
      }
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        collectFunctionMutationExpression(instr.value, ownerByName, mutations)
      }
    }
    switch (block.terminator.kind) {
      case 'Return':
        collectFunctionMutationExpression(block.terminator.argument ?? null, ownerByName, mutations)
        break
      case 'Throw':
        collectFunctionMutationExpression(block.terminator.argument, ownerByName, mutations)
        break
      case 'Branch':
        collectFunctionMutationExpression(block.terminator.test, ownerByName, mutations)
        break
      case 'Switch':
        collectFunctionMutationExpression(block.terminator.discriminant, ownerByName, mutations)
        block.terminator.cases.forEach(item =>
          collectFunctionMutationExpression(item.test ?? null, ownerByName, mutations),
        )
        break
      case 'ForOf':
        collectFunctionMutationExpression(block.terminator.iterable, ownerByName, mutations)
        collectFunctionMutationExpression(
          block.terminator.assignmentTarget ?? null,
          ownerByName,
          mutations,
        )
        break
      case 'ForIn':
        collectFunctionMutationExpression(block.terminator.object, ownerByName, mutations)
        collectFunctionMutationExpression(
          block.terminator.assignmentTarget ?? null,
          ownerByName,
          mutations,
        )
        break
      default:
        break
    }
  }

  return new Map(
    Array.from(mutations.entries(), ([name, details]) => [name, Array.from(details).sort()]),
  )
}

export function collectCalledIdentifiers(
  fn: HIRFunction,
  shadowRootNames?: Set<string>,
): Set<string> {
  const called = new Set<string>()
  const aliasSources = collectStableIdentifierAliases(fn)
  const shadowRoots = shadowRootNames ?? new Set<string>()

  const getStaticMemberName = (
    expr: Extract<Expression, { kind: 'MemberExpression' | 'OptionalMemberExpression' }>,
  ): string | null => {
    if (!expr.computed && expr.property.kind === 'Identifier') return expr.property.name
    if (expr.property.kind === 'Literal') {
      return typeof expr.property.value === 'string' ? expr.property.value : null
    }
    return null
  }

  const recordCalledIdentifier = (callee: Expression, shadowed: Set<string>): boolean => {
    if (callee.kind === 'Identifier') {
      const name = deSSAVarName(callee.name)
      if (!shadowed.has(name)) called.add(name)
      return true
    }
    if (callee.kind === 'MemberExpression' || callee.kind === 'OptionalMemberExpression') {
      const methodName = getStaticMemberName(callee)
      if (
        (methodName === 'call' || methodName === 'apply') &&
        callee.object.kind === 'Identifier'
      ) {
        const name = deSSAVarName(callee.object.name)
        if (!shadowed.has(name)) called.add(name)
        return true
      }
    }
    return false
  }

  const withRootShadow = (shadowed: Set<string>, name: string | undefined | null): Set<string> => {
    if (!name || !shadowRoots.has(name)) return shadowed
    const next = new Set(shadowed)
    next.add(name)
    return next
  }
  const collectPatternRootNames = (
    pattern: LVal | null | undefined,
    into = new Set<string>(),
  ): Set<string> => {
    if (!pattern || typeof pattern !== 'object') return into
    const node = pattern as {
      type?: string
      name?: unknown
      left?: unknown
      argument?: unknown
      properties?: unknown
      value?: unknown
      elements?: unknown
    }
    if (node.type === 'Identifier' && typeof node.name === 'string') {
      into.add(deSSAVarName(node.name))
      return into
    }
    if (node.type === 'AssignmentPattern') {
      collectPatternRootNames(node.left as LVal, into)
      return into
    }
    if (node.type === 'RestElement') {
      collectPatternRootNames(node.argument as LVal, into)
      return into
    }
    if (node.type === 'ObjectPattern' && Array.isArray(node.properties)) {
      for (const prop of node.properties) {
        if (!prop || typeof prop !== 'object') continue
        const current = prop as { type?: string; value?: unknown; argument?: unknown }
        collectPatternRootNames(
          (current.type === 'RestElement' ? current.argument : current.value) as LVal,
          into,
        )
      }
      return into
    }
    if (node.type === 'ArrayPattern' && Array.isArray(node.elements)) {
      for (const element of node.elements) {
        collectPatternRootNames(element as LVal, into)
      }
    }
    return into
  }
  const withRootShadows = (shadowed: Set<string>, names: Iterable<string>): Set<string> => {
    let next = shadowed
    for (const name of names) {
      next = withRootShadow(next, name)
    }
    return next
  }

  const staticTruthiness = (expr: Expression): boolean | null => {
    if (expr.kind !== 'Literal') return null
    return Boolean(expr.value)
  }

  const visitExpr = (expr: Expression | undefined | null, shadowed = new Set<string>()) => {
    if (!expr) return
    switch (expr.kind) {
      case 'Identifier':
        return
      case 'CallExpression': {
        if (!recordCalledIdentifier(expr.callee as Expression, shadowed)) {
          visitExpr(expr.callee as Expression, shadowed)
        }
        expr.arguments.forEach(arg => visitExpr(arg as Expression, shadowed))
        return
      }
      case 'OptionalCallExpression': {
        if (!recordCalledIdentifier(expr.callee as Expression, shadowed)) {
          visitExpr(expr.callee as Expression, shadowed)
        }
        expr.arguments.forEach(arg => visitExpr(arg as Expression, shadowed))
        return
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visitExpr(expr.object as Expression, shadowed)
        visitExpr(expr.property as Expression, shadowed)
        return
      case 'UnaryExpression':
      case 'AwaitExpression':
        visitExpr(expr.argument as Expression, shadowed)
        return
      case 'AssignmentExpression':
        visitExpr(expr.left as Expression, shadowed)
        visitExpr(expr.right as Expression, shadowed)
        return
      case 'UpdateExpression':
        visitExpr(expr.argument as Expression, shadowed)
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
        visitExpr(expr.left as Expression, shadowed)
        visitExpr(expr.right as Expression, shadowed)
        return
      case 'TemplateLiteral':
        expr.expressions.forEach(item => visitExpr(item as Expression, shadowed))
        return
      case 'TaggedTemplateExpression':
        if (!recordCalledIdentifier(expr.tag as Expression, shadowed)) {
          visitExpr(expr.tag as Expression, shadowed)
        }
        visitExpr(expr.quasi, shadowed)
        return
      case 'SequenceExpression':
        expr.expressions.forEach(item => visitExpr(item as Expression, shadowed))
        return
      case 'NewExpression':
        if (!recordCalledIdentifier(expr.callee as Expression, shadowed)) {
          visitExpr(expr.callee as Expression, shadowed)
        }
        expr.arguments.forEach(arg => visitExpr(arg as Expression, shadowed))
        return
      case 'ImportExpression':
        visitExpr(expr.source as Expression, shadowed)
        visitExpr(expr.options ?? null, shadowed)
        return
      case 'YieldExpression':
        visitExpr(expr.argument ?? null, shadowed)
        return
      case 'SpreadElement':
        visitExpr(expr.argument as Expression, shadowed)
        return
      case 'ClassExpression':
        visitExpr(expr.superClass ?? null, shadowed)
        return
      case 'ConditionalExpression':
        visitExpr(expr.test as Expression, shadowed)
        visitExpr(expr.consequent as Expression, shadowed)
        visitExpr(expr.alternate as Expression, shadowed)
        return
      case 'ArrayExpression':
        expr.elements.forEach(el => visitExpr(el as Expression, shadowed))
        return
      case 'ObjectExpression':
        expr.properties.forEach(p => {
          if (p.kind === 'SpreadElement') {
            visitExpr(p.argument as Expression, shadowed)
          } else {
            if (p.computed) visitExpr(p.key as Expression, shadowed)
            visitExpr(p.value as Expression, shadowed)
          }
        })
        return
      case 'ArrowFunction': {
        let fnShadowed = shadowed
        expr.params.forEach(param => {
          fnShadowed = withRootShadow(fnShadowed, deSSAVarName(param.name))
        })
        if (Array.isArray(expr.body)) {
          visitBlocks(expr.body, fnShadowed)
        } else {
          visitExpr(expr.body as Expression, fnShadowed)
        }
        return
      }
      case 'FunctionExpression': {
        let fnShadowed = shadowed
        expr.params.forEach(param => {
          fnShadowed = withRootShadow(fnShadowed, deSSAVarName(param.name))
        })
        visitBlocks(expr.body, fnShadowed)
        return
      }
      case 'JSXElement':
        expr.attributes.forEach(attr => {
          if (attr.isSpread && attr.spreadExpr) {
            visitExpr(attr.spreadExpr, shadowed)
          } else if (attr.value) {
            visitExpr(attr.value, shadowed)
          }
        })
        expr.children.forEach(child => {
          if (child.kind === 'expression') {
            visitExpr(child.value, shadowed)
          } else if (child.kind === 'element') {
            visitExpr(child.value, shadowed)
          }
        })
        return
      default:
        return
    }
  }

  const visitTerminator = (
    term: BasicBlock['terminator'],
    shadowed: Set<string>,
    visitBlockById?: (id: number, shadowed: Set<string>) => void,
  ) => {
    switch (term.kind) {
      case 'Branch':
        visitExpr(term.test, shadowed)
        switch (staticTruthiness(term.test)) {
          case true:
            visitBlockById?.(term.consequent, shadowed)
            break
          case false:
            visitBlockById?.(term.alternate, shadowed)
            break
          default:
            visitBlockById?.(term.consequent, shadowed)
            visitBlockById?.(term.alternate, shadowed)
            break
        }
        return
      case 'Switch':
        visitExpr(term.discriminant, shadowed)
        term.cases.forEach(c => {
          visitExpr(c.test, shadowed)
          visitBlockById?.(c.target, shadowed)
        })
        return
      case 'ForOf':
        visitExpr(term.iterable, shadowed)
        visitExpr(term.assignmentTarget ?? null, shadowed)
        visitBlockById?.(
          term.body,
          term.leftKind === 'declaration'
            ? withRootShadow(shadowed, deSSAVarName(term.variable))
            : shadowed,
        )
        visitBlockById?.(term.exit, shadowed)
        return
      case 'ForIn':
        visitExpr(term.object, shadowed)
        visitExpr(term.assignmentTarget ?? null, shadowed)
        visitBlockById?.(
          term.body,
          term.leftKind === 'declaration'
            ? withRootShadow(shadowed, deSSAVarName(term.variable))
            : shadowed,
        )
        visitBlockById?.(term.exit, shadowed)
        return
      case 'Try':
        visitBlockById?.(term.tryBlock, shadowed)
        if (term.catchBlock !== undefined) {
          visitBlockById?.(
            term.catchBlock,
            term.catchPattern
              ? withRootShadows(shadowed, collectPatternRootNames(term.catchPattern))
              : term.catchParam
                ? withRootShadow(shadowed, deSSAVarName(term.catchParam))
                : shadowed,
          )
        }
        if (term.finallyBlock !== undefined) visitBlockById?.(term.finallyBlock, shadowed)
        visitBlockById?.(term.exit, shadowed)
        return
      case 'Return':
        visitExpr(term.argument ?? null, shadowed)
        return
      case 'Throw':
        visitExpr(term.argument, shadowed)
        return
      case 'Jump':
      case 'Break':
      case 'Continue':
        visitBlockById?.(term.target, shadowed)
        return
      default:
        return
    }
  }

  function visitBlocks(blocks: BasicBlock[], initialShadowed: Set<string>): void {
    const byId = new Map(blocks.map(block => [block.id, block]))
    const visited = new Set<string>()
    const visitBlockById = (id: number, shadowed: Set<string>): void => {
      const block = byId.get(id)
      if (!block) return
      const key = `${id}:${Array.from(shadowed).sort().join(',')}`
      if (visited.has(key)) return
      visited.add(key)

      let blockShadowed = shadowed
      block.instructions.forEach(instr => {
        if (instr.kind === 'Assign') {
          visitExpr(instr.value, blockShadowed)
          if (instr.declarationKind) {
            blockShadowed = withRootShadow(blockShadowed, deSSAVarName(instr.target.name))
          }
        } else if (instr.kind === 'Expression') {
          visitExpr(instr.value, blockShadowed)
        }
      })
      visitTerminator(block.terminator, blockShadowed, visitBlockById)
    }

    if (blocks[0]) visitBlockById(blocks[0].id, initialShadowed)
  }

  if (shadowRoots.size > 0) {
    visitBlocks(fn.blocks, new Set())
  } else {
    for (const block of fn.blocks) {
      block.instructions.forEach(instr => {
        if (instr.kind === 'Assign') {
          visitExpr(instr.value)
        } else if (instr.kind === 'Expression') {
          visitExpr(instr.value)
        }
      })
      visitTerminator(block.terminator, new Set())
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const [alias, source] of aliasSources) {
      if (called.has(alias) && !called.has(source)) {
        called.add(source)
        changed = true
      }
    }
  }

  return called
}

function collectMutatedIdentifiersFromExpression(
  expr: Expression | null | undefined,
  into: Set<string>,
): void {
  if (!expr) return
  walkExpression(
    expr,
    node => {
      if (node.kind === 'AssignmentExpression' && node.left.kind === 'Identifier') {
        into.add(deSSAVarName(node.left.name))
      } else if (node.kind === 'UpdateExpression' && node.argument.kind === 'Identifier') {
        into.add(deSSAVarName(node.argument.name))
      }
    },
    { includeFunctionBodies: false },
  )
}

function collectMutatedIdentifiersFromAssignmentTarget(
  target: Expression | null | undefined,
  into: Set<string>,
): void {
  if (!target) return
  if (target.kind === 'Identifier') {
    into.add(deSSAVarName(target.name))
    return
  }
  if (target.kind === 'MemberExpression' || target.kind === 'OptionalMemberExpression') {
    collectMutatedIdentifiersFromAssignmentTarget(target.object, into)
    if (target.computed) collectMutatedIdentifiersFromExpression(target.property, into)
  }
}

function collectMemberMutationRootFromTarget(
  target: Expression | null | undefined,
  into: Set<string>,
): void {
  if (!target) return
  if (target.kind !== 'MemberExpression' && target.kind !== 'OptionalMemberExpression') return

  let object = target.object
  while (object.kind === 'MemberExpression' || object.kind === 'OptionalMemberExpression') {
    object = object.object
  }
  if (object.kind === 'Identifier') {
    into.add(deSSAVarName(object.name))
  }
}

function collectMemberMutatedIdentifiersFromExpression(
  expr: Expression | null | undefined,
  into: Set<string>,
): void {
  if (!expr) return
  walkExpression(
    expr,
    node => {
      if (node.kind === 'AssignmentExpression') {
        collectMemberMutationRootFromTarget(node.left, into)
      } else if (node.kind === 'UpdateExpression') {
        collectMemberMutationRootFromTarget(node.argument, into)
      }
    },
    { includeFunctionBodies: false },
  )
}

function collectMemberMutatedIdentifiersFromTerminator(term: Terminator, into: Set<string>): void {
  switch (term.kind) {
    case 'Return':
      collectMemberMutatedIdentifiersFromExpression(term.argument ?? null, into)
      return
    case 'Throw':
      collectMemberMutatedIdentifiersFromExpression(term.argument, into)
      return
    case 'Branch':
      collectMemberMutatedIdentifiersFromExpression(term.test, into)
      return
    case 'Switch':
      collectMemberMutatedIdentifiersFromExpression(term.discriminant, into)
      term.cases.forEach(c => collectMemberMutatedIdentifiersFromExpression(c.test ?? null, into))
      return
    case 'ForOf':
      collectMemberMutatedIdentifiersFromExpression(term.iterable, into)
      collectMemberMutationRootFromTarget(term.assignmentTarget ?? null, into)
      return
    case 'ForIn':
      collectMemberMutatedIdentifiersFromExpression(term.object, into)
      collectMemberMutationRootFromTarget(term.assignmentTarget ?? null, into)
      return
    case 'Jump':
    case 'Unreachable':
    case 'Break':
    case 'Continue':
    case 'Try':
      return
    default:
      assertNever(term)
  }
}

function collectMutatedIdentifiersFromTerminator(term: Terminator, into: Set<string>): void {
  switch (term.kind) {
    case 'Return':
      collectMutatedIdentifiersFromExpression(term.argument ?? null, into)
      return
    case 'Throw':
      collectMutatedIdentifiersFromExpression(term.argument, into)
      return
    case 'Branch':
      collectMutatedIdentifiersFromExpression(term.test, into)
      return
    case 'Switch':
      collectMutatedIdentifiersFromExpression(term.discriminant, into)
      term.cases.forEach(c => collectMutatedIdentifiersFromExpression(c.test ?? null, into))
      return
    case 'ForOf':
      collectMutatedIdentifiersFromExpression(term.iterable, into)
      collectMutatedIdentifiersFromExpression(term.assignmentTarget ?? null, into)
      collectMutatedIdentifiersFromAssignmentTarget(term.assignmentTarget ?? null, into)
      return
    case 'ForIn':
      collectMutatedIdentifiersFromExpression(term.object, into)
      collectMutatedIdentifiersFromExpression(term.assignmentTarget ?? null, into)
      collectMutatedIdentifiersFromAssignmentTarget(term.assignmentTarget ?? null, into)
      return
    case 'Jump':
    case 'Unreachable':
    case 'Break':
    case 'Continue':
    case 'Try':
      return
    default:
      assertNever(term)
  }
}

export function collectMutatedIdentifiers(fn: HIRFunction): Set<string> {
  const mutated = new Set<string>()

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        collectMutatedIdentifiersFromExpression(instr.value, mutated)
      }
    }
    collectMutatedIdentifiersFromTerminator(block.terminator, mutated)
  }

  return mutated
}

export function collectMemberMutatedIdentifiers(fn: HIRFunction): Set<string> {
  const mutated = new Set<string>()

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign' || instr.kind === 'Expression') {
        collectMemberMutatedIdentifiersFromExpression(instr.value, mutated)
      }
    }
    collectMemberMutatedIdentifiersFromTerminator(block.terminator, mutated)
  }

  return mutated
}
