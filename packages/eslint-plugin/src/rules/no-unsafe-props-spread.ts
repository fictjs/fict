import type { Rule } from 'eslint'

/**
 * ESLint rule to warn on JSX prop spreads with dynamic or unsafe sources.
 *
 * These spreads can snapshot props and lose reactivity unless merged lazily.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Warn on JSX spread sources that are too dynamic to keep props reactive',
      recommended: true,
    },
    messages: {
      unsafeSpread:
        'JSX spread source is too dynamic to keep props reactive. Consider passing explicit props or using mergeProps(() => source).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          accessorNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Identifier names to treat as accessor functions.',
          },
          accessorModules: {
            type: 'array',
            items: { type: 'string' },
            description: 'Module specifiers whose imports are accessor functions.',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] || {}
    const accessorVars = new Set<string>(options.accessorNames ?? [])
    const accessorModules = new Set<string>(options.accessorModules ?? [])

    const isComponentName = (name: any): boolean => {
      if (name.type === 'JSXIdentifier') {
        return /^[A-Z]/.test(name.name)
      }
      if (name.type === 'JSXMemberExpression') {
        return true
      }
      return false
    }

    const recordAccessorVar = (node: any) => {
      if (!node.init || node.id?.type !== 'Identifier') return
      if (node.init.type !== 'CallExpression') return
      if (node.init.callee?.type !== 'Identifier') return
      const callee = node.init.callee.name
      if (callee === '$state' || callee === '$memo' || callee === 'prop') {
        accessorVars.add(node.id.name)
      }
    }

    const isSafeAccessorExpr = (expr: any): boolean => {
      if (expr.type === 'Identifier') return true
      if (
        expr.type === 'CallExpression' &&
        expr.callee?.type === 'Identifier' &&
        expr.arguments.length === 0 &&
        accessorVars.has(expr.callee.name)
      ) {
        return true
      }
      return false
    }

    const isObviouslyDynamic = (expr: any): boolean =>
      expr.type === 'ConditionalExpression' ||
      expr.type === 'LogicalExpression' ||
      expr.type === 'SequenceExpression' ||
      expr.type === 'AssignmentExpression' ||
      expr.type === 'UpdateExpression' ||
      expr.type === 'AwaitExpression' ||
      expr.type === 'NewExpression' ||
      expr.type === 'YieldExpression'

    const hasUnsafeObjectLiteral = (obj: any): boolean => {
      for (const prop of obj.properties ?? []) {
        if (prop.type === 'SpreadElement') return true
        if (prop.type === 'Property') {
          if (prop.computed) return true
          if (prop.kind === 'get' || prop.kind === 'set') return true
        }
      }
      return false
    }

    const shouldWarnForSpreadExpr = (expr: any): boolean => {
      if (isSafeAccessorExpr(expr)) return false

      if (
        expr.type === 'CallExpression' &&
        expr.callee?.type === 'Identifier' &&
        expr.callee.name === 'mergeProps'
      ) {
        return false
      }

      if (expr.type === 'ObjectExpression') {
        return hasUnsafeObjectLiteral(expr)
      }

      if (isObviouslyDynamic(expr)) return true
      if (expr.type === 'CallExpression') return true
      if (expr.type === 'MemberExpression') return true
      return false
    }

    return {
      ImportDeclaration(node: any) {
        if (!node.source?.value || typeof node.source.value !== 'string') return
        if (!accessorModules.has(node.source.value)) return
        for (const spec of node.specifiers ?? []) {
          if (spec.local?.name) {
            accessorVars.add(spec.local.name)
          }
        }
      },
      VariableDeclarator: recordAccessorVar,
      JSXOpeningElement(node: any) {
        if (!isComponentName(node.name)) return
        for (const attr of node.attributes ?? []) {
          if (attr.type !== 'JSXSpreadAttribute') continue
          const expr = attr.argument
          if (!expr) continue
          if (shouldWarnForSpreadExpr(expr)) {
            context.report({
              node: attr,
              messageId: 'unsafeSpread',
            })
          }
        }
      },
    }
  },
}

export default rule
