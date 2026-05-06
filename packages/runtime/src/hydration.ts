interface HydrationContext {
  cursor: Node | null
  boundary: Node | null
  owner: Document
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
  hydrationStack.push({
    cursor: start,
    boundary: end,
    owner,
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
  if (!ctx || !ctx.cursor) {
    if (ctx) {
      emitHydrationIssue(ctx, {
        code: 'node_missing',
        message: '[fict/hydration] Missing DOM node while claiming hydrated template output.',
        expected: describeNode(templateRoot),
        actual: null,
        node: null,
      })
    }
    return fallback()
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
      return fallback()
    }
    if (expected && !isCompatibleNode(expected, cursor)) {
      emitHydrationIssue(ctx, {
        code: 'node_type_mismatch',
        message: '[fict/hydration] Hydrated DOM node does not match the expected template node.',
        expected: describeNode(expected),
        actual: describeNode(cursor),
        node: cursor,
      })
      return fallback()
    }
    claimed.push(cursor)
    cursor = cursor.nextSibling
  }

  ctx.cursor = cursor

  if (claimed.length === 1) {
    return claimed[0]!
  }

  const frag = ctx.owner.createDocumentFragment()
  for (const node of claimed) {
    frag.appendChild(node)
  }
  return frag
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
    return fallback()
  }
  if (ctx.cursor.nodeType !== Node.TEXT_NODE) {
    emitHydrationIssue(ctx, {
      code: 'node_type_mismatch',
      message: '[fict/hydration] Hydrated DOM node is not a text node.',
      expected: '#text',
      actual: describeNode(ctx.cursor),
      node: ctx.cursor,
    })
    return fallback()
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
