/**
 * Fict Reactive DOM Binding System
 *
 * This module provides the core mechanisms for reactive DOM updates.
 * It bridges the gap between Fict's reactive system (signals, effects)
 * and the DOM, enabling fine-grained updates without a virtual DOM.
 *
 * Design Philosophy:
 * - Explicitly marked getter functions are treated as reactive
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
} from './constants'
import { isNodeLike } from './dom-guards'
import { createRenderEffect } from './effect'
import { withHydration, withHydrationRange, isHydratingActive } from './hydration'
import {
  createRootContext,
  deferRootRefAssignments,
  destroyRoot,
  flushDeferredRefAssignments,
  flushOnMount,
  getCurrentRoot,
  handleError,
  handleSuspend,
  pushRoot,
  popRoot,
  queueDeferredRefAssignment,
  registerRootCleanup,
  type RootContext,
} from './lifecycle'
import { toNodeArray, removeNodes, insertNodesBefore } from './node-ops'
import { __fictIsHydrating } from './resume'
import { batch } from './scheduler'
import { computed, signal, untrack, isSignal, isComputed, isEffect, isEffectScope } from './signal'
import type { Cleanup, FictNode } from './types'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

const TEXT_CACHE = Symbol('fict:text')
const ATTR_CACHE = Symbol('fict:attr')
const PROP_CACHE = Symbol('fict:prop')
const STYLE_CACHE = Symbol('fict:style')
const CLASS_STATE_CACHE = Symbol('fict:class-state')
const CLASS_VALUE_CACHE = Symbol('fict:class-value')
const EVENT_LISTENER_CACHE = Symbol('fict:event-listener-cache')
const REF_ASSIGN_CACHE = Symbol('fict:ref-assign-cache')
const CHILDREN_BINDING_CACHE = Symbol('fict:children-binding-cache')
const NON_REACTIVE_FN_MARKER = Symbol.for('fict:non-reactive-fn')
const REACTIVE_FN_MARKER = Symbol.for('fict:reactive-fn')
const NON_REACTIVE_FN_REGISTRY_KEY = Symbol.for('fict:non-reactive-fn-registry')
const REACTIVE_FN_REGISTRY_KEY = Symbol.for('fict:reactive-fn-registry')
const PROP_GETTER_REGISTRY_KEY = Symbol.for('fict:prop-getter-registry')
const DELEGATED_DATA_ONLY_MARKER = '__fictDataOnly'

type EventHandlerTuple = [EventListenerOrEventListenerObject, unknown, string?]

type NonReactiveRegistryHost = typeof globalThis & {
  [NON_REACTIVE_FN_REGISTRY_KEY]?: WeakSet<(...args: unknown[]) => unknown>
  [REACTIVE_FN_REGISTRY_KEY]?: WeakSet<(...args: unknown[]) => unknown>
  [PROP_GETTER_REGISTRY_KEY]?: WeakSet<(...args: unknown[]) => unknown>
}

interface StoredEventListener {
  listener: EventListener
  options: boolean | AddEventListenerOptions | undefined
}

interface ChildrenBindingState {
  cleanup: Cleanup | undefined
  value: (next?: FictNode | undefined) => FictNode | void
  owner: RootContext | undefined
}

interface AssignedRefState {
  cleanup: Cleanup | undefined
  owner: RootContext | undefined
  registeredCleanup: boolean
  value: ((next?: unknown) => unknown | void) | undefined
}

type EventListenerStore = Map<string, StoredEventListener>

const PROPERTY_BINDING_KEYS = new Set([
  'value',
  'checked',
  'selected',
  'disabled',
  'readOnly',
  'multiple',
  'muted',
])

const STYLE_PROP_CACHE = new Map<string, string>()
const hasOwn = Object.prototype.hasOwnProperty

function readDangerouslySetInnerHTML(
  value: unknown,
): { found: true; html: unknown } | { found: false } {
  if (value == null || typeof value !== 'object') return { found: false }
  if (!hasOwn.call(value, '__html')) return { found: false }
  return { found: true, html: (value as Record<string, unknown>).__html }
}

function getNonReactiveFnRegistry(): WeakSet<(...args: unknown[]) => unknown> {
  const host = globalThis as NonReactiveRegistryHost
  let registry = host[NON_REACTIVE_FN_REGISTRY_KEY]
  if (!registry) {
    registry = new WeakSet<(...args: unknown[]) => unknown>()
    host[NON_REACTIVE_FN_REGISTRY_KEY] = registry
  }
  return registry
}

function getReactiveFnRegistry(): WeakSet<(...args: unknown[]) => unknown> {
  const host = globalThis as NonReactiveRegistryHost
  let registry = host[REACTIVE_FN_REGISTRY_KEY]
  if (!registry) {
    registry = new WeakSet<(...args: unknown[]) => unknown>()
    host[REACTIVE_FN_REGISTRY_KEY] = registry
  }
  return registry
}

function getPropGetterRegistry(): WeakSet<(...args: unknown[]) => unknown> {
  const host = globalThis as NonReactiveRegistryHost
  let registry = host[PROP_GETTER_REGISTRY_KEY]
  if (!registry) {
    registry = new WeakSet<(...args: unknown[]) => unknown>()
    host[PROP_GETTER_REGISTRY_KEY] = registry
  }
  return registry
}

function isExplicitReactiveFn(value: unknown): boolean {
  if (typeof value !== 'function') return false
  if (getReactiveFnRegistry().has(value as (...args: unknown[]) => unknown)) return true
  return (
    (value as ((...args: unknown[]) => unknown) & { [REACTIVE_FN_MARKER]?: boolean })[
      REACTIVE_FN_MARKER
    ] === true
  )
}

// ============================================================================
// Type Definitions
// ============================================================================

/** A reactive value that can be either static or a getter function */
export type MaybeReactive<T> = T | (() => T)

/** Internal type for createElement function reference */
export type CreateElementFn = (node: FictNode) => Node

let registeredCreateElement: CreateElementFn | undefined

export function registerCreateElement(fn: CreateElementFn): void {
  registeredCreateElement = fn
}

/** Handle returned by conditional/list bindings for cleanup */
export interface BindingHandle {
  /** Marker node(s) used for positioning */
  marker: Comment | DocumentFragment
  /** Flush pending content - call after markers are inserted into DOM */
  flush?: () => void
  /** Dispose function to clean up the binding */
  dispose: Cleanup
}

export interface ConditionalBindingOptions {
  /**
   * When true, track signal reads inside active branch render callbacks and
   * re-run the branch callback on updates even if the top-level condition stays
   * the same. This preserves reactivity for control-flow callbacks that cannot
   * be lowered into fine-grained bindings.
   */
  trackBranchReads?: boolean
}

/** Managed child node with its dispose function */
// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a value is reactive (a marked getter function that returns a value).
 *
 * A value is considered reactive if:
 * 1. It's a signal or computed value created by the runtime (marked with Symbol)
 * 2. It's a prop getter or compiler-generated getter marked by the runtime
 * 3. It's explicitly marked with reactive(fn)
 *
 * NOT considered reactive:
 * - Plain callbacks, including zero-argument callbacks
 * - Effect disposers
 * - Effect scopes
 *
 * @param value - The value to check
 * @returns true if the value is a reactive getter
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0)
 * isReactive(count)          // true - signal accessor
 * isReactive(reactive(() => 42)) // true - explicit getter
 * isReactive(() => 42)       // false - plain callback/function value
 * isReactive((x) => x)       // false - takes argument
 * isReactive('hello')        // false - not a function
 * isReactive(effectDisposer) // false - effect cleanup function
 * ```
 */
export function isReactive(value: unknown): value is () => unknown {
  if (typeof value !== 'function') return false

  // Explicit non-reactive marker always wins.
  if (isNonReactiveFn(value)) return false

  // Check for runtime-created signals/computed (most reliable)
  if (isSignal(value) || isComputed(value)) return true

  // Explicit markers for prop/compiler/user-authored reactive getters.
  if (isPropGetterFn(value) || isExplicitReactiveFn(value)) return true

  // Exclude effect disposers and effect scopes.
  if (isEffect(value) || isEffectScope(value)) return false

  return false
}

/**
 * Stricter reactive check that only considers explicitly marked values.
 * Used in DOM/event paths where regular callbacks must not be treated as
 * reactive getters.
 *
 * Only returns true for:
 * - Signal accessors (created by createSignal)
 * - Computed accessors (created by createMemo)
 * - Prop getters (marked by __fictProp)
 * - Explicitly marked getters (reactive(...))
 */
export function isStrictlyReactive(value: unknown): value is () => unknown {
  return isReactive(value)
}

// Import-like check for prop getter marker without circular dependency
const PROP_GETTER_MARKER = Symbol.for('fict:prop-getter')
function isPropGetterFn(value: unknown): boolean {
  if (typeof value !== 'function') return false
  if (getPropGetterRegistry().has(value as (...args: unknown[]) => unknown)) return true
  return (value as any)[PROP_GETTER_MARKER] === true
}

function isNonReactiveFn(value: unknown): boolean {
  if (typeof value !== 'function') return false
  if (getNonReactiveFnRegistry().has(value as (...args: unknown[]) => unknown)) return true
  return (
    (value as ((...args: unknown[]) => unknown) & { [NON_REACTIVE_FN_MARKER]?: boolean })[
      NON_REACTIVE_FN_MARKER
    ] === true
  )
}

/**
 * Mark a function as non-reactive so runtime bindings won't treat it as a getter.
 * Useful for callback props / function-as-child patterns that must remain callbacks.
 */
export function nonReactive<T extends (...args: unknown[]) => unknown>(fn: T): T {
  getNonReactiveFnRegistry().add(fn as (...args: unknown[]) => unknown)
  if (Object.isExtensible(fn)) {
    try {
      ;(fn as T & { [NON_REACTIVE_FN_MARKER]?: boolean })[NON_REACTIVE_FN_MARKER] = true
    } catch {
      // Ignore marker failures on non-standard function objects.
    }
  }
  return fn
}

/**
 * Mark a zero-arg function as an explicit reactive getter.
 * Useful when authoring runtime code manually and you need function values
 * to participate in reactive binding without relying on heuristics.
 */
export function reactive<T>(fn: () => T): () => T {
  getReactiveFnRegistry().add(fn as (...args: unknown[]) => unknown)
  if (Object.isExtensible(fn)) {
    try {
      ;(fn as (() => T) & { [REACTIVE_FN_MARKER]?: boolean })[REACTIVE_FN_MARKER] = true
    } catch {
      // Ignore marker failures on non-standard function objects.
    }
  }
  return fn
}

/**
 * Mark a compiler-generated getter as reactive.
 * @internal Compiler/runtime ABI helper; use reactive(fn) in user-authored code.
 */
export function __fictReactive<T>(fn: () => T): () => T {
  return reactive(fn)
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
  dataOnly = false,
): void {
  if (!handler) return

  const context = (node ?? event.currentTarget ?? undefined) as EventTarget | undefined
  const hasData = dataOnly || data !== undefined
  const invoke = (fn: EventListenerOrEventListenerObject | null | undefined): void => {
    if (typeof fn === 'function') {
      const result = !hasData
        ? (fn as EventListener).call(context, event)
        : dataOnly
          ? (fn as (data: unknown) => unknown).call(context, data)
          : (fn as (data: unknown, e: Event) => unknown).call(context, data, event)

      if (typeof result === 'function' && result !== fn) {
        if (!hasData) {
          ;(result as EventListener).call(context, event)
        } else if (dataOnly) {
          ;(result as (data: unknown) => unknown).call(context, data)
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
 * // Reactive text
 * createTextBinding(reactive(() => $count()))
 * ```
 */
export function createTextBinding(
  value: MaybeReactive<unknown>,
  owner?: Document | Node | null,
): Text {
  const textOwnerDocument =
    owner && 'nodeType' in owner
      ? owner.nodeType === 9
        ? (owner as Document)
        : ((owner as Node).ownerDocument ?? document)
      : document
  const text = textOwnerDocument.createTextNode('')

  if (isReactive(value)) {
    // Reactive: create effect to update text when value changes
    createRenderEffect(() => {
      setText(text, (value as () => unknown)())
    })
  } else {
    // Static: set once
    setText(text, value)
  }

  return text
}

/**
 * Bind a reactive value to an existing text node.
 * This is a convenience function for binding to existing DOM nodes.
 */
export function bindText(textNode: Text, getValue: () => unknown): Cleanup {
  return createRenderEffect(() => setText(textNode, getValue()))
}

/**
 * Patch text node content with per-node value caching.
 * This is the low-level primitive used by compiled render effects.
 */
export function setText(textNode: Text, value: unknown): void {
  const next = formatTextValue(value)
  const cache = textNode as unknown as Record<PropertyKey, unknown>
  const prev = cache[TEXT_CACHE]
  if (prev === next && textNode.data === next) return
  cache[TEXT_CACHE] = next
  if (textNode.data !== next) {
    textNode.data = next
  }
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
 * // Reactive attribute
 * createAttributeBinding(button, 'disabled', reactive(() => !$isValid()), setAttribute)
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
  return createRenderEffect(() => setAttr(el, key, getValue()))
}

/**
 * Patch attribute value with per-node, per-attribute cache.
 */
export function setAttr(el: Element, key: string, value: unknown): void {
  const cacheTarget = el as unknown as Record<PropertyKey, unknown>
  const attrCache =
    (cacheTarget[ATTR_CACHE] as Record<string, unknown> | undefined) ??
    (cacheTarget[ATTR_CACHE] = Object.create(null))
  if (attrCache[key] === value) return
  attrCache[key] = value

  if (value === undefined || value === null || value === false) {
    el.removeAttribute(key)
  } else if (value === true) {
    el.setAttribute(key, '')
  } else {
    el.setAttribute(key, String(value))
  }
}

/**
 * Bind a reactive value to an element's property.
 */
export function bindProperty(el: Element, key: string, getValue: () => unknown): Cleanup {
  return createRenderEffect(() => setProp(el, key, getValue()))
}

/**
 * Patch DOM property with per-node, per-property cache.
 */
export function setProp(el: Element, key: string, value: unknown): void {
  const cacheTarget = el as unknown as Record<PropertyKey, unknown>
  const propCache =
    (cacheTarget[PROP_CACHE] as Record<string, unknown> | undefined) ??
    (cacheTarget[PROP_CACHE] = Object.create(null))
  if (propCache[key] === value) return
  propCache[key] = value

  if (PROPERTY_BINDING_KEYS.has(key) && (value === undefined || value === null)) {
    const fallback = key === 'checked' || key === 'selected' ? false : ''
    ;(el as unknown as Record<string, unknown>)[key] = fallback
    return
  }
  ;(el as unknown as Record<string, unknown>)[key] = value
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
  if (isReactive(value)) {
    createRenderEffect(() => {
      setStyle(el, (value as () => unknown)() as string | Record<string, string | number> | null)
    })
  } else {
    setStyle(el, value)
  }
}

/**
 * Bind a reactive style value to an existing element.
 */
export function bindStyle(
  el: Element,
  getValue: () => string | Record<string, string | number> | null | undefined,
): Cleanup {
  return createRenderEffect(() => setStyle(el, getValue()))
}

/**
 * Patch style value with cached previous style payload.
 */
export function setStyle(
  el: Element,
  value: string | Record<string, string | number> | null | undefined,
): void {
  const target = el as Element & { style: CSSStyleDeclaration }
  const cache = target as unknown as Record<PropertyKey, unknown>
  const prev = cache[STYLE_CACHE]
  if (typeof value === 'string' && prev === value) return
  if ((value === null || value === undefined) && (prev === null || prev === undefined)) return
  applyStyle(target, value, prev)
  cache[STYLE_CACHE] = value
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
      for (const key in prevStyles) {
        if (!hasOwn.call(prevStyles, key)) continue
        if (!hasOwn.call(styles, key)) {
          const cssProperty = normalizeStyleProperty(key)
          el.style.removeProperty(cssProperty)
        }
      }
    }

    for (const prop in styles) {
      if (!hasOwn.call(styles, prop)) continue
      const v = styles[prop]
      if (v != null) {
        const cssProperty = normalizeStyleProperty(prop)
        const unitless = isUnitlessStyleProperty(prop) || isUnitlessStyleProperty(cssProperty)
        const valueStr = typeof v === 'number' && !unitless ? `${v}px` : String(v)
        el.style.setProperty(cssProperty, valueStr)
      } else {
        const cssProperty = normalizeStyleProperty(prop)
        el.style.removeProperty(cssProperty) // Handle null/undefined values by removing
      }
    }
  } else {
    // If value is null/undefined, we might want to clear styles set by PREVIOUS binding?
    // But blindly clearing cssText is dangerous.
    // Ideally we remove keys from prev.
    if (prev && typeof prev === 'object') {
      const prevStyles = prev as Record<string, string | number>
      for (const key in prevStyles) {
        if (!hasOwn.call(prevStyles, key)) continue
        const cssProperty = normalizeStyleProperty(key)
        el.style.removeProperty(cssProperty)
      }
    } else if (typeof prev === 'string') {
      el.style.cssText = ''
    }
  }
}

const isUnitlessStyleProperty = isDev
  ? (prop: string): boolean => UnitlessStyles.has(prop)
  : (prop: string): boolean => prop === 'opacity' || prop === 'zIndex'

function normalizeStyleProperty(prop: string): string {
  const cached = STYLE_PROP_CACHE.get(prop)
  if (cached) return cached
  const normalized = prop.includes('-') ? prop : prop.replace(/([A-Z])/g, '-$1').toLowerCase()
  STYLE_PROP_CACHE.set(prop, normalized)
  return normalized
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
    createRenderEffect(() =>
      setClass(el, (value as () => string | Record<string, boolean> | null | undefined)()),
    )
  } else {
    setClass(el, value)
  }
}

/**
 * Bind a reactive class value to an existing element.
 */
export function bindClass(
  el: Element,
  getValue: () => string | Record<string, boolean> | null | undefined,
): Cleanup {
  return createRenderEffect(() => setClass(el, getValue()))
}

/**
 * Patch class value using per-node cached class state.
 */
export function setClass(
  el: Element,
  value: string | Record<string, boolean> | null | undefined,
): void {
  const cache = el as unknown as Record<PropertyKey, unknown>
  const prevValue = cache[CLASS_VALUE_CACHE]
  const prevState = (cache[CLASS_STATE_CACHE] as Record<string, boolean> | undefined) ?? {}

  // Preserve existing behavior: short-circuit only for stable string values.
  if (typeof value === 'string') {
    if (typeof prevValue === 'string' && prevValue === value) return
    el.className = value
    cache[CLASS_STATE_CACHE] = {}
    cache[CLASS_VALUE_CACHE] = value
    return
  }

  cache[CLASS_STATE_CACHE] = applyClass(el, value, prevState)
  cache[CLASS_VALUE_CACHE] = value
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
  const parentOwnerDocument = parent.ownerDocument ?? document
  let marker: Node
  let ownsMarker = false
  let createFn: CreateElementFn | undefined = createElementFn

  if (isNodeLike(markerOrCreateElement, parentOwnerDocument)) {
    marker = markerOrCreateElement
    createFn = createElementFn
  } else {
    marker = parentOwnerDocument.createComment('fict:insert')
    parent.appendChild(marker)
    createFn = markerOrCreateElement as CreateElementFn | undefined
    ownsMarker = true
  }
  const markerOwnerDocument = marker.ownerDocument ?? parentOwnerDocument

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
      currentText = (parentNode.ownerDocument ?? markerOwnerDocument).createTextNode(textValue)
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
    const insertedNodes = insertNodesBefore(parentNode, [currentText], marker)
    currentText = (insertedNodes[0] as Text | undefined) ?? currentText
    currentNodes = insertedNodes
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
    let nodes: Node[]
    let handledError = false
    try {
      let newNode: Node | Node[]
      const ownerDocument = parentNode?.ownerDocument ?? markerOwnerDocument

      if (isNodeLike(value, ownerDocument)) {
        newNode = value
      } else if (Array.isArray(value)) {
        if (value.every(v => isNodeLike(v, ownerDocument))) {
          newNode = value as Node[]
        } else {
          if (createFn) {
            const mapped: Node[] = []
            for (const item of value) {
              mapped.push(...toNodeArray(createFn(item as any), ownerDocument))
            }
            newNode = mapped
          } else {
            newNode = ownerDocument.createTextNode(String(value))
          }
        }
      } else {
        newNode = createFn ? createFn(value) : ownerDocument.createTextNode(String(value))
      }

      nodes = toNodeArray(newNode, ownerDocument)
      if (root.suspended) {
        handledError = true
        destroyRoot(root)
        return
      }
      if (parentNode) {
        nodes = insertNodesBefore(parentNode, nodes, marker)
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

    // If we reach here, no error was handled (handledError blocks return early)
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
 * Insert reactive content between two marker comments.
 * Supports hydration by claiming existing nodes between markers.
 */
export function insertBetween(
  start: Comment,
  end: Comment,
  getValue: () => FictNode,
  createElementFn?: CreateElementFn,
): Cleanup {
  const hostRoot = getCurrentRoot()
  const markerOwnerDocument = start.ownerDocument ?? end.ownerDocument ?? document
  let currentNodes: Node[] = []
  let currentText: Text | null = null
  let currentRoot: RootContext | null = null
  let initialHydrating = __fictIsHydrating()

  const collectBetween = (): Node[] => {
    const nodes: Node[] = []
    let cursor = start.nextSibling
    while (cursor && cursor !== end) {
      nodes.push(cursor)
      cursor = cursor.nextSibling
    }
    return nodes
  }

  const clearCurrentNodes = () => {
    if (currentNodes.length > 0) {
      removeNodes(currentNodes)
      currentNodes = []
    }
  }

  const setTextNode = (textValue: string, shouldInsert: boolean) => {
    const parentNode = start.parentNode as (ParentNode & Node) | null
    if (!currentText) {
      currentText = (parentNode?.ownerDocument ?? markerOwnerDocument).createTextNode(textValue)
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
    if (parentNode) {
      const insertedNodes = insertNodesBefore(parentNode, [currentText], end)
      currentText = (insertedNodes[0] as Text | undefined) ?? currentText
      currentNodes = insertedNodes
    }
  }

  const dispose = createRenderEffect(() => {
    const value = getValue()
    const parentNode = start.parentNode as (ParentNode & Node) | null
    const isPrimitive =
      value == null ||
      value === false ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'

    if (isPrimitive) {
      if (initialHydrating && isHydratingActive() && parentNode) {
        const existing = collectBetween()
        if (existing.length > 0) {
          currentNodes = existing
          const only = existing.length === 1 ? existing[0] : null
          currentText = only && only.nodeType === 3 ? (only as Text) : null
        }
      }
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
      setTextNode(textValue, shouldInsert)
      initialHydrating = false
      return
    }

    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    clearCurrentNodes()

    const root = createRootContext(hostRoot)
    const prev = pushRoot(root)
    let nodes: Node[]
    let handledError = false
    try {
      let newNode: Node | Node[] = undefined as unknown as Node | Node[]
      const ownerDocument = parentNode?.ownerDocument ?? markerOwnerDocument
      const createValue = () => {
        if (isNodeLike(value, ownerDocument)) {
          return value
        }
        if (Array.isArray(value)) {
          if (value.every(v => isNodeLike(v, ownerDocument))) {
            return value as Node[]
          }
          if (createElementFn) {
            const mapped: Node[] = []
            for (const item of value) {
              mapped.push(...toNodeArray(createElementFn(item as any), ownerDocument))
            }
            return mapped
          }
          return ownerDocument.createTextNode(String(value))
        }
        return createElementFn
          ? createElementFn(value)
          : ownerDocument.createTextNode(String(value))
      }

      if (initialHydrating && isHydratingActive() && parentNode) {
        withHydrationRange(
          start.nextSibling,
          end,
          parentNode.ownerDocument ?? markerOwnerDocument,
          () => {
            newNode = createValue()
          },
        )
      } else {
        newNode = createValue()
      }

      nodes = toNodeArray(newNode, ownerDocument)
      if (root.suspended) {
        handledError = true
        destroyRoot(root)
        return
      }
      if (parentNode && !initialHydrating) {
        nodes = insertNodesBefore(parentNode, nodes, end)
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

    currentRoot = root
    currentNodes = initialHydrating ? collectBetween() : nodes
    initialHydrating = false
  })

  return () => {
    dispose()
    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    clearCurrentNodes()
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
  const marker = (parent.ownerDocument ?? document).createComment('fict:child')
  parent.appendChild(marker)
  const hostRoot = getCurrentRoot()

  const dispose = createRenderEffect(() => {
    const root = createRootContext(hostRoot)
    const prev = pushRoot(root)
    let nodes: Node[] = []
    let handledError = false
    let keepRoot = false
    try {
      const value = getValue()

      // Skip if value is null/undefined/false
      if (value == null || value === false) {
        destroyRoot(root)
        return
      }

      const output = createElementFn(value)
      nodes = toNodeArray(output, marker.ownerDocument ?? parent.ownerDocument ?? document)
      const parentNode = marker.parentNode as (ParentNode & Node) | null
      if (parentNode) {
        nodes = insertNodesBefore(parentNode, nodes, marker)
      }
      keepRoot = true
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
      if (!handledError && keepRoot) {
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
      const rawData = (node as any)[dataKey] as unknown
      const hasData = rawData !== undefined
      const resolvedNodeData = hasData ? resolveEventData(rawData, e) : undefined
      // Wrap event handler calls in batch for synchronous flush & reduced microtasks
      batch(() => {
        if (typeof handler === 'function') {
          callEventHandler(handler, e, node, hasData ? resolvedNodeData : undefined)
        } else if (Array.isArray(handler)) {
          const tupleHandler = resolveEventHandlerValue(
            handler[0] as EventListenerOrEventListenerObject | null | undefined,
          )
          const tupleData = resolveEventData(handler[1], e)
          callEventHandler(tupleHandler, e, node, tupleData)
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
      return node || oriCurrentTarget || asNode(oriTarget)?.ownerDocument || document
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
  handler: EventListenerOrEventListenerObject | EventHandlerTuple | null | undefined,
  delegate?: boolean,
  options?: boolean | AddEventListenerOptions,
): void {
  if (delegate) {
    const key = `$$${name}`
    const dataKey = `${key}Data`
    const rootRef = getCurrentRoot()
    const delegationDocument = resolveDelegationDocument(node, rootRef)

    delegateEvents([name], delegationDocument)

    if (handler == null) {
      ;(node as unknown as Record<string, unknown>)[key] = undefined
      ;(node as unknown as Record<string, unknown>)[dataKey] = undefined
      return
    }

    ;(node as unknown as Record<string, unknown>)[key] = createEventInvoker(
      name,
      handler,
      node,
      rootRef,
    )
    ;(node as unknown as Record<string, unknown>)[dataKey] = undefined
    return
  }

  removeStoredEventListener(node, name, options)
  if (handler == null) return

  const rootRef = getCurrentRoot()
  const wrapped = createEventInvoker(name, handler, node, rootRef)
  node.addEventListener(name, wrapped, options)
  getStoredEventListenerStore(node).set(getEventListenerStoreKey(name, options), {
    listener: wrapped,
    options,
  })
}

function resolveDelegationDocument(node: Element, rootRef: RootContext | undefined): Document {
  const nodeDocument = node.ownerDocument ?? undefined
  if (rootRef?.ownerDocument && nodeDocument?.defaultView == null) {
    return rootRef.ownerDocument
  }
  return nodeDocument ?? rootRef?.ownerDocument ?? document
}

function getStoredEventListenerStore(node: Element): EventListenerStore {
  const host = node as unknown as {
    [EVENT_LISTENER_CACHE]?: EventListenerStore
  }
  if (!host[EVENT_LISTENER_CACHE]) {
    host[EVENT_LISTENER_CACHE] = new Map<string, StoredEventListener>()
  }
  return host[EVENT_LISTENER_CACHE]!
}

function getEventListenerStoreKey(
  name: string,
  options?: boolean | AddEventListenerOptions,
): string {
  const capture = typeof options === 'boolean' ? options : options?.capture === true
  const passive = typeof options === 'object' && options?.passive === true
  const once = typeof options === 'object' && options?.once === true
  return `${name}:${capture ? 1 : 0}:${passive ? 1 : 0}:${once ? 1 : 0}`
}

function removeStoredEventListener(
  node: Element,
  name: string,
  options?: boolean | AddEventListenerOptions,
): void {
  const host = node as unknown as {
    [EVENT_LISTENER_CACHE]?: EventListenerStore
  }
  const store = host[EVENT_LISTENER_CACHE]
  if (!store) return

  const entry = store.get(getEventListenerStoreKey(name, options))
  if (!entry) return

  node.removeEventListener(name, entry.listener, entry.options)
  store.delete(getEventListenerStoreKey(name, options))
  if (store.size === 0) {
    delete host[EVENT_LISTENER_CACHE]
  }
}

function resolveEventData(value: unknown, event: Event): unknown {
  if (typeof value !== 'function') return value
  if (isReactive(value)) {
    return (value as () => unknown)()
  }
  try {
    const fn = value as (event?: Event) => unknown
    return fn.length > 0 ? fn(event) : fn()
  } catch {
    return (value as () => unknown)()
  }
}

function resolveEventHandlerValue(
  value: EventListenerOrEventListenerObject | null | undefined,
): EventListenerOrEventListenerObject | null | undefined {
  if (isStrictlyReactive(value)) {
    return (value as () => EventListenerOrEventListenerObject | null | undefined)()
  }
  return value
}

function createEventInvoker(
  eventName: string,
  handler: EventListenerOrEventListenerObject | EventHandlerTuple | null | undefined,
  node: Element,
  rootRef: RootContext | undefined,
): EventListener {
  return (event: Event) => {
    try {
      if (Array.isArray(handler)) {
        const resolvedHandler = resolveEventHandlerValue(
          handler[0] as EventListenerOrEventListenerObject | null | undefined,
        )
        const data = resolveEventData(handler[1], event)
        callEventHandler(
          resolvedHandler,
          event,
          node,
          data,
          handler[2] === DELEGATED_DATA_ONLY_MARKER,
        )
        return
      }

      const resolvedHandler = resolveEventHandlerValue(
        handler as EventListenerOrEventListenerObject | null | undefined,
      )
      callEventHandler(resolvedHandler, event, node)
    } catch (err) {
      if (handleError(err, { source: 'event', eventName }, rootRef)) {
        return
      }
      throw err
    }
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
 * // Reactive event handler accessor
 * bindEvent(button, 'click', reactive(() => $handler()))
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

  // Optimization: Global Event Delegation
  // If the event is delegatable and no options were provided,
  // we attach the handler to the element property and rely on the global listener.
  const shouldDelegate = options == null && DelegatedEvents.has(eventName)
  if (shouldDelegate) {
    addEventListener(el, eventName, handler, true)

    // Cleanup: remove property (no effect needed for static or reactive)
    return () => {
      addEventListener(el, eventName, null, true)
    }
  }

  addEventListener(
    el,
    eventName,
    handler as EventListenerOrEventListenerObject | null | undefined,
    false,
    options,
  )
  const cleanup = () => removeStoredEventListener(el, eventName, options)
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
 * // Reactive ref accessor
 * bindRef(el, reactive(() => props.ref))
 * ```
 */
export function bindRef(el: Element, ref: unknown, registerCleanup = true): Cleanup {
  if (ref == null) return () => {}

  const getRef = isReactive(ref) ? (ref as () => unknown) : () => ref
  let currentRef: unknown

  const applyRefValue = (refValue: unknown, value: Element | null) => {
    if (refValue == null) return
    if (typeof refValue === 'function') {
      ;(refValue as (el: Element | null) => void)(value)
    } else if (typeof refValue === 'object' && 'current' in refValue) {
      ;(refValue as { current: Element | null }).current = value
    }
  }

  const clearCurrentRef = () => {
    if (currentRef == null) return
    if (currentRefApplied) {
      applyRefValue(currentRef, null)
    }
    currentRef = undefined
    currentRefApplied = false
  }

  let currentRefApplied = false

  const syncRef = (nextRef: unknown) => {
    if (nextRef === currentRef) return
    clearCurrentRef()
    currentRef = nextRef
    const applyCurrentRef = () => {
      if (currentRef !== nextRef || currentRefApplied) return
      applyRefValue(nextRef, el)
      currentRefApplied = true
    }
    if (!queueDeferredRefAssignment(applyCurrentRef)) {
      applyCurrentRef()
    }
  }

  let disposeTracking: Cleanup | undefined
  if (isReactive(ref)) {
    disposeTracking = createRenderEffect(() => {
      syncRef(getRef())
    })
  } else {
    syncRef(getRef())
  }

  if (registerCleanup) {
    registerRootCleanup(clearCurrentRef)
  }

  return () => {
    disposeTracking?.()
    clearCurrentRef()
  }
}

function resolveAssignedChildrenValue(value: FictNode | undefined): FictNode {
  if (typeof value === 'function') {
    return isReactive(value) ? (value as () => FictNode)() : null
  }
  return value ?? null
}

function resolveAssignedRefValue(value: unknown): unknown {
  if (isReactive(value)) {
    return (value as () => unknown)()
  }
  return value
}

function createAssignedRefState(
  node: Element,
  owner: RootContext | undefined,
  initialValue: unknown,
): AssignedRefState {
  const valueSignal = signal<unknown>(initialValue)
  let currentRef: unknown

  const applyRefValue = (refValue: unknown, value: Element | null) => {
    if (refValue == null) return
    if (typeof refValue === 'function') {
      ;(refValue as (el: Element | null) => void)(value)
    } else if (typeof refValue === 'object' && 'current' in refValue) {
      ;(refValue as { current: Element | null }).current = value
    }
  }

  const clearCurrentRef = () => {
    if (currentRef == null) return
    applyRefValue(currentRef, null)
    currentRef = undefined
  }

  const syncRef = (nextRef: unknown) => {
    if (nextRef === currentRef) return
    clearCurrentRef()
    currentRef = nextRef
    applyRefValue(currentRef, node)
  }

  const disposeTracking = createRenderEffect(() => {
    syncRef(resolveAssignedRefValue(valueSignal() as unknown))
  })

  return {
    cleanup: () => {
      disposeTracking()
      clearCurrentRef()
    },
    owner,
    registeredCleanup: false,
    value: (next?: unknown) => {
      valueSignal(next)
      syncRef(resolveAssignedRefValue(next))
    },
  }
}

function bindAssignedChildren(
  node: Element,
  getValue: () => FictNode,
  createElementFn?: CreateElementFn,
): Cleanup {
  const hostRoot = getCurrentRoot()
  const createFn = createElementFn ?? registeredCreateElement
  let currentNodes: Node[] = []
  let currentText: Text | null = null
  let currentRoot: RootContext | null = null
  let initialHydrating = __fictIsHydrating()

  const collectCurrentChildren = (): Node[] => Array.from(node.childNodes)

  const clearCurrentNodes = () => {
    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    if (currentNodes.length > 0) {
      removeNodes(currentNodes)
      currentNodes = []
    }
    currentText = null
  }

  const setTextNode = (textValue: string, shouldInsert: boolean) => {
    if (!shouldInsert) {
      clearCurrentNodes()
      if (node.childNodes.length > 0) {
        node.replaceChildren()
      }
      initialHydrating = false
      return
    }

    if (initialHydrating && isHydratingActive()) {
      const hydratedNodes = collectCurrentChildren()
      if (hydratedNodes.length === 1 && hydratedNodes[0]?.nodeType === 3) {
        const hydratedText = hydratedNodes[0] as Text
        if (hydratedText.data !== textValue) {
          hydratedText.data = textValue
        }
        currentText = hydratedText
        currentNodes = [hydratedText]
        initialHydrating = false
        return
      }
    }

    const textNode = currentText ?? (node.ownerDocument ?? document).createTextNode(textValue)
    if (textNode.data !== textValue) {
      textNode.data = textValue
    }

    if (currentNodes.length === 1 && currentNodes[0] === textNode) {
      currentText = textNode
      return
    }

    if (currentRoot) {
      destroyRoot(currentRoot)
      currentRoot = null
    }
    if (currentNodes.length > 0) {
      removeNodes(currentNodes)
      currentNodes = []
    }

    node.replaceChildren(textNode)
    currentText = textNode
    currentNodes = [textNode]
    initialHydrating = false
  }

  const dispose = createRenderEffect(() => {
    const value = getValue()
    const isPrimitive =
      value == null ||
      value === false ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'

    if (isPrimitive) {
      const textValue = value == null || value === false ? '' : String(value)
      const shouldInsert = value != null && value !== false
      setTextNode(textValue, shouldInsert)
      return
    }

    clearCurrentNodes()

    const root = createRootContext(hostRoot)
    const prev = pushRoot(root)
    let nodes: Node[]
    let currentHydratedNodes: Node[] | undefined
    let handledError = false
    try {
      const ownerDocument = node.ownerDocument ?? hostRoot?.ownerDocument ?? document
      const createValue = () => {
        if (isNodeLike(value, ownerDocument)) {
          return value
        }
        if (Array.isArray(value)) {
          if (value.every(v => isNodeLike(v, ownerDocument))) {
            return value as Node[]
          }
          if (createFn) {
            const mapped: Node[] = []
            for (const item of value) {
              mapped.push(...toNodeArray(createFn(item as any), ownerDocument))
            }
            return mapped
          }
          return ownerDocument.createTextNode(String(value))
        }
        return createFn ? createFn(value) : ownerDocument.createTextNode(String(value))
      }

      const newNode =
        initialHydrating && isHydratingActive()
          ? withHydration(node, () => createValue())
          : createValue()

      nodes = toNodeArray(newNode, ownerDocument)
      if (root.suspended) {
        handledError = true
        destroyRoot(root)
        return
      }

      if (initialHydrating) {
        const hydratedNodes = collectCurrentChildren()
        const reuseHydratedNodes =
          hydratedNodes.length === nodes.length &&
          nodes.every((candidate, index) => candidate === hydratedNodes[index])
        if (reuseHydratedNodes) {
          currentHydratedNodes = hydratedNodes
        } else {
          node.replaceChildren(...nodes)
        }
      } else {
        node.replaceChildren(...nodes)
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

    currentRoot = root
    currentNodes = currentHydratedNodes ?? nodes
    initialHydrating = false
  })

  return () => {
    dispose()
    clearCurrentNodes()
  }
}

function updateChildrenBinding(
  node: Element,
  value: FictNode | undefined,
  createElementFn?: CreateElementFn,
): void {
  const host = node as {
    [CHILDREN_BINDING_CACHE]?: ChildrenBindingState
  }
  const createFn = createElementFn ?? registeredCreateElement
  const owner = getCurrentRoot()
  let state = host[CHILDREN_BINDING_CACHE]

  if (state && state.owner !== owner) {
    state.cleanup?.()
    state.cleanup = undefined
    delete host[CHILDREN_BINDING_CACHE]
    state = undefined
  }

  if (!state) {
    const valueSignal = signal<FictNode | undefined>(value)
    const cleanup = bindAssignedChildren(
      node,
      () => resolveAssignedChildrenValue(valueSignal() as FictNode | undefined),
      createFn,
    )
    const nextState: ChildrenBindingState = {
      cleanup,
      owner,
      value: valueSignal,
    }
    state = nextState
    host[CHILDREN_BINDING_CACHE] = nextState
    registerRootCleanup(() => {
      state?.cleanup?.()
      if (state) {
        state.cleanup = undefined
      }
      if (host[CHILDREN_BINDING_CACHE] === state) {
        delete host[CHILDREN_BINDING_CACHE]
      }
    })
    return
  }

  state.value(value)
}

function updateAssignedRefBinding(node: Element, value: unknown): void {
  const host = node as {
    [REF_ASSIGN_CACHE]?: AssignedRefState
  }
  const owner = getCurrentRoot()
  let state = host[REF_ASSIGN_CACHE]

  if (state && state.owner !== owner) {
    state.cleanup?.()
    state.cleanup = undefined
    delete host[REF_ASSIGN_CACHE]
    state = undefined
  }

  if (!state && value == null) {
    return
  }

  if (!state) {
    state = createAssignedRefState(node, owner, value)
    host[REF_ASSIGN_CACHE] = state
  }

  state.value?.(value)

  if (value == null) {
    if (!state.registeredCleanup) {
      state.cleanup?.()
      state.cleanup = undefined
      delete host[REF_ASSIGN_CACHE]
    }
    return
  }

  if (!state.registeredCleanup && getCurrentRoot()) {
    state.registeredCleanup = true
    registerRootCleanup(() => {
      state.cleanup?.()
      state.cleanup = undefined
      state.value = undefined
      if (host[REF_ASSIGN_CACHE] === state) {
        delete host[REF_ASSIGN_CACHE]
      }
    })
  }
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
  props: Record<string, unknown> | (() => Record<string, unknown>) = {},
  isSVG = false,
  skipChildren = false,
  exclude: readonly string[] = [],
): Record<string, unknown> {
  const prevProps: Record<string, unknown> = {}
  const excludedProps = exclude.length > 0 ? new Set(exclude) : undefined
  const resolveProps = (): Record<string, unknown> => {
    const next = typeof props === 'function' ? (props as () => Record<string, unknown>)() : props
    if (!next || typeof next !== 'object') return {}
    return next
  }

  // Handle ref
  bindRef(
    node,
    (typeof props === 'function' ? reactive(() => resolveProps().ref) : resolveProps().ref) ?? null,
  )

  // Handle all other props
  createRenderEffect(() => {
    assign(node, resolveProps(), isSVG, skipChildren, prevProps, true, excludedProps)
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
  excludedProps?: ReadonlySet<string>,
): void {
  props = props || {}

  // Remove props that are no longer present
  for (const prop in prevProps) {
    if (excludedProps?.has(prop)) continue
    if (!(prop in props)) {
      if (prop === 'children') {
        if (!skipChildren) {
          updateChildrenBinding(node, undefined)
          prevProps.children = undefined
        }
        continue
      }
      prevProps[prop] = assignProp(node, prop, null, prevProps[prop], isSVG, skipRef, props)
    }
  }

  // Set or update props
  for (const prop in props) {
    if (excludedProps?.has(prop)) continue
    const value = props[prop]
    if (prop === 'children') {
      if (!skipChildren) {
        updateChildrenBinding(node, value as FictNode | undefined)
        prevProps.children = props.children
      }
      continue
    }
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

  // Class/className handling
  if (prop === 'class' || prop === 'className') {
    if (value == null) {
      node.removeAttribute('class')
    } else {
      setClass(node, value as string | Record<string, boolean>)
    }
    return value
  }

  if (prop === 'dangerouslySetInnerHTML') {
    const htmlValue = readDangerouslySetInnerHTML(value)
    if (htmlValue.found) {
      const nextHtml = isReactive(htmlValue.html) ? htmlValue.html() : htmlValue.html
      setProp(node, 'innerHTML', nextHtml)
    } else if (value == null && prev !== undefined) {
      setProp(node, 'innerHTML', '')
    }
    return value
  }

  // Skip if value unchanged
  if (value === prev) return prev

  // Ref handling
  if (prop === 'ref') {
    if (!skipRef) {
      updateAssignedRefBinding(node, value)
    }
    return value
  }

  // Event handling: on:eventname
  if (prop.slice(0, 3) === 'on:') {
    const eventName = prop.slice(3)
    if (typeof value === 'string') {
      node.setAttribute(prop, value)
      return value
    }
    if (prev && typeof prev !== 'string') removeStoredEventListener(node, eventName)
    addEventListener(
      node,
      eventName,
      value as EventListenerOrEventListenerObject | EventHandlerTuple | null | undefined,
      false,
    )
    return value
  }

  // Capture event handling: oncapture:eventname
  if (prop.slice(0, 10) === 'oncapture:') {
    const eventName = prop.slice(10)
    if (prev) removeStoredEventListener(node, eventName, true)
    addEventListener(
      node,
      eventName,
      value as EventListenerOrEventListenerObject | EventHandlerTuple | null | undefined,
      false,
      true,
    )
    return value
  }

  // Standard event handling: onClick, onInput, etc.
  if (prop.slice(0, 2) === 'on') {
    const eventName = prop.slice(2).toLowerCase()
    const shouldDelegate = DelegatedEvents.has(eventName)
    if (!shouldDelegate && prev) {
      removeStoredEventListener(node, eventName)
    }
    if (shouldDelegate || value) {
      addEventListener(
        node,
        eventName,
        value as EventListenerOrEventListenerObject | EventHandlerTuple | null | undefined,
        shouldDelegate,
        false,
      )
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

  // Check if custom element
  const isCE = node.nodeName.includes('-') || 'is' in props

  // Property handling (for non-SVG elements)
  if (!isSVG) {
    const propAlias = isDev ? getPropAlias(prop, node.tagName) : undefined
    const isProperty = isDev
      ? Properties.has(prop)
      : prop in (node as unknown as Record<string, unknown>)
    const isChildProp = isDev
      ? ChildProperties.has(prop)
      : prop === 'innerHTML' ||
        prop === 'textContent' ||
        prop === 'innerText' ||
        prop === 'children'

    if (propAlias || isProperty || isChildProp || isCE) {
      const propName = propAlias || prop
      if (isCE && !isProperty && !isChildProp && !propAlias) {
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
  const attrName = prop === 'htmlFor' ? 'for' : prop
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
  startOverride?: Comment,
  endOverride?: Comment,
  options?: ConditionalBindingOptions,
): BindingHandle {
  const trackBranchReads = options?.trackBranchReads === true
  const hostRoot = getCurrentRoot()
  const useProvided = !!(startOverride && endOverride)
  const markerOwnerDocument =
    startOverride?.ownerDocument ??
    endOverride?.ownerDocument ??
    hostRoot?.ownerDocument ??
    document
  const startMarker = useProvided
    ? startOverride!
    : markerOwnerDocument.createComment('fict:cond:start')
  const endMarker = useProvided ? endOverride! : markerOwnerDocument.createComment('fict:cond:end')
  const fragment = useProvided ? startMarker : markerOwnerDocument.createDocumentFragment()
  if (!useProvided) {
    ;(fragment as DocumentFragment).append(startMarker, endMarker)
  }

  let currentNodes: Node[] = []
  let currentRoot: RootContext | null = null
  let lastCondition: boolean | undefined = undefined
  let pendingRender = false
  let initialHydrating = __fictIsHydrating()

  const collectBetween = (): Node[] => {
    const nodes: Node[] = []
    let cursor = startMarker.nextSibling
    while (cursor && cursor !== endMarker) {
      nodes.push(cursor)
      cursor = cursor.nextSibling
    }
    return nodes
  }

  // Use computed to memoize condition value - this prevents the effect from
  // re-running when condition dependencies change but the boolean result stays same.
  // This is critical because re-running the effect would purge child effect deps
  // (like bindText) even if we early-return, breaking fine-grained reactivity.
  const conditionMemo = computed(condition)

  const prepareBranch = (
    render: (() => FictNode) | undefined,
    parent: ParentNode & Node,
    deferRefs: boolean,
  ): { root: RootContext | null; nodes: Node[]; handled: boolean } => {
    if (!render) {
      return { root: null, nodes: [], handled: false }
    }

    const root = createRootContext(hostRoot)
    if (deferRefs) {
      deferRootRefAssignments(root)
    }

    const prevRender = pushRoot(root)
    let output: FictNode | undefined
    try {
      // Use untrack for ordinary branches so nested signal reads do not make
      // the conditional effect own child dependencies.
      output = trackBranchReads ? render() : untrack(render)
    } catch (err) {
      if (handleSuspend(err as any, root)) {
        destroyRoot(root)
        return { root: null, nodes: [], handled: true }
      }
      if (handleError(err, { source: 'renderChild' }, root)) {
        destroyRoot(root)
        return { root: null, nodes: [], handled: true }
      }
      throw err
    } finally {
      popRoot(prevRender)
    }

    const prevCreate = pushRoot(root)
    try {
      if (output == null || output === false) {
        return { root, nodes: [], handled: false }
      }
      const el = createElementFn(output)
      return {
        root,
        nodes: toNodeArray(el, parent.ownerDocument ?? markerOwnerDocument),
        handled: false,
      }
    } catch (err) {
      if (handleSuspend(err as any, root)) {
        destroyRoot(root)
        return { root: null, nodes: [], handled: true }
      }
      if (handleError(err, { source: 'renderChild' }, root)) {
        destroyRoot(root)
        return { root: null, nodes: [], handled: true }
      }
      throw err
    } finally {
      popRoot(prevCreate)
    }
  }

  const commitBranch = (
    cond: boolean,
    root: RootContext | null,
    nodes: Node[],
    parent: ParentNode & Node,
  ): void => {
    const previousRoot = currentRoot
    const previousNodes = currentNodes
    let inserted = false

    try {
      if (nodes.length > 0) {
        nodes = insertNodesBefore(parent, nodes, endMarker)
      }
      inserted = true

      currentNodes = nodes
      currentRoot = root
      lastCondition = cond

      try {
        if (previousRoot) {
          destroyRoot(previousRoot)
        }
      } finally {
        removeNodes(previousNodes)
      }

      if (root) {
        flushDeferredRefAssignments(root)
        flushOnMount(root)
      }
    } catch (err) {
      if (!inserted) {
        removeNodes(nodes)
        if (root) {
          destroyRoot(root)
        }
        currentNodes = previousNodes
        currentRoot = previousRoot
      }
      throw err
    }
  }

  const runConditional = () => {
    const cond = conditionMemo()
    const parent = startMarker.parentNode as (ParentNode & Node) | null
    if (!parent) {
      pendingRender = true
      return
    }
    pendingRender = false

    if (initialHydrating && isHydratingActive()) {
      initialHydrating = false
      lastCondition = cond

      const render = cond ? renderTrue : renderFalse
      if (!render) {
        currentNodes = collectBetween()
        return
      }

      const root = createRootContext(hostRoot)
      const prev = pushRoot(root)
      let handledError = false
      try {
        // Call render() INSIDE withHydrationRange so that template() and insertBetween
        // see the correct hydration context for the conditional content
        withHydrationRange(
          startMarker.nextSibling,
          endMarker,
          parent.ownerDocument ?? markerOwnerDocument,
          () => {
            const output = trackBranchReads ? render() : untrack(render)
            if (output == null || output === false) {
              return
            }
            createElementFn(output)
          },
        )
        currentNodes = collectBetween()
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
      return
    }

    if (!trackBranchReads) {
      if (lastCondition === cond && currentNodes.length > 0) {
        return
      }
      if (lastCondition === cond && lastCondition === false && renderFalse === undefined) {
        return
      }
    } else if (lastCondition === cond) {
      const render = cond ? renderTrue : renderFalse
      const next = prepareBranch(render, parent, true)
      if (next.handled) {
        return
      }

      commitBranch(cond, next.root, next.nodes, parent)
      return
    }

    const render = cond ? renderTrue : renderFalse
    const next = prepareBranch(render, parent, lastCondition !== undefined)
    if (next.handled) {
      return
    }
    commitBranch(cond, next.root, next.nodes, parent)
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

  const markerOwnerDocument = container.ownerDocument ?? document
  const marker = markerOwnerDocument.createComment('fict:portal')
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
    root.ownerDocument = container.ownerDocument ?? parentRoot?.ownerDocument ?? document
    const prev = pushRoot(root)
    let handledError = false
    try {
      const output = render()
      if (output != null && output !== false) {
        const el = createElementFn(output)
        const nodes = toNodeArray(el, markerOwnerDocument)
        if (marker.parentNode) {
          currentNodes = insertNodesBefore(marker.parentNode as ParentNode & Node, nodes, marker)
        } else {
          currentNodes = nodes
        }
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

// DOM utility functions are imported from './node-ops' to avoid duplication
