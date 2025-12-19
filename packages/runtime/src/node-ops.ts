/**
 * Low-level DOM node helpers shared across runtime modules.
 * Keep this file dependency-free to avoid module cycles.
 */

/**
 * Convert a value to a flat array of DOM nodes.
 * Defensively handles proxies and non-DOM values.
 */
export function toNodeArray(node: Node | Node[] | unknown): Node[] {
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
        result.push(...toNodeArray(item))
      }
      return result
    }
    if (node === null || node === undefined || node === false) {
      return []
    }
  } catch {
    return []
  }

  let isNode = false
  try {
    isNode = node instanceof Node
  } catch {
    // If safe check fails, treat as primitive string
    isNode = false
  }

  if (isNode) {
    try {
      if (node instanceof DocumentFragment) {
        return Array.from(node.childNodes)
      }
    } catch {
      // Ignore fragment check error
    }
    return [node as Node]
  }

  try {
    // Duck-type BindingHandle-like values
    if (typeof node === 'object' && node !== null && 'marker' in node) {
      return toNodeArray((node as { marker: unknown }).marker)
    }
  } catch {
    // Ignore property check error
  }

  // Primitive fallback
  try {
    return [document.createTextNode(String(node))]
  } catch {
    return [document.createTextNode('')]
  }
}

/**
 * Insert nodes before an anchor node, preserving order.
 */
export function insertNodesBefore(
  parent: ParentNode & Node,
  nodes: Node[],
  anchor: Node | null,
): void {
  const insertSingle = (nodeToInsert: Node, anchorNode: Node | null): Node => {
    if (nodeToInsert.ownerDocument !== parent.ownerDocument && parent.ownerDocument) {
      parent.ownerDocument.adoptNode(nodeToInsert)
    }
    try {
      parent.insertBefore(nodeToInsert, anchorNode)
      return nodeToInsert
    } catch (e: any) {
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
    const isFrag = node.nodeType === 11
    if (isFrag) {
      const childrenArr = Array.from(node.childNodes)
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
