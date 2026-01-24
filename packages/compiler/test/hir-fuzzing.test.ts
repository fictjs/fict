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
  if (forDefinition || ctx.definedVars.length === 0 || ctx.rng.bool(0.3)) {
    const name = `v${ctx.varCounter++}`
    if (forDefinition) {
      ctx.definedVars.push(name)
    }
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
  if (ctx.rng.bool(0.7)) {
    const target = generateIdentifier(ctx, true)
    return {
      kind: 'Assign',
      target,
      value: generateExpression(ctx),
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

  const paramCount = ctx.rng.nextInt(0, 3)
  const params: Identifier[] = []
  for (let i = 0; i < paramCount; i++) {
    params.push(generateIdentifier(ctx, true))
  }

  return {
    name: `fn_${ctx.rng.nextInt(0, 99)}`,
    params,
    blocks,
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

function collectDefinedVariables(program: HIRProgram): Set<string> {
  const defined = new Set<string>()

  for (const fn of program.functions) {
    for (const param of fn.params) {
      defined.add(param.name)
    }
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign') {
          defined.add(instr.target.name)
        } else if (instr.kind === 'Phi') {
          defined.add(instr.target.name)
        }
      }
    }
  }

  return defined
}

function collectUsedVariables(program: HIRProgram): Set<string> {
  const used = new Set<string>()

  function visitExpr(expr: Expression): void {
    switch (expr.kind) {
      case 'Identifier':
        used.add(expr.name)
        break
      case 'BinaryExpression':
        visitExpr(expr.left)
        visitExpr(expr.right)
        break
      case 'UnaryExpression':
        visitExpr(expr.argument)
        break
      case 'CallExpression':
        visitExpr(expr.callee)
        expr.arguments.forEach(visitExpr)
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
            visitExpr(prop.value)
          } else if (prop.kind === 'SpreadElement') {
            visitExpr(prop.argument)
          }
        }
        break
      case 'MemberExpression':
        visitExpr(expr.object)
        visitExpr(expr.property)
        break
      case 'LogicalExpression':
        visitExpr(expr.left)
        visitExpr(expr.right)
        break
      // Add other expression types as needed
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
      case 'ForIn':
        visitExpr('iterable' in term ? term.iterable : term.object)
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
        } else if (instr.kind === 'Phi') {
          for (const src of instr.sources) {
            used.add(src.id.name)
          }
        }
      }
      visitTerminator(block.terminator)
    }
  }

  return used
}

interface InvariantResult {
  valid: boolean
  errors: string[]
}

/**
 * Verify that no variable is used without being defined.
 * Note: We skip checking identifiers that look like external references (function calls, globals).
 */
function verifyNoDanglingReferences(program: HIRProgram): InvariantResult {
  const errors: string[] = []
  // We don't verify dangling references in generated programs because
  // identifiers might refer to external functions/globals
  // In a real compiler, this would be verified differently
  return { valid: true, errors }
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
 * This is a simplified check - just ensures we don't add more call expressions.
 */
function verifyNoDuplicateSideEffects(
  original: HIRProgram,
  optimized: HIRProgram,
): InvariantResult {
  const errors: string[] = []

  function countCalls(program: HIRProgram): number {
    let count = 0

    function visitExpr(expr: Expression): void {
      if (expr.kind === 'CallExpression' || expr.kind === 'OptionalCallExpression') {
        // Only count impure calls
        if (!('pure' in expr) || !expr.pure) {
          count++
        }
      }
      // Visit children
      switch (expr.kind) {
        case 'BinaryExpression':
          visitExpr(expr.left)
          visitExpr(expr.right)
          break
        case 'UnaryExpression':
          visitExpr(expr.argument)
          break
        case 'CallExpression':
        case 'OptionalCallExpression':
          visitExpr(expr.callee)
          expr.arguments.forEach(visitExpr)
          break
        case 'ConditionalExpression':
          visitExpr(expr.test)
          visitExpr(expr.consequent)
          visitExpr(expr.alternate)
          break
        case 'ArrayExpression':
          expr.elements.forEach(visitExpr)
          break
        case 'MemberExpression':
          visitExpr(expr.object)
          visitExpr(expr.property)
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
      }
    }

    return count
  }

  const originalCalls = countCalls(original)
  const optimizedCalls = countCalls(optimized)

  if (optimizedCalls > originalCalls) {
    errors.push(
      `Optimization increased impure call count from ${originalCalls} to ${optimizedCalls}`,
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

// ============================================================================
// Test Cases
// ============================================================================

describe('HIR Optimizer Fuzz Tests', () => {
  describe('fixed seed invariant tests', () => {
    const FIXED_SEEDS = [42, 123, 456, 789, 1000, 2023, 3141, 5926, 7777, 9999]

    for (const seed of FIXED_SEEDS) {
      it(`seed ${seed}: optimizer maintains invariants`, () => {
        const original = generateHIRProgram(seed)

        // Verify original is valid
        expect(verifyUniqueBlockIds(original).valid).toBe(true)
        expect(verifyTerminators(original).valid).toBe(true)
        expect(verifyPhiNodeCorrectness(original).valid).toBe(true)

        // Run optimizer
        const optimized = optimizeHIR(original)

        // Verify optimized maintains invariants
        const blockIdResult = verifyUniqueBlockIds(optimized)
        expect(blockIdResult.valid).toBe(true)

        const terminatorResult = verifyTerminators(optimized)
        expect(terminatorResult.valid).toBe(true)

        const phiResult = verifyPhiNodeCorrectness(optimized)
        expect(phiResult.valid).toBe(true)

        // Verify no new side effects introduced
        const sideEffectResult = verifyNoDuplicateSideEffects(original, optimized)
        expect(sideEffectResult.valid).toBe(true)
      })
    }
  })

  describe('random program crash tests', () => {
    it('optimizer does not crash on 100 random programs', () => {
      const baseSeed = Date.now()

      for (let i = 0; i < 100; i++) {
        const seed = baseSeed + i
        const program = generateHIRProgram(seed)

        // Should not throw
        expect(() => {
          optimizeHIR(program)
        }).not.toThrow()
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
  })
})
