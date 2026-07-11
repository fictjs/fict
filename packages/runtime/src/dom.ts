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
  createClassListBinding,
  createChildBinding,
  bindEvent,
  bindRef,
  isReactive,
  parseEventNameWithModifiers,
  registerCreateElement,
  type MaybeReactive,
  type AttributeSetter,
  type BindingHandle,
} from './binding'
import {
  Properties,
  ChildProperties,
  getPropAlias,
  SVGElements,
  normalizeSVGAttributeName,
  resolveNamespacedAttribute,
} from './constants'
import { getSafeDevtoolsHook as getDevtoolsHook } from './devtools'
import { isDocumentFragmentLike, isHTMLElementLike, isNodeLike } from './dom-guards'
import { assertValidDOMAttributeName, assertValidDOMElementName } from './dom-names'
import { __fictPushContext, __fictPopContext, __fictGetCurrentComponentId } from './hooks'
import {
  claimNodes,
  claimResumableScopeHost,
  claimText,
  isHydratingActive,
  withHydration,
  type HydrationIssueHandler,
} from './hydration'
import { Fragment } from './jsx'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  handleSuspend,
  pushRoot,
  popRoot,
  registerRootCleanup,
  getCurrentRoot,
  onMount,
  onCleanup,
} from './lifecycle'
import { toNodeArray } from './node-ops'
import { createPropsProxy, unwrapProps } from './props'
import {
  __fictIsHydrating,
  __fictIsResumable,
  __fictRegisterScope,
  __fictEnterHydration,
  __fictExitHydration,
  __fictGetComponentMeta,
} from './resume'
import { untrack } from './scheduler'
import type { DOMElement, FictNode, FictVNode } from './types'

type NamespaceContext = 'svg' | 'mathml' | null

export interface HydrateComponentOptions {
  onHydrationIssue?: HydrationIssueHandler | undefined
  strictHydration?: boolean | undefined
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

let nextComponentId = 1

function createKeyedComponentProps(
  rawProps: Record<string, unknown>,
  key: unknown,
): Record<string, unknown> {
  const props = Object.create(Object.getPrototypeOf(rawProps)) as Record<string, unknown>
  for (const prop of Reflect.ownKeys(rawProps)) {
    if (prop === 'key') continue
    const descriptor = Object.getOwnPropertyDescriptor(rawProps, prop)
    if (descriptor) {
      Object.defineProperty(props, prop, descriptor)
    }
  }
  Object.defineProperty(props, 'key', {
    value: key,
    enumerable: true,
    configurable: true,
    writable: true,
  })
  return props
}

type DevtoolsAnnotatedElement = HTMLElement & {
  __fict_component_id__?: number
  __fict_component_name__?: string
}

function collectComponentMountElements(node: Node): HTMLElement[] {
  if (isDocumentFragmentLike(node)) {
    return toNodeArray(node).filter((child): child is HTMLElement =>
      isHTMLElementLike(child, node.ownerDocument),
    )
  }

  if (isHTMLElementLike(node)) {
    // Resumable hosts use display: contents; surface concrete child elements for inspection.
    if (node.hasAttribute('data-fict-host')) {
      const children = Array.from(node.children).filter((child): child is HTMLElement =>
        isHTMLElementLike(child, node.ownerDocument),
      )
      if (children.length > 0) return children
    }
    return [node]
  }

  return []
}

function annotateComponentElements(
  elements: HTMLElement[],
  componentId: number,
  componentName: string,
): void {
  for (const element of elements) {
    element.setAttribute('data-fict-component', componentName)
    element.setAttribute('data-fict-component-id', String(componentId))
    const annotated = element as DevtoolsAnnotatedElement
    annotated.__fict_component_id__ = componentId
    annotated.__fict_component_name__ = componentName
  }
}

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
  root.ownerDocument = container.ownerDocument ?? document
  const prev = pushRoot(root)
  let dom: DOMElement = undefined as unknown as DOMElement
  let completed = false
  try {
    try {
      const output = view()
      // createElement must be called within the root context
      // so that child components register their onMount callbacks correctly
      if (__fictIsHydrating()) {
        withHydration(container, () => {
          dom = createElement(output)
        })
      } else {
        dom = createElement(output)
      }
    } finally {
      popRoot(prev)
    }

    if (!__fictIsHydrating()) {
      container.replaceChildren(dom)
    }
    container.setAttribute('data-fict-fine-grained', '1')

    flushOnMount(root)

    const teardown = () => {
      try {
        destroyRoot(root)
      } finally {
        // An unhandled cleanup error is still reported to the caller, but it
        // must not leave the rendered tree mounted.
        container.innerHTML = ''
      }
    }

    completed = true
    return teardown
  } finally {
    if (!completed) {
      destroyRoot(root)
    }
  }
}

/**
 * Hydrate compiled DOM output into an existing DOM container.
 * Unlike render(), the view function is expected to perform its own template
 * claims and binding setup while running inside the hydration context. Its
 * return value is ignored for compatibility with compiler-generated entries.
 *
 * @param view - A compiled hydration entry that claims/creates DOM as it runs
 * @param container - The DOM container with existing SSR content
 * @returns A teardown function to unmount the view
 */
export function hydrateComponent(
  view: () => FictNode | void,
  container: HTMLElement,
  options: HydrateComponentOptions = {},
): () => void {
  const root = createRootContext()
  root.ownerDocument = container.ownerDocument ?? document
  const prev = pushRoot(root)
  let completed = false
  let hydrationEntered = false

  try {
    try {
      // Enable hydration flags for bindings that check __fictIsHydrating()
      __fictEnterHydration()
      hydrationEntered = true
      // Run the view function INSIDE withHydration so template() can claim nodes
      withHydration(
        container,
        () => {
          view()
        },
        {
          onHydrationIssue: options.onHydrationIssue,
          strictHydration: options.strictHydration,
        },
      )
    } finally {
      if (hydrationEntered) {
        __fictExitHydration()
      }
      popRoot(prev)
    }

    container.setAttribute('data-fict-fine-grained', '1')
    flushOnMount(root)

    const teardown = () => {
      destroyRoot(root)
    }

    completed = true
    return teardown
  } finally {
    if (!completed) {
      destroyRoot(root)
    }
  }
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
  return createElementWithContext(node, null, resolveOwnerDocument())
}

export function createElementInNamespace(node: FictNode, namespace: NamespaceContext): DOMElement {
  return createElementWithContext(node, namespace, resolveOwnerDocument())
}

registerCreateElement(createElement)

function resolveNamespace(tagName: string, namespace: NamespaceContext): NamespaceContext {
  if (tagName === 'svg') return 'svg'
  if (tagName === 'math') return 'mathml'
  if (namespace === 'mathml') return 'mathml'
  if (namespace === 'svg') return 'svg'
  if (isDev && SVGElements.has(tagName)) return 'svg'
  return null
}

function resolveOwnerDocument(ownerDocument?: Document): Document {
  return ownerDocument ?? getCurrentRoot()?.ownerDocument ?? document
}

function createTextNodeWithHydration(value: string, ownerDocument: Document): Text {
  if (!isHydratingActive()) {
    return ownerDocument.createTextNode(value)
  }
  return claimText(value, () => ownerDocument.createTextNode(value))
}

function createElementWithContext(
  node: FictNode,
  namespace: NamespaceContext,
  ownerDocument: Document,
): DOMElement {
  // Already a DOM node - pass through
  if (isNodeLike(node, ownerDocument)) {
    return node
  }

  // Null/undefined/false - empty placeholder
  if (node === null || node === undefined || node === false) {
    return createTextNodeWithHydration('', ownerDocument)
  }

  // Reactive getter function - resolve to actual node
  if (isReactive(node)) {
    const resolved = (node as () => FictNode)()
    if (resolved === node) {
      return createTextNodeWithHydration('', ownerDocument)
    }
    return createElementWithContext(resolved, namespace, ownerDocument)
  }

  // Non-reactive function values are not valid DOM nodes.
  // Keep callback values inert instead of stringifying function source.
  if (typeof node === 'function') {
    return createTextNodeWithHydration('', ownerDocument)
  }

  if (typeof node === 'object' && node !== null && !isNodeLike(node, ownerDocument)) {
    // Handle BindingHandle (list/conditional bindings, etc)
    if ('marker' in node) {
      const handle = node as { marker: unknown; dispose?: () => void; flush?: () => void }
      // Register dispose cleanup if available
      if (typeof handle.dispose === 'function') {
        registerRootCleanup(handle.dispose)
      }
      if (typeof handle.flush === 'function') {
        const runFlush = () => handle.flush && handle.flush()
        if (typeof queueMicrotask === 'function') {
          queueMicrotask(runFlush)
        } else {
          Promise.resolve()
            .then(runFlush)
            .catch(() => undefined)
        }
      }
      return createElementWithContext(handle.marker as FictNode, namespace, ownerDocument)
    }
  }

  // Array - create fragment
  if (Array.isArray(node)) {
    const frag = ownerDocument.createDocumentFragment()
    for (const child of node) {
      appendChildNode(frag, child, namespace, ownerDocument)
    }
    return frag
  }

  // Primitive values - text node
  if (typeof node === 'string' || typeof node === 'number') {
    return createTextNodeWithHydration(String(node), ownerDocument)
  }

  if (typeof node === 'boolean') {
    return createTextNodeWithHydration('', ownerDocument)
  }

  // VNode
  const vnode = node as FictVNode

  // Function component
  if (typeof vnode.type === 'function') {
    const componentMeta = __fictGetComponentMeta(vnode.type)
    if (isHydratingActive() && componentMeta?.id) {
      const scopeHost = claimResumableScopeHost(componentMeta.id)
      if (scopeHost) {
        return scopeHost as DOMElement
      }
    }

    const rawProps = unwrapProps(vnode.props ?? {}) as Record<string, unknown>
    const baseProps =
      vnode.key === undefined ? rawProps : createKeyedComponentProps(rawProps, vnode.key)

    const props = createPropsProxy(baseProps)
    const componentType = (componentMeta?.id ?? vnode.type.name) || 'Anonymous'
    // Create a fresh hook context for this component instance.
    // This preserves slot state across re-renders driven by __fictRender.
    const hook = isDev ? getDevtoolsHook() : undefined
    const componentName = vnode.type.name || 'Anonymous'
    const parentId = hook ? __fictGetCurrentComponentId() : undefined
    const componentId = hook ? nextComponentId++ : undefined

    // Register component
    if (hook?.registerComponent && componentId !== undefined) {
      hook.registerComponent(componentId, componentName, parentId)
    }

    const ctx = __fictPushContext()
    if (componentId !== undefined) {
      ctx.componentId = componentId
      if (parentId !== undefined) {
        ctx.parentId = parentId
      }
    }

    try {
      const rendered = vnode.type(props)
      let mountElements: HTMLElement[] | undefined

      if (hook && componentId !== undefined) {
        hook.componentRender?.(componentId)
      }

      // Register lifecycle hooks
      if (hook && componentId !== undefined) {
        onMount(() => {
          hook.componentMount?.(componentId, mountElements)
        })
        onCleanup(() => hook.componentUnmount?.(componentId))
      }
      if (__fictIsResumable() && !__fictIsHydrating()) {
        const content = createElementWithContext(rendered as FictNode, namespace, ownerDocument)
        const host =
          namespace === 'svg'
            ? ownerDocument.createElementNS(SVG_NS, 'fict-host')
            : namespace === 'mathml'
              ? ownerDocument.createElementNS(MATHML_NS, 'fict-host')
              : ownerDocument.createElement('fict-host')
        host.setAttribute('data-fict-host', '')
        if (namespace === null && (host as HTMLElement).style) {
          ;(host as HTMLElement).style.display = 'contents'
        }
        const meta = componentMeta
        const typeKey = componentType
        __fictRegisterScope(ctx, host, typeKey, rawProps)
        if (meta?.resume) {
          host.setAttribute('data-fict-h', meta.resume)
        }
        if (isDocumentFragmentLike(content, ownerDocument)) {
          host.append(...Array.from(content.childNodes))
        } else {
          host.appendChild(content)
        }
        if (hook && componentId !== undefined) {
          mountElements = collectComponentMountElements(host)
          annotateComponentElements(mountElements, componentId, componentName)
        }
        return host as DOMElement
      }
      const componentRoot = createElementWithContext(rendered as FictNode, namespace, ownerDocument)
      if (hook && componentId !== undefined) {
        mountElements = collectComponentMountElements(componentRoot)
        annotateComponentElements(mountElements, componentId, componentName)
      }
      return componentRoot
    } catch (err) {
      if (handleSuspend(err as any)) {
        return ownerDocument.createComment('fict:suspend')
      }
      throw err
    } finally {
      __fictPopContext()
    }
  }

  // Fragment
  if (vnode.type === Fragment) {
    const frag = ownerDocument.createDocumentFragment()
    const children = vnode.props?.children as FictNode | FictNode[] | undefined
    appendChildren(frag, children, namespace, ownerDocument)
    return frag
  }

  // HTML Element
  const tagName = typeof vnode.type === 'string' ? vnode.type : 'div'
  const resolvedNamespace = resolveNamespace(tagName, namespace)
  const namespaceURI =
    resolvedNamespace === 'svg' ? SVG_NS : resolvedNamespace === 'mathml' ? MATHML_NS : null
  assertValidDOMElementName(tagName, resolvedNamespace !== null, namespaceURI ?? undefined)
  const el =
    namespaceURI !== null
      ? ownerDocument.createElementNS(namespaceURI, tagName)
      : ownerDocument.createElement(tagName)
  applyProps(el, vnode.props ?? {}, resolvedNamespace === 'svg')
  const childParent =
    namespaceURI === null && el.localName === 'template' && 'content' in el
      ? (el as HTMLTemplateElement).content
      : (el as unknown as ParentNode & Node)
  appendChildren(
    childParent,
    vnode.props?.children as FictNode | FictNode[] | undefined,
    tagName === 'foreignObject' ? null : resolvedNamespace,
    ownerDocument,
  )
  return el as DOMElement
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
  const nodeByDocument = new WeakMap<Document, Node>()

  const create = (ownerDocument: Document): Node => {
    const t = ownerDocument.createElement('template')

    if (isSVG) {
      // fix: Wrap HTML in <svg> to parse content in SVG namespace
      // Then extract the actual content (firstChild of the wrapper svg)
      t.innerHTML = `<svg>${html}</svg>`
      const wrapper = (t as HTMLTemplateElement).content.firstChild!
      // Dev check for multi-root SVG templates
      if (isDev && wrapper.childNodes.length !== 1) {
        console.warn('[fict] Multi-root SVG template.')
      }
      if (wrapper.childNodes.length === 1) {
        return wrapper.firstChild!
      }
      // Preserve all root nodes by returning a fragment
      const fragment = ownerDocument.createDocumentFragment()
      fragment.append(...Array.from(wrapper.childNodes))
      return fragment
    }
    if (isMathML) {
      // fix: Wrap HTML in <math> to parse content in MathML namespace
      // Then extract the actual content (firstChild of the wrapper math)
      t.innerHTML = `<math>${html}</math>`
      const wrapper = (t as HTMLTemplateElement).content.firstChild!
      // Dev check for multi-root MathML templates
      if (isDev && wrapper.childNodes.length !== 1) {
        console.warn('[fict] Multi-root MathML template.')
      }
      if (wrapper.childNodes.length === 1) {
        return wrapper.firstChild!
      }
      // Preserve all root nodes by returning a fragment
      const fragment = ownerDocument.createDocumentFragment()
      fragment.append(...Array.from(wrapper.childNodes))
      return fragment
    }

    t.innerHTML = html
    const content = (t as HTMLTemplateElement).content
    // Dev check for multi-root templates
    if (isDev && content.childNodes.length !== 1) {
      console.warn('[fict] Multi-root template.')
    }
    if (content.childNodes.length === 1) {
      return content.firstChild!
    }
    // Preserve all root nodes by returning a fragment
    return content
  }

  const getBase = (ownerDocument: Document): Node => {
    const cached = nodeByDocument.get(ownerDocument)
    if (cached) return cached
    const created = create(ownerDocument)
    nodeByDocument.set(ownerDocument, created)
    return created
  }

  // Create the cloning function
  const fn = isImportNode
    ? () =>
        untrack(() => {
          const ownerDocument = resolveOwnerDocument()
          const base = getBase(ownerDocument)
          return isHydratingActive()
            ? claimNodes(base, () => ownerDocument.importNode(base, true))
            : ownerDocument.importNode(base, true)
        })
    : () => {
        const base = getBase(resolveOwnerDocument())
        return isHydratingActive()
          ? claimNodes(base, () => base.cloneNode(true))
          : base.cloneNode(true)
      }

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
function appendChildNode(
  parent: ParentNode & Node,
  child: FictNode,
  namespace: NamespaceContext,
  ownerDocument: Document,
): void {
  const parentOwnerDocument = parent.ownerDocument ?? ownerDocument

  // Skip nullish values
  if (child === null || child === undefined || child === false) {
    return
  }

  // Handle BindingHandle (recursive)
  if (isBindingHandle(child)) {
    registerRootCleanup(child.dispose)
    appendChildNode(parent, child.marker, namespace, parentOwnerDocument)
    // Flush pending nodes now that markers are in the DOM
    child.flush?.()
    return
  }

  // Handle function children:
  // - reactive accessors (signals/computed/getters) become child bindings
  // - non-reactive callbacks stay inert
  if (typeof child === 'function') {
    const childGetter = child as () => FictNode
    if (isReactive(childGetter)) {
      createChildBinding(parent, childGetter, node =>
        createElementWithContext(node, namespace, parentOwnerDocument),
      )
      return
    }
    return
  }

  // Static child - create element and append
  if (Array.isArray(child)) {
    for (const item of child) {
      appendChildNode(parent, item, namespace, parentOwnerDocument)
    }
    return
  }

  // Cast to Node for remaining logic
  let domNode: Node
  if (typeof child !== 'object' || child === null) {
    domNode = createTextNodeWithHydration(String(child ?? ''), parentOwnerDocument)
  } else {
    domNode = createElementWithContext(child as any, namespace, parentOwnerDocument) as Node
  }

  // Handle DocumentFragment manually to avoid JSDOM issues
  if (domNode.nodeType === 11) {
    const children = Array.from(domNode.childNodes)
    for (const node of children) {
      appendChildNode(parent, node as FictNode, namespace, parentOwnerDocument)
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
  parent: ParentNode & Node,
  children: FictNode | FictNode[] | undefined,
  namespace: NamespaceContext,
  ownerDocument: Document,
): void {
  if (children === undefined) return

  if (Array.isArray(children)) {
    for (const child of children) {
      appendChildren(parent, child, namespace, ownerDocument)
    }
    return
  }

  appendChildNode(parent, children, namespace, ownerDocument)
}

// ============================================================================
// Ref Handling
// ============================================================================

/**
 * Apply a ref to an element, supporting both callback and object refs.
 * Both types are automatically cleaned up on unmount.
 */
function applyRef(el: Element, value: unknown): void {
  if (!getCurrentRoot() && isDev) {
    console.warn('rootless ref')
  }
  bindRef(el, value)
}

// ============================================================================
// Props Handling
// ============================================================================

/**
 * Apply props to an HTML element, setting up reactive bindings as needed.
 * Uses comprehensive property constants for correct attribute/property handling.
 */
function applyProps(el: Element, props: Record<string, unknown>, isSVG = false): void {
  props = unwrapProps(props)
  const tagName = el.tagName

  // Check if this is a custom element
  const isCE = tagName.includes('-') || 'is' in props

  for (const [rawKey, value] of Object.entries(props)) {
    let key = rawKey
    if (key === 'children') continue

    // Ref handling
    if (key === 'ref') {
      applyRef(el, value)
      continue
    }

    // Event handling with delegation support
    if (isEventKey(key)) {
      const parsedEvent = parseEventNameWithModifiers(key.slice(2))
      const hasEventOptions = parsedEvent.capture || parsedEvent.passive || parsedEvent.once
      const options: AddEventListenerOptions | undefined = hasEventOptions ? {} : undefined
      if (options) {
        if (parsedEvent.capture) options.capture = true
        if (parsedEvent.passive) options.passive = true
        if (parsedEvent.once) options.once = true
      }
      bindEvent(
        el,
        parsedEvent.eventName.toLowerCase(),
        value as MaybeReactive<EventListenerOrEventListenerObject | null | undefined>,
        options,
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
      createClassListBinding(el, value as MaybeReactive<Record<string, boolean> | null>)
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

    if (isSVG) {
      key = normalizeSVGAttributeName(key)
    }

    // Child properties (innerHTML, textContent, etc.)
    if (
      (isDev && ChildProperties.has(key)) ||
      key === 'innerHTML' ||
      key === 'textContent' ||
      key === 'innerText' ||
      key === 'children'
    ) {
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

    const namespaced = resolveNamespacedAttribute(key)
    if (namespaced) {
      createAttributeBinding(el, key, value as MaybeReactive<unknown>, (el, _key, val) =>
        setAttributeNS(el, namespaced, val),
      )
      continue
    }

    // Check for property alias (element-specific mappings)
    const propAlias = !isSVG && isDev ? getPropAlias(key, tagName) : undefined
    const isProperty = !isSVG
      ? isDev
        ? Properties.has(key)
        : key in (el as unknown as Record<string, unknown>)
      : false

    // Handle properties and element-specific attributes
    if (propAlias || isProperty || (isCE && !isSVG)) {
      const propName = propAlias || key
      // Custom elements use toPropertyName conversion
      if (isCE && !isProperty && !propAlias) {
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

    // Regular attributes (potentially reactive)
    // Apply alias mapping (className -> class, htmlFor -> for)
    const attrName = key === 'htmlFor' ? 'for' : key
    createAttributeBinding(el, attrName, value as MaybeReactive<unknown>, setAttribute)
  }
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
function shouldStringifyBooleanAttribute(key: string): boolean {
  const normalized = key.toLowerCase()
  return (
    normalized === 'draggable' ||
    normalized === 'contenteditable' ||
    normalized === 'spellcheck' ||
    normalized.startsWith('aria-') ||
    normalized.startsWith('data-')
  )
}

const setAttribute: AttributeSetter = (el: Element, key: string, value: unknown): void => {
  assertValidDOMAttributeName(key)
  if (typeof value === 'boolean' && shouldStringifyBooleanAttribute(key)) {
    el.setAttribute(key, String(value))
    return
  }

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
const setProperty: AttributeSetter = (el: Element, key: string, value: unknown): void => {
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
        ;((el as HTMLElement).style as unknown as Record<string, string>)[k] = String(v)
      }
    }
    return
  }

  ;(el as unknown as Record<string, unknown>)[key] = value as unknown
}

/**
 * Set innerHTML on an element (used for dangerouslySetInnerHTML)
 */
const setInnerHTML: AttributeSetter = (el: Element, _key: string, value: unknown): void => {
  const next = value == null ? '' : String(value)
  const node = el as HTMLElement
  if (node.innerHTML === next) return
  node.innerHTML = next
}

/**
 * Set a boolean attribute on an element (empty string when true, removed when false)
 */
const setBoolAttribute: AttributeSetter = (el: Element, key: string, value: unknown): void => {
  assertValidDOMAttributeName(key)
  if (value) {
    el.setAttribute(key, '')
  } else {
    el.removeAttribute(key)
  }
}

/**
 * Set an attribute with a namespace (for SVG xlink:href, etc.)
 */
function setAttributeNS(
  el: Element,
  namespaced: NonNullable<ReturnType<typeof resolveNamespacedAttribute>>,
  value: unknown,
): void {
  assertValidDOMAttributeName(namespaced.qualifiedName, true, namespaced.namespace)
  if (value === undefined || value === null || value === false) {
    el.removeAttributeNS(namespaced.namespace, namespaced.localName)
  } else if (value === true) {
    el.setAttributeNS(namespaced.namespace, namespaced.qualifiedName, '')
  } else {
    el.setAttributeNS(namespaced.namespace, namespaced.qualifiedName, String(value))
  }
}

// ============================================================================
// Event Handling Utilities
// ============================================================================

/**
 * Check if a prop key is an event handler (starts with "on")
 */
function isEventKey(key: string): boolean {
  const marker = key[2]
  return (
    key.startsWith('on') && key.length > 2 && marker !== undefined && marker >= 'A' && marker <= 'Z'
  )
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
