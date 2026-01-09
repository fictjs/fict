/**
 * Region metadata + template extraction helpers.
 *
 * The compiler's HIR path consumes RegionMetadata via applyRegionMetadata,
 * and tests use extractStaticHtml to validate template extraction.
 */

import type * as BabelCore from '@babel/core'

// ============================================================================
// Region Metadata (used by HIR reactive scope analysis)
// ============================================================================

/**
 * Metadata for a reactive region from HIR analysis.
 */
export interface RegionMetadata {
  /** Unique identifier for this region */
  id: number
  /** Variables that trigger re-execution of this region */
  dependencies: Set<string>
  /** Variables declared/output by this region */
  declarations: Set<string>
  /** Whether this region contains control flow (if/for/while) */
  hasControlFlow: boolean
  /** Whether this region contains reactive writes */
  hasReactiveWrites: boolean
  /** Child regions nested within this one */
  children?: RegionMetadata[]
  /** Start position in source for debugging */
  start?: { line: number; column: number }
  /** End position in source for debugging */
  end?: { line: number; column: number }
}

/**
 * Options for region-aware code generation.
 * Kept minimal for applyRegionMetadata.
 */
export interface RegionCodegenOptions {
  /** The region metadata from HIR analysis */
  region?: RegionMetadata
  /** Whether to emit memo wrappers for this region */
  emitMemo?: boolean
  /** Whether to emit destructuring for region outputs */
  emitDestructuring?: boolean
  /** Custom dependency getter expression factory */
  dependencyGetter?: (name: string) => BabelCore.types.Expression
}

interface RegionApplyState {
  identifierOverrides?: Record<string, () => BabelCore.types.Expression>
  regionMetadata?: RegionMetadata
}

/**
 * Normalize dependency keys by stripping SSA suffixes and keeping dotted paths intact.
 */
function normalizeDependencyKey(name: string): string {
  return name
    .split('.')
    .map(part => part.replace(/_\d+$/, ''))
    .join('.')
}

/**
 * Apply region metadata to influence code generation.
 * This is the integration point between HIR reactive scopes and template extraction.
 */
export function applyRegionMetadata(state: RegionApplyState, options: RegionCodegenOptions): void {
  if (!options.region) return

  const region = options.region
  state.regionMetadata = region

  if (region.dependencies.size === 0) return

  const dependencyGetter = options.dependencyGetter
  if (!dependencyGetter) return

  state.identifierOverrides = state.identifierOverrides ?? {}

  for (const dep of region.dependencies) {
    const key = normalizeDependencyKey(dep)
    state.identifierOverrides[key] = () => dependencyGetter(dep)

    const base = key.split('.')[0]
    if (base && !state.identifierOverrides[base]) {
      state.identifierOverrides[base] = () => dependencyGetter(base)
    }
  }
}

/**
 * Determine if a region should use memo wrapper based on its characteristics.
 */
export function shouldMemoizeRegion(region: RegionMetadata): boolean {
  if (region.dependencies.size > 0) return true
  if (region.hasControlFlow) return true
  if (region.hasReactiveWrites) return true
  return false
}

// ============================================================================
// Template Extraction (tests)
// ============================================================================

interface NormalizedAttribute {
  name: string
  kind: 'attr' | 'class' | 'style' | 'event' | 'ref' | 'property' | 'skip'
  eventName?: string
  capture?: boolean
  passive?: boolean
  once?: boolean
}

export interface TemplateBinding {
  type: 'attr' | 'child' | 'spread' | 'text'
  node: BabelCore.types.Node
  // Path is array of child indices from root
  // e.g. [] = root, [0] = first child, [0, 1] = second child of first child
  path: number[]
  name?: string // for attributes
}

export interface TemplateExtractionResult {
  html: string
  hasDynamic: boolean
  bindings: TemplateBinding[]
}

function isStaticTextExpression(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): boolean {
  if (
    t.isStringLiteral(expr) ||
    t.isNumericLiteral(expr) ||
    t.isBooleanLiteral(expr) ||
    t.isNullLiteral(expr) ||
    t.isBigIntLiteral(expr)
  ) {
    return true
  }

  if (t.isTemplateLiteral(expr) && expr.expressions.length === 0) {
    return true
  }

  return false
}

function normalizeAttributeName(name: string): NormalizedAttribute | null {
  if (name.length > 2 && name.startsWith('on') && name[2]?.toUpperCase() === name[2]) {
    let eventName = name.slice(2)
    let capture = false
    let passive = false
    let once = false

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

    return {
      name,
      kind: 'event',
      eventName: eventName.toLowerCase(),
      capture,
      passive,
      once,
    }
  }

  switch (name) {
    case 'key':
      return { name, kind: 'skip' }
    case 'ref':
      return { name, kind: 'ref' }
    case 'value':
    case 'checked':
    case 'selected':
    case 'disabled':
    case 'readOnly':
    case 'multiple':
    case 'muted':
      return { name, kind: 'property' }
    case 'class':
    case 'className':
      return { name: 'class', kind: 'class' }
    case 'style':
      return { name: 'style', kind: 'style' }
    case 'htmlFor':
      return { name: 'for', kind: 'attr' }
    case 'dangerouslySetInnerHTML':
      return null
    default:
      if (name[0] === name[0]?.toUpperCase()) {
        return null
      }
      return { name, kind: 'attr' }
  }
}

function getIntrinsicTagName(
  element: BabelCore.types.JSXElement,
  t: typeof BabelCore.types,
): string | null {
  const tag = element.openingElement.name

  if (!t.isJSXIdentifier(tag)) return null

  const text = tag.name
  if (!text) return null

  const firstChar = text[0]
  if (!firstChar || firstChar !== firstChar.toLowerCase()) {
    return null
  }

  return text
}

export function extractStaticHtml(
  node: BabelCore.types.JSXElement,
  t: typeof BabelCore.types,
  parentPath: number[] = [],
): TemplateExtractionResult {
  const tagName = getIntrinsicTagName(node, t)
  if (!tagName) {
    return {
      html: '<!---->',
      hasDynamic: true,
      bindings: [
        {
          type: 'child',
          node,
          path: [...parentPath],
        },
      ],
    }
  }

  let html = `<${tagName}`
  let hasDynamic = false
  const bindings: TemplateBinding[] = []

  for (const attr of node.openingElement.attributes) {
    if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name)) {
      const name = attr.name.name
      const normalized = normalizeAttributeName(name)
      if (!normalized || normalized.kind === 'skip') continue

      if (attr.value && t.isStringLiteral(attr.value)) {
        html += ` ${normalized.name}="${attr.value.value}"`
      } else if (!attr.value) {
        html += ` ${normalized.name}`
      } else {
        hasDynamic = true
        bindings.push({
          type: 'attr',
          node: attr,
          path: [...parentPath],
          name: normalized.name,
        })
      }
    } else {
      hasDynamic = true
      bindings.push({
        type: 'spread',
        node: attr,
        path: [...parentPath],
      })
    }
  }

  html += '>'

  let childIndex = 0
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]

    if (t.isJSXText(child)) {
      let text = child.value
      while (i + 1 < node.children.length && t.isJSXText(node.children[i + 1])) {
        text += (node.children[i + 1] as BabelCore.types.JSXText).value
        i++
      }

      if (!text.trim()) continue

      html += text
      childIndex++
    } else if (t.isJSXElement(child)) {
      const currentPath = [...parentPath, childIndex]
      const res = extractStaticHtml(child, t, currentPath)
      html += res.html
      if (res.hasDynamic) hasDynamic = true
      bindings.push(...res.bindings)
      childIndex++
    } else {
      if (t.isJSXExpressionContainer(child) && t.isJSXEmptyExpression(child.expression)) {
        continue
      }

      let isTextBinding = false
      if (t.isJSXExpressionContainer(child)) {
        isTextBinding = isStaticTextExpression(child.expression as BabelCore.types.Expression, t)
      }

      if (isTextBinding) {
        html += ' '
        hasDynamic = true
        bindings.push({
          type: 'text',
          node: child as BabelCore.types.Node,
          path: [...parentPath, childIndex],
        })
      } else {
        html += '<!---->'
        hasDynamic = true
        bindings.push({
          type: 'child',
          node: child as BabelCore.types.Node,
          path: [...parentPath, childIndex],
        })
      }
      childIndex++
    }
  }

  html += `</${tagName}>`

  return { html, hasDynamic, bindings }
}
