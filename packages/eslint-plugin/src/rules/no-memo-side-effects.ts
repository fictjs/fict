import type { Rule } from 'eslint'
import type { BlockStatement, Expression, Node } from 'estree'

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow obvious side effects inside $memo callbacks (FICT-M003)',
      recommended: true,
    },
    messages: {
      sideEffectInMemo:
        'Avoid side effects inside $memo. Move mutations/effects outside or wrap them in $effect (FICT-M003).',
    },
    schema: [],
  },
  create(context) {
    const hasSideEffect = (node: BlockStatement | Expression): boolean => {
      let found = false
      const visit = (n: Node) => {
        if (found) return
        if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') {
          found = true
          return
        }
        if (n.type === 'CallExpression') {
          if (n.callee.type === 'Identifier' && n.callee.name === '$effect') {
            found = true
            return
          }
        }
        if (
          n.type === 'FunctionDeclaration' ||
          n.type === 'FunctionExpression' ||
          n.type === 'ArrowFunctionExpression'
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
      visit(node as unknown as Node)
      return found
    }

    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== '$memo') return
        const first = node.arguments[0]
        if (
          first &&
          (first.type === 'ArrowFunctionExpression' || first.type === 'FunctionExpression')
        ) {
          const body =
            first.type === 'ArrowFunctionExpression' && first.body.type !== 'BlockStatement'
              ? first.body
              : first.body
          if (hasSideEffect(body as BlockStatement | Expression)) {
            context.report({ node, messageId: 'sideEffectInMemo' })
          }
        }
      },
    }
  },
}

export default rule
