/**
 * Fine-grained DOM Lowering
 *
 * This module implements the optimization that transforms JSX into
 * fine-grained DOM operations using direct DOM APIs and reactive bindings.
 */

import type * as BabelCore from '@babel/core'

import { RUNTIME_ALIASES } from './constants'
import type { TransformContext } from './types'

// ============================================================================
// Types
// ============================================================================

interface NormalizedAttribute {
  name: string
  kind: 'attr' | 'class' | 'style' | 'event' | 'ref' | 'property' | 'skip'
  eventName?: string
  capture?: boolean
  passive?: boolean
  once?: boolean
}

// ============================================================================
// Attribute Normalization
// ============================================================================

/**
 * Normalize JSX attribute names to DOM attribute names
 */
export function normalizeAttributeName(name: string): NormalizedAttribute | null {
  // Event handlers: onClick, onSubmit, etc.
  if (name.length > 2 && name.startsWith('on') && name[2]?.toUpperCase() === name[2]) {
    let eventName = name.slice(2)
    let capture = false
    let passive = false
    let once = false

    // Support suffix modifiers (Capture/Passive/Once)
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
      // Skip component props (start with uppercase)
      if (name[0] === name[0]?.toUpperCase()) {
        return null
      }
      return { name, kind: 'attr' }
  }
}

/**
 * Check if a JSX element tag is an intrinsic HTML element
 */
export function getIntrinsicTagName(
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

// ============================================================================
// DOM Helper Generators
// ============================================================================

/**
 * Create a const declaration: const $id = $init
 */
export function createConstDeclaration(
  t: typeof BabelCore.types,
  id: BabelCore.types.Identifier,
  init: BabelCore.types.Expression,
): BabelCore.types.VariableDeclaration {
  return t.variableDeclaration('const', [t.variableDeclarator(id, init)])
}

/**
 * Create appendChild statement: $parent.appendChild($child)
 */
export function createAppendStatement(
  t: typeof BabelCore.types,
  parentId: BabelCore.types.Identifier,
  childId: BabelCore.types.Expression,
): BabelCore.types.ExpressionStatement {
  return t.expressionStatement(
    t.callExpression(t.memberExpression(parentId, t.identifier('appendChild')), [childId]),
  )
}

/**
 * Create a getter arrow function: () => $expr
 */
export function createGetterArrow(
  t: typeof BabelCore.types,
  expr: BabelCore.types.Expression,
): BabelCore.types.ArrowFunctionExpression {
  return t.arrowFunctionExpression([], expr)
}

/**
 * Create document.createElement call
 */
export function createElementCall(
  t: typeof BabelCore.types,
  tagName: string,
): BabelCore.types.CallExpression {
  return t.callExpression(
    t.memberExpression(t.identifier('document'), t.identifier('createElement')),
    [t.stringLiteral(tagName)],
  )
}

/**
 * Create document.createTextNode call
 */
export function createTextNodeCall(
  t: typeof BabelCore.types,
  text: string,
): BabelCore.types.CallExpression {
  return t.callExpression(
    t.memberExpression(t.identifier('document'), t.identifier('createTextNode')),
    [t.stringLiteral(text)],
  )
}

/**
 * Create bindText call: __fictBindText($textNode, () => $expr)
 */
export function createBindTextCall(
  t: typeof BabelCore.types,
  textNodeId: BabelCore.types.Identifier,
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
): BabelCore.types.ExpressionStatement {
  ctx.helpersUsed.bindText = true
  return t.expressionStatement(
    t.callExpression(t.identifier(RUNTIME_ALIASES.bindText), [
      textNodeId,
      createGetterArrow(t, expr),
    ]),
  )
}

/**
 * Create bindAttribute call: __fictBindAttribute($element, $attrName, () => $expr)
 */
export function createBindAttributeCall(
  t: typeof BabelCore.types,
  elementId: BabelCore.types.Identifier,
  attrName: string,
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
): BabelCore.types.ExpressionStatement {
  ctx.helpersUsed.bindAttribute = true
  return t.expressionStatement(
    t.callExpression(t.identifier(RUNTIME_ALIASES.bindAttribute), [
      elementId,
      t.stringLiteral(attrName),
      createGetterArrow(t, expr),
    ]),
  )
}

/**
 * Create bindProperty call: __fictBindProperty($element, $propName, () => $expr)
 */
export function createBindPropertyCall(
  t: typeof BabelCore.types,
  elementId: BabelCore.types.Identifier,
  propName: string,
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
): BabelCore.types.ExpressionStatement {
  ctx.helpersUsed.bindProperty = true
  return t.expressionStatement(
    t.callExpression(t.identifier(RUNTIME_ALIASES.bindProperty), [
      elementId,
      t.stringLiteral(propName),
      createGetterArrow(t, expr),
    ]),
  )
}

/**
 * Create bindClass call: __fictBindClass($element, () => $expr)
 */
export function createBindClassCall(
  t: typeof BabelCore.types,
  elementId: BabelCore.types.Identifier,
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
): BabelCore.types.ExpressionStatement {
  ctx.helpersUsed.bindClass = true
  return t.expressionStatement(
    t.callExpression(t.identifier(RUNTIME_ALIASES.bindClass), [
      elementId,
      createGetterArrow(t, expr),
    ]),
  )
}

/**
 * Create bindStyle call: __fictBindStyle($element, () => $expr)
 */
export function createBindStyleCall(
  t: typeof BabelCore.types,
  elementId: BabelCore.types.Identifier,
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
): BabelCore.types.ExpressionStatement {
  ctx.helpersUsed.bindStyle = true
  return t.expressionStatement(
    t.callExpression(t.identifier(RUNTIME_ALIASES.bindStyle), [
      elementId,
      createGetterArrow(t, expr),
    ]),
  )
}

/**
 * Create bindEvent call: __fictBindEvent($element, $eventName, $handler, $options?)
 *
 * For event handlers, we need to:
 * - If handler is already an arrow function (e.g., `() => doSomething()`),
 *   pass it directly as it already returns the latest value
 * - If handler is a static reference (e.g., `handleClick`),
 *   wrap it in an arrow function to allow reactive swapping
 */
export function createBindEventCall(
  t: typeof BabelCore.types,
  elementId: BabelCore.types.Identifier,
  eventName: string,
  handler: BabelCore.types.Expression,
  options: { capture?: boolean; passive?: boolean; once?: boolean },
  ctx: TransformContext,
): BabelCore.types.Statement[] {
  ctx.helpersUsed.bindEvent = true
  ctx.helpersUsed.onDestroy = true

  // Don't wrap if handler is already an arrow function or function expression
  // This prevents double-wrapping like `() => () => handler()`
  const isAlreadyFunction = t.isArrowFunctionExpression(handler) || t.isFunctionExpression(handler)

  const handlerArg = isAlreadyFunction ? handler : createGetterArrow(t, handler)

  const args: BabelCore.types.Expression[] = [elementId, t.stringLiteral(eventName), handlerArg]

  if (options.capture || options.passive || options.once) {
    const optionProps: BabelCore.types.ObjectProperty[] = []
    if (options.capture) {
      optionProps.push(t.objectProperty(t.identifier('capture'), t.booleanLiteral(true)))
    }
    if (options.passive) {
      optionProps.push(t.objectProperty(t.identifier('passive'), t.booleanLiteral(true)))
    }
    if (options.once) {
      optionProps.push(t.objectProperty(t.identifier('once'), t.booleanLiteral(true)))
    }
    args.push(t.objectExpression(optionProps))
  }

  const cleanupId = t.identifier(`__fictEvt_${++ctx.fineGrainedTemplateId}`)
  const bindCall = t.callExpression(t.identifier(RUNTIME_ALIASES.bindEvent), args)

  return [
    createConstDeclaration(t, cleanupId, bindCall),
    t.expressionStatement(t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [cleanupId])),
  ]
}

/**
 * Apply a ref in fine-grained DOM lowering, mirroring runtime applyRef behavior.
 * Supports callback refs and object refs, and registers cleanup to clear on unmount.
 */
export function createApplyRefStatements(
  t: typeof BabelCore.types,
  elementId: BabelCore.types.Identifier,
  refExpr: BabelCore.types.Expression,
  ctx: TransformContext,
): BabelCore.types.Statement[] {
  ctx.helpersUsed.onDestroy = true

  const refId = t.identifier(`__fictRef_${++ctx.fineGrainedTemplateId}`)

  const assignCallbackRef = t.ifStatement(
    t.binaryExpression('===', t.unaryExpression('typeof', refId), t.stringLiteral('function')),
    t.blockStatement([
      t.expressionStatement(t.callExpression(refId, [elementId])),
      t.expressionStatement(
        t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
          t.arrowFunctionExpression([], t.callExpression(refId, [t.nullLiteral()])),
        ]),
      ),
    ]),
  )

  const assignObjectRef = t.ifStatement(
    t.logicalExpression(
      '&&',
      t.logicalExpression(
        '&&',
        refId,
        t.binaryExpression('===', t.unaryExpression('typeof', refId), t.stringLiteral('object')),
      ),
      t.binaryExpression('in', t.stringLiteral('current'), refId),
    ),
    t.blockStatement([
      t.expressionStatement(
        t.assignmentExpression('=', t.memberExpression(refId, t.identifier('current')), elementId),
      ),
      t.expressionStatement(
        t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
          t.arrowFunctionExpression(
            [],
            t.blockStatement([
              t.expressionStatement(
                t.assignmentExpression(
                  '=',
                  t.memberExpression(refId, t.identifier('current')),
                  t.nullLiteral(),
                ),
              ),
            ]),
          ),
        ]),
      ),
    ]),
  )

  return [createConstDeclaration(t, refId, refExpr), assignCallbackRef, assignObjectRef]
}
