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
import { Fragment } from './jsx'
import {
  clearRoot,
  createRootContext,
  destroyRoot,
  flushOnMount,
  getCurrentRoot,
  handleError,
  handleSuspend,
  pushRoot,
  popRoot,
  registerRootCleanup,
  type RootContext,
} from './lifecycle'
import { computed, createSignal, untrack, type Signal } from './signal'
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
  /** Marker node(s) used for positioning */
  marker: Comment | DocumentFragment | Node[]
  /** Flush pending content - call after markers are inserted into DOM */
  flush?: () => void
  /** Dispose function to clean up the binding */
  dispose: Cleanup
}

/** Managed child node with its dispose function */
interface ManagedBlock<T = unknown> {
  nodes: Node[]
  root: RootContext
  value: Signal<T>
  index: Signal<number>
  version: Signal<number>
  start: Comment
  end: Comment
  valueProxy: T
  renderCurrent: () => FictNode
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

export const PRIMITIVE_PROXY = Symbol('fict:primitive-proxy')
const PRIMITIVE_PROXY_RAW_VALUE = Symbol('fict:primitive-proxy:raw-value')

/**
 * Unwrap a primitive proxy value to get the raw primitive value.
 * This is primarily useful for advanced scenarios where you need the actual
 * primitive type (e.g., for typeof checks or strict equality comparisons).
 *
 * @param value - A potentially proxied primitive value
 * @returns The raw primitive value
 *
 * @example
 * ```ts
 * createList(
 *   () => [1, 2, 3],
 *   (item) => {
 *     const raw = unwrapPrimitive(item)
 *     typeof raw === 'number'  // true
 *     raw === 1  // true (for first item)
 *   },
 *   item => item
 * )
 * ```
 */
export function unwrapPrimitive<T>(value: T): T {
  if (value && typeof value === 'object' && PRIMITIVE_PROXY in value) {
    // Use the internal raw value getter
    const getRawValue = (value as Record<PropertyKey, unknown>)[PRIMITIVE_PROXY_RAW_VALUE]
    if (typeof getRawValue === 'function') {
      return (getRawValue as () => T)()
    }
  }
  return value
}

function createValueProxy<T>(read: () => T): T {
  const getPrimitivePrototype = (value: unknown): Record<PropertyKey, unknown> | undefined => {
    switch (typeof value) {
      case 'string':
        return String.prototype as unknown as Record<PropertyKey, unknown>
      case 'number':
        return Number.prototype as unknown as Record<PropertyKey, unknown>
      case 'boolean':
        return Boolean.prototype as unknown as Record<PropertyKey, unknown>
      case 'bigint':
        return BigInt.prototype as unknown as Record<PropertyKey, unknown>
      case 'symbol':
        return Symbol.prototype as unknown as Record<PropertyKey, unknown>
      default:
        return undefined
    }
  }

  const target: Record<PropertyKey, unknown> = {}
  const handler: ProxyHandler<Record<PropertyKey, unknown>> = {
    get(_target, prop, receiver) {
      if (prop === PRIMITIVE_PROXY) {
        return true
      }
      if (prop === PRIMITIVE_PROXY_RAW_VALUE) {
        return () => read()
      }
      if (prop === Symbol.toPrimitive) {
        return (hint: 'string' | 'number' | 'default') => {
          const value = read() as unknown
          if (value != null && (typeof value === 'object' || typeof value === 'function')) {
            const toPrimitive = (value as { [Symbol.toPrimitive]?: (hint: string) => unknown })[
              Symbol.toPrimitive
            ]
            if (typeof toPrimitive === 'function') {
              return toPrimitive.call(value, hint)
            }
            if (hint === 'string') return value.toString?.() ?? '[object Object]'
            if (hint === 'number') return value.valueOf?.() ?? value
            return value.valueOf?.() ?? value
          }
          return value
        }
      }
      if (prop === 'valueOf') {
        return () => {
          const value = read() as unknown
          if (value != null && (typeof value === 'object' || typeof value === 'function')) {
            return typeof (value as { valueOf?: () => unknown }).valueOf === 'function'
              ? (value as { valueOf: () => unknown }).valueOf()
              : value
          }
          return value
        }
      }
      if (prop === 'toString') {
        return () => String(read())
      }

      const value = read() as unknown
      if (value != null && (typeof value === 'object' || typeof value === 'function')) {
        return Reflect.get(value as object, prop, receiver === _target ? value : receiver)
      }

      const proto = getPrimitivePrototype(value)
      if (proto && prop in proto) {
        const descriptor = Reflect.get(proto, prop, value)
        return typeof descriptor === 'function' ? descriptor.bind(value) : descriptor
      }
      return undefined
    },
    set(_target, prop, newValue, receiver) {
      const value = read() as unknown
      if (value != null && (typeof value === 'object' || typeof value === 'function')) {
        return Reflect.set(value as object, prop, newValue, receiver === _target ? value : receiver)
      }
      return false
    },
    has(_target, prop) {
      if (prop === PRIMITIVE_PROXY || prop === PRIMITIVE_PROXY_RAW_VALUE) {
        return true
      }
      const value = read() as unknown
      if (value != null && (typeof value === 'object' || typeof value === 'function')) {
        return prop in (value as object)
      }
      const proto = getPrimitivePrototype(value)
      return proto ? prop in proto : false
    },
    ownKeys() {
      const value = read() as unknown
      if (value != null && (typeof value === 'object' || typeof value === 'function')) {
        return Reflect.ownKeys(value as object)
      }
      const proto = getPrimitivePrototype(value)
      return proto ? Reflect.ownKeys(proto) : []
    },
    getOwnPropertyDescriptor(_target, prop) {
      const value = read() as unknown
      if (value != null && (typeof value === 'object' || typeof value === 'function')) {
        return Object.getOwnPropertyDescriptor(value as object, prop)
      }
      const proto = getPrimitivePrototype(value)
      return proto ? Object.getOwnPropertyDescriptor(proto, prop) || undefined : undefined
    },
  }

  return new Proxy(target, handler) as T
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
  // Keep behavior aligned with the legacy createElement+applyProps path in `dom.ts`,
  // where certain keys must behave like DOM properties and nullish clears should
  // reset to sensible defaults (e.g. value -> '', checked -> false).
  const PROPERTY_BINDING_KEYS = new Set([
    'value',
    'checked',
    'selected',
    'disabled',
    'readOnly',
    'multiple',
    'muted',
  ])

  return createEffect(() => {
    const next = getValue()
    if (PROPERTY_BINDING_KEYS.has(key) && (next === undefined || next === null)) {
      const fallback = key === 'checked' || key === 'selected' ? false : ''
      ;(el as unknown as Record<string, unknown>)[key] = fallback
      return
    }
    ;(el as unknown as Record<string, unknown>)[key] = next
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
    let prev: unknown
    createEffect(() => {
      const next = (value as () => unknown)()
      applyStyle(el, next, prev)
      prev = next
    })
  } else {
    applyStyle(el, value, undefined)
  }
}

/**
 * Bind a reactive style value to an existing element.
 */
export function bindStyle(
  el: HTMLElement,
  getValue: () => string | Record<string, string | number> | null | undefined,
): Cleanup {
  let prev: unknown
  return createEffect(() => {
    const next = getValue()
    applyStyle(el, next, prev)
    prev = next
  })
}

/**
 * Apply a style value to an element
 */
function applyStyle(el: HTMLElement, value: unknown, prev: unknown): void {
  if (typeof value === 'string') {
    el.style.cssText = value
  } else if (value && typeof value === 'object') {
    const styles = value as Record<string, string | number>

    // If we previously set styles via string, clear before applying object map
    if (typeof prev === 'string') {
      el.style.cssText = ''
    }

    // Remove styles that were present in prev but not in current
    if (prev && typeof prev === 'object') {
      const prevStyles = prev as Record<string, string | number>
      for (const key of Object.keys(prevStyles)) {
        if (!(key in styles)) {
          const cssProperty = key.replace(/([A-Z])/g, '-$1').toLowerCase()
          el.style.removeProperty(cssProperty)
        }
      }
    }

    for (const [prop, v] of Object.entries(styles)) {
      if (v != null) {
        // Handle camelCase to kebab-case conversion
        const cssProperty = prop.replace(/([A-Z])/g, '-$1').toLowerCase()
        const unitless = isUnitlessStyleProperty(prop) || isUnitlessStyleProperty(cssProperty)
        const valueStr = typeof v === 'number' && !unitless ? `${v}px` : String(v)
        el.style.setProperty(cssProperty, valueStr)
      } else {
        const cssProperty = prop.replace(/([A-Z])/g, '-$1').toLowerCase()
        el.style.removeProperty(cssProperty) // Handle null/undefined values by removing
      }
    }
  } else {
    // If value is null/undefined, we might want to clear styles set by PREVIOUS binding?
    // But blindly clearing cssText is dangerous.
    // Ideally we remove keys from prev.
    if (prev && typeof prev === 'object') {
      const prevStyles = prev as Record<string, string | number>
      for (const key of Object.keys(prevStyles)) {
        const cssProperty = key.replace(/([A-Z])/g, '-$1').toLowerCase()
        el.style.removeProperty(cssProperty)
      }
    } else if (typeof prev === 'string') {
      el.style.cssText = ''
    }
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
    let prev: unknown
    createEffect(() => {
      const next = (value as () => unknown)()
      applyClass(el, next, prev)
      prev = next
    })
  } else {
    applyClass(el, value, undefined)
  }
}

/**
 * Bind a reactive class value to an existing element.
 */
export function bindClass(
  el: HTMLElement,
  getValue: () => string | Record<string, boolean> | null | undefined,
): Cleanup {
  let prev: unknown
  return createEffect(() => {
    const next = getValue()
    applyClass(el, next, prev)
    prev = next
  })
}

/**
 * Apply a class value to an element
 */
function applyClass(el: HTMLElement, value: unknown, _prev: unknown): void {
  let staticClasses = STATIC_CLASS_MAP.get(el)
  if (!staticClasses) {
    staticClasses = el.className ? el.className.split(/\s+/).filter(Boolean) : []
    STATIC_CLASS_MAP.set(el, staticClasses)
  }

  if (typeof value === 'string') {
    el.className = value
  } else if (value && typeof value === 'object') {
    const classes = value as Record<string, boolean>
    const enabled = Object.entries(classes)
      .filter(([, on]) => !!on)
      .map(([name]) => name)
    const merged = [...enabled, ...staticClasses.filter(name => !classes[name])]
    el.className = merged.join(' ')
  } else {
    el.className = staticClasses ? staticClasses.join(' ') : ''
  }
}

const STATIC_CLASS_MAP = new WeakMap<HTMLElement, string[]>()

// ============================================================================
// Child/Insert Binding (Dynamic Children)
// ============================================================================

/** Managed child node with its dispose function */
interface ManagedBlock<T = unknown> {
  nodes: Node[]
  root: RootContext
  value: Signal<T>
  index: Signal<number>
  version: Signal<number>
  start: Comment
  end: Comment
  valueProxy: T
  renderCurrent: () => FictNode
}

/**
 * Insert reactive content into a parent element.
 * This is a simpler API than createChildBinding for basic cases.
 *
 * @param parent - The parent element to insert into
 * @param getValue - Function that returns the value to render
 * @param markerOrCreateElement - Optional marker node to insert before, or createElementFn
 * @param createElementFn - Optional function to create DOM elements (when marker is provided)
 */
export function insert(
  parent: HTMLElement | DocumentFragment,
  getValue: () => FictNode,
  markerOrCreateElement?: Node | CreateElementFn,
  createElementFn?: CreateElementFn,
): Cleanup {
  // Determine if third argument is a marker node or createElementFn
  let marker: Comment
  let createFn: CreateElementFn | undefined = createElementFn

  if (markerOrCreateElement instanceof Node) {
    // Third argument is a marker node - insert before it
    marker = document.createComment('fict:insert')
    parent.insertBefore(marker, markerOrCreateElement)
    createFn = createElementFn
  } else {
    // Third argument is createElementFn (or undefined) - append marker at end
    marker = document.createComment('fict:insert')
    parent.appendChild(marker)
    createFn = markerOrCreateElement as CreateElementFn | undefined
  }

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
      let newNode: Node | Node[]

      if (value instanceof Node) {
        newNode = value
      } else if (Array.isArray(value)) {
        // Handle array of nodes (e.g. from createList) directly
        // Filter to ensure we only have Nodes, or use createElement for mixed content if needed
        // For now, assume if it's an array from a binding handle, it's nodes.
        // If it's a mixed array from JSX, createElementFn should handle it if passed there?
        // Actually, let's keep it simple: if array, pass to toNodeArray which handles recursion/arrays
        newNode = [] as Node[]
        // But wait, toNodeArray takes Node | Node[].
        // We need to resolve the array items.
        // If the array contains non-Nodes, we might need createElementFn?
        // For the specific case of BindingHandle.marker returning Node[], this is fine.
        // But insert is generic.
        // Let's rely on toNodeArray but we need to pass something that toNodeArray accepts or handle the resolution here.
        // Actually, if value is array, let's trust createElementFn or handle it if it contains pure Nodes.

        // Revised strategy:
        // If it's an array of Nodes, use it.
        // If mixed, use createElementFn.
        if (value.every(v => v instanceof Node)) {
          newNode = value as Node[]
        } else {
          // Fallback to createFn which likely handles arrays (via Fragment logic) or standard text conv
          newNode = createFn ? createFn(value) : document.createTextNode(String(value))
        }
      } else if (typeof value === 'string' || typeof value === 'number') {
        newNode = document.createTextNode(String(value))
      } else {
        newNode = createFn ? createFn(value) : document.createTextNode(String(value))
      }

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
    const root = createRootContext()
    const prev = pushRoot(root)
    let nodes: Node[] = []
    let handledError = false
    try {
      const value = getValue()

      // Skip if value is null/undefined/false
      if (value == null || value === false) {
        return
      }

      const output = createElementFn(value)
      nodes = toNodeArray(output)
      const parentNode = marker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        insertNodesBefore(parentNode, nodes, marker)
      }
      return () => {
        destroyRoot(root)
        removeNodes(nodes)
      }
    } catch (err) {
      if (handleSuspend(err as any, root)) {
        handledError = true
        destroyRoot(root)
        return
      }
      if (handleError(err, { source: 'renderChild' }, root)) {
        handledError = true
        destroyRoot(root)
        return
      }
      throw err
    } finally {
      popRoot(prev)
      if (!handledError) {
        flushOnMount(root)
      }
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
// Event Binding
// ============================================================================

/**
 * Bind an event listener to an element.
 *
 * @example
 * ```ts
 * // Static event
 * bindEvent(button, 'click', handleClick)
 *
 * // Reactive event (compiler output)
 * bindEvent(button, 'click', () => $handler())
 *
 * // With modifiers
 * bindEvent(button, 'click', handler, { capture: true, passive: true, once: true })
 * ```
 */
export function bindEvent(
  el: HTMLElement,
  eventName: string,
  handler: EventListenerOrEventListenerObject | null | undefined,
  options?: boolean | AddEventListenerOptions,
): Cleanup {
  if (handler == null) return () => {}

  const rootRef = getCurrentRoot()
  const getHandler = isReactive(handler) ? (handler as () => unknown) : () => handler

  const wrapped: EventListener = event => {
    try {
      const resolved = getHandler()
      if (typeof resolved === 'function') {
        ;(resolved as EventListener)(event)
      } else if (resolved && typeof (resolved as EventListenerObject).handleEvent === 'function') {
        ;(resolved as EventListenerObject).handleEvent(event)
      }
    } catch (err) {
      if (handleError(err, { source: 'event', eventName }, rootRef)) {
        return
      }
      throw err
    }
  }

  el.addEventListener(eventName, wrapped, options)
  const cleanup = () => el.removeEventListener(eventName, wrapped, options)
  registerRootCleanup(cleanup)
  return cleanup
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
  const startMarker = document.createComment('fict:cond:start')
  const endMarker = document.createComment('fict:cond:end')

  let currentNodes: Node[] = []
  let currentRoot: RootContext | null = null
  let lastCondition: boolean | undefined = undefined
  let pendingNodes: Node[] = [] // Nodes waiting to be inserted when markers are in DOM

  // Use computed to memoize condition value - this prevents the effect from
  // re-running when condition dependencies change but the boolean result stays same.
  // This is critical because re-running the effect would purge child effect deps
  // (like bindText) even if we early-return, breaking fine-grained reactivity.
  const conditionMemo = computed(condition)

  // Function to insert pending nodes when markers become available in DOM
  const insertPendingNodes = () => {
    if (pendingNodes.length === 0) return
    const parent = startMarker.parentNode as (ParentNode & Node) | null
    if (parent) {
      insertNodesBefore(parent, pendingNodes, endMarker)
      currentNodes = pendingNodes
      pendingNodes = []
    }
  }

  const dispose = createEffect(() => {
    const cond = conditionMemo()

    if (lastCondition === cond && currentNodes.length > 0) {
      return
    }
    if (lastCondition === cond && lastCondition === false && renderFalse === undefined) {
      return
    }
    lastCondition = cond

    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    removeNodes(currentNodes)
    currentNodes = []
    pendingNodes = []

    const render = cond ? renderTrue : renderFalse
    if (!render) {
      return
    }

    const root = createRootContext()
    const prev = pushRoot(root)
    let handledError = false
    try {
      // Use untrack to prevent render function's signal accesses from being
      // tracked by createConditional's effect. This ensures that signals used
      // inside the render function (e.g., nested if conditions) don't cause
      // createConditional to re-run, which would purge child effect deps.
      const output = untrack(render)
      if (output == null || output === false) {
        return
      }
      const el = createElementFn(output)
      const nodes = toNodeArray(el)
      const parent = startMarker.parentNode as (ParentNode & Node) | null
      if (parent) {
        insertNodesBefore(parent, nodes, endMarker)
        currentNodes = nodes
      } else {
        // Markers not in DOM yet - store nodes for later insertion
        pendingNodes = nodes
      }
    } catch (err) {
      if (handleSuspend(err as any, root)) {
        handledError = true
        destroyRoot(root)
        return
      }
      if (handleError(err, { source: 'renderChild' }, root)) {
        handledError = true
        destroyRoot(root)
        return
      }
      throw err
    } finally {
      popRoot(prev)
      if (!handledError) {
        flushOnMount(root)
        currentRoot = root
      } else {
        currentRoot = null
      }
    }
  })

  return {
    marker: [startMarker, endMarker],
    // Flush pending nodes - call this after markers are inserted into DOM
    flush: insertPendingNodes,
    dispose: () => {
      dispose()
      if (currentRoot) {
        destroyRoot(currentRoot)
      }
      removeNodes(currentNodes)
      removeNodes(pendingNodes)
      currentNodes = []
      pendingNodes = []
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
 * Create a reactive list rendering binding with optional keying.
 */
export function createList<T>(
  items: () => T[],
  renderItem: (item: T, index: number) => FictNode,
  createElementFn: CreateElementFn,
  getKey?: KeyFn<T>,
): BindingHandle {
  const startMarker = document.createComment('fict:list:start')
  const endMarker = document.createComment('fict:list:end')

  const nodeMap = new Map<string | number, ManagedBlock<T>>()
  let pendingRender = false // Flag to schedule re-render when markers become available

  // Function to re-trigger the effect when markers are available
  const scheduleRender = () => {
    if (!pendingRender) return
    const parent = startMarker.parentNode as (ParentNode & Node) | null
    if (parent) {
      pendingRender = false
      // Force effect to re-run by reading items again
      runListUpdate()
    }
  }

  const runListUpdate = () => {
    const arr = items()
    const parent = startMarker.parentNode as (ParentNode & Node) | null
    if (!parent) {
      // Markers not in DOM yet - schedule re-render
      pendingRender = true
      queueMicrotask(scheduleRender)
      return
    }

    const newNodeMap = new Map<string | number, ManagedBlock<T>>()
    const blocks: ManagedBlock<T>[] = []

    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]! as T
      const key = getKey ? getKey(item, i) : i
      const existing = nodeMap.get(key)

      let block: ManagedBlock<T>
      if (existing) {
        const previousValue = existing.value()
        if (!getKey && previousValue !== item) {
          destroyRoot(existing.root)
          removeBlockNodes(existing)
          block = mountBlock(item, i, renderItem, parent, endMarker, createElementFn)
        } else {
          const previousIndex = existing.index()
          existing.value(item)
          existing.index(i)

          if (previousValue === item) {
            bumpBlockVersion(existing)
          }

          const needsRerender = getKey ? true : previousValue !== item || previousIndex !== i
          block = needsRerender ? rerenderBlock(existing, createElementFn) : existing
        }
      } else {
        block = mountBlock(item, i, renderItem, parent, endMarker, createElementFn)
      }

      newNodeMap.set(key, block)
      blocks.push(block)
    }

    for (const [key, managed] of nodeMap) {
      if (!newNodeMap.has(key)) {
        destroyRoot(managed.root)
        removeBlockNodes(managed)
      }
    }

    let anchor: Node = endMarker
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!
      insertNodesBefore(parent, block.nodes, anchor)
      if (block.nodes.length > 0) {
        anchor = block.nodes[0]!
      }
    }

    nodeMap.clear()
    for (const [k, v] of newNodeMap) {
      nodeMap.set(k, v)
    }
  }

  const dispose = createEffect(runListUpdate)

  return {
    marker: [startMarker, endMarker],
    // Flush pending render - call this after markers are inserted into DOM
    flush: () => {
      if (pendingRender) {
        pendingRender = false
        runListUpdate()
      }
    },
    dispose: () => {
      dispose()
      for (const [, managed] of nodeMap) {
        destroyRoot(managed.root)
        removeBlockNodes(managed)
      }
      nodeMap.clear()
      startMarker.parentNode?.removeChild(startMarker)
      endMarker.parentNode?.removeChild(endMarker)
    },
  }
}

// ============================================================================
// Show/Hide Helper
// ==========================================================================

/**
 * Create a show/hide binding that uses CSS display instead of DOM manipulation.
 * More efficient than conditional when the content is expensive to create.
 *
 * @example
 * ```ts
 * createShow(container, () => $visible())
 * ```
 */
export function createShow(el: HTMLElement, condition: () => boolean, displayValue?: string): void {
  const originalDisplay = displayValue ?? el.style.display
  createEffect(() => {
    el.style.display = condition() ? originalDisplay : 'none'
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
  // Capture the parent root BEFORE any effects run
  // This is needed because createEffect will push/pop its own root context
  const parentRoot = getCurrentRoot()

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
    let handledError = false
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
    } catch (err) {
      if (handleSuspend(err as any, root)) {
        handledError = true
        destroyRoot(root)
        currentNodes = []
        return
      }
      if (handleError(err, { source: 'renderChild' }, root)) {
        handledError = true
        destroyRoot(root)
        currentNodes = []
        return
      }
      throw err
    } finally {
      popRoot(prev)
      if (!handledError) {
        flushOnMount(root)
        currentRoot = root
      } else {
        currentRoot = null
      }
    }
  })

  // The portal's dispose function must be named so we can register it for cleanup
  const portalDispose = () => {
    dispose()
    if (currentRoot) {
      destroyRoot(currentRoot)
    }
    if (currentNodes.length > 0) {
      removeNodes(currentNodes)
    }
    marker.parentNode?.removeChild(marker)
  }

  // Register the portal's cleanup with the parent component's root context
  // This ensures the portal is cleaned up when the parent unmounts
  // We use parentRoot (captured before createEffect) to avoid registering
  // with the portal's internal root which would be destroyed separately
  if (parentRoot) {
    parentRoot.destroyCallbacks.push(portalDispose)
  }

  return {
    marker,
    dispose: portalDispose,
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function mountBlock<T>(
  initialValue: T,
  initialIndex: number,
  renderItem: (item: T, index: number) => FictNode,
  parent: ParentNode & Node,
  anchor: Node,
  createElementFn: CreateElementFn,
): ManagedBlock<T> {
  const start = document.createComment('fict:block:start')
  const end = document.createComment('fict:block:end')
  const valueSig = createSignal<T>(initialValue)
  const indexSig = createSignal<number>(initialIndex)
  const versionSig = createSignal(0)
  const valueProxy = createValueProxy(() => {
    versionSig()
    return valueSig()
  }) as T
  const renderCurrent = () => renderItem(valueProxy, indexSig())
  const root = createRootContext()
  const prev = pushRoot(root)
  const nodes: Node[] = [start]
  let handledError = false
  try {
    const output = renderCurrent()
    if (output != null && output !== false) {
      const el = createElementFn(output)
      const rendered = toNodeArray(el)
      nodes.push(...rendered)
    }
    nodes.push(end)
    insertNodesBefore(parent, nodes, anchor)
  } catch (err) {
    if (handleSuspend(err as any, root)) {
      handledError = true
      nodes.push(end)
      insertNodesBefore(parent, nodes, anchor)
    } else if (handleError(err, { source: 'renderChild' }, root)) {
      handledError = true
      nodes.push(end)
      insertNodesBefore(parent, nodes, anchor)
    } else {
      throw err
    }
  } finally {
    popRoot(prev)
    if (!handledError) {
      flushOnMount(root)
    } else {
      destroyRoot(root)
    }
  }
  return {
    nodes,
    root,
    value: valueSig,
    index: indexSig,
    version: versionSig,
    start,
    end,
    valueProxy,
    renderCurrent,
  }
}

function rerenderBlock<T>(
  block: ManagedBlock<T>,
  createElementFn: CreateElementFn,
): ManagedBlock<T> {
  const currentContent = block.nodes.slice(1, Math.max(1, block.nodes.length - 1))
  const currentNode = currentContent.length === 1 ? currentContent[0] : null

  clearRoot(block.root)

  const prev = pushRoot(block.root)
  let nextOutput: FictNode
  let handledError = false
  try {
    nextOutput = block.renderCurrent()
  } catch (err) {
    if (handleSuspend(err as any, block.root)) {
      handledError = true
      popRoot(prev)
      destroyRoot(block.root)
      block.nodes = [block.start, block.end]
      return block
    }
    if (handleError(err, { source: 'renderChild' }, block.root)) {
      handledError = true
      popRoot(prev)
      destroyRoot(block.root)
      block.nodes = [block.start, block.end]
      return block
    }
    throw err
  } finally {
    if (!handledError) {
      popRoot(prev)
    }
  }

  if (isFragmentVNode(nextOutput) && currentContent.length > 0) {
    const patched = patchFragmentChildren(currentContent, nextOutput.props?.children)
    if (patched) {
      block.nodes = [block.start, ...currentContent, block.end]
      return block
    }
  }

  if (currentNode && patchNode(currentNode, nextOutput)) {
    block.nodes = [block.start, currentNode, block.end]
    return block
  }

  clearContent(block)

  if (nextOutput != null && nextOutput !== false) {
    const newNodes = toNodeArray(
      nextOutput instanceof Node ? nextOutput : (createElementFn(nextOutput) as Node),
    )
    insertNodesBefore(block.start.parentNode as ParentNode & Node, newNodes, block.end)
    block.nodes = [block.start, ...newNodes, block.end]
  } else {
    block.nodes = [block.start, block.end]
  }
  return block
}

function patchElement(el: Element, output: FictNode): boolean {
  if (
    output === null ||
    output === undefined ||
    output === false ||
    typeof output === 'string' ||
    typeof output === 'number'
  ) {
    el.textContent =
      output === null || output === undefined || output === false ? '' : String(output)
    return true
  }

  if (output instanceof Text) {
    el.textContent = output.data
    return true
  }

  if (output && typeof output === 'object' && !(output instanceof Node)) {
    const vnode = output as { type?: unknown; props?: Record<string, unknown> }
    if (typeof vnode.type === 'string' && vnode.type.toLowerCase() === el.tagName.toLowerCase()) {
      const children = vnode.props?.children
      if (
        typeof children === 'string' ||
        typeof children === 'number' ||
        children === null ||
        children === undefined ||
        children === false
      ) {
        el.textContent =
          children === null || children === undefined || children === false ? '' : String(children)
        const props = vnode.props ?? {}
        for (const [key, value] of Object.entries(props)) {
          if (key === 'children' || key === 'key') continue
          if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            value === null ||
            value === undefined
          ) {
            if (key === 'class' || key === 'className') {
              el.setAttribute('class', value === false || value === null ? '' : String(value))
            } else if (key === 'style' && typeof value === 'string') {
              ;(el as HTMLElement).style.cssText = value
            } else if (value === false || value === null || value === undefined) {
              el.removeAttribute(key)
            } else if (value === true) {
              el.setAttribute(key, '')
            } else {
              el.setAttribute(key, String(value))
            }
          }
        }
        return true
      }
    }
  }

  if (output instanceof Node) {
    if (output.nodeType === Node.ELEMENT_NODE) {
      const nextEl = output as Element
      if (nextEl.tagName.toLowerCase() === el.tagName.toLowerCase()) {
        el.textContent = nextEl.textContent
        return true
      }
    } else if (output.nodeType === Node.TEXT_NODE) {
      el.textContent = (output as Text).data
      return true
    }
  }

  return false
}

function patchNode(currentNode: Node | null, nextOutput: FictNode): boolean {
  if (!currentNode) return false

  if (
    currentNode instanceof Text &&
    (nextOutput === null ||
      nextOutput === undefined ||
      nextOutput === false ||
      typeof nextOutput === 'string' ||
      typeof nextOutput === 'number' ||
      nextOutput instanceof Text)
  ) {
    const nextText =
      nextOutput instanceof Text
        ? nextOutput.data
        : nextOutput === null || nextOutput === undefined || nextOutput === false
          ? ''
          : String(nextOutput)
    currentNode.data = nextText
    return true
  }

  if (currentNode instanceof Element && patchElement(currentNode, nextOutput)) {
    return true
  }

  if (nextOutput instanceof Node && currentNode === nextOutput) {
    return true
  }

  return false
}

function isFragmentVNode(
  value: unknown,
): value is { type: typeof Fragment; props?: { children?: FictNode | FictNode[] } } {
  return (
    value != null &&
    typeof value === 'object' &&
    !(value instanceof Node) &&
    (value as { type?: unknown }).type === Fragment
  )
}

function normalizeChildren(
  children: FictNode | FictNode[] | undefined,
  result: FictNode[] = [],
): FictNode[] {
  if (children === undefined) {
    return result
  }
  if (Array.isArray(children)) {
    for (const child of children) {
      normalizeChildren(child, result)
    }
    return result
  }
  if (children === null || children === false) {
    return result
  }
  result.push(children)
  return result
}

function patchFragmentChildren(
  nodes: Node[],
  children: FictNode | FictNode[] | undefined,
): boolean {
  const normalized = normalizeChildren(children)
  if (normalized.length !== nodes.length) {
    return false
  }
  for (let i = 0; i < normalized.length; i++) {
    if (!patchNode(nodes[i]!, normalized[i]!)) {
      return false
    }
  }
  return true
}

function clearContent<T>(block: ManagedBlock<T>): void {
  const nodes = block.nodes.slice(1, Math.max(1, block.nodes.length - 1))
  removeNodes(nodes)
}

function removeBlockNodes<T>(block: ManagedBlock<T>): void {
  let cursor: Node | null = block.start
  const end = block.end
  while (cursor) {
    const next: Node | null = cursor.nextSibling
    cursor.parentNode?.removeChild(cursor)
    if (cursor === end) break
    cursor = next
  }
}

function bumpBlockVersion<T>(block: ManagedBlock<T>): void {
  block.version(block.version() + 1)
}

function toNodeArray(node: Node | Node[] | BindingHandle | unknown): Node[] {
  try {
    if (Array.isArray(node)) {
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
    // Handle BindingHandle
    // Accessing properties might throw on proxy
    if (typeof node === 'object' && node !== null && 'marker' in node) {
      return toNodeArray((node as BindingHandle).marker)
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

function insertNodesBefore(parent: ParentNode & Node, nodes: Node[], anchor: Node): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    if (node === undefined || node === null) continue

    // Handle DocumentFragment - insert children in reverse order
    const isFrag = node.nodeType === 11
    if (isFrag) {
      const childrenArr = Array.from(node.childNodes)
      for (let j = childrenArr.length - 1; j >= 0; j--) {
        const child = childrenArr[j]!
        if (child.ownerDocument !== parent.ownerDocument && parent.ownerDocument) {
          parent.ownerDocument.adoptNode(child)
        }
        parent.insertBefore(child, anchor)
        anchor = child
      }
    } else {
      // Regular node
      if (node.ownerDocument !== parent.ownerDocument && parent.ownerDocument) {
        parent.ownerDocument.adoptNode(node)
      }
      parent.insertBefore(node, anchor)
    }
    anchor = node
  }
}

function removeNodes(nodes: Node[]): void {
  for (const node of nodes) {
    node.parentNode?.removeChild(node)
  }
}
