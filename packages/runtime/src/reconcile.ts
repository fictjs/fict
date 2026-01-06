/**
 * Fict DOM Reconciliation
 *
 * Efficient array reconciliation algorithm based on udomdiff.
 * https://github.com/WebReflection/udomdiff
 *
 * This algorithm uses a 5-step strategy:
 * 1. Common prefix - skip matching nodes at start
 * 2. Common suffix - skip matching nodes at end
 * 3. Append - insert remaining new nodes
 * 4. Remove - remove remaining old nodes
 * 5. Swap/Map fallback - handle complex rearrangements
 *
 * Most real-world updates (95%+) use fast paths without building a Map.
 */

/**
 * Reconcile two arrays of DOM nodes, efficiently updating the DOM.
 *
 * @param parentNode - The parent element containing the nodes
 * @param a - The old array of nodes (currently in DOM)
 * @param b - The new array of nodes (target state)
 *
 * **Note:** This function may mutate the input array `a` during the swap
 * optimization (step 5a). If you need to preserve the original array,
 * pass a shallow copy: `reconcileArrays(parent, [...oldNodes], newNodes)`.
 *
 * @example
 * ```ts
 * const oldNodes = [node1, node2, node3]
 * const newNodes = [node1, node4, node3]  // node2 replaced with node4
 * reconcileArrays(parent, oldNodes, newNodes)
 * ```
 */
export default function reconcileArrays(parentNode: ParentNode, a: Node[], b: Node[]): void {
  const bLength = b.length
  let aEnd = a.length
  let bEnd = bLength
  let aStart = 0
  let bStart = 0
  const after = aEnd > 0 ? a[aEnd - 1]!.nextSibling : null
  let map: Map<Node, number> | null = null

  while (aStart < aEnd || bStart < bEnd) {
    // 1. Common prefix - nodes match at start
    if (a[aStart] === b[bStart]) {
      aStart++
      bStart++
      continue
    }

    // 2. Common suffix - nodes match at end
    while (a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--
      bEnd--
    }

    // 3. Append - old array exhausted, insert remaining new nodes
    if (aEnd === aStart) {
      const node: Node | null =
        bEnd < bLength ? (bStart ? b[bStart - 1]!.nextSibling : (b[bEnd - bStart] ?? null)) : after

      const count = bEnd - bStart
      const doc = (parentNode as Node).ownerDocument
      if (count > 1 && doc) {
        const frag = doc.createDocumentFragment()
        for (let i = bStart; i < bEnd; i++) {
          frag.appendChild(b[i]!)
        }
        parentNode.insertBefore(frag, node)
        bStart = bEnd
      } else {
        while (bStart < bEnd) {
          parentNode.insertBefore(b[bStart++]!, node)
        }
      }
    }
    // 4. Remove - new array exhausted, remove remaining old nodes
    else if (bEnd === bStart) {
      while (aStart < aEnd) {
        const nodeToRemove = a[aStart]!
        if (!map || !map.has(nodeToRemove)) {
          nodeToRemove.parentNode?.removeChild(nodeToRemove)
        }
        aStart++
      }
    }
    // 5a. Swap backward - detect backward swap pattern
    else if (a[aStart] === b[bEnd - 1] && b[bStart] === a[aEnd - 1]) {
      const node = a[--aEnd]!.nextSibling
      parentNode.insertBefore(b[bStart++]!, a[aStart++]!.nextSibling)
      parentNode.insertBefore(b[--bEnd]!, node)
      // Update reference in old array for potential future matches
      a[aEnd] = b[bEnd]!
    }
    // 5b. Map fallback - use Map for complex rearrangements
    else {
      // Build map on first use (lazy initialization)
      if (!map) {
        map = new Map()
        let i = bStart
        while (i < bEnd) {
          map.set(b[i]!, i++)
        }
      }

      const index = map.get(a[aStart]!)

      if (index != null) {
        if (bStart < index && index < bEnd) {
          // Check for longest increasing subsequence
          let i = aStart
          let sequence = 1
          let t: number | undefined

          while (++i < aEnd && i < bEnd) {
            t = map.get(a[i]!)
            if (t == null || t !== index + sequence) break
            sequence++
          }

          // Use optimal strategy based on sequence length
          if (sequence > index - bStart) {
            // Sequence is long enough - insert nodes before current
            const node = a[aStart]!
            while (bStart < index) {
              parentNode.insertBefore(b[bStart++]!, node)
            }
          } else {
            // Short sequence - replace
            parentNode.replaceChild(b[bStart++]!, a[aStart++]!)
          }
        } else {
          aStart++
        }
      } else {
        // Node not in new array - remove it
        const nodeToRemove = a[aStart++]!
        nodeToRemove.parentNode?.removeChild(nodeToRemove)
      }
    }
  }
}

/**
 * Simple reconciliation for keyed lists.
 * Uses the same algorithm but works with keyed blocks.
 *
 * @param parentNode - The parent element
 * @param oldNodes - Old nodes in DOM order
 * @param newNodes - New nodes in target order
 */
export function reconcileNodes(parentNode: ParentNode, oldNodes: Node[], newNodes: Node[]): void {
  reconcileArrays(parentNode, oldNodes, newNodes)
}
