interface HydrationContext {
  cursor: Node | null
  boundary: Node | null
  owner: Document
  parent: ParentNode & Node
  onIssue?: HydrationIssueHandler | undefined
}

export type HydrationIssueCode = 'node_missing' | 'node_type_mismatch' | 'text_mismatch'

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
}

const hydrationStack: HydrationContext[] = []
const HYDRATED_FRAGMENT_NODES = Symbol.for('fict:hydration-fragment-nodes')

type HydratedFragment = DocumentFragment & { [HYDRATED_FRAGMENT_NODES]?: Node[] }

export function withHydration<T>(
  root: ParentNode & Node,
  fn: () => T,
  options: HydrationOptions = {},
): T {
  const owner = root.ownerDocument ?? document
  hydrationStack.push({
    cursor: root.firstChild,
    boundary: null,
    owner,
    parent: root,
    onIssue: options.onHydrationIssue,
  })
  try {
    return fn()
  } finally {
    hydrationStack.pop()
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
  hydrationStack.push({
    cursor: start,
    boundary: end,
    owner,
    parent: rangeParent,
    onIssue: options.onHydrationIssue ?? parent?.onIssue,
  })
  try {
    return fn()
  } finally {
    hydrationStack.pop()
  }
}

export function claimNodes(templateRoot: Node, fallback: () => Node): Node {
  const ctx = hydrationStack[hydrationStack.length - 1]
  if (!ctx) {
    return fallback()
  }
  if (!ctx.cursor) {
    emitHydrationIssue(ctx, {
      code: 'node_missing',
      message: '[fict/hydration] Missing DOM node while claiming hydrated template output.',
      expected: describeNode(templateRoot),
      actual: null,
      node: null,
    })
    return mountFallback(ctx, fallback(), null, 0)
  }

  const count = templateRoot.nodeType === 11 ? templateRoot.childNodes.length : 1
  if (count === 0) return fallback()

  const claimed: Node[] = []
  let cursor: Node | null = ctx.cursor
  for (let i = 0; i < count; i++) {
    const expected = templateRoot.nodeType === 11 ? templateRoot.childNodes.item(i) : templateRoot
    if (!cursor || cursor === ctx.boundary) {
      emitHydrationIssue(ctx, {
        code: 'node_missing',
        message: '[fict/hydration] Hydrated DOM ended before the expected template output.',
        expected: expected ? describeNode(expected) : describeNode(templateRoot),
        actual: null,
        node: null,
      })
      return mountFallback(ctx, fallback(), claimed[0] ?? null, claimed.length)
    }
    if (expected && !isCompatibleNode(expected, cursor)) {
      emitHydrationIssue(ctx, {
        code: 'node_type_mismatch',
        message: '[fict/hydration] Hydrated DOM node does not match the expected template node.',
        expected: describeNode(expected),
        actual: describeNode(cursor),
        node: cursor,
      })
      return mountFallback(ctx, fallback(), claimed[0] ?? cursor, count)
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
  if (!ctx) {
    return fallback()
  }
  if (!ctx.cursor || ctx.cursor === ctx.boundary) {
    emitHydrationIssue(ctx, {
      code: 'node_missing',
      message: '[fict/hydration] Missing text node while hydrating.',
      expected: '#text',
      actual: null,
      node: null,
    })
    return mountFallback(ctx, fallback(), null, 0) as Text
  }
  if (ctx.cursor.nodeType !== Node.TEXT_NODE) {
    emitHydrationIssue(ctx, {
      code: 'node_type_mismatch',
      message: '[fict/hydration] Hydrated DOM node is not a text node.',
      expected: '#text',
      actual: describeNode(ctx.cursor),
      node: ctx.cursor,
    })
    return mountFallback(ctx, fallback(), ctx.cursor, 1) as Text
  }

  const text = ctx.cursor as Text
  ctx.cursor = text.nextSibling
  if (text.data !== value) {
    emitHydrationIssue(ctx, {
      code: 'text_mismatch',
      message: '[fict/hydration] Hydrated text content does not match client output.',
      expected: value,
      actual: text.data,
      node: text,
    })
    text.data = value
  }
  return text
}

export function isHydratingActive(): boolean {
  return hydrationStack.length > 0
}

function mountFallback(
  ctx: HydrationContext,
  fallbackNode: Node,
  replaceStart: Node | null,
  removeCount: number,
): Node {
  const fallbackFragmentNodes =
    fallbackNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      ? Array.from(fallbackNode.childNodes)
      : null
  const parent =
    ((replaceStart?.parentNode ?? ctx.boundary?.parentNode ?? ctx.parent) as
      | (ParentNode & Node)
      | null) ?? null
  if (!parent) {
    return fallbackNode
  }

  let cursor = replaceStart
  let removed = 0
  while (cursor && cursor !== ctx.boundary && removed < removeCount) {
    const next = cursor.nextSibling
    parent.removeChild(cursor)
    cursor = next
    removed += 1
  }

  const anchor = replaceStart ? cursor : ctx.boundary
  parent.insertBefore(fallbackNode, anchor)
  ctx.cursor = anchor
  if (fallbackFragmentNodes) {
    return createHydratedFragment(ctx.owner, fallbackFragmentNodes)
  }
  return fallbackNode
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
  if (!ctx.onIssue) return
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
  ctx.onIssue(normalized)
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(normalized.message)
  }
}

function isCompatibleNode(expected: Node, actual: Node): boolean {
  if (expected.nodeType !== actual.nodeType) return false
  if (expected.nodeType === Node.ELEMENT_NODE && actual.nodeType === Node.ELEMENT_NODE) {
    return (expected as Element).tagName === (actual as Element).tagName
  }
  return true
}

function describeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return '#text'
  if (node.nodeType === Node.COMMENT_NODE) return '#comment'
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return '#fragment'
  if (node.nodeType === Node.ELEMENT_NODE) {
    return (node as Element).tagName.toLowerCase()
  }
  return `node:${node.nodeType}`
}
