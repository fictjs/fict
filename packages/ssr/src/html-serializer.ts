import { assertValidDOMAttributeName, assertValidDOMElementName } from '@fictjs/runtime/internal'

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML'

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
// This list only covers confirmed native HTML algorithms that require direct
// children. Generic CSS selectors, Shadow DOM slotting, and DOM child APIs
// cannot be made transparent with a denylist and remain range-v3 concerns.
const HTML_HOST_SENSITIVE_CONTEXT_CHILDREN = new Map([
  ['details', new Set(['summary'])],
  ['fieldset', new Set(['legend'])],
  ['audio', new Set(['source', 'track'])],
  ['video', new Set(['source', 'track'])],
  ['ruby', new Set(['rp', 'rt'])],
  ['figure', new Set(['figcaption'])],
  ['map', new Set(['area'])],
])

const STREAM_BOUNDARY_START_PREFIX = 'fict:suspense-start:'
const STREAM_BOUNDARY_END_PREFIX = 'fict:suspense-end:'
const SCRIPT_SUPPORTING_ELEMENTS = ['script', 'template']
const HTML_STREAM_BOUNDARY_ALLOWED_CHILDREN = new Map([
  [
    'table',
    new Set(['caption', 'colgroup', 'tbody', 'tfoot', 'thead', ...SCRIPT_SUPPORTING_ELEMENTS]),
  ],
  ['tbody', new Set(['tr', ...SCRIPT_SUPPORTING_ELEMENTS])],
  ['thead', new Set(['tr', ...SCRIPT_SUPPORTING_ELEMENTS])],
  ['tfoot', new Set(['tr', ...SCRIPT_SUPPORTING_ELEMENTS])],
  ['tr', new Set(['td', 'th', ...SCRIPT_SUPPORTING_ELEMENTS])],
  ['colgroup', new Set(['col', 'template'])],
  ['select', new Set(['hr', 'optgroup', 'option', ...SCRIPT_SUPPORTING_ELEMENTS])],
  ['optgroup', new Set(['option', ...SCRIPT_SUPPORTING_ELEMENTS])],
  ['option', new Set<string>()],
])
const HTML_STREAM_BOUNDARY_TEXT_CONTEXTS = new Set(['option', 'optgroup', 'select'])

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
  if (parentElement && isHtmlElement(parentElement)) {
    const parentTagName = (parentElement.localName || parentElement.tagName).toLowerCase()
    assertSafeStreamingBoundaryContext(parentElement, parentTagName)
  }

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
  if (isHtml && normalizedTagName === 'plaintext') {
    throw new Error(
      '[fict/ssr] Cannot serialize HTML <plaintext>. The HTML syntax has no closing tag for this element, so a browser would consume every following tag, ancestor closing tag, and snapshot script as text. Use <pre> for preformatted HTML content or return a text/plain response instead.',
    )
  }
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
  const discardedResumableState = describeDiscardedResumableFeature(feature)
  throw new Error(
    `[fict/ssr] Cannot serialize <${tagName}> with ${childCount} child node${childCount === 1 ? '' : 's'}. ` +
      `HTML void elements cannot contain children, and browsers omit every child when serializing or parsing <${tagName}>.${discardedResumableState} ` +
      `Remove all children from <${tagName}> and move the content outside the void element.`,
  )
}

function assertSafeStreamingBoundaryContext(element: Element, contextTag: string): void {
  if (HTML_TEXT_ONLY_ELEMENTS.has(contextTag)) {
    const marker = findStreamingBoundaryMarker(element)
    if (!marker) return
    throw new Error(
      `[fict/ssr] Cannot serialize a streaming Suspense boundary inside <${contextTag}>. ` +
        `The HTML parser treats its comment markers as text in this context, so the streamed patch can never find boundary ${JSON.stringify(marker.id)}. ` +
        `Move the streaming boundary outside <${contextTag}> and update this element through an outer component.`,
    )
  }

  const allowedChildren = HTML_STREAM_BOUNDARY_ALLOWED_CHILDREN.get(contextTag)
  if (!allowedChildren) return

  const children = Array.from(element.childNodes)
  for (let index = 0; index < children.length; index++) {
    const start = parseStreamingBoundaryMarker(children[index])
    if (start?.kind !== 'start') continue

    let endIndex = index + 1
    while (endIndex < children.length) {
      const end = parseStreamingBoundaryMarker(children[endIndex])
      if (end?.kind === 'end' && end.id === start.id) break
      endIndex++
    }
    if (endIndex === children.length) {
      throw new Error(
        `[fict/ssr] Cannot serialize streaming Suspense boundary ${JSON.stringify(start.id)} inside <${contextTag}> because its sibling end marker is missing.`,
      )
    }

    for (let contentIndex = index + 1; contentIndex < endIndex; contentIndex++) {
      const invalidContent = describeInvalidBoundaryContent(
        children[contentIndex]!,
        allowedChildren,
        HTML_STREAM_BOUNDARY_TEXT_CONTEXTS.has(contextTag),
      )
      if (!invalidContent) continue
      throw new Error(
        `[fict/ssr] Cannot serialize a streaming Suspense boundary inside <${contextTag}> with direct ${invalidContent} content. ` +
          `The HTML parser reparents or discards that content, so the boundary markers no longer describe one patchable sibling range. ` +
          getStreamingBoundaryRewriteSuggestion(contextTag, invalidContent),
      )
    }
  }
}

function describeInvalidBoundaryContent(
  node: Node,
  allowedElements: ReadonlySet<string>,
  allowText: boolean,
): string | null {
  if (node.nodeType === COMMENT_NODE) return null
  if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) {
    return allowText || !(node.nodeValue ?? '').trim() ? null : 'non-whitespace text'
  }
  if (node.nodeType !== ELEMENT_NODE) return `node type ${node.nodeType}`

  const element = node as Element
  const tagName = (element.localName || element.tagName).toLowerCase()
  return isHtmlElement(element) && allowedElements.has(tagName) ? null : `<${tagName}>`
}

function getStreamingBoundaryRewriteSuggestion(contextTag: string, invalidContent: string): string {
  if (contextTag === 'table' && invalidContent === '<tr>') {
    return 'Wrap the boundary and rows in an explicit <tbody>.'
  }
  if (contextTag === 'table' && invalidContent === '<col>') {
    return 'Wrap the boundary and columns in an explicit <colgroup>.'
  }
  if (HTML_TABLE_SECTION_ELEMENTS.has(contextTag)) {
    return `Wrap cells in a native <tr>, or move the boundary outside <${contextTag}>.`
  }
  if (contextTag === 'tr') {
    return 'Render only native <td> or <th> roots inside this boundary.'
  }
  if (contextTag === 'colgroup') {
    return 'Render only native <col> roots inside this boundary.'
  }
  if (contextTag === 'select' || contextTag === 'optgroup' || contextTag === 'option') {
    return 'Use only portable native option content, or move the boundary outside <select>.'
  }
  return `Move the boundary outside <${contextTag}> or wrap its content in a parser-stable native container.`
}

function assertSafeResumableHostContext(element: Element, serializedParent: Element | null): void {
  if (!isResumableFictHost(element)) return

  const foreignNamespace = getResumableHostForeignNamespace(element, serializedParent)
  if (foreignNamespace) {
    const scopeId = element.getAttribute('data-fict-s') ?? '<unknown>'
    const namespaceDescription =
      foreignNamespace.kind === 'other'
        ? `foreign namespace ${JSON.stringify(foreignNamespace.uri)}`
        : `the ${foreignNamespace.kind} namespace`
    const semanticRisk =
      foreignNamespace.kind === 'SVG'
        ? 'A custom element wrapper is not structurally transparent in SVG and can suppress the graphics it contains after HTML parsing.'
        : foreignNamespace.kind === 'MathML'
          ? 'A custom element wrapper is not structurally transparent in MathML and can replace the intended operands of fixed-arity layout elements after HTML parsing.'
          : 'A custom element wrapper is not guaranteed to be structurally transparent in foreign content after HTML parsing.'
    throw new Error(
      `[fict/ssr] Cannot serialize resumable <fict-host> scope ${JSON.stringify(scopeId)} in ${namespaceDescription}. ` +
        `${semanticRisk} Range-based scope anchors (range-v3) are required for resumable components in foreign content; ` +
        'move the component boundary outside the foreign-content subtree until that protocol is available.',
    )
  }

  const parent = serializedParent ?? element.parentElement
  if (!parent || !isHtmlElement(parent)) return

  const contextTag = (parent.localName || parent.tagName).toLowerCase()
  if (HTML_UNSAFE_RESUMABLE_HOST_PARENTS.has(contextTag)) {
    const scopeId = element.getAttribute('data-fict-s') ?? '<unknown>'
    throw new Error(
      `[fict/ssr] Cannot serialize resumable <fict-host> scope ${JSON.stringify(scopeId)} inside <${contextTag}>. ` +
        `The HTML parser will not preserve that host at this location, so its scope would target different DOM after parsing. ` +
        getResumableHostRewriteSuggestion(contextTag),
    )
  }

  assertSafeHostSensitiveHtmlContext(element, contextTag)
}

function isResumableFictHost(element: Element): boolean {
  return (
    (element.localName || element.tagName).toLowerCase() === 'fict-host' &&
    element.hasAttribute('data-fict-host') &&
    !!element.getAttribute('data-fict-s')
  )
}

function assertSafeHostSensitiveHtmlContext(host: Element, contextTag: string): void {
  let sensitiveDescription: string
  if (contextTag === 'picture') {
    sensitiveDescription = 'the native <source> and <img> structure'
  } else {
    const sensitiveTags = HTML_HOST_SENSITIVE_CONTEXT_CHILDREN.get(contextTag)
    if (!sensitiveTags) return

    const sensitiveTag = findTransparentDirectChildTag(host, sensitiveTags)
    if (!sensitiveTag) return
    sensitiveDescription = `a transparent direct <${sensitiveTag}> child`
  }

  const scopeId = host.getAttribute('data-fict-s') ?? '<unknown>'
  throw new Error(
    `[fict/ssr] Cannot serialize resumable <fict-host> scope ${JSON.stringify(scopeId)} as a component boundary inside <${contextTag}> around ${sensitiveDescription}. ` +
      `${getHostSensitiveContextRisk(contextTag)} CSS display: contents removes only the host's box; it does not make the host transparent to these DOM rules. ` +
      `Move the component boundary outside <${contextTag}> and make the component own <${contextTag}>, so its sensitive content remains native direct children. ` +
      'Range-based scope anchors (range-v3) are required to keep a resumable boundary at this position without an element wrapper.',
  )
}

function findTransparentDirectChildTag(
  host: Element,
  sensitiveTags: ReadonlySet<string>,
): string | null {
  for (const child of Array.from(host.children)) {
    if (!isHtmlElement(child)) continue

    // Only an uninterrupted chain of Fict's own scope hosts is transparent in
    // the future range protocol. Ordinary elements and unmarked user-created
    // <fict-host> elements remain real structural barriers.
    if (isResumableFictHost(child)) {
      const nestedTag = findTransparentDirectChildTag(child, sensitiveTags)
      if (nestedTag) return nestedTag
      continue
    }

    const childTag = (child.localName || child.tagName).toLowerCase()
    if (sensitiveTags.has(childTag)) return childTag
  }
  return null
}

function getHostSensitiveContextRisk(contextTag: string): string {
  switch (contextTag) {
    case 'picture':
      return 'Browsers select picture candidates from its direct <source>/<img> structure, so a wrapper can silently select the fallback image.'
    case 'details':
      return 'Only a direct <summary> child provides the native disclosure control, so wrapping it prevents activation from toggling <details>.'
    case 'fieldset':
      return 'A direct <legend> supplies the fieldset name and its first-legend disabled-state exemption, both of which a wrapper removes.'
    case 'audio':
    case 'video':
      return `Browsers discover <source> and <track> from direct <${contextTag}> children, so wrapped media resources and text tracks are ignored.`
    case 'ruby':
      return 'Ruby annotation layout depends on direct <rt>/<rp> structure, and wrappers cause annotations to render as ordinary inline content in some browsers.'
    case 'figure':
      return 'A direct <figcaption> provides the accessible name of <figure>, which is lost through a wrapper.'
    case 'map':
      return 'Browser image-map and areas-collection behavior diverges when <area> is hidden behind a wrapper.'
    default:
      return 'This HTML context assigns semantics through native direct-child relationships that an element wrapper changes.'
  }
}

type ResumableHostForeignNamespace = { kind: 'SVG' | 'MathML' } | { kind: 'other'; uri: string }

function getResumableHostForeignNamespace(
  element: Element,
  serializedParent: Element | null,
): ResumableHostForeignNamespace | null {
  const directNamespace = classifyForeignNamespace(element.namespaceURI)
  if (directNamespace) return directNamespace

  // linkedom currently reports MathML elements as XHTML. Recover the browser
  // parser context from ancestry so a MathML host cannot evade validation.
  // SVG <foreignObject> is an intentional HTML island, so an HTML host below
  // it remains valid unless a nested <svg> or <math> establishes a new context.
  let ancestor = serializedParent ?? element.parentElement
  while (ancestor) {
    const localName = (ancestor.localName || ancestor.tagName).toLowerCase()
    if (localName === 'foreignobject' && ancestor.namespaceURI === SVG_NAMESPACE) return null

    const ancestorNamespace = classifyForeignNamespace(ancestor.namespaceURI)
    if (ancestorNamespace) return ancestorNamespace
    if (localName === 'svg') return { kind: 'SVG' }
    if (localName === 'math') return { kind: 'MathML' }
    ancestor = ancestor.parentElement
  }
  return null
}

function classifyForeignNamespace(
  namespaceURI: string | null,
): ResumableHostForeignNamespace | null {
  if (namespaceURI === null || namespaceURI === HTML_NAMESPACE) return null
  if (namespaceURI === SVG_NAMESPACE) return { kind: 'SVG' }
  if (namespaceURI === MATHML_NAMESPACE) return { kind: 'MathML' }
  return { kind: 'other', uri: namespaceURI }
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
  | { kind: 'boundary'; detail: string }

interface StreamingBoundaryMarker {
  kind: 'start' | 'end'
  id: string
}

function describeDiscardedResumableFeature(feature: SerializedResumableFeature | null): string {
  if (!feature) return ''
  if (feature.kind === 'scope') {
    return ` The discarded children contain a resumable scope (${feature.detail}), which would leave orphaned snapshot state.`
  }
  if (feature.kind === 'event') {
    return ` The discarded children contain a resumable event (${feature.detail}), which would disappear from the parsed document.`
  }
  return ` The discarded children contain a streaming Suspense boundary (${feature.detail}), which would leave an unpatchable stream.`
}

function assertSafeTemplateContent(content: DocumentFragment | Element): void {
  const feature = findResumableFeature(content)
  if (!feature) return

  if (feature.kind === 'boundary') {
    throw new Error(
      `[fict/ssr] Cannot serialize <template> content containing a streaming Suspense boundary (${feature.detail}). ` +
        'Native template content can be cloned more than once, which duplicates the stream boundary id and makes patch targeting ambiguous. ' +
        'Move the streaming boundary outside <template>.',
    )
  }

  const label = feature.kind === 'scope' ? 'resumable scope' : 'resumable event'
  throw new Error(
    `[fict/ssr] Cannot serialize <template> content containing a ${label} (${feature.detail}). ` +
      'Native template content can be cloned more than once, but the current resumability protocol assigns only one runtime scope to each server scope id. ' +
      'Move the resumable component or event outside <template>.',
  )
}

function findResumableFeature(root: Node): SerializedResumableFeature | null {
  for (const child of Array.from(root.childNodes)) {
    const boundary = parseStreamingBoundaryMarker(child)
    if (boundary) {
      return {
        kind: 'boundary',
        detail: `${boundary.kind} id ${JSON.stringify(boundary.id)}`,
      }
    }
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

function findStreamingBoundaryMarker(root: Node): StreamingBoundaryMarker | null {
  for (const child of Array.from(root.childNodes)) {
    const marker = parseStreamingBoundaryMarker(child)
    if (marker) return marker
    if (child.nodeType !== ELEMENT_NODE) continue

    const element = child as Element
    const childRoot =
      isHtmlElement(element) &&
      (element.localName || element.tagName).toLowerCase() === 'template' &&
      'content' in element
        ? ((element as HTMLTemplateElement).content ?? element)
        : element
    const nested = findStreamingBoundaryMarker(childRoot)
    if (nested) return nested
  }
  return null
}

function parseStreamingBoundaryMarker(node: Node | undefined): StreamingBoundaryMarker | null {
  if (!node || node.nodeType !== COMMENT_NODE) return null
  const value = node.nodeValue ?? ''
  if (value.startsWith(STREAM_BOUNDARY_START_PREFIX)) {
    const id = value.slice(STREAM_BOUNDARY_START_PREFIX.length)
    return id ? { kind: 'start', id } : null
  }
  if (value.startsWith(STREAM_BOUNDARY_END_PREFIX)) {
    const id = value.slice(STREAM_BOUNDARY_END_PREFIX.length)
    return id ? { kind: 'end', id } : null
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
