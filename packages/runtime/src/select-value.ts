// A controlled select can receive its value before its options exist. Keep
// the setter so option insertion/removal and value changes can apply it again.
const setters = new WeakMap<Element, () => void>()

export function registerSelectValueSetter(select: Element, setter: () => void): void {
  setters.set(select, setter)
}

export function syncSelectValue(node: Node | null): void {
  if (node?.nodeType === 3) node = node.parentNode
  while (node?.nodeType === 1) {
    const element = node as Element
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return
    if (element.localName === 'select') {
      setters.get(element)?.()
      return
    }
    if (element.localName !== 'option' && element.localName !== 'optgroup') return
    node = node.parentNode
  }
}
