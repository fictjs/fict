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
interface ManagedNode {
  node: Node
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

  let currentNode: Node | null = null

  const dispose = createEffect(() => {
    const value = getValue()

    // Remove previous node
    if (currentNode && currentNode.parentNode) {
      currentNode.parentNode.removeChild(currentNode)
      currentNode = null
    }

    // Skip if value is null/undefined/false
    if (value == null || value === false) {
      return
    }

    // Create new content
    let newNode: Node
    if (value instanceof Node) {
      newNode = value
    } else if (typeof value === 'string' || typeof value === 'number') {
      newNode = document.createTextNode(String(value))
    } else if (createElementFn) {
      newNode = createElementFn(value)
    } else {
      newNode = document.createTextNode(String(value))
    }

    marker.parentNode?.insertBefore(newNode, marker)
    currentNode = newNode
  })

  return () => {
    dispose()
    if (currentNode && currentNode.parentNode) {
      currentNode.parentNode.removeChild(currentNode)
    }
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

  let currentNodes: Node[] = []
  let currentRoot: RootContext | null = null

  const dispose = createEffect(() => {
    const value = getValue()

    // Clean up previous nodes
    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    for (const node of currentNodes) {
      if (node.parentNode) {
        node.parentNode.removeChild(node)
      }
    }
    currentNodes = []

    // Skip if value is null/undefined/false
    if (value == null || value === false) {
      return
    }

    // Create new content within a root context
    const root = createRootContext()
    const prev = pushRoot(root)
    try {
      const newNode = createElementFn(value)
      if (newNode instanceof DocumentFragment) {
        // Collect all child nodes before inserting (fragment gets emptied)
        currentNodes = Array.from(newNode.childNodes)
      } else {
        currentNodes = [newNode]
      }
      marker.parentNode?.insertBefore(newNode, marker)
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
      for (const node of currentNodes) {
        node.parentNode?.removeChild(node)
      }
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

  let currentNode: Node | null = null
  let currentRoot: RootContext | null = null
  let lastCondition: boolean | undefined = undefined

  const dispose = createEffect(() => {
    const cond = condition()

    // Skip if condition hasn't changed and we already rendered
    if (lastCondition === cond && currentNode !== null) {
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
    if (currentNode && currentNode.parentNode) {
      currentNode.parentNode.removeChild(currentNode)
      currentNode = null
    }

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

      // Insert before endMarker (works whether we're in fragment or real DOM)
      const parent = startMarker.parentNode
      if (parent) {
        parent.insertBefore(el, endMarker)
      }
      currentNode = el
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
      if (currentNode && currentNode.parentNode) {
        currentNode.parentNode.removeChild(currentNode)
      }
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

  // Map of key -> managed node
  const nodeMap = new Map<string | number, ManagedNode>()

  const dispose = createEffect(() => {
    const arr = items()
    const parent = startMarker.parentNode
    if (!parent) return

    const newKeys: (string | number)[] = []
    const newNodeMap = new Map<string | number, ManagedNode>()
    const reusedKeys = new Set<string | number>()

    // Phase 1: Determine new keys and which nodes can be reused
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]!
      const key = getKey ? getKey(item, i) : i
      newKeys.push(key)

      const existing = nodeMap.get(key)
      if (existing) {
        // Reuse existing node
        newNodeMap.set(key, existing)
        reusedKeys.add(key)
      }
    }

    // Phase 2: Remove nodes that are no longer needed
    for (const [key, managed] of nodeMap) {
      if (!reusedKeys.has(key)) {
        destroyRoot(managed.root)
        managed.node.parentNode?.removeChild(managed.node)
      }
    }

    // Phase 3: Create new nodes
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]!
      const key = newKeys[i]!

      if (!newNodeMap.has(key)) {
        // Create new node
        const root = createRootContext()
        const prev = pushRoot(root)
        try {
          const output = renderItem(item, i)
          const node = createElementFn!(output)
          newNodeMap.set(key, { node, root })
        } finally {
          popRoot(prev)
          flushOnMount(root)
        }
      }
    }

    // Phase 4: Reorder nodes efficiently - insert before endMarker in correct order
    let nextSibling: Node = endMarker
    for (let i = newKeys.length - 1; i >= 0; i--) {
      const key = newKeys[i]!
      const managed = newNodeMap.get(key)!
      // Only move if not already in correct position
      if (managed.node.nextSibling !== nextSibling) {
        parent.insertBefore(managed.node, nextSibling)
      }
      nextSibling = managed.node
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
        managed.node.parentNode?.removeChild(managed.node)
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
export function createShow(
  el: HTMLElement,
  condition: () => boolean,
  displayValue: string = '',
): void {
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

  let currentNode: Node | null = null
  let currentRoot: RootContext | null = null

  const dispose = createEffect(() => {
    // Clean up previous
    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    if (currentNode) {
      currentNode.parentNode?.removeChild(currentNode)
      currentNode = null
    }

    // Create new content
    const root = createRootContext()
    const prev = pushRoot(root)
    try {
      const output = render()
      if (output != null && output !== false) {
        currentNode = createElementFn(output)
        marker.parentNode?.insertBefore(currentNode, marker)
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
      if (currentNode) {
        currentNode.parentNode?.removeChild(currentNode)
      }
      marker.parentNode?.removeChild(marker)
    },
  }
}
