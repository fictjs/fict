import type { FictNode } from './types'

export function createElement(node: FictNode): HTMLElement | Text {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return document.createTextNode('')
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return document.createTextNode(String(node))
  }
  const el = document.createElement(typeof node.type === 'string' ? node.type : 'div')
  if (node.props) {
    Object.entries(node.props).forEach(([key, value]) => {
      if (key === 'children') return
      // naive property assignment; real runtime should handle events/attrs
      // @ts-expect-error runtime wiring pending
      el[key] = value
    })
    if (node.props.children) {
      const children = Array.isArray(node.props.children)
        ? node.props.children
        : [node.props.children]
      children.filter(Boolean).forEach(child => el.appendChild(createElement(child)))
    }
  }
  return el
}
