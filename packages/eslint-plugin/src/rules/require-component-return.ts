import type { Rule } from 'eslint'
import type {
  ArrowFunctionExpression,
  BlockStatement,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  Statement,
  SwitchCase,
  TryStatement,
} from 'estree'

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require component functions to return a value (FICT-C004)',
      recommended: true,
    },
    messages: {
      missingReturn: 'Component should return JSX or null/undefined (FICT-C004).',
    },
    schema: [],
  },
  create(context) {
    const isUpperCaseName = (name?: string | null): boolean => !!name && /^[A-Z]/.test(name)

    const getFunctionName = (
      node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression,
    ): string | undefined => {
      if ((node as FunctionDeclaration | FunctionExpression).id?.name) {
        return (node as FunctionDeclaration | FunctionExpression).id!.name
      }
      const parent = (node as any).parent
      if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        return parent.id.name
      }
      return undefined
    }

    const hasReturn = (node: Node): boolean => {
      const visit = (n: Node): boolean => {
        switch (n.type) {
          case 'ReturnStatement':
            return true
          case 'BlockStatement':
            return n.body.some(stmt => visit(stmt))
          case 'IfStatement':
            return visit(n.consequent) || (!!n.alternate && visit(n.alternate))
          case 'SwitchStatement':
            return n.cases.some((c: SwitchCase) => c.consequent.some(visit))
          case 'WhileStatement':
          case 'DoWhileStatement':
          case 'ForStatement':
          case 'ForInStatement':
          case 'ForOfStatement':
            return visit(n.body as Statement)
          case 'TryStatement': {
            const t = n as TryStatement
            return (
              (t.block && visit(t.block)) ||
              (!!t.handler && visit(t.handler.body)) ||
              (!!t.finalizer && visit(t.finalizer))
            )
          }
          default:
            // Do not descend into nested functions or classes
            if (
              n.type === 'FunctionDeclaration' ||
              n.type === 'FunctionExpression' ||
              n.type === 'ArrowFunctionExpression' ||
              n.type === 'ClassDeclaration' ||
              n.type === 'ClassExpression'
            ) {
              return false
            }
            for (const key of Object.keys(n as any)) {
              if (key === 'parent') continue
              const value = (n as any)[key]
              if (!value) continue
              if (Array.isArray(value)) {
                if (value.some(child => child && typeof child.type === 'string' && visit(child))) {
                  return true
                }
              } else if (value && typeof value.type === 'string') {
                if (visit(value as Node)) return true
              }
            }
            return false
        }
      }
      return visit(node)
    }

    const enter = (node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression) => {
      const name = getFunctionName(node)
      const isComponent = isUpperCaseName(name)
      if (!isComponent) return

      if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
        return
      }

      const body =
        node.type === 'ArrowFunctionExpression' ? node.body : (node.body as BlockStatement)

      if (body && body.type === 'BlockStatement' && !hasReturn(body)) {
        context.report({
          node,
          messageId: 'missingReturn',
        })
      }
    }

    return {
      FunctionDeclaration: enter,
      FunctionExpression: enter,
      ArrowFunctionExpression: enter,
    }
  },
}

export default rule
