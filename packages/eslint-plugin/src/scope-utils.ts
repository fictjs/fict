import type { Rule, Scope } from 'eslint'
import type { Identifier } from 'estree'

/** Resolve an identifier to its lexical ESLint binding. */
export function resolveVariable(
  context: Rule.RuleContext,
  identifier: Identifier,
): Scope.Variable | null {
  let scope: Scope.Scope | null = context.sourceCode.getScope(identifier)
  while (scope) {
    const variable = scope.set.get(identifier.name)
    if (variable) return variable
    scope = scope.upper
  }
  return null
}
