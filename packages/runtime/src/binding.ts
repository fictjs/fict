/**
 * Fict Reactive DOM Binding System
 *
 * This module provides the core mechanisms for reactive DOM updates.
 * It bridges the gap between Fict's reactive system (signals, effects)
 * and the DOM, enabling fine-grained updates without a virtual DOM.
 *
 * Design Philosophy:
 * - Values wrapped in functions `() => T` are treated as reactive
 * - Static values are applied once without tracking
 * - The compiler transforms JSX expressions to use these primitives
 */

import { createEffect } from './effect'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  pushRoot,
  popRoot,
  type RootContext,
} from './lifecycle'
import type { Cleanup, FictNode } from './types'

// ============================================================================
// Type Definitions
// ============================================================================

/** A reactive value that can be either static or a getter function */
export type MaybeReactive<T> = T | (() => T)

/** Internal type for createElement function reference */
export type CreateElementFn = (node: FictNode) => Node

/** Handle returned by conditional/list bindings for cleanup */
export interface BindingHandle {
  /** Marker node used for positioning (may be a fragment for complex bindings) */
  marker: Comment | DocumentFragment
  /** Dispose function to clean up the binding */
  dispose: Cleanup
}

/** Managed child node with its dispose function */
interface ManagedBlock {
  nodes: Node[]
  root: RootContext
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a value is reactive (a getter function)
 * Note: Event handlers (functions that take arguments) are NOT reactive values
 */
export function isReactive(value: unknown): value is () => unknown {
  return typeof value === 'function' && value.length === 0
}

/**
 * Unwrap a potentially reactive value to get the actual value
 */
export function unwrap<T>(value: MaybeReactive<T>): T {
  return isReactive(value) ? (value as () => T)() : value
}

// ============================================================================
// Text Binding
// ============================================================================

/**
 * Create a text node that reactively updates when the value changes.
 *
 * @example
 * ```ts
 * // Static text
 * createTextBinding("Hello")
 *
 * // Reactive text (compiler output)
 * createTextBinding(() => $count())
 * ```
 */
export function createTextBinding(value: MaybeReactive<unknown>): Text {
  const text = document.createTextNode('')

  if (isReactive(value)) {
    // Reactive: create effect to update text when value changes
    createEffect(() => {
      const v = (value as () => unknown)()
      text.data = formatTextValue(v)
    })
  } else {
    // Static: set once
    text.data = formatTextValue(value)
  }

  return text
}

/**
 * Bind a reactive value to an existing text node.
 * This is a convenience function for binding to existing DOM nodes.
 */
export function bindText(textNode: Text, getValue: () => unknown): Cleanup {
  return createEffect(() => {
    textNode.data = formatTextValue(getValue())
  })
}

/**
 * Format a value for text content
 */
function formatTextValue(value: unknown): string {
  if (value == null || value === false) {
    return ''
  }
  return String(value)
}

// ============================================================================
// Attribute Binding
// ============================================================================

/** Attribute setter function type */
export type AttributeSetter = (el: HTMLElement, key: string, value: unknown) => void

/**
 * Create a reactive attribute binding on an element.
 *
 * @example
 * ```ts
 * // Static attribute
 * createAttributeBinding(button, 'disabled', false, setAttribute)
 *
 * // Reactive attribute (compiler output)
 * createAttributeBinding(button, 'disabled', () => !$isValid(), setAttribute)
 * ```
 */
export function createAttributeBinding(
  el: HTMLElement,
  key: string,
  value: MaybeReactive<unknown>,
  setter: AttributeSetter,
): void {
  if (isReactive(value)) {
    // Reactive: create effect to update attribute when value changes
    createEffect(() => {
      setter(el, key, (value as () => unknown)())
    })
  } else {
    // Static: set once
    setter(el, key, value)
  }
}

/**
 * Bind a reactive value to an element's attribute.
 */
export function bindAttribute(el: HTMLElement, key: string, getValue: () => unknown): Cleanup {
  return createEffect(() => {
    const value = getValue()
    if (value === undefined || value === null || value === false) {
      el.removeAttribute(key)
    } else if (value === true) {
      el.setAttribute(key, '')
    } else {
      el.setAttribute(key, String(value))
    }
  })
}

/**
 * Bind a reactive value to an element's property.
 */
export function bindProperty(el: HTMLElement, key: string, getValue: () => unknown): Cleanup {
  return createEffect(() => {
    ;(el as unknown as Record<string, unknown>)[key] = getValue()
  })
}

// ============================================================================
// Style Binding
// ============================================================================

/**
 * Apply styles to an element, supporting reactive style objects/strings.
 */
export function createStyleBinding(
  el: HTMLElement,
  value: MaybeReactive<string | Record<string, string | number> | null | undefined>,
): void {
  if (isReactive(value)) {
    createEffect(() => {
      applyStyle(el, (value as () => unknown)())
    })
  } else {
    applyStyle(el, value)
  }
}

/**
 * Apply a style value to an element
 */
function applyStyle(el: HTMLElement, value: unknown): void {
  if (typeof value === 'string') {
    el.style.cssText = value
  } else if (value && typeof value === 'object') {
    // Reset styles first for reactive updates
    el.style.cssText = ''
    const styles = value as Record<string, string | number>
    for (const [prop, v] of Object.entries(styles)) {
      if (v != null) {
        // Handle camelCase to kebab-case conversion
        const cssProperty = prop.replace(/([A-Z])/g, '-$1').toLowerCase()
        const unitless = isUnitlessStyleProperty(prop) || isUnitlessStyleProperty(cssProperty)
        const valueStr = typeof v === 'number' && !unitless ? `${v}px` : String(v)
        el.style.setProperty(cssProperty, valueStr)
      }
    }
  } else {
    el.style.cssText = ''
  }
}

const UNITLESS_STYLES = new Set([
  'animationIterationCount',
  'borderImageOutset',
  'borderImageSlice',
  'borderImageWidth',
  'boxFlex',
  'boxFlexGroup',
  'boxOrdinalGroup',
  'columnCount',
  'columns',
  'flex',
  'flexGrow',
  'flexPositive',
  'flexShrink',
  'flexNegative',
  'flexOrder',
  'gridRow',
  'gridRowEnd',
  'gridRowSpan',
  'gridRowStart',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnSpan',
  'gridColumnStart',
  'fontWeight',
  'lineClamp',
  'lineHeight',
  'opacity',
  'order',
  'orphans',
  'tabSize',
  'widows',
  'zIndex',
  'zoom',
  'fillOpacity',
  'floodOpacity',
  'stopOpacity',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
])

function isUnitlessStyleProperty(prop: string): boolean {
  return UNITLESS_STYLES.has(prop)
}

// ============================================================================
// Class Binding
// ============================================================================

/**
 * Apply class to an element, supporting reactive class values.
 */
export function createClassBinding(
  el: HTMLElement,
  value: MaybeReactive<string | Record<string, boolean> | null | undefined>,
): void {
  if (isReactive(value)) {
    createEffect(() => {
      applyClass(el, (value as () => unknown)())
    })
  } else {
    applyClass(el, value)
  }
}

/**
 * Apply a class value to an element
 */
function applyClass(el: HTMLElement, value: unknown): void {
  if (typeof value === 'string') {
    el.className = value
  } else if (value && typeof value === 'object') {
    // Object syntax: { 'class-name': boolean }
    const classes: string[] = []
    for (const [className, enabled] of Object.entries(value)) {
      if (enabled) {
        classes.push(className)
      }
    }
    el.className = classes.join(' ')
  } else {
    el.className = ''
  }
}

// ============================================================================
// Child/Insert Binding (Dynamic Children)
// ============================================================================

/**
 * Insert reactive content into a parent element.
 * This is a simpler API than createChildBinding for basic cases.
 */
export function insert(
  parent: HTMLElement | DocumentFragment,
  getValue: () => FictNode,
  createElementFn?: CreateElementFn,
): Cleanup {
  const marker = document.createComment('fict:insert')
  parent.appendChild(marker)

  const dispose = createEffect(() => {
    const value = getValue()

    // Skip if value is null/undefined/false
    if (value == null || value === false) {
      return
    }

    // Create new content
    const root = createRootContext()
    const prev = pushRoot(root)
    let nodes: Node[] = []
    try {
      const newNode =
        value instanceof Node
          ? value
          : typeof value === 'string' || typeof value === 'number'
            ? document.createTextNode(String(value))
            : createElementFn
              ? createElementFn(value)
              : document.createTextNode(String(value))

      nodes = toNodeArray(newNode)
      const parentNode = marker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        insertNodesBefore(parentNode, nodes, marker)
      }
    } finally {
      popRoot(prev)
      flushOnMount(root)
    }

    return () => {
      destroyRoot(root)
      removeNodes(nodes)
    }
  })

  return () => {
    dispose()
    marker.parentNode?.removeChild(marker)
  }
}

/**
 * Create a reactive child binding that updates when the child value changes.
 * This is used for dynamic expressions like `{show && <Modal />}` or `{items.map(...)}`.
 *
 * @example
 * ```ts
 * // Reactive child (compiler output for {count})
 * createChildBinding(parent, () => $count(), createElement)
 *
 * // Reactive conditional (compiler output for {show && <Modal />})
 * createChildBinding(parent, () => $show() && jsx(Modal, {}), createElement)
 * ```
 */
export function createChildBinding(
  parent: HTMLElement | DocumentFragment,
  getValue: () => FictNode,
  createElementFn: CreateElementFn,
): BindingHandle {
  const marker = document.createComment('fict:child')
  parent.appendChild(marker)

  const dispose = createEffect(() => {
    const value = getValue()

    // Skip if value is null/undefined/false
    if (value == null || value === false) {
      return
    }

    // Create new content within a root context
    const root = createRootContext()
    const prev = pushRoot(root)
    let nodes: Node[] = []
    try {
      const output = createElementFn(value)
      nodes = toNodeArray(output)
      const parentNode = marker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        insertNodesBefore(parentNode, nodes, marker)
      }
    } finally {
      popRoot(prev)
      flushOnMount(root)
    }

    return () => {
      destroyRoot(root)
      removeNodes(nodes)
    }
  })

  return {
    marker,
    dispose: () => {
      dispose()
      marker.parentNode?.removeChild(marker)
    },
  }
}

// ============================================================================
// Conditional Rendering
// ============================================================================

/**
 * Create a conditional rendering binding.
 * Efficiently renders one of two branches based on a condition.
 *
 * This is an optimized version for `{condition ? <A /> : <B />}` patterns
 * where both branches are known statically.
 *
 * @example
 * ```ts
 * // Compiler output for {show ? <A /> : <B />}
 * createConditional(
 *   () => $show(),
 *   () => jsx(A, {}),
 *   () => jsx(B, {}),
 *   createElement
 * )
 * ```
 */
export function createConditional(
  condition: () => boolean,
  renderTrue: () => FictNode,
  createElementFn: CreateElementFn,
  renderFalse?: () => FictNode,
): BindingHandle {
  // Create a fragment with start and end markers
  const fragment = document.createDocumentFragment()
  const startMarker = document.createComment('fict:cond:start')
  const endMarker = document.createComment('fict:cond:end')
  fragment.appendChild(startMarker)
  fragment.appendChild(endMarker)

  let currentNodes: Node[] = []
  let currentRoot: RootContext | null = null
  let lastCondition: boolean | undefined = undefined

  const dispose = createEffect(() => {
    const cond = condition()

    // Skip if condition hasn't changed and we already rendered
    if (lastCondition === cond && currentNodes.length > 0) {
      return
    }
    // For initial false condition, we still need to mark as initialized
    if (lastCondition === cond && lastCondition === false && renderFalse === undefined) {
      return
    }
    lastCondition = cond

    // Clean up previous node
    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    removeNodes(currentNodes)
    currentNodes = []

    // Determine what to render
    const render = cond ? renderTrue : renderFalse
    if (!render) {
      return
    }

    // Create new content
    const root = createRootContext()
    const prev = pushRoot(root)
    try {
      const output = render()
      if (output == null || output === false) {
        currentRoot = root
        return
      }
      const el = createElementFn!(output)
      const nodes = toNodeArray(el)
      const parent = startMarker.parentNode as (ParentNode & Node) | null
      if (parent) {
        insertNodesBefore(parent, nodes, endMarker)
        currentNodes = nodes
      } else {
        currentNodes = nodes
      }
    } finally {
      popRoot(prev)
      flushOnMount(root)
    }
    currentRoot = root
  })

  return {
    marker: fragment,
    dispose: () => {
      dispose()
      if (currentRoot) {
        destroyRoot(currentRoot)
      }
      removeNodes(currentNodes)
      currentNodes = []
      startMarker.parentNode?.removeChild(startMarker)
      endMarker.parentNode?.removeChild(endMarker)
    },
  }
}

// ============================================================================
// List Rendering
// ============================================================================

/** Key extractor function type */
export type KeyFn<T> = (item: T, index: number) => string | number

/**
 * Create a reactive list rendering binding.
 * Efficiently renders and updates a list of items with optional keying.
 *
 * @example
 * ```ts
 * // Compiler output for {items.map(item => <Item item={item} />)}
 * createList(
 *   () => $items(),
 *   (item, index) => jsx(Item, { item }),
 *   item => item.id,  // optional key function
 *   createElement
 * )
 * ```
 */
export function createList<T>(
  items: () => T[],
  renderItem: (item: T, index: number) => FictNode,
  createElementFn: CreateElementFn,
  getKey?: KeyFn<T>,
): BindingHandle {
  // Create a fragment with start and end markers
  const fragment = document.createDocumentFragment()
  const startMarker = document.createComment('fict:list:start')
  const endMarker = document.createComment('fict:list:end')
  fragment.appendChild(startMarker)
  fragment.appendChild(endMarker)

  // Map of key -> managed block
  const nodeMap = new Map<string | number, ManagedBlock>()

  const dispose = createEffect(() => {
    const arr = items()
    const parent = startMarker.parentNode as (ParentNode & Node) | null
    if (!parent) return

    const newNodeMap = new Map<string | number, ManagedBlock>()
    const blocks: ManagedBlock[] = []

    // Build or refresh blocks for the new array
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]!
      const key = getKey ? getKey(item, i) : i
      const existing = nodeMap.get(key)

      let block: ManagedBlock
      if (existing) {
        // Always refresh to reflect latest item value
        block = refreshBlock(
          existing,
          () => renderItem(item, i),
          parent,
          endMarker,
          createElementFn,
        )
      } else {
        block = mountBlock(() => renderItem(item, i), parent, endMarker, createElementFn)
      }

      newNodeMap.set(key, block)
      blocks.push(block)
    }

    // Cleanup removed blocks
    for (const [key, managed] of nodeMap) {
      if (!newNodeMap.has(key)) {
        destroyRoot(managed.root)
        removeNodes(managed.nodes)
      }
    }

    // Reorder nodes efficiently - insert blocks before endMarker in correct order
    let anchor: Node = endMarker
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!
      insertNodesBefore(parent, block.nodes, anchor)
      if (block.nodes.length > 0) {
        anchor = block.nodes[0]!
      }
    }

    // Update state
    nodeMap.clear()
    for (const [k, v] of newNodeMap) {
      nodeMap.set(k, v)
    }
  })

  return {
    marker: fragment,
    dispose: () => {
      dispose()
      for (const [, managed] of nodeMap) {
        destroyRoot(managed.root)
        removeNodes(managed.nodes)
      }
      nodeMap.clear()
      startMarker.parentNode?.removeChild(startMarker)
      endMarker.parentNode?.removeChild(endMarker)
    },
  }
}

// ============================================================================
// Show/Hide Helper
// ============================================================================

/**
 * Create a show/hide binding that uses CSS display instead of DOM manipulation.
 * More efficient than conditional when the content is expensive to create.
 *
 * @example
 * ```ts
 * createShow(container, () => $visible())
 * ```
 */
export function createShow(el: HTMLElement, condition: () => boolean, displayValue = ''): void {
  createEffect(() => {
    el.style.display = condition() ? displayValue : 'none'
  })
}

// ============================================================================
// Portal
// ============================================================================

/**
 * Create a portal that renders content into a different DOM container.
 *
 * @example
 * ```ts
 * createPortal(
 *   document.body,
 *   () => jsx(Modal, { children: 'Hello' }),
 *   createElement
 * )
 * ```
 */
export function createPortal(
  container: HTMLElement,
  render: () => FictNode,
  createElementFn: CreateElementFn,
): BindingHandle {
  const marker = document.createComment('fict:portal')
  container.appendChild(marker)

  let currentNodes: Node[] = []
  let currentRoot: RootContext | null = null

  const dispose = createEffect(() => {
    // Clean up previous
    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    if (currentNodes.length > 0) {
      removeNodes(currentNodes)
      currentNodes = []
    }

    // Create new content
    const root = createRootContext()
    const prev = pushRoot(root)
    try {
      const output = render()
      if (output != null && output !== false) {
        const el = createElementFn(output)
        const nodes = toNodeArray(el)
        if (marker.parentNode) {
          insertNodesBefore(marker.parentNode as ParentNode & Node, nodes, marker)
        }
        currentNodes = nodes
      }
    } finally {
      popRoot(prev)
      flushOnMount(root)
    }
    currentRoot = root
  })

  return {
    marker,
    dispose: () => {
      dispose()
      if (currentRoot) {
        destroyRoot(currentRoot)
      }
      if (currentNodes.length > 0) {
        removeNodes(currentNodes)
      }
      marker.parentNode?.removeChild(marker)
    },
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function mountBlock(
  render: () => FictNode,
  parent: ParentNode & Node,
  anchor: Node,
  createElementFn: CreateElementFn,
): ManagedBlock {
  const root = createRootContext()
  const prev = pushRoot(root)
  let nodes: Node[] = []
  try {
    const output = render()
    if (output != null && output !== false) {
      const el = createElementFn(output)
      nodes = toNodeArray(el)
      insertNodesBefore(parent, nodes, anchor)
    }
  } finally {
    popRoot(prev)
    flushOnMount(root)
  }
  return { nodes, root }
}

function refreshBlock(
  block: ManagedBlock,
  render: () => FictNode,
  parent: ParentNode & Node,
  anchor: Node,
  createElementFn: CreateElementFn,
): ManagedBlock {
  destroyRoot(block.root)
  removeNodes(block.nodes)
  return mountBlock(render, parent, anchor, createElementFn)
}

function toNodeArray(node: Node): Node[] {
  return node instanceof DocumentFragment ? Array.from(node.childNodes) : [node]
}

function insertNodesBefore(parent: ParentNode & Node, nodes: Node[], anchor: Node): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    parent.insertBefore(node, anchor)
    anchor = node
  }
}

function removeNodes(nodes: Node[]): void {
  for (const node of nodes) {
    node.parentNode?.removeChild(node)
  }
}
