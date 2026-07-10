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
      return serializeElement(node as Element)
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

function serializeElement(element: Element): string {
  const localName = element.localName || element.tagName
  const tagName = element.prefix ? `${element.prefix}:${localName}` : localName
  const isHtml = isHtmlElement(element)
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

  if (isHtml && HTML_VOID_ELEMENTS.has(tagName.toLowerCase())) {
    return `${html}>`
  }

  if (!isHtml && element.childNodes.length === 0) {
    return `${html} />`
  }

  html += '>'
  const childSource =
    isHtml && tagName.toLowerCase() === 'template' && 'content' in element
      ? ((element as HTMLTemplateElement).content ?? element)
      : element
  html += serializeHtmlChildren(childSource)
  html += `</${tagName}>`
  return html
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
