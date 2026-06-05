import type { CodegenContext } from './codegen'
import { shouldAutoExtract } from './codegen-auto-extract'
import { isDOMTemplateProperty } from './codegen-dom-utils'
import type { Expression, JSXChild, JSXElementExpression } from './hir'

export interface HIRBinding {
  type: 'attr' | 'child' | 'event' | 'key' | 'spread' | 'text'
  path: number[] // path to navigate from root to target node
  name?: string | undefined // for attributes/events
  expr?: Expression | undefined // the dynamic expression
  exclude?: string[] | undefined // spread-only: keys overridden by following explicit attrs
  hasChildren?: boolean | undefined // content-prop bindings that conflict with JSX children
  eventOptions?: { capture?: boolean; passive?: boolean; once?: boolean } | undefined
  resumable?: boolean | undefined
  resumableExplicit?: boolean | undefined
  /** Namespace context at this binding's location (for dynamic children) */
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
export type NamespaceContext = 'svg' | 'mathml' | null

export interface TemplateExtractionOps {
  isLikelyTextExpression: (expr: Expression, ctx: CodegenContext) => boolean
}

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

/**
 * Resolve namespace context based on tag name and parent context.
 * - 'svg' enters SVG namespace
 * - 'math' enters MathML namespace
 * - 'foreignObject' inside SVG exits to null (HTML namespace)
 * - Otherwise inherit from parent context
 */
export function resolveNamespaceContext(
  tagName: string,
  parentNamespace: NamespaceContext,
): NamespaceContext {
  if (tagName === 'svg') return 'svg'
  if (tagName === 'math') return 'mathml'
  if (tagName === 'foreignObject' && parentNamespace === 'svg') return null
  return parentNamespace
}

function isStaticValue(expr: Expression | null): expr is Expression & { kind: 'Literal' } {
  if (!expr) return false
  return expr.kind === 'Literal'
}

function escapeHtmlAttributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shouldStringifyBooleanAttribute(name: string): boolean {
  return name.startsWith('aria-') || name.startsWith('data-')
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
        },
      ],
      nodeCount: 1,
    }
  }

  const tagName = jsx.tagName as string
  // Resolve namespace for this element
  const resolvedNamespace = resolveNamespaceContext(tagName, namespace)
  let html = `<${tagName}`
  const bindings: HIRBinding[] = []
  const hasRenderableChildren = jsx.children.some(
    child => child.kind !== 'text' || child.value.length > 0,
  )
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
          if (nextName.endsWith('$')) {
            nextName = nextName.slice(0, -1)
          }
          if (nextName === 'key') continue

          excluded.add(nextName)
          if (nextName !== nextAttr.name) {
            excluded.add(nextAttr.name)
          }
        }

        bindings.push({
          type: 'spread',
          path: [...parentPath],
          expr: attr.spreadExpr,
          exclude: excluded.size > 0 ? Array.from(excluded) : undefined,
        })
      }
      continue
    }

    let name = normalizeHIRAttrName(attr.name, resolvedNamespace)
    const isResumableEvent = name.endsWith('$')
    if (isResumableEvent) {
      name = name.slice(0, -1)
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
        name: eventName.toLowerCase(),
        expr: attr.value ?? undefined,
        eventOptions: { capture, passive, once },
        resumable: shouldBeResumable,
        resumableExplicit: isResumableEvent,
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

    if (name.startsWith('bool:')) {
      bindings.push({
        type: 'attr',
        path: [...parentPath],
        name,
        expr: attr.value ?? undefined,
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
  const isNonEmptyText = (node: JSXChild): boolean => node.kind === 'text' && node.value.length > 0
  const hasAdjacentInline = (index: number): boolean => {
    const prev = children[index - 1]
    const next = children[index + 1]
    return (
      (!!prev && (prev.kind === 'expression' || isNonEmptyText(prev))) ||
      (!!next && (next.kind === 'expression' || isNonEmptyText(next)))
    )
  }

  if (childrenPropExpr && !hasRenderableChildren) {
    html += '<!--fict:slot:start--><!--fict:slot:end-->'
    bindings.push({
      type: 'child',
      path: [...parentPath, childIndex],
      expr: childrenPropExpr,
      namespace: resolvedNamespace,
    })
    childIndex++
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    if (child.kind === 'text') {
      const text = child.value
      if (text.length > 0) {
        html += escapeHtmlText(text)
        childIndex++
      }
    } else if (child.kind === 'element') {
      const childPath = [...parentPath, childIndex]
      // Pass namespace context to child elements
      const childResult = extractHIRStaticHtml(child.value, ctx, ops, childPath, resolvedNamespace)
      html += childResult.html
      bindings.push(...childResult.bindings)
      childIndex += childResult.nodeCount
    } else if (child.kind === 'expression') {
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

  html += `</${tagName}>`

  // Determine if this template needs SVG/MathML namespace wrapping.
  // This is needed when:
  // - We're in SVG/MathML context (from parent) but root tag isn't 'svg'/'math' itself
  // - In that case, the browser would parse the HTML as HTML elements without the namespace
  // Note: If root IS 'svg' or 'math', the tag itself creates the namespace, no wrapping needed
  const needsSVG = namespace === 'svg' && tagName !== 'svg'
  const needsMathML = namespace === 'mathml' && tagName !== 'math'

  return {
    html,
    bindings,
    nodeCount: 1,
    isSVG: needsSVG || undefined,
    isMathML: needsMathML || undefined,
  }
}
