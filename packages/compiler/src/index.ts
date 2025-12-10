import type * as BabelCore from '@babel/core'
import { declare } from '@babel/helper-plugin-utils'

import {
  RUNTIME_MODULE,
  RUNTIME_HELPERS,
  RUNTIME_ALIASES,
  NON_REACTIVE_ATTRS,
  SAFE_FUNCTIONS,
} from './constants'
import {
  normalizeAttributeName,
  getIntrinsicTagName,
  createConstDeclaration,
  createAppendStatement,
  createElementCall,
  createTextNodeCall,
  createBindTextCall,
  createBindAttributeCall,
  createBindClassCall,
  createBindStyleCall,
  createBindEventCall,
} from './fine-grained-dom'
import {
  collectDerivedOutputsFromStatements,
  findNextRegion,
  collectOutputsInOrder,
  generateRegionMemo,
} from './rule-d'
import type { TransformContext, FictCompilerOptions, HelperUsage } from './types'
import { createHelperUsage } from './types'
import {
  isStateCall,
  isEffectCall,
  isTracked,
  isTrackedAndNotShadowed,
  createGetterCall,
  toBinaryOperator,
  dependsOnTracked,
  collectBindingNames,
  isEventHandler,
  emitWarning,
  getRootIdentifier,
  isTrackedRoot,
  isDynamicElementAccess,
} from './utils'

export type { FictCompilerOptions, CompilerWarning } from './types'

// ============================================================================
// Main Plugin
// ============================================================================

export function createFictPlugin(options: FictCompilerOptions = {}): BabelCore.PluginObj {
  const mergedOptions: FictCompilerOptions = {
    fineGrainedDom: true,
    ...options,
  }

  return declare(api => {
    api.assertVersion(7)
    const t = api.types as typeof BabelCore.types

    return {
      name: 'fict-compiler',
      visitor: {
        Program: {
          enter(path, state) {
            const file = state.file

            // Phase 1: Analyze macro imports
            const macroInfo = analyzeMacroImports(path, t)

            // Phase 2: Collect all $state variables
            const stateVars = new Set<string>()
            collectStateVariables(path, stateVars, t)

            // Phase 3: Create transform context
            const ctx: TransformContext = {
              stateVars,
              memoVars: new Set(),
              guardedDerived: new Set(),
              aliasVars: new Set(),
              getterOnlyVars: new Set(),
              shadowedVars: new Set(),
              helpersUsed: createHelperUsage(),
              options: mergedOptions,
              dependencyGraph: new Map(),
              derivedDecls: new Map(),
              hasStateImport: macroInfo.hasStateImport,
              hasEffectImport: macroInfo.hasEffectImport,
              exportedNames: collectExportedNames(path, t),
              fineGrainedTemplateId: 0,
              file,
            }

            // Phase 4: Pre-analysis - collect derived variables
            const derivedVars = collectDerivedOutputs(path, ctx, t)
            derivedVars.forEach(v => ctx.memoVars.add(v))

            // Phase 5: Build dependency graph for cycle detection (after memoVars are collected)
            buildDependencyGraph(path, ctx, t)

            // Store context in state for use by other visitors
            ;(state as any).__fictCtx = ctx
          },
          exit(path, state) {
            const ctx = (state as any).__fictCtx as TransformContext
            if (!ctx) return

            applyRegionTransform(path, ctx, t)

            // Detect derived cycles before finishing
            detectDerivedCycles(ctx, t)

            // Add runtime imports
            addRuntimeImports(path, ctx.helpersUsed, t)

            // Strip macro imports
            stripMacroImports(path, t)
          },
        },

        // Handle $state declarations
        VariableDeclaration(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          for (const declarator of path.node.declarations) {
            if (!declarator.init) continue

            // Check for $state() call
            if (isStateCall(declarator.init, t)) {
              if (!t.isIdentifier(declarator.id)) {
                throw path.buildCodeFrameError(
                  'Destructuring $state is not supported. Use a simple identifier.',
                )
              }

              // Validate placement
              ensureValidStatePlacement(path, ctx, t)

              // Transform: let x = $state(init) -> let x = __fictSignal(init)
              ctx.helpersUsed.signal = true
              declarator.init = t.callExpression(
                t.identifier(RUNTIME_ALIASES.signal),
                declarator.init.arguments,
              )
            }
            // Check for alias of state variable
            else if (
              t.isIdentifier(declarator.id) &&
              t.isIdentifier(declarator.init) &&
              ctx.stateVars.has(declarator.init.name) &&
              !ctx.shadowedVars.has(declarator.init.name) &&
              !isInsideLoop(path) &&
              !isInsideConditional(path)
            ) {
              const aliasName = declarator.id.name
              const stateName = declarator.init.name

              // Transform: const alias = count -> const alias = () => count()
              declarator.init = t.arrowFunctionExpression([], createGetterCall(t, stateName))

              ctx.getterOnlyVars.add(aliasName)
              ctx.aliasVars.add(aliasName)
            }
            // Check for derived value (depends on state)
            else if (
              t.isIdentifier(declarator.id) &&
              path.node.kind === 'const' &&
              !t.isArrowFunctionExpression(declarator.init) &&
              !t.isFunctionExpression(declarator.init) &&
              dependsOnTracked(declarator.init, ctx, t)
            ) {
              const name = declarator.id.name

              ctx.memoVars.add(name)
              ctx.guardedDerived.add(name)
              ctx.helpersUsed.memo = true

              // Transform: const x = expr -> const x = __fictMemo(() => expr)
              const transformedInit = transformExpression(declarator.init, ctx, t)
              declarator.init = t.callExpression(t.identifier(RUNTIME_ALIASES.memo), [
                t.arrowFunctionExpression([], transformedInit),
              ])
            }
          }
        },

        // Handle $effect calls
        CallExpression(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          // Rule H: Check for black-box function calls
          checkBlackBoxFunctionCall(path.node, ctx, t)

          if (isEffectCall(path.node, t)) {
            ensureValidEffectPlacement(path, ctx, t)
            ctx.helpersUsed.effect = true

            // Transform: $effect(fn) -> __fictEffect(fn)
            const transformedArgs = path.node.arguments.map(arg =>
              t.isExpression(arg) ? transformExpression(arg, ctx, t) : arg,
            )

            path.replaceWith(
              t.callExpression(
                t.identifier(RUNTIME_ALIASES.effect),
                transformedArgs as BabelCore.types.Expression[],
              ),
            )
          }
        },

        // Handle identifier references (state/memo variable reads)
        Identifier(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          const name = path.node.name

          // Check if identifier is shadowed by enclosing function parameters or local variables
          if (isShadowedByEnclosingScope(path, name, t)) {
            return
          }

          // Check for getterOnlyVars too
          const isGetterOnly = ctx.getterOnlyVars.has(name) && !ctx.shadowedVars.has(name)

          // Skip if not tracked or shadowed
          if (
            !isGetterOnly &&
            !isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)
          ) {
            return
          }

          // Skip if shouldn't be transformed
          if (!shouldTransformIdentifier(path, t)) {
            return
          }

          // Transform to getter call
          path.replaceWith(createGetterCall(t, name))
          path.skip() // Prevent infinite recursion
        },

        // Handle assignments to state variables
        AssignmentExpression(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          // Handle property mutations
          if (
            t.isMemberExpression(path.node.left) ||
            t.isOptionalMemberExpression(path.node.left)
          ) {
            const root = getRootIdentifier(path.node.left, t)
            if (root && ctx.stateVars.has(root.name) && !ctx.shadowedVars.has(root.name)) {
              emitWarning(
                ctx,
                path.node,
                'FICT-M',
                'Direct mutation of nested property will not trigger updates; use an immutable update or $store().',
              )
            }
            return
          }

          if (!t.isIdentifier(path.node.left)) return

          const name = path.node.left.name

          // Check for alias reassignment
          if (ctx.aliasVars.has(name) && !ctx.shadowedVars.has(name)) {
            throw path.buildCodeFrameError(
              'Aliasing $state values must remain getters; reassignment is not supported',
            )
          }

          // Check for derived reassignment
          if (ctx.guardedDerived.has(name) && !ctx.shadowedVars.has(name)) {
            throw path.buildCodeFrameError(`Cannot reassign derived value "${name}"`)
          }

          if (!isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)) {
            return
          }

          // Only state vars can be assigned
          if (!ctx.stateVars.has(name)) {
            if (ctx.memoVars.has(name)) {
              throw path.buildCodeFrameError(`Cannot reassign derived value "${name}"`)
            }
            return
          }

          const operator = path.node.operator

          if (operator === '=') {
            // count = 5 -> count(5)
            path.replaceWith(t.callExpression(t.identifier(name), [path.node.right]))
            path.skip()
          } else {
            // count += 1 -> count(count() + 1)
            const binaryOp = toBinaryOperator(operator)
            if (binaryOp) {
              path.replaceWith(
                t.callExpression(t.identifier(name), [
                  t.binaryExpression(binaryOp, createGetterCall(t, name), path.node.right),
                ]),
              )
              path.skip()
            }
          }
        },

        // Handle ++ and -- operators
        UpdateExpression(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          // Handle property mutations
          if (
            t.isMemberExpression(path.node.argument) ||
            t.isOptionalMemberExpression(path.node.argument)
          ) {
            const root = getRootIdentifier(path.node.argument, t)
            if (root && ctx.stateVars.has(root.name) && !ctx.shadowedVars.has(root.name)) {
              emitWarning(
                ctx,
                path.node,
                'FICT-M',
                'Direct mutation of nested property will not trigger updates; use an immutable update or $store().',
              )
            }
            return
          }

          if (!t.isIdentifier(path.node.argument)) return

          const name = path.node.argument.name
          if (!isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)) {
            return
          }

          // count++ -> count(count() + 1)
          const delta = path.node.operator === '++' ? 1 : -1
          path.replaceWith(
            t.callExpression(t.identifier(name), [
              t.binaryExpression(
                delta > 0 ? '+' : '-',
                createGetterCall(t, name),
                t.numericLiteral(1),
              ),
            ]),
          )
          path.skip()
        },

        BlockStatement: {
          exit(path, state) {
            const ctx = (state as any).__fictCtx as TransformContext
            if (!ctx) return
            applyRegionTransform(path, ctx, t)
          },
        },

        JSXElement(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          const lowered = transformFineGrainedJsx(path.node, ctx, t)
          if (lowered) {
            path.replaceWith(lowered)
            path.skip()
          }
        },

        // Handle JSX expressions
        JSXExpressionContainer(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          const expr = path.node.expression
          if (t.isJSXEmptyExpression(expr)) return

          // Check if parent is an attribute
          const parentAttr = path.findParent(p => p.isJSXAttribute())
          if (parentAttr && t.isJSXAttribute(parentAttr.node)) {
            const attrName = t.isJSXIdentifier(parentAttr.node.name)
              ? parentAttr.node.name.name
              : ''

            // Skip non-reactive attributes
            if (NON_REACTIVE_ATTRS.has(attrName)) {
              return
            }

            // Skip event handlers (already functions)
            if (isEventHandler(attrName)) {
              return
            }

            // Wrap reactive attribute value in arrow function
            if (dependsOnTracked(expr, ctx, t)) {
              path.node.expression = t.arrowFunctionExpression(
                [],
                transformExpression(expr, ctx, t),
              )
            }
            return
          }

          // JSX child expression
          if (dependsOnTracked(expr, ctx, t)) {
            const transformedExpr = transformExpression(expr, ctx, t)

            // Check for conditional (ternary or &&)
            if (t.isConditionalExpression(expr) || t.isLogicalExpression(expr)) {
              const binding = createConditionalBinding(transformedExpr, ctx, t)
              if (binding) {
                path.node.expression = binding
                return
              }
            }

            // Check for array.map (list rendering)
            if (t.isCallExpression(expr) && t.isMemberExpression(expr.callee)) {
              const prop = expr.callee.property
              if (t.isIdentifier(prop) && prop.name === 'map') {
                const binding = createListBinding(transformedExpr, expr, ctx, t)
                if (binding) {
                  path.node.expression = binding
                  return
                }
              }
            }

            // Default: wrap in insert binding
            ctx.helpersUsed.insert = true
            ctx.helpersUsed.onDestroy = true
            path.node.expression = createInsertBinding(transformedExpr, ctx, t)
          }
        },

        // Handle shorthand properties
        ObjectProperty(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          if (!path.node.shorthand) return
          if (!t.isIdentifier(path.node.key)) return

          const name = path.node.key.name

          // Check for getterOnlyVars too
          const isGetterOnly = ctx.getterOnlyVars.has(name) && !ctx.shadowedVars.has(name)

          if (
            !isGetterOnly &&
            !isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)
          ) {
            return
          }

          // { count } -> { count: count() }
          path.node.shorthand = false
          path.node.value = createGetterCall(t, name)
        },

        // Handle MemberExpression with dynamic access (array[index])
        MemberExpression(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          const object = path.node.object
          const property = path.node.property

          // Check for dynamic property access warning (FICT-H)
          // Only warn for read access (not write access which is handled elsewhere)
          if (
            path.node.computed &&
            t.isExpression(object) &&
            isDynamicElementAccess(path.node, t) &&
            isTrackedRoot(object, ctx, t)
          ) {
            // Check if this is a write context (left side of assignment)
            const parent = path.parent
            const isWriteContext =
              (t.isAssignmentExpression(parent) && parent.left === path.node) ||
              (t.isUpdateExpression(parent) && parent.argument === path.node)

            if (!isWriteContext) {
              emitWarning(
                ctx,
                path.node,
                'FICT-H',
                'Dynamic property access widens dependency tracking scope.',
              )
            }
          }

          // Only handle computed access like arr[index]
          if (!path.node.computed) return

          // Check if the object is a tracked variable
          if (t.isIdentifier(object)) {
            const name = object.name
            if (
              isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars) ||
              (ctx.getterOnlyVars.has(name) && !ctx.shadowedVars.has(name))
            ) {
              // Transform arr[index] -> arr()[index]
              path.node.object = createGetterCall(t, name)
            }
          }

          // Transform dynamic property if it depends on tracked
          if (t.isExpression(property) && dependsOnTracked(property, ctx, t)) {
            path.node.property = transformExpression(property, ctx, t)
          }
        },

        // Handle function declarations/expressions (Rule E + optional getter caching)
        Function: {
          enter(path: BabelCore.NodePath<BabelCore.types.Function>, state) {
            const ctx = (state as any).__fictCtx as TransformContext
            if (!ctx) return

            if (
              !(
                path.isFunctionDeclaration() ||
                path.isFunctionExpression() ||
                path.isArrowFunctionExpression()
              )
            ) {
              return
            }

            const containsJsx = functionContainsJsx(path.node, t)
            if (containsJsx) {
              const params = path.node.params
              if (params.length > 0) {
                const firstParam = params[0]
                if (t.isObjectPattern(firstParam) || t.isArrayPattern(firstParam)) {
                  const plan = buildPropsDestructurePlan(firstParam, ctx, t)
                  if (plan) {
                    params[0] = plan.aliasParam
                    const body = path.node.body
                    if (t.isBlockStatement(body)) {
                      body.body.unshift(...plan.prologue)
                    } else {
                      path.node.body = t.blockStatement([...plan.prologue, t.returnStatement(body)])
                    }
                    plan.trackedNames.forEach(name => {
                      ctx.memoVars.add(name)
                      ctx.getterOnlyVars.add(name)
                    })
                  }
                }
              }
            }
          },
          exit(path: BabelCore.NodePath<BabelCore.types.Function>, state) {
            const ctx = (state as any).__fictCtx as TransformContext
            if (!ctx) return
            maybeApplyGetterCaching(path, ctx, t)
          },
        },
      },
    }
  }) as unknown as BabelCore.PluginObj
}

// ============================================================================
// Helper Functions
// ============================================================================

function analyzeMacroImports(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  t: typeof BabelCore.types,
): { hasStateImport: boolean; hasEffectImport: boolean } {
  let hasStateImport = false
  let hasEffectImport = false

  path.traverse({
    ImportDeclaration(importPath) {
      if (importPath.node.source.value !== 'fict') return

      for (const spec of importPath.node.specifiers) {
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported)) {
          if (spec.imported.name === '$state') hasStateImport = true
          if (spec.imported.name === '$effect') hasEffectImport = true
        }
      }
    },
  })

  return { hasStateImport, hasEffectImport }
}

function collectStateVariables(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  stateVars: Set<string>,
  t: typeof BabelCore.types,
): void {
  path.traverse({
    VariableDeclarator(declPath) {
      if (!declPath.node.init) return
      if (!isStateCall(declPath.node.init, t)) return

      if (t.isIdentifier(declPath.node.id)) {
        stateVars.add(declPath.node.id.name)
      }
    },
  })
}

function maybeApplyGetterCaching(
  path: BabelCore.NodePath<BabelCore.types.Function>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  if (!ctx.options.getterCache) return
  if (
    !(
      path.isFunctionDeclaration() ||
      path.isFunctionExpression() ||
      path.isArrowFunctionExpression()
    )
  ) {
    return
  }
  const bodyPath = path.get('body') as
    | BabelCore.NodePath<BabelCore.types.BlockStatement | BabelCore.types.Expression>
    | BabelCore.NodePath[]
  if (Array.isArray(bodyPath)) return

  const tracked = new Set<string>([...ctx.getterOnlyVars, ...ctx.stateVars, ...ctx.memoVars])

  const ensureBlock = (): BabelCore.NodePath<BabelCore.types.BlockStatement> => {
    if (bodyPath.isBlockStatement()) return bodyPath
    const expr = bodyPath.node as BabelCore.types.Expression
    const transformedExpr = transformExpression(expr, ctx, t)
    const block = t.blockStatement([t.returnStatement(transformedExpr)])
    bodyPath.replaceWith(block)
    return bodyPath as BabelCore.NodePath<BabelCore.types.BlockStatement>
  }

  const blockPath = ensureBlock()
  const counts = new Map<string, number>()

  blockPath.traverse({
    Function(inner) {
      inner.skip()
    },
    CallExpression(callPath) {
      const callee = callPath.get('callee')
      if (!callee.isIdentifier()) return
      if (callPath.node.arguments.length > 0) return
      if (!tracked.has(callee.node.name)) return
      counts.set(callee.node.name, (counts.get(callee.node.name) ?? 0) + 1)
    },
  })

  const toCache = Array.from(counts.entries()).filter(([, count]) => count > 1)
  if (!toCache.length) return

  const cacheDecls = toCache.map(([name]) =>
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier(`__cached_${name}`),
        t.callExpression(t.identifier(name), []),
      ),
    ]),
  )

  blockPath.unshiftContainer('body', cacheDecls)

  blockPath.traverse({
    Function(inner) {
      inner.skip()
    },
    CallExpression(callPath) {
      const callee = callPath.get('callee')
      if (!callee.isIdentifier()) return
      if (callPath.node.arguments.length > 0) return
      const name = callee.node.name
      if (!tracked.has(name)) return
      callPath.replaceWith(t.identifier(`__cached_${name}`))
    },
  })
}

function collectExportedNames(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  t: typeof BabelCore.types,
): Set<string> {
  const names = new Set<string>()

  path.traverse({
    ExportNamedDeclaration(exportPath) {
      const decl = exportPath.node.declaration
      if (t.isVariableDeclaration(decl)) {
        for (const d of decl.declarations) {
          if (t.isIdentifier(d.id)) {
            names.add(d.id.name)
          }
        }
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        names.add(decl.id.name)
      }
    },
  })

  return names
}

function collectDerivedOutputs(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): Set<string> {
  const derived = new Set<string>()

  // Collect all const declarations with their initializers
  const constDecls: { name: string; init: BabelCore.types.Expression }[] = []

  path.traverse({
    VariableDeclarator(declPath) {
      if (!declPath.node.init) return

      const parent = declPath.parentPath
      if (!parent || !t.isVariableDeclaration(parent.node)) return
      if (parent.node.kind !== 'const') return

      if (!t.isIdentifier(declPath.node.id)) return

      // Skip function initializers
      if (
        t.isArrowFunctionExpression(declPath.node.init) ||
        t.isFunctionExpression(declPath.node.init)
      ) {
        return
      }

      constDecls.push({
        name: declPath.node.id.name,
        init: declPath.node.init,
      })
    },
  })

  // Fixed-point iteration to find all derived variables
  // This handles cases where a depends on b, and b depends on c, etc.
  let changed = true
  while (changed) {
    changed = false
    for (const decl of constDecls) {
      if (derived.has(decl.name)) continue

      // Check if depends on tracked (state or already-found derived)
      if (dependsOnTracked(decl.init, ctx, t, derived)) {
        derived.add(decl.name)
        changed = true
      }
    }
  }

  return derived
}

function transformExpression(
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  // Simple recursive transformation of identifiers to getter calls
  if (t.isIdentifier(expr)) {
    if (
      isTrackedAndNotShadowed(expr.name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars) ||
      (ctx.getterOnlyVars.has(expr.name) && !ctx.shadowedVars.has(expr.name))
    ) {
      return createGetterCall(t, expr.name)
    }
    return expr
  }

  if (t.isBinaryExpression(expr)) {
    const left = t.isPrivateName(expr.left) ? expr.left : transformExpression(expr.left, ctx, t)
    return t.binaryExpression(
      expr.operator,
      left as BabelCore.types.Expression,
      transformExpression(expr.right, ctx, t),
    )
  }

  if (t.isUnaryExpression(expr)) {
    return t.unaryExpression(expr.operator, transformExpression(expr.argument, ctx, t), expr.prefix)
  }

  if (t.isConditionalExpression(expr)) {
    return t.conditionalExpression(
      transformExpression(expr.test, ctx, t),
      transformExpression(expr.consequent, ctx, t),
      transformExpression(expr.alternate, ctx, t),
    )
  }

  if (t.isLogicalExpression(expr)) {
    return t.logicalExpression(
      expr.operator,
      transformExpression(expr.left, ctx, t),
      transformExpression(expr.right, ctx, t),
    )
  }

  if (t.isMemberExpression(expr)) {
    const transformedObject = transformExpression(expr.object as BabelCore.types.Expression, ctx, t)
    const transformedProperty =
      expr.computed && t.isExpression(expr.property)
        ? transformExpression(expr.property, ctx, t)
        : expr.property
    return t.memberExpression(transformedObject, transformedProperty, expr.computed)
  }

  if (t.isOptionalMemberExpression(expr)) {
    const transformedObject = transformExpression(expr.object as BabelCore.types.Expression, ctx, t)
    const transformedProperty =
      expr.computed && t.isExpression(expr.property)
        ? transformExpression(expr.property, ctx, t)
        : expr.property
    return t.optionalMemberExpression(
      transformedObject,
      transformedProperty,
      expr.computed,
      expr.optional,
    )
  }

  if (t.isCallExpression(expr)) {
    return t.callExpression(
      t.isExpression(expr.callee) ? transformExpression(expr.callee, ctx, t) : expr.callee,
      expr.arguments.map(arg =>
        t.isExpression(arg) ? transformExpression(arg, ctx, t) : arg,
      ) as BabelCore.types.Expression[],
    )
  }

  if (t.isOptionalCallExpression(expr)) {
    return t.optionalCallExpression(
      t.isExpression(expr.callee) ? transformExpression(expr.callee, ctx, t) : expr.callee,
      expr.arguments.map(arg => (t.isExpression(arg) ? transformExpression(arg, ctx, t) : arg)),
      expr.optional,
    )
  }

  if (t.isArrayExpression(expr)) {
    return t.arrayExpression(
      expr.elements.map(el => (el && t.isExpression(el) ? transformExpression(el, ctx, t) : el)),
    )
  }

  if (t.isObjectExpression(expr)) {
    return t.objectExpression(
      expr.properties.map(prop => {
        if (t.isObjectProperty(prop) && t.isExpression(prop.value)) {
          return t.objectProperty(
            prop.key,
            transformExpression(prop.value, ctx, t),
            prop.computed,
            prop.shorthand,
          )
        }
        return prop
      }),
    )
  }

  if (t.isTemplateLiteral(expr)) {
    return t.templateLiteral(
      expr.quasis,
      expr.expressions.map(e => (t.isExpression(e) ? transformExpression(e, ctx, t) : e)),
    )
  }

  if (t.isTSAsExpression(expr) && t.isExpression(expr.expression)) {
    return t.tsAsExpression(transformExpression(expr.expression, ctx, t), expr.typeAnnotation)
  }

  if (t.isTSTypeAssertion(expr) && t.isExpression(expr.expression)) {
    return t.tsTypeAssertion(expr.typeAnnotation, transformExpression(expr.expression, ctx, t))
  }

  if (t.isTSNonNullExpression(expr) && t.isExpression(expr.expression)) {
    return t.tsNonNullExpression(transformExpression(expr.expression, ctx, t))
  }

  if (t.isArrowFunctionExpression(expr)) {
    // Handle shadowing inside arrow functions
    const shadowedNames = new Set<string>()
    for (const param of expr.params) {
      collectBindingNames(param, shadowedNames, t)
    }

    const originalShadowed = new Set(ctx.shadowedVars)
    shadowedNames.forEach(n => ctx.shadowedVars.add(n))

    let newBody: BabelCore.types.BlockStatement | BabelCore.types.Expression
    if (t.isExpression(expr.body)) {
      newBody = transformExpression(expr.body, ctx, t)
    } else {
      // Block body - would need full statement transformation
      newBody = expr.body
    }

    ctx.shadowedVars = originalShadowed as Set<string>

    return t.arrowFunctionExpression(expr.params, newBody, expr.async)
  }

  return expr
}

function createConditionalBinding(
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Expression | null {
  ctx.helpersUsed.conditional = true
  ctx.helpersUsed.createElement = true
  ctx.helpersUsed.onDestroy = true

  const bindingId = t.identifier(`__fictBinding_${++ctx.fineGrainedTemplateId}`)

  let conditionExpr: BabelCore.types.Expression
  let trueBranch: BabelCore.types.Expression
  let falseBranch: BabelCore.types.Expression | null = null

  if (t.isConditionalExpression(expr)) {
    conditionExpr = expr.test
    trueBranch = expr.consequent
    falseBranch = expr.alternate
  } else if (t.isLogicalExpression(expr) && expr.operator === '&&') {
    conditionExpr = expr.left
    trueBranch = expr.right
  } else {
    return null
  }

  // Build: __fictConditional(() => cond, () => trueBranch, __fictCreateElement, () => falseBranch?)
  const args: BabelCore.types.Expression[] = [
    t.arrowFunctionExpression([], conditionExpr),
    t.arrowFunctionExpression([], trueBranch),
    t.identifier(RUNTIME_ALIASES.createElement),
  ]

  if (falseBranch) {
    args.push(t.arrowFunctionExpression([], falseBranch))
  }

  const conditionalCall = t.callExpression(t.identifier(RUNTIME_ALIASES.conditional), args)

  // Wrap in IIFE that registers cleanup
  return t.callExpression(
    t.arrowFunctionExpression(
      [],
      t.blockStatement([
        t.variableDeclaration('const', [t.variableDeclarator(bindingId, conditionalCall)]),
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
            t.memberExpression(bindingId, t.identifier('dispose')),
          ]),
        ),
        t.returnStatement(t.memberExpression(bindingId, t.identifier('marker'))),
      ]),
    ),
    [],
  )
}

function createListBinding(
  transformedExpr: BabelCore.types.Expression,
  originalExpr: BabelCore.types.CallExpression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Expression | null {
  if (!t.isMemberExpression(originalExpr.callee)) return null

  const arrayExpr = originalExpr.callee.object
  if (!t.isExpression(arrayExpr)) return null

  const mapCallback = originalExpr.arguments[0]
  if (
    !mapCallback ||
    (!t.isArrowFunctionExpression(mapCallback) && !t.isFunctionExpression(mapCallback))
  ) {
    return null
  }

  // Check for key attribute in the returned JSX
  let keyExpr: BabelCore.types.Expression | null = null
  const callbackBody = mapCallback.body

  if (t.isJSXElement(callbackBody)) {
    keyExpr = extractKeyAttribute(callbackBody, t)
  } else if (t.isBlockStatement(callbackBody)) {
    // Look for return statement with JSX
    for (const stmt of callbackBody.body) {
      if (t.isReturnStatement(stmt) && stmt.argument && t.isJSXElement(stmt.argument)) {
        keyExpr = extractKeyAttribute(stmt.argument, t)
        break
      }
    }
  }

  const isKeyed = keyExpr !== null
  const helperName = isKeyed ? 'keyedList' : 'list'
  ctx.helpersUsed[helperName] = true
  ctx.helpersUsed.onDestroy = true
  ctx.helpersUsed.toNodeArray = true
  ctx.helpersUsed.createElement = true

  const bindingId = t.identifier(`__fictBinding_${++ctx.fineGrainedTemplateId}`)

  // Get transformed array expression
  const transformedArray =
    t.isCallExpression(transformedExpr) && t.isMemberExpression(transformedExpr.callee)
      ? (transformedExpr.callee.object as BabelCore.types.Expression)
      : transformExpression(arrayExpr as BabelCore.types.Expression, ctx, t)

  // Build key extractor if keyed
  let keyExtractor: BabelCore.types.Expression | undefined
  if (isKeyed && keyExpr) {
    const itemParam = mapCallback.params[0] || t.identifier('item')
    const indexParam = mapCallback.params[1] || t.identifier('_index')
    keyExtractor = t.arrowFunctionExpression([itemParam, indexParam], keyExpr)
  }

  // Build renderer
  const itemSignalId = t.identifier('__fictItemSig')
  const indexSignalId = t.identifier('__fictIndexSig')

  // Get the callback's body (transformed)
  let renderedBody: BabelCore.types.Expression | BabelCore.types.BlockStatement
  if (t.isCallExpression(transformedExpr)) {
    const transformedCallback = transformedExpr.arguments[0]
    if (
      t.isArrowFunctionExpression(transformedCallback) ||
      t.isFunctionExpression(transformedCallback)
    ) {
      renderedBody = t.isExpression(transformedCallback.body)
        ? transformedCallback.body
        : transformedCallback.body
    } else {
      renderedBody = t.isExpression(mapCallback.body)
        ? transformExpression(mapCallback.body, ctx, t)
        : mapCallback.body
    }
  } else {
    renderedBody = t.isExpression(mapCallback.body)
      ? transformExpression(mapCallback.body, ctx, t)
      : mapCallback.body
  }

  const renderer = t.arrowFunctionExpression(
    [itemSignalId, indexSignalId],
    t.blockStatement([
      t.returnStatement(
        t.callExpression(t.identifier(RUNTIME_ALIASES.toNodeArray), [
          t.callExpression(t.identifier(RUNTIME_ALIASES.createElement), [
            t.arrowFunctionExpression(
              mapCallback.params,
              t.isExpression(renderedBody) ? renderedBody : t.blockStatement([]),
            ),
            t.callExpression(itemSignalId, []),
          ]),
        ]),
      ),
    ]),
  )

  // Build list call
  const listArgs: BabelCore.types.Expression[] = [t.arrowFunctionExpression([], transformedArray)]

  if (isKeyed && keyExtractor) {
    listArgs.push(keyExtractor)
  }

  listArgs.push(renderer)

  const listCall = t.callExpression(
    t.identifier(isKeyed ? RUNTIME_ALIASES.keyedList : RUNTIME_ALIASES.list),
    listArgs,
  )

  // Wrap in IIFE
  return t.callExpression(
    t.arrowFunctionExpression(
      [],
      t.blockStatement([
        t.variableDeclaration('const', [t.variableDeclarator(bindingId, listCall)]),
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
            t.memberExpression(bindingId, t.identifier('dispose')),
          ]),
        ),
        t.returnStatement(t.memberExpression(bindingId, t.identifier('marker'))),
      ]),
    ),
    [],
  )
}

function extractKeyAttribute(
  element: BabelCore.types.JSXElement,
  t: typeof BabelCore.types,
): BabelCore.types.Expression | null {
  for (const attr of element.openingElement.attributes) {
    if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === 'key') {
      if (t.isJSXExpressionContainer(attr.value) && t.isExpression(attr.value.expression)) {
        return attr.value.expression
      }
    }
  }
  return null
}

function createInsertBinding(
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  ctx.helpersUsed.insert = true
  ctx.helpersUsed.onDestroy = true

  const bindingId = t.identifier(`__fictBinding_${++ctx.fineGrainedTemplateId}`)

  // Build: __fictInsert(() => expr)
  const insertCall = t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
    t.arrowFunctionExpression([], expr),
  ])

  // Wrap in IIFE
  return t.callExpression(
    t.arrowFunctionExpression(
      [],
      t.blockStatement([
        t.variableDeclaration('const', [t.variableDeclarator(bindingId, insertCall)]),
        t.expressionStatement(
          t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [
            t.memberExpression(bindingId, t.identifier('dispose')),
          ]),
        ),
        t.returnStatement(t.memberExpression(bindingId, t.identifier('marker'))),
      ]),
    ),
    [],
  )
}

function ensureValidStatePlacement(
  path: BabelCore.NodePath,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  // Check if inside loop or conditional
  let parent = path.parentPath
  while (parent) {
    if (
      t.isForStatement(parent.node) ||
      t.isForInStatement(parent.node) ||
      t.isForOfStatement(parent.node) ||
      t.isWhileStatement(parent.node) ||
      t.isDoWhileStatement(parent.node) ||
      t.isIfStatement(parent.node) ||
      t.isSwitchStatement(parent.node)
    ) {
      throw path.buildCodeFrameError('$state() cannot be declared inside loops or conditionals')
    }
    parent = parent.parentPath
  }
}

function ensureValidEffectPlacement(
  path: BabelCore.NodePath,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  let parent = path.parentPath
  while (parent) {
    if (
      t.isForStatement(parent.node) ||
      t.isForInStatement(parent.node) ||
      t.isForOfStatement(parent.node) ||
      t.isWhileStatement(parent.node) ||
      t.isDoWhileStatement(parent.node) ||
      t.isIfStatement(parent.node) ||
      t.isSwitchStatement(parent.node)
    ) {
      throw path.buildCodeFrameError('$effect() cannot be called inside loops or conditionals')
    }
    parent = parent.parentPath
  }
}

/**
 * Check if an identifier should be transformed to a getter call
 * Returns false for declarations, property names, type references, etc.
 */
function shouldTransformIdentifier(
  path: BabelCore.NodePath<BabelCore.types.Identifier>,
  t: typeof BabelCore.types,
): boolean {
  const parent = path.parent
  if (!parent) return false

  // Don't transform if this is the callee of a call expression
  if (t.isCallExpression(parent) && parent.callee === path.node) return false
  if (t.isNewExpression(parent) && parent.callee === path.node) return false

  // Don't transform declarations
  if (t.isVariableDeclarator(parent) && parent.id === path.node) return false
  if (t.isRestElement(parent) && parent.argument === path.node) return false
  if (t.isAssignmentPattern(parent) && parent.left === path.node) return false
  if (t.isFunctionDeclaration(parent) && parent.id === path.node) return false
  if (t.isFunctionExpression(parent) && parent.id === path.node) return false
  if (
    (t.isArrowFunctionExpression(parent) ||
      t.isFunctionExpression(parent) ||
      t.isFunctionDeclaration(parent)) &&
    parent.params.includes(path.node)
  ) {
    return false
  }

  // Don't transform imports/exports
  if (t.isImportSpecifier(parent) || t.isImportDefaultSpecifier(parent)) return false
  if (t.isExportSpecifier(parent)) return false

  // Don't transform property names in object literals/assignments
  if (t.isObjectProperty(parent) && parent.key === path.node && !parent.computed) return false
  if (t.isMemberExpression(parent) && parent.property === path.node && !parent.computed) {
    return false
  }
  if (t.isOptionalMemberExpression(parent) && parent.property === path.node && !parent.computed) {
    return false
  }

  // Don't transform JSX attribute names
  if (t.isJSXAttribute(parent) && t.isJSXIdentifier(path.node as any)) return false

  return true
}

/**
 * Check if an identifier is shadowed by an enclosing function parameter or local variable
 * This only checks for local shadowing WITHIN functions (not at program level)
 */
function isShadowedByEnclosingScope(
  path: BabelCore.NodePath<BabelCore.types.Identifier>,
  name: string,
  t: typeof BabelCore.types,
): boolean {
  let current: BabelCore.NodePath | null = path.parentPath
  let insideFunction = false

  while (current) {
    // Check function parameters
    if (
      current.isArrowFunctionExpression() ||
      current.isFunctionExpression() ||
      current.isFunctionDeclaration()
    ) {
      const funcNode = current.node as
        | BabelCore.types.ArrowFunctionExpression
        | BabelCore.types.FunctionExpression
        | BabelCore.types.FunctionDeclaration
      const paramNames = new Set<string>()
      for (const param of funcNode.params) {
        collectBindingNames(param, paramNames, t)
      }
      if (paramNames.has(name)) {
        return true
      }
      insideFunction = true
    }

    // Only check block-scoped variable declarations inside functions
    // (not at program level, those are handled by stateVars/memoVars tracking)
    if (insideFunction && current.isBlockStatement()) {
      const bodyNode = current.node as BabelCore.types.BlockStatement
      for (const stmt of bodyNode.body) {
        if (t.isVariableDeclaration(stmt)) {
          for (const decl of stmt.declarations) {
            const bindingNames = new Set<string>()
            collectBindingNames(decl.id, bindingNames, t)
            if (bindingNames.has(name)) {
              return true
            }
          }
        }
      }
    }

    // Stop at program level
    if (current.isProgram()) break

    current = current.parentPath
  }

  return false
}

/**
 * Detect whether a node is inside a loop statement
 */
function isInsideLoop(path: BabelCore.NodePath): boolean {
  let current: BabelCore.NodePath | null = path
  while (current) {
    if (
      current.isForStatement() ||
      current.isForInStatement() ||
      current.isForOfStatement() ||
      current.isWhileStatement() ||
      current.isDoWhileStatement()
    ) {
      return true
    }
    if (current.isFunction()) break
    if (current.isProgram()) break
    current = current.parentPath
  }
  return false
}

function isInsideConditional(path: BabelCore.NodePath): boolean {
  let current: BabelCore.NodePath | null = path
  while (current) {
    if (
      current.isIfStatement() ||
      current.isSwitchStatement() ||
      current.isConditionalExpression()
    ) {
      return true
    }
    if (current.isFunction()) break
    if (current.isProgram()) break
    current = current.parentPath
  }
  return false
}

/**
 * Rule H: Check for black-box function calls that receive state objects
 */
function checkBlackBoxFunctionCall(
  node: BabelCore.types.CallExpression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  const { stateVars, shadowedVars } = ctx

  // Skip if no arguments
  if (!node.arguments.length) return

  // Get the function name
  const funcName = getCallExpressionName(node.callee, t)

  // Skip known safe functions
  if (funcName && SAFE_FUNCTIONS.has(funcName)) return

  // Skip $effect, $state and other fict macros
  if (funcName && (funcName === '$effect' || funcName === '$state')) return

  // Check each argument
  for (const arg of node.arguments) {
    if (!t.isExpression(arg)) continue

    // Check if argument is a state variable identifier
    if (t.isIdentifier(arg) && stateVars.has(arg.name) && !shadowedVars.has(arg.name)) {
      emitWarning(
        ctx,
        node,
        'FICT-H',
        `State object "${arg.name}" passed to function "${funcName || '<anonymous>'}" ` +
          'is treated as a black box and may cause over-recomputation. ' +
          'Consider passing only the specific properties needed.',
      )
    }
  }
}

/**
 * Get the name of a function being called
 */
function getCallExpressionName(
  callee: BabelCore.types.Expression | BabelCore.types.V8IntrinsicIdentifier,
  t: typeof BabelCore.types,
): string | null {
  if (t.isIdentifier(callee)) {
    return callee.name
  }
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object) &&
    t.isIdentifier(callee.property)
  ) {
    return `${callee.object.name}.${callee.property.name}`
  }
  return null
}

/**
 * Build the dependency graph for all derived variables (for cycle detection)
 * This should be called after memoVars are collected
 */
function buildDependencyGraph(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  path.traverse({
    VariableDeclarator(declPath) {
      if (!declPath.node.init) return

      const parent = declPath.parentPath
      if (!parent || !t.isVariableDeclaration(parent.node)) return
      if (parent.node.kind !== 'const') return

      if (!t.isIdentifier(declPath.node.id)) return

      const name = declPath.node.id.name
      // Only process derived variables
      if (!ctx.memoVars.has(name)) return

      // Skip function initializers
      if (
        t.isArrowFunctionExpression(declPath.node.init) ||
        t.isFunctionExpression(declPath.node.init)
      ) {
        return
      }

      recordDerivedDependencies(name, declPath.node.init, ctx, t)
    },
  })
}

/**
 * Record derived dependencies for cycle detection
 */
function recordDerivedDependencies(
  name: string,
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  const deps = new Set<string>()

  const visit = (node: BabelCore.types.Node, locals: Set<string>): void => {
    // Special-case __fictMemo callbacks to capture dependencies
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee) &&
      node.callee.name === RUNTIME_ALIASES.memo
    ) {
      const fn = node.arguments[0]
      if (fn && (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn))) {
        if (t.isBlockStatement(fn.body)) {
          for (const stmt of fn.body.body) {
            if (t.isReturnStatement(stmt) && stmt.argument) {
              visit(stmt.argument, locals)
            }
          }
        } else {
          visit(fn.body, locals)
        }
      }
    }

    if (t.isIdentifier(node)) {
      if (!locals.has(node.name) && !ctx.shadowedVars.has(node.name)) {
        if (isTracked(node.name, ctx.stateVars, ctx.memoVars)) {
          deps.add(node.name)
        }
      }
      return
    }

    // Skip function bodies
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }

    // Handle variable declarations
    if (t.isVariableDeclaration(node)) {
      const newLocals = new Set(locals)
      for (const decl of node.declarations) {
        if (t.isIdentifier(decl.id)) {
          newLocals.add(decl.id.name)
        }
      }
      for (const decl of node.declarations) {
        if (decl.init) {
          visit(decl.init, newLocals)
        }
      }
      return
    }

    // Recurse into children
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node, locals)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type: unknown }).type === 'string'
      ) {
        visit(child as unknown as BabelCore.types.Node, locals)
      }
    }
  }

  visit(expr, new Set())

  ctx.dependencyGraph.set(name, deps)
  ctx.derivedDecls.set(name, expr)
}

/**
 * Detect cycles in derived dependencies
 */
function detectDerivedCycles(ctx: TransformContext, _t: typeof BabelCore.types): void {
  // Filter graph to only include derived-to-derived dependencies
  const filteredGraph = new Map<string, Set<string>>()
  ctx.dependencyGraph.forEach((deps, name) => {
    const filtered = new Set<string>()
    deps.forEach(dep => {
      if (ctx.dependencyGraph.has(dep)) {
        filtered.add(dep)
      }
    })
    filteredGraph.set(name, filtered)
  })

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const dfs = (name: string): void => {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      const cycleStart = stack.indexOf(name)
      const cyclePath = stack.slice(cycleStart).concat(name)
      throw new Error(`Detected cyclic derived dependency: ${cyclePath.join(' -> ')}`)
    }

    visiting.add(name)
    stack.push(name)
    const deps = filteredGraph.get(name)
    if (deps) {
      deps.forEach(dep => dfs(dep))
    }
    stack.pop()
    visiting.delete(name)
    visited.add(name)
  }

  filteredGraph.forEach((_deps, name) => {
    if (!visited.has(name)) dfs(name)
  })
}

function addRuntimeImports(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  helpers: HelperUsage,
  t: typeof BabelCore.types,
): void {
  const specifiers: BabelCore.types.ImportSpecifier[] = []

  const addHelper = (key: keyof HelperUsage) => {
    if (helpers[key]) {
      specifiers.push(
        t.importSpecifier(t.identifier(RUNTIME_ALIASES[key]), t.identifier(RUNTIME_HELPERS[key])),
      )
    }
  }

  addHelper('signal')
  addHelper('memo')
  addHelper('effect')
  addHelper('createElement')
  addHelper('conditional')
  addHelper('list')
  addHelper('keyedList')
  addHelper('insert')
  addHelper('onDestroy')
  addHelper('bindText')
  addHelper('bindAttribute')
  addHelper('bindClass')
  addHelper('bindStyle')
  addHelper('bindEvent')
  addHelper('toNodeArray')

  if (specifiers.length === 0) return

  const importDecl = t.importDeclaration(specifiers, t.stringLiteral(RUNTIME_MODULE))

  path.unshiftContainer('body', importDecl)
}

function stripMacroImports(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  t: typeof BabelCore.types,
): void {
  path.traverse({
    ImportDeclaration(importPath) {
      if (importPath.node.source.value !== 'fict') return

      const filteredSpecifiers = importPath.node.specifiers.filter(spec => {
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported)) {
          return !['$state', '$effect'].includes(spec.imported.name)
        }
        return true
      })

      if (filteredSpecifiers.length === 0) {
        importPath.remove()
      } else if (filteredSpecifiers.length !== importPath.node.specifiers.length) {
        importPath.node.specifiers = filteredSpecifiers
      }
    },
  })
}

// ============================================================================
// Fine-grained DOM Lowering (Rule L)
// ============================================================================

type IdentifierOverrideMap = Record<string, () => BabelCore.types.Expression>

interface TemplateBuilderState {
  ctx: TransformContext
  statements: BabelCore.types.Statement[]
  namePrefix: string
  nameCounters: Record<string, number>
  identifierOverrides?: IdentifierOverrideMap
}

function createTemplateNamePrefix(ctx: TransformContext): string {
  const id = ctx.fineGrainedTemplateId++
  return `__fg${id}`
}

function allocateTemplateIdentifier(
  state: TemplateBuilderState,
  t: typeof BabelCore.types,
  kind: string,
): BabelCore.types.Identifier {
  const index = state.nameCounters[kind] ?? 0
  state.nameCounters[kind] = index + 1
  return t.identifier(`${state.namePrefix}_${kind}${index}`)
}

function transformExpressionForFineGrained(
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
  _overrides?: IdentifierOverrideMap,
): BabelCore.types.Expression {
  // Reuse standard transform logic; override support can be added if needed
  return transformExpression(expr, ctx, t)
}

function emitBindingChild(
  parentId: BabelCore.types.Identifier,
  bindingExpr: BabelCore.types.Expression,
  state: TemplateBuilderState,
  t: typeof BabelCore.types,
): void {
  const markerId = allocateTemplateIdentifier(state, t, 'frag')
  state.statements.push(createConstDeclaration(t, markerId, bindingExpr))
  state.statements.push(createAppendStatement(t, parentId, markerId))
}

function emitDynamicTextChild(
  parentId: BabelCore.types.Identifier,
  expr: BabelCore.types.Expression,
  state: TemplateBuilderState,
  t: typeof BabelCore.types,
): void {
  const textId = allocateTemplateIdentifier(state, t, 'txt')
  const textNode = createTextNodeCall(t, '')
  state.statements.push(createConstDeclaration(t, textId, textNode))
  state.statements.push(createAppendStatement(t, parentId, textId))
  state.statements.push(createBindTextCall(t, textId, expr, state.ctx))
}

function emitAttributes(
  elementId: BabelCore.types.Identifier,
  attributes: (BabelCore.types.JSXAttribute | BabelCore.types.JSXSpreadAttribute)[],
  state: TemplateBuilderState,
  t: typeof BabelCore.types,
): boolean {
  for (const attr of attributes) {
    if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) {
      return false
    }

    const normalized = normalizeAttributeName(attr.name.name)
    if (!normalized) {
      return false
    }

    if (normalized.kind === 'skip') {
      continue
    }

    if (normalized.kind === 'event') {
      if (!attr.value || !t.isJSXExpressionContainer(attr.value) || !attr.value.expression) {
        return false
      }
      const expr = transformExpressionForFineGrained(
        attr.value.expression as BabelCore.types.Expression,
        state.ctx,
        t,
        state.identifierOverrides,
      )
      state.statements.push(
        createBindEventCall(t, elementId, normalized.eventName!, expr, normalized, state.ctx),
      )
      continue
    }

    if (!attr.value) {
      state.statements.push(
        createBindAttributeCall(t, elementId, normalized.name, t.stringLiteral(''), state.ctx),
      )
      continue
    }

    if (t.isStringLiteral(attr.value)) {
      // Static attribute
      if (normalized.kind === 'class') {
        state.statements.push(
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(elementId, t.identifier('className')),
              attr.value,
            ),
          ),
        )
      } else {
        state.statements.push(
          t.expressionStatement(
            t.callExpression(t.memberExpression(elementId, t.identifier('setAttribute')), [
              t.stringLiteral(normalized.name),
              attr.value,
            ]),
          ),
        )
      }
      continue
    }

    if (t.isJSXExpressionContainer(attr.value) && attr.value.expression) {
      const expr = transformExpressionForFineGrained(
        attr.value.expression as BabelCore.types.Expression,
        state.ctx,
        t,
        state.identifierOverrides,
      )

      if (normalized.kind === 'class') {
        state.statements.push(createBindClassCall(t, elementId, expr, state.ctx))
        continue
      }
      if (normalized.kind === 'style') {
        state.statements.push(createBindStyleCall(t, elementId, expr, state.ctx))
        continue
      }

      state.statements.push(createBindAttributeCall(t, elementId, normalized.name, expr, state.ctx))
      continue
    }

    return false
  }

  return true
}

function emitChildren(
  parentId: BabelCore.types.Identifier,
  children: (
    | BabelCore.types.JSXElement
    | BabelCore.types.JSXFragment
    | BabelCore.types.JSXText
    | BabelCore.types.JSXExpressionContainer
    | BabelCore.types.JSXSpreadChild
  )[],
  state: TemplateBuilderState,
  t: typeof BabelCore.types,
): boolean {
  for (const child of children) {
    if (t.isJSXSpreadChild(child)) {
      // Spread children are not supported in fine-grained mode
      return false
    }

    if (t.isJSXFragment(child)) {
      if (!emitChildren(parentId, child.children, state, t)) return false
      continue
    }

    if (t.isJSXText(child)) {
      const text = child.value
      if (!text.trim()) continue
      const textId = allocateTemplateIdentifier(state, t, 'txt')
      const textNode = createTextNodeCall(t, text)
      state.statements.push(createConstDeclaration(t, textId, textNode))
      state.statements.push(createAppendStatement(t, parentId, textId))
      continue
    }

    if (t.isJSXExpressionContainer(child)) {
      if (!child.expression || t.isJSXEmptyExpression(child.expression)) continue

      if (t.isJSXElement(child.expression)) {
        return false
      }

      if (t.isJSXFragment(child.expression)) {
        if (!emitChildren(parentId, child.expression.children, state, t)) return false
        continue
      }

      const transformedExpr = transformExpressionForFineGrained(
        child.expression as BabelCore.types.Expression,
        state.ctx,
        t,
        state.identifierOverrides,
      )

      const conditionalBinding = createConditionalBinding(transformedExpr, state.ctx, t)
      if (conditionalBinding) {
        emitBindingChild(parentId, conditionalBinding, state, t)
        continue
      }

      if (t.isCallExpression(child.expression) && t.isMemberExpression(child.expression.callee)) {
        const prop = child.expression.callee.property
        if (t.isIdentifier(prop) && prop.name === 'map') {
          const listBinding = createListBinding(transformedExpr, child.expression, state.ctx, t)
          if (listBinding) {
            emitBindingChild(parentId, listBinding, state, t)
            continue
          }
        }
      }

      emitDynamicTextChild(parentId, transformedExpr, state, t)
      continue
    }

    if (t.isJSXElement(child)) {
      const tagName = getIntrinsicTagName(child, t)
      if (!tagName) return false
      const childId = emitJsxElementToTemplate(child, tagName, state, t)
      if (!childId) return false
      state.statements.push(createAppendStatement(t, parentId, childId))
      continue
    }

    return false
  }

  return true
}

function emitJsxElementToTemplate(
  node: BabelCore.types.JSXElement,
  tagName: string,
  state: TemplateBuilderState,
  t: typeof BabelCore.types,
): BabelCore.types.Identifier | null {
  const elementId = allocateTemplateIdentifier(state, t, 'el')
  const createEl = createElementCall(t, tagName)
  state.statements.push(createConstDeclaration(t, elementId, createEl))

  const attributes = node.openingElement.attributes

  if (!emitAttributes(elementId, attributes, state, t)) {
    return null
  }

  if (!emitChildren(elementId, node.children, state, t)) {
    return null
  }

  return elementId
}

function transformFineGrainedJsx(
  node: BabelCore.types.JSXElement,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Expression | null {
  if (!ctx.options.fineGrainedDom) return null

  const tagName = getIntrinsicTagName(node, t)
  if (!tagName) return null

  const state: TemplateBuilderState = {
    ctx,
    statements: [],
    namePrefix: createTemplateNamePrefix(ctx),
    nameCounters: Object.create(null),
  }

  const rootId = emitJsxElementToTemplate(node, tagName, state, t)
  if (!rootId) return null

  state.statements.push(t.returnStatement(rootId))

  return t.callExpression(t.arrowFunctionExpression([], t.blockStatement(state.statements)), [])
}

// ============================================================================
// Props Destructuring (Rule E)
// ============================================================================

interface PropsDestructurePlan {
  aliasParam: BabelCore.types.Identifier
  prologue: BabelCore.types.Statement[]
  trackedNames: string[]
}

/**
 * Check if a function contains JSX elements
 */
function functionContainsJsx(
  node:
    | BabelCore.types.FunctionDeclaration
    | BabelCore.types.FunctionExpression
    | BabelCore.types.ArrowFunctionExpression,
  t: typeof BabelCore.types,
): boolean {
  let hasJsx = false

  const visit = (n: BabelCore.types.Node): void => {
    if (hasJsx) return

    if (t.isJSXElement(n) || t.isJSXFragment(n)) {
      hasJsx = true
      return
    }

    // Don't descend into nested functions
    if (t.isArrowFunctionExpression(n) || t.isFunctionExpression(n) || t.isFunctionDeclaration(n)) {
      // Only check if it's the same function
      if (n !== node) return
    }

    for (const key of Object.keys(n) as (keyof typeof n)[]) {
      const child = n[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (
            c &&
            typeof c === 'object' &&
            'type' in c &&
            typeof (c as { type: unknown }).type === 'string'
          ) {
            visit(c as unknown as BabelCore.types.Node)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type: unknown }).type === 'string'
      ) {
        visit(child as unknown as BabelCore.types.Node)
      }
    }
  }

  visit(node.body)
  return hasJsx
}

/**
 * Build a plan for transforming props destructuring to reactive getters
 */
function buildPropsDestructurePlan(
  param: BabelCore.types.ObjectPattern | BabelCore.types.ArrayPattern,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): PropsDestructurePlan | null {
  const aliasParam = t.identifier(`__props${ctx.fineGrainedTemplateId++}`)
  const prologue: BabelCore.types.Statement[] = []
  const trackedNames: string[] = []

  const emitGetter = (
    id: BabelCore.types.Identifier,
    accessExpr: BabelCore.types.Expression,
    defaultValue?: BabelCore.types.Expression,
  ) => {
    const tmpId = t.identifier(`__fictProp${ctx.fineGrainedTemplateId++}`)

    let returnExpr: BabelCore.types.Expression = tmpId
    if (defaultValue) {
      returnExpr = t.conditionalExpression(
        t.binaryExpression('===', tmpId, t.identifier('undefined')),
        defaultValue,
        tmpId,
      )
    }

    const getter = t.arrowFunctionExpression(
      [],
      t.blockStatement([
        t.variableDeclaration('const', [t.variableDeclarator(tmpId, accessExpr)]),
        t.returnStatement(returnExpr),
      ]),
    )

    prologue.push(t.variableDeclaration('const', [t.variableDeclarator(id, getter)]))
    trackedNames.push(id.name)
  }

  const visitBinding = (
    pattern: BabelCore.types.LVal,
    baseExpr: BabelCore.types.Expression,
  ): void => {
    if (t.isIdentifier(pattern)) {
      emitGetter(pattern, baseExpr)
      return
    }

    if (t.isObjectPattern(pattern)) {
      for (const prop of pattern.properties) {
        if (t.isRestElement(prop)) {
          // Rest element - emit warning and fallback to non-reactive
          emitWarning(
            ctx,
            prop,
            'FICT-E',
            'Object rest in props destructuring falls back to non-reactive binding.',
          )
          prologue.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(t.objectPattern([prop]), baseExpr),
            ]),
          )
          continue
        }

        if (!t.isObjectProperty(prop)) continue

        const key = prop.key
        let accessExpr: BabelCore.types.Expression

        if (t.isIdentifier(key)) {
          accessExpr = t.memberExpression(baseExpr, key)
        } else if (t.isStringLiteral(key)) {
          accessExpr = t.memberExpression(baseExpr, key, true)
        } else if (t.isNumericLiteral(key)) {
          accessExpr = t.memberExpression(baseExpr, key, true)
        } else {
          continue
        }

        const value = prop.value

        if (t.isAssignmentPattern(value)) {
          // Has default value
          if (t.isIdentifier(value.left)) {
            emitGetter(value.left, accessExpr, value.right)
          } else if (t.isObjectPattern(value.left) || t.isArrayPattern(value.left)) {
            // Nested pattern with default
            const combinedExpr = t.conditionalExpression(
              t.binaryExpression('===', accessExpr, t.identifier('undefined')),
              value.right,
              accessExpr,
            )
            visitBinding(value.left, combinedExpr)
          }
        } else if (t.isIdentifier(value)) {
          emitGetter(value, accessExpr)
        } else if (t.isObjectPattern(value) || t.isArrayPattern(value)) {
          visitBinding(value, accessExpr)
        }
      }
      return
    }

    if (t.isArrayPattern(pattern)) {
      pattern.elements.forEach((element, index) => {
        if (!element) return

        const accessExpr = t.memberExpression(baseExpr, t.numericLiteral(index), true)

        if (t.isRestElement(element)) {
          emitWarning(
            ctx,
            element,
            'FICT-E',
            'Array rest in props destructuring falls back to non-reactive binding.',
          )
          prologue.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(t.arrayPattern([element]), baseExpr),
            ]),
          )
          return
        }

        if (t.isAssignmentPattern(element)) {
          if (t.isIdentifier(element.left)) {
            emitGetter(element.left, accessExpr, element.right)
          } else if (t.isObjectPattern(element.left) || t.isArrayPattern(element.left)) {
            const combinedExpr = t.conditionalExpression(
              t.binaryExpression('===', accessExpr, t.identifier('undefined')),
              element.right,
              accessExpr,
            )
            visitBinding(element.left, combinedExpr)
          }
        } else if (t.isIdentifier(element)) {
          emitGetter(element, accessExpr)
        } else if (t.isObjectPattern(element) || t.isArrayPattern(element)) {
          visitBinding(element, accessExpr)
        }
      })
    }
  }

  visitBinding(param, aliasParam)

  if (prologue.length === 0) return null

  return {
    aliasParam,
    prologue,
    trackedNames,
  }
}

function applyRegionTransform(
  path:
    | BabelCore.NodePath<BabelCore.types.Program>
    | BabelCore.NodePath<BabelCore.types.BlockStatement>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  const statements = (path.node as BabelCore.types.Program | BabelCore.types.BlockStatement).body
  if (!Array.isArray(statements) || statements.length === 0) return

  const derivedOutputs = collectDerivedOutputsFromStatements(
    statements as BabelCore.types.Statement[],
    ctx,
    t,
  )
  if (derivedOutputs.size < 2) return

  const result: BabelCore.types.Statement[] = []
  let index = 0
  let changed = false

  while (index < statements.length) {
    const region = findNextRegion(
      statements as BabelCore.types.Statement[],
      derivedOutputs,
      ctx,
      t,
      index,
    )

    if (!region) {
      result.push(statements[index] as BabelCore.types.Statement)
      index++
      continue
    }

    const { start, end, outputs } = region
    for (let i = index; i < start; i++) {
      result.push(statements[i] as BabelCore.types.Statement)
    }

    const regionStatements = (statements as BabelCore.types.Statement[]).slice(start, end + 1)
    const orderedOutputs = collectOutputsInOrder(regionStatements, outputs, t)
    const { memoDecl, getterDecls } = generateRegionMemo(
      regionStatements,
      orderedOutputs.length ? orderedOutputs : Array.from(outputs),
      ctx,
      t,
      regionStatements,
    )

    result.push(memoDecl, ...getterDecls)
    index = end + 1
    changed = true
  }

  if (changed) {
    ;(path.node as any).body = result
  }
}

// ============================================================================
// Exports
// ============================================================================

export default createFictPlugin
