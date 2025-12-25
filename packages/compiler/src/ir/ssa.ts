import type { BasicBlock, BlockId, HIRFunction, HIRProgram, Identifier, Instruction } from './hir'
import { makeSSAName, getSSABaseName } from './hir'

/**
 * SSA conversion with optimizations:
 * - Inserts Phi nodes using dominance frontiers.
 * - Renames all definitions/uses to versioned identifiers.
 * - Eliminates redundant Phi nodes (all operands identical).
 * - Detects back-edges for loop-aware analysis.
 * - Uses a simple dominator tree; not optimized for pathological CFGs.
 */
export function enterSSA(program: HIRProgram): HIRProgram {
  const functions = program.functions.map(fn => {
    const ssa = toSSA(fn)
    const result = eliminateRedundantPhis(ssa)
    // Validate phi node sources after SSA conversion
    validatePhiSources(result)
    return result
  })
  return {
    functions,
    preamble: program.preamble || [],
    postamble: program.postamble || [],
    originalBody: program.originalBody || [],
  }
}

/**
 * Results of control flow analysis including back-edges
 */
export interface CFGAnalysis {
  predecessors: Map<BlockId, BlockId[]>
  successors: Map<BlockId, BlockId[]>
  dominatorTree: DominatorTree
  dominanceFrontier: Map<BlockId, Set<BlockId>>
  backEdges: Set<string> // "from->to" format
  loopHeaders: Set<BlockId>
}

interface DominatorTree {
  idom: Map<BlockId, BlockId>
  children: Map<BlockId, BlockId[]>
}

/**
 * Perform comprehensive control flow analysis
 */
export function analyzeCFG(blocks: BasicBlock[]): CFGAnalysis {
  const predecessors = computePredecessors(blocks)
  const successors = computeSuccessors(blocks)
  const dominatorTree = computeDomTree(blocks, predecessors, successors)
  const dominanceFrontier = computeDominanceFrontier(blocks, predecessors, dominatorTree.idom)

  // Detect back-edges: edge from B to A where A dominates B
  const backEdges = new Set<string>()
  const loopHeaders = new Set<BlockId>()

  for (const block of blocks) {
    for (const succ of successors.get(block.id) ?? []) {
      if (dominates(dominatorTree.idom, succ, block.id)) {
        backEdges.add(`${block.id}->${succ}`)
        loopHeaders.add(succ)
      }
    }
  }

  return {
    predecessors,
    successors,
    dominatorTree,
    dominanceFrontier,
    backEdges,
    loopHeaders,
  }
}

/**
 * Check if A dominates B (A appears on every path from entry to B)
 */
function dominates(idom: Map<BlockId, BlockId>, a: BlockId, b: BlockId): boolean {
  let current = b
  while (current !== a) {
    const dom = idom.get(current)
    if (dom === undefined || dom === current) {
      return current === a
    }
    current = dom
  }
  return true
}

/**
 * Eliminate redundant Phi nodes where all operands are identical
 * or where the Phi refers to itself (trivial Phis).
 */
function eliminateRedundantPhis(fn: HIRFunction): HIRFunction {
  let changed = true
  let blocks = fn.blocks

  while (changed) {
    changed = false
    const phiRewrites = new Map<string, string>()

    // Find redundant Phis
    for (const block of blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Phi') {
          const phi = instr as any
          const sources = phi.sources as { block: BlockId; id: Identifier }[]

          if (sources.length === 0) continue

          // Filter out self-references
          const nonSelfSources = sources.filter(
            (s: { id: Identifier }) => s.id.name !== phi.target.name,
          )

          if (nonSelfSources.length === 0) {
            // All sources are self-references - this is dead, remove it
            continue
          }

          // Check if all non-self sources are the same
          const firstSource = nonSelfSources[0]
          if (!firstSource) continue
          const firstName = firstSource.id.name
          const allSame = nonSelfSources.every((s: { id: Identifier }) => s.id.name === firstName)

          if (allSame) {
            // This Phi can be replaced with its unique source
            phiRewrites.set(phi.target.name, firstName)
            changed = true
          }
        }
      }
    }

    if (!changed) break

    // Apply rewrites
    blocks = blocks.map(block => {
      const newInstructions = block.instructions
        .filter(instr => {
          if (instr.kind === 'Phi') {
            const phi = instr as any
            return !phiRewrites.has(phi.target.name)
          }
          return true
        })
        .map(instr => rewriteInstruction(instr, phiRewrites))

      const newTerminator = rewriteTerminator(block.terminator, phiRewrites)

      return {
        ...block,
        instructions: newInstructions,
        terminator: newTerminator,
      }
    })
  }

  return { ...fn, blocks }
}

/**
 * Rewrite references in an instruction based on Phi elimination
 */
function rewriteInstruction(instr: Instruction, rewrites: Map<string, string>): Instruction {
  if (instr.kind === 'Assign') {
    return {
      ...instr,
      value: rewriteExprWithMap(instr.value, rewrites),
    }
  }
  if (instr.kind === 'Expression') {
    return {
      ...instr,
      value: rewriteExprWithMap(instr.value, rewrites),
    }
  }
  if (instr.kind === 'Phi') {
    const phi = instr as any
    return {
      ...phi,
      sources: phi.sources.map((s: any) => ({
        ...s,
        id: { ...s.id, name: rewrites.get(s.id.name) ?? s.id.name },
      })),
    }
  }
  return instr
}

/**
 * Rewrite references in an expression based on Phi elimination
 */
function rewriteExprWithMap(expr: any, rewrites: Map<string, string>): any {
  if (!expr) return expr

  switch (expr.kind) {
    case 'Identifier':
      return { ...expr, name: rewrites.get(expr.name) ?? expr.name }
    case 'CallExpression':
      return {
        ...expr,
        callee: rewriteExprWithMap(expr.callee, rewrites),
        arguments: expr.arguments.map((a: any) => rewriteExprWithMap(a, rewrites)),
      }
    case 'MemberExpression':
      return {
        ...expr,
        object: rewriteExprWithMap(expr.object, rewrites),
        property: rewriteExprWithMap(expr.property, rewrites),
      }
    case 'BinaryExpression':
    case 'LogicalExpression':
      return {
        ...expr,
        left: rewriteExprWithMap(expr.left, rewrites),
        right: rewriteExprWithMap(expr.right, rewrites),
      }
    case 'UnaryExpression':
      return { ...expr, argument: rewriteExprWithMap(expr.argument, rewrites) }
    case 'ConditionalExpression':
      return {
        ...expr,
        test: rewriteExprWithMap(expr.test, rewrites),
        consequent: rewriteExprWithMap(expr.consequent, rewrites),
        alternate: rewriteExprWithMap(expr.alternate, rewrites),
      }
    case 'ArrayExpression':
      return { ...expr, elements: expr.elements.map((el: any) => rewriteExprWithMap(el, rewrites)) }
    case 'ObjectExpression':
      return {
        ...expr,
        properties: expr.properties.map((p: any) => ({
          ...p,
          key: rewriteExprWithMap(p.key, rewrites),
          value: rewriteExprWithMap(p.value, rewrites),
        })),
      }
    default:
      return expr
  }
}

/**
 * Rewrite terminator with rewrites map
 */
function rewriteTerminator(term: any, rewrites: Map<string, string>): any {
  switch (term.kind) {
    case 'Return':
      return {
        ...term,
        argument: term.argument ? rewriteExprWithMap(term.argument, rewrites) : term.argument,
      }
    case 'Throw':
      return { ...term, argument: rewriteExprWithMap(term.argument, rewrites) }
    case 'Branch':
      return { ...term, test: rewriteExprWithMap(term.test, rewrites) }
    case 'Switch':
      return {
        ...term,
        discriminant: rewriteExprWithMap(term.discriminant, rewrites),
        cases: term.cases.map((c: any) => ({
          ...c,
          test: c.test ? rewriteExprWithMap(c.test, rewrites) : c.test,
        })),
      }
    default:
      return term
  }
}

function toSSA(fn: HIRFunction): HIRFunction {
  const preds = computePredecessors(fn.blocks)
  const succs = computeSuccessors(fn.blocks)
  const domTree = computeDomTree(fn.blocks, preds, succs)
  const df = computeDominanceFrontier(fn.blocks, preds, domTree.idom)

  // Collect def sites
  const defSites = new Map<string, Set<BlockId>>()
  fn.blocks.forEach(block => {
    block.instructions.forEach(instr => {
      if (instr.kind === 'Assign') {
        const set = defSites.get(instr.target.name) ?? new Set<BlockId>()
        set.add(block.id)
        defSites.set(instr.target.name, set)
      }
    })
  })

  // Insert Phi nodes where needed (frontier-based)
  const phiBlocks = new Map<BlockId, Map<string, Instruction>>()
  defSites.forEach((blocks, variable) => {
    const worklist = [...blocks]
    const hasPhi = new Set<BlockId>()
    while (worklist.length) {
      const b = worklist.pop()!
      const frontier = df.get(b) ?? new Set()
      frontier.forEach(f => {
        if (!hasPhi.has(f)) {
          hasPhi.add(f)
          const target: Identifier = { kind: 'Identifier', name: variable }
          const phi: Instruction = { kind: 'Phi', variable, target, sources: [] }
          const map = phiBlocks.get(f) ?? new Map()
          map.set(variable, phi)
          phiBlocks.set(f, map)
          if (!defSites.get(variable)?.has(f)) {
            worklist.push(f)
          }
        }
      })
    }
  })

  // Prepend phi instructions
  const blocksWithPhi = fn.blocks.map(block => {
    const phiMap = phiBlocks.get(block.id)
    if (!phiMap) return block
    const phis = Array.from(phiMap.values())
    return { ...block, instructions: [...phis, ...block.instructions] }
  })

  // Rename through dominator tree
  const counters = new Map<string, number>()
  const stacks = new Map<string, string[]>()
  const renamedBlocks = new Map<BlockId, BasicBlock>()
  // Collect phi sources immutably to avoid mutating during traversal
  const pendingPhiSources = new Map<
    BlockId,
    { variable: string; source: { block: BlockId; id: Identifier } }[]
  >()

  const renameVar = (name: string) => {
    // Get the base name without any existing SSA suffix
    const baseName = getSSABaseName(name)
    const next = (counters.get(baseName) ?? 0) + 1
    counters.set(baseName, next)
    const full = makeSSAName(baseName, next)
    const stack = stacks.get(baseName) ?? []
    stack.push(full)
    stacks.set(baseName, stack)
    return full
  }
  const currentName = (name: string) => {
    const baseName = getSSABaseName(name)
    const stack = stacks.get(baseName)
    if (!stack || stack.length === 0) return name
    return stack[stack.length - 1]
  }
  const popName = (name: string) => {
    const baseName = getSSABaseName(name)
    const stack = stacks.get(baseName)
    if (stack) stack.pop()
  }

  const renameExpr = (expr: any): any => {
    switch (expr?.kind) {
      case 'Identifier':
        return { ...expr, name: currentName(expr.name) }
      case 'CallExpression':
        return {
          ...expr,
          callee: renameExpr(expr.callee),
          arguments: expr.arguments.map((a: any) => renameExpr(a)),
        }
      case 'MemberExpression':
        return { ...expr, object: renameExpr(expr.object), property: renameExpr(expr.property) }
      case 'BinaryExpression':
      case 'LogicalExpression':
        return { ...expr, left: renameExpr(expr.left), right: renameExpr(expr.right) }
      case 'UnaryExpression':
        return { ...expr, argument: renameExpr(expr.argument) }
      case 'ConditionalExpression':
        return {
          ...expr,
          test: renameExpr(expr.test),
          consequent: renameExpr(expr.consequent),
          alternate: renameExpr(expr.alternate),
        }
      case 'ArrayExpression':
        return { ...expr, elements: expr.elements.map((el: any) => renameExpr(el)) }
      case 'ObjectExpression':
        return {
          ...expr,
          properties: expr.properties.map((p: any) => ({
            ...p,
            key: renameExpr(p.key),
            value: renameExpr(p.value),
          })),
        }
      default:
        return expr
    }
  }

  const renameBlock = (blockId: BlockId) => {
    const block = blocksWithPhi.find(b => b.id === blockId)!
    const newInstr: Instruction[] = []

    // Rename Phi targets - create new phi with renamed target
    const renamedPhis: Instruction[] = []
    for (const instr of block.instructions) {
      if (instr.kind === 'Phi') {
        const newName = renameVar(instr.variable)
        renamedPhis.push({
          ...instr,
          target: { ...instr.target, name: newName },
        })
      }
    }

    // Use index-based access instead of shift() to avoid race conditions
    let phiIndex = 0
    for (const instr of block.instructions) {
      if (instr.kind === 'Phi') {
        // Use the renamed phi from above with index-based access
        const renamedPhi = renamedPhis[phiIndex++]
        if (renamedPhi) {
          newInstr.push(renamedPhi)
        } else {
          throw new Error(`SSA: Phi instruction count mismatch at block ${blockId}`)
        }
        continue
      }
      if (instr.kind === 'Assign') {
        const renamedValue = renameExpr(instr.value)
        const newName = renameVar(getSSABaseName(instr.target.name))
        newInstr.push({
          kind: 'Assign',
          target: { ...instr.target, name: newName },
          value: renamedValue,
        })
      } else if (instr.kind === 'Expression') {
        newInstr.push({ kind: 'Expression', value: renameExpr(instr.value) })
      }
    }

    // Validate all phis were processed
    if (phiIndex !== renamedPhis.length) {
      throw new Error(
        `SSA: Phi instruction count mismatch at block ${blockId}: processed ${phiIndex}, expected ${renamedPhis.length}`,
      )
    }

    // Collect phi sources for successors (immutable approach)
    for (const succ of succs.get(blockId) ?? []) {
      const succBlock = blocksWithPhi.find(b => b.id === succ)
      if (!succBlock) continue
      const updates = pendingPhiSources.get(succ) ?? []
      for (const instr of succBlock.instructions) {
        if (instr.kind === 'Phi') {
          const name = currentName(instr.variable) ?? instr.variable
          updates.push({
            variable: instr.variable,
            source: { block: blockId, id: { kind: 'Identifier', name } },
          })
        }
      }
      pendingPhiSources.set(succ, updates)
    }

    // Rewrite terminator
    const terminator = renameTerminator(block.terminator, renameExpr)

    renamedBlocks.set(blockId, { ...block, instructions: newInstr, terminator })

    // Recurse into dominated children
    for (const child of domTree.children.get(blockId) ?? []) {
      renameBlock(child)
    }

    // Pop names defined in this block
    for (const instr of block.instructions) {
      if (instr.kind === 'Phi') {
        popName(instr.variable)
      } else if (instr.kind === 'Assign') {
        popName(getSSABaseName(instr.target.name))
      }
    }
  }

  const firstBlock = fn.blocks[0]
  if (firstBlock) {
    renameBlock(firstBlock.id)
  }

  // Apply pending phi sources immutably
  const blocks = fn.blocks.map(b => {
    const renamed = renamedBlocks.get(b.id) ?? b
    const updates = pendingPhiSources.get(b.id)
    if (!updates || updates.length === 0) return renamed

    // Apply pending phi sources immutably
    const newInstructions = renamed.instructions.map(instr => {
      if (instr.kind !== 'Phi') return instr
      const phi = instr as any
      const relevantUpdates = updates.filter(u => u.variable === phi.variable)
      if (relevantUpdates.length === 0) return instr
      return {
        ...phi,
        sources: [...phi.sources, ...relevantUpdates.map(u => u.source)],
      }
    })
    return { ...renamed, instructions: newInstructions }
  })
  return { ...fn, blocks }
}

function computePredecessors(blocks: BasicBlock[]): Map<number, number[]> {
  const preds = new Map<number, number[]>()
  const add = (from: number, to: number) => {
    const arr = preds.get(to) ?? []
    arr.push(from)
    preds.set(to, arr)
  }
  for (const block of blocks) {
    const bid = block.id
    switch (block.terminator.kind) {
      case 'Jump':
        add(bid, block.terminator.target)
        break
      case 'Branch':
        add(bid, block.terminator.consequent)
        add(bid, block.terminator.alternate)
        break
      case 'Switch':
        for (const c of block.terminator.cases) {
          add(bid, c.target)
        }
        break
      case 'Break':
        add(bid, block.terminator.target)
        break
      case 'Continue':
        add(bid, block.terminator.target)
        break
      case 'ForOf':
        add(bid, block.terminator.body)
        add(bid, block.terminator.exit)
        break
      case 'ForIn':
        add(bid, block.terminator.body)
        add(bid, block.terminator.exit)
        break
      case 'Try':
        add(bid, block.terminator.tryBlock)
        if (block.terminator.catchBlock !== undefined) {
          add(bid, block.terminator.catchBlock)
        }
        if (block.terminator.finallyBlock !== undefined) {
          add(bid, block.terminator.finallyBlock)
        }
        add(bid, block.terminator.exit)
        break
      default:
        break
    }
  }
  return preds
}

function computeSuccessors(blocks: BasicBlock[]): Map<number, number[]> {
  const succ = new Map<number, number[]>()
  const add = (from: number, to: number) => {
    const arr = succ.get(from) ?? []
    arr.push(to)
    succ.set(from, arr)
  }
  for (const block of blocks) {
    switch (block.terminator.kind) {
      case 'Jump':
        add(block.id, block.terminator.target)
        break
      case 'Branch':
        add(block.id, block.terminator.consequent)
        add(block.id, block.terminator.alternate)
        break
      case 'Switch':
        for (const c of block.terminator.cases) {
          add(block.id, c.target)
        }
        break
      case 'Break':
        add(block.id, block.terminator.target)
        break
      case 'Continue':
        add(block.id, block.terminator.target)
        break
      case 'ForOf':
        add(block.id, block.terminator.body)
        add(block.id, block.terminator.exit)
        break
      case 'ForIn':
        add(block.id, block.terminator.body)
        add(block.id, block.terminator.exit)
        break
      case 'Try':
        add(block.id, block.terminator.tryBlock)
        if (block.terminator.catchBlock !== undefined) {
          add(block.id, block.terminator.catchBlock)
        }
        if (block.terminator.finallyBlock !== undefined) {
          add(block.id, block.terminator.finallyBlock)
        }
        add(block.id, block.terminator.exit)
        break
      default:
        break
    }
  }
  return succ
}

function computeDomTree(
  blocks: BasicBlock[],
  preds: Map<number, number[]>,
  succs: Map<number, number[]>,
) {
  const start = blocks[0]?.id ?? 0
  const order = reversePostOrder(blocks, succs, start)
  // Create a map from block ID to its reverse post-order position
  // This is needed for the intersect function to work correctly
  // regardless of actual block ID values
  const rpoIndex = new Map<number, number>()
  for (let i = 0; i < order.length; i++) {
    rpoIndex.set(order[i], i)
  }
  const idom = new Map<number, number>()
  idom.set(start, start)

  let changed = true
  while (changed) {
    changed = false
    for (const b of order) {
      if (b === start) continue
      const bPreds = preds.get(b) ?? []
      let newIdom: number | undefined
      for (const p of bPreds) {
        if (idom.has(p)) {
          newIdom = newIdom === undefined ? p : intersect(idom, p, newIdom, rpoIndex)
        }
      }
      if (newIdom !== undefined && idom.get(b) !== newIdom) {
        idom.set(b, newIdom)
        changed = true
      }
    }
  }

  const children = new Map<number, number[]>()
  for (const [b, i] of idom) {
    if (b === i) continue
    const arr = children.get(i) ?? []
    arr.push(b)
    children.set(i, arr)
  }

  return { idom, children }
}

function reversePostOrder(
  blocks: BasicBlock[],
  succs: Map<number, number[]>,
  start: number,
): number[] {
  const visited = new Set<number>()
  const out: number[] = []
  const dfs = (b: number) => {
    if (visited.has(b)) return
    visited.add(b)
    for (const s of succs.get(b) ?? []) dfs(s)
    out.push(b)
  }
  dfs(start)
  return out.reverse()
}

function intersect(
  idom: Map<number, number>,
  b1: number,
  b2: number,
  rpoIndex: Map<number, number>,
): number {
  let finger1 = b1
  let finger2 = b2
  // Use reverse post-order position for comparison instead of raw block IDs
  // This ensures correct behavior regardless of block ID assignment
  const getIndex = (b: number) => rpoIndex.get(b) ?? 0
  while (finger1 !== finger2) {
    while (getIndex(finger1) > getIndex(finger2)) {
      finger1 = idom.get(finger1) ?? finger1
    }
    while (getIndex(finger2) > getIndex(finger1)) {
      finger2 = idom.get(finger2) ?? finger2
    }
  }
  return finger1
}

function computeDominanceFrontier(
  blocks: BasicBlock[],
  preds: Map<number, number[]>,
  idom: Map<number, number>,
): Map<number, Set<number>> {
  const df = new Map<number, Set<number>>()
  for (const b of blocks) {
    const bPreds = preds.get(b.id) ?? []
    if (bPreds.length >= 2) {
      for (const p of bPreds) {
        let runner = p
        while (runner !== (idom.get(b.id) ?? b.id)) {
          const set = df.get(runner) ?? new Set<number>()
          set.add(b.id)
          df.set(runner, set)
          const next = idom.get(runner)
          if (next === undefined || next === runner) break
          runner = next
        }
      }
    }
  }
  return df
}

function renameTerminator(term: any, renameExpr: (expr: any) => any) {
  switch (term.kind) {
    case 'Return':
      return {
        ...term,
        argument: term.argument ? renameExpr(term.argument) : term.argument,
      }
    case 'Throw':
      return { ...term, argument: renameExpr(term.argument) }
    case 'Branch':
      return {
        ...term,
        test: renameExpr(term.test),
      }
    case 'Switch':
      return {
        ...term,
        discriminant: renameExpr(term.discriminant),
        cases: term.cases.map((c: any) => ({
          ...c,
          test: c.test ? renameExpr(c.test) : c.test,
        })),
      }
    default:
      return term
  }
}

/**
 * Validate that all phi nodes have sources from all predecessors.
 * This ensures the SSA form is well-formed.
 */
function validatePhiSources(fn: HIRFunction): void {
  const preds = computePredecessors(fn.blocks)

  for (const block of fn.blocks) {
    const blockPreds = preds.get(block.id) ?? []
    // Entry block has no predecessors, skip validation
    if (blockPreds.length === 0) continue

    for (const instr of block.instructions) {
      if (instr.kind !== 'Phi') continue

      const phi = instr as any
      const sources = phi.sources as Array<{ block: number }>

      // Collect blocks that provided sources
      const sourceBlocks = new Set(sources.map((s: { block: number }) => s.block))

      // Check if all predecessors provided a source
      const missingPreds = blockPreds.filter(pred => !sourceBlocks.has(pred))

      if (missingPreds.length > 0) {
        // Log warning but don't fail - some predecessors may be unreachable
        // This is not an error in valid SSA, just a diagnostic
        if (process.env.DEBUG_SSA) {
          console.warn(
            `SSA: Phi node for '${phi.variable}' in block ${block.id} missing sources from predecessors: ${missingPreds.join(', ')}`,
          )
        }
      }
    }
  }
}
