/**
 * CFG Structurization: Convert CFG blocks back to structured control flow
 *
 * This module converts a CFG (Control Flow Graph) representation back into
 * structured control flow statements (if/while/for/switch/try) that can be
 * directly emitted as JavaScript.
 *
 * The approach is based on dominator tree analysis and pattern recognition:
 * 1. Compute dominance relationships between blocks
 * 2. Identify natural loops (back-edges to loop headers)
 * 3. Identify if-else structures (branches that merge at join points)
 * 4. Emit structured code in a single pass
 */

import type { BasicBlock, BlockId, Expression, Instruction, HIRFunction } from './hir'
import { analyzeCFG } from './ssa'

/**
 * Error thrown when CFG cannot be structurized (e.g., irreducible control flow)
 */
export class StructurizationError extends Error {
  constructor(
    message: string,
    public readonly blockId?: BlockId,
    public readonly reason?: 'depth_exceeded' | 'irreducible' | 'unreachable_blocks',
  ) {
    super(message)
    this.name = 'StructurizationError'
  }
}

/**
 * Structured representation of a control flow node
 */
export type StructuredNode =
  | { kind: 'block'; blockId: BlockId; statements: StructuredNode[] }
  | { kind: 'sequence'; nodes: StructuredNode[] }
  | {
      kind: 'if'
      test: Expression
      consequent: StructuredNode
      alternate: StructuredNode | null
      joinBlock?: BlockId
    }
  | {
      kind: 'while'
      test: Expression
      body: StructuredNode
      headerBlock: BlockId
    }
  | {
      kind: 'doWhile'
      test: Expression
      body: StructuredNode
      headerBlock: BlockId
    }
  | {
      kind: 'for'
      init: Instruction[] | null
      test: Expression | null
      update: Instruction[] | null
      body: StructuredNode
      headerBlock: BlockId
    }
  | {
      kind: 'forOf'
      variable: string
      variableKind: 'const' | 'let' | 'var'
      pattern?: any
      iterable: Expression
      body: StructuredNode
    }
  | {
      kind: 'forIn'
      variable: string
      variableKind: 'const' | 'let' | 'var'
      pattern?: any
      object: Expression
      body: StructuredNode
    }
  | {
      kind: 'switch'
      discriminant: Expression
      cases: { test: Expression | null; body: StructuredNode }[]
    }
  | {
      kind: 'try'
      block: StructuredNode
      handler: { param: string | null; body: StructuredNode } | null
      finalizer: StructuredNode | null
    }
  | { kind: 'return'; argument: Expression | null }
  | { kind: 'throw'; argument: Expression }
  | { kind: 'break'; label?: string }
  | { kind: 'continue'; label?: string }
  | { kind: 'instruction'; instruction: Instruction }

/**
 * Context for CFG structurization
 */
interface StructurizeContext {
  fn: HIRFunction
  blockMap: Map<BlockId, BasicBlock>
  predecessors: Map<BlockId, BlockId[]>
  successors: Map<BlockId, BlockId[]>
  idom: Map<BlockId, BlockId>
  loopHeaders: Set<BlockId>
  backEdges: Set<string>
  visited: Set<BlockId>
  emitted: Set<BlockId>
  processing: Set<BlockId>
  /** Current recursion depth for safety */
  depth: number
  /** Maximum allowed depth to prevent infinite recursion */
  maxDepth: number
  /** Blocks that couldn't be properly structured */
  problematicBlocks: Set<BlockId>
  /** Whether to emit warnings for non-structurable patterns */
  warnOnIssues: boolean
  /** Blocks with multiple predecessors (potential join points or shared blocks) */
  joinPoints: Set<BlockId>
  /** Track which emitted blocks had side effects (instructions) */
  blocksWithSideEffects: Set<BlockId>
}

/**
 * Build structured code from HIR function.
 * Includes safety guards to detect and handle non-structurable CFGs.
 *
 * @param fn - The HIR function to structurize
 * @param options - Optional configuration
 * @param options.warnOnIssues - Whether to emit console warnings for structurization issues (default: true in dev)
 * @param options.throwOnIssues - Whether to throw StructurizationError for critical issues (default: false)
 */
export function structurizeCFG(
  fn: HIRFunction,
  options?: { warnOnIssues?: boolean; throwOnIssues?: boolean },
): StructuredNode {
  if (fn.blocks.length === 0) {
    return { kind: 'sequence', nodes: [] }
  }

  const cfg = analyzeCFG(fn.blocks)
  const blockMap = new Map<BlockId, BasicBlock>()
  for (const block of fn.blocks) {
    blockMap.set(block.id, block)
  }

  // Identify join points (blocks with multiple predecessors)
  const joinPoints = new Set<BlockId>()
  for (const [blockId, preds] of cfg.predecessors) {
    if (preds.length > 1) {
      joinPoints.add(blockId)
    }
  }

  // Identify blocks with side effects (non-empty instructions or terminator with effects)
  const blocksWithSideEffects = new Set<BlockId>()
  for (const block of fn.blocks) {
    if (block.instructions.length > 0) {
      blocksWithSideEffects.add(block.id)
    }
    // Terminators like Throw, some Calls also have side effects
    if (block.terminator.kind === 'Throw') {
      blocksWithSideEffects.add(block.id)
    }
  }

  const throwOnIssues = options?.throwOnIssues ?? true

  const ctx: StructurizeContext = {
    fn,
    blockMap,
    predecessors: cfg.predecessors,
    successors: cfg.successors,
    idom: cfg.dominatorTree.idom,
    loopHeaders: cfg.loopHeaders,
    backEdges: cfg.backEdges,
    visited: new Set(),
    emitted: new Set(),
    processing: new Set(),
    depth: 0,
    maxDepth: fn.blocks.length * 3, // Conservative limit based on block count
    problematicBlocks: new Set(),
    warnOnIssues: options?.warnOnIssues ?? false,
    joinPoints,
    blocksWithSideEffects,
  }

  const entryBlock = fn.blocks[0]
  if (!entryBlock) {
    return { kind: 'sequence', nodes: [] }
  }

  const result = structurizeBlock(ctx, entryBlock.id)

  // Verify all reachable blocks were emitted
  const reachableBlocks = computeReachableBlocks(fn.blocks, cfg.successors)
  const unemittedBlocks: BlockId[] = []
  for (const blockId of reachableBlocks) {
    if (!ctx.emitted.has(blockId) && !ctx.problematicBlocks.has(blockId)) {
      unemittedBlocks.push(blockId)
    }
  }

  // Handle issues based on options
  if (throwOnIssues) {
    if (ctx.problematicBlocks.size > 0) {
      const firstBlock = Array.from(ctx.problematicBlocks)[0]
      throw new StructurizationError(
        `Cannot structurize CFG: ${ctx.problematicBlocks.size} blocks have irreducible control flow`,
        firstBlock,
        'irreducible',
      )
    }
    if (unemittedBlocks.length > 0) {
      throw new StructurizationError(
        `Cannot structurize CFG: ${unemittedBlocks.length} reachable blocks were not emitted`,
        unemittedBlocks[0],
        'unreachable_blocks',
      )
    }
  } else if (ctx.warnOnIssues) {
    for (const blockId of unemittedBlocks) {
      console.warn(
        `[structurizeCFG] Block ${blockId} was not emitted - possible unreachable or non-structurable code`,
      )
    }
    if (ctx.problematicBlocks.size > 0) {
      console.warn(
        `[structurizeCFG] ${ctx.problematicBlocks.size} blocks had structurization issues`,
      )
    }
  }

  return result
}

/**
 * Compute set of blocks reachable from entry
 */
function computeReachableBlocks(
  blocks: BasicBlock[],
  successors: Map<BlockId, BlockId[]>,
): Set<BlockId> {
  const reachable = new Set<BlockId>()
  const entryBlock = blocks[0]
  if (!entryBlock) return reachable

  const worklist = [entryBlock.id]
  while (worklist.length > 0) {
    const blockId = worklist.pop()!
    if (reachable.has(blockId)) continue
    reachable.add(blockId)
    const succs = successors.get(blockId) ?? []
    for (const succ of succs) {
      if (!reachable.has(succ)) {
        worklist.push(succ)
      }
    }
  }
  return reachable
}

/**
 * Structurize a block and its control flow successors.
 * Includes depth limit to prevent infinite recursion in pathological CFGs.
 */
function structurizeBlock(ctx: StructurizeContext, blockId: BlockId): StructuredNode {
  // Safety: check depth limit
  if (ctx.depth > ctx.maxDepth) {
    ctx.problematicBlocks.add(blockId)
    if (ctx.warnOnIssues) {
      console.warn(
        `[structurizeCFG] Maximum depth exceeded at block ${blockId} - possible irreducible control flow`,
      )
    }
    return { kind: 'sequence', nodes: [] }
  }

  if (ctx.processing.has(blockId)) {
    ctx.problematicBlocks.add(blockId)
    if (ctx.warnOnIssues) {
      console.warn(
        `[structurizeCFG] Detected cycle involving block ${blockId} - possible irreducible control flow`,
      )
    }
    return { kind: 'sequence', nodes: [] }
  }

  if (ctx.emitted.has(blockId)) {
    // Already emitted - check if this is a problematic shared block
    // A shared block with side effects being skipped could cause issues
    if (ctx.blocksWithSideEffects.has(blockId) && ctx.joinPoints.has(blockId)) {
      if (ctx.warnOnIssues) {
        console.warn(
          `[structurizeCFG] Shared block ${blockId} with side effects was skipped - CFG may be irreducible`,
        )
      }
    }
    return { kind: 'sequence', nodes: [] }
  }

  const block = ctx.blockMap.get(blockId)
  if (!block) {
    ctx.problematicBlocks.add(blockId)
    return { kind: 'sequence', nodes: [] }
  }

  ctx.processing.add(blockId)
  ctx.emitted.add(blockId)
  ctx.depth++

  const nodes: StructuredNode[] = []

  // Emit instructions
  for (const instr of block.instructions) {
    nodes.push({ kind: 'instruction', instruction: instr })
  }

  // Handle terminator
  const termNode = structurizeTerminator(ctx, block)
  if (termNode) {
    if (termNode.kind === 'sequence') {
      nodes.push(...termNode.nodes)
    } else {
      nodes.push(termNode)
    }
  }

  ctx.depth--
  ctx.processing.delete(blockId)

  if (nodes.length === 1 && nodes[0]) {
    return nodes[0]
  }
  return { kind: 'sequence', nodes }
}

/**
 * Structurize a terminator into a control flow node
 */
function structurizeTerminator(ctx: StructurizeContext, block: BasicBlock): StructuredNode | null {
  const term = block.terminator

  switch (term.kind) {
    case 'Return':
      return { kind: 'return', argument: term.argument ?? null }

    case 'Throw':
      return { kind: 'throw', argument: term.argument }

    case 'Jump': {
      // Check if this is a back-edge (loop continuation)
      const edgeKey = `${block.id}->${term.target}`
      if (ctx.backEdges.has(edgeKey)) {
        // This is a loop back-edge, don't follow it
        return null
      }
      // Follow the jump
      return structurizeBlock(ctx, term.target)
    }

    case 'Branch': {
      return structurizeBranch(ctx, block, term)
    }

    case 'Switch': {
      return structurizeSwitch(ctx, block, term)
    }

    case 'ForOf': {
      return structurizeForOf(ctx, block, term)
    }

    case 'ForIn': {
      return structurizeForIn(ctx, block, term)
    }

    case 'Try': {
      return structurizeTry(ctx, block, term)
    }

    case 'Break':
      return { kind: 'break', label: term.label }

    case 'Continue':
      return { kind: 'continue', label: term.label }

    case 'Unreachable':
      return null

    default:
      return null
  }
}

/**
 * Structurize a branch terminator
 */
function structurizeBranch(
  ctx: StructurizeContext,
  block: BasicBlock,
  term: { kind: 'Branch'; test: Expression; consequent: BlockId; alternate: BlockId },
): StructuredNode {
  const { consequent, alternate, test } = term

  // Check if this is a loop header
  const isLoopHeader = ctx.loopHeaders.has(block.id)
  if (isLoopHeader) {
    return structurizeWhileLoop(ctx, block, test, consequent, alternate)
  }

  // Check if consequent or alternate leads back (indicating a while loop started earlier)
  const consBackEdge = `${consequent}->${block.id}`
  const altBackEdge = `${alternate}->${block.id}`
  if (ctx.backEdges.has(consBackEdge) || ctx.backEdges.has(altBackEdge)) {
    // This block is the condition of a while loop
    return structurizeWhileLoop(ctx, block, test, consequent, alternate)
  }

  // Regular if-else structure
  return structurizeIfElse(ctx, test, consequent, alternate)
}

/**
 * Structurize a while loop
 */
function structurizeWhileLoop(
  ctx: StructurizeContext,
  condBlock: BasicBlock,
  test: Expression,
  bodyBlockId: BlockId,
  exitBlockId: BlockId,
): StructuredNode {
  // Determine which block is the body and which is the exit
  // The body block usually has a back-edge to the condition
  const bodyEdge = `${bodyBlockId}->${condBlock.id}`
  const exitEdge = `${exitBlockId}->${condBlock.id}`

  let body: StructuredNode
  let exit: StructuredNode | null = null

  if (ctx.backEdges.has(bodyEdge) || !ctx.emitted.has(bodyBlockId)) {
    // bodyBlockId is the loop body
    body = structurizeBlock(ctx, bodyBlockId)
    if (!ctx.emitted.has(exitBlockId)) {
      exit = structurizeBlock(ctx, exitBlockId)
    }
  } else if (ctx.backEdges.has(exitEdge)) {
    // exitBlockId is actually the body (test was inverted)
    body = structurizeBlock(ctx, exitBlockId)
    if (!ctx.emitted.has(bodyBlockId)) {
      exit = structurizeBlock(ctx, bodyBlockId)
    }
  } else {
    // Fallback: treat consequent as body
    body = structurizeBlock(ctx, bodyBlockId)
    if (!ctx.emitted.has(exitBlockId)) {
      exit = structurizeBlock(ctx, exitBlockId)
    }
  }

  const whileNode: StructuredNode = {
    kind: 'while',
    test,
    body,
    headerBlock: condBlock.id,
  }

  if (exit) {
    return { kind: 'sequence', nodes: [whileNode, exit] }
  }
  return whileNode
}

/**
 * Structurize an if-else statement
 */
function structurizeIfElse(
  ctx: StructurizeContext,
  test: Expression,
  consequentId: BlockId,
  alternateId: BlockId,
): StructuredNode {
  // Find the join point (if any)
  const joinBlock = findJoinBlock(ctx, consequentId, alternateId)

  // Structurize consequent
  const consequent = structurizeBlockUntilJoin(ctx, consequentId, joinBlock)

  // Structurize alternate (only if different from join)
  let alternate: StructuredNode | null = null
  if (alternateId !== joinBlock && !ctx.emitted.has(alternateId)) {
    alternate = structurizeBlockUntilJoin(ctx, alternateId, joinBlock)
  }

  const ifNode: StructuredNode = {
    kind: 'if',
    test,
    consequent,
    alternate,
    joinBlock: joinBlock ?? undefined,
  }

  // Continue with join block if not yet emitted
  if (joinBlock !== undefined && !ctx.emitted.has(joinBlock)) {
    const joinNode = structurizeBlock(ctx, joinBlock)
    return { kind: 'sequence', nodes: [ifNode, joinNode] }
  }

  return ifNode
}

/**
 * Find the join block where two branches merge
 */
function findJoinBlock(
  ctx: StructurizeContext,
  block1: BlockId,
  block2: BlockId,
): BlockId | undefined {
  // Collect all blocks reachable from block1
  const reachable1 = collectReachableBlocks(ctx, block1, new Set())
  // Find first block reachable from block2 that's also in reachable1
  const visited = new Set<BlockId>()
  const queue = [block2]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    if (reachable1.has(current) && current !== block1 && current !== block2) {
      return current
    }

    const succs = ctx.successors.get(current) ?? []
    for (const succ of succs) {
      if (!visited.has(succ)) {
        queue.push(succ)
      }
    }
  }

  return undefined
}

/**
 * Collect all blocks reachable from a starting block
 */
function collectReachableBlocks(
  ctx: StructurizeContext,
  start: BlockId,
  visited: Set<BlockId>,
): Set<BlockId> {
  if (visited.has(start)) return visited
  visited.add(start)

  const succs = ctx.successors.get(start) ?? []
  for (const succ of succs) {
    // Don't follow back-edges
    const edgeKey = `${start}->${succ}`
    if (!ctx.backEdges.has(edgeKey)) {
      collectReachableBlocks(ctx, succ, visited)
    }
  }

  return visited
}

/**
 * Structurize a block up to (but not including) a join point
 */
function structurizeBlockUntilJoin(
  ctx: StructurizeContext,
  blockId: BlockId,
  joinBlock: BlockId | undefined,
): StructuredNode {
  if (joinBlock !== undefined && blockId === joinBlock) {
    return { kind: 'sequence', nodes: [] }
  }

  if (ctx.emitted.has(blockId)) {
    return { kind: 'sequence', nodes: [] }
  }

  const block = ctx.blockMap.get(blockId)
  if (!block) {
    return { kind: 'sequence', nodes: [] }
  }

  ctx.emitted.add(blockId)
  const nodes: StructuredNode[] = []

  // Emit instructions
  for (const instr of block.instructions) {
    nodes.push({ kind: 'instruction', instruction: instr })
  }

  // Handle terminator
  const term = block.terminator

  switch (term.kind) {
    case 'Return':
      nodes.push({ kind: 'return', argument: term.argument ?? null })
      break

    case 'Throw':
      nodes.push({ kind: 'throw', argument: term.argument })
      break

    case 'Jump': {
      const edgeKey = `${blockId}->${term.target}`
      if (!ctx.backEdges.has(edgeKey) && term.target !== joinBlock) {
        const next = structurizeBlockUntilJoin(ctx, term.target, joinBlock)
        if (next.kind === 'sequence') {
          nodes.push(...next.nodes)
        } else {
          nodes.push(next)
        }
      }
      break
    }

    case 'Branch': {
      // Check if this branch leads to the join
      if (term.consequent === joinBlock && term.alternate === joinBlock) {
        // Both branches lead to join - just emit condition as expression if needed
        break
      }
      const branchNode = structurizeBranchUntilJoin(ctx, block, term, joinBlock)
      if (branchNode) nodes.push(branchNode)
      break
    }

    case 'Break':
      nodes.push({ kind: 'break', label: term.label })
      break

    case 'Continue':
      nodes.push({ kind: 'continue', label: term.label })
      break

    default:
      break
  }

  if (nodes.length === 1 && nodes[0]) {
    return nodes[0]
  }
  return { kind: 'sequence', nodes }
}

/**
 * Structurize a branch with a known join point
 */
function structurizeBranchUntilJoin(
  ctx: StructurizeContext,
  block: BasicBlock,
  term: { kind: 'Branch'; test: Expression; consequent: BlockId; alternate: BlockId },
  outerJoin: BlockId | undefined,
): StructuredNode | null {
  const { test, consequent, alternate } = term

  // Find inner join (between consequent and alternate)
  const innerJoin = findJoinBlock(ctx, consequent, alternate)
  const effectiveJoin = innerJoin ?? outerJoin

  const consNode =
    consequent !== effectiveJoin && !ctx.emitted.has(consequent)
      ? structurizeBlockUntilJoin(ctx, consequent, effectiveJoin)
      : { kind: 'sequence' as const, nodes: [] }

  const altNode =
    alternate !== effectiveJoin && !ctx.emitted.has(alternate)
      ? structurizeBlockUntilJoin(ctx, alternate, effectiveJoin)
      : null

  const ifNode: StructuredNode = {
    kind: 'if',
    test,
    consequent: consNode,
    alternate: altNode,
    joinBlock: effectiveJoin,
  }

  // Continue with inner join if different from outer
  if (innerJoin !== undefined && innerJoin !== outerJoin && !ctx.emitted.has(innerJoin)) {
    const joinNode = structurizeBlockUntilJoin(ctx, innerJoin, outerJoin)
    return { kind: 'sequence', nodes: [ifNode, joinNode] }
  }

  return ifNode
}

/**
 * Structurize a switch statement
 */
function structurizeSwitch(
  ctx: StructurizeContext,
  block: BasicBlock,
  term: {
    kind: 'Switch'
    discriminant: Expression
    cases: { test?: Expression; target: BlockId }[]
  },
): StructuredNode {
  const cases: { test: Expression | null; body: StructuredNode }[] = []

  for (const c of term.cases) {
    const body = structurizeBlock(ctx, c.target)
    cases.push({ test: c.test ?? null, body })
  }

  return {
    kind: 'switch',
    discriminant: term.discriminant,
    cases,
  }
}

/**
 * Structurize a for-of statement
 */
function structurizeForOf(
  ctx: StructurizeContext,
  block: BasicBlock,
  term: {
    kind: 'ForOf'
    variable: string
    variableKind: 'const' | 'let' | 'var'
    pattern?: any
    iterable: Expression
    body: BlockId
    exit: BlockId
  },
): StructuredNode {
  const body = structurizeBlock(ctx, term.body)
  const exit = !ctx.emitted.has(term.exit) ? structurizeBlock(ctx, term.exit) : null

  const forOfNode: StructuredNode = {
    kind: 'forOf',
    variable: term.variable,
    variableKind: term.variableKind,
    pattern: term.pattern,
    iterable: term.iterable,
    body,
  }

  if (exit) {
    return { kind: 'sequence', nodes: [forOfNode, exit] }
  }
  return forOfNode
}

/**
 * Structurize a for-in statement
 */
function structurizeForIn(
  ctx: StructurizeContext,
  block: BasicBlock,
  term: {
    kind: 'ForIn'
    variable: string
    variableKind: 'const' | 'let' | 'var'
    pattern?: any
    object: Expression
    body: BlockId
    exit: BlockId
  },
): StructuredNode {
  const body = structurizeBlock(ctx, term.body)
  const exit = !ctx.emitted.has(term.exit) ? structurizeBlock(ctx, term.exit) : null

  const forInNode: StructuredNode = {
    kind: 'forIn',
    variable: term.variable,
    variableKind: term.variableKind,
    pattern: term.pattern,
    object: term.object,
    body,
  }

  if (exit) {
    return { kind: 'sequence', nodes: [forInNode, exit] }
  }
  return forInNode
}

/**
 * Structurize a try-catch-finally statement
 */
function structurizeTry(
  ctx: StructurizeContext,
  block: BasicBlock,
  term: {
    kind: 'Try'
    tryBlock: BlockId
    catchBlock?: BlockId
    catchParam?: string
    finallyBlock?: BlockId
    exit: BlockId
  },
): StructuredNode {
  const tryBody = structurizeBlock(ctx, term.tryBlock)

  let handler: { param: string | null; body: StructuredNode } | null = null
  if (term.catchBlock !== undefined) {
    const catchBody = structurizeBlock(ctx, term.catchBlock)
    handler = {
      param: term.catchParam ?? null,
      body: catchBody,
    }
  }

  let finalizer: StructuredNode | null = null
  if (term.finallyBlock !== undefined) {
    finalizer = structurizeBlock(ctx, term.finallyBlock)
  }

  const exit = !ctx.emitted.has(term.exit) ? structurizeBlock(ctx, term.exit) : null

  const tryNode: StructuredNode = {
    kind: 'try',
    block: tryBody,
    handler,
    finalizer,
  }

  if (exit) {
    return { kind: 'sequence', nodes: [tryNode, exit] }
  }
  return tryNode
}
