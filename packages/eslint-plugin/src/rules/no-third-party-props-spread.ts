import type { Rule } from 'eslint'

/**
 * ESLint rule to warn on spreading third-party objects into component props.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Warn on third-party object spreads in JSX props',
      recommended: true,
    },
    messages: {
      thirdPartySpread:
        'Spreading third-party objects into props may hide reactive changes; prefer explicit props or map fields.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          includeCallExpressions: {
            type: 'boolean',
            description: 'Also warn when JSX spread comes from a third-party call expression.',
          },
          allow: {
            type: 'array',
            items: { type: 'string' },
            description: 'Module specifiers to treat as internal.',
          },
          internalPrefixes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Import path prefixes to treat as internal (e.g. "@/", "~/" ).',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] || {}
    const allow = new Set<string>(options.allow ?? [])
    const internalPrefixes: string[] = options.internalPrefixes ?? []
    const includeCallExpressions = options.includeCallExpressions === true
    const thirdPartyImports = new Set<string>()

    const isThirdPartySource = (source: string): boolean => {
      if (allow.has(source)) return false
      if (source.startsWith('.') || source.startsWith('/')) return false
      if (internalPrefixes.some(prefix => source.startsWith(prefix))) return false
      return true
    }

    const isComponentName = (name: any): boolean => {
      if (name.type === 'JSXIdentifier') {
        return /^[A-Z]/.test(name.name)
      }
      if (name.type === 'JSXMemberExpression') {
        return true
      }
      return false
    }

    const unwrapExpression = (expr: any): any => {
      let current = expr
      while (current) {
        if (current.type === 'ChainExpression') {
          current = current.expression
          continue
        }
        if (
          current.type === 'TSAsExpression' ||
          current.type === 'TSTypeAssertion' ||
          current.type === 'TSNonNullExpression'
        ) {
          current = current.expression
          continue
        }
        break
      }
      return current
    }

    const getRootIdentifierName = (expr: any): string | null => {
      let current = unwrapExpression(expr)
      while (current) {
        if (current.type === 'Identifier') return current.name
        if (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression') {
          current = unwrapExpression(current.object)
          continue
        }
        if (
          includeCallExpressions &&
          (current.type === 'CallExpression' || current.type === 'OptionalCallExpression')
        ) {
          current = unwrapExpression(current.callee)
          continue
        }
        return null
      }
      return null
    }

    return {
      ImportDeclaration(node: any) {
        if (!node.source?.value || typeof node.source.value !== 'string') return
        if (!isThirdPartySource(node.source.value)) return
        for (const spec of node.specifiers ?? []) {
          if (spec.local?.name) {
            thirdPartyImports.add(spec.local.name)
          }
        }
      },

      JSXOpeningElement(node: any) {
        if (!isComponentName(node.name)) return
        for (const attr of node.attributes ?? []) {
          if (attr.type !== 'JSXSpreadAttribute') continue
          const expr = attr.argument
          if (!expr) continue
          if (
            expr.type === 'CallExpression' &&
            expr.callee?.type === 'Identifier' &&
            expr.callee.name === 'mergeProps'
          ) {
            continue
          }
          const root = getRootIdentifierName(expr)
          if (root && thirdPartyImports.has(root)) {
            context.report({
              node: attr,
              messageId: 'thirdPartySpread',
            })
          }
        }
      },
    }
  },
}

export default rule
