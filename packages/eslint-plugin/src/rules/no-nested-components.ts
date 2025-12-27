import type { Rule } from 'eslint'
import type {
  ArrowFunctionExpression,
  BlockStatement,
  FunctionDeclaration,
  FunctionExpression,
  Node,
} from 'estree'

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow defining components inside other components (FICT-C003)',
      recommended: true,
    },
    messages: {
      nestedComponent:
        'Do not define a component inside another component. Move {{name}} to module scope to avoid recreating it on every render.',
    },
    schema: [],
  },
  create(context) {
    const componentStack: boolean[] = []

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

    const hasJSX = (node: BlockStatement | Node): boolean => {
      let found = false
      const visit = (n: Node) => {
        if (found) return
        const t = (n as any).type
        if (t === 'JSXElement' || t === 'JSXFragment') {
          found = true
          return
        }
        // Skip traversal into nested functions to avoid false positives
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
      visit(node)
      return found
    }

    const isComponentLike = (
      node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression,
    ): boolean => {
      const name = getFunctionName(node)
      if (isUpperCaseName(name)) return true
      if (node.type === 'ArrowFunctionExpression' && node.body) {
        const bodyType = (node.body as any).type
        if (bodyType === 'JSXElement' || bodyType === 'JSXFragment') return true
        if (bodyType === 'BlockStatement' && hasJSX(node.body as any)) return true
      }
      if (node.type !== 'ArrowFunctionExpression' && node.body && hasJSX(node.body as any))
        return true
      return false
    }

    const enterFunction = (
      node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression,
    ) => {
      const parentIsComponent = componentStack[componentStack.length - 1] ?? false
      const currentIsComponent = isComponentLike(node)

      if (parentIsComponent && currentIsComponent) {
        const name = getFunctionName(node) ?? 'this component'
        context.report({
          node,
          messageId: 'nestedComponent',
          data: { name },
        })
      }

      componentStack.push(parentIsComponent || currentIsComponent)
    }

    const exitFunction = () => {
      componentStack.pop()
    }

    return {
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,
    }
  },
}

export default rule
