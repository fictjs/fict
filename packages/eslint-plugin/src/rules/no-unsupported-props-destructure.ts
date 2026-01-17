import type { Rule } from 'eslint'

/**
 * ESLint rule to warn on props destructuring patterns that cannot stay reactive.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Warn on unsupported props destructuring patterns in components',
      recommended: true,
    },
    messages: {
      computedKey: 'Computed property in props pattern cannot be made reactive.',
      arrayRest: 'Array rest in props destructuring falls back to non-reactive binding.',
      nestedRest:
        'Nested props rest destructuring falls back to non-reactive binding; access props directly or use prop.',
      nonFirstParam: 'Props destructuring is only supported in the first parameter.',
      fallback: 'Props destructuring falls back to non-reactive binding.',
    },
    schema: [],
  },
  create(context) {
    const isComponentName = (name: string): boolean => /^[A-Z]/.test(name)

    const getPropsPattern = (fnNode: any): any | null => {
      const params = fnNode?.params ?? []
      const first = params[0]
      if (params.length > 1) {
        params.slice(1).forEach((param: any) => {
          if (!param) return
          const target = param.type === 'AssignmentPattern' ? param.left : param
          if (target?.type === 'ObjectPattern' || target?.type === 'ArrayPattern') {
            context.report({
              node: target,
              messageId: 'nonFirstParam',
            })
          }
        })
      }
      if (!first) return null
      if (first.type === 'ObjectPattern') return first
      if (first.type === 'AssignmentPattern' && first.left?.type === 'ObjectPattern') {
        return first.left
      }
      if (first.type === 'ArrayPattern') {
        context.report({
          node: first,
          messageId: 'fallback',
        })
        return null
      }
      return null
    }

    const reportOnce = (node: any, messageId: string) => {
      context.report({
        node,
        messageId,
      })
    }

    const walkPattern = (pattern: any, depth: number): void => {
      if (!pattern) return

      if (pattern.type === 'ObjectPattern') {
        for (const prop of pattern.properties ?? []) {
          if (prop.type === 'RestElement') {
            if (depth > 0) {
              reportOnce(prop, 'nestedRest')
            }
            continue
          }

          if (prop.type !== 'Property') {
            reportOnce(prop, 'fallback')
            continue
          }

          if (prop.computed) {
            reportOnce(prop, 'computedKey')
            continue
          }

          const value = prop.value

          if (value.type === 'Identifier') {
            continue
          }

          if (value.type === 'AssignmentPattern' && value.left?.type === 'Identifier') {
            continue
          }

          if (value.type === 'ObjectPattern') {
            walkPattern(value, depth + 1)
            continue
          }

          if (value.type === 'ArrayPattern') {
            const hasRest = (value.elements ?? []).some((el: any) => el?.type === 'RestElement')
            reportOnce(value, hasRest ? 'arrayRest' : 'fallback')
            continue
          }

          reportOnce(value, 'fallback')
        }
        return
      }

      if (pattern.type === 'ArrayPattern') {
        reportOnce(pattern, 'fallback')
      }
    }

    return {
      FunctionDeclaration(node: any) {
        if (!node.id?.name || !isComponentName(node.id.name)) return
        const pattern = getPropsPattern(node)
        if (pattern) walkPattern(pattern, 0)
      },
      VariableDeclarator(node: any) {
        if (!node.id || node.id.type !== 'Identifier' || !isComponentName(node.id.name)) return
        if (!node.init) return
        if (
          node.init.type !== 'ArrowFunctionExpression' &&
          node.init.type !== 'FunctionExpression'
        ) {
          return
        }
        const pattern = getPropsPattern(node.init)
        if (pattern) walkPattern(pattern, 0)
      },
    }
  },
}

export default rule
