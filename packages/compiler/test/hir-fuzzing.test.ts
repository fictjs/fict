import { describe, it, expect } from 'vitest'

import type {
  BasicBlock,
  BlockId,
  Expression,
  HIRFunction,
  HIRProgram,
  Identifier,
  Instruction,
  Terminator,
} from '../src/ir/hir'
import { getSSABaseName } from '../src/ir/hir'
import { optimizeHIR } from '../src/ir/optimize'

// ============================================================================
// Seeded PRNG (Mulberry32)
// ============================================================================

class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.nextInt(0, arr.length - 1)]!
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability
  }
}

// ============================================================================
// HIR Generators
// ============================================================================

interface GeneratorContext {
  rng: SeededRandom
  blockIdCounter: number
  varCounter: number
  definedVars: string[]
  depth: number
  maxDepth: number
}

function createContext(seed: number): GeneratorContext {
  return {
    rng: new SeededRandom(seed),
    blockIdCounter: 0,
    varCounter: 0,
    definedVars: [],
    depth: 0,
    maxDepth: 3,
  }
}

function generateIdentifier(ctx: GeneratorContext, forDefinition = false): Identifier {
  if (forDefinition) {
    const name = `v${ctx.varCounter++}`
    ctx.definedVars.push(name)
    return { kind: 'Identifier', name }
  }
  if (ctx.definedVars.length === 0) {
    // Keep generated programs closed over declared bindings.
    const name = `v${ctx.varCounter++}`
    ctx.definedVars.push(name)
    return { kind: 'Identifier', name }
  }
  return { kind: 'Identifier', name: ctx.rng.pick(ctx.definedVars) }
}

function generateLiteral(ctx: GeneratorContext): Expression {
  const type = ctx.rng.nextInt(0, 4)
  switch (type) {
    case 0:
      return { kind: 'Literal', value: ctx.rng.nextInt(-100, 100) }
    case 1:
      return { kind: 'Literal', value: ctx.rng.next() }
    case 2:
      return { kind: 'Literal', value: ctx.rng.bool() }
    case 3:
      return { kind: 'Literal', value: `str_${ctx.rng.nextInt(0, 99)}` }
    default:
      return { kind: 'Literal', value: null }
  }
}

const BINARY_OPERATORS = ['+', '-', '*', '/', '%', '===', '!==', '<', '>', '<=', '>=', '&&', '||']

function generateBinaryExpression(ctx: GeneratorContext): Expression {
  return {
    kind: 'BinaryExpression',
    operator: ctx.rng.pick(BINARY_OPERATORS),
    left: generateExpression(ctx),
    right: generateExpression(ctx),
  }
}

const UNARY_OPERATORS = ['!', '-', '+', 'typeof']

function generateUnaryExpression(ctx: GeneratorContext): Expression {
  return {
    kind: 'UnaryExpression',
    operator: ctx.rng.pick(UNARY_OPERATORS),
    argument: generateExpression(ctx),
    prefix: true,
  }
}

function generateCallExpression(ctx: GeneratorContext): Expression {
  const argCount = ctx.rng.nextInt(0, 3)
  const args: Expression[] = []
  for (let i = 0; i < argCount; i++) {
    args.push(generateExpression(ctx))
  }
  return {
    kind: 'CallExpression',
    callee: generateIdentifier(ctx),
    arguments: args,
    pure: ctx.rng.bool(0.3),
  }
}

function generateArrayExpression(ctx: GeneratorContext): Expression {
  const elemCount = ctx.rng.nextInt(0, 4)
  const elements: Expression[] = []
  for (let i = 0; i < elemCount; i++) {
    elements.push(generateExpression(ctx))
  }
  return {
    kind: 'ArrayExpression',
    elements,
  }
}

function generateObjectExpression(ctx: GeneratorContext): Expression {
  const propCount = ctx.rng.nextInt(0, 3)
  const properties: Expression['kind'] extends 'ObjectExpression'
    ? Expression extends { properties: infer P }
      ? P
      : never
    : never = []
  for (let i = 0; i < propCount; i++) {
    ;(properties as any[]).push({
      kind: 'Property',
      key: { kind: 'Identifier', name: `prop${i}` },
      value: generateExpression(ctx),
      shorthand: false,
    })
  }
  return {
    kind: 'ObjectExpression',
    properties,
  } as Expression
}

function generateExpression(ctx: GeneratorContext): Expression {
  ctx.depth++
  try {
    if (ctx.depth > ctx.maxDepth) {
      return ctx.rng.bool(0.5) ? generateLiteral(ctx) : generateIdentifier(ctx)
    }

    const type = ctx.rng.nextInt(0, 7)
    switch (type) {
      case 0:
        return generateLiteral(ctx)
      case 1:
        return generateIdentifier(ctx)
      case 2:
        return generateBinaryExpression(ctx)
      case 3:
        return generateUnaryExpression(ctx)
      case 4:
        return generateCallExpression(ctx)
      case 5:
        return generateArrayExpression(ctx)
      case 6:
        return generateObjectExpression(ctx)
      default:
        return {
          kind: 'ConditionalExpression',
          test: generateExpression(ctx),
          consequent: generateExpression(ctx),
          alternate: generateExpression(ctx),
        }
    }
  } finally {
    ctx.depth--
  }
}

function generateInstruction(ctx: GeneratorContext): Instruction {
  if (ctx.definedVars.length === 0 || ctx.rng.bool(0.7)) {
    const targetName = `v${ctx.varCounter++}`
    const target: Identifier = { kind: 'Identifier', name: targetName }
    const value = generateExpression(ctx)
    ctx.definedVars.push(targetName)
    return {
      kind: 'Assign',
      target,
      value,
      declarationKind: ctx.rng.pick(['const', 'let', 'var']),
    }
  }
  return {
    kind: 'Expression',
    value: generateExpression(ctx),
  }
}

function generateTerminator(ctx: GeneratorContext, availableTargets: BlockId[]): Terminator {
  if (availableTargets.length === 0) {
    return ctx.rng.bool(0.8)
      ? { kind: 'Return', argument: ctx.rng.bool(0.7) ? generateExpression(ctx) : undefined }
      : { kind: 'Unreachable' }
  }

  const type = ctx.rng.nextInt(0, 3)
  switch (type) {
    case 0:
      return {
        kind: 'Jump',
        target: ctx.rng.pick(availableTargets),
      }
    case 1:
      return {
        kind: 'Branch',
        test: generateExpression(ctx),
        consequent: ctx.rng.pick(availableTargets),
        alternate: ctx.rng.pick(availableTargets),
      }
    case 2:
      return {
        kind: 'Return',
        argument: ctx.rng.bool(0.7) ? generateExpression(ctx) : undefined,
      }
    default:
      return { kind: 'Unreachable' }
  }
}

function generateBasicBlock(
  ctx: GeneratorContext,
  blockId: BlockId,
  availableTargets: BlockId[],
): BasicBlock {
  const instrCount = ctx.rng.nextInt(1, 5)
  const instructions: Instruction[] = []
  for (let i = 0; i < instrCount; i++) {
    instructions.push(generateInstruction(ctx))
  }

  return {
    id: blockId,
    instructions,
    terminator: generateTerminator(ctx, availableTargets),
  }
}

function generateHIRFunction(ctx: GeneratorContext): HIRFunction {
  const previousDefinedVars = ctx.definedVars
  ctx.definedVars = []
  try {
    const paramCount = ctx.rng.nextInt(0, 3)
    const params: Identifier[] = []
    for (let i = 0; i < paramCount; i++) {
      params.push(generateIdentifier(ctx, true))
    }

    const blockCount = ctx.rng.nextInt(1, 4)
    const blocks: BasicBlock[] = []

    // Generate block IDs first
    const blockIds: BlockId[] = []
    for (let i = 0; i < blockCount; i++) {
      blockIds.push(ctx.blockIdCounter++)
    }

    // Generate blocks - each block can only jump forward to prevent cycles
    for (let i = 0; i < blockCount; i++) {
      const forwardTargets = blockIds.slice(i + 1)
      blocks.push(generateBasicBlock(ctx, blockIds[i]!, forwardTargets))
    }

    // Ensure last block always returns
    if (blocks.length > 0) {
      const lastBlock = blocks[blocks.length - 1]!
      if (lastBlock.terminator.kind !== 'Return' && lastBlock.terminator.kind !== 'Unreachable') {
        lastBlock.terminator = {
          kind: 'Return',
          argument: ctx.rng.bool(0.7) ? generateExpression(ctx) : undefined,
        }
      }
    }

    return {
      name: `fn_${ctx.rng.nextInt(0, 99)}`,
      params,
      blocks,
    }
  } finally {
    ctx.definedVars = previousDefinedVars
  }
}

function generateHIRProgram(seed: number): HIRProgram {
  const ctx = createContext(seed)
  const fnCount = ctx.rng.nextInt(1, 3)
  const functions: HIRFunction[] = []

  for (let i = 0; i < fnCount; i++) {
    functions.push(generateHIRFunction(ctx))
  }

  return {
    functions,
    preamble: [],
    postamble: [],
  }
}

// ============================================================================
// Invariant Verification
// ============================================================================

interface ReferenceCollectionOptions {
  reachableOnly?: boolean
}

function getTerminatorTargets(term: Terminator): BlockId[] {
  switch (term.kind) {
    case 'Jump':
    case 'Break':
    case 'Continue':
      return [term.target]
    case 'Branch':
      return [term.consequent, term.alternate]
    case 'Switch':
      return term.cases.map(c => c.target)
    case 'ForOf':
    case 'ForIn':
      return [term.body, term.exit]
    case 'Try':
      return [term.tryBlock, term.catchBlock, term.finallyBlock, term.exit].filter(
        (id): id is BlockId => typeof id === 'number',
      )
    case 'Return':
    case 'Throw':
    case 'Unreachable':
      return []
  }
}

function collectReachableBlockIds(fn: HIRFunction): Set<BlockId> {
  const reachable = new Set<BlockId>()
  if (fn.blocks.length === 0) return reachable

  const blockMap = new Map<BlockId, BasicBlock>()
  fn.blocks.forEach(block => blockMap.set(block.id, block))

  const entry = fn.blocks[0]!.id
  const stack: BlockId[] = [entry]

  while (stack.length > 0) {
    const blockId = stack.pop()!
    if (reachable.has(blockId)) continue
    reachable.add(blockId)

    const block = blockMap.get(blockId)
    if (!block) continue
    for (const target of getTerminatorTargets(block.terminator)) {
      if (!reachable.has(target) && blockMap.has(target)) {
        stack.push(target)
      }
    }
  }

  return reachable
}

function collectDefinedVariables(program: HIRProgram): Set<string> {
  const defined = new Set<string>()
  const addDefinedName = (name: string): void => {
    defined.add(name)
    defined.add(getSSABaseName(name))
  }

  function collectExprAssignedIdentifiers(expr: Expression): void {
    switch (expr.kind) {
      case 'AssignmentExpression':
        if (expr.left.kind === 'Identifier') {
          addDefinedName(expr.left.name)
        } else {
          collectExprAssignedIdentifiers(expr.left)
        }
        collectExprAssignedIdentifiers(expr.right)
        break
      case 'BinaryExpression':
      case 'LogicalExpression':
        collectExprAssignedIdentifiers(expr.left)
        collectExprAssignedIdentifiers(expr.right)
        break
      case 'UnaryExpression':
      case 'AwaitExpression':
      case 'SpreadElement':
        collectExprAssignedIdentifiers(expr.argument)
        break
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression':
        collectExprAssignedIdentifiers(expr.callee)
        expr.arguments.forEach(collectExprAssignedIdentifiers)
        break
      case 'ConditionalExpression':
        collectExprAssignedIdentifiers(expr.test)
        collectExprAssignedIdentifiers(expr.consequent)
        collectExprAssignedIdentifiers(expr.alternate)
        break
      case 'ArrayExpression':
        expr.elements.forEach(collectExprAssignedIdentifiers)
        break
      case 'ObjectExpression':
        for (const prop of expr.properties) {
          if (prop.kind === 'Property') {
            if (prop.computed) {
              collectExprAssignedIdentifiers(prop.key)
            }
            collectExprAssignedIdentifiers(prop.value)
          } else {
            collectExprAssignedIdentifiers(prop.argument)
          }
        }
        break
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        collectExprAssignedIdentifiers(expr.object)
        if (expr.computed) {
          collectExprAssignedIdentifiers(expr.property)
        }
        break
      case 'TemplateLiteral':
      case 'SequenceExpression':
        expr.expressions.forEach(collectExprAssignedIdentifiers)
        break
      case 'TaggedTemplateExpression':
        collectExprAssignedIdentifiers(expr.tag)
        collectExprAssignedIdentifiers(expr.quasi)
        break
      case 'ImportExpression':
        collectExprAssignedIdentifiers(expr.source)
        break
      case 'YieldExpression':
        if (expr.argument) {
          collectExprAssignedIdentifiers(expr.argument)
        }
        break
      case 'ArrowFunction':
      case 'FunctionExpression':
      case 'ClassExpression':
      case 'JSXElement':
      case 'Identifier':
      case 'Literal':
      case 'MetaProperty':
      case 'ThisExpression':
      case 'SuperExpression':
      case 'UpdateExpression':
        break
    }
  }

  for (const fn of program.functions) {
    for (const param of fn.params) {
      addDefinedName(param.name)
    }
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign') {
          addDefinedName(instr.target.name)
          collectExprAssignedIdentifiers(instr.value)
        } else if (instr.kind === 'Phi') {
          addDefinedName(instr.target.name)
        } else if (instr.kind === 'Expression') {
          collectExprAssignedIdentifiers(instr.value)
        }
      }
      if (block.terminator.kind === 'ForOf' || block.terminator.kind === 'ForIn') {
        addDefinedName(block.terminator.variable)
      } else if (block.terminator.kind === 'Try' && block.terminator.catchParam) {
        addDefinedName(block.terminator.catchParam)
      } else if (block.terminator.kind === 'Return' && block.terminator.argument) {
        collectExprAssignedIdentifiers(block.terminator.argument)
      } else if (block.terminator.kind === 'Throw') {
        collectExprAssignedIdentifiers(block.terminator.argument)
      } else if (block.terminator.kind === 'Branch') {
        collectExprAssignedIdentifiers(block.terminator.test)
      } else if (block.terminator.kind === 'Switch') {
        collectExprAssignedIdentifiers(block.terminator.discriminant)
        block.terminator.cases.forEach(c => {
          if (c.test) collectExprAssignedIdentifiers(c.test)
        })
      }
    }
  }

  return defined
}

interface ReferenceSummary {
  used: Set<string>
  maybeExternal: Set<string>
}

const KNOWN_GLOBAL_IDENTIFIERS = new Set([
  'undefined',
  'Infinity',
  'NaN',
  'globalThis',
  'window',
  'document',
  'navigator',
  'console',
  'Math',
  'Number',
  'String',
  'Boolean',
  'Object',
  'Array',
  'Date',
  'JSON',
  'Promise',
  'Symbol',
  'Set',
  'Map',
  'WeakMap',
  'WeakSet',
  'Reflect',
  'Error',
  'TypeError',
  'RegExp',
])

function collectReferenceSummary(
  program: HIRProgram,
  options: ReferenceCollectionOptions = {},
): ReferenceSummary {
  const used = new Set<string>()
  const maybeExternal = new Set<string>()

  function visitExpr(expr: Expression, options?: { calleePosition?: boolean }): void {
    switch (expr.kind) {
      case 'Identifier':
        used.add(expr.name)
        if (options?.calleePosition) {
          maybeExternal.add(expr.name)
        }
        break
      case 'BinaryExpression':
      case 'LogicalExpression':
        visitExpr(expr.left)
        visitExpr(expr.right)
        break
      case 'UnaryExpression':
        visitExpr(expr.argument)
        break
      case 'CallExpression':
      case 'OptionalCallExpression':
        visitExpr(expr.callee, { calleePosition: true })
        expr.arguments.forEach(visitExpr)
        break
      case 'NewExpression':
        visitExpr(expr.callee, { calleePosition: true })
        expr.arguments.forEach(visitExpr)
        break
      case 'TaggedTemplateExpression':
        visitExpr(expr.tag, { calleePosition: true })
        visitExpr(expr.quasi)
        break
      case 'ImportExpression':
        visitExpr(expr.source)
        break
      case 'ConditionalExpression':
        visitExpr(expr.test)
        visitExpr(expr.consequent)
        visitExpr(expr.alternate)
        break
      case 'ArrayExpression':
        expr.elements.forEach(visitExpr)
        break
      case 'ObjectExpression':
        for (const prop of expr.properties) {
          if (prop.kind === 'Property') {
            if (prop.computed) {
              visitExpr(prop.key)
            }
            visitExpr(prop.value)
          } else if (prop.kind === 'SpreadElement') {
            visitExpr(prop.argument)
          }
        }
        break
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visitExpr(expr.object)
        if (expr.computed) {
          visitExpr(expr.property)
        }
        break
      case 'AssignmentExpression':
        if (expr.left.kind !== 'Identifier') {
          visitExpr(expr.left)
        }
        visitExpr(expr.right)
        break
      case 'UpdateExpression':
        visitExpr(expr.argument)
        break
      case 'TemplateLiteral':
        expr.expressions.forEach(visitExpr)
        break
      case 'SpreadElement':
        visitExpr(expr.argument)
        break
      case 'AwaitExpression':
        visitExpr(expr.argument)
        break
      case 'SequenceExpression':
        expr.expressions.forEach(visitExpr)
        break
      case 'YieldExpression':
        if (expr.argument) visitExpr(expr.argument)
        break
      case 'ArrowFunction':
      case 'FunctionExpression':
      case 'ClassExpression':
      case 'JSXElement':
      case 'Literal':
      case 'MetaProperty':
      case 'ThisExpression':
      case 'SuperExpression':
        // Skip nested scopes or non-reference nodes.
        break
    }
  }

  function visitTerminator(term: Terminator): void {
    switch (term.kind) {
      case 'Return':
        if (term.argument) visitExpr(term.argument)
        break
      case 'Branch':
        visitExpr(term.test)
        break
      case 'Throw':
        visitExpr(term.argument)
        break
      case 'Switch':
        visitExpr(term.discriminant)
        term.cases.forEach(c => {
          if (c.test) visitExpr(c.test)
        })
        break
      case 'ForOf':
        visitExpr(term.iterable)
        break
      case 'ForIn':
        visitExpr(term.object)
        break
      case 'Jump':
      case 'Unreachable':
      case 'Break':
      case 'Continue':
      case 'Try':
        break
    }
  }

  for (const fn of program.functions) {
    const reachable = options.reachableOnly ? collectReachableBlockIds(fn) : null
    for (const block of fn.blocks) {
      if (reachable && !reachable.has(block.id)) continue
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign') {
          visitExpr(instr.value)
        } else if (instr.kind === 'Expression') {
          visitExpr(instr.value)
        } else if (instr.kind === 'Phi') {
          for (const src of instr.sources) {
            used.add(src.id.name)
          }
        }
      }
      visitTerminator(block.terminator)
    }
  }

  return { used, maybeExternal }
}

interface SideEffectEvent {
  kind: string
}

function collectSideEffectEvents(program: HIRProgram): SideEffectEvent[] {
  const events: SideEffectEvent[] = []

  const record = (kind: string): void => {
    events.push({ kind })
  }

  function visitExpr(expr: Expression): void {
    switch (expr.kind) {
      case 'CallExpression':
        visitExpr(expr.callee)
        expr.arguments.forEach(visitExpr)
        if (expr.pure !== true) {
          record('call')
        }
        break
      case 'OptionalCallExpression':
        visitExpr(expr.callee)
        expr.arguments.forEach(visitExpr)
        if (expr.pure !== true) {
          record('optional_call')
        }
        break
      case 'NewExpression':
        visitExpr(expr.callee)
        expr.arguments.forEach(visitExpr)
        record('new')
        break
      case 'ConditionalExpression':
        visitExpr(expr.test)
        visitExpr(expr.consequent)
        visitExpr(expr.alternate)
        break
      case 'ArrayExpression':
        expr.elements.forEach(visitExpr)
        break
      case 'ObjectExpression':
        for (const prop of expr.properties) {
          if (prop.kind === 'Property') {
            if (prop.computed) {
              visitExpr(prop.key)
            }
            visitExpr(prop.value)
          } else {
            visitExpr(prop.argument)
          }
        }
        break
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visitExpr(expr.object)
        if (expr.computed) {
          visitExpr(expr.property)
        }
        break
      case 'AssignmentExpression':
        visitExpr(expr.left)
        visitExpr(expr.right)
        record(`assign:${expr.operator}`)
        break
      case 'UpdateExpression':
        visitExpr(expr.argument)
        record(`update:${expr.operator}`)
        break
      case 'AwaitExpression':
        visitExpr(expr.argument)
        record('await')
        break
      case 'YieldExpression':
        if (expr.argument) {
          visitExpr(expr.argument)
        }
        record(expr.delegate ? 'yield*' : 'yield')
        break
      case 'TaggedTemplateExpression':
        visitExpr(expr.tag)
        visitExpr(expr.quasi)
        record('tagged_template')
        break
      case 'ImportExpression':
        visitExpr(expr.source)
        record('import')
        break
      case 'TemplateLiteral':
        expr.expressions.forEach(visitExpr)
        break
      case 'SpreadElement':
        visitExpr(expr.argument)
        break
      case 'SequenceExpression':
        expr.expressions.forEach(visitExpr)
        break
      case 'LogicalExpression':
        visitExpr(expr.left)
        visitExpr(expr.right)
        break
      case 'ArrowFunction':
      case 'FunctionExpression':
      case 'ClassExpression':
      case 'JSXElement':
      case 'Identifier':
      case 'Literal':
      case 'MetaProperty':
      case 'ThisExpression':
      case 'SuperExpression':
        break
    }
  }

  function visitTerminator(term: Terminator): void {
    switch (term.kind) {
      case 'Return':
        if (term.argument) {
          visitExpr(term.argument)
        }
        break
      case 'Throw':
        visitExpr(term.argument)
        record('throw')
        break
      case 'Branch':
        visitExpr(term.test)
        break
      case 'Switch':
        visitExpr(term.discriminant)
        term.cases.forEach(c => {
          if (c.test) {
            visitExpr(c.test)
          }
        })
        break
      case 'ForOf':
        visitExpr(term.iterable)
        break
      case 'ForIn':
        visitExpr(term.object)
        break
      case 'Jump':
      case 'Unreachable':
      case 'Break':
      case 'Continue':
      case 'Try':
        break
    }
  }

  for (const fn of program.functions) {
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign') {
          visitExpr(instr.value)
        } else if (instr.kind === 'Expression') {
          visitExpr(instr.value)
        }
      }
      visitTerminator(block.terminator)
    }
  }

  return events
}

function isSubsequence<T>(source: T[], candidate: T[], equals: (a: T, b: T) => boolean): boolean {
  let cursor = 0
  for (const item of candidate) {
    while (cursor < source.length && !equals(source[cursor]!, item)) {
      cursor++
    }
    if (cursor === source.length) {
      return false
    }
    cursor++
  }
  return true
}

function countByKind(events: SideEffectEvent[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1)
  }
  return counts
}

function summarizeEvents(events: SideEffectEvent[]): string {
  const MAX = 20
  const kinds = events.slice(0, MAX).map(event => event.kind)
  if (events.length > MAX) {
    kinds.push(`...(+${events.length - MAX})`)
  }
  return kinds.join(' -> ')
}

interface InvariantResult {
  valid: boolean
  errors: string[]
}

function collectDanglingReferenceNames(
  program: HIRProgram,
  options: ReferenceCollectionOptions = {},
): string[] {
  const defined = collectDefinedVariables(program)
  const { used, maybeExternal } = collectReferenceSummary(program, options)

  const dangling = [...used].filter(
    name =>
      !defined.has(name) &&
      !defined.has(getSSABaseName(name)) &&
      !maybeExternal.has(name) &&
      !KNOWN_GLOBAL_IDENTIFIERS.has(name) &&
      !name.startsWith('__fict'),
  )
  dangling.sort()
  return dangling
}

/**
 * Verify that no variable is used without being defined.
 * Allows unresolved identifiers only for likely external references.
 */
function verifyNoDanglingReferences(program: HIRProgram): InvariantResult {
  const dangling = collectDanglingReferenceNames(program)
  return {
    valid: dangling.length === 0,
    errors: dangling.map(name => `Dangling reference: "${name}" is used but never defined`),
  }
}

function verifyNoDanglingReferencesOnReachable(program: HIRProgram): InvariantResult {
  const dangling = collectDanglingReferenceNames(program, { reachableOnly: true })
  return {
    valid: dangling.length === 0,
    errors: dangling.map(name => `Dangling reference: "${name}" is used but never defined`),
  }
}

/**
 * Verify basic SSA consistency: each Phi node has valid sources.
 */
function verifyPhiNodeCorrectness(program: HIRProgram): InvariantResult {
  const errors: string[] = []

  for (const fn of program.functions) {
    const blockIds = new Set(fn.blocks.map(b => b.id))

    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Phi') {
          for (const src of instr.sources) {
            if (!blockIds.has(src.block)) {
              errors.push(
                `Phi node in block ${block.id} references non-existent block ${src.block}`,
              )
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Verify that optimization doesn't introduce new side effects.
 * We compare both aggregate counts and event ordering to catch duplicate/reordered effects.
 */
function verifyNoDuplicateSideEffects(
  original: HIRProgram,
  optimized: HIRProgram,
): InvariantResult {
  const errors: string[] = []
  const originalEvents = collectSideEffectEvents(original)
  const optimizedEvents = collectSideEffectEvents(optimized)

  if (optimizedEvents.length > originalEvents.length) {
    errors.push(
      `Optimization increased side-effect event count from ${originalEvents.length} to ${optimizedEvents.length}`,
    )
  }

  const originalCounts = countByKind(originalEvents)
  const optimizedCounts = countByKind(optimizedEvents)
  for (const [kind, optimizedCount] of optimizedCounts) {
    const originalCount = originalCounts.get(kind) ?? 0
    if (optimizedCount > originalCount) {
      errors.push(
        `Optimization increased "${kind}" events from ${originalCount} to ${optimizedCount}`,
      )
    }
  }

  if (!isSubsequence(originalEvents, optimizedEvents, (left, right) => left.kind === right.kind)) {
    errors.push(
      `Optimization changed side-effect ordering.\n` +
        `Original: ${summarizeEvents(originalEvents)}\n` +
        `Optimized: ${summarizeEvents(optimizedEvents)}`,
    )
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Verify that all block IDs are unique within a function.
 */
function verifyUniqueBlockIds(program: HIRProgram): InvariantResult {
  const errors: string[] = []

  for (const fn of program.functions) {
    const ids = new Set<BlockId>()
    for (const block of fn.blocks) {
      if (ids.has(block.id)) {
        errors.push(`Duplicate block ID ${block.id} in function ${fn.name}`)
      }
      ids.add(block.id)
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Verify that each block has exactly one terminator.
 */
function verifyTerminators(program: HIRProgram): InvariantResult {
  const errors: string[] = []

  for (const fn of program.functions) {
    for (const block of fn.blocks) {
      if (!block.terminator) {
        errors.push(`Block ${block.id} in function ${fn.name} has no terminator`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

const DEFAULT_RANDOM_FUZZ_SEED = 20260207

function resolveRandomFuzzSeed(): number {
  const raw = process.env.FICT_HIR_FUZZ_SEED
  if (!raw) return DEFAULT_RANDOM_FUZZ_SEED
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_RANDOM_FUZZ_SEED
}

function assertInvariant(seed: number, name: string, result: InvariantResult): void {
  if (!result.valid) {
    const details = result.errors.length > 0 ? `\n${result.errors.join('\n')}` : ''
    throw new Error(`seed ${seed}: ${name} failed${details}`)
  }
}

function generateReachableClosedProgram(seed: number): HIRProgram {
  const MAX_ATTEMPTS = 25
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidateSeed = seed + i * 7919
    const candidate = generateHIRProgram(candidateSeed)
    if (verifyNoDanglingReferencesOnReachable(candidate).valid) {
      return candidate
    }
  }
  throw new Error(
    `seed ${seed}: could not generate a reachable-closed HIR program in ${MAX_ATTEMPTS} attempts`,
  )
}

// ============================================================================
// Test Cases
// ============================================================================

describe('HIR Optimizer Fuzz Tests', () => {
  describe('fixed seed invariant tests', () => {
    const FIXED_SEEDS = [42, 123, 456, 789, 1000, 2023, 3141, 5926, 7777, 9999]

    for (const seed of FIXED_SEEDS) {
      it(`seed ${seed}: optimizer maintains invariants`, () => {
        const original = generateReachableClosedProgram(seed)

        // Verify original is valid
        assertInvariant(seed, 'original unique block IDs', verifyUniqueBlockIds(original))
        assertInvariant(seed, 'original terminators', verifyTerminators(original))
        assertInvariant(seed, 'original phi correctness', verifyPhiNodeCorrectness(original))
        assertInvariant(
          seed,
          'original reachable dangling references',
          verifyNoDanglingReferencesOnReachable(original),
        )

        // Run optimizer
        const optimized = optimizeHIR(original)

        // Verify optimized maintains invariants
        assertInvariant(seed, 'optimized unique block IDs', verifyUniqueBlockIds(optimized))
        assertInvariant(seed, 'optimized terminators', verifyTerminators(optimized))
        assertInvariant(seed, 'optimized phi correctness', verifyPhiNodeCorrectness(optimized))
        const optimizedReachableDangling = verifyNoDanglingReferencesOnReachable(optimized)
        if (!optimizedReachableDangling.valid && process.env.FICT_HIR_FUZZ_DEBUG === '1') {
          // Debug dump to inspect optimizer-introduced dangling references.
          console.error(
            `[debug] seed ${seed} dangling: ${optimizedReachableDangling.errors.join(', ')}`,
          )
          console.error('[debug] original:')
          console.error(JSON.stringify(original, null, 2))
          console.error('[debug] optimized:')
          console.error(JSON.stringify(optimized, null, 2))
        }
        assertInvariant(seed, 'optimized reachable dangling references', optimizedReachableDangling)

        // Verify no new side effects introduced
        assertInvariant(
          seed,
          'optimized side-effect preservation',
          verifyNoDuplicateSideEffects(original, optimized),
        )
      })
    }
  })

  describe('random program crash tests', () => {
    it('optimizer does not crash on 100 random programs', () => {
      const baseSeed = resolveRandomFuzzSeed()

      for (let i = 0; i < 100; i++) {
        const seed = baseSeed + i
        const program = generateHIRProgram(seed)

        try {
          optimizeHIR(program)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`optimizer crashed for seed ${seed}: ${message}`)
        }
      }
    })
  })

  describe('optimization idempotency', () => {
    it('running optimizer twice produces same result', () => {
      const IDEMPOTENCY_SEEDS = [111, 222, 333, 444, 555]

      for (const seed of IDEMPOTENCY_SEEDS) {
        const original = generateHIRProgram(seed)
        const once = optimizeHIR(original)
        const twice = optimizeHIR(once)

        // Structure should be the same after second optimization
        expect(twice.functions.length).toBe(once.functions.length)

        for (let i = 0; i < once.functions.length; i++) {
          const fnOnce = once.functions[i]!
          const fnTwice = twice.functions[i]!

          expect(fnTwice.blocks.length).toBe(fnOnce.blocks.length)
        }
      }
    })
  })

  describe('edge cases', () => {
    it('handles empty function', () => {
      const program: HIRProgram = {
        functions: [
          {
            name: 'empty',
            params: [],
            blocks: [
              {
                id: 0,
                instructions: [],
                terminator: { kind: 'Return' },
              },
            ],
          },
        ],
        preamble: [],
        postamble: [],
      }

      expect(() => optimizeHIR(program)).not.toThrow()
    })

    it('handles function with only literals', () => {
      const program: HIRProgram = {
        functions: [
          {
            name: 'literals',
            params: [],
            blocks: [
              {
                id: 0,
                instructions: [
                  {
                    kind: 'Assign',
                    target: { kind: 'Identifier', name: 'x' },
                    value: { kind: 'Literal', value: 42 },
                  },
                  {
                    kind: 'Assign',
                    target: { kind: 'Identifier', name: 'y' },
                    value: { kind: 'Literal', value: 'hello' },
                  },
                ],
                terminator: {
                  kind: 'Return',
                  argument: { kind: 'Identifier', name: 'x' },
                },
              },
            ],
          },
        ],
        preamble: [],
        postamble: [],
      }

      const optimized = optimizeHIR(program)
      expect(optimized.functions.length).toBe(1)
    })

    it('handles deeply nested expressions', () => {
      // Create a deeply nested binary expression
      function makeNestedBinary(depth: number): Expression {
        if (depth === 0) {
          return { kind: 'Literal', value: 1 }
        }
        return {
          kind: 'BinaryExpression',
          operator: '+',
          left: makeNestedBinary(depth - 1),
          right: { kind: 'Literal', value: 1 },
        }
      }

      const program: HIRProgram = {
        functions: [
          {
            name: 'nested',
            params: [],
            blocks: [
              {
                id: 0,
                instructions: [
                  {
                    kind: 'Assign',
                    target: { kind: 'Identifier', name: 'result' },
                    value: makeNestedBinary(10),
                  },
                ],
                terminator: {
                  kind: 'Return',
                  argument: { kind: 'Identifier', name: 'result' },
                },
              },
            ],
          },
        ],
        preamble: [],
        postamble: [],
      }

      expect(() => optimizeHIR(program)).not.toThrow()
    })

    it('handles multiple blocks with branches', () => {
      const program: HIRProgram = {
        functions: [
          {
            name: 'branching',
            params: [{ kind: 'Identifier', name: 'cond' }],
            blocks: [
              {
                id: 0,
                instructions: [],
                terminator: {
                  kind: 'Branch',
                  test: { kind: 'Identifier', name: 'cond' },
                  consequent: 1,
                  alternate: 2,
                },
              },
              {
                id: 1,
                instructions: [
                  {
                    kind: 'Assign',
                    target: { kind: 'Identifier', name: 'x' },
                    value: { kind: 'Literal', value: 1 },
                  },
                ],
                terminator: { kind: 'Jump', target: 3 },
              },
              {
                id: 2,
                instructions: [
                  {
                    kind: 'Assign',
                    target: { kind: 'Identifier', name: 'x' },
                    value: { kind: 'Literal', value: 2 },
                  },
                ],
                terminator: { kind: 'Jump', target: 3 },
              },
              {
                id: 3,
                instructions: [],
                terminator: {
                  kind: 'Return',
                  argument: { kind: 'Identifier', name: 'x' },
                },
              },
            ],
          },
        ],
        preamble: [],
        postamble: [],
      }

      const optimized = optimizeHIR(program)
      expect(optimized.functions.length).toBe(1)
    })

    it('detects dangling references when present', () => {
      const program: HIRProgram = {
        functions: [
          {
            name: 'dangling',
            params: [],
            blocks: [
              {
                id: 0,
                instructions: [],
                terminator: {
                  kind: 'Return',
                  argument: { kind: 'Identifier', name: 'missing' },
                },
              },
            ],
          },
        ],
        preamble: [],
        postamble: [],
      }

      const result = verifyNoDanglingReferences(program)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('missing')
    })

    it('keeps closed programs free of dangling references after optimization', () => {
      const program: HIRProgram = {
        functions: [
          {
            name: 'closed',
            params: [],
            blocks: [
              {
                id: 0,
                instructions: [
                  {
                    kind: 'Assign',
                    target: { kind: 'Identifier', name: 'a' },
                    value: { kind: 'Literal', value: 1 },
                  },
                  {
                    kind: 'Assign',
                    target: { kind: 'Identifier', name: 'b' },
                    value: {
                      kind: 'BinaryExpression',
                      operator: '+',
                      left: { kind: 'Identifier', name: 'a' },
                      right: { kind: 'Literal', value: 2 },
                    },
                  },
                ],
                terminator: {
                  kind: 'Return',
                  argument: { kind: 'Identifier', name: 'b' },
                },
              },
            ],
          },
        ],
        preamble: [],
        postamble: [],
      }

      expect(verifyNoDanglingReferences(program).valid).toBe(true)
      const optimized = optimizeHIR(program)
      expect(verifyNoDanglingReferences(optimized).valid).toBe(true)
    })

    it('ignores dangling references inside unreachable blocks when configured', () => {
      const program: HIRProgram = {
        functions: [
          {
            name: 'unreachable-dangling',
            params: [],
            blocks: [
              {
                id: 0,
                instructions: [],
                terminator: { kind: 'Return', argument: { kind: 'Literal', value: 1 } },
              },
              {
                id: 1,
                instructions: [],
                terminator: {
                  kind: 'Return',
                  argument: { kind: 'Identifier', name: 'missing_unreachable' },
                },
              },
            ],
          },
        ],
        preamble: [],
        postamble: [],
      }

      expect(verifyNoDanglingReferences(program).valid).toBe(false)
      expect(verifyNoDanglingReferencesOnReachable(program).valid).toBe(true)
    })
  })
})
