import type * as BabelCore from '@babel/core'
import { declare } from '@babel/helper-plugin-utils'

import { SAFE_FUNCTIONS } from './constants'
import { buildHIR } from './ir/build-hir'
import { lowerHIRWithRegions } from './ir/codegen'
import type { FictCompilerOptions } from './types'
import { getRootIdentifier, isEffectCall, isStateCall } from './utils'

export type { FictCompilerOptions, CompilerWarning } from './types'

function stripMacroImports(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  t: typeof BabelCore.types,
): void {
  path.traverse({
    ImportDeclaration(importPath) {
      if (importPath.node.source.value !== 'fict') return
      const filtered = importPath.node.specifiers.filter(spec => {
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported)) {
          return !['$state', '$effect'].includes(spec.imported.name)
        }
        return true
      })
      if (filtered.length === 0) {
        importPath.remove()
      } else if (filtered.length !== importPath.node.specifiers.length) {
        importPath.node.specifiers = filtered
      }
    },
  })
}

function isInsideLoop(path: BabelCore.NodePath): boolean {
  return !!path.findParent(
    p =>
      p.isForStatement?.() ||
      p.isWhileStatement?.() ||
      p.isDoWhileStatement?.() ||
      p.isForInStatement?.() ||
      p.isForOfStatement?.(),
  )
}

function isInsideConditional(path: BabelCore.NodePath): boolean {
  return !!path.findParent(
    p => p.isIfStatement?.() || p.isConditionalExpression?.() || p.isSwitchCase?.(),
  )
}

function isInsideNestedFunction(path: BabelCore.NodePath): boolean {
  let depth = 0
  let current: BabelCore.NodePath | null = path
  while (current) {
    if (current.isFunction?.()) {
      depth++
      if (depth > 1) return true
    }
    current = current.parentPath
  }
  return false
}

function emitWarning(
  node: BabelCore.types.Node,
  code: string,
  message: string,
  options: FictCompilerOptions,
  fileName: string,
): void {
  if (!options.onWarn) return
  const loc = node.loc?.start
  options.onWarn({
    code,
    message,
    fileName,
    line: loc?.line ?? 0,
    column: loc ? loc.column + 1 : 0,
  })
}

function isComponentName(name: string | undefined): boolean {
  return !!name && name[0] === name[0]?.toUpperCase()
}

function blockHasReturn(block: BabelCore.types.BlockStatement): boolean {
  for (const stmt of block.body) {
    if (stmt.type === 'ReturnStatement') return true
    if (stmt.type === 'IfStatement') {
      if (
        (stmt.consequent && stmt.consequent.type === 'BlockStatement'
          ? blockHasReturn(stmt.consequent)
          : stmt.consequent?.type === 'ReturnStatement') ||
        (stmt.alternate && stmt.alternate.type === 'BlockStatement'
          ? blockHasReturn(stmt.alternate)
          : stmt.alternate?.type === 'ReturnStatement')
      ) {
        return true
      }
    }
    if (stmt.type === 'SwitchStatement') {
      for (const cs of stmt.cases) {
        for (const cstmt of cs.consequent) {
          if (cstmt.type === 'ReturnStatement') return true
          if (cstmt.type === 'BlockStatement' && blockHasReturn(cstmt)) return true
        }
      }
    }
    if (stmt.type === 'TryStatement') {
      if (stmt.block && blockHasReturn(stmt.block)) return true
      if (stmt.handler?.body && blockHasReturn(stmt.handler.body)) return true
      if (stmt.finalizer && blockHasReturn(stmt.finalizer)) return true
    }
  }
  return false
}

function functionHasReturn(node: BabelCore.types.Function): boolean {
  if (node.type === 'ArrowFunctionExpression' && node.expression) return true
  if (node.body && node.body.type === 'BlockStatement') {
    return blockHasReturn(node.body)
  }
  return false
}

function functionHasJSX(fnPath: BabelCore.NodePath<BabelCore.types.Function>): boolean {
  let found = false
  fnPath.traverse({
    JSXElement(p) {
      found = true
      p.stop()
    },
    JSXFragment(p) {
      found = true
      p.stop()
    },
    Function(inner) {
      if (inner === fnPath) return
      inner.skip()
    },
  })
  return found
}

function functionUsesStateLike(
  fnPath: BabelCore.NodePath<BabelCore.types.Function>,
  t: typeof BabelCore.types,
): boolean {
  let found = false
  fnPath.traverse({
    CallExpression(callPath) {
      if (
        t.isIdentifier(callPath.node.callee) &&
        (callPath.node.callee.name === '$state' || callPath.node.callee.name === '$effect')
      ) {
        found = true
        callPath.stop()
      }
    },
    JSXElement(p) {
      found = true
      p.stop()
    },
    JSXFragment(p) {
      found = true
      p.stop()
    },
    Function(inner) {
      if (inner === fnPath) return
      inner.skip()
    },
  })
  return found
}

function isDynamicPropertyAccess(
  node: BabelCore.types.MemberExpression | BabelCore.types.OptionalMemberExpression,
  t: typeof BabelCore.types,
): boolean {
  if (!node.computed) return false
  return !(t.isStringLiteral(node.property) || t.isNumericLiteral(node.property))
}

function runWarningPass(
  programPath: BabelCore.NodePath<BabelCore.types.Program>,
  stateVars: Set<string>,
  derivedVars: Set<string>,
  options: FictCompilerOptions,
  t: typeof BabelCore.types,
): void {
  const fileName = (programPath.hub as any)?.file?.opts?.filename || '<unknown>'
  const isStateRoot = (expr: BabelCore.types.Expression): boolean => {
    const root = getRootIdentifier(expr, t)
    return !!(root && stateVars.has(root.name))
  }

  programPath.traverse({
    AssignmentExpression(path) {
      const { left } = path.node
      if (t.isIdentifier(left)) return
      if (t.isMemberExpression(left) || t.isOptionalMemberExpression(left)) {
        if (isStateRoot(left.object as BabelCore.types.Expression)) {
          emitWarning(
            path.node,
            'FICT-M',
            'Direct mutation of nested property detected; use immutable update or $store helpers',
            options,
            fileName,
          )
          if (isDynamicPropertyAccess(left as any, t)) {
            emitWarning(
              path.node,
              'FICT-H',
              'Dynamic property access widens dependency tracking',
              options,
              fileName,
            )
          }
        }
      }
    },
    UpdateExpression(path) {
      const arg = path.node.argument
      if (t.isMemberExpression(arg) || t.isOptionalMemberExpression(arg)) {
        if (isStateRoot(arg.object as BabelCore.types.Expression)) {
          emitWarning(
            path.node,
            'FICT-M',
            'Direct mutation of nested property detected; use immutable update or $store helpers',
            options,
            fileName,
          )
          if (isDynamicPropertyAccess(arg as any, t)) {
            emitWarning(
              path.node,
              'FICT-H',
              'Dynamic property access widens dependency tracking',
              options,
              fileName,
            )
          }
        }
      }
    },
    MemberExpression(path) {
      if (!path.node.computed) return
      if (path.parentPath.isAssignmentExpression({ left: path.node })) return
      if (path.parentPath.isUpdateExpression({ argument: path.node as any })) return
      if (isDynamicPropertyAccess(path.node, t) && isStateRoot(path.node.object as any)) {
        emitWarning(
          path.node,
          'FICT-H',
          'Dynamic property access widens dependency tracking',
          options,
          fileName,
        )
      }
    },
    CallExpression(path) {
      if (t.isIdentifier(path.node.callee, { name: '$effect' })) {
        const argPath = path.get('arguments.0')
        if (argPath?.isFunctionExpression() || argPath?.isArrowFunctionExpression()) {
          let hasReactiveDependency = false
          argPath.traverse({
            Identifier(idPath) {
              // Ignore property keys and non-computed member properties
              if (
                idPath.parentPath.isMemberExpression({ property: idPath.node }) &&
                !(idPath.parent as BabelCore.types.MemberExpression).computed
              ) {
                return
              }
              if (
                idPath.parentPath.isObjectProperty({ key: idPath.node }) &&
                !(idPath.parent as BabelCore.types.ObjectProperty).computed
              ) {
                return
              }
              const binding = idPath.scope.getBinding(idPath.node.name)
              if (binding && binding.scope === argPath.scope) return

              if (stateVars.has(idPath.node.name) || derivedVars.has(idPath.node.name)) {
                hasReactiveDependency = true
                idPath.stop()
              }
            },
          })

          if (!hasReactiveDependency) {
            emitWarning(
              path.node,
              'FICT-E001',
              'Effect has no reactive reads; it will run once. Consider removing $effect or adding dependencies.',
              options,
              fileName,
            )
          }
        }
        return
      }

      // Re-extract callee to reset TypeScript type narrowing from the $effect check above
      const callee = path.node.callee as BabelCore.types.Expression
      let calleeName = ''
      if (t.isIdentifier(callee)) {
        calleeName = callee.name
      } else if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
        const root = getRootIdentifier(callee.object as BabelCore.types.Expression, t)
        if (root) {
          calleeName = `${root.name}.${callee.property.name}`
        }
      }

      const isSafe = calleeName && SAFE_FUNCTIONS.has(calleeName)
      if (isSafe) return

      for (const arg of path.node.arguments) {
        if (!t.isExpression(arg)) continue
        if (isStateRoot(arg)) {
          emitWarning(
            arg,
            'FICT-H',
            'State value passed to unknown function (black box); dependency tracking may be imprecise',
            options,
            fileName,
          )
          break
        }
      }
    },
    OptionalMemberExpression(path) {
      if (!path.node.computed) return
      if (path.parentPath.isAssignmentExpression({ left: path.node })) return
      if (path.parentPath.isUpdateExpression({ argument: path.node as any })) return
      if (isDynamicPropertyAccess(path.node, t) && isStateRoot(path.node.object as any)) {
        emitWarning(
          path.node,
          'FICT-H',
          'Dynamic property access widens dependency tracking',
          options,
          fileName,
        )
      }
    },
  })
}

function createHIREntrypointVisitor(
  t: typeof BabelCore.types,
  options: FictCompilerOptions,
): BabelCore.PluginObj['visitor'] {
  const collectPatternIdentifiers = (pattern: BabelCore.types.PatternLike): string[] => {
    const ids: string[] = []
    const visit = (p: BabelCore.types.PatternLike) => {
      if (t.isIdentifier(p)) {
        ids.push(p.name)
        return
      }
      if (t.isRestElement(p)) {
        if (t.isIdentifier(p.argument)) ids.push(p.argument.name)
        else if (t.isPatternLike(p.argument)) visit(p.argument as BabelCore.types.PatternLike)
        return
      }
      if (t.isObjectPattern(p)) {
        p.properties.forEach(prop => {
          if (t.isObjectProperty(prop)) {
            if (t.isIdentifier(prop.value)) ids.push(prop.value.name)
            else if (t.isPatternLike(prop.value)) visit(prop.value as BabelCore.types.PatternLike)
          } else if (t.isRestElement(prop)) {
            visit(prop.argument as BabelCore.types.PatternLike)
          }
        })
        return
      }
      if (t.isArrayPattern(p)) {
        p.elements.forEach(el => {
          if (!el) return
          if (t.isIdentifier(el)) ids.push(el.name)
          else if (t.isPatternLike(el)) visit(el as BabelCore.types.PatternLike)
        })
        return
      }
      if (t.isAssignmentPattern(p)) {
        visit(p.left as BabelCore.types.PatternLike)
      }
    }
    visit(pattern)
    return ids
  }

  return {
    Program: {
      exit(path) {
        const fileName = (path.hub as any)?.file?.opts?.filename || '<unknown>'

        // Warn on component-like functions missing a return
        path.traverse({
          FunctionDeclaration(fnPath) {
            const name = fnPath.node.id?.name
            if (!isComponentName(name)) return
            if (!functionHasJSX(fnPath) && !functionUsesStateLike(fnPath, t)) return
            if (functionHasReturn(fnPath.node)) return
            emitWarning(
              fnPath.node,
              'FICT-C004',
              'Component has no return statement and will render nothing.',
              options,
              fileName,
            )
          },
          VariableDeclarator(varPath) {
            if (!t.isIdentifier(varPath.node.id) || !isComponentName(varPath.node.id.name)) return
            const init = varPath.node.init
            if (!init) return
            if (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init)) {
              return
            }
            const fnPath = varPath.get('init') as BabelCore.NodePath<
              BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression
            >
            if (!functionHasJSX(fnPath as any) && !functionUsesStateLike(fnPath as any, t)) return
            if (functionHasReturn(init as any)) return
            emitWarning(
              init,
              'FICT-C004',
              'Component has no return statement and will render nothing.',
              options,
              fileName,
            )
          },
        })
        // Collect macro imports from fict
        const fictImports = new Set<string>()
        path.traverse({
          ImportDeclaration(importPath) {
            if (importPath.node.source.value !== 'fict') return
            for (const spec of importPath.node.specifiers) {
              if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported)) {
                fictImports.add(spec.imported.name)
              }
            }
          },
        })
        // Warn on list rendering without key
        path.traverse({
          JSXExpressionContainer(exprPath) {
            const expr = exprPath.node.expression
            if (!t.isCallExpression(expr)) return
            if (
              !t.isMemberExpression(expr.callee) ||
              !t.isIdentifier(expr.callee.property, { name: 'map' })
            ) {
              return
            }
            const cb = expr.arguments[0]
            if (!cb || (!t.isArrowFunctionExpression(cb) && !t.isFunctionExpression(cb))) return

            const getReturnedJsx = (
              fn: BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression,
            ): BabelCore.types.JSXElement | null => {
              if (t.isJSXElement(fn.body)) return fn.body
              if (t.isBlockStatement(fn.body)) {
                const ret = fn.body.body.find(stmt => t.isReturnStatement(stmt))
                if (
                  ret &&
                  t.isReturnStatement(ret) &&
                  ret.argument &&
                  t.isJSXElement(ret.argument)
                ) {
                  return ret.argument
                }
              }
              return null
            }

            const jsx = getReturnedJsx(cb as any)
            if (!jsx) return

            let hasKey = false
            let hasUnknownSpread = false
            for (const attr of jsx.openingElement.attributes) {
              if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name: 'key' })) {
                hasKey = true
                break
              }
              if (t.isJSXSpreadAttribute(attr)) {
                hasUnknownSpread = true
              }
            }
            if (hasKey || hasUnknownSpread) return

            options.onWarn?.({
              code: 'FICT-J002',
              message: 'Missing key prop in list rendering.',
              fileName,
              line: expr.loc?.start.line ?? 0,
              column: expr.loc ? expr.loc.start.column + 1 : 0,
            })
          },
        })

        // Validate macro placement consistently for HIR path
        const stateVars = new Set<string>()
        const derivedVars = new Set<string>()
        const destructuredAliases = new Set<string>()
        path.traverse({
          VariableDeclarator(varPath) {
            const init = varPath.node.init
            if (!init) return
            if (isStateCall(init, t)) {
              // Check if $state is imported from fict
              if (!fictImports.has('$state')) {
                throw varPath.buildCodeFrameError('$state() must be imported from "fict"')
              }
              if (!t.isIdentifier(varPath.node.id)) {
                throw varPath.buildCodeFrameError(
                  'Destructuring $state is not supported. Use a simple identifier.',
                )
              }
              stateVars.add(varPath.node.id.name)
              if (isInsideLoop(varPath) || isInsideConditional(varPath)) {
                throw varPath.buildCodeFrameError(
                  '$state() cannot be declared inside loops or conditionals',
                )
              }
              if (isInsideNestedFunction(varPath)) {
                throw varPath.buildCodeFrameError(
                  '$state() cannot be declared inside nested functions',
                )
              }
            } else if (t.isIdentifier(varPath.node.id)) {
              // Check if this is a derived value (const declaration depending on state)
              const parentDecl = varPath.parentPath.node as BabelCore.types.VariableDeclaration
              if (parentDecl.kind === 'const') {
                let dependsOnState = false
                varPath.get('init').traverse({
                  Identifier(idPath: BabelCore.NodePath<BabelCore.types.Identifier>) {
                    if (stateVars.has(idPath.node.name)) {
                      dependsOnState = true
                      idPath.stop()
                    }
                  },
                })
                if (dependsOnState) {
                  derivedVars.add(varPath.node.id.name)
                }
              }
            } else if (
              (t.isObjectPattern(varPath.node.id) || t.isArrayPattern(varPath.node.id)) &&
              t.isIdentifier(init) &&
              stateVars.has(init.name)
            ) {
              collectPatternIdentifiers(varPath.node.id).forEach(id => destructuredAliases.add(id))
            }
          },
          CallExpression(callPath) {
            if (isStateCall(callPath.node, t)) {
              if (isInsideLoop(callPath) || isInsideConditional(callPath)) {
                throw callPath.buildCodeFrameError(
                  '$state() cannot be declared inside loops or conditionals',
                )
              }
              if (isInsideNestedFunction(callPath)) {
                throw callPath.buildCodeFrameError(
                  '$state() cannot be declared inside nested functions',
                )
              }
            }
            if (isEffectCall(callPath.node, t)) {
              // Check if $effect is imported from fict
              if (!fictImports.has('$effect')) {
                throw callPath.buildCodeFrameError('$effect() must be imported from "fict"')
              }
              if (isInsideLoop(callPath) || isInsideConditional(callPath)) {
                throw callPath.buildCodeFrameError(
                  '$effect() cannot be called inside loops or conditionals',
                )
              }
              if (isInsideNestedFunction(callPath)) {
                throw callPath.buildCodeFrameError(
                  '$effect() cannot be called inside nested functions',
                )
              }
            }
          },
        })

        // Validate derived variable reassignments
        if (derivedVars.size > 0) {
          path.traverse({
            AssignmentExpression(assignPath) {
              const { left } = assignPath.node
              if (t.isIdentifier(left) && derivedVars.has(left.name)) {
                throw assignPath.buildCodeFrameError(
                  `Cannot reassign derived value '${left.name}'. Derived values are read-only.`,
                )
              }
            },
          })
        }

        // Disallow writes to destructured state aliases
        if (destructuredAliases.size > 0) {
          path.traverse({
            AssignmentExpression(assignPath) {
              const { left } = assignPath.node
              if (t.isIdentifier(left) && destructuredAliases.has(left.name)) {
                throw assignPath.buildCodeFrameError(
                  `Cannot write to destructured state alias '${left.name}'. Update the original state (e.g. state.count++ or immutable update).`,
                )
              }
            },
            UpdateExpression(updatePath) {
              const arg = updatePath.node.argument
              if (t.isIdentifier(arg) && destructuredAliases.has(arg.name)) {
                throw updatePath.buildCodeFrameError(
                  `Cannot write to destructured state alias '${arg.name}'. Update the original state (e.g. state.count++ or immutable update).`,
                )
              }
            },
          })
        }

        // Emit conservative warnings for mutation/dynamic access
        runWarningPass(path as any, stateVars, derivedVars, options, t)

        const fileAst = t.file(path.node)
        const hir = buildHIR(fileAst)
        const lowered = lowerHIRWithRegions(hir, t, options)

        path.node.body = lowered.program.body
        path.node.directives = lowered.program.directives

        path.scope.crawl()
        stripMacroImports(path as any, t)
      },
    },
  }
}

export const createFictPlugin = declare(
  (api, options: FictCompilerOptions = {}): BabelCore.PluginObj => {
    api.assertVersion(7)
    const t = api.types as typeof BabelCore.types

    return {
      name: 'fict-compiler-hir',
      visitor: createHIREntrypointVisitor(t, options),
    }
  },
)

export default createFictPlugin
