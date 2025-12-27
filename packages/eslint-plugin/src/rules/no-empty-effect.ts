import type { Rule } from 'eslint'

const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow $effect bodies that do not read any reactive value (FICT-E001)',
      recommended: true,
    },
    messages: {
      emptyEffect: '$effect should reference at least one reactive value (FICT-E001).',
    },
    schema: [],
  },
  create(context) {
    const builtinIgnore = new Set([
      'console',
      'Math',
      'Date',
      'JSON',
      'Number',
      'String',
      'Boolean',
      'Symbol',
      'BigInt',
      'Reflect',
      'RegExp',
    ])

    const collectLocals = (node: any, locals: Set<string>) => {
      if (!node || node.type !== 'BlockStatement') return
      for (const stmt of node.body) {
        if (stmt.type === 'VariableDeclaration') {
          for (const decl of stmt.declarations) {
            if (decl.id.type === 'Identifier') {
              locals.add(decl.id.name)
            } else if (decl.id.type === 'ObjectPattern' || decl.id.type === 'ArrayPattern') {
              const visit = (p: any) => {
                if (!p) return
                if (p.type === 'Identifier') {
                  locals.add(p.name)
                } else if (p.type === 'RestElement') {
                  visit(p.argument)
                } else if (p.type === 'ObjectPattern') {
                  for (const prop of p.properties) {
                    if (prop.type === 'Property') {
                      visit(prop.value)
                    } else if (prop.type === 'RestElement') {
                      visit(prop.argument)
                    }
                  }
                } else if (p.type === 'ArrayPattern') {
                  p.elements.forEach(visit)
                }
              }
              visit(decl.id)
            }
          }
        }
        if (stmt.type === 'FunctionDeclaration' && stmt.id?.name) {
          locals.add(stmt.id.name)
        }
      }
    }

    const hasOuterReference = (node: any, locals: Set<string>): boolean => {
      let found = false
      const visit = (n: any) => {
        if (found) return
        if (!n) return
        if (
          n.type === 'FunctionDeclaration' ||
          n.type === 'FunctionExpression' ||
          n.type === 'ArrowFunctionExpression'
        ) {
          return
        }
        if (n.type === 'Identifier') {
          if (!locals.has(n.name) && !builtinIgnore.has(n.name)) {
            found = true
          }
          return
        }
        if (n.type === 'MemberExpression') {
          // Only look at the object; property may be an Identifier but is not a read
          visit(n.object)
          if (n.computed) {
            visit(n.property)
          }
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
            visit(value)
          }
        }
      }
      visit(node)
      return found
    }

    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === '$effect') {
          const firstArg = node.arguments[0]
          if (
            firstArg &&
            (firstArg.type === 'ArrowFunctionExpression' || firstArg.type === 'FunctionExpression')
          ) {
            if (firstArg.body.type !== 'BlockStatement') {
              return
            }
            const block = firstArg.body
            if (block.body.length === 0) {
              context.report({ node, messageId: 'emptyEffect' })
              return
            }
            const locals = new Set<string>()
            firstArg.params.forEach(param => {
              if (param.type === 'Identifier') locals.add(param.name)
            })
            collectLocals(block, locals)
            if (!hasOuterReference(block, locals)) {
              context.report({ node, messageId: 'emptyEffect' })
            }
          }
        }
      },
    }
  },
}

export default rule
