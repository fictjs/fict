import type { CodegenContext } from './codegen'
import { shouldAutoExtract } from './codegen-auto-extract'
import type { Expression, JSXChild, JSXElementExpression } from './hir'

export interface HIRBinding {
  type: 'attr' | 'child' | 'event' | 'key' | 'text'
  path: number[] // path to navigate from root to target node
  name?: string // for attributes/events
  expr?: Expression // the dynamic expression
  eventOptions?: { capture?: boolean; passive?: boolean; once?: boolean }
  resumable?: boolean
  /** Namespace context at this binding's location (for dynamic children) */
  namespace?: NamespaceContext
}

export interface HIRTemplateExtractionResult {
  html: string
  bindings: HIRBinding[]
  nodeCount: number
  /** Whether the root element is an SVG element (or child of SVG) */
  isSVG?: boolean
  /** Whether the root element is a MathML element (or child of MathML) */
  isMathML?: boolean
}

/** Namespace context type for template extraction */
export type NamespaceContext = 'svg' | 'mathml' | null

export interface TemplateExtractionOps {
  isLikelyTextExpression: (expr: Expression, ctx: CodegenContext) => boolean
}

/**
 * Normalize attribute names for special cases.
 */
export function normalizeHIRAttrName(name: string): string {
  if (name === 'className') return 'class'
  if (name === 'htmlFor') return 'for'
  return name
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

  // Process attributes
  for (const attr of jsx.attributes) {
    if (attr.isSpread) {
      // Spread attributes are always dynamic - skip in template
      continue
    }

    let name = normalizeHIRAttrName(attr.name)
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
    if (name.startsWith('on') && name.length > 2 && name[2] === name[2]?.toUpperCase()) {
      let eventName = name.slice(2)
      let capture = false
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

    // Check if value is static
    if (isStaticValue(attr.value)) {
      const value = attr.value.value
      if (typeof value === 'string') {
        // Escape HTML attribute value
        const escaped = String(value).replace(/"/g, '&quot;')
        html += ` ${name}="${escaped}"`
      } else if (typeof value === 'boolean' && value) {
        html += ` ${name}`
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
  const isNonEmptyText = (node: JSXChild): boolean =>
    node.kind === 'text' && node.value.trim().length > 0
  const hasAdjacentInline = (index: number): boolean => {
    const prev = children[index - 1]
    const next = children[index + 1]
    return (
      (!!prev && (prev.kind === 'expression' || isNonEmptyText(prev))) ||
      (!!next && (next.kind === 'expression' || isNonEmptyText(next)))
    )
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    if (child.kind === 'text') {
      const text = child.value
      if (text.trim()) {
        html += text
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
