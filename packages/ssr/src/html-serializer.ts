import { assertValidDOMAttributeName, assertValidDOMElementName } from '@fictjs/runtime/internal'

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

// In these elements, character references are not decoded by the HTML parser.
// Escaping the whole text as `&lt;` would therefore change executable script,
// stylesheet, and fallback content. Neutralize only an actual matching end tag.
const HTML_RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'xmp',
])

const HTML_TABLE_SECTION_ELEMENTS = new Set(['tbody', 'thead', 'tfoot'])
const HTML_TEXT_ONLY_ELEMENTS = new Set([
  ...HTML_RAW_TEXT_ELEMENTS,
  'plaintext',
  'textarea',
  'title',
])
const HTML_DOCUMENT_STRUCTURE_ELEMENTS = new Set(['frameset', 'head', 'html'])
const HTML_UNSAFE_RESUMABLE_HOST_PARENTS = new Set([
  'colgroup',
  'option',
  'optgroup',
  'select',
  'table',
  'tr',
  ...HTML_TABLE_SECTION_ELEMENTS,
  ...HTML_TEXT_ONLY_ELEMENTS,
  ...HTML_DOCUMENT_STRUCTURE_ELEMENTS,
])

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4
const PROCESSING_INSTRUCTION_NODE = 7
const COMMENT_NODE = 8
const DOCUMENT_NODE = 9
const DOCUMENT_TYPE_NODE = 10
const DOCUMENT_FRAGMENT_NODE = 11

/**
 * Serialize a DOM subtree as HTML without relying on the host DOM's
 * `innerHTML`/`outerHTML` implementation. Some lightweight server DOMs do not
 * escape ampersands in attributes or matching end tags in raw-text elements,
 * so their output can produce a different (and unsafe) tree when a browser
 * parses it again.
 */
export function serializeHtmlNode(node: Node, parentElement: Element | null = null): string {
  switch (node.nodeType) {
    case ELEMENT_NODE:
      return serializeElement(node as Element, parentElement)
    case TEXT_NODE:
    case CDATA_SECTION_NODE:
      return serializeText(node.nodeValue ?? '', parentElement)
    case COMMENT_NODE:
      return serializeComment(node.nodeValue ?? '')
    case DOCUMENT_NODE:
    case DOCUMENT_FRAGMENT_NODE:
      return serializeHtmlChildren(node)
    case DOCUMENT_TYPE_NODE:
      return serializeDocumentType(node as DocumentType)
    case PROCESSING_INSTRUCTION_NODE:
      // HTML has no processing-instruction syntax: `<?...>` is parsed as a
      // bogus comment only until the first `>`, so arbitrary PI data could
      // otherwise reopen markup. Preserve it as an inert HTML comment.
      return serializeComment(`?${node.nodeName} ${node.nodeValue ?? ''}?`)
    default:
      return ''
  }
}

export function serializeHtmlChildren(parent: Node): string {
  const parentElement = parent.nodeType === ELEMENT_NODE ? (parent as Element) : null
  return serializeHtmlNodes(parent.childNodes, parentElement)
}

export function serializeHtmlNodes(
  nodes: Iterable<Node>,
  parentElement: Element | null = null,
): string {
  let html = ''
  for (const node of nodes) html += serializeHtmlNode(node, parentElement)

  // Adjacent DOM text nodes remain separate in memory but are concatenated in
  // the HTML byte stream. Re-check the complete child serialization so an end
  // tag split across text-node boundaries cannot evade raw-text escaping.
  const rawTextTagName = getRawTextTagName(parentElement)
  return rawTextTagName ? escapeRawTextEndTag(html, rawTextTagName) : html
}

function serializeElement(element: Element, serializedParent: Element | null): string {
  const localName = element.localName || element.tagName
  const tagName = element.prefix ? `${element.prefix}:${localName}` : localName
  const isHtml = isHtmlElement(element)
  const normalizedTagName = tagName.toLowerCase()
  assertSafeResumableHostContext(element, serializedParent)
  assertValidDOMElementName(tagName, !isHtml, isHtml ? undefined : element.namespaceURI)
  let html = `<${tagName}`

  for (const attribute of Array.from(element.attributes)) {
    assertValidDOMAttributeName(
      attribute.name,
      attribute.namespaceURI != null,
      attribute.namespaceURI ?? undefined,
    )
    html += ` ${attribute.name}="${escapeAttributeValue(attribute.value)}"`
  }

  if (isHtml && HTML_VOID_ELEMENTS.has(normalizedTagName)) {
    assertEmptyHtmlVoidElement(element, normalizedTagName)
    return `${html}>`
  }

  html += '>'
  const childSource =
    isHtml && normalizedTagName === 'template' && 'content' in element
      ? ((element as HTMLTemplateElement).content ?? element)
      : element
  if (childSource !== element) {
    assertSafeTemplateContent(childSource)
  }
  html += serializeHtmlChildren(childSource)
  html += `</${tagName}>`
  return html
}

function assertEmptyHtmlVoidElement(element: Element, tagName: string): void {
  const childCount = element.childNodes.length
  if (childCount === 0) return

  const feature = findResumableFeature(element)
  const discardedResumableState =
    feature?.kind === 'scope'
      ? ` The discarded children contain a resumable scope (${feature.detail}), which would leave orphaned snapshot state.`
      : feature
        ? ` The discarded children contain a resumable event (${feature.detail}), which would disappear from the parsed document.`
        : ''
  throw new Error(
    `[fict/ssr] Cannot serialize <${tagName}> with ${childCount} child node${childCount === 1 ? '' : 's'}. ` +
      `HTML void elements cannot contain children, and browsers omit every child when serializing or parsing <${tagName}>.${discardedResumableState} ` +
      `Remove all children from <${tagName}> and move the content outside the void element.`,
  )
}

function assertSafeResumableHostContext(element: Element, serializedParent: Element | null): void {
  if (!isResumableFictHost(element)) return

  const parent = serializedParent ?? element.parentElement
  if (!parent || !isHtmlElement(parent)) return

  const contextTag = (parent.localName || parent.tagName).toLowerCase()
  if (!HTML_UNSAFE_RESUMABLE_HOST_PARENTS.has(contextTag)) return

  const scopeId = element.getAttribute('data-fict-s') ?? '<unknown>'
  throw new Error(
    `[fict/ssr] Cannot serialize resumable <fict-host> scope ${JSON.stringify(scopeId)} inside <${contextTag}>. ` +
      `The HTML parser will not preserve that host at this location, so its scope would target different DOM after parsing. ` +
      getResumableHostRewriteSuggestion(contextTag),
  )
}

function isResumableFictHost(element: Element): boolean {
  return (
    isHtmlElement(element) &&
    (element.localName || element.tagName).toLowerCase() === 'fict-host' &&
    element.hasAttribute('data-fict-host') &&
    !!element.getAttribute('data-fict-s')
  )
}

function getResumableHostRewriteSuggestion(contextTag: string): string {
  if (contextTag === 'table') {
    return 'Move the component outside <table>, or make it own the complete table while keeping table sections as native elements.'
  }
  if (HTML_TABLE_SECTION_ELEMENTS.has(contextTag)) {
    return 'Move the component into a native <td> or <th> within the row, or move its resumable boundary outside the table.'
  }
  if (contextTag === 'tr') {
    return 'Move the component inside a native <td> or <th>, rather than using a component as a direct row child.'
  }
  if (contextTag === 'colgroup') {
    return 'Move the component outside <colgroup>, or make it own the complete table and render <col> elements natively.'
  }
  if (contextTag === 'select' || contextTag === 'optgroup' || contextTag === 'option') {
    return 'Move the component outside <select>, or make it own the complete select while rendering option structure natively.'
  }
  if (HTML_TEXT_ONLY_ELEMENTS.has(contextTag)) {
    return `Move the component outside <${contextTag}> and make it own that element; bind its value or text content instead of nesting a component inside it.`
  }
  return 'Move the component into <body> content, outside document-structure elements.'
}

type SerializedResumableFeature =
  | { kind: 'scope'; detail: string }
  | { kind: 'event'; detail: string }

function assertSafeTemplateContent(content: DocumentFragment | Element): void {
  const feature = findResumableFeature(content)
  if (!feature) return

  const label = feature.kind === 'scope' ? 'resumable scope' : 'resumable event'
  throw new Error(
    `[fict/ssr] Cannot serialize <template> content containing a ${label} (${feature.detail}). ` +
      'Native template content can be cloned more than once, but the current resumability protocol assigns only one runtime scope to each server scope id. ' +
      'Move the resumable component or event outside <template>.',
  )
}

function findResumableFeature(root: Node): SerializedResumableFeature | null {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== ELEMENT_NODE) continue
    const element = child as Element
    const scopeId = element.getAttribute('data-fict-s')
    if (scopeId) {
      return { kind: 'scope', detail: `data-fict-s=${JSON.stringify(scopeId)}` }
    }
    const resumeQrl = element.getAttribute('data-fict-h')
    if (resumeQrl) {
      return { kind: 'scope', detail: `data-fict-h=${JSON.stringify(resumeQrl)}` }
    }
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.value && attribute.name.startsWith('on:') && attribute.name.length > 3) {
        return { kind: 'event', detail: attribute.name }
      }
    }

    const childRoot =
      isHtmlElement(element) &&
      (element.localName || element.tagName).toLowerCase() === 'template' &&
      'content' in element
        ? ((element as HTMLTemplateElement).content ?? element)
        : element
    const nested = findResumableFeature(childRoot)
    if (nested) return nested
  }
  return null
}

function serializeText(value: string, parentElement: Element | null): string {
  const rawTextTagName = getRawTextTagName(parentElement)
  if (rawTextTagName) return escapeRawTextEndTag(value, rawTextTagName)

  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeRawTextEndTag(value: string, tagName: string): string {
  const endTag = new RegExp(`</${tagName}(?=[\\t\\n\\f\\r />])`, 'gi')
  return value.replace(endTag, match => `<\\/${match.slice(2)}`)
}

function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function serializeComment(value: string): string {
  // `--`, a trailing `-`, and leading `>` / `->` are not valid in an HTML
  // comment. In particular, `<!--><script>...` exits the comment immediately,
  // so an otherwise inert DOM Comment could become active markup when the SSR
  // output is parsed by a browser.
  let safe = value.replace(/--/g, '- -').replace(/-$/, '- ')
  if (safe.startsWith('>') || safe.startsWith('->')) {
    safe = ` ${safe}`
  }
  return `<!--${safe}-->`
}

function serializeDocumentType(doctype: DocumentType): string {
  const name = doctype.name || 'html'
  assertValidDOMElementName(name, true)
  if (doctype.publicId) {
    const system = doctype.systemId ? ` "${escapeAttributeValue(doctype.systemId)}"` : ''
    return `<!DOCTYPE ${name} PUBLIC "${escapeAttributeValue(doctype.publicId)}"${system}>`
  }
  if (doctype.systemId) {
    return `<!DOCTYPE ${name} SYSTEM "${escapeAttributeValue(doctype.systemId)}">`
  }
  return `<!DOCTYPE ${name}>`
}

function isHtmlElement(element: Element): boolean {
  return element.namespaceURI === null || element.namespaceURI === HTML_NAMESPACE
}

function getRawTextTagName(element: Element | null): string | null {
  if (!element || !isHtmlElement(element)) return null
  const tagName = (element.localName || element.tagName).toLowerCase()
  return HTML_RAW_TEXT_ELEMENTS.has(tagName) ? tagName : null
}
