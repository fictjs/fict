/**
 * Low-level DOM node helpers shared across runtime modules.
 * Keep this file dependency-free to avoid module cycles.
 */

const HYDRATED_FRAGMENT_NODES = Symbol.for('fict:hydration-fragment-nodes')
const DOCUMENT_FRAGMENT_NODE = 11

type HydratedFragment = DocumentFragment & { [HYDRATED_FRAGMENT_NODES]?: Node[] }

function getHydratedFragmentNodes(node: Node): Node[] | undefined {
  if (node.nodeType !== DOCUMENT_FRAGMENT_NODE) return undefined
  const nodes = (node as HydratedFragment)[HYDRATED_FRAGMENT_NODES]
  return Array.isArray(nodes) ? nodes : undefined
}

function getFragmentChildNodes(node: Node): Node[] {
  return getHydratedFragmentNodes(node) ?? Array.from(node.childNodes)
}

/**
 * Convert a value to a flat array of DOM nodes.
 * Defensively handles proxies and non-DOM values.
 */
export function toNodeArray(
  node: Node | Node[] | unknown,
  ownerDocument: Document = document,
): Node[] {
  try {
    if (Array.isArray(node)) {
      // Preserve original array reference when it's already a flat Node array
      let allNodes = true
      for (const item of node) {
        let isItemNode = false
        try {
          isItemNode = item instanceof Node
        } catch {
          isItemNode = false
        }
        if (!isItemNode) {
          allNodes = false
          break
        }
      }
      if (allNodes) {
        return node as Node[]
      }
      const result: Node[] = []
      for (const item of node) {
        result.push(...toNodeArray(item, ownerDocument))
      }
      return result
    }
    if (node === null || node === undefined || node === false) {
      return []
    }
  } catch {
    return []
  }

  let isNode: boolean
  try {
    isNode = node instanceof Node
  } catch {
    // If safe check fails, treat as primitive string
    isNode = false
  }

  if (isNode) {
    try {
      if ((node as Node).nodeType === DOCUMENT_FRAGMENT_NODE) {
        return getFragmentChildNodes(node as Node)
      }
    } catch {
      // Ignore fragment check error
    }
    return [node as Node]
  }

  try {
    // Duck-type BindingHandle-like values
    if (typeof node === 'object' && node !== null && 'marker' in node) {
      return toNodeArray((node as { marker: unknown }).marker, ownerDocument)
    }
  } catch {
    // Ignore property check error
  }

  // Primitive fallback
  try {
    return [ownerDocument.createTextNode(String(node))]
  } catch {
    return [ownerDocument.createTextNode('')]
  }
}

/**
 * Insert nodes before an anchor node, preserving order.
 * Uses DocumentFragment for batch insertion when inserting multiple nodes.
 */
export function insertNodesBefore(
  parent: ParentNode & Node,
  nodes: Node[],
  anchor: Node | null,
): void {
  if (nodes.length === 0) return

  // Single node optimization - direct insertion
  if (nodes.length === 1) {
    const node = nodes[0]!
    if (node === undefined || node === null) return
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      insertNodesBefore(parent, getFragmentChildNodes(node), anchor)
      return
    }
    if (node.ownerDocument !== parent.ownerDocument && parent.ownerDocument) {
      parent.ownerDocument.adoptNode(node)
    }
    try {
      parent.insertBefore(node, anchor)
    } catch (e: unknown) {
      if (parent.ownerDocument) {
        try {
          const clone = parent.ownerDocument.importNode(node, true)
          parent.insertBefore(clone, anchor)
          return
        } catch {
          // Clone fallback failed
        }
      }
      throw e
    }
    return
  }

  // Batch insertion using DocumentFragment for multiple nodes
  const doc = parent.ownerDocument
  if (doc) {
    const frag = doc.createDocumentFragment()
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      if (node === undefined || node === null) continue
      // Handle DocumentFragment - append children
      if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
        const childrenArr = getFragmentChildNodes(node)
        for (let j = 0; j < childrenArr.length; j++) {
          frag.appendChild(childrenArr[j]!)
        }
      } else {
        if (node.ownerDocument !== doc) {
          doc.adoptNode(node)
        }
        frag.appendChild(node)
      }
    }
    parent.insertBefore(frag, anchor)
    return
  }

  // Fallback for non-document contexts (rare)
  const insertSingle = (nodeToInsert: Node, anchorNode: Node | null): Node => {
    if (nodeToInsert.ownerDocument !== parent.ownerDocument && parent.ownerDocument) {
      parent.ownerDocument.adoptNode(nodeToInsert)
    }
    try {
      parent.insertBefore(nodeToInsert, anchorNode)
      return nodeToInsert
    } catch (e: unknown) {
      if (parent.ownerDocument) {
        try {
          const clone = parent.ownerDocument.importNode(nodeToInsert, true)
          parent.insertBefore(clone, anchorNode)
          return clone
        } catch {
          // Clone fallback failed
        }
      }
      throw e
    }
  }

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    if (node === undefined || node === null) continue

    // Handle DocumentFragment - insert children in reverse order
    const isFrag = node.nodeType === DOCUMENT_FRAGMENT_NODE
    if (isFrag) {
      const childrenArr = getFragmentChildNodes(node)
      for (let j = childrenArr.length - 1; j >= 0; j--) {
        const child = childrenArr[j]!
        anchor = insertSingle(child, anchor)
      }
    } else {
      anchor = insertSingle(node, anchor)
    }
  }
}

/**
 * Remove an array of nodes from the DOM.
 */
export function removeNodes(nodes: Node[]): void {
  for (const node of nodes) {
    node.parentNode?.removeChild(node)
  }
}

const SLOT_START = 'fict:slot:start'
const SLOT_END = 'fict:slot:end'

function isSlotStart(node: Node | null): node is Comment {
  return !!(node && node.nodeType === 8 && (node as Comment).data === SLOT_START)
}

function isSlotEnd(node: Node | null): node is Comment {
  return !!(node && node.nodeType === 8 && (node as Comment).data === SLOT_END)
}

export function getSlotEnd(start: Comment): Comment {
  let depth = 1
  let cursor: Node | null = start.nextSibling
  while (cursor) {
    if (isSlotStart(cursor)) {
      depth++
    } else if (isSlotEnd(cursor)) {
      depth--
      if (depth === 0) {
        return cursor
      }
    }
    cursor = cursor.nextSibling
  }

  const owner = start.ownerDocument ?? document
  const end = owner.createComment(SLOT_END)
  if (start.parentNode) {
    start.parentNode.insertBefore(end, start.nextSibling)
  }
  return end
}

export function resolvePath(root: Node, path: number[]): Node | null {
  let current: Node | null = root
  for (const index of path) {
    if (!current) return null
    current = getChildAtPathIndex(current, index)
    if (!current) {
      return null
    }
  }
  return current
}

function getChildAtPathIndex(current: Node, index: number): Node | null {
  const hydratedNodes = getHydratedFragmentNodes(current)
  if (hydratedNodes) {
    let currentIndex = 0
    for (let offset = 0; offset < hydratedNodes.length; offset += 1) {
      const child = hydratedNodes[offset]!
      if (isSlotStart(child)) {
        if (currentIndex === index) return child
        const end = getSlotEnd(child)
        const endOffset = hydratedNodes.indexOf(end, offset + 1)
        if (endOffset !== -1) {
          offset = endOffset
        }
        currentIndex += 1
        continue
      }
      if (currentIndex === index) return child
      currentIndex += 1
    }
    return null
  }

  let child: Node | null = current.firstChild
  let currentIndex = 0
  while (child) {
    if (isSlotStart(child)) {
      if (currentIndex === index) return child
      const end = getSlotEnd(child as Comment)
      child = end.nextSibling
      currentIndex++
      continue
    }
    if (currentIndex === index) return child
    currentIndex++
    child = child.nextSibling
  }
  return null
}
