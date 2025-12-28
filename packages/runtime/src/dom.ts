/**
 * Fict DOM Rendering System
 *
 * This module provides DOM rendering capabilities with reactive bindings.
 * It transforms JSX virtual nodes into actual DOM elements, automatically
 * setting up reactive updates for dynamic values.
 *
 * Key Features:
 * - Reactive text content: `{count}` updates when count changes
 * - Reactive attributes: `disabled={!isValid}` updates reactively
 * - Reactive children: `{show && <Modal />}` handles conditionals
 * - List rendering: `{items.map(...)}` with efficient keyed updates
 */

import {
  createTextBinding,
  createAttributeBinding,
  createStyleBinding,
  createClassBinding,
  createChildBinding,
  bindEvent,
  isReactive,
  PRIMITIVE_PROXY,
  type MaybeReactive,
  type AttributeSetter,
  type BindingHandle,
} from './binding'
import { Properties, ChildProperties, Aliases, getPropAlias, SVGNamespace } from './constants'
import { __fictPushContext, __fictPopContext } from './hooks'
import { Fragment } from './jsx'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  handleError,
  handleSuspend,
  pushRoot,
  popRoot,
  registerRootCleanup,
  getCurrentRoot,
} from './lifecycle'
import { createPropsProxy, unwrapProps } from './props'
import { untrack } from './scheduler'
import type { DOMElement, FictNode, FictVNode, RefObject } from './types'

// ============================================================================
// Main Render Function
// ============================================================================

/**
 * Render a Fict view into a container element.
 *
 * @param view - A function that returns the view to render
 * @param container - The DOM container to render into
 * @returns A teardown function to unmount the view
 *
 * @example
 * ```ts
 * const unmount = render(() => <App />, document.getElementById('root')!)
 * // Later: unmount()
 * ```
 */
export function render(view: () => FictNode, container: HTMLElement): () => void {
  const root = createRootContext()
  const prev = pushRoot(root)
  let dom: DOMElement
  try {
    const output = view()
    // createElement must be called within the root context
    // so that child components register their onMount callbacks correctly
    dom = createElement(output)
  } finally {
    popRoot(prev)
  }

  container.replaceChildren(dom)
  container.setAttribute('data-fict-fine-grained', '1')

  flushOnMount(root)

  const teardown = () => {
    destroyRoot(root)
    container.innerHTML = ''
  }

  return teardown
}

// ============================================================================
// Element Creation
// ============================================================================

/**
 * Create a DOM element from a Fict node.
 * This is the main entry point for converting virtual nodes to real DOM.
 *
 * Supports:
 * - Native DOM nodes (passed through)
 * - Null/undefined/false (empty text node)
 * - Arrays (DocumentFragment)
 * - Strings/numbers (text nodes)
 * - Booleans (empty text node)
 * - VNodes (components or HTML elements)
 * - Reactive values (functions returning any of the above)
 */
export function createElement(node: FictNode): DOMElement {
  // Already a DOM node - pass through
  if (node instanceof Node) {
    return node
  }

  // Null/undefined/false - empty placeholder
  if (node === null || node === undefined || node === false) {
    return document.createTextNode('')
  }

  // Primitive proxy produced by keyed list binding
  if (typeof node === 'object' && node !== null && !(node instanceof Node)) {
    // Handle BindingHandle (createList, createConditional, etc)
    if ('marker' in node) {
      return createElement((node as { marker: unknown }).marker as FictNode)
    }

    const nodeRecord = node as unknown as Record<PropertyKey, unknown>
    if (nodeRecord[PRIMITIVE_PROXY]) {
      const primitiveGetter = nodeRecord[Symbol.toPrimitive]
      const value =
        typeof primitiveGetter === 'function' ? primitiveGetter.call(node, 'default') : node
      return document.createTextNode(value == null || value === false ? '' : String(value))
    }
  }

  // Array - create fragment
  if (Array.isArray(node)) {
    const frag = document.createDocumentFragment()
    for (const child of node) {
      appendChildNode(frag, child)
    }
    return frag
  }

  // Primitive values - text node
  if (typeof node === 'string' || typeof node === 'number') {
    return document.createTextNode(String(node))
  }

  if (typeof node === 'boolean') {
    return document.createTextNode('')
  }

  // VNode
  const vnode = node as FictVNode

  // Function component
  if (typeof vnode.type === 'function') {
    const rawProps = unwrapProps(vnode.props ?? {}) as Record<string, unknown>
    const baseProps =
      vnode.key === undefined
        ? rawProps
        : new Proxy(rawProps, {
            get(target, prop, receiver) {
              if (prop === 'key') return vnode.key
              return Reflect.get(target, prop, receiver)
            },
            has(target, prop) {
              if (prop === 'key') return true
              return prop in target
            },
            ownKeys(target) {
              const keys = new Set(Reflect.ownKeys(target))
              keys.add('key')
              return Array.from(keys)
            },
            getOwnPropertyDescriptor(target, prop) {
              if (prop === 'key') {
                return { enumerable: true, configurable: true, value: vnode.key }
              }
              return Object.getOwnPropertyDescriptor(target, prop)
            },
          })

    const props = createPropsProxy(baseProps)
    try {
      // Create a fresh hook context for this component instance.
      // This preserves slot state across re-renders driven by __fictRender.
      __fictPushContext()
      const rendered = vnode.type(props)
      __fictPopContext()
      return createElement(rendered as FictNode)
    } catch (err) {
      __fictPopContext()
      if (handleSuspend(err as any)) {
        return document.createComment('fict:suspend')
      }
      handleError(err, { source: 'render', componentName: vnode.type.name })
      throw err
    }
  }

  // Fragment
  if (vnode.type === Fragment) {
    const frag = document.createDocumentFragment()
    const children = vnode.props?.children as FictNode | FictNode[] | undefined
    appendChildren(frag, children)
    return frag
  }

  // HTML Element
  const tagName = typeof vnode.type === 'string' ? vnode.type : 'div'
  const el = document.createElement(tagName)
  applyProps(el, vnode.props ?? {})
  return el
}

/**
 * Create a template cloning factory from an HTML string.
 * Used by the compiler for efficient DOM generation.
 *
 * @param html - The HTML string to create a template from
 * @param isImportNode - Use importNode for elements like img/iframe
 * @param isSVG - Whether the template is SVG content
 * @param isMathML - Whether the template is MathML content
 */
export function template(
  html: string,
  isImportNode?: boolean,
  isSVG?: boolean,
  isMathML?: boolean,
): () => Node {
  let node: Node | null = null

  const create = (): Node => {
    const t = isMathML
      ? document.createElementNS('http://www.w3.org/1998/Math/MathML', 'template')
      : document.createElement('template')
    t.innerHTML = html

    if (isSVG) {
      // For SVG, get the nested content
      return (t as HTMLTemplateElement).content.firstChild!.firstChild!
    }
    if (isMathML) {
      return t.firstChild!
    }
    return (t as HTMLTemplateElement).content.firstChild!
  }

  // Create the cloning function
  const fn = isImportNode
    ? () => untrack(() => document.importNode(node || (node = create()), true))
    : () => (node || (node = create())).cloneNode(true)

  // Add cloneNode property for compatibility
  ;(fn as { cloneNode?: typeof fn }).cloneNode = fn

  return fn
}

// ============================================================================
// Child Node Handling
// ============================================================================

// Use the comprehensive Properties set from constants for property binding
// These properties must update via DOM property semantics rather than attributes

/**
 * Check if a value is a runtime binding handle
 */
function isBindingHandle(node: unknown): node is BindingHandle {
  return (
    node !== null &&
    typeof node === 'object' &&
    'marker' in node &&
    'dispose' in node &&
    typeof (node as BindingHandle).dispose === 'function'
  )
}

/**
 * Append a child node to a parent, handling all node types including reactive values.
 */
function appendChildNode(parent: HTMLElement | DocumentFragment, child: FictNode): void {
  // Skip nullish values
  if (child === null || child === undefined || child === false) {
    return
  }

  // Handle BindingHandle (recursive)
  if (isBindingHandle(child)) {
    appendChildNode(parent, child.marker)
    // Flush pending nodes now that markers are in the DOM
    child.flush?.()
    return
  }

  // Handle getter function (recursive)
  if (typeof child === 'function' && (child as () => FictNode).length === 0) {
    const childGetter = child as () => FictNode
    createChildBinding(parent as HTMLElement | DocumentFragment, childGetter, createElement)
    return
  }

  // Static child - create element and append
  if (Array.isArray(child)) {
    for (const item of child) {
      appendChildNode(parent, item)
    }
    return
  }

  // Cast to Node for remaining logic
  let domNode: Node
  if (typeof child !== 'object' || child === null) {
    domNode = document.createTextNode(String(child ?? ''))
  } else {
    domNode = createElement(child as any) as Node
  }

  // Handle DocumentFragment manually to avoid JSDOM issues
  if (domNode.nodeType === 11) {
    const children = Array.from(domNode.childNodes)
    for (const node of children) {
      appendChildNode(parent, node)
    }
    return
  }

  if (domNode.ownerDocument !== parent.ownerDocument && parent.ownerDocument) {
    parent.ownerDocument.adoptNode(domNode)
  }

  try {
    parent.appendChild(domNode)
  } catch (e: any) {
    if (parent.ownerDocument) {
      const clone = parent.ownerDocument.importNode(domNode, true)
      parent.appendChild(clone)
      return
    }
    throw e
  }
}

/**
 * Append multiple children, handling arrays and nested structures.
 */
function appendChildren(
  parent: HTMLElement | DocumentFragment,
  children: FictNode | FictNode[] | undefined,
): void {
  if (children === undefined) return

  if (Array.isArray(children)) {
    for (const child of children) {
      appendChildren(parent, child)
    }
    return
  }

  appendChildNode(parent, children)
}

// ============================================================================
// Ref Handling
// ============================================================================

/**
 * Apply a ref to an element, supporting both callback and object refs.
 * Both types are automatically cleaned up on unmount.
 */
function applyRef(el: HTMLElement, value: unknown): void {
  if (typeof value === 'function') {
    // Callback ref
    const refFn = value as (el: HTMLElement | null) => void
    refFn(el)

    // Match React behavior: call ref(null) on unmount
    if (getCurrentRoot()) {
      registerRootCleanup(() => {
        refFn(null)
      })
    }
  } else if (value && typeof value === 'object' && 'current' in value) {
    // Object ref
    const refObj = value as RefObject<HTMLElement>
    refObj.current = el

    // Auto-cleanup on unmount
    if (getCurrentRoot()) {
      registerRootCleanup(() => {
        refObj.current = null
      })
    }
  }
}

// ============================================================================
// Props Handling
// ============================================================================

/**
 * Apply props to an HTML element, setting up reactive bindings as needed.
 * Uses comprehensive property constants for correct attribute/property handling.
 */
function applyProps(el: HTMLElement, props: Record<string, unknown>, isSVG = false): void {
  props = unwrapProps(props)
  const tagName = el.tagName

  // Check if this is a custom element
  const isCE = tagName.includes('-') || 'is' in props

  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue

    // Ref handling
    if (key === 'ref') {
      applyRef(el, value)
      continue
    }

    // Event handling with delegation support
    if (isEventKey(key)) {
      bindEvent(
        el,
        eventNameFromProp(key),
        value as MaybeReactive<EventListenerOrEventListenerObject | null | undefined>,
      )
      continue
    }

    // Explicit on: namespace for non-delegated events
    if (key.slice(0, 3) === 'on:') {
      bindEvent(
        el,
        key.slice(3),
        value as MaybeReactive<EventListenerOrEventListenerObject | null | undefined>,
        false, // Non-delegated
      )
      continue
    }

    // Capture events
    if (key.slice(0, 10) === 'oncapture:') {
      bindEvent(
        el,
        key.slice(10),
        value as MaybeReactive<EventListenerOrEventListenerObject | null | undefined>,
        true, // Capture
      )
      continue
    }

    // Class/ClassName
    if (key === 'class' || key === 'className') {
      createClassBinding(el, value as MaybeReactive<string | Record<string, boolean> | null>)
      continue
    }

    // classList for object-style class binding
    if (key === 'classList') {
      createClassBinding(el, value as MaybeReactive<Record<string, boolean> | null>)
      continue
    }

    // Style
    if (key === 'style') {
      createStyleBinding(
        el,
        value as MaybeReactive<string | Record<string, string | number> | null>,
      )
      continue
    }

    // dangerouslySetInnerHTML
    if (key === 'dangerouslySetInnerHTML' && value && typeof value === 'object') {
      const htmlValue = (value as { __html?: string }).__html
      if (htmlValue !== undefined) {
        if (isReactive(htmlValue)) {
          createAttributeBinding(el, 'innerHTML', htmlValue as () => unknown, setInnerHTML)
        } else {
          el.innerHTML = htmlValue
        }
      }
      continue
    }

    // Child properties (innerHTML, textContent, etc.)
    if (ChildProperties.has(key)) {
      createAttributeBinding(el, key, value as MaybeReactive<unknown>, setProperty)
      continue
    }

    // Forced attribute via attr: prefix
    if (key.slice(0, 5) === 'attr:') {
      createAttributeBinding(el, key.slice(5), value as MaybeReactive<unknown>, setAttribute)
      continue
    }

    // Forced boolean attribute via bool: prefix
    if (key.slice(0, 5) === 'bool:') {
      createAttributeBinding(el, key.slice(5), value as MaybeReactive<unknown>, setBoolAttribute)
      continue
    }

    // Forced property via prop: prefix
    if (key.slice(0, 5) === 'prop:') {
      createAttributeBinding(el, key.slice(5), value as MaybeReactive<unknown>, setProperty)
      continue
    }

    // Check for property alias (element-specific mappings)
    const propAlias = !isSVG ? getPropAlias(key, tagName) : undefined

    // Handle properties and element-specific attributes
    if (propAlias || (!isSVG && Properties.has(key)) || (isCE && !isSVG)) {
      const propName = propAlias || key
      // Custom elements use toPropertyName conversion
      if (isCE && !Properties.has(key)) {
        createAttributeBinding(
          el,
          toPropertyName(propName),
          value as MaybeReactive<unknown>,
          setProperty,
        )
      } else {
        createAttributeBinding(el, propName, value as MaybeReactive<unknown>, setProperty)
      }
      continue
    }

    // SVG namespaced attributes (xlink:href, xml:lang, etc.)
    if (isSVG && key.indexOf(':') > -1) {
      const [prefix, name] = key.split(':')
      const ns = SVGNamespace[prefix!]
      if (ns) {
        createAttributeBinding(el, key, value as MaybeReactive<unknown>, (el, _key, val) =>
          setAttributeNS(el, ns, name!, val),
        )
        continue
      }
    }

    // Regular attributes (potentially reactive)
    // Apply alias mapping (className -> class, htmlFor -> for)
    const attrName = Aliases[key] || key
    createAttributeBinding(el, attrName, value as MaybeReactive<unknown>, setAttribute)
  }

  // Handle children
  const children = props.children as FictNode | FictNode[] | undefined
  appendChildren(el, children)
}

/**
 * Convert kebab-case to camelCase for custom element properties
 */
function toPropertyName(name: string): string {
  return name.toLowerCase().replace(/-([a-z])/g, (_, w) => w.toUpperCase())
}

// ============================================================================
// Attribute Setters
// ============================================================================

/**
 * Set an attribute on an element, handling various value types.
 */
const setAttribute: AttributeSetter = (el: HTMLElement, key: string, value: unknown): void => {
  // Remove attribute for nullish/false values
  if (value === undefined || value === null || value === false) {
    el.removeAttribute(key)
    return
  }

  // Boolean true -> empty string attribute
  if (value === true) {
    el.setAttribute(key, '')
    return
  }

  // Primitive values
  const valueType = typeof value
  if (valueType === 'string' || valueType === 'number') {
    el.setAttribute(key, String(value))
    return
  }

  // DOM property (for cases like `value`, `checked`, etc.)
  if (key in el) {
    ;(el as unknown as Record<string, unknown>)[key] = value
    return
  }

  // Fallback: set as attribute
  el.setAttribute(key, String(value))
}

/**
 * Set a property on an element, ensuring nullish values clear sensibly.
 */
const setProperty: AttributeSetter = (el: HTMLElement, key: string, value: unknown): void => {
  if (value === undefined || value === null) {
    const fallback = key === 'checked' || key === 'selected' ? false : ''
    ;(el as unknown as Record<string, unknown>)[key] = fallback
    return
  }

  // Handle style object binding style={{ color: 'red' }}
  if (key === 'style' && typeof value === 'object' && value !== null) {
    for (const k in value as Record<string, string>) {
      const v = (value as Record<string, string>)[k]
      if (v !== undefined) {
        ;(el.style as unknown as Record<string, string>)[k] = String(v)
      }
    }
    return
  }

  ;(el as unknown as Record<string, unknown>)[key] = value as unknown
}

/**
 * Set innerHTML on an element (used for dangerouslySetInnerHTML)
 */
const setInnerHTML: AttributeSetter = (el: HTMLElement, _key: string, value: unknown): void => {
  el.innerHTML = value == null ? '' : String(value)
}

/**
 * Set a boolean attribute on an element (empty string when true, removed when false)
 */
const setBoolAttribute: AttributeSetter = (el: HTMLElement, key: string, value: unknown): void => {
  if (value) {
    el.setAttribute(key, '')
  } else {
    el.removeAttribute(key)
  }
}

/**
 * Set an attribute with a namespace (for SVG xlink:href, etc.)
 */
function setAttributeNS(el: HTMLElement, namespace: string, name: string, value: unknown): void {
  if (value == null) {
    el.removeAttributeNS(namespace, name)
  } else {
    el.setAttributeNS(namespace, name, String(value))
  }
}

// ============================================================================
// Event Handling Utilities
// ============================================================================

/**
 * Check if a prop key is an event handler (starts with "on")
 */
function isEventKey(key: string): boolean {
  return key.startsWith('on') && key.length > 2 && key[2]!.toUpperCase() === key[2]
}

/**
 * Convert a React-style event prop to a DOM event name
 * e.g., "onClick" -> "click", "onMouseDown" -> "mousedown"
 */
function eventNameFromProp(key: string): string {
  return key.slice(2).toLowerCase()
}

// ============================================================================
// Exports for Advanced Usage
// ============================================================================

export {
  createTextBinding,
  createChildBinding,
  createAttributeBinding,
  createStyleBinding,
  createClassBinding,
  isReactive,
}

export type { BindingHandle, MaybeReactive }
