import type { CodegenContext } from './codegen'
import { shouldAutoExtract } from './codegen-auto-extract'
import {
  isCustomElementTagName,
  isDOMProperty,
  isDOMTemplateProperty,
  toCustomElementPropertyName,
} from './codegen-dom-utils'
import {
  HIRError,
  type Expression,
  type Identifier,
  type JSXChild,
  type JSXElementExpression,
} from './hir'

export interface HIRBinding {
  type: 'attr' | 'child' | 'event' | 'key' | 'spread' | 'text' | 'textContent'
  path: number[] // path to navigate from root to target node
  name?: string | undefined // for attributes/events
  expr?: Expression | undefined // the dynamic expression
  exclude?: string[] | undefined // spread-only: keys overridden by following explicit attrs
  hasChildren?: boolean | undefined // content-prop bindings that conflict with JSX children
  eventOptions?: { capture?: boolean; passive?: boolean; once?: boolean } | undefined
  resumable?: boolean | undefined
  resumableExplicit?: boolean | undefined
  bindingTarget?: 'attribute' | 'property' | undefined
  /** Namespace context at this binding's location */
  namespace?: NamespaceContext | undefined
}

export interface HIRTemplateExtractionResult {
  html: string
  bindings: HIRBinding[]
  nodeCount: number
  /** Whether the root element is an SVG element (or child of SVG) */
  isSVG?: boolean | undefined
  /** Whether the root element is a MathML element (or child of MathML) */
  isMathML?: boolean | undefined
}

/** Namespace context type for template extraction */
export type NamespaceContext = 'svg' | 'mathml' | 'mathmlTextIntegration' | null

export interface TemplateExtractionOps {
  isLikelyTextExpression: (expr: Expression, ctx: CodegenContext) => boolean
}

interface NamespaceResolveOptions {
  allowStandaloneIntrinsic?: boolean | undefined
}

type JSXElementAttribute = JSXElementExpression['attributes'][number]

/**
 * Normalize attribute names for special cases.
 */
const SVG_ATTRIBUTE_ALIASES: Record<string, string> = {
  xmlnsXlink: 'xmlns:xlink',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeDasharray: 'stroke-dasharray',
  strokeDashoffset: 'stroke-dashoffset',
  strokeOpacity: 'stroke-opacity',
  fillOpacity: 'fill-opacity',
  fillRule: 'fill-rule',
  clipRule: 'clip-rule',
  transformOrigin: 'transform-origin',
  clipPath: 'clip-path',
  textAnchor: 'text-anchor',
  dominantBaseline: 'dominant-baseline',
  fontSize: 'font-size',
  fontFamily: 'font-family',
  fontWeight: 'font-weight',
  xlinkHref: 'xlink:href',
  stopColor: 'stop-color',
  stopOpacity: 'stop-opacity',
  markerStart: 'marker-start',
  markerMid: 'marker-mid',
  markerEnd: 'marker-end',
  vectorEffect: 'vector-effect',
}

export function normalizeHIRAttrName(name: string, namespace: NamespaceContext = null): string {
  if (name === 'className') return 'class'
  if (name === 'htmlFor') return 'for'
  if (namespace === 'svg') return SVG_ATTRIBUTE_ALIASES[name] ?? name
  return name
}

function addSpreadExclusionName(excluded: Set<string>, name: string): void {
  excluded.add(name)
  if (name === 'class' || name === 'className') {
    excluded.add('class')
    excluded.add('className')
  }
  if (name === 'for' || name === 'htmlFor') {
    excluded.add('for')
    excluded.add('htmlFor')
  }
}

export type ForcedBindingPrefix = 'attr' | 'bool' | 'prop'

export interface ForcedBindingName {
  prefix: ForcedBindingPrefix
  name: string
}

export function parseForcedBindingName(name: string): ForcedBindingName | null {
  if (name.length <= 5) return null
  if (name.startsWith('attr:')) return { prefix: 'attr', name: name.slice(5) }
  if (name.startsWith('bool:')) return { prefix: 'bool', name: name.slice(5) }
  if (name.startsWith('prop:')) return { prefix: 'prop', name: name.slice(5) }
  return null
}

function parseNamespacedEventName(name: string): { eventName: string; capture: boolean } | null {
  if (name.startsWith('oncapture:') && name.length > 'oncapture:'.length) {
    return { eventName: name.slice('oncapture:'.length), capture: true }
  }
  if (name.startsWith('on:') && name.length > 'on:'.length) {
    return { eventName: name.slice('on:'.length), capture: false }
  }
  return null
}

function isCamelCaseEventName(name: string): boolean {
  return name.startsWith('on') && name.length > 2 && /^[A-Z]$/.test(name[2] ?? '')
}

function normalizeEventAttributeName(name: string): { name: string; resumableExplicit: boolean } {
  if (!name.endsWith('$')) return { name, resumableExplicit: false }
  const eventCandidate = name.slice(0, -1)
  if (parseNamespacedEventName(eventCandidate) || isCamelCaseEventName(eventCandidate)) {
    return { name: eventCandidate, resumableExplicit: true }
  }
  return { name, resumableExplicit: false }
}

const EVENT_NAMES_WITH_MODIFIER_SUFFIX = ['GotPointerCapture', 'LostPointerCapture'] as const

function parseModifierSuffixes(
  suffix: string,
): { capture: boolean; passive: boolean; once: boolean } | null {
  let rest = suffix
  const modifiers = { capture: false, passive: false, once: false }
  while (rest.length > 0) {
    if (rest.startsWith('Capture')) {
      modifiers.capture = true
      rest = rest.slice('Capture'.length)
      continue
    }
    if (rest.startsWith('Passive')) {
      modifiers.passive = true
      rest = rest.slice('Passive'.length)
      continue
    }
    if (rest.startsWith('Once')) {
      modifiers.once = true
      rest = rest.slice('Once'.length)
      continue
    }
    return null
  }
  return modifiers
}

function parseKnownEventNameWithModifiers(
  eventName: string,
): { eventName: string; capture: boolean; passive: boolean; once: boolean } | null {
  for (const knownEventName of EVENT_NAMES_WITH_MODIFIER_SUFFIX) {
    if (!eventName.startsWith(knownEventName)) continue
    const modifiers = parseModifierSuffixes(eventName.slice(knownEventName.length))
    if (!modifiers) continue
    return { eventName: knownEventName, ...modifiers }
  }
  return null
}

function getStaticStringAttribute(
  attrs: readonly JSXElementAttribute[] | undefined,
  name: string,
): string | null {
  if (!attrs) return null
  const expected = name.toLowerCase()
  for (const attr of attrs) {
    if (attr.isSpread || attr.name.toLowerCase() !== expected) continue
    if (attr.value?.kind !== 'Literal' || typeof attr.value.value !== 'string') return null
    return attr.value.value
  }
  return null
}

function isHtmlAnnotationXmlEncoding(value: string | null): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'text/html' || normalized === 'application/xhtml+xml'
}

const MATHML_TEXT_INTEGRATION_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext'])
const MATHML_TEXT_INTEGRATION_EXCEPTIONS = new Set(['mglyph', 'malignmark'])
const SVG_HTML_INTEGRATION_POINTS = new Set(['foreignObject', 'title', 'desc'])
const HTML_RAW_TEXT_CONTENT_ELEMENTS = new Set(['script', 'style', 'title'])
// True RAWTEXT elements: the HTML parser does NOT decode entities inside them and
// does not parse comment markers, so their content must be emitted verbatim (or
// bound via textContent) rather than HTML-escaped with comment slots. `title`
// is RCDATA (entities decode), so it is intentionally excluded here.
const HTML_RAWTEXT_ELEMENTS = new Set(['script', 'style'])
const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
const STANDALONE_SVG_INTRINSIC_ELEMENTS = new Set([
  'animate',
  'animateMotion',
  'animateTransform',
  'circle',
  'clipPath',
  'defs',
  'desc',
  'ellipse',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feImage',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
  'filter',
  'g',
  'image',
  'line',
  'linearGradient',
  'marker',
  'mask',
  'metadata',
  'mpath',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialGradient',
  'rect',
  'set',
  'stop',
  'switch',
  'symbol',
  'text',
  'textPath',
  'tspan',
  'use',
  'view',
])
const STANDALONE_MATHML_INTRINSIC_ELEMENTS = new Set([
  'annotation',
  'maction',
  'maligngroup',
  'malignmark',
  'menclose',
  'merror',
  'mfenced',
  'mfrac',
  'mglyph',
  'mlabeledtr',
  'mlongdiv',
  'mmultiscripts',
  'mover',
  'mpadded',
  'mphantom',
  'mroot',
  'mrow',
  'msgroup',
  'msline',
  'mspace',
  'msqrt',
  'msrow',
  'mstack',
  'mstyle',
  'msub',
  'msubsup',
  'msup',
  'mtable',
  'mtd',
  'mtr',
  'munder',
  'munderover',
  'semantics',
])

/**
 * Resolve namespace context based on tag name and parent context.
 * - 'svg' enters SVG namespace
 * - 'math' enters MathML namespace
 * - SVG HTML integration points exit to null (HTML namespace)
 * - 'annotation-xml' with an HTML encoding inside MathML exits to null
 * - MathML text integration point children exit to HTML except mglyph/malignmark
 * - Otherwise inherit from parent context
 */
export function resolveNamespaceContext(
  tagName: string,
  parentNamespace: NamespaceContext,
  attrs?: readonly JSXElementAttribute[],
  options?: NamespaceResolveOptions,
): NamespaceContext {
  if (tagName === 'svg') return 'svg'
  if (tagName === 'math') return 'mathml'
  if (
    options?.allowStandaloneIntrinsic === true &&
    parentNamespace === null &&
    STANDALONE_SVG_INTRINSIC_ELEMENTS.has(tagName)
  ) {
    return 'svg'
  }
  if (
    options?.allowStandaloneIntrinsic === true &&
    parentNamespace === null &&
    MATHML_TEXT_INTEGRATION_POINTS.has(tagName)
  ) {
    return 'mathmlTextIntegration'
  }
  if (
    options?.allowStandaloneIntrinsic === true &&
    parentNamespace === null &&
    STANDALONE_MATHML_INTRINSIC_ELEMENTS.has(tagName)
  ) {
    return 'mathml'
  }
  if (parentNamespace === 'svg' && SVG_HTML_INTEGRATION_POINTS.has(tagName)) return null
  if (parentNamespace === 'mathmlTextIntegration') {
    return MATHML_TEXT_INTEGRATION_EXCEPTIONS.has(tagName) ? 'mathml' : null
  }
  if (
    tagName === 'annotation-xml' &&
    parentNamespace === 'mathml' &&
    isHtmlAnnotationXmlEncoding(getStaticStringAttribute(attrs, 'encoding'))
  ) {
    return null
  }
  if (parentNamespace === 'mathml' && MATHML_TEXT_INTEGRATION_POINTS.has(tagName)) {
    return 'mathmlTextIntegration'
  }
  return parentNamespace
}

function isStaticValue(expr: Expression | null): expr is Expression & { kind: 'Literal' } {
  if (!expr) return false
  if (expr.kind !== 'Literal') return false
  const { value } = expr
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function shouldBindRawTextContent(
  tagName: string,
  parentNamespace: NamespaceContext,
  resolvedNamespace: NamespaceContext,
): boolean {
  return (
    parentNamespace === null &&
    resolvedNamespace === null &&
    HTML_RAW_TEXT_CONTENT_ELEMENTS.has(tagName)
  )
}

function escapeHtmlAttributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shouldStringifyBooleanAttribute(name: string): boolean {
  const normalized = name.toLowerCase()
  return (
    normalized === 'draggable' ||
    normalized === 'contenteditable' ||
    normalized === 'spellcheck' ||
    normalized.startsWith('aria-') ||
    normalized.startsWith('data-')
  )
}

const PHRASING_HTML_TAGS = new Set([
  'a',
  'abbr',
  'area',
  'audio',
  'b',
  'bdi',
  'bdo',
  'br',
  'button',
  'canvas',
  'cite',
  'code',
  'data',
  'datalist',
  'del',
  'dfn',
  'em',
  'embed',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'map',
  'mark',
  'math',
  'meter',
  'noscript',
  'object',
  'output',
  'picture',
  'progress',
  'q',
  'ruby',
  's',
  'samp',
  'script',
  'select',
  'slot',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'svg',
  'template',
  'textarea',
  'time',
  'u',
  'var',
  'video',
  'wbr',
])

function shouldDeferChildForHtmlParser(
  parentTag: string,
  childTag: string,
  namespace: NamespaceContext,
): boolean {
  if (namespace !== null) return false
  if (parentTag === 'p') {
    return !PHRASING_HTML_TAGS.has(childTag)
  }
  if (parentTag === 'a') {
    return childTag === 'a'
  }
  if (parentTag === 'form') {
    return childTag === 'form'
  }
  return false
}

function literalExpression(value: unknown, loc?: Expression['loc']): Expression {
  return { kind: 'Literal', value, loc } as Expression
}

function rawTextSegmentExpression(expr: Expression): Expression {
  const valueName = '__fictRawTextPart'
  const valueParam: Identifier = { kind: 'Identifier', name: valueName, loc: expr.loc }
  const valueRef = (): Identifier => ({ kind: 'Identifier', name: valueName, loc: expr.loc })

  return {
    kind: 'CallExpression',
    callee: {
      kind: 'ArrowFunction',
      params: [valueParam],
      body: {
        kind: 'ConditionalExpression',
        test: {
          kind: 'LogicalExpression',
          operator: '||',
          left: {
            kind: 'BinaryExpression',
            operator: '==',
            left: valueRef(),
            right: literalExpression(null, expr.loc),
            loc: expr.loc,
          },
          right: {
            kind: 'BinaryExpression',
            operator: '===',
            left: {
              kind: 'UnaryExpression',
              operator: 'typeof',
              argument: valueRef(),
              prefix: true,
              loc: expr.loc,
            },
            right: literalExpression('boolean', expr.loc),
            loc: expr.loc,
          },
          loc: expr.loc,
        },
        consequent: literalExpression('', expr.loc),
        alternate: valueRef(),
        loc: expr.loc,
      },
      isExpression: true,
      loc: expr.loc,
    },
    arguments: [expr],
    loc: expr.loc,
  } as Expression
}

function hasExplicitIsAttribute(jsx: JSXElementExpression, namespace: NamespaceContext): boolean {
  return jsx.attributes.some(attr => {
    if (attr.isSpread) return false
    return normalizeHIRAttrName(attr.name, namespace) === 'is'
  })
}

function getCustomElementPropertyBindingName(
  name: string,
  isCustomElement: boolean,
): string | null {
  if (!isCustomElement) return null
  if (name === 'is') return null
  if (name === 'class' || name === 'className' || name === 'classList' || name === 'style') {
    return null
  }
  if (name === 'ref' || name === 'children' || name === 'dangerouslySetInnerHTML') return null
  if (isDOMProperty(name) || isDOMTemplateProperty(name)) return name
  return toCustomElementPropertyName(name)
}

/**
 * Extract static HTML from HIR JSXElementExpression.
 * Similar to extractStaticHtml from fine-grained-dom.ts but works with HIR types.
 * Now tracks namespace context for SVG/MathML elements.
 */
export function extractHIRStaticHtml(
  jsx: JSXElementExpression,
  ctx: CodegenContext,
  ops: TemplateExtractionOps,
  parentPath: number[] = [],
  namespace: NamespaceContext = null,
  allowStandaloneIntrinsic = true,
): HIRTemplateExtractionResult {
  // Components or dynamic tag expressions should be treated as dynamic children,
  // not baked into static HTML.
  if (jsx.isComponent || typeof jsx.tagName !== 'string') {
    return {
      html: '<!--fict:slot:start--><!--fict:slot:end-->',
      bindings: [
        {
          type: 'child',
          path: [...parentPath],
          expr: jsx,
          namespace,
        },
      ],
      nodeCount: 1,
    }
  }

  const tagName = jsx.tagName as string
  // Resolve namespace for this element
  const resolvedNamespace = resolveNamespaceContext(tagName, namespace, jsx.attributes, {
    allowStandaloneIntrinsic,
  })
  const isCustomElement =
    resolvedNamespace === null &&
    (isCustomElementTagName(tagName) || hasExplicitIsAttribute(jsx, resolvedNamespace))
  let html = `<${tagName}`
  const bindings: HIRBinding[] = []
  let hasExplicitTextareaValue = false
  const hasRenderableChildren = jsx.children.some(
    child => child.kind !== 'text' || child.value.length > 0,
  )
  const hasAuthoredChildren = jsx.hasAuthoredChildren === true || jsx.children.length > 0
  let childrenPropExpr: Expression | undefined

  // Process attributes
  for (let attrIndex = 0; attrIndex < jsx.attributes.length; attrIndex++) {
    const attr = jsx.attributes[attrIndex]!
    if (attr.isSpread) {
      if (attr.spreadExpr) {
        const excluded = new Set<string>()
        for (let nextIndex = attrIndex + 1; nextIndex < jsx.attributes.length; nextIndex++) {
          const nextAttr = jsx.attributes[nextIndex]!
          if (nextAttr.isSpread) continue

          let nextName = normalizeHIRAttrName(nextAttr.name, resolvedNamespace)
          nextName = normalizeEventAttributeName(nextName).name
          if (nextName === 'key') continue

          addSpreadExclusionName(excluded, nextName)
          if (nextName !== nextAttr.name) {
            addSpreadExclusionName(excluded, nextAttr.name)
          }
          const customPropertyName = getCustomElementPropertyBindingName(nextName, isCustomElement)
          if (customPropertyName) {
            addSpreadExclusionName(excluded, customPropertyName)
          }
          const forcedBinding = parseForcedBindingName(nextName)
          if (forcedBinding) {
            addSpreadExclusionName(excluded, forcedBinding.name)
          }
        }

        bindings.push({
          type: 'spread',
          path: [...parentPath],
          expr: attr.spreadExpr,
          exclude: excluded.size > 0 ? Array.from(excluded) : undefined,
          namespace: resolvedNamespace,
        })
      }
      continue
    }

    const normalizedName = normalizeEventAttributeName(
      normalizeHIRAttrName(attr.name, resolvedNamespace),
    )
    const name = normalizedName.name
    const isResumableEvent = normalizedName.resumableExplicit
    const forcedBinding = parseForcedBindingName(name)
    if (
      tagName === 'textarea' &&
      resolvedNamespace === null &&
      (name === 'value' || (forcedBinding?.prefix === 'prop' && forcedBinding.name === 'value'))
    ) {
      hasExplicitTextareaValue = true
    }

    // Key attribute is for list reconciliation only; keep expression for evaluation
    if (name === 'key') {
      if (attr.value && !isStaticValue(attr.value)) {
        bindings.push({
          type: 'key',
          path: [...parentPath],
          expr: attr.value,
        })
      }
      continue
    }

    // Event handlers are always dynamic
    const namespacedEvent = parseNamespacedEventName(name)
    if (namespacedEvent || isCamelCaseEventName(name)) {
      let eventName = namespacedEvent?.eventName ?? name.slice(2)
      let capture = namespacedEvent?.capture ?? false
      let passive = false
      let once = false

      const knownEvent = parseKnownEventNameWithModifiers(eventName)
      if (knownEvent) {
        eventName = knownEvent.eventName
        capture ||= knownEvent.capture
        passive = knownEvent.passive
        once = knownEvent.once
      } else {
        // Parse event modifiers
        let changed = true
        while (changed) {
          changed = false
          if (eventName.endsWith('Capture')) {
            eventName = eventName.slice(0, -7)
            capture = true
            changed = true
          }
          if (eventName.endsWith('Passive')) {
            eventName = eventName.slice(0, -7)
            passive = true
            changed = true
          }
          if (eventName.endsWith('Once')) {
            eventName = eventName.slice(0, -4)
            once = true
            changed = true
          }
        }
      }

      // Determine if handler should be resumable (lazy-loaded)
      // - Explicit $ suffix always enables resumable when resumable mode is on
      // - Without $, auto-extract heuristics determine if handler is complex enough
      const shouldBeResumable =
        (isResumableEvent && ctx.resumableEnabled) ||
        (!isResumableEvent &&
          ctx.resumableEnabled &&
          shouldAutoExtract(attr.value ?? undefined, ctx))

      bindings.push({
        type: 'event',
        path: [...parentPath],
        name: namespacedEvent ? eventName : eventName.toLowerCase(),
        expr: attr.value ?? undefined,
        eventOptions: { capture, passive, once },
        resumable: shouldBeResumable,
        resumableExplicit: isResumableEvent,
      })
      continue
    }

    if (forcedBinding) {
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name,
        expr: attr.value ?? undefined,
      })
      continue
    }

    // ref is always dynamic
    if (name === 'ref') {
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name: 'ref',
        expr: attr.value ?? undefined,
      })
      continue
    }

    if (name === 'children') {
      childrenPropExpr =
        attr.value ?? ({ kind: 'Literal', value: true, loc: attr.loc } as Expression)
      continue
    }

    if (name === 'dangerouslySetInnerHTML') {
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name,
        expr: attr.value ?? undefined,
        hasChildren: hasRenderableChildren,
      })
      continue
    }

    if (isDOMTemplateProperty(name)) {
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name,
        expr: attr.value ?? undefined,
      })
      continue
    }

    const customPropertyName = getCustomElementPropertyBindingName(name, isCustomElement)
    if (customPropertyName) {
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name: customPropertyName,
        expr: attr.value ?? literalExpression(true, attr.loc),
        bindingTarget: 'property',
      })
      continue
    }

    if (resolvedNamespace === null && isDOMProperty(name) && isStaticValue(attr.value)) {
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name,
        expr: attr.value,
        bindingTarget: 'property',
      })
      continue
    }

    // Check if value is static
    if (isStaticValue(attr.value)) {
      const value = attr.value.value
      if (typeof value === 'string') {
        html += ` ${name}="${escapeHtmlAttributeValue(value)}"`
      } else if (typeof value === 'boolean' && value) {
        if (shouldStringifyBooleanAttribute(name)) {
          html += ` ${name}="${value}"`
        } else {
          html += ` ${name}`
        }
      } else if (typeof value === 'boolean' && shouldStringifyBooleanAttribute(name)) {
        html += ` ${name}="${value}"`
      } else if (typeof value === 'number') {
        html += ` ${name}="${value}"`
      }
    } else if (attr.value === null) {
      // Boolean attribute without value
      html += ` ${name}`
    } else {
      // Dynamic attribute
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name,
        expr: attr.value ?? undefined,
      })
    }
  }

  html += '>'

  // Process children
  let childIndex = 0
  const children = jsx.children
  const textareaValueChild =
    tagName === 'textarea' &&
    resolvedNamespace === null &&
    !hasExplicitTextareaValue &&
    children.length === 1 &&
    children[0]?.kind === 'expression'
      ? children[0].value
      : null
  const rawTextContentChild =
    shouldBindRawTextContent(tagName, namespace, resolvedNamespace) &&
    children.length === 1 &&
    children[0]?.kind === 'expression'
      ? children[0].value
      : null
  const isTrueRawText =
    namespace === null && resolvedNamespace === null && HTML_RAWTEXT_ELEMENTS.has(tagName)
  // Raw text cannot carry comment slot markers and its entities are not decoded,
  // so a script/style element whose children mix static text with expressions
  // (e.g. CSS braces written as {'{'}) must bind its whole textContent to a
  // string concatenation instead of baking comment slots into the template.
  const rawTextConcatExpr: Expression | null =
    isTrueRawText &&
    hasAuthoredChildren &&
    children.length > 1 &&
    children.some(child => child.kind === 'expression') &&
    children.every(child => child.kind === 'text' || child.kind === 'expression')
      ? children.reduce<Expression>(
          (acc, child) => ({
            kind: 'BinaryExpression',
            operator: '+',
            left: acc,
            right:
              child.kind === 'text'
                ? literalExpression(child.value, child.loc)
                : rawTextSegmentExpression(child.value),
            loc: child.loc,
          }),
          literalExpression(''),
        )
      : null
  const isNonEmptyText = (node: JSXChild): boolean => node.kind === 'text' && node.value.length > 0
  const isImplicitTableRow = (node: JSXChild | undefined): boolean =>
    tagName === 'table' &&
    resolvedNamespace === null &&
    node?.kind === 'element' &&
    !node.value.isComponent &&
    node.value.tagName === 'tr'
  const isImplicitTableColumn = (node: JSXChild | undefined): boolean =>
    tagName === 'table' &&
    resolvedNamespace === null &&
    node?.kind === 'element' &&
    !node.value.isComponent &&
    node.value.tagName === 'col'
  const hasAdjacentInline = (index: number): boolean => {
    const prev = children[index - 1]
    const next = children[index + 1]
    return (
      (!!prev && (prev.kind === 'expression' || isNonEmptyText(prev))) ||
      (!!next && (next.kind === 'expression' || isNonEmptyText(next)))
    )
  }

  if (rawTextConcatExpr) {
    bindings.push({
      type: 'textContent',
      path: [...parentPath],
      expr: rawTextConcatExpr,
    })
  } else if (textareaValueChild) {
    bindings.push({
      type: 'attr',
      path: [...parentPath],
      name: 'value',
      expr: textareaValueChild,
      bindingTarget: 'property',
    })
  } else if (rawTextContentChild) {
    bindings.push({
      type: 'textContent',
      path: [...parentPath],
      expr: rawTextContentChild,
    })
  } else if (childrenPropExpr && !hasAuthoredChildren) {
    if (shouldBindRawTextContent(tagName, namespace, resolvedNamespace)) {
      bindings.push({
        type: 'textContent',
        path: [...parentPath],
        expr: childrenPropExpr,
      })
    } else {
      html += '<!--fict:slot:start--><!--fict:slot:end-->'
      bindings.push({
        type: 'child',
        path: [...parentPath, childIndex],
        expr: childrenPropExpr,
        namespace: resolvedNamespace,
      })
      childIndex++
    }
  }

  if (!textareaValueChild && !rawTextContentChild && !rawTextConcatExpr) {
    let previousStaticTextChild = false
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!
      if (child.kind === 'text') {
        const text = child.value
        if (text.length > 0) {
          if (isTrueRawText) {
            // RAWTEXT content is not entity-decoded by the parser; emit it
            // verbatim, but reject an embedded closing tag that would break out.
            if (new RegExp(`</${tagName}`, 'i').test(text)) {
              throw new HIRError(
                `Static <${tagName}> content may not contain a closing </${tagName}> sequence.`,
                'CODEGEN_ERROR',
              )
            }
            html += text
          } else {
            html += escapeHtmlText(text)
          }
          if (!previousStaticTextChild) {
            childIndex++
          }
          previousStaticTextChild = true
        }
      } else if (child.kind === 'element') {
        previousStaticTextChild = false
        if (
          !child.value.isComponent &&
          typeof child.value.tagName === 'string' &&
          shouldDeferChildForHtmlParser(tagName, child.value.tagName, resolvedNamespace)
        ) {
          html += '<!--fict:slot:start--><!--fict:slot:end-->'
          bindings.push({
            type: 'child',
            path: [...parentPath, childIndex],
            expr: child.value,
            namespace: resolvedNamespace,
          })
          childIndex++
          continue
        }
        if (isImplicitTableRow(child)) {
          const tbodyPath = [...parentPath, childIndex]
          html += '<tbody>'
          let rowIndex = 0
          while (true) {
            const row = children[i]
            if (row?.kind !== 'element' || !isImplicitTableRow(row)) break
            const rowResult = extractHIRStaticHtml(
              row.value,
              ctx,
              ops,
              [...tbodyPath, rowIndex],
              resolvedNamespace,
              false,
            )
            html += rowResult.html
            bindings.push(...rowResult.bindings)
            rowIndex += rowResult.nodeCount
            i++
          }
          i--
          html += '</tbody>'
          childIndex++
          continue
        }
        if (isImplicitTableColumn(child)) {
          const colgroupPath = [...parentPath, childIndex]
          html += '<colgroup>'
          let columnIndex = 0
          while (true) {
            const column = children[i]
            if (column?.kind !== 'element' || !isImplicitTableColumn(column)) break
            const columnResult = extractHIRStaticHtml(
              column.value,
              ctx,
              ops,
              [...colgroupPath, columnIndex],
              resolvedNamespace,
              false,
            )
            html += columnResult.html
            bindings.push(...columnResult.bindings)
            columnIndex += columnResult.nodeCount
            i++
          }
          i--
          html += '</colgroup>'
          childIndex++
          continue
        }
        const childPath = [...parentPath, childIndex]
        // Pass namespace context to child elements
        const childResult = extractHIRStaticHtml(
          child.value,
          ctx,
          ops,
          childPath,
          resolvedNamespace,
          false,
        )
        html += childResult.html
        bindings.push(...childResult.bindings)
        childIndex += childResult.nodeCount
      } else if (child.kind === 'expression') {
        previousStaticTextChild = false
        const inline = hasAdjacentInline(i)
        if (!inline && ops.isLikelyTextExpression(child.value, ctx)) {
          html += ' '
          bindings.push({
            type: 'text',
            path: [...parentPath, childIndex],
            expr: child.value,
            // Track namespace for dynamic text bindings
            namespace: resolvedNamespace,
          })
        } else {
          // Dynamic expression - insert placeholder comments
          html += '<!--fict:slot:start--><!--fict:slot:end-->'
          bindings.push({
            type: 'child',
            path: [...parentPath, childIndex],
            expr: child.value,
            // Track namespace for dynamic child bindings
            namespace: resolvedNamespace,
          })
          childIndex++
          continue
        }
        childIndex++
      }
    }
  }

  if (!(resolvedNamespace === null && HTML_VOID_ELEMENTS.has(tagName))) {
    html += `</${tagName}>`
  }

  // Determine if this template needs SVG/MathML namespace wrapping.
  // This is needed when:
  // - We're in SVG/MathML context (from parent) but root tag isn't 'svg'/'math' itself
  // - In that case, the browser would parse the HTML as HTML elements without the namespace
  // Note: If root IS 'svg' or 'math', the tag itself creates the namespace, no wrapping needed
  const needsSVG =
    (namespace === 'svg' || (namespace === null && resolvedNamespace === 'svg')) &&
    tagName !== 'svg'
  const needsMathML =
    (namespace === 'mathml' ||
      (namespace === 'mathmlTextIntegration' && resolvedNamespace === 'mathml') ||
      (namespace === null &&
        (resolvedNamespace === 'mathml' || resolvedNamespace === 'mathmlTextIntegration'))) &&
    tagName !== 'math'

  return {
    html,
    bindings,
    nodeCount: 1,
    isSVG: needsSVG || undefined,
    isMathML: needsMathML || undefined,
  }
}
