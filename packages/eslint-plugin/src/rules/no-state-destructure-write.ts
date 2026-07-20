import type { Rule, Scope } from 'eslint'
import type {
  AssignmentExpression,
  CallExpression,
  Identifier,
  MemberExpression,
  Node,
  Pattern,
  RestElement,
  UnaryExpression,
  UpdateExpression,
  VariableDeclarator,
} from 'estree'

import { resolveVariable } from '../scope-utils'

const MUTATING_ARRAY_METHODS = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
])

/**
 * Prevent writes to read-only aliases created from a $state-backed value.
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
        'Disallow writing to read-only aliases from $state; write via the original state instead.',
      recommended: true,
    },
    messages: {
      noWrite:
        "Do not write to read-only $state alias '{name}'. Update via the original state binding instead.",
    },
    schema: [],
  },
  create(context) {
    const stateVars = new WeakSet<Scope.Variable>()
    const reactiveAliases = new WeakSet<Scope.Variable>()
    const destructuredAliases = new WeakSet<Scope.Variable>()

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
        if (p.type === 'AssignmentPattern') {
          visit(p.left)
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

    const isAliasWrite = (identifier: Identifier): boolean => {
      const variable = resolveVariable(context, identifier)
      return !!variable && (reactiveAliases.has(variable) || destructuredAliases.has(variable))
    }

    const isReactiveSource = (identifier: Identifier): boolean => {
      const variable = resolveVariable(context, identifier)
      return (
        !!variable &&
        (stateVars.has(variable) ||
          reactiveAliases.has(variable) ||
          destructuredAliases.has(variable))
      )
    }

    const isNode = (value: unknown): value is Node =>
      typeof value === 'object' && value !== null && 'type' in value

    const expressionContainsReactiveSource = (node: Node): boolean => {
      if (node.type === 'Identifier') return isReactiveSource(node)
      if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
        return false
      }
      if (node.type === 'MemberExpression') {
        return (
          expressionContainsReactiveSource(node.object) ||
          (node.computed && expressionContainsReactiveSource(node.property))
        )
      }
      if (node.type === 'Property') {
        return (
          expressionContainsReactiveSource(node.value) ||
          (node.computed && expressionContainsReactiveSource(node.key))
        )
      }
      return (context.sourceCode.visitorKeys[node.type] ?? []).some(key => {
        const child = (node as unknown as Record<string, unknown>)[key]
        return Array.isArray(child)
          ? child.some(value => isNode(value) && expressionContainsReactiveSource(value))
          : isNode(child) && expressionContainsReactiveSource(child)
      })
    }

    const markDestructure = (node: VariableDeclarator) => {
      if (!node.init || (node.id.type !== 'ObjectPattern' && node.id.type !== 'ArrayPattern'))
        return
      if (expressionContainsReactiveSource(node.init)) {
        collectIds(node.id).forEach(id => {
          const variable = resolveVariable(context, id)
          if (variable) destructuredAliases.add(variable)
        })
      }
    }

    const memberRootIdentifier = (member: MemberExpression): Identifier | null => {
      let object = member.object
      while (object.type === 'MemberExpression') object = object.object
      return object.type === 'Identifier' ? object : null
    }

    const mutatingArrayMethod = (member: MemberExpression): boolean => {
      const name = member.computed
        ? member.property.type === 'Literal' && typeof member.property.value === 'string'
          ? member.property.value
          : null
        : member.property.type === 'Identifier'
          ? member.property.name
          : null
      return name !== null && MUTATING_ARRAY_METHODS.has(name)
    }

    const markDirectAlias = (identifier: Identifier) => {
      const variable = resolveVariable(context, identifier)
      if (variable && !stateVars.has(variable)) reactiveAliases.add(variable)
    }

    const markDestructuredAliases = (pattern: Pattern) => {
      collectIds(pattern).forEach(identifier => {
        const variable = resolveVariable(context, identifier)
        if (variable && !stateVars.has(variable)) destructuredAliases.add(variable)
      })
    }

    const reportAliasWrite = (
      node: AssignmentExpression | CallExpression | UnaryExpression | UpdateExpression,
      id: Identifier,
    ) => {
      context.report({
        node,
        messageId: 'noWrite',
        data: { name: id.name },
      })
    }

    return {
      VariableDeclarator(node) {
        // Track state declarations
        if (
          node.init?.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.init.callee.name === '$state' &&
          node.id.type === 'Identifier'
        ) {
          const variable = resolveVariable(context, node.id)
          if (variable) stateVars.add(variable)
        }
        if (
          node.id.type === 'Identifier' &&
          node.init &&
          ((node.init.type === 'Identifier' && isReactiveSource(node.init)) ||
            ((node as VariableDeclarator & { parent?: { kind?: string } }).parent?.kind ===
              'const' &&
              expressionContainsReactiveSource(node.init)))
        ) {
          markDirectAlias(node.id)
        }
        // Track destructuring from state
        markDestructure(node)
      },

      AssignmentExpression(node: AssignmentExpression) {
        if (node.left.type === 'MemberExpression') {
          const root = memberRootIdentifier(node.left)
          if (root && isAliasWrite(root)) reportAliasWrite(node, root)
          return
        }
        if (expressionContainsReactiveSource(node.right)) {
          const existingAlias = collectIds(node.left as Pattern).find(isAliasWrite)
          if (existingAlias) {
            reportAliasWrite(node, existingAlias)
            return
          }
          if (
            node.left.type === 'Identifier' &&
            node.right.type === 'Identifier' &&
            isReactiveSource(node.right)
          ) {
            markDirectAlias(node.left)
          } else if (node.left.type !== 'Identifier') {
            markDestructuredAliases(node.left as Pattern)
          }
          return
        }
        const alias = collectIds(node.left as Pattern).find(isAliasWrite)
        if (alias) {
          reportAliasWrite(node, alias)
        }
      },

      UpdateExpression(node: UpdateExpression) {
        if (node.argument.type === 'Identifier' && isAliasWrite(node.argument)) {
          reportAliasWrite(node, node.argument)
        } else if (node.argument.type === 'MemberExpression') {
          const root = memberRootIdentifier(node.argument)
          if (root && isAliasWrite(root)) reportAliasWrite(node, root)
        }
      },

      UnaryExpression(node: UnaryExpression) {
        if (node.operator !== 'delete' || node.argument.type !== 'MemberExpression') return
        const root = memberRootIdentifier(node.argument)
        if (root && isAliasWrite(root)) {
          reportAliasWrite(node, root)
        }
      },

      CallExpression(node: CallExpression) {
        if (node.callee.type !== 'MemberExpression' || !mutatingArrayMethod(node.callee)) return
        const root = memberRootIdentifier(node.callee)
        if (root && isAliasWrite(root)) {
          reportAliasWrite(node, root)
        }
      },
    }
  },
}

export default rule
