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

import {
  $$EVENTS,
  DelegatedEvents,
  UnitlessStyles,
  Properties,
  ChildProperties,
  getPropAlias,
  SVGNamespace,
  Aliases,
} from './constants'
import { createRenderEffect } from './effect'
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
import { createVersionedSignalAccessor } from './list-helpers'
import { toNodeArray, removeNodes, insertNodesBefore } from './node-ops'
import { batch } from './scheduler'
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
  marker: Comment | DocumentFragment
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
  start: Comment
  end: Comment
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

/**
 * Invoke an event handler or handler accessor in a safe way.
 * Supports handlers that return another handler and handlers that expect an
 * optional data payload followed by the event.
 */
export function callEventHandler(
  handler: EventListenerOrEventListenerObject | null | undefined,
  event: Event,
  node?: EventTarget | null,
  data?: unknown,
): void {
  if (!handler) return

  const context = (node ?? event.currentTarget ?? undefined) as EventTarget | undefined
  const invoke = (fn: EventListenerOrEventListenerObject | null | undefined): void => {
    if (typeof fn === 'function') {
      const result =
        data === undefined
          ? (fn as EventListener).call(context, event)
          : (fn as (data: unknown, e: Event) => unknown).call(context, data, event)

      if (typeof result === 'function' && result !== fn) {
        if (data === undefined) {
          ;(result as EventListener).call(context, event)
        } else {
          ;(result as (data: unknown, e: Event) => unknown).call(context, data, event)
        }
      } else if (result && typeof (result as EventListenerObject).handleEvent === 'function') {
        ;(result as EventListenerObject).handleEvent.call(result as EventListenerObject, event)
      }
    } else if (fn && typeof fn.handleEvent === 'function') {
      fn.handleEvent.call(fn, event)
    }
  }

  invoke(handler)
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

function _createValueProxy<T>(read: () => T): T {
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
    createRenderEffect(() => {
      const v = (value as () => unknown)()
      const fmt = formatTextValue(v)
      if (text.data !== fmt) {
        text.data = fmt
      }
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
  return createRenderEffect(() => {
    const value = formatTextValue(getValue())
    if (textNode.data !== value) {
      textNode.data = value
    }
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
export type AttributeSetter = (el: Element, key: string, value: unknown) => void

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
  el: Element,
  key: string,
  value: MaybeReactive<unknown>,
  setter: AttributeSetter,
): void {
  if (isReactive(value)) {
    // Reactive: create effect to update attribute when value changes
    createRenderEffect(() => {
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
export function bindAttribute(el: Element, key: string, getValue: () => unknown): Cleanup {
  let prevValue: unknown = undefined
  return createRenderEffect(() => {
    const value = getValue()
    if (value === prevValue) return
    prevValue = value

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
export function bindProperty(el: Element, key: string, getValue: () => unknown): Cleanup {
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

  let prevValue: unknown = undefined
  return createRenderEffect(() => {
    const next = getValue()
    if (next === prevValue) return
    prevValue = next

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
  el: Element,
  value: MaybeReactive<string | Record<string, string | number> | null | undefined>,
): void {
  const target = el as Element & { style: CSSStyleDeclaration }
  if (isReactive(value)) {
    let prev: unknown
    createRenderEffect(() => {
      const next = (value as () => unknown)()
      applyStyle(target, next, prev)
      prev = next
    })
  } else {
    applyStyle(target, value, undefined)
  }
}

/**
 * Bind a reactive style value to an existing element.
 */
export function bindStyle(
  el: Element,
  getValue: () => string | Record<string, string | number> | null | undefined,
): Cleanup {
  const target = el as Element & { style: CSSStyleDeclaration }
  let prev: unknown
  return createRenderEffect(() => {
    const next = getValue()
    applyStyle(target, next, prev)
    prev = next
  })
}

/**
 * Apply a style value to an element
 */
function applyStyle(
  el: Element & { style: CSSStyleDeclaration },
  value: unknown,
  prev: unknown,
): void {
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

function isUnitlessStyleProperty(prop: string): boolean {
  return UnitlessStyles.has(prop)
}

// ============================================================================
// Class Binding
// ============================================================================

/**
 * Apply class to an element, supporting reactive class values.
 */
export function createClassBinding(
  el: Element,
  value: MaybeReactive<string | Record<string, boolean> | null | undefined>,
): void {
  if (isReactive(value)) {
    let prev: Record<string, boolean> = {}
    createRenderEffect(() => {
      const next = (value as () => unknown)()
      prev = applyClass(el, next, prev)
    })
  } else {
    applyClass(el, value, {})
  }
}

/**
 * Bind a reactive class value to an existing element.
 */
export function bindClass(
  el: Element,
  getValue: () => string | Record<string, boolean> | null | undefined,
): Cleanup {
  let prev: Record<string, boolean> = {}
  let prevString: string | undefined
  return createRenderEffect(() => {
    const next = getValue()
    // P2-1: Short-circuit for string values to avoid DOM writes when unchanged
    if (typeof next === 'string') {
      if (next === prevString) return
      prevString = next
      el.className = next
      prev = {}
      return
    }
    prevString = undefined
    prev = applyClass(el, next, prev)
  })
}

/**
 * Toggle a class key (supports space-separated class names)
 */
function toggleClassKey(node: Element, key: string, value: boolean): void {
  const classNames = key.trim().split(/\s+/)
  for (let i = 0, len = classNames.length; i < len; i++) {
    node.classList.toggle(classNames[i]!, value)
  }
}

/**
 * Apply a class value to an element using classList.toggle for efficient updates.
 * Returns the new prev state for tracking.
 */
function applyClass(el: Element, value: unknown, prev: unknown): Record<string, boolean> {
  const prevState = (prev && typeof prev === 'object' ? prev : {}) as Record<string, boolean>

  // Handle string value - full replacement
  if (typeof value === 'string') {
    el.className = value
    // Clear prev state since we're doing full replacement
    return {}
  }

  // Handle object value - incremental updates
  if (value && typeof value === 'object') {
    const classes = value as Record<string, boolean>
    const classKeys = Object.keys(classes)
    const prevKeys = Object.keys(prevState)

    // Remove classes that were true but are now false or missing
    for (let i = 0, len = prevKeys.length; i < len; i++) {
      const key = prevKeys[i]!
      if (!key || key === 'undefined' || classes[key]) continue
      toggleClassKey(el, key, false)
      delete prevState[key]
    }

    // Add classes that are now true
    for (let i = 0, len = classKeys.length; i < len; i++) {
      const key = classKeys[i]!
      const classValue = !!classes[key]
      if (!key || key === 'undefined' || prevState[key] === classValue || !classValue) continue
      toggleClassKey(el, key, true)
      prevState[key] = classValue
    }

    return prevState
  }

  // Handle null/undefined - clear all tracked classes
  if (!value) {
    for (const key of Object.keys(prevState)) {
      if (key && key !== 'undefined') {
        toggleClassKey(el, key, false)
      }
    }
    return {}
  }

  return prevState
}

/**
 * Exported classList function for direct use (compatible with dom-expressions)
 */
export function classList(
  node: Element,
  value: Record<string, boolean> | null | undefined,
  prev: Record<string, boolean> = {},
): Record<string, boolean> {
  return applyClass(node, value, prev)
}

// ============================================================================
// Child/Insert Binding (Dynamic Children)
// ============================================================================

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
  parent: ParentNode & Node,
  getValue: () => FictNode,
  markerOrCreateElement?: Node | CreateElementFn,
  createElementFn?: CreateElementFn,
): Cleanup {
  const hostRoot = getCurrentRoot()
  let marker: Node
  let ownsMarker = false
  let createFn: CreateElementFn | undefined = createElementFn

  if (markerOrCreateElement instanceof Node) {
    marker = markerOrCreateElement
    createFn = createElementFn
  } else {
    marker = document.createComment('fict:insert')
    parent.appendChild(marker)
    createFn = markerOrCreateElement as CreateElementFn | undefined
    ownsMarker = true
  }

  let currentNodes: Node[] = []
  let currentText: Text | null = null
  let currentRoot: RootContext | null = null

  const clearCurrentNodes = () => {
    if (currentNodes.length > 0) {
      removeNodes(currentNodes)
      currentNodes = []
    }
  }

  const setTextNode = (textValue: string, shouldInsert: boolean, parentNode: ParentNode & Node) => {
    if (!currentText) {
      currentText = document.createTextNode(textValue)
    } else if (currentText.data !== textValue) {
      currentText.data = textValue
    }

    if (!shouldInsert) {
      clearCurrentNodes()
      return
    }

    if (currentNodes.length === 1 && currentNodes[0] === currentText) {
      return
    }

    clearCurrentNodes()
    insertNodesBefore(parentNode, [currentText], marker)
    currentNodes = [currentText]
  }

  const dispose = createRenderEffect(() => {
    const value = getValue()
    const parentNode = marker.parentNode as (ParentNode & Node) | null
    const isPrimitive =
      value == null ||
      value === false ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'

    if (isPrimitive) {
      if (currentRoot) {
        destroyRoot(currentRoot)
        currentRoot = null
      }
      if (!parentNode) {
        clearCurrentNodes()
        return
      }
      const textValue = value == null || value === false ? '' : String(value)
      const shouldInsert = value != null && value !== false
      setTextNode(textValue, shouldInsert, parentNode)
      return
    }

    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    clearCurrentNodes()

    const root = createRootContext(hostRoot)
    const prev = pushRoot(root)
    let nodes: Node[] = []
    try {
      let newNode: Node | Node[]

      if (value instanceof Node) {
        newNode = value
      } else if (Array.isArray(value)) {
        if (value.every(v => v instanceof Node)) {
          newNode = value as Node[]
        } else {
          if (createFn) {
            const mapped: Node[] = []
            for (const item of value) {
              mapped.push(...toNodeArray(createFn(item as any)))
            }
            newNode = mapped
          } else {
            newNode = document.createTextNode(String(value))
          }
        }
      } else {
        newNode = createFn ? createFn(value) : document.createTextNode(String(value))
      }

      nodes = toNodeArray(newNode)
      if (parentNode) {
        insertNodesBefore(parentNode, nodes, marker)
      }
    } finally {
      popRoot(prev)
      flushOnMount(root)
    }

    currentRoot = root
    currentNodes = nodes
  })

  return () => {
    dispose()
    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    clearCurrentNodes()
    if (ownsMarker) {
      marker.parentNode?.removeChild(marker)
    }
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
  parent: ParentNode & Node,
  getValue: () => FictNode,
  createElementFn: CreateElementFn,
): BindingHandle {
  const marker = document.createComment('fict:child')
  parent.appendChild(marker)
  const hostRoot = getCurrentRoot()

  const dispose = createRenderEffect(() => {
    const root = createRootContext(hostRoot)
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
// Event Delegation System
// ============================================================================

// Extend Element/Document type to support event delegation
declare global {
  interface Element {
    _$host?: Element
    [key: `$$${string}`]: EventListener | [EventListener, unknown] | undefined
    [key: `$$${string}Data`]: unknown
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Document extends Record<string, unknown> {}
}

/**
 * Initialize event delegation for a set of event names.
 * Events will be handled at the document level and dispatched to the appropriate handlers.
 *
 * @param eventNames - Array of event names to delegate
 * @param doc - The document to attach handlers to (default: window.document)
 *
 * @example
 * ```ts
 * // Called automatically by the compiler for delegated events
 * delegateEvents(['click', 'input', 'keydown'])
 * ```
 */
export function delegateEvents(eventNames: string[], doc: Document = window.document): void {
  const e = (doc[$$EVENTS] as Set<string>) || (doc[$$EVENTS] = new Set<string>())
  for (let i = 0, l = eventNames.length; i < l; i++) {
    const name = eventNames[i]!
    if (!e.has(name)) {
      e.add(name)
      doc.addEventListener(name, globalEventHandler)
    }
  }
}

/**
 * Clear all delegated event handlers from a document.
 *
 * @param doc - The document to clear handlers from (default: window.document)
 */
export function clearDelegatedEvents(doc: Document = window.document): void {
  const e = doc[$$EVENTS] as Set<string> | undefined
  if (e) {
    for (const name of e.keys()) {
      doc.removeEventListener(name, globalEventHandler)
    }
    delete doc[$$EVENTS]
  }
}

/**
 * Global event handler for delegated events.
 * Walks up the DOM tree to find and call handlers stored as $$eventName properties.
 */
function globalEventHandler(e: Event): void {
  const asNode = (value: unknown): Node | null =>
    value && typeof (value as Node).nodeType === 'number' ? (value as Node) : null
  const asElement = (value: unknown): Element | null => {
    const n = asNode(value)
    if (!n) return null
    if (n.nodeType === 1) return n as Element
    return (n as ChildNode).parentElement
  }

  let node = asElement(e.target)
  const key = `$$${e.type}` as const
  const dataKey = `${key}Data` as `$$${string}Data`
  const oriTarget = e.target
  const oriCurrentTarget = e.currentTarget
  let lastHandled: Element | null = null

  // Retarget helper for shadow DOM and portals
  const retarget = (value: EventTarget) =>
    Object.defineProperty(e, 'target', {
      configurable: true,
      value,
    })

  // Handler for each node in the bubble path
  const handleNode = (): boolean => {
    if (!node) return false
    const handler = node[key]
    if (handler && !(node as HTMLButtonElement).disabled) {
      const resolveData = (value: unknown): unknown => {
        if (typeof value === 'function') {
          try {
            const fn = value as (event?: Event) => unknown
            return fn.length > 0 ? fn(e) : fn()
          } catch {
            return (value as () => unknown)()
          }
        }
        return value
      }

      const rawData = (node as any)[dataKey] as unknown
      const hasData = rawData !== undefined
      const resolvedNodeData = hasData ? resolveData(rawData) : undefined
      // P2-3: Wrap event handler calls in batch for synchronous flush & reduced microtasks
      batch(() => {
        if (typeof handler === 'function') {
          callEventHandler(handler, e, node, hasData ? resolvedNodeData : undefined)
        } else if (Array.isArray(handler)) {
          const tupleData = resolveData(handler[1])
          callEventHandler(handler[0], e, node, tupleData)
        }
      })
      if (e.cancelBubble) return false
    }
    // Handle shadow DOM host retargeting
    const shadowHost = (node as unknown as ShadowRoot).host
    if (
      shadowHost &&
      typeof shadowHost !== 'string' &&
      !(shadowHost as Element)._$host &&
      (() => {
        const targetNode = asNode(e.target)
        return targetNode ? node.contains(targetNode) : false
      })()
    ) {
      retarget(shadowHost as EventTarget)
    }
    return true
  }

  // Walk up tree helper
  const walkUpTree = (): void => {
    while (handleNode() && node) {
      node = asElement(node._$host || node.parentNode || (node as unknown as ShadowRoot).host)
    }
  }

  // Simulate currentTarget
  Object.defineProperty(e, 'currentTarget', {
    configurable: true,
    get() {
      return node || document
    },
  })

  // Use composedPath for shadow DOM support
  if (e.composedPath) {
    const path = e.composedPath()
    retarget(path[0] as EventTarget)
    for (let i = 0; i < path.length - 2; i++) {
      const nextNode = asElement(path[i] as EventTarget)
      if (!nextNode || nextNode === lastHandled) continue
      node = nextNode
      if (!handleNode()) break
      lastHandled = node
      // Handle portal event bubbling
      if (node._$host) {
        node = node._$host
        walkUpTree()
        break
      }
      // Don't bubble above root of event delegation
      if (node.parentNode === oriCurrentTarget) {
        break
      }
    }
  } else {
    // Fallback for browsers without composedPath
    walkUpTree()
  }

  // Reset target
  retarget(oriTarget as EventTarget)
}

/**
 * Add an event listener to an element.
 * If the event is in DelegatedEvents, it uses event delegation for better performance.
 *
 * @param node - The element to add the listener to
 * @param name - The event name (lowercase)
 * @param handler - The event handler or [handler, data] tuple
 * @param delegate - Whether to use delegation (auto-detected based on event name)
 */
export function addEventListener(
  node: Element,
  name: string,
  handler: EventListener | [EventListener, unknown] | null | undefined,
  delegate?: boolean,
): void {
  if (handler == null) return

  if (delegate) {
    // Event delegation: store handler on element
    if (Array.isArray(handler)) {
      ;(node as unknown as Record<string, unknown>)[`$$${name}`] = handler[0]
      ;(node as unknown as Record<string, unknown>)[`$$${name}Data`] = handler[1]
    } else {
      ;(node as unknown as Record<string, unknown>)[`$$${name}`] = handler
    }
  } else if (Array.isArray(handler)) {
    // Non-delegated with data binding
    const handlerFn = handler[0] as (data: unknown, e: Event) => void
    node.addEventListener(name, (e: Event) => handlerFn.call(node, handler[1], e))
  } else {
    // Regular event listener
    node.addEventListener(name, handler as EventListener)
  }
}

// ============================================================================
// Event Binding
// ============================================================================

/**
 * Bind an event listener to an element.
 * Uses event delegation for better performance when applicable.
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
  el: Element,
  eventName: string,
  handler: EventListenerOrEventListenerObject | null | undefined,
  options?: boolean | AddEventListenerOptions,
): Cleanup {
  if (handler == null) return () => {}
  const rootRef = getCurrentRoot()

  // Optimization: Global Event Delegation
  // If the event is delegatable and no special options (capture, passive) are used,
  // we attach the handler to the element property and rely on the global listener.
  if (DelegatedEvents.has(eventName) && !options) {
    const key = `$$${eventName}`

    // Ensure global delegation is active for this event
    delegateEvents([eventName])

    const resolveHandler = isReactive(handler)
      ? (handler as () => EventListenerOrEventListenerObject | null | undefined)
      : () => handler

    // Cache a single wrapper that resolves the latest handler when invoked
    // @ts-expect-error - using dynamic property for delegation
    el[key] = function (this: any, ...args: any[]) {
      try {
        const fn = resolveHandler()
        callEventHandler(fn as EventListenerOrEventListenerObject, args[0] as Event, el)
      } catch (err) {
        if (!handleError(err, { source: 'event', eventName }, rootRef)) {
          throw err
        }
      }
    }

    // Cleanup: remove property (no effect needed for static or reactive)
    return () => {
      // @ts-expect-error - using dynamic property for delegation
      el[key] = undefined
    }
  }

  // Fallback: Native addEventListener
  // Used for non-delegated events or when options are present
  const getHandler = isReactive(handler) ? (handler as () => unknown) : () => handler

  // Create wrapped handler that resolves reactive handlers
  const wrapped: EventListener = event => {
    try {
      const resolved = getHandler()
      callEventHandler(resolved as EventListenerOrEventListenerObject, event, el)
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
// Ref Binding
// ============================================================================

/**
 * Bind a ref to an element.
 * Supports both callback refs and ref objects.
 *
 * @param el - The element to bind the ref to
 * @param ref - Either a callback function, a ref object, or a reactive getter
 * @returns Cleanup function
 *
 * @example
 * ```ts
 * // Callback ref
 * bindRef(el, (element) => { store.input = element })
 *
 * // Ref object
 * const inputRef = createRef()
 * bindRef(el, inputRef)
 *
 * // Reactive ref (compiler output)
 * bindRef(el, () => props.ref)
 * ```
 */
export function bindRef(el: Element, ref: unknown): Cleanup {
  if (ref == null) return () => {}

  // Handle reactive refs (getters)
  const getRef = isReactive(ref) ? (ref as () => unknown) : () => ref

  const applyRef = (refValue: unknown) => {
    if (refValue == null) return

    if (typeof refValue === 'function') {
      // Callback ref: call with element
      ;(refValue as (el: Element) => void)(el)
    } else if (typeof refValue === 'object' && 'current' in refValue) {
      // Ref object: set current property
      ;(refValue as { current: Element | null }).current = el
    }
  }

  // Apply ref initially
  const initialRef = getRef()
  applyRef(initialRef)

  // For reactive refs, track changes
  if (isReactive(ref)) {
    const cleanup = createRenderEffect(() => {
      const currentRef = getRef()
      applyRef(currentRef)
    })
    registerRootCleanup(cleanup)

    // On cleanup, null out the ref
    const nullifyCleanup = () => {
      const currentRef = getRef()
      if (currentRef && typeof currentRef === 'object' && 'current' in currentRef) {
        ;(currentRef as { current: Element | null }).current = null
      }
    }
    registerRootCleanup(nullifyCleanup)

    return () => {
      cleanup()
      nullifyCleanup()
    }
  }

  // For static refs, register cleanup to null out on unmount
  const cleanup = () => {
    const refValue = getRef()
    if (refValue && typeof refValue === 'object' && 'current' in refValue) {
      ;(refValue as { current: Element | null }).current = null
    }
  }
  registerRootCleanup(cleanup)

  return cleanup
}

// ============================================================================
// Spread Props
// ============================================================================

/**
 * Apply spread props to an element with reactive updates.
 * This handles dynamic spread like `<div {...props}>`.
 *
 * @param node - The element to apply props to
 * @param props - The props object (may have reactive getters)
 * @param isSVG - Whether this is an SVG element
 * @param skipChildren - Whether to skip children handling
 * @returns The previous props for tracking changes
 *
 * @example
 * ```ts
 * // Compiler output for <div {...props} />
 * spread(el, props, false, false)
 * ```
 */
export function spread(
  node: Element,
  props: Record<string, unknown> = {},
  isSVG = false,
  skipChildren = false,
): Record<string, unknown> {
  const prevProps: Record<string, unknown> = {}

  // Handle children if not skipped
  if (!skipChildren && 'children' in props) {
    createRenderEffect(() => {
      prevProps.children = props.children
    })
  }

  // Handle ref
  createRenderEffect(() => {
    if (typeof props.ref === 'function') {
      ;(props.ref as (el: Element) => void)(node)
    }
  })

  // Handle all other props
  createRenderEffect(() => {
    assign(node, props, isSVG, true, prevProps, true)
  })

  return prevProps
}

/**
 * Assign props to a node, tracking previous values for efficient updates.
 * This is the core prop assignment logic used by spread.
 *
 * @param node - The element to assign props to
 * @param props - New props object
 * @param isSVG - Whether this is an SVG element
 * @param skipChildren - Whether to skip children handling
 * @param prevProps - Previous props for comparison
 * @param skipRef - Whether to skip ref handling
 */
export function assign(
  node: Element,
  props: Record<string, unknown>,
  isSVG = false,
  skipChildren = false,
  prevProps: Record<string, unknown> = {},
  skipRef = false,
): void {
  props = props || {}

  // Remove props that are no longer present
  for (const prop in prevProps) {
    if (!(prop in props)) {
      if (prop === 'children') continue
      prevProps[prop] = assignProp(node, prop, null, prevProps[prop], isSVG, skipRef, props)
    }
  }

  // Set or update props
  for (const prop in props) {
    if (prop === 'children') {
      if (!skipChildren) {
        // Handle children insertion
        prevProps.children = props.children
      }
      continue
    }
    const value = props[prop]
    prevProps[prop] = assignProp(node, prop, value, prevProps[prop], isSVG, skipRef, props)
  }
}

/**
 * Assign a single prop to a node.
 */
function assignProp(
  node: Element,
  prop: string,
  value: unknown,
  prev: unknown,
  isSVG: boolean,
  skipRef: boolean,
  props: Record<string, unknown>,
): unknown {
  // Style handling
  if (prop === 'style') {
    applyStyle(node as Element & { style: CSSStyleDeclaration }, value, prev)
    return value
  }

  // classList handling
  if (prop === 'classList') {
    return applyClass(node, value, prev)
  }

  // Skip if value unchanged
  if (value === prev) return prev

  // Ref handling
  if (prop === 'ref') {
    if (!skipRef && typeof value === 'function') {
      ;(value as (el: Element) => void)(node)
    }
    return value
  }

  // Event handling: on:eventname
  if (prop.slice(0, 3) === 'on:') {
    const eventName = prop.slice(3)
    if (prev) node.removeEventListener(eventName, prev as EventListener)
    if (value) node.addEventListener(eventName, value as EventListener)
    return value
  }

  // Capture event handling: oncapture:eventname
  if (prop.slice(0, 10) === 'oncapture:') {
    const eventName = prop.slice(10)
    if (prev) node.removeEventListener(eventName, prev as EventListener, true)
    if (value) node.addEventListener(eventName, value as EventListener, true)
    return value
  }

  // Standard event handling: onClick, onInput, etc.
  if (prop.slice(0, 2) === 'on') {
    const eventName = prop.slice(2).toLowerCase()
    const shouldDelegate = DelegatedEvents.has(eventName)
    if (!shouldDelegate && prev) {
      const handler = Array.isArray(prev) ? prev[0] : prev
      node.removeEventListener(eventName, handler as EventListener)
    }
    if (shouldDelegate || value) {
      addEventListener(node, eventName, value as EventListener, shouldDelegate)
      if (shouldDelegate) delegateEvents([eventName])
    }
    return value
  }

  // Explicit attribute: attr:name
  if (prop.slice(0, 5) === 'attr:') {
    if (value == null) node.removeAttribute(prop.slice(5))
    else node.setAttribute(prop.slice(5), String(value))
    return value
  }

  // Explicit boolean attribute: bool:name
  if (prop.slice(0, 5) === 'bool:') {
    if (value) node.setAttribute(prop.slice(5), '')
    else node.removeAttribute(prop.slice(5))
    return value
  }

  // Explicit property: prop:name
  if (prop.slice(0, 5) === 'prop:') {
    ;(node as unknown as Record<string, unknown>)[prop.slice(5)] = value
    return value
  }

  // Class/className handling
  if (prop === 'class' || prop === 'className') {
    if (value == null) node.removeAttribute('class')
    else node.className = String(value)
    return value
  }

  // Check if custom element
  const isCE = node.nodeName.includes('-') || 'is' in props

  // Property handling (for non-SVG elements)
  if (!isSVG) {
    const propAlias = getPropAlias(prop, node.tagName)
    const isProperty = Properties.has(prop)
    const isChildProp = ChildProperties.has(prop)

    if (propAlias || isProperty || isChildProp || isCE) {
      const propName = propAlias || prop
      if (isCE && !isProperty && !isChildProp) {
        ;(node as unknown as Record<string, unknown>)[toPropertyName(propName)] = value
      } else {
        ;(node as unknown as Record<string, unknown>)[propName] = value
      }
      return value
    }
  }

  // SVG namespace handling
  if (isSVG && prop.indexOf(':') > -1) {
    const [prefix, name] = prop.split(':')
    const ns = SVGNamespace[prefix!]
    if (ns) {
      if (value == null) node.removeAttributeNS(ns, name!)
      else node.setAttributeNS(ns, name!, String(value))
      return value
    }
  }

  // Default: set as attribute
  const attrName = Aliases[prop] || prop
  if (value == null) node.removeAttribute(attrName)
  else node.setAttribute(attrName, String(value))
  return value
}

/**
 * Convert kebab-case to camelCase for property names
 */
function toPropertyName(name: string): string {
  return name.toLowerCase().replace(/-([a-z])/g, (_, w) => w.toUpperCase())
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
  const fragment = document.createDocumentFragment()
  fragment.append(startMarker, endMarker)
  const hostRoot = getCurrentRoot()

  let currentNodes: Node[] = []
  let currentRoot: RootContext | null = null
  let lastCondition: boolean | undefined = undefined
  let pendingRender = false

  // Use computed to memoize condition value - this prevents the effect from
  // re-running when condition dependencies change but the boolean result stays same.
  // This is critical because re-running the effect would purge child effect deps
  // (like bindText) even if we early-return, breaking fine-grained reactivity.
  const conditionMemo = computed(condition)

  const runConditional = () => {
    const cond = conditionMemo()
    const parent = startMarker.parentNode as (ParentNode & Node) | null
    if (!parent) {
      pendingRender = true
      return
    }
    pendingRender = false

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

    const render = cond ? renderTrue : renderFalse
    if (!render) {
      return
    }

    const root = createRootContext(hostRoot)
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
      insertNodesBefore(parent, nodes, endMarker)
      currentNodes = nodes
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
  }

  const dispose = createRenderEffect(runConditional)

  return {
    marker: fragment,
    flush: () => {
      if (pendingRender) {
        runConditional()
      }
    },
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
 * Create a reactive list rendering binding with optional keying.
 * The render callback receives signal accessors for the item and index.
 */
export function createList<T>(
  items: () => T[],
  renderItem: (item: Signal<T>, index: Signal<number>) => FictNode,
  createElementFn: CreateElementFn,
  getKey?: KeyFn<T>,
): BindingHandle {
  const startMarker = document.createComment('fict:list:start')
  const endMarker = document.createComment('fict:list:end')
  const fragment = document.createDocumentFragment()
  fragment.append(startMarker, endMarker)
  const hostRoot = getCurrentRoot()

  const nodeMap = new Map<string | number, ManagedBlock<T>>()
  let pendingItems: T[] | null = null

  const runListUpdate = () => {
    const arr = items()
    const parent = startMarker.parentNode as (ParentNode & Node) | null
    if (!parent) {
      pendingItems = arr
      return
    }
    pendingItems = null

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
          block = mountBlock(item, i, renderItem, parent, endMarker, createElementFn, hostRoot)
        } else {
          const previousIndex = existing.index()
          existing.value(item)
          existing.index(i)

          const needsRerender = getKey ? true : previousValue !== item || previousIndex !== i
          block = needsRerender ? rerenderBlock(existing, createElementFn) : existing
        }
      } else {
        block = mountBlock(item, i, renderItem, parent, endMarker, createElementFn, hostRoot)
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

  const dispose = createRenderEffect(runListUpdate)

  return {
    marker: fragment,
    flush: () => {
      if (pendingItems !== null) {
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
export function createShow(
  el: Element & { style: CSSStyleDeclaration },
  condition: () => boolean,
  displayValue?: string,
): void {
  const originalDisplay = displayValue ?? el.style.display
  createRenderEffect(() => {
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
  container: ParentNode & Node,
  render: () => FictNode,
  createElementFn: CreateElementFn,
): BindingHandle {
  // Capture the parent root BEFORE any effects run
  // This is needed because createRenderEffect will push/pop its own root context
  const parentRoot = getCurrentRoot()

  const marker = document.createComment('fict:portal')
  container.appendChild(marker)

  let currentNodes: Node[] = []
  let currentRoot: RootContext | null = null

  const dispose = createRenderEffect(() => {
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
    const root = createRootContext(parentRoot)
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
  // We use parentRoot (captured before createRenderEffect) to avoid registering
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
  renderItem: (item: Signal<T>, index: Signal<number>) => FictNode,
  parent: ParentNode & Node,
  anchor: Node,
  createElementFn: CreateElementFn,
  hostRoot?: RootContext | undefined,
): ManagedBlock<T> {
  const start = document.createComment('fict:block:start')
  const end = document.createComment('fict:block:end')
  const valueSig = createVersionedSignalAccessor<T>(initialValue)
  const indexSig = createSignal<number>(initialIndex)
  const renderCurrent = () => renderItem(valueSig, indexSig)
  const root = createRootContext(hostRoot)
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
    start,
    end,
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
      const props = vnode.props ?? {}

      // Update props (except children and key)
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
            ;(el as Element & { style: CSSStyleDeclaration }).style.cssText = value
          } else if (value === false || value === null || value === undefined) {
            el.removeAttribute(key)
          } else if (value === true) {
            el.setAttribute(key, '')
          } else {
            el.setAttribute(key, String(value))
          }
        }
      }

      // Handle primitive children
      if (
        typeof children === 'string' ||
        typeof children === 'number' ||
        children === null ||
        children === undefined ||
        children === false
      ) {
        el.textContent =
          children === null || children === undefined || children === false ? '' : String(children)
        return true
      }

      // Handle single nested VNode child - recursively patch
      if (
        children &&
        typeof children === 'object' &&
        !Array.isArray(children) &&
        !(children instanceof Node)
      ) {
        const childVNode = children as { type?: unknown; props?: Record<string, unknown> }
        if (typeof childVNode.type === 'string') {
          // Find matching child element in the DOM
          const childEl = el.querySelector(childVNode.type)
          if (childEl && patchElement(childEl, children as FictNode)) {
            return true
          }
        }
      }

      return false
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

// DOM utility functions are imported from './node-ops' to avoid duplication
