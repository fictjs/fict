function getViewFromDocument(ownerDocument?: Document | null): (Window & typeof globalThis) | null {
  return (ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined) ?? null
}

function getOwnerDocument(value: unknown): Document | undefined {
  if (!value || typeof value !== 'object') return undefined
  const ownerDocument = (value as { ownerDocument?: Document | null }).ownerDocument
  if (ownerDocument) return ownerDocument
  return (value as { nodeType?: unknown }).nodeType === 9 ? (value as Document) : undefined
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

function matchesDomConstructor<T>(
  value: object,
  ownerDocument: Document | undefined,
  name: string,
): boolean | undefined {
  const valueDocument = getOwnerDocument(value)
  const valueCtor = hasCtor<T>(valueDocument, name)
  if (valueCtor && value instanceof valueCtor) return true

  const ownerCtor =
    ownerDocument && ownerDocument !== valueDocument ? hasCtor<T>(ownerDocument, name) : undefined
  if (ownerCtor && value instanceof ownerCtor) return true

  return valueCtor || ownerCtor ? false : undefined
}

export function isNodeLike(value: unknown, ownerDocument?: Document): value is Node {
  if (!value || typeof value !== 'object') return false
  const matchesCtor = matchesDomConstructor<Node>(value, ownerDocument, 'Node')
  if (matchesCtor !== undefined) return matchesCtor
  return (
    typeof (value as { nodeType?: unknown }).nodeType === 'number' &&
    typeof (value as { nodeName?: unknown }).nodeName === 'string'
  )
}

export function isElementLike(value: unknown, ownerDocument?: Document): value is Element {
  if (!value || typeof value !== 'object') return false
  const matchesCtor = matchesDomConstructor<Element>(value, ownerDocument, 'Element')
  if (matchesCtor !== undefined) return matchesCtor
  return (value as { nodeType?: unknown }).nodeType === 1
}

export function isHTMLElementLike(value: unknown, ownerDocument?: Document): value is HTMLElement {
  if (!value || typeof value !== 'object') return false
  const matchesCtor = matchesDomConstructor<HTMLElement>(value, ownerDocument, 'HTMLElement')
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
  )
  if (matchesCtor !== undefined) return matchesCtor
  return (value as { nodeType?: unknown }).nodeType === 11
}

export function isCommentLike(value: unknown, ownerDocument?: Document): value is Comment {
  if (!value || typeof value !== 'object') return false
  const matchesCtor = matchesDomConstructor<Comment>(value, ownerDocument, 'Comment')
  if (matchesCtor !== undefined) return matchesCtor
  return (value as { nodeType?: unknown }).nodeType === 8
}
