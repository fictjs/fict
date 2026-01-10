import type { Rule } from 'eslint'
import type { ArrowFunctionExpression, FunctionDeclaration, FunctionExpression, Node } from 'estree'

const isUpperCaseName = (name?: string | null): boolean => !!name && /^[A-Z]/.test(name)
const isHookName = (name?: string | null): boolean => !!name && /^use[A-Z]/.test(name)

const getFunctionName = (
  node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression,
): string | undefined => {
  if ((node as FunctionDeclaration | FunctionExpression).id?.type === 'Identifier') {
    return (node as FunctionDeclaration | FunctionExpression).id!.name
  }
  const parent = (node as any).parent
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name
  }
  return undefined
}

const hasJSX = (node: Node): boolean => {
  let found = false
  const visit = (n: Node) => {
    if (found) return
    const type = (n as any).type
    if (type === 'JSXElement' || type === 'JSXFragment') {
      found = true
      return
    }
    if (
      type === 'FunctionDeclaration' ||
      type === 'FunctionExpression' ||
      type === 'ArrowFunctionExpression'
    ) {
      return
    }
    for (const key of Object.keys(n as any)) {
      if (key === 'parent') continue
      const value = (n as any)[key]
      if (!value) continue
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === 'string') visit(child)
        }
      } else if (value && typeof value.type === 'string') {
        visit(value as Node)
      }
    }
  }
  visit(node)
  return found
}

const isComponentLike = (
  node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression,
): boolean => {
  const name = getFunctionName(node)
  if (isHookName(name)) return true
  if (isUpperCaseName(name)) return true
  if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
    const bodyType = (node.body as any).type
    return bodyType === 'JSXElement' || bodyType === 'JSXFragment'
  }
  if (node.body && hasJSX(node.body as any as Node)) return true
  return false
}

const isInConditional = (ancestors: Node[]): boolean =>
  ancestors.some(ancestor =>
    [
      'IfStatement',
      'SwitchStatement',
      'SwitchCase',
      'ConditionalExpression',
      'LogicalExpression',
    ].includes((ancestor as any).type),
  )

const isDirectStateDeclaration = (node: Node, ancestors: Node[]): boolean => {
  const parent = ancestors[ancestors.length - 1] as any
  if (!parent || parent.type !== 'VariableDeclarator') return false
  if (parent.init !== node) return false
  return parent.id?.type === 'Identifier'
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require $state to be declared at the top level of a component or hook function body',
      recommended: true,
    },
    messages: {
      moduleScope:
        '$state must be declared inside a component or hook function body (not at module scope).',
      componentOnly:
        '$state should only be used inside a component function (PascalCase or JSX-returning) or a hook (useX).',
      topLevel:
        '$state must be at the top level of the component or hook body (not inside conditionals or nested functions).',
      declarationOnly:
        '$state() must be assigned directly to a variable (e.g. let count = $state(0)).',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== '$state') return

        const ancestors = context.sourceCode.getAncestors(node)
        if (!isDirectStateDeclaration(node, ancestors)) {
          context.report({ node, messageId: 'declarationOnly' })
          return
        }
        const functionAncestors = ancestors.filter((ancestor: Node) =>
          ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
            (ancestor as any).type,
          ),
        ) as (FunctionDeclaration | FunctionExpression | ArrowFunctionExpression)[]

        if (functionAncestors.length === 0) {
          context.report({ node, messageId: 'moduleScope' })
          return
        }

        const nearestFunction = functionAncestors[functionAncestors.length - 1]

        if (functionAncestors.length > 1) {
          context.report({ node, messageId: 'topLevel' })
          return
        }

        if (!nearestFunction || !isComponentLike(nearestFunction)) {
          context.report({ node, messageId: 'componentOnly' })
          return
        }

        if (isInConditional(ancestors)) {
          context.report({ node, messageId: 'topLevel' })
        }
      },
    }
  },
}

export default rule
