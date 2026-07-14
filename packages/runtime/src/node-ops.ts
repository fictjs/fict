/**
 * Low-level DOM node helpers shared across runtime modules.
 * Keep this file dependency-free to avoid module cycles.
 */

import { isDocumentFragmentLike, isNodeLike } from './dom-guards'
import { HYDRATED_TEMPLATE_NODE } from './hydration'

const HYDRATED_FRAGMENT_NODES = Symbol.for('fict:hydration-fragment-nodes')
const DOCUMENT_FRAGMENT_NODE = 11

type HydratedFragment = DocumentFragment & { [HYDRATED_FRAGMENT_NODES]?: Node[] }
type HydratedTemplateNode = Node & { [HYDRATED_TEMPLATE_NODE]?: Node }

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
        if (!isNodeLike(item, ownerDocument)) {
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

  if (isNodeLike(node, ownerDocument)) {
    try {
      if (isDocumentFragmentLike(node, ownerDocument)) {
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
): Node[] {
  if (nodes.length === 0) return []

  const doc = parent.ownerDocument
  const insertSingle = (nodeToInsert: Node, anchorNode: Node | null): Node => {
    if (nodeToInsert.ownerDocument !== doc && doc) {
      doc.adoptNode(nodeToInsert)
    }
    try {
      parent.insertBefore(nodeToInsert, anchorNode)
      return nodeToInsert
    } catch (e: unknown) {
      if (doc) {
        try {
          const clone = doc.importNode(nodeToInsert, true)
          parent.insertBefore(clone, anchorNode)
          return clone
        } catch {
          // Clone fallback failed
        }
      }
      throw e
    }
  }

  // Single node optimization - direct insertion
  if (nodes.length === 1) {
    const node = nodes[0]!
    if (node === undefined || node === null) return []
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      return insertNodesBefore(parent, getFragmentChildNodes(node), anchor)
    }
    return [insertSingle(node, anchor)]
  }

  // Batch insertion using DocumentFragment for multiple nodes
  if (doc) {
    const frag = doc.createDocumentFragment()
    const insertedNodes: Node[] = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      if (node === undefined || node === null) continue
      // Handle DocumentFragment - append children
      if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
        const childrenArr = getFragmentChildNodes(node)
        for (let j = 0; j < childrenArr.length; j++) {
          const child = childrenArr[j]!
          frag.appendChild(child)
          insertedNodes.push(child)
        }
      } else {
        if (node.ownerDocument !== doc) {
          doc.adoptNode(node)
        }
        frag.appendChild(node)
        insertedNodes.push(node)
      }
    }
    parent.insertBefore(frag, anchor)
    return insertedNodes
  }

  // Fallback for non-document contexts (rare)
  const insertedNodes: Node[] = []
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
        insertedNodes.unshift(anchor)
      }
    } else {
      anchor = insertSingle(node, anchor)
      insertedNodes.unshift(anchor)
    }
  }

  return insertedNodes
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
  let expected: Node | null = (root as HydratedTemplateNode)[HYDRATED_TEMPLATE_NODE] ?? null
  for (const index of path) {
    if (!current) return null
    current = expected
      ? getHydratedChildAtPathIndex(current, expected, index)
      : getChildAtPathIndex(current, index)
    expected = expected ? getChildAtPathIndex(expected, index) : null
    if (!current) {
      return null
    }
  }
  return current
}

function getHydratedChildAtPathIndex(current: Node, expected: Node, index: number): Node | null {
  const actualChildren = getLogicalChildren(current)
  const expectedChildren = getLogicalChildren(expected)
  let actualIndex = 0
  for (let expectedIndex = 0; expectedIndex <= index; expectedIndex += 1) {
    const expectedChild = expectedChildren[expectedIndex]
    if (!expectedChild) return null
    while (
      actualIndex < actualChildren.length &&
      !isHydrationPathCompatible(expectedChild, actualChildren[actualIndex]!)
    ) {
      actualIndex += 1
    }
    if (actualIndex >= actualChildren.length) return null
    if (expectedIndex === index) {
      return attachHydratedTemplateNode(actualChildren[actualIndex]!, expectedChild)
    }
    actualIndex += 1
  }
  return null
}

function attachHydratedTemplateNode(actual: Node, expected: Node): Node {
  Object.defineProperty(actual as HydratedTemplateNode, HYDRATED_TEMPLATE_NODE, {
    configurable: true,
    value: expected,
  })
  return actual
}

function getLogicalChildren(current: Node): Node[] {
  const childRoot = getTemplateContentRoot(current) ?? current
  const children = getHydratedFragmentNodes(childRoot) ?? Array.from(childRoot.childNodes)
  const logical: Node[] = []
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!
    logical.push(child)
    if (isSlotStart(child)) {
      const endIndex = children.indexOf(getSlotEnd(child as Comment), index + 1)
      if (endIndex !== -1) index = endIndex
    }
  }
  return logical
}

function isHydrationPathCompatible(expected: Node, actual: Node): boolean {
  if (expected.nodeType !== actual.nodeType) return false
  if (expected.nodeType === 1) {
    return (
      (expected as Element).localName === (actual as Element).localName &&
      (expected as Element).namespaceURI === (actual as Element).namespaceURI
    )
  }
  if (expected.nodeType === 8) {
    return (expected as Comment).data === (actual as Comment).data
  }
  return true
}

function getChildAtPathIndex(current: Node, index: number): Node | null {
  const childRoot = getTemplateContentRoot(current) ?? current
  const hydratedNodes = getHydratedFragmentNodes(childRoot)
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

  let child: Node | null = childRoot.firstChild
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

function getTemplateContentRoot(current: Node): DocumentFragment | null {
  if (current.nodeType !== 1) return null
  const element = current as Element & { content?: DocumentFragment }
  const content = element.localName === 'template' ? element.content : undefined
  return content?.nodeType === DOCUMENT_FRAGMENT_NODE ? content : null
}
