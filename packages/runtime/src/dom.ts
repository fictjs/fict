import { Fragment } from './jsx'
import { createEffect } from './effect'
import { createRootContext, destroyRoot, flushOnMount, pushRoot, popRoot } from './lifecycle'
import type { DOMElement, FictNode, FictVNode } from './types'

export function render(view: () => FictNode, container: HTMLElement): () => void {
  const root = createRootContext()
  const prev = pushRoot(root)
  const output = view()
  const dom = createElement(output)
  container.replaceChildren(dom)
  flushOnMount(root)
  popRoot(prev)

  const teardown = () => {
    destroyRoot(root)
    container.innerHTML = ''
  }

  return teardown
}

export function bindText(node: Text | HTMLElement, accessor: () => unknown): () => void {
  return createEffect(() => {
    const value = accessor()
    node.textContent = value == null ? '' : String(value)
  })
}

export function bindAttribute(el: HTMLElement, name: string, accessor: () => unknown): () => void {
  return createEffect(() => {
    const value = accessor()
    setAttribute(el, name, value)
  })
}

export function bindProperty(el: HTMLElement, name: string, accessor: () => unknown): () => void {
  return createEffect(() => {
    const value = accessor()
    if (value === undefined) return
    ;(el as unknown as Record<string, unknown>)[name] = value as unknown
  })
}

export function insert(
  parent: HTMLElement | DocumentFragment,
  accessor: () => FictNode,
): () => void {
  const marker = document.createTextNode('')
  parent.appendChild(marker)
  let current: Node | null = null

  return createEffect(() => {
    const next = createElement(accessor())
    if (current === next) return

    if (current) {
      parent.insertBefore(next, current)
      parent.removeChild(current)
    } else {
      parent.insertBefore(next, marker)
    }

    current = next
  })
}

export function createElement(node: FictNode): DOMElement {
  if (node instanceof Node) {
    return node
  }

  if (node === null || node === undefined || node === false) {
    return document.createTextNode('')
  }

  if (Array.isArray(node)) {
    const frag = document.createDocumentFragment()
    for (const child of node) {
      appendChild(frag, child)
    }
    return frag
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return document.createTextNode(String(node))
  }

  if (typeof node === 'boolean') {
    return document.createTextNode('')
  }

  const vnode = node as FictVNode
  if (typeof vnode.type === 'function') {
    const rendered = vnode.type({ ...(vnode.props ?? {}), key: vnode.key })
    return createElement(rendered as FictNode)
  }

  if (vnode.type === Fragment) {
    const frag = document.createDocumentFragment()
    appendChildren(frag, vnode.props?.children as FictNode | FictNode[] | undefined)
    return frag
  }

  const el = document.createElement(typeof vnode.type === 'string' ? vnode.type : 'div')
  applyProps(el, vnode.props ?? {})
  return el
}

function appendChild(parent: HTMLElement | DocumentFragment, child: FictNode): void {
  if (child === null || child === undefined || child === false) return
  parent.appendChild(createElement(child))
}

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
  appendChild(parent, children)
}

function applyProps(el: HTMLElement, props: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue
    if (key === 'ref' && typeof value === 'function') {
      value(el)
      continue
    }
    if (isEventKey(key) && typeof value === 'function') {
      el.addEventListener(eventNameFromProp(key), value as EventListener)
      continue
    }
    if (key === 'class' || key === 'className') {
      el.className = value == null ? '' : String(value)
      continue
    }
    if (key === 'style') {
      applyStyle(el, value)
      continue
    }
    setAttribute(el, key, value)
  }

  appendChildren(el, props.children as FictNode | FictNode[] | undefined)
}

function setAttribute(el: HTMLElement, key: string, value: unknown): void {
  if (value === undefined || value === null || value === false) {
    el.removeAttribute(key)
    return
  }
  if (value === true) {
    el.setAttribute(key, '')
    return
  }

  const valueType = typeof value
  if (valueType === 'string' || valueType === 'number') {
    el.setAttribute(key, String(value))
    return
  }

  if (key in el) {
    ;(el as unknown as Record<string, unknown>)[key] = value as unknown
    return
  }

  el.setAttribute(key, String(value))
}

function applyStyle(el: HTMLElement, value: unknown): void {
  if (typeof value === 'string') {
    el.style.cssText = value
    return
  }
  if (value && typeof value === 'object') {
    const styles = value as Record<string, string | number>
    for (const [prop, v] of Object.entries(styles)) {
      el.style.setProperty(prop, typeof v === 'number' ? `${v}` : v)
    }
  }
}

function isEventKey(key: string): boolean {
  return key.startsWith('on') && key.length > 2
}

function eventNameFromProp(key: string): string {
  return key.slice(2).toLowerCase()
}
