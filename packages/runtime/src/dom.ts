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
  isReactive,
  PRIMITIVE_PROXY,
  type MaybeReactive,
  type AttributeSetter,
  type BindingHandle,
} from './binding'
import { Fragment } from './jsx'
import { createRootContext, destroyRoot, flushOnMount, pushRoot, popRoot } from './lifecycle'
import { isFineGrainedRuntimeEnabled } from './feature-flags'
import type { DOMElement, FictNode, FictVNode } from './types'

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

  if (isFineGrainedRuntimeEnabled()) {
    container.setAttribute('data-fict-fine-grained', '1')
  } else {
    container.removeAttribute('data-fict-fine-grained')
  }

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
    const nodeRecord = node as unknown as Record<PropertyKey, unknown>
    if (Boolean(nodeRecord[PRIMITIVE_PROXY])) {
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
    const props = { ...(vnode.props ?? {}), key: vnode.key }
    const rendered = vnode.type(props)
    return createElement(rendered as FictNode)
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

// ============================================================================
// Child Node Handling
// ============================================================================

/**
 * Append a child node to a parent, handling all node types including reactive values.
 */
function appendChildNode(parent: HTMLElement | DocumentFragment, child: FictNode): void {
  // Skip nullish values
  if (child === null || child === undefined || child === false) {
    return
  }

  // Reactive child - create binding
  if (typeof child === 'function' && (child as () => FictNode).length === 0) {
    const childGetter = child as () => FictNode
    createChildBinding(parent as HTMLElement | DocumentFragment, childGetter, createElement)
    return
  }

  // Static child - create element and append
  parent.appendChild(createElement(child))
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
// Props Handling
// ============================================================================

/**
 * Apply props to an HTML element, setting up reactive bindings as needed.
 */
function applyProps(el: HTMLElement, props: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue

    // Ref handling
    if (key === 'ref') {
      if (typeof value === 'function') {
        ;(value as (el: HTMLElement) => void)(el)
      }
      continue
    }

    // Event handling
    if (isEventKey(key)) {
      if (typeof value === 'function') {
        el.addEventListener(eventNameFromProp(key), value as EventListener)
      }
      continue
    }

    // Class/ClassName
    if (key === 'class' || key === 'className') {
      createClassBinding(el, value as MaybeReactive<string | Record<string, boolean> | null>)
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

    // Regular attributes (potentially reactive)
    createAttributeBinding(el, key, value as MaybeReactive<unknown>, setAttribute)
  }

  // Handle children
  const children = props.children as FictNode | FictNode[] | undefined
  appendChildren(el, children)
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
 * Set innerHTML on an element (used for dangerouslySetInnerHTML)
 */
const setInnerHTML: AttributeSetter = (el: HTMLElement, _key: string, value: unknown): void => {
  el.innerHTML = value == null ? '' : String(value)
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
