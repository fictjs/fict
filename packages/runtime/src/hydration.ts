interface HydrationContext {
  cursor: Node | null
  boundary: Node | null
  owner: Document
  parent: ParentNode & Node
  pendingRepair?: HydrationRepairPlan | undefined
  onIssue?: HydrationIssueHandler | undefined
  strictHydration?: boolean | undefined
}

export type HydrationIssueCode =
  | 'node_missing'
  | 'node_extra'
  | 'node_type_mismatch'
  | 'scope_type_mismatch'
  | 'text_mismatch'

export interface HydrationIssue {
  code: HydrationIssueCode
  message: string
  expected?: string
  actual?: string
  node?: Node | null
}

export type HydrationIssueHandler = (issue: HydrationIssue) => void

export interface HydrationOptions {
  onHydrationIssue?: HydrationIssueHandler | undefined
  strictHydration?: boolean | undefined
}

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

const hydrationStack: HydrationContext[] = []
let hydrationClaimSuppressionDepth = 0
const HYDRATED_FRAGMENT_NODES = Symbol.for('fict:hydration-fragment-nodes')

type HydratedFragment = DocumentFragment & { [HYDRATED_FRAGMENT_NODES]?: Node[] }

interface HydrationRepairPlan {
  parent: ParentNode & Node
  nodes: Node[]
  anchor: Node | null
  offset: number
}

export function withHydration<T>(
  root: ParentNode & Node,
  fn: () => T,
  options: HydrationOptions = {},
): T {
  const owner = root.ownerDocument ?? document
  const context: HydrationContext = {
    cursor: root.firstChild,
    boundary: null,
    owner,
    parent: root,
    onIssue: options.onHydrationIssue,
    strictHydration: options.strictHydration,
  }
  hydrationStack.push(context)
  let completed = false
  try {
    const result = fn()
    completed = true
    return result
  } finally {
    try {
      if (completed) removeExtraHydrationNodes(context)
    } finally {
      hydrationStack.pop()
    }
  }
}

export function withHydrationRange<T>(
  start: Node | null,
  end: Node | null,
  owner: Document,
  fn: () => T,
  options: HydrationOptions = {},
): T {
  const parent = hydrationStack[hydrationStack.length - 1]
  const rangeParent =
    ((end?.parentNode ?? start?.parentNode ?? parent?.parent) as (ParentNode & Node) | null) ??
    owner.createDocumentFragment()
  const context: HydrationContext = {
    cursor: start,
    boundary: end,
    owner,
    parent: rangeParent,
    onIssue: options.onHydrationIssue ?? parent?.onIssue,
    strictHydration: options.strictHydration ?? parent?.strictHydration,
  }
  hydrationStack.push(context)
  let completed = false
  try {
    const result = fn()
    completed = true
    return result
  } finally {
    try {
      if (completed) removeExtraHydrationNodes(context)
    } finally {
      hydrationStack.pop()
    }
  }
}

export function claimNodes(templateRoot: Node, fallback: () => Node): Node {
  const ctx = hydrationStack[hydrationStack.length - 1]
  if (!ctx || hydrationClaimSuppressionDepth > 0) {
    return fallback()
  }
  if (ctx.pendingRepair) {
    const repair = ctx.pendingRepair
    const fallbackNode = fallback()
    ctx.pendingRepair = undefined
    return mountFallback(ctx, fallbackNode, repair)
  }
  if (!ctx.cursor) {
    const repair = captureHydrationRepairPlan(ctx, null, 0)
    emitHydrationIssue(ctx, {
      code: 'node_missing',
      message: '[fict/hydration] Missing DOM node while claiming hydrated template output.',
      expected: describeNode(templateRoot),
      actual: null,
      node: null,
    })
    return mountFallback(ctx, fallback(), repair)
  }

  const count = templateRoot.nodeType === 11 ? templateRoot.childNodes.length : 1
  if (count === 0) return fallback()

  const claimed: Node[] = []
  let cursor: Node | null = ctx.cursor
  for (let i = 0; i < count; i++) {
    const expected = templateRoot.nodeType === 11 ? templateRoot.childNodes.item(i) : templateRoot
    if (!cursor || cursor === ctx.boundary) {
      const repair = captureHydrationRepairPlan(ctx, claimed[0] ?? null, claimed.length)
      emitHydrationIssue(ctx, {
        code: 'node_missing',
        message: '[fict/hydration] Hydrated DOM ended before the expected template output.',
        expected: expected ? describeNode(expected) : describeNode(templateRoot),
        actual: null,
        node: null,
      })
      return mountFallback(ctx, fallback(), repair)
    }
    if (expected && !isCompatibleNode(expected, cursor)) {
      const repair = captureHydrationRepairPlan(ctx, claimed[0] ?? cursor, count)
      emitHydrationIssue(ctx, {
        code: 'node_type_mismatch',
        message: '[fict/hydration] Hydrated DOM node does not match the expected template node.',
        expected: describeNode(expected),
        actual: describeNode(cursor),
        node: cursor,
      })
      return mountFallback(ctx, fallback(), repair)
    }
    claimed.push(cursor)
    cursor = cursor.nextSibling
  }

  ctx.cursor = cursor

  if (claimed.length === 1) {
    return claimed[0]!
  }

  return createHydratedFragment(ctx.owner, claimed)
}

export function claimText(value: string, fallback: () => Text): Text {
  const ctx = hydrationStack[hydrationStack.length - 1]
  if (!ctx || hydrationClaimSuppressionDepth > 0) {
    return fallback()
  }
  if (ctx.pendingRepair) {
    const repair = ctx.pendingRepair
    const fallbackNode = fallback()
    ctx.pendingRepair = undefined
    return mountFallback(ctx, fallbackNode, repair) as Text
  }
  if (!ctx.cursor || ctx.cursor === ctx.boundary) {
    const repair = captureHydrationRepairPlan(ctx, null, 0)
    emitHydrationIssue(ctx, {
      code: 'node_missing',
      message: '[fict/hydration] Missing text node while hydrating.',
      expected: '#text',
      actual: null,
      node: null,
    })
    return mountFallback(ctx, fallback(), repair) as Text
  }
  if (ctx.cursor.nodeType !== 3) {
    const repair = captureHydrationRepairPlan(ctx, ctx.cursor, 1)
    emitHydrationIssue(ctx, {
      code: 'node_type_mismatch',
      message: '[fict/hydration] Hydrated DOM node is not a text node.',
      expected: '#text',
      actual: describeNode(ctx.cursor),
      node: ctx.cursor,
    })
    return mountFallback(ctx, fallback(), repair) as Text
  }

  const text = ctx.cursor as Text
  if (text.data !== value) {
    const repair = captureHydrationRepairPlan(ctx, text, 1)
    emitHydrationIssue(ctx, {
      code: 'text_mismatch',
      message: '[fict/hydration] Hydrated text content does not match client output.',
      expected: value,
      actual: text.data,
      node: text,
    })
    if (text.parentNode !== repair.parent || text.nextSibling !== repair.anchor) {
      return mountFallback(ctx, ctx.owner.createTextNode(value), repair) as Text
    }
    text.data = value
    ctx.cursor = repair.anchor
    return text
  }
  ctx.cursor = text.nextSibling
  return text
}

/**
 * Claim a nested resumable component host without hydrating its descendants.
 *
 * Parent scopes and child scopes resume independently. When a parent resumes,
 * a child host in its hydration range therefore belongs to a different root
 * and must remain opaque. Only internal hosts with a non-empty scope id, an
 * independent resume entry, and an exact component identity match are
 * claimable; a different identity is a hydration mismatch and falls back to
 * the normal replacement path.
 */
export function claimResumableScopeHost(expectedType: string): Element | null {
  const ctx = hydrationStack[hydrationStack.length - 1]
  if (hydrationClaimSuppressionDepth > 0) {
    return null
  }
  if (ctx?.pendingRepair) {
    return null
  }
  const cursor = ctx?.cursor
  if (!ctx || !cursor || cursor === ctx.boundary || cursor.nodeType !== 1) {
    return null
  }

  const host = cursor as Element
  if (
    host.localName.toLowerCase() !== 'fict-host' ||
    !host.hasAttribute('data-fict-host') ||
    !host.getAttribute('data-fict-s') ||
    !host.getAttribute('data-fict-h')
  ) {
    return null
  }

  const actualType = host.getAttribute('data-fict-t')
  if (actualType !== expectedType) {
    const repair = captureHydrationRepairPlan(ctx, host, 1)
    emitHydrationIssue(ctx, {
      code: 'scope_type_mismatch',
      message:
        '[fict/hydration] Resumable scope host does not match the expected component identity.',
      expected: expectedType,
      actual: actualType ?? '<missing>',
      node: host,
    })
    ctx.pendingRepair = repair
    return null
  }

  ctx.cursor = host.nextSibling
  return host
}

export function isHydratingActive(): boolean {
  return hydrationStack.length > 0 && hydrationClaimSuppressionDepth === 0
}

/** @internal Complete a scope-mismatch repair at the component invocation boundary. */
export function getPendingHydrationRepairToken(): object | null {
  return hydrationStack[hydrationStack.length - 1]?.pendingRepair ?? null
}

/** @internal Build a mismatched component subtree without claiming nodes from its server host. */
export function suppressHydrationClaimsForPendingRepair(token: object | null): () => void {
  const ctx = hydrationStack[hydrationStack.length - 1]
  if (!ctx || !token || ctx.pendingRepair !== token) return () => {}

  hydrationClaimSuppressionDepth += 1
  let restored = false
  return () => {
    if (restored) return
    restored = true
    hydrationClaimSuppressionDepth = Math.max(0, hydrationClaimSuppressionDepth - 1)
  }
}

/** @internal */
export function finalizePendingHydrationRepair(token: object | null, fallbackNode: Node): Node {
  const ctx = hydrationStack[hydrationStack.length - 1]
  if (!ctx || !token || ctx.pendingRepair !== token) return fallbackNode

  const repair = ctx.pendingRepair
  ctx.pendingRepair = undefined
  return mountFallback(ctx, fallbackNode, repair)
}

/** @internal Preserve the server range while a mismatched component is suspended. */
export function abandonPendingHydrationRepair(token: object | null): void {
  const ctx = hydrationStack[hydrationStack.length - 1]
  if (!ctx || !token || ctx.pendingRepair !== token) return

  const repair = ctx.pendingRepair
  ctx.pendingRepair = undefined
  if (repair.anchor?.parentNode === repair.parent) {
    ctx.cursor = repair.anchor
    return
  }
  for (let index = repair.nodes.length - 1; index >= 0; index -= 1) {
    const node = repair.nodes[index]!
    if (node.parentNode === repair.parent) {
      ctx.cursor = node.nextSibling
      return
    }
  }
  ctx.cursor = repair.parent.childNodes.item(
    Math.min(repair.offset, repair.parent.childNodes.length),
  )
}

function removeExtraHydrationNodes(ctx: HydrationContext): void {
  if (ctx.pendingRepair) {
    const repair = ctx.pendingRepair
    ctx.pendingRepair = undefined
    removeRepairNodes(repair)
    ctx.cursor =
      repair.anchor?.parentNode === repair.parent
        ? repair.anchor
        : repair.parent.childNodes.item(Math.min(repair.offset, repair.parent.childNodes.length))
  }
  if (!ctx.cursor || ctx.cursor === ctx.boundary) return

  const repair = captureHydrationRepairPlan(ctx, ctx.cursor, Number.POSITIVE_INFINITY)

  emitHydrationIssue(ctx, {
    code: 'node_extra',
    message: '[fict/hydration] Hydrated DOM contains extra server-rendered nodes.',
    actual: describeNode(ctx.cursor),
    node: ctx.cursor,
  })

  removeRepairNodes(repair)
  ctx.cursor = ctx.boundary
}

function mountFallback(
  ctx: HydrationContext,
  fallbackNode: Node,
  repair: HydrationRepairPlan,
): Node {
  const fallbackFragmentNodes =
    fallbackNode.nodeType === 11 ? Array.from(fallbackNode.childNodes) : null

  removeRepairNodes(repair)

  const anchor =
    repair.anchor?.parentNode === repair.parent
      ? repair.anchor
      : repair.parent.childNodes.item(Math.min(repair.offset, repair.parent.childNodes.length))
  repair.parent.insertBefore(fallbackNode, anchor)
  ctx.cursor = anchor
  if (fallbackFragmentNodes) {
    return createHydratedFragment(ctx.owner, fallbackFragmentNodes)
  }
  return fallbackNode
}

function removeRepairNodes(repair: HydrationRepairPlan): void {
  for (const node of repair.nodes) {
    if (node.parentNode === repair.parent) {
      repair.parent.removeChild(node)
    }
  }
}

function captureHydrationRepairPlan(
  ctx: HydrationContext,
  replaceStart: Node | null,
  removeCount: number,
): HydrationRepairPlan {
  const parent =
    ((replaceStart?.parentNode ?? ctx.boundary?.parentNode ?? ctx.parent) as
      | (ParentNode & Node)
      | null) ?? ctx.parent
  const offset = replaceStart
    ? childOffset(parent, replaceStart)
    : ctx.boundary?.parentNode === parent
      ? childOffset(parent, ctx.boundary)
      : parent.childNodes.length
  const nodes: Node[] = []
  let cursor = replaceStart
  while (cursor && cursor !== ctx.boundary && nodes.length < removeCount) {
    nodes.push(cursor)
    cursor = cursor.nextSibling
  }
  return {
    parent,
    nodes,
    anchor: replaceStart ? cursor : ctx.boundary,
    offset: offset < 0 ? parent.childNodes.length : offset,
  }
}

function childOffset(parent: ParentNode, node: Node): number {
  let offset = 0
  for (let cursor = parent.firstChild; cursor; cursor = cursor.nextSibling) {
    if (cursor === node) return offset
    offset += 1
  }
  return -1
}

function createHydratedFragment(owner: Document, nodes: Node[]): DocumentFragment {
  const fragment = owner.createDocumentFragment() as HydratedFragment
  Object.defineProperty(fragment, HYDRATED_FRAGMENT_NODES, {
    configurable: true,
    value: nodes,
  })
  return fragment
}

function emitHydrationIssue(
  ctx: HydrationContext,
  issue: Omit<HydrationIssue, 'actual'> & { actual?: string | null },
): void {
  const normalized: HydrationIssue = {
    code: issue.code,
    message: issue.message,
  }
  if (issue.expected !== undefined) {
    normalized.expected = issue.expected
  }
  if (issue.actual !== undefined && issue.actual !== null) {
    normalized.actual = issue.actual
  }
  if (issue.node !== undefined) {
    normalized.node = issue.node
  }
  ctx.onIssue?.(normalized)
  if (isDev && typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(normalized.message)
  }
  if (ctx.strictHydration) {
    const error = new Error(normalized.message) as Error & { issue?: HydrationIssue }
    error.issue = normalized
    throw error
  }
}

function isCompatibleNode(expected: Node, actual: Node): boolean {
  if (expected.nodeType !== actual.nodeType) return false
  if (expected.nodeType === 1 && actual.nodeType === 1) {
    return (expected as Element).tagName === (actual as Element).tagName
  }
  return true
}

function describeNode(node: Node): string {
  if (node.nodeType === 3) return '#text'
  if (node.nodeType === 8) return '#comment'
  if (node.nodeType === 11) return '#fragment'
  if (node.nodeType === 1) {
    return (node as Element).tagName.toLowerCase()
  }
  return `node:${node.nodeType}`
}
