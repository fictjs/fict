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

import type { LVal } from '@babel/types'

import type {
  BasicBlock,
  BlockId,
  Expression,
  HIRFunction,
  Instruction,
  LabeledStatementMeta,
} from './hir'
import { analyzeCFG } from './ssa'

/**
 * Error thrown when CFG cannot be structurized (e.g., irreducible control flow)
 */
export class StructurizationError extends Error {
  constructor(
    message: string,
    public readonly blockId?: BlockId,
    public readonly reason?:
      | 'depth_exceeded'
      | 'irreducible'
      | 'unreachable_blocks'
      | 'shared_block',
  ) {
    super(message)
    this.name = 'StructurizationError'
  }
}

/**
 * Diagnostic information about structurization issues
 */
export interface StructurizationDiagnostics {
  /** Blocks that couldn't be properly structured */
  problematicBlocks: BlockId[]
  /** Reachable blocks that were not emitted */
  unemittedBlocks: BlockId[]
  /** Shared blocks with side effects that were skipped */
  sharedSideEffectBlocks: BlockId[]
  /** Whether the result is complete and safe to use */
  isComplete: boolean
}

/**
 * Result of CFG structurization with diagnostics
 */
export interface StructurizationResult {
  /** The structured node (may be incomplete if issues occurred) */
  node: StructuredNode
  /** Diagnostic information about any issues encountered */
  diagnostics: StructurizationDiagnostics
}

/**
 * Structured representation of a control flow node
 */
export type StructuredNode =
  | { kind: 'block'; blockId: BlockId; statements: StructuredNode[] }
  | { kind: 'sequence'; nodes: StructuredNode[] }
  | { kind: 'labeled'; label: string; statement: StructuredNode }
  | {
      kind: 'if'
      test: Expression
      consequent: StructuredNode
      alternate: StructuredNode | null
      joinBlock?: BlockId | undefined
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
      leftKind?: 'declaration' | 'assignment' | undefined
      variableKind: 'const' | 'let' | 'var'
      pattern?: LVal | undefined
      iterable: Expression
      body: StructuredNode
    }
  | {
      kind: 'forIn'
      variable: string
      leftKind?: 'declaration' | 'assignment' | undefined
      variableKind: 'const' | 'let' | 'var'
      pattern?: LVal | undefined
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
  | { kind: 'break'; label?: string | undefined }
  | { kind: 'continue'; label?: string | undefined }
  | { kind: 'instruction'; instruction: Instruction }
  | {
      // Fallback: state machine representation for non-structurable CFGs
      kind: 'stateMachine'
      blocks: {
        blockId: BlockId
        instructions: Instruction[]
        terminator: BasicBlock['terminator']
      }[]
      entryBlock: BlockId
    }

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
  /** Blocks that were seen multiple times with side effects (unsafe to skip) */
  sharedSideEffectBlocks: Set<BlockId>
  /** Blocks reserved for explicit processing (e.g., finally blocks in try-catch) */
  reservedBlocks: Set<BlockId>
}

/**
 * Build structured code from HIR function.
 * Includes safety guards to detect and handle non-structurable CFGs.
 *
 * @param fn - The HIR function to structurize
 * @param options - Optional configuration
 * @param options.warnOnIssues - Whether to emit console warnings for structurization issues (default: true in dev)
 * @param options.throwOnIssues - Whether to throw StructurizationError for critical issues (default: true)
 * @param options.useFallback - Whether to use state machine fallback for non-structurable CFGs (default: true)
 */
export function structurizeCFG(
  fn: HIRFunction,
  options?: { warnOnIssues?: boolean; throwOnIssues?: boolean; useFallback?: boolean },
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
    sharedSideEffectBlocks: new Set(),
    reservedBlocks: new Set(),
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

  // Check if we have any structurization issues
  const hasIssues =
    ctx.sharedSideEffectBlocks.size > 0 ||
    ctx.problematicBlocks.size > 0 ||
    unemittedBlocks.length > 0

  // Use fallback state machine if issues detected and fallback is enabled
  const useFallback = options?.useFallback ?? true
  if (hasIssues && useFallback) {
    if (ctx.warnOnIssues) {
      console.warn(
        `[structurizeCFG] Using state machine fallback due to non-structurable CFG ` +
          `(${ctx.problematicBlocks.size} problematic, ${unemittedBlocks.length} unemitted, ` +
          `${ctx.sharedSideEffectBlocks.size} shared side-effect blocks)`,
      )
    }
    return createStateMachineFallback(fn)
  }

  // Handle issues based on options (when fallback is disabled)
  if (throwOnIssues && hasIssues) {
    if (ctx.sharedSideEffectBlocks.size > 0) {
      const firstBlock = Array.from(ctx.sharedSideEffectBlocks)[0]
      throw new StructurizationError(
        `Cannot structurize CFG: shared block ${firstBlock} with side effects would be skipped`,
        firstBlock,
        'shared_block',
      )
    }
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
  } else if (ctx.warnOnIssues && hasIssues) {
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
    if (ctx.sharedSideEffectBlocks.size > 0) {
      for (const blockId of ctx.sharedSideEffectBlocks) {
        console.warn(
          `[structurizeCFG] Shared block ${blockId} with side effects was encountered multiple times`,
        )
      }
    }
  }

  return result
}

/**
 * Create a state machine fallback for non-structurable CFGs.
 * This generates a switch-based state machine that can handle any control flow.
 */
function createStateMachineFallback(fn: HIRFunction): StructuredNode {
  const blocks = fn.blocks.map(block => ({
    blockId: block.id,
    instructions: block.instructions,
    terminator: block.terminator,
  }))

  return {
    kind: 'stateMachine',
    blocks,
    entryBlock: fn.blocks[0]?.id ?? 0,
  }
}

/**
 * Structurize a CFG and return detailed diagnostics.
 * This version always returns the result along with diagnostic information,
 * allowing callers to decide how to handle incomplete structurization.
 */
export function structurizeCFGWithDiagnostics(fn: HIRFunction): StructurizationResult {
  if (fn.blocks.length === 0) {
    return {
      node: { kind: 'sequence', nodes: [] },
      diagnostics: {
        problematicBlocks: [],
        unemittedBlocks: [],
        sharedSideEffectBlocks: [],
        isComplete: true,
      },
    }
  }

  const cfg = analyzeCFG(fn.blocks)
  const blockMap = new Map<BlockId, BasicBlock>()
  for (const block of fn.blocks) {
    blockMap.set(block.id, block)
  }

  // Identify join points
  const joinPoints = new Set<BlockId>()
  for (const [blockId, preds] of cfg.predecessors) {
    if (preds.length > 1) {
      joinPoints.add(blockId)
    }
  }

  // Identify blocks with side effects
  const blocksWithSideEffects = new Set<BlockId>()
  for (const block of fn.blocks) {
    if (block.instructions.length > 0) {
      blocksWithSideEffects.add(block.id)
    }
    if (block.terminator.kind === 'Throw') {
      blocksWithSideEffects.add(block.id)
    }
  }

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
    maxDepth: fn.blocks.length * 3,
    problematicBlocks: new Set(),
    warnOnIssues: false, // We collect diagnostics instead
    joinPoints,
    blocksWithSideEffects,
    sharedSideEffectBlocks: new Set(),
    reservedBlocks: new Set(),
  }

  const entryBlock = fn.blocks[0]
  if (!entryBlock) {
    return {
      node: { kind: 'sequence', nodes: [] },
      diagnostics: {
        problematicBlocks: [],
        unemittedBlocks: [],
        sharedSideEffectBlocks: [],
        isComplete: true,
      },
    }
  }

  const result = structurizeBlock(ctx, entryBlock.id)

  // Compute diagnostics
  const reachableBlocks = computeReachableBlocks(fn.blocks, cfg.successors)
  const unemittedBlocks: BlockId[] = []
  for (const blockId of reachableBlocks) {
    if (!ctx.emitted.has(blockId) && !ctx.problematicBlocks.has(blockId)) {
      unemittedBlocks.push(blockId)
    }
  }

  const isComplete =
    ctx.problematicBlocks.size === 0 &&
    unemittedBlocks.length === 0 &&
    ctx.sharedSideEffectBlocks.size === 0

  return {
    node: result,
    diagnostics: {
      problematicBlocks: Array.from(ctx.problematicBlocks),
      unemittedBlocks,
      sharedSideEffectBlocks: Array.from(ctx.sharedSideEffectBlocks),
      isComplete,
    },
  }
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

function getLabeledStatementMeta(
  ctx: StructurizeContext,
  blockId: BlockId,
): LabeledStatementMeta | undefined {
  return ctx.fn.meta?.labeledStatements?.get(blockId)
}

function wrapStructuredNodeWithLabel(
  meta: LabeledStatementMeta | undefined,
  node: StructuredNode,
  options?: { allowBoundaryLabel?: boolean },
): StructuredNode {
  if (!meta?.label) return node
  if (!options?.allowBoundaryLabel && meta.exitBlock !== undefined) return node
  return { kind: 'labeled', label: meta.label, statement: node }
}

function combineStructuredNodes(...nodes: (StructuredNode | null | undefined)[]): StructuredNode {
  const flattened: StructuredNode[] = []
  for (const node of nodes) {
    if (!node) continue
    if (node.kind === 'sequence') {
      flattened.push(...node.nodes)
    } else {
      flattened.push(node)
    }
  }

  if (flattened.length === 0) {
    return { kind: 'sequence', nodes: [] }
  }
  if (flattened.length === 1) {
    return flattened[0]!
  }
  return { kind: 'sequence', nodes: flattened }
}

function structurizeLabeledStatement(
  ctx: StructurizeContext,
  blockId: BlockId,
  meta: LabeledStatementMeta,
  outerJoin?: BlockId,
): StructuredNode {
  const exitBlock = meta.exitBlock
  if (exitBlock === undefined) {
    return structurizeBlock(ctx, blockId, { ignoreLabeledBoundary: true })
  }

  const body = structurizeBlockUntilJoin(ctx, blockId, exitBlock, {
    ignoreLabeledBoundary: true,
  })
  const labeledNode = wrapStructuredNodeWithLabel(meta, body, { allowBoundaryLabel: true })

  if (exitBlock === outerJoin || ctx.emitted.has(exitBlock)) {
    return labeledNode
  }

  const exitNode =
    outerJoin !== undefined
      ? structurizeBlockUntilJoin(ctx, exitBlock, outerJoin)
      : structurizeBlock(ctx, exitBlock)

  return combineStructuredNodes(labeledNode, exitNode)
}

/**
 * Structurize a block and its control flow successors.
 * Includes depth limit to prevent infinite recursion in pathological CFGs.
 */
function structurizeBlock(
  ctx: StructurizeContext,
  blockId: BlockId,
  options?: { ignoreLabeledBoundary?: boolean; ignoreLexicalBoundary?: boolean },
): StructuredNode {
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

  // Check if this block is reserved for explicit processing (e.g., finally blocks)
  // Reserved blocks should not trigger shared side effect warnings
  if (ctx.reservedBlocks.has(blockId)) {
    return { kind: 'sequence', nodes: [] }
  }

  if (ctx.emitted.has(blockId)) {
    // Already emitted - check if this is a problematic shared block
    // A shared block with side effects being skipped could cause issues
    if (ctx.blocksWithSideEffects.has(blockId) && ctx.joinPoints.has(blockId)) {
      ctx.sharedSideEffectBlocks.add(blockId)
      if (ctx.warnOnIssues) {
        console.warn(
          `[structurizeCFG] Shared block ${blockId} with side effects was skipped - CFG may be irreducible`,
        )
      }
    }
    return { kind: 'sequence', nodes: [] }
  }

  const labeledMeta = !options?.ignoreLabeledBoundary
    ? getLabeledStatementMeta(ctx, blockId)
    : undefined
  if (labeledMeta?.exitBlock !== undefined) {
    return structurizeLabeledStatement(ctx, blockId, labeledMeta)
  }

  const block = ctx.blockMap.get(blockId)
  if (!block) {
    ctx.problematicBlocks.add(blockId)
    return { kind: 'sequence', nodes: [] }
  }

  if (block.lexicalScopeExit !== undefined && !options?.ignoreLexicalBoundary) {
    return structurizeLexicalScopeBlock(ctx, blockId, block.lexicalScopeExit)
  }

  if (block.sourceLoop?.kind === 'doWhile') {
    if (
      subgraphHasContinueToTarget(
        ctx,
        block.id,
        block.sourceLoop.condition,
        new Set([block.sourceLoop.condition]),
      )
    ) {
      ctx.problematicBlocks.add(block.id)
    } else {
      return structurizeDoWhileLoop(ctx, block, block.sourceLoop)
    }
  }

  ctx.processing.add(blockId)
  ctx.emitted.add(blockId)
  ctx.depth++

  const nodes: StructuredNode[] = []
  const skippedInstructions = getForLoopInitInstructionsForJump(ctx, block)

  // Emit instructions
  for (const instr of block.instructions) {
    if (skippedInstructions?.has(instr)) continue
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

function toStructuredStatements(node: StructuredNode): StructuredNode[] {
  if (node.kind === 'sequence') return node.nodes
  return [node]
}

function getForLoopInitInstructionsForJump(
  ctx: StructurizeContext,
  block: BasicBlock,
): Set<Instruction> | null {
  if (block.terminator.kind !== 'Jump') return null
  const targetBlock = ctx.blockMap.get(block.terminator.target)
  const initInstructions =
    targetBlock?.sourceLoop?.kind === 'for' ? targetBlock.sourceLoop.init : undefined
  if (!initInstructions || initInstructions.length === 0) return null

  const startIndex = block.instructions.length - initInstructions.length
  if (startIndex < 0) return null
  const candidateInstructions = block.instructions.slice(startIndex)
  const matches = candidateInstructions.every((candidate, index) =>
    isMatchingForLoopInitInstruction(candidate, initInstructions[index]!),
  )
  return matches ? new Set(candidateInstructions) : null
}

function isMatchingForLoopInitInstruction(candidate: Instruction, init: Instruction): boolean {
  if (candidate.kind !== init.kind) return false
  if (candidate.kind !== 'Assign' || init.kind !== 'Assign') return candidate === init
  return (
    candidate.target.name === init.target.name && candidate.declarationKind === init.declarationKind
  )
}

function structurizeLexicalScopeBlock(
  ctx: StructurizeContext,
  blockId: BlockId,
  exitBlock: BlockId,
): StructuredNode {
  ctx.reservedBlocks.add(exitBlock)
  let body: StructuredNode
  try {
    body = structurizeBlock(ctx, blockId, { ignoreLexicalBoundary: true })
  } finally {
    ctx.reservedBlocks.delete(exitBlock)
  }

  const blockNode: StructuredNode = {
    kind: 'block',
    blockId,
    statements: toStructuredStatements(body),
  }
  const exitPreds = ctx.predecessors.get(exitBlock) ?? []
  const reachesExit = exitPreds.some(pred => ctx.emitted.has(pred))
  const exitNode = reachesExit ? structurizeBlock(ctx, exitBlock) : null
  return combineStructuredNodes(blockNode, exitNode)
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
  const isSyntheticIteratorBodyHeader = hasSyntheticIteratorBodyPredecessor(ctx, block.id)
  if (
    block.sourceLoop?.kind === 'while' &&
    block.sourceLoop.body === consequent &&
    block.sourceLoop.exit === alternate
  ) {
    return structurizeWhileLoop(ctx, block, test, consequent, alternate)
  }
  if (
    block.sourceLoop?.kind === 'for' &&
    block.sourceLoop.body === consequent &&
    block.sourceLoop.exit === alternate
  ) {
    const updateBlock = ctx.blockMap.get(block.sourceLoop.update)
    if (updateBlock) {
      return structurizeForLoop(ctx, test, {
        headerBlockId: block.id,
        bodyBlockId: block.sourceLoop.body,
        exitBlockId: block.sourceLoop.exit,
        updateBlockId: block.sourceLoop.update,
        updateInstructions: updateBlock.instructions,
        initInstructions: block.sourceLoop.init ?? null,
      })
    }
  }
  const isLoopHeader = ctx.loopHeaders.has(block.id) && !isSyntheticIteratorBodyHeader
  if (isLoopHeader) {
    const forLoop = detectForLoop(ctx, block.id, consequent, alternate)
    if (forLoop) {
      return structurizeForLoop(ctx, test, forLoop)
    }
    return structurizeWhileLoop(ctx, block, test, consequent, alternate)
  }

  // Check if consequent or alternate leads back (indicating a while loop started earlier)
  const consBackEdge = `${consequent}->${block.id}`
  const altBackEdge = `${alternate}->${block.id}`
  const consequentBlock = ctx.blockMap.get(consequent)
  const alternateBlock = ctx.blockMap.get(alternate)
  const consequentIsLoopContinue =
    consequentBlock?.terminator.kind === 'Continue' &&
    consequentBlock.terminator.target === block.id
  const alternateIsLoopContinue =
    alternateBlock?.terminator.kind === 'Continue' && alternateBlock.terminator.target === block.id
  const hasLoopBackEdge =
    !isSyntheticIteratorBodyHeader &&
    ((ctx.backEdges.has(consBackEdge) && !consequentIsLoopContinue) ||
      (ctx.backEdges.has(altBackEdge) && !alternateIsLoopContinue))
  if (hasLoopBackEdge) {
    const forLoop = detectForLoop(ctx, block.id, consequent, alternate)
    if (forLoop) {
      return structurizeForLoop(ctx, test, forLoop)
    }
    // This block is the condition of a while loop
    return structurizeWhileLoop(ctx, block, test, consequent, alternate)
  }

  // Regular if-else structure
  return structurizeIfElse(ctx, test, consequent, alternate)
}

function hasSyntheticIteratorBodyPredecessor(ctx: StructurizeContext, blockId: BlockId): boolean {
  const predecessors = ctx.predecessors.get(blockId) ?? []
  return predecessors.some(predecessorId => {
    const predecessor = ctx.blockMap.get(predecessorId)
    if (!predecessor) return false
    return (
      (predecessor.terminator.kind === 'ForOf' && predecessor.terminator.body === blockId) ||
      (predecessor.terminator.kind === 'ForIn' && predecessor.terminator.body === blockId)
    )
  })
}

interface CanonicalForLoop {
  headerBlockId: BlockId
  bodyBlockId: BlockId
  exitBlockId: BlockId
  updateBlockId: BlockId
  updateInstructions: Instruction[]
  initInstructions: Instruction[] | null
}

function detectForLoop(
  ctx: StructurizeContext,
  headerBlockId: BlockId,
  consequentId: BlockId,
  alternateId: BlockId,
): CanonicalForLoop | null {
  const predecessors = ctx.predecessors.get(headerBlockId) ?? []
  const backEdgePreds = predecessors.filter(pred => ctx.backEdges.has(`${pred}->${headerBlockId}`))
  if (backEdgePreds.length !== 1) return null

  const updateBlockId = backEdgePreds[0]
  if (
    updateBlockId === undefined ||
    updateBlockId === consequentId ||
    updateBlockId === alternateId
  ) {
    return null
  }

  const updateBlock = ctx.blockMap.get(updateBlockId)
  if (!updateBlock) return null
  if (updateBlock.terminator.kind !== 'Jump' || updateBlock.terminator.target !== headerBlockId) {
    return null
  }

  const consequentReachable = collectReachableBlocks(ctx, consequentId, new Set()).has(
    updateBlockId,
  )
  const alternateReachable = collectReachableBlocks(ctx, alternateId, new Set()).has(updateBlockId)
  if (!consequentReachable || alternateReachable) return null

  return {
    headerBlockId,
    bodyBlockId: consequentId,
    exitBlockId: alternateId,
    updateBlockId,
    updateInstructions: updateBlock.instructions,
    initInstructions: null,
  }
}

function structurizeForLoop(
  ctx: StructurizeContext,
  test: Expression,
  loop: CanonicalForLoop,
  outerJoin?: BlockId,
): StructuredNode {
  const body = structurizeBlockUntilJoin(ctx, loop.bodyBlockId, loop.updateBlockId)
  ctx.emitted.add(loop.updateBlockId)

  const forNode: StructuredNode = {
    kind: 'for',
    init: loop.initInstructions,
    test,
    update: loop.updateInstructions,
    body,
    headerBlock: loop.headerBlockId,
  }
  const labeledForNode = wrapStructuredNodeWithLabel(
    getLabeledStatementMeta(ctx, loop.headerBlockId),
    forNode,
  )

  if (loop.exitBlockId !== outerJoin && !ctx.emitted.has(loop.exitBlockId)) {
    const exit =
      outerJoin !== undefined
        ? structurizeBlockUntilJoin(ctx, loop.exitBlockId, outerJoin)
        : structurizeBlock(ctx, loop.exitBlockId)
    return combineStructuredNodes(labeledForNode, exit)
  }

  return labeledForNode
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
  outerJoin?: BlockId,
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
    if (exitBlockId !== outerJoin && !ctx.emitted.has(exitBlockId)) {
      exit =
        outerJoin !== undefined
          ? structurizeBlockUntilJoin(ctx, exitBlockId, outerJoin)
          : structurizeBlock(ctx, exitBlockId)
    }
  } else if (ctx.backEdges.has(exitEdge)) {
    // exitBlockId is actually the body (test was inverted)
    body = structurizeBlock(ctx, exitBlockId)
    if (bodyBlockId !== outerJoin && !ctx.emitted.has(bodyBlockId)) {
      exit =
        outerJoin !== undefined
          ? structurizeBlockUntilJoin(ctx, bodyBlockId, outerJoin)
          : structurizeBlock(ctx, bodyBlockId)
    }
  } else {
    // Fallback: treat consequent as body
    body = structurizeBlock(ctx, bodyBlockId)
    if (exitBlockId !== outerJoin && !ctx.emitted.has(exitBlockId)) {
      exit =
        outerJoin !== undefined
          ? structurizeBlockUntilJoin(ctx, exitBlockId, outerJoin)
          : structurizeBlock(ctx, exitBlockId)
    }
  }

  const whileNode: StructuredNode = {
    kind: 'while',
    test,
    body,
    headerBlock: condBlock.id,
  }
  const labeledWhileNode = wrapStructuredNodeWithLabel(
    getLabeledStatementMeta(ctx, condBlock.id),
    whileNode,
  )

  if (exit) {
    return combineStructuredNodes(labeledWhileNode, exit)
  }
  return labeledWhileNode
}

function structurizeDoWhileLoop(
  ctx: StructurizeContext,
  bodyBlock: BasicBlock,
  loop: Extract<NonNullable<BasicBlock['sourceLoop']>, { kind: 'doWhile' }>,
  outerJoin?: BlockId,
): StructuredNode {
  const condBlock = ctx.blockMap.get(loop.condition)
  const test =
    condBlock?.terminator.kind === 'Branch'
      ? condBlock.terminator.test
      : ({ kind: 'Literal', value: true } as Expression)
  const body = structurizeBlockUntilJoin(ctx, bodyBlock.id, loop.condition)
  ctx.emitted.add(loop.condition)

  const doWhileNode: StructuredNode = {
    kind: 'doWhile',
    test,
    body,
    headerBlock: loop.condition,
  }
  const labeledDoWhileNode = wrapStructuredNodeWithLabel(
    getLabeledStatementMeta(ctx, loop.condition),
    doWhileNode,
  )

  if (loop.exit !== outerJoin && !ctx.emitted.has(loop.exit)) {
    const exit =
      outerJoin !== undefined
        ? structurizeBlockUntilJoin(ctx, loop.exit, outerJoin)
        : structurizeBlock(ctx, loop.exit)
    return combineStructuredNodes(labeledDoWhileNode, exit)
  }

  return labeledDoWhileNode
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
    if (ctx.reservedBlocks.has(current)) continue

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
  if (ctx.reservedBlocks.has(start)) return visited
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
  options?: { ignoreLabeledBoundary?: boolean },
): StructuredNode {
  if (joinBlock !== undefined && blockId === joinBlock) {
    return { kind: 'sequence', nodes: [] }
  }

  if (ctx.reservedBlocks.has(blockId)) {
    return { kind: 'sequence', nodes: [] }
  }

  if (ctx.emitted.has(blockId)) {
    // Track shared blocks with side effects that were skipped
    // This can happen when a block is reached from multiple paths
    // but wasn't properly identified as a join point
    if (ctx.blocksWithSideEffects.has(blockId) && ctx.joinPoints.has(blockId)) {
      ctx.sharedSideEffectBlocks.add(blockId)
      if (ctx.warnOnIssues) {
        console.warn(
          `[structurizeCFG] Block ${blockId} with side effects was already emitted - ` +
            `this may indicate incorrect join point detection`,
        )
      }
    }
    return { kind: 'sequence', nodes: [] }
  }

  const labeledMeta = !options?.ignoreLabeledBoundary
    ? getLabeledStatementMeta(ctx, blockId)
    : undefined
  if (labeledMeta?.exitBlock !== undefined) {
    return structurizeLabeledStatement(ctx, blockId, labeledMeta, joinBlock)
  }

  const block = ctx.blockMap.get(blockId)
  if (!block) {
    return { kind: 'sequence', nodes: [] }
  }

  ctx.emitted.add(blockId)
  const nodes: StructuredNode[] = []
  const skippedInstructions = getForLoopInitInstructionsForJump(ctx, block)

  // Emit instructions
  for (const instr of block.instructions) {
    if (skippedInstructions?.has(instr)) continue
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

    case 'Switch': {
      nodes.push(structurizeSwitch(ctx, block, term, joinBlock))
      break
    }

    case 'ForOf': {
      nodes.push(structurizeForOf(ctx, block, term, joinBlock))
      break
    }

    case 'ForIn': {
      nodes.push(structurizeForIn(ctx, block, term, joinBlock))
      break
    }

    case 'Try': {
      nodes.push(structurizeTry(ctx, block, term, joinBlock))
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

  const isSyntheticIteratorBodyHeader = hasSyntheticIteratorBodyPredecessor(ctx, block.id)
  if (
    block.sourceLoop?.kind === 'while' &&
    block.sourceLoop.body === consequent &&
    block.sourceLoop.exit === alternate
  ) {
    return structurizeWhileLoop(ctx, block, test, consequent, alternate, outerJoin)
  }
  if (
    block.sourceLoop?.kind === 'for' &&
    block.sourceLoop.body === consequent &&
    block.sourceLoop.exit === alternate
  ) {
    const updateBlock = ctx.blockMap.get(block.sourceLoop.update)
    if (updateBlock) {
      return structurizeForLoop(
        ctx,
        test,
        {
          headerBlockId: block.id,
          bodyBlockId: block.sourceLoop.body,
          exitBlockId: block.sourceLoop.exit,
          updateBlockId: block.sourceLoop.update,
          updateInstructions: updateBlock.instructions,
          initInstructions: block.sourceLoop.init ?? null,
        },
        outerJoin,
      )
    }
  }
  const isLoopHeader = ctx.loopHeaders.has(block.id) && !isSyntheticIteratorBodyHeader
  if (isLoopHeader) {
    const forLoop = detectForLoop(ctx, block.id, consequent, alternate)
    if (forLoop) {
      return structurizeForLoop(ctx, test, forLoop, outerJoin)
    }
    return structurizeWhileLoop(ctx, block, test, consequent, alternate, outerJoin)
  }

  const consBackEdge = `${consequent}->${block.id}`
  const altBackEdge = `${alternate}->${block.id}`
  const consequentBlock = ctx.blockMap.get(consequent)
  const alternateBlock = ctx.blockMap.get(alternate)
  const consequentIsLoopContinue =
    consequentBlock?.terminator.kind === 'Continue' &&
    consequentBlock.terminator.target === block.id
  const alternateIsLoopContinue =
    alternateBlock?.terminator.kind === 'Continue' && alternateBlock.terminator.target === block.id
  const hasLoopBackEdge =
    !isSyntheticIteratorBodyHeader &&
    ((ctx.backEdges.has(consBackEdge) && !consequentIsLoopContinue) ||
      (ctx.backEdges.has(altBackEdge) && !alternateIsLoopContinue))
  if (hasLoopBackEdge) {
    const forLoop = detectForLoop(ctx, block.id, consequent, alternate)
    if (forLoop) {
      return structurizeForLoop(ctx, test, forLoop, outerJoin)
    }
    return structurizeWhileLoop(ctx, block, test, consequent, alternate, outerJoin)
  }

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
    cases: { test?: Expression | undefined; target: BlockId; syntheticDefault?: boolean }[]
  },
  outerJoin?: BlockId,
): StructuredNode {
  const syntheticDefaultTarget = term.cases.find(c => c.syntheticDefault)?.target
  const sourceCases = term.cases.filter(c => !c.syntheticDefault)
  const uniqueTargets = Array.from(new Set(sourceCases.map(c => c.target)))
  let joinBlock =
    syntheticDefaultTarget !== undefined
      ? syntheticDefaultTarget
      : findSwitchJoinBlock(ctx, uniqueTargets)
  if (
    syntheticDefaultTarget === undefined &&
    outerJoin !== undefined &&
    (joinBlock === undefined || joinBlock === outerJoin)
  ) {
    const localExit = findSwitchLocalExitBlock(ctx, uniqueTargets, outerJoin)
    if (localExit !== undefined) {
      joinBlock = localExit
    }
  }
  const cases: { test: Expression | null; body: StructuredNode }[] = []
  const emittedBeforeSwitch = new Set(ctx.emitted)
  const emittedBySwitchCases = new Set<BlockId>()

  for (const c of sourceCases) {
    const caseCtx: StructurizeContext = {
      ...ctx,
      emitted: new Set(emittedBeforeSwitch),
      processing: new Set(ctx.processing),
    }
    const body =
      joinBlock !== undefined
        ? structurizeBlockUntilJoin(caseCtx, c.target, joinBlock)
        : structurizeBlock(caseCtx, c.target)
    for (const emittedBlock of caseCtx.emitted) {
      if (!emittedBeforeSwitch.has(emittedBlock)) {
        emittedBySwitchCases.add(emittedBlock)
      }
    }
    const normalizedBody = appendSwitchCaseBreak(body)
    cases.push({ test: c.test ?? null, body: normalizedBody })
  }

  for (const emittedBlock of emittedBySwitchCases) {
    ctx.emitted.add(emittedBlock)
  }

  const switchNode: StructuredNode = {
    kind: 'switch',
    discriminant: term.discriminant,
    cases,
  }
  const labeledSwitchNode = wrapStructuredNodeWithLabel(
    getLabeledStatementMeta(ctx, block.id),
    switchNode,
  )

  if (joinBlock !== undefined && joinBlock !== outerJoin && !ctx.emitted.has(joinBlock)) {
    const joinNode =
      outerJoin !== undefined
        ? structurizeBlockUntilJoin(ctx, joinBlock, outerJoin)
        : structurizeBlock(ctx, joinBlock)
    return combineStructuredNodes(labeledSwitchNode, joinNode)
  }

  return labeledSwitchNode
}

function findSwitchJoinBlock(ctx: StructurizeContext, caseTargets: BlockId[]): BlockId | undefined {
  const uniqueTargets = Array.from(new Set(caseTargets))
  if (uniqueTargets.length === 0) return undefined

  const reachableByCase = uniqueTargets.map(target =>
    collectReachableBlocks(ctx, target, new Set<BlockId>()),
  )
  const reachableUnion = new Set<BlockId>()
  for (const set of reachableByCase) {
    for (const id of set) reachableUnion.add(id)
  }

  const minCaseCoverage = uniqueTargets.length > 1 ? 2 : 1
  interface Candidate {
    id: BlockId
    reachableCases: number
    predecessorCount: number
    isJoinPoint: boolean
  }
  const candidates: Candidate[] = []

  for (const id of reachableUnion) {
    if (uniqueTargets.includes(id)) continue

    let reachableCases = 0
    for (const set of reachableByCase) {
      if (set.has(id)) reachableCases++
    }
    if (reachableCases < minCaseCoverage) continue

    const predecessors = ctx.predecessors.get(id) ?? []
    const predecessorCount = predecessors.filter(pred => reachableUnion.has(pred)).length

    candidates.push({
      id,
      reachableCases,
      predecessorCount,
      isJoinPoint: predecessors.length > 1,
    })
  }

  if (candidates.length === 0) return undefined

  candidates.sort((a, b) => {
    if (a.reachableCases !== b.reachableCases) return b.reachableCases - a.reachableCases
    if (a.predecessorCount !== b.predecessorCount) return b.predecessorCount - a.predecessorCount
    if (a.isJoinPoint !== b.isJoinPoint) return Number(b.isJoinPoint) - Number(a.isJoinPoint)
    return a.id - b.id
  })

  return candidates[0]?.id
}

function findSwitchLocalExitBlock(
  ctx: StructurizeContext,
  caseTargets: BlockId[],
  outerJoin: BlockId,
): BlockId | undefined {
  const exitTargets = new Set<BlockId>()

  const visit = (blockId: BlockId, visited: Set<BlockId>): void => {
    if (blockId === outerJoin || visited.has(blockId) || ctx.reservedBlocks.has(blockId)) {
      return
    }
    visited.add(blockId)

    const block = ctx.blockMap.get(blockId)
    if (!block) return

    if (block.terminator.kind === 'Break') {
      if (block.terminator.target !== outerJoin) {
        exitTargets.add(block.terminator.target)
      }
      return
    }
    if (
      block.terminator.kind === 'Continue' ||
      block.terminator.kind === 'Return' ||
      block.terminator.kind === 'Throw' ||
      block.terminator.kind === 'Unreachable'
    ) {
      return
    }

    const succs = ctx.successors.get(blockId) ?? []
    for (const succ of succs) {
      const edgeKey = `${blockId}->${succ}`
      if (!ctx.backEdges.has(edgeKey)) {
        visit(succ, visited)
      }
    }
  }

  for (const target of caseTargets) {
    visit(target, new Set<BlockId>())
  }

  if (exitTargets.size !== 1) return undefined
  return Array.from(exitTargets)[0]
}

function appendSwitchCaseBreak(body: StructuredNode): StructuredNode {
  if (isSwitchCaseTerminated(body)) return body
  if (body.kind === 'sequence') {
    return { kind: 'sequence', nodes: [...body.nodes, { kind: 'break' }] }
  }
  return { kind: 'sequence', nodes: [body, { kind: 'break' }] }
}

function isSwitchCaseTerminated(node: StructuredNode | null | undefined): boolean {
  if (!node) return false
  switch (node.kind) {
    case 'return':
    case 'throw':
    case 'break':
    case 'continue':
      return true
    case 'sequence':
      return node.nodes.length > 0 && isSwitchCaseTerminated(node.nodes[node.nodes.length - 1])
    case 'block':
      return (
        node.statements.length > 0 &&
        isSwitchCaseTerminated(node.statements[node.statements.length - 1])
      )
    case 'labeled':
      return false
    case 'if':
      return (
        isSwitchCaseTerminated(node.consequent) &&
        isSwitchCaseTerminated(node.alternate ?? undefined)
      )
    case 'try':
      if (node.finalizer && isSwitchCaseTerminated(node.finalizer)) return true
      return (
        isSwitchCaseTerminated(node.block) &&
        isSwitchCaseTerminated(node.handler?.body ?? undefined)
      )
    default:
      return false
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
    leftKind?: 'declaration' | 'assignment' | undefined
    variableKind: 'const' | 'let' | 'var'
    pattern?: LVal | undefined
    iterable: Expression
    body: BlockId
    exit: BlockId
  },
  outerJoin?: BlockId,
): StructuredNode {
  ctx.reservedBlocks.add(term.exit)
  const body = structurizeBlock(ctx, term.body)
  ctx.reservedBlocks.delete(term.exit)
  const exit =
    term.exit !== outerJoin && !ctx.emitted.has(term.exit)
      ? outerJoin !== undefined
        ? structurizeBlockUntilJoin(ctx, term.exit, outerJoin)
        : structurizeBlock(ctx, term.exit)
      : null

  const forOfNode: StructuredNode = {
    kind: 'forOf',
    variable: term.variable,
    leftKind: term.leftKind,
    variableKind: term.variableKind,
    pattern: term.pattern,
    iterable: term.iterable,
    body,
  }
  const labeledForOfNode = wrapStructuredNodeWithLabel(
    getLabeledStatementMeta(ctx, block.id),
    forOfNode,
  )

  if (exit) {
    return combineStructuredNodes(labeledForOfNode, exit)
  }
  return labeledForOfNode
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
    leftKind?: 'declaration' | 'assignment' | undefined
    variableKind: 'const' | 'let' | 'var'
    pattern?: LVal | undefined
    object: Expression
    body: BlockId
    exit: BlockId
  },
  outerJoin?: BlockId,
): StructuredNode {
  ctx.reservedBlocks.add(term.exit)
  const body = structurizeBlock(ctx, term.body)
  ctx.reservedBlocks.delete(term.exit)
  const exit =
    term.exit !== outerJoin && !ctx.emitted.has(term.exit)
      ? outerJoin !== undefined
        ? structurizeBlockUntilJoin(ctx, term.exit, outerJoin)
        : structurizeBlock(ctx, term.exit)
      : null

  const forInNode: StructuredNode = {
    kind: 'forIn',
    variable: term.variable,
    leftKind: term.leftKind,
    variableKind: term.variableKind,
    pattern: term.pattern,
    object: term.object,
    body,
  }
  const labeledForInNode = wrapStructuredNodeWithLabel(
    getLabeledStatementMeta(ctx, block.id),
    forInNode,
  )

  if (exit) {
    return combineStructuredNodes(labeledForInNode, exit)
  }
  return labeledForInNode
}

function collectSubgraphBlocksUntilStop(
  ctx: StructurizeContext,
  start: BlockId | undefined,
  stopBlocks: Set<BlockId>,
  visited = new Set<BlockId>(),
): Set<BlockId> {
  if (start === undefined || stopBlocks.has(start) || visited.has(start)) {
    return visited
  }
  visited.add(start)

  const block = ctx.blockMap.get(start)
  if (!block) {
    return visited
  }
  if (block.terminator.kind === 'Break' || block.terminator.kind === 'Continue') {
    return visited
  }

  const successors = ctx.successors.get(start) ?? []
  for (const succ of successors) {
    collectSubgraphBlocksUntilStop(ctx, succ, stopBlocks, visited)
  }
  return visited
}

function subgraphHasContinueToTarget(
  ctx: StructurizeContext,
  start: BlockId | undefined,
  target: BlockId,
  stopBlocks: Set<BlockId>,
  visited = new Set<BlockId>(),
): boolean {
  if (start === undefined || stopBlocks.has(start) || visited.has(start)) {
    return false
  }
  visited.add(start)

  const block = ctx.blockMap.get(start)
  if (!block) return false
  if (block.terminator.kind === 'Continue') {
    return block.terminator.target === target
  }
  if (block.terminator.kind === 'Break') {
    return false
  }

  const successors = ctx.successors.get(start) ?? []
  for (const succ of successors) {
    if (subgraphHasContinueToTarget(ctx, succ, target, stopBlocks, visited)) {
      return true
    }
  }
  return false
}

function subgraphHasEscapingLoopControlTransfer(
  ctx: StructurizeContext,
  start: BlockId | undefined,
  protectedBlocks: Set<BlockId>,
  stopBlocks: Set<BlockId>,
  allowedTargets?: Set<BlockId>,
  visited = new Set<BlockId>(),
): boolean {
  if (start === undefined || stopBlocks.has(start) || visited.has(start)) {
    return false
  }
  visited.add(start)

  const block = ctx.blockMap.get(start)
  if (!block) return false
  if (
    (block.terminator.kind === 'Break' || block.terminator.kind === 'Continue') &&
    !protectedBlocks.has(block.terminator.target) &&
    !(allowedTargets?.has(block.terminator.target) ?? false)
  ) {
    return true
  }

  const successors = ctx.successors.get(start) ?? []
  for (const succ of successors) {
    if (
      subgraphHasEscapingLoopControlTransfer(
        ctx,
        succ,
        protectedBlocks,
        stopBlocks,
        allowedTargets,
        visited,
      )
    ) {
      return true
    }
  }
  return false
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
    catchBlock?: BlockId | undefined
    catchParam?: string | undefined
    finallyBlock?: BlockId | undefined
    exit: BlockId
  },
  outerJoin?: BlockId,
): StructuredNode {
  if (term.finallyBlock !== undefined) {
    const stopBlocks = new Set<BlockId>([term.finallyBlock, term.exit])
    const trySubgraph = collectSubgraphBlocksUntilStop(ctx, term.tryBlock, stopBlocks)
    const catchSubgraph = collectSubgraphBlocksUntilStop(ctx, term.catchBlock, stopBlocks)
    const allowedTargets = outerJoin !== undefined ? new Set<BlockId>([outerJoin]) : undefined
    if (
      subgraphHasEscapingLoopControlTransfer(
        ctx,
        term.tryBlock,
        trySubgraph,
        stopBlocks,
        allowedTargets,
      ) ||
      subgraphHasEscapingLoopControlTransfer(
        ctx,
        term.catchBlock,
        catchSubgraph,
        stopBlocks,
        allowedTargets,
      )
    ) {
      ctx.problematicBlocks.add(block.id)
      return { kind: 'sequence', nodes: [] }
    }
  }

  // Reserve finally and exit blocks to prevent catch/try blocks from prematurely processing them
  // This avoids "shared side effect block" issues when catch jumps to finally
  if (term.finallyBlock !== undefined) {
    ctx.reservedBlocks.add(term.finallyBlock)
  }
  ctx.reservedBlocks.add(term.exit)

  const tryBody = structurizeBlock(ctx, term.tryBlock)

  let handler: { param: string | null; body: StructuredNode } | null = null
  if (term.catchBlock !== undefined) {
    const catchBody = structurizeBlock(ctx, term.catchBlock)
    handler = {
      param: term.catchParam ?? null,
      body: catchBody,
    }
  }

  // Unreserve and actually process finally and exit blocks
  if (term.finallyBlock !== undefined) {
    ctx.reservedBlocks.delete(term.finallyBlock)
  }
  ctx.reservedBlocks.delete(term.exit)

  let finalizer: StructuredNode | null = null
  if (term.finallyBlock !== undefined) {
    finalizer = structurizeBlockUntilJoin(ctx, term.finallyBlock, term.exit)
  }

  const exit =
    term.exit !== outerJoin && !ctx.emitted.has(term.exit)
      ? outerJoin !== undefined
        ? structurizeBlockUntilJoin(ctx, term.exit, outerJoin)
        : structurizeBlock(ctx, term.exit)
      : null

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
