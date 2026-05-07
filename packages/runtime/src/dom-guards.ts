function getViewFromDocument(ownerDocument?: Document | null): (Window & typeof globalThis) | null {
  return (ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined) ?? null
}

function getOwnerDocument(value: unknown): Document | undefined {
  if (!value || typeof value !== 'object') return undefined
  return (value as { ownerDocument?: Document | undefined }).ownerDocument
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

export function isNodeLike(value: unknown, ownerDocument?: Document): value is Node {
  if (!value || typeof value !== 'object') return false
  const doc = ownerDocument ?? getOwnerDocument(value)
  const NodeCtor = hasCtor<Node>(doc, 'Node')
  if (NodeCtor) return value instanceof NodeCtor
  return (
    typeof (value as { nodeType?: unknown }).nodeType === 'number' &&
    typeof (value as { nodeName?: unknown }).nodeName === 'string'
  )
}

export function isElementLike(value: unknown, ownerDocument?: Document): value is Element {
  if (!value || typeof value !== 'object') return false
  const doc = ownerDocument ?? getOwnerDocument(value)
  const ElementCtor = hasCtor<Element>(doc, 'Element')
  if (ElementCtor) return value instanceof ElementCtor
  return (value as { nodeType?: unknown }).nodeType === 1
}

export function isHTMLElementLike(value: unknown, ownerDocument?: Document): value is HTMLElement {
  if (!value || typeof value !== 'object') return false
  const doc = ownerDocument ?? getOwnerDocument(value)
  const HTMLElementCtor = hasCtor<HTMLElement>(doc, 'HTMLElement')
  if (HTMLElementCtor) return value instanceof HTMLElementCtor
  return isElementLike(value, doc) && 'style' in value
}

export function isDocumentFragmentLike(
  value: unknown,
  ownerDocument?: Document,
): value is DocumentFragment {
  if (!value || typeof value !== 'object') return false
  const doc = ownerDocument ?? getOwnerDocument(value)
  const FragmentCtor = hasCtor<DocumentFragment>(doc, 'DocumentFragment')
  if (FragmentCtor) return value instanceof FragmentCtor
  return (value as { nodeType?: unknown }).nodeType === 11
}

export function isCommentLike(value: unknown, ownerDocument?: Document): value is Comment {
  if (!value || typeof value !== 'object') return false
  const doc = ownerDocument ?? getOwnerDocument(value)
  const CommentCtor = hasCtor<Comment>(doc, 'Comment')
  if (CommentCtor) return value instanceof CommentCtor
  return (value as { nodeType?: unknown }).nodeType === 8
}
