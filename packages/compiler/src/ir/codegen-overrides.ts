import type * as BabelCore from '@babel/core'

import { normalizeDependencyKey as normalizeDependencyKeyImpl } from './dependency-key'

export type RegionOverrideMap = Record<string, () => BabelCore.types.Expression>

const SKIP_REGION_OVERRIDE_EXTRA_KEY = '__fictSkipRegionOverride'
const hasOwn = (obj: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key)

export function markSkipRegionOverride<T extends BabelCore.types.Node>(node: T): T {
  const extra = (node.extra ?? {}) as Record<string, unknown>
  extra[SKIP_REGION_OVERRIDE_EXTRA_KEY] = true
  node.extra = extra
  return node
}

function shouldSkipRegionOverride(node: BabelCore.types.Node): boolean {
  const extra = (node.extra ?? {}) as Record<string, unknown>
  return extra[SKIP_REGION_OVERRIDE_EXTRA_KEY] === true
}

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
  const isWriteTarget =
    (parentKind === 'AssignmentExpression' && parentKey === 'left') ||
    (parentKind === 'UpdateExpression' && parentKey === 'argument')
  const isLabelPosition =
    parentKey === 'label' &&
    (parentKind === 'BreakStatement' ||
      parentKind === 'ContinueStatement' ||
      parentKind === 'LabeledStatement')

  if (parentKind === 'VariableDeclarator' && parentKey === 'id') {
    return
  }
  if (isLabelPosition) {
    return
  }
  if (isWriteTarget) {
    return
  }
  if (!skipCurrentNode && shouldSkipRegionOverride(node)) {
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

  const collectFunctionScopedNames = (
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
        t.isClassDeclaration(current) ||
        t.isClassExpression(current) ||
        t.isFunctionExpression(current) ||
        t.isArrowFunctionExpression(current) ||
        t.isFunctionDeclaration(current) ||
        t.isObjectMethod(current) ||
        t.isClassMethod(current) ||
        t.isClassPrivateMethod(current)
      ) {
        return
      }

      if (t.isVariableDeclaration(current)) {
        if (current.kind === 'var') {
          current.declarations.forEach(decl => {
            collectPatternNames(decl.id as BabelCore.types.PatternLike, names)
            visit(decl.init)
          })
        } else {
          current.declarations.forEach(decl => visit(decl.init))
        }
        return
      }

      if (t.isCatchClause(current)) {
        visit(current.body)
        return
      }

      if (t.isForOfStatement(current) || t.isForInStatement(current)) {
        if (t.isVariableDeclaration(current.left) && current.left.kind === 'var') {
          current.left.declarations.forEach(decl => {
            collectPatternNames(decl.id as BabelCore.types.PatternLike, names)
          })
        }
        visit(current.right)
        visit(current.body)
        return
      }

      if (t.isForStatement(current)) {
        if (t.isVariableDeclaration(current.init) && current.init.kind === 'var') {
          current.init.declarations.forEach(decl => {
            collectPatternNames(decl.id as BabelCore.types.PatternLike, names)
          })
        }
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

  const collectBlockScopedNames = (body: BabelCore.types.BlockStatement): Set<string> => {
    const names = new Set<string>()
    body.body.forEach(stmt => {
      if (t.isVariableDeclaration(stmt) && stmt.kind !== 'var') {
        stmt.declarations.forEach(decl =>
          collectPatternNames(decl.id as BabelCore.types.PatternLike, names),
        )
      } else if (t.isFunctionDeclaration(stmt) && stmt.id) {
        names.add(normalizeDependencyKey(stmt.id.name).split('.')[0] ?? stmt.id.name)
      } else if (t.isClassDeclaration(stmt) && stmt.id) {
        names.add(normalizeDependencyKey(stmt.id.name).split('.')[0] ?? stmt.id.name)
      }
    })
    return names
  }

  const scopeOverrides = (names: Set<string>): RegionOverrideMap => {
    if (names.size === 0) return overrides
    const scopedOverrides = Object.create(null) as RegionOverrideMap
    for (const key of Object.keys(overrides)) {
      const base = normalizeDependencyKey(key).split('.')[0] ?? key
      if (!names.has(base)) {
        scopedOverrides[key] = overrides[key]!
      }
    }
    return scopedOverrides
  }

  if (t.isFunctionDeclaration(node)) {
    const names = collectParamNames(node.params)
    collectFunctionScopedNames(node.body).forEach(name => names.add(name))
    replaceIdentifiersWithOverrides(
      node.body,
      scopeOverrides(names),
      t,
      node.type,
      'body',
      false,
      allowCallCalleeReplacement,
    )
    return
  }

  if (t.isCatchClause(node)) {
    const names = new Set<string>()
    if (node.param) {
      collectPatternNames(node.param as BabelCore.types.PatternLike, names)
    }
    replaceIdentifiersWithOverrides(
      node.body,
      scopeOverrides(names),
      t,
      node.type,
      'body',
      false,
      allowCallCalleeReplacement,
    )
    return
  }

  if (t.isForOfStatement(node) || t.isForInStatement(node)) {
    const names = new Set<string>()
    if (t.isVariableDeclaration(node.left) && node.left.kind !== 'var') {
      node.left.declarations.forEach(decl =>
        collectPatternNames(decl.id as BabelCore.types.PatternLike, names),
      )
    }
    const scopedOverrides = scopeOverrides(names)
    replaceIdentifiersWithOverrides(
      node.left as BabelCore.types.Node,
      scopedOverrides,
      t,
      node.type,
      'left',
      false,
      allowCallCalleeReplacement,
    )
    replaceIdentifiersWithOverrides(
      node.right,
      overrides,
      t,
      node.type,
      'right',
      false,
      allowCallCalleeReplacement,
    )
    replaceIdentifiersWithOverrides(
      node.body,
      scopedOverrides,
      t,
      node.type,
      'body',
      false,
      allowCallCalleeReplacement,
    )
    return
  }

  if (t.isForStatement(node)) {
    const names = new Set<string>()
    if (t.isVariableDeclaration(node.init) && node.init.kind !== 'var') {
      node.init.declarations.forEach(decl =>
        collectPatternNames(decl.id as BabelCore.types.PatternLike, names),
      )
    }
    const scopedOverrides = scopeOverrides(names)
    if (node.init) {
      replaceIdentifiersWithOverrides(
        node.init as BabelCore.types.Node,
        scopedOverrides,
        t,
        node.type,
        'init',
        false,
        allowCallCalleeReplacement,
      )
    }
    if (node.test) {
      replaceIdentifiersWithOverrides(
        node.test,
        scopedOverrides,
        t,
        node.type,
        'test',
        false,
        allowCallCalleeReplacement,
      )
    }
    if (node.update) {
      replaceIdentifiersWithOverrides(
        node.update,
        scopedOverrides,
        t,
        node.type,
        'update',
        false,
        allowCallCalleeReplacement,
      )
    }
    replaceIdentifiersWithOverrides(
      node.body,
      scopedOverrides,
      t,
      node.type,
      'body',
      false,
      allowCallCalleeReplacement,
    )
    return
  }

  if (t.isBlockStatement(node)) {
    const names = collectBlockScopedNames(node)
    const scopedOverrides = scopeOverrides(names)
    node.body.forEach(stmt =>
      replaceIdentifiersWithOverrides(
        stmt,
        scopedOverrides,
        t,
        node.type,
        'body',
        false,
        allowCallCalleeReplacement,
      ),
    )
    return
  }

  if (!skipCurrentNode && (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))) {
    const propertyNode = node.property as BabelCore.types.Node
    const isDynamicComputed =
      (node.computed ?? false) &&
      !t.isStringLiteral(propertyNode) &&
      !t.isNumericLiteral(propertyNode)
    const path = getDependencyPathFromNode(node, t)
    const normalized = path ? normalizeDependencyKey(path) : null
    const override =
      normalized && hasOwn(overrides, normalized)
        ? overrides[normalized]
        : path && hasOwn(overrides, path)
          ? overrides[path]
          : undefined
    if (override && !isCallTarget && !isDynamicComputed) {
      const replacement = override()
      Object.assign(node, replacement)
      return
    }
  }

  if (!skipCurrentNode && t.isIdentifier(node)) {
    const key = normalizeDependencyKey(node.name)
    const override = hasOwn(overrides, key)
      ? overrides[key]
      : hasOwn(overrides, node.name)
        ? overrides[node.name]
        : undefined
    if (override && !isCallTarget) {
      const replacement = override()
      Object.assign(node, replacement)
      return
    }
  }

  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    const paramNames = collectParamNames(node.params)
    if (t.isFunctionExpression(node) && node.id) {
      paramNames.add(normalizeDependencyKey(node.id.name).split('.')[0] ?? node.id.name)
    }
    const localNames = collectFunctionScopedNames(node.body)
    localNames.forEach(name => paramNames.add(name))
    const scopedOverrides = scopeOverrides(paramNames)
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

  if (t.isObjectMethod(node)) {
    if (node.computed) {
      replaceIdentifiersWithOverrides(
        node.key,
        overrides,
        t,
        node.type,
        'key',
        false,
        allowCallCalleeReplacement,
      )
    }
    const names = collectParamNames(node.params)
    collectFunctionScopedNames(node.body).forEach(name => names.add(name))
    replaceIdentifiersWithOverrides(
      node.body,
      scopeOverrides(names),
      t,
      node.type,
      'body',
      false,
      allowCallCalleeReplacement,
    )
    return
  }

  if (t.isClassMethod(node) || t.isClassPrivateMethod(node)) {
    if (node.computed) {
      replaceIdentifiersWithOverrides(
        node.key,
        overrides,
        t,
        node.type,
        'key',
        false,
        allowCallCalleeReplacement,
      )
    }
    const names = collectParamNames(node.params)
    collectFunctionScopedNames(node.body).forEach(name => names.add(name))
    replaceIdentifiersWithOverrides(
      node.body,
      scopeOverrides(names),
      t,
      node.type,
      'body',
      false,
      allowCallCalleeReplacement,
    )
    return
  }

  if (t.isStaticBlock(node)) {
    const names = collectBlockScopedNames(t.blockStatement(node.body))
    node.body.forEach(stmt =>
      replaceIdentifiersWithOverrides(
        stmt,
        scopeOverrides(names),
        t,
        node.type,
        'body',
        false,
        allowCallCalleeReplacement,
      ),
    )
    return
  }

  if (t.isMetaProperty(node)) {
    return
  }

  if (t.isClassExpression(node) || t.isClassDeclaration(node)) {
    const classNames = new Set<string>()
    if (node.id) {
      classNames.add(normalizeDependencyKey(node.id.name).split('.')[0] ?? node.id.name)
    }
    const classOverrides = scopeOverrides(classNames)

    const decorators = (node as unknown as { decorators?: BabelCore.types.Decorator[] }).decorators
    decorators?.forEach(decorator =>
      replaceIdentifiersWithOverrides(
        decorator,
        overrides,
        t,
        node.type,
        'decorators',
        false,
        allowCallCalleeReplacement,
      ),
    )

    if (node.superClass) {
      replaceIdentifiersWithOverrides(
        node.superClass,
        classOverrides,
        t,
        node.type,
        'superClass',
        false,
        allowCallCalleeReplacement,
      )
    }
    node.body.body.forEach(member =>
      replaceIdentifiersWithOverrides(
        member,
        classOverrides,
        t,
        node.type,
        'body',
        false,
        allowCallCalleeReplacement,
      ),
    )
    return
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
    if ((t.isObjectProperty(node) || t.isObjectMethod(node)) && key === 'key' && !node.computed) {
      continue
    }
    if (
      (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
      key === 'property' &&
      !node.computed
    ) {
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
