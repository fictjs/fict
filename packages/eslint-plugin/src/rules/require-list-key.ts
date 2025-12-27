import type { Rule } from 'eslint'
import type { CallExpression, Expression, Node, ReturnStatement } from 'estree'

type JSXLike = any

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require key on elements returned from Array.prototype.map in JSX (FICT-J002)',
      recommended: true,
    },
    messages: {
      missingKey:
        'Elements returned from map() in JSX should have a stable key (FICT-J002). Add key={...}.',
    },
    schema: [],
  },
  create(context) {
    const hasKeyAttribute = (node: JSXLike): boolean => {
      if ((node as any).type === 'JSXFragment') {
        // Shorthand fragments cannot carry keys
        return false
      }
      if ((node as any).type !== 'JSXElement') return false
      return ((node as any).openingElement?.attributes ?? []).some((attr: any) => {
        if (!attr || attr.type !== 'JSXAttribute') return false
        return attr.name?.name === 'key'
      })
    }

    const collectReturnedJSX = (expr: Expression | ReturnStatement | JSXLike, out: JSXLike[]) => {
      const target =
        expr.type === 'ReturnStatement' ? (expr.argument ?? undefined) : (expr as Expression)
      if (!target) return
      const t = (target as any).type
      if (t === 'JSXElement' || t === 'JSXFragment') {
        out.push(target as JSXLike)
        return
      }
      if (t === 'ArrayExpression') {
        for (const el of (target as any).elements) {
          if (!el || el.type === 'SpreadElement') continue
          collectReturnedJSX(el as any, out)
        }
      }
      if (t === 'ConditionalExpression') {
        collectReturnedJSX((target as any).consequent, out)
        collectReturnedJSX((target as any).alternate, out)
      }
      if (t === 'LogicalExpression') {
        collectReturnedJSX((target as any).right, out)
      }
    }

    const mapReturnsJSXWithoutKey = (call: CallExpression): JSXLike | null => {
      const callback = call.arguments[0]
      if (!callback) return null
      if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') {
        return null
      }

      const returned: JSXLike[] = []
      if (callback.type === 'ArrowFunctionExpression') {
        const body: any = callback.body
        const bodyType = body.type
        if (bodyType === 'JSXElement' || bodyType === 'JSXFragment') {
          returned.push(body)
        } else if (bodyType === 'BlockStatement') {
          for (const stmt of body.body) {
            if (stmt.type === 'ReturnStatement') {
              collectReturnedJSX(stmt, returned)
            }
          }
        } else {
          collectReturnedJSX(body as Expression, returned)
        }
      } else {
        for (const stmt of callback.body.body) {
          if (stmt.type === 'ReturnStatement') {
            collectReturnedJSX(stmt, returned)
          }
        }
      }

      const missing = returned.find(node => !hasKeyAttribute(node))
      return missing ?? null
    }

    return {
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'map'
        ) {
          const offending = mapReturnsJSXWithoutKey(node)
          if (offending) {
            context.report({
              node: offending as unknown as Node,
              messageId: 'missingKey',
            })
          }
        }
      },
    }
  },
}

export default rule
