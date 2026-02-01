interface HydrationContext {
  cursor: Node | null
  boundary: Node | null
  owner: Document
}

const hydrationStack: HydrationContext[] = []

export function withHydration(root: ParentNode & Node, fn: () => void): void {
  const owner = root.ownerDocument ?? document
  hydrationStack.push({
    cursor: root.firstChild,
    boundary: null,
    owner,
  })
  try {
    fn()
  } finally {
    hydrationStack.pop()
  }
}

export function withHydrationRange(
  start: Node | null,
  end: Node | null,
  owner: Document,
  fn: () => void,
): void {
  hydrationStack.push({
    cursor: start,
    boundary: end,
    owner,
  })
  try {
    fn()
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

export function isHydratingActive(): boolean {
  return hydrationStack.length > 0
}
