import type { Rule } from 'eslint'
import type {
  AssignmentExpression,
  Identifier,
  Pattern,
  RestElement,
  UpdateExpression,
  VariableDeclarator,
} from 'estree'

/**
 * Prevent writes to aliases created by destructuring a $state-backed object.
 * Example:
 *   const state = $state({ count: 0 })
 *   const { count } = state      // allowed (read)
 *   count++                      // banned – must write via state
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow writing to destructured aliases from $state; write via the original state instead.',
      recommended: true,
    },
    messages: {
      noWrite:
        "Do not write to '{name}' (destructured from $state). Update via the original state object (e.g. state.count++ or immutable update).",
    },
    schema: [],
  },
  create(context) {
    const stateVars = new Set<string>()
    const destructuredAliases = new Set<string>()

    const collectIds = (pattern: Pattern | RestElement): Identifier[] => {
      const ids: Identifier[] = []
      const visit = (p: Pattern | RestElement) => {
        if (p.type === 'Identifier') {
          ids.push(p)
          return
        }
        if (p.type === 'RestElement') {
          visit(p.argument)
          return
        }
        if (p.type === 'ObjectPattern') {
          for (const prop of p.properties) {
            if (prop.type === 'Property') {
              if (prop.value.type === 'Identifier') {
                ids.push(prop.value)
              } else {
                visit(prop.value as Pattern)
              }
            } else if (prop.type === 'RestElement') {
              visit(prop.argument)
            }
          }
          return
        }
        if (p.type === 'ArrayPattern') {
          for (const el of p.elements) {
            if (!el) continue
            visit(el as Pattern)
          }
        }
      }
      visit(pattern)
      return ids
    }

    const markDestructure = (node: VariableDeclarator) => {
      if (!node.id || (node.id.type !== 'ObjectPattern' && node.id.type !== 'ArrayPattern')) return
      const init = node.init
      if (!init) return
      // Only track destructuring from an identifier that is a known $state variable
      if (init.type === 'Identifier' && stateVars.has(init.name)) {
        collectIds(node.id).forEach(id => destructuredAliases.add(id.name))
      }
    }

    const isAliasWrite = (name: string) => destructuredAliases.has(name)

    return {
      VariableDeclarator(node) {
        // Track state declarations
        if (
          node.init?.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.init.callee.name === '$state' &&
          node.id.type === 'Identifier'
        ) {
          stateVars.add(node.id.name)
        }
        // Track destructuring from state
        markDestructure(node)
      },

      AssignmentExpression(node: AssignmentExpression) {
        if (node.left.type === 'Identifier' && isAliasWrite(node.left.name)) {
          context.report({
            node,
            messageId: 'noWrite',
            data: { name: node.left.name },
          })
        }
      },

      UpdateExpression(node: UpdateExpression) {
        if (node.argument.type === 'Identifier' && isAliasWrite(node.argument.name)) {
          context.report({
            node,
            messageId: 'noWrite',
            data: { name: node.argument.name },
          })
        }
      },
    }
  },
}

export default rule
