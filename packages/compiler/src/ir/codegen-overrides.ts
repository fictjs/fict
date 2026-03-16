import type * as BabelCore from '@babel/core'

import { normalizeDependencyKey as normalizeDependencyKeyImpl } from './dependency-key'

export type RegionOverrideMap = Record<string, () => BabelCore.types.Expression>

export function normalizeDependencyKey(name: string): string {
  return normalizeDependencyKeyImpl(name)
}

function getDependencyPathFromNode(
  node: BabelCore.types.Node,
  t: typeof BabelCore.types,
): string | null {
  if (t.isIdentifier(node)) {
    return normalizeDependencyKey(node.name)
  }

  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const object = node.object as BabelCore.types.Node
    const property = node.property as BabelCore.types.Node
    const objectPath = getDependencyPathFromNode(object, t)
    if (!objectPath) return null

    let propName: string | null = null
    if (node.computed) {
      if (t.isStringLiteral(property) || t.isNumericLiteral(property)) {
        propName = String(property.value)
      } else {
        // Dynamic computed property - fall back to tracking the base object
        return objectPath
      }
    } else if (t.isIdentifier(property)) {
      propName = property.name
    }

    if (!propName) return objectPath
    return `${objectPath}.${propName}`
  }

  return null
}

/**
 * Replace identifiers using overrides while skipping call/optional call callees.
 * This is adapted from fine-grained-dom's replaceIdentifiers helper.
 */
export function replaceIdentifiersWithOverrides(
  node: BabelCore.types.Node,
  overrides: RegionOverrideMap,
  t: typeof BabelCore.types,
  parentKind?: string,
  parentKey?: string,
  skipCurrentNode = false,
  allowCallCalleeReplacement = false,
): void {
  const isCallTarget =
    !allowCallCalleeReplacement &&
    parentKey === 'callee' &&
    (parentKind === 'CallExpression' || parentKind === 'OptionalCallExpression')

  if (parentKind === 'VariableDeclarator' && parentKey === 'id') {
    return
  }

  const collectPatternNames = (
    pattern: BabelCore.types.LVal | BabelCore.types.PatternLike,
    into: Set<string>,
  ) => {
    if (t.isIdentifier(pattern)) {
      into.add(normalizeDependencyKey(pattern.name).split('.')[0] ?? pattern.name)
      return
    }
    if (t.isTSParameterProperty(pattern)) {
      collectPatternNames(pattern.parameter, into)
      return
    }
    if (t.isRestElement(pattern)) {
      collectPatternNames(pattern.argument as BabelCore.types.PatternLike, into)
      return
    }
    if (t.isAssignmentPattern(pattern)) {
      collectPatternNames(pattern.left, into)
      return
    }
    if (t.isObjectPattern(pattern)) {
      pattern.properties.forEach(prop => {
        if (t.isRestElement(prop)) {
          collectPatternNames(prop.argument as BabelCore.types.PatternLike, into)
        } else if (t.isObjectProperty(prop)) {
          collectPatternNames(prop.value as BabelCore.types.PatternLike, into)
        }
      })
      return
    }
    if (t.isArrayPattern(pattern)) {
      pattern.elements.forEach(el => {
        if (el && t.isPatternLike(el)) {
          collectPatternNames(el as BabelCore.types.PatternLike, into)
        }
      })
    }
  }

  const collectParamNames = (params: BabelCore.types.Function['params']): Set<string> => {
    const names = new Set<string>()
    const addName = (n: string | undefined) => {
      if (n) names.add(normalizeDependencyKey(n).split('.')[0] ?? n)
    }
    const visitPattern = (p: BabelCore.types.LVal | BabelCore.types.PatternLike) => {
      if (t.isIdentifier(p)) {
        addName(p.name)
      } else if (t.isTSParameterProperty(p)) {
        visitPattern(p.parameter)
      } else if (t.isRestElement(p) && t.isIdentifier(p.argument)) {
        addName(p.argument.name)
      } else if (t.isAssignmentPattern(p)) {
        visitPattern(p.left)
      } else if (t.isObjectPattern(p)) {
        p.properties.forEach(prop => {
          if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
            addName(prop.argument.name)
          } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.value)) {
            addName(prop.value.name)
          } else if (t.isObjectProperty(prop) && t.isPatternLike(prop.value)) {
            visitPattern(prop.value as BabelCore.types.PatternLike)
          }
        })
      } else if (t.isArrayPattern(p)) {
        p.elements.forEach(el => {
          if (t.isIdentifier(el)) addName(el.name)
          else if (el && t.isPatternLike(el)) visitPattern(el)
        })
      }
    }
    params.forEach(p => visitPattern(p))
    return names
  }

  const collectFunctionLocalNames = (
    body: BabelCore.types.Node | null | undefined,
  ): Set<string> => {
    const names = new Set<string>()

    const visit = (current: BabelCore.types.Node | null | undefined) => {
      if (!current) return
      if (t.isFunctionDeclaration(current) && current.id) {
        names.add(normalizeDependencyKey(current.id.name).split('.')[0] ?? current.id.name)
        return
      }
      if (
        t.isFunctionExpression(current) ||
        t.isArrowFunctionExpression(current) ||
        t.isFunctionDeclaration(current)
      ) {
        return
      }

      if (t.isVariableDeclaration(current)) {
        current.declarations.forEach(decl => {
          collectPatternNames(decl.id as BabelCore.types.PatternLike, names)
          visit(decl.init)
        })
        return
      }

      if (t.isCatchClause(current)) {
        if (current.param) {
          collectPatternNames(current.param as BabelCore.types.PatternLike, names)
        }
        visit(current.body)
        return
      }

      if (t.isForOfStatement(current) || t.isForInStatement(current)) {
        if (t.isVariableDeclaration(current.left)) {
          current.left.declarations.forEach(decl => {
            collectPatternNames(decl.id as BabelCore.types.PatternLike, names)
          })
        } else if (t.isPatternLike(current.left)) {
          collectPatternNames(current.left as BabelCore.types.PatternLike, names)
        }
        visit(current.right)
        visit(current.body)
        return
      }

      if (t.isForStatement(current)) {
        visit(current.init as BabelCore.types.Node | null)
        visit(current.test as BabelCore.types.Node | null)
        visit(current.update as BabelCore.types.Node | null)
        visit(current.body)
        return
      }

      if (t.isBlockStatement(current)) {
        current.body.forEach(visit)
        return
      }

      for (const key of Object.keys(current)) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
        const value = (current as unknown as Record<string, unknown>)[key]
        if (Array.isArray(value)) {
          value.forEach(item => {
            if (item && typeof item === 'object' && 'type' in item) {
              visit(item as BabelCore.types.Node)
            }
          })
        } else if (value && typeof value === 'object' && 'type' in value) {
          visit(value as BabelCore.types.Node)
        }
      }
    }

    visit(body)
    return names
  }

  if (!skipCurrentNode && (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))) {
    const propertyNode = node.property as BabelCore.types.Node
    const isDynamicComputed =
      (node.computed ?? false) &&
      !t.isStringLiteral(propertyNode) &&
      !t.isNumericLiteral(propertyNode)
    const path = getDependencyPathFromNode(node, t)
    const normalized = path ? normalizeDependencyKey(path) : null
    const override = (normalized && overrides[normalized]) || (path ? overrides[path] : undefined)
    if (override && !isCallTarget && !isDynamicComputed) {
      const replacement = override()
      Object.assign(node, replacement)
      return
    }
  }

  if (!skipCurrentNode && t.isIdentifier(node)) {
    const key = normalizeDependencyKey(node.name)
    const override = overrides[key] ?? overrides[node.name]
    if (override && !isCallTarget) {
      const replacement = override()
      Object.assign(node, replacement)
      return
    }
  }

  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    const paramNames = collectParamNames(node.params)
    const localNames = collectFunctionLocalNames(node.body)
    localNames.forEach(name => paramNames.add(name))
    let scopedOverrides = overrides
    if (paramNames.size > 0) {
      scopedOverrides = {}
      for (const key of Object.keys(overrides)) {
        const base = normalizeDependencyKey(key).split('.')[0] ?? key
        if (!paramNames.has(base)) {
          scopedOverrides[key] = overrides[key]!
        }
      }
    }
    // Avoid replacing parameter identifiers; only walk the body
    if (t.isBlockStatement(node.body)) {
      replaceIdentifiersWithOverrides(
        node.body,
        scopedOverrides,
        t,
        node.type,
        'body',
        false,
        allowCallCalleeReplacement,
      )
    } else {
      replaceIdentifiersWithOverrides(
        node.body,
        scopedOverrides,
        t,
        node.type,
        'body',
        false,
        allowCallCalleeReplacement,
      )
    }
    return
  }

  // fix: For MemberExpressions like `foo.call()`, `foo.apply()`, or `foo.bind()`,
  // skip replacing the object identifier. These method calls need the original function
  // reference for proper `this` binding.
  const isMethodCallMember =
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    !(node as BabelCore.types.MemberExpression).computed &&
    t.isIdentifier((node as BabelCore.types.MemberExpression).property) &&
    ['call', 'apply', 'bind'].includes(
      ((node as BabelCore.types.MemberExpression).property as BabelCore.types.Identifier).name,
    )

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
    if (t.isObjectProperty(node) && key === 'key' && !node.computed) {
      continue
    }
    if (
      (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
      key === 'property' &&
      !node.computed
    ) {
      continue
    }
    // fix: Skip the object of .call()/.apply()/.bind() member expressions
    if (isMethodCallMember && key === 'object') {
      continue
    }
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && 'type' in item) {
          replaceIdentifiersWithOverrides(
            item as BabelCore.types.Node,
            overrides,
            t,
            node.type,
            key,
            false,
            allowCallCalleeReplacement,
          )
        }
      }
    } else if (value && typeof value === 'object' && 'type' in value) {
      replaceIdentifiersWithOverrides(
        value as BabelCore.types.Node,
        overrides,
        t,
        node.type,
        key,
        false,
        allowCallCalleeReplacement,
      )
    }
  }
}
