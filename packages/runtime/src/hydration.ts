interface HydrationContext {
  cursor: Node | null
  boundary: Node | null
  owner: Document
}

const hydrationStack: HydrationContext[] = []

export function withHydration<T>(root: ParentNode & Node, fn: () => T): T {
  const owner = root.ownerDocument ?? document
  hydrationStack.push({
    cursor: root.firstChild,
    boundary: null,
    owner,
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
): T {
  hydrationStack.push({
    cursor: start,
    boundary: end,
    owner,
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
    return fallback()
  }

  const count = templateRoot.nodeType === 11 ? templateRoot.childNodes.length : 1
  if (count === 0) return fallback()

  const claimed: Node[] = []
  let cursor: Node | null = ctx.cursor
  for (let i = 0; i < count; i++) {
    if (!cursor || cursor === ctx.boundary) {
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
  if (
    !ctx ||
    !ctx.cursor ||
    ctx.cursor === ctx.boundary ||
    ctx.cursor.nodeType !== Node.TEXT_NODE
  ) {
    return fallback()
  }

  const text = ctx.cursor as Text
  ctx.cursor = text.nextSibling
  if (text.data !== value) {
    text.data = value
  }
  return text
}

export function isHydratingActive(): boolean {
  return hydrationStack.length > 0
}
