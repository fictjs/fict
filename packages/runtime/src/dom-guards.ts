function getViewFromDocument(ownerDocument?: Document | null): (Window & typeof globalThis) | null {
  return (ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined) ?? null
}

function getOwnerDocument(value: unknown): Document | undefined {
  if (!value || typeof value !== 'object') return undefined
  try {
    const ownerDocument = (value as { ownerDocument?: Document | null }).ownerDocument
    if (ownerDocument) return ownerDocument
    return (value as { nodeType?: unknown }).nodeType === 9 ? (value as Document) : undefined
  } catch {
    return undefined
  }
}

type DomConstructor<T> = abstract new (...args: never[]) => T

function hasCtor<T>(
  ownerDocument: Document | undefined,
  name: string,
): DomConstructor<T> | undefined {
  const view = getViewFromDocument(ownerDocument)
  const fromView = view ? (view as unknown as Record<string, unknown>)[name] : undefined
  if (typeof fromView === 'function') return fromView as unknown as DomConstructor<T>
  const fromGlobal = (globalThis as unknown as Record<string, unknown>)[name]
  return typeof fromGlobal === 'function' ? (fromGlobal as unknown as DomConstructor<T>) : undefined
}

function getDomBrandGetter<T>(
  ctor: DomConstructor<T>,
  property: string,
): ((this: object) => unknown) | undefined {
  let prototype: object | null = ctor.prototype
  while (prototype) {
    const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get
    if (getter) return getter
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  return undefined
}

function matchesDomConstructor<T>(
  value: object,
  ownerDocument: Document | undefined,
  name: string,
  brandProperty: string,
  acceptsBrand: (brand: unknown) => boolean = () => true,
): boolean | undefined {
  const valueDocument = getOwnerDocument(value)
  const valueCtor = hasCtor<T>(valueDocument, name)
  const ownerCtor =
    ownerDocument && ownerDocument !== valueDocument ? hasCtor<T>(ownerDocument, name) : undefined

  const constructors = [...new Set([valueCtor, ownerCtor].filter(Boolean))] as DomConstructor<T>[]
  let foundBrandGetter = false
  let matchesInstance = false

  for (const ctor of constructors) {
    matchesInstance ||= value instanceof ctor
    const getter = getDomBrandGetter(ctor, brandProperty)
    if (!getter) continue
    foundBrandGetter = true
    try {
      if (acceptsBrand(getter.call(value))) return true
    } catch {
      // A native Web IDL getter rejects objects without the corresponding DOM brand.
    }
  }

  if (foundBrandGetter) return false
  return constructors.length > 0 ? matchesInstance : undefined
}

export function isNodeLike(value: unknown, ownerDocument?: Document): value is Node {
  if (!value || typeof value !== 'object') return false
  const matchesCtor = matchesDomConstructor<Node>(value, ownerDocument, 'Node', 'nodeType')
  if (matchesCtor !== undefined) return matchesCtor
  return (
    typeof (value as { nodeType?: unknown }).nodeType === 'number' &&
    typeof (value as { nodeName?: unknown }).nodeName === 'string'
  )
}

export function isElementLike(value: unknown, ownerDocument?: Document): value is Element {
  if (!value || typeof value !== 'object') return false
  const matchesCtor = matchesDomConstructor<Element>(
    value,
    ownerDocument,
    'Element',
    'nodeType',
    nodeType => nodeType === 1,
  )
  if (matchesCtor !== undefined) return matchesCtor
  return (value as { nodeType?: unknown }).nodeType === 1
}

export function isHTMLElementLike(value: unknown, ownerDocument?: Document): value is HTMLElement {
  if (!value || typeof value !== 'object') return false
  const matchesCtor = matchesDomConstructor<HTMLElement>(
    value,
    ownerDocument,
    'HTMLElement',
    'title',
  )
  if (matchesCtor !== undefined) return matchesCtor
  return isElementLike(value, ownerDocument) && 'style' in value
}

export function isDocumentFragmentLike(
  value: unknown,
  ownerDocument?: Document,
): value is DocumentFragment {
  if (!value || typeof value !== 'object') return false
  const matchesCtor = matchesDomConstructor<DocumentFragment>(
    value,
    ownerDocument,
    'DocumentFragment',
    'nodeType',
    nodeType => nodeType === 11,
  )
  if (matchesCtor !== undefined) return matchesCtor
  return (value as { nodeType?: unknown }).nodeType === 11
}

export function isCommentLike(value: unknown, ownerDocument?: Document): value is Comment {
  if (!value || typeof value !== 'object') return false
  const matchesCtor = matchesDomConstructor<Comment>(
    value,
    ownerDocument,
    'Comment',
    'nodeType',
    nodeType => nodeType === 8,
  )
  if (matchesCtor !== undefined) return matchesCtor
  return (value as { nodeType?: unknown }).nodeType === 8
}
