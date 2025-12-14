import type * as BabelCore from '@babel/core'
import { declare } from '@babel/helper-plugin-utils'
import traverse, { type NodePath as TraverseNodePath } from '@babel/traverse'

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
  createBindPropertyCall,
  createBindClassCall,
  createBindStyleCall,
  createBindEventCall,
  createApplyRefStatements,
} from './fine-grained-dom'
import {
  collectDerivedOutputsFromStatements,
  findNextRegion,
  collectOutputsInOrder,
  generateRegionMemo,
  statementTouchesOutputs,
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
  detectNoMemoDirective,
  isInNoMemoScope,
} from './utils'

export type { FictCompilerOptions, CompilerWarning } from './types'

// ============================================================================
// Main Plugin
// ============================================================================

export const createFictPlugin = declare(
  (api, options: FictCompilerOptions = {}): BabelCore.PluginObj => {
    api.assertVersion(7)
    const t = api.types as typeof BabelCore.types

    const mergedOptions: FictCompilerOptions = {
      fineGrainedDom: true,
      ...options,
    }

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
              noMemo: false,
              noMemoFunctions: new WeakSet(),
            }

            if (detectNoMemoDirective(path, t)) {
              ctx.noMemo = true
              ctx.options = { ...ctx.options, fineGrainedDom: false }
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
          const inNoMemo = isInNoMemoScope(path, ctx)

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
            // Skip alias transformation inside $effect callbacks - they should capture values
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

              // Inside $effect - skip memoization, just transform to getter call
              if (isInsideEffectCallback(path, t)) {
                declarator.init = createGetterCall(t, stateName)
              } else {
                // Transform: const alias = count -> const alias = () => count()
                declarator.init = t.arrowFunctionExpression([], createGetterCall(t, stateName))

                ctx.getterOnlyVars.add(aliasName)
                ctx.aliasVars.add(aliasName)
              }
            }
            // Check for derived value (depends on state)
            // Skip memoization inside $effect callbacks - they should capture values, not create getters
            else if (
              t.isIdentifier(declarator.id) &&
              path.node.kind === 'const' &&
              !t.isArrowFunctionExpression(declarator.init) &&
              !t.isFunctionExpression(declarator.init) &&
              dependsOnTracked(declarator.init, ctx, t)
            ) {
              const name = declarator.id.name
              // Check if inside effect callback
              const isInEffect = isInsideEffectCallback(path, t)

              if (isInEffect) {
                // Inside $effect - skip memoization, just transform the initializer to capture value
                declarator.init = transformExpression(declarator.init, ctx, t)
              } else if (!inNoMemo) {
                // Outside $effect - memoize as usual
                ctx.memoVars.add(name)
                ctx.guardedDerived.add(name)
                const transformedInit = transformExpression(declarator.init, ctx, t)

                const isModuleScope = path.parentPath?.isProgram?.() ?? false
                const isExported = ctx.exportedNames.has(name)
                const useGetterOnly =
                  !ctx.options.lazyConditional &&
                  !isModuleScope &&
                  !isExported &&
                  shouldEmitGetter(name, ctx, t)

                if (useGetterOnly) {
                  ctx.getterOnlyVars.add(name)
                  declarator.init = t.arrowFunctionExpression([], transformedInit)
                } else {
                  ctx.helpersUsed.memo = true
                  declarator.init = t.callExpression(t.identifier(RUNTIME_ALIASES.memo), [
                    t.arrowFunctionExpression([], transformedInit),
                  ])
                }
              } else {
                // No-memo scope: still transform expressions ($state reads/writes) but don't memoize
                declarator.init = transformExpression(declarator.init, ctx, t)
              }
            }
          }
        },

        // Handle $effect and $state calls
        CallExpression(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          // Rule H: Check for black-box function calls
          checkBlackBoxFunctionCall(path.node, ctx, t)

          // Validate $state() placement when used in assignments like: x = $state(0)
          // This catches cases where $state is called but not in a variable declaration
          if (isStateCall(path.node, t)) {
            // Check if this is NOT inside a variable declaration (already handled there)
            const variableDeclarator = path.findParent(p => p.isVariableDeclarator())
            if (!variableDeclarator) {
              // This is a $state() call in an assignment expression or other context
              ensureValidStatePlacement(path, ctx, t)
            }
          }

          if (isEffectCall(path.node, t)) {
            ensureValidEffectPlacement(path, ctx, t)
            ctx.helpersUsed.effect = true

            // Transform: $effect(fn) -> __fictEffect(fn)
            // Note: We don't call transformExpression on the callback here.
            // The callback's variable declarations will be processed by the VariableDeclaration visitor,
            // which skips memoization for declarations inside $effect (isInsideEffectCallback check).
            // The normal Babel visitor traversal will handle identifier transformations.
            path.node.callee = t.identifier(RUNTIME_ALIASES.effect)
          }
        },

        // Handle identifier references (state/memo variable reads)
        Identifier(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return

          const name = path.node.name

          // Check if identifier is shadowed by enclosing function parameters or local variables
          if (isShadowedByEnclosingScope(path, name, ctx)) {
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

          if (
            isGetterOnly &&
            isInsideNestedFunction(path) &&
            !ctx.options.getterCache &&
            !ctx.aliasVars.has(name)
          ) {
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
          // Transform the right-hand side to convert any state variable references
          const transformedRight = transformExpression(path.node.right, ctx, t)

          if (operator === '=') {
            // count = count + 1 -> count(count() + 1)
            path.replaceWith(t.callExpression(t.identifier(name), [transformedRight]))
            path.skip()
          } else {
            // count += 1 -> count(count() + 1)
            const binaryOp = toBinaryOperator(operator)
            if (binaryOp) {
              path.replaceWith(
                t.callExpression(t.identifier(name), [
                  t.binaryExpression(binaryOp, createGetterCall(t, name), transformedRight),
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
            const parent = path.parentPath
            if (
              parent &&
              (parent.isIfStatement() ||
                parent.isForStatement() ||
                parent.isForInStatement() ||
                parent.isForOfStatement() ||
                parent.isWhileStatement() ||
                parent.isDoWhileStatement() ||
                parent.isSwitchStatement() ||
                parent.isSwitchCase())
            ) {
              return
            }
            applyRegionTransform(path, ctx, t)
          },
        },

        JSXElement(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return
          if (isInNoMemoScope(path, ctx)) return

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

          // Skip destructuring patterns - only transform object literal shorthand
          const parent = path.parent
          if (t.isObjectPattern(parent)) {
            return
          }

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

            if (t.isBlockStatement(path.node.body)) {
              const bodyPath = path.get('body')
              if (
                !Array.isArray(bodyPath) &&
                detectNoMemoDirective(
                  bodyPath as BabelCore.NodePath<BabelCore.types.BlockStatement>,
                  t,
                )
              ) {
                ctx.noMemoFunctions.add(path.node as BabelCore.types.Function)
              }
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
  },
) as unknown as BabelCore.PluginObj

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a path is inside a $effect callback.
 * Variable declarations inside $effect should NOT be memoized - they should capture values.
 */
function isInsideEffectCallback(path: BabelCore.NodePath, t: typeof BabelCore.types): boolean {
  let current = path.parentPath
  while (current) {
    // Check if we're inside a function that is an argument to $effect/__fictEffect
    if (
      (current.isArrowFunctionExpression() || current.isFunctionExpression()) &&
      current.parentPath?.isCallExpression()
    ) {
      const callNode = current.parentPath.node
      // Check for both original $effect and transformed __fictEffect names
      if (t.isCallExpression(callNode) && t.isIdentifier(callNode.callee)) {
        const calleeName = callNode.callee.name
        if (calleeName === '$effect' || calleeName === RUNTIME_ALIASES.effect) {
          return true
        }
      }
    }
    current = current.parentPath
  }
  return false
}

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

  const getterNames = new Set<string>([...ctx.getterOnlyVars, ...ctx.stateVars])
  if (!getterNames.size) return

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
      const name = callee.node.name
      if (!getterNames.has(name)) return
      const targetBinding = blockPath.scope.getBinding(name)
      const binding = callPath.scope.getBinding(name)
      if (!targetBinding || binding !== targetBinding) return
      counts.set(name, (counts.get(name) ?? 0) + 1)
    },
  })

  const cacheIds = new Map<string, BabelCore.types.Identifier>()
  counts.forEach((count, name) => {
    if (count > 1) {
      cacheIds.set(name, t.identifier(`__cached_${name}`))
    }
  })

  if (!cacheIds.size) return

  blockPath.traverse({
    Function(inner) {
      inner.skip()
    },
    CallExpression(callPath) {
      const callee = callPath.get('callee')
      if (!callee.isIdentifier()) return
      if (callPath.node.arguments.length > 0) return
      const name = callee.node.name
      const cacheId = cacheIds.get(name)
      if (!cacheId) return
      const targetBinding = blockPath.scope.getBinding(name)
      const binding = callPath.scope.getBinding(name)
      if (!targetBinding || binding !== targetBinding) return
      callPath.replaceWith(t.identifier(cacheId.name))
    },
  })

  const cacheDecls = Array.from(cacheIds.entries()).map(([name, cacheId]) =>
    t.variableDeclaration('const', [
      t.variableDeclarator(cacheId, t.callExpression(t.identifier(name), [])),
    ]),
  )

  blockPath.unshiftContainer('body', cacheDecls)
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
  if (ctx.noMemo) return new Set()
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

      // Skip declarations inside $effect callbacks - they should capture values, not become getters
      if (isInsideEffectCallback(declPath, t)) {
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

/**
 * Transform statements inside a block body (for arrow functions with block bodies)
 */
function transformBlockStatement(
  block: BabelCore.types.BlockStatement,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.BlockStatement {
  const newBody = block.body.map(stmt => transformStatement(stmt, ctx, t))
  return t.blockStatement(newBody)
}

/**
 * Transform a single statement, handling ExpressionStatements and other common patterns
 */
function transformStatement(
  stmt: BabelCore.types.Statement,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Statement {
  if (t.isExpressionStatement(stmt)) {
    return t.expressionStatement(transformExpression(stmt.expression, ctx, t))
  }

  if (t.isReturnStatement(stmt) && stmt.argument) {
    return t.returnStatement(transformExpression(stmt.argument, ctx, t))
  }

  if (t.isIfStatement(stmt)) {
    return t.ifStatement(
      transformExpression(stmt.test, ctx, t),
      t.isBlockStatement(stmt.consequent)
        ? transformBlockStatement(stmt.consequent, ctx, t)
        : transformStatement(stmt.consequent, ctx, t),
      stmt.alternate
        ? t.isBlockStatement(stmt.alternate)
          ? transformBlockStatement(stmt.alternate, ctx, t)
          : transformStatement(stmt.alternate, ctx, t)
        : null,
    )
  }

  if (t.isVariableDeclaration(stmt)) {
    return t.variableDeclaration(
      stmt.kind,
      stmt.declarations.map(decl => {
        if (decl.init) {
          return t.variableDeclarator(decl.id, transformExpression(decl.init, ctx, t))
        }
        return decl
      }),
    )
  }

  // For other statements, return as-is (could be extended as needed)
  return stmt
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

  if (t.isSequenceExpression(expr)) {
    return t.sequenceExpression(expr.expressions.map(e => transformExpression(e, ctx, t)))
  }

  // Preserve parentheses when parser emits them (prevents traversal gaps for inserted nodes)
  if (t.isParenthesizedExpression(expr)) {
    return t.parenthesizedExpression(transformExpression(expr.expression, ctx, t))
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
    const shouldSkipCalleeTransform =
      t.isIdentifier(expr.callee) &&
      (isTrackedAndNotShadowed(expr.callee.name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars) ||
        (ctx.getterOnlyVars.has(expr.callee.name) && !ctx.shadowedVars.has(expr.callee.name)))

    return t.callExpression(
      t.isExpression(expr.callee) && !shouldSkipCalleeTransform
        ? transformExpression(expr.callee, ctx, t)
        : expr.callee,
      expr.arguments.map(arg => {
        if (t.isSpreadElement(arg)) {
          return t.spreadElement(transformExpression(arg.argument, ctx, t))
        }
        return t.isExpression(arg) ? transformExpression(arg, ctx, t) : arg
      }) as any,
    )
  }

  if (t.isOptionalCallExpression(expr)) {
    const shouldSkipCalleeTransform =
      t.isIdentifier(expr.callee) &&
      (isTrackedAndNotShadowed(expr.callee.name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars) ||
        (ctx.getterOnlyVars.has(expr.callee.name) && !ctx.shadowedVars.has(expr.callee.name)))

    return t.optionalCallExpression(
      t.isExpression(expr.callee) && !shouldSkipCalleeTransform
        ? transformExpression(expr.callee, ctx, t)
        : expr.callee,
      expr.arguments.map(arg => {
        if (t.isSpreadElement(arg)) {
          return t.spreadElement(transformExpression(arg.argument, ctx, t))
        }
        return t.isExpression(arg) ? transformExpression(arg, ctx, t) : arg
      }) as any,
      expr.optional,
    )
  }

  if (t.isNewExpression(expr)) {
    const shouldSkipCalleeTransform =
      t.isIdentifier(expr.callee) &&
      (isTrackedAndNotShadowed(expr.callee.name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars) ||
        (ctx.getterOnlyVars.has(expr.callee.name) && !ctx.shadowedVars.has(expr.callee.name)))

    return t.newExpression(
      t.isExpression(expr.callee) && !shouldSkipCalleeTransform
        ? transformExpression(expr.callee, ctx, t)
        : expr.callee,
      expr.arguments?.map(arg => {
        if (t.isSpreadElement(arg)) {
          return t.spreadElement(transformExpression(arg.argument, ctx, t))
        }
        return t.isExpression(arg) ? transformExpression(arg, ctx, t) : arg
      }) as any,
    )
  }

  if (t.isArrayExpression(expr)) {
    return t.arrayExpression(
      expr.elements.map(el => {
        if (!el) return el
        if (t.isSpreadElement(el)) {
          return t.spreadElement(transformExpression(el.argument, ctx, t))
        }
        return t.isExpression(el) ? transformExpression(el, ctx, t) : el
      }),
    )
  }

  if (t.isObjectExpression(expr)) {
    return t.objectExpression(
      expr.properties.map(prop => {
        if (t.isSpreadElement(prop)) {
          return t.spreadElement(transformExpression(prop.argument, ctx, t))
        }

        if (t.isObjectProperty(prop) && t.isExpression(prop.value)) {
          const transformedKey =
            prop.computed && t.isExpression(prop.key)
              ? transformExpression(prop.key, ctx, t)
              : prop.key
          const transformedValue = transformExpression(prop.value, ctx, t)
          const shorthand =
            prop.shorthand && t.isIdentifier(transformedValue) ? prop.shorthand : false

          return t.objectProperty(transformedKey, transformedValue, prop.computed, shorthand)
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
      if (t.isConditionalExpression(newBody) || t.isLogicalExpression(newBody)) {
        newBody = t.parenthesizedExpression(newBody)
      }
    } else {
      // Block body - transform statements inside the block
      newBody = transformBlockStatement(expr.body, ctx, t)
    }

    ctx.shadowedVars = originalShadowed as Set<string>

    return t.arrowFunctionExpression(expr.params, newBody, expr.async)
  }

  // Handle UpdateExpression (count++, count--)
  if (t.isUpdateExpression(expr)) {
    if (t.isIdentifier(expr.argument)) {
      const name = expr.argument.name
      if (isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)) {
        // Only state vars can be updated
        if (ctx.stateVars.has(name)) {
          // count++ -> count(count() + 1)
          // count-- -> count(count() - 1)
          const delta = expr.operator === '++' ? 1 : -1
          return t.callExpression(t.identifier(name), [
            t.binaryExpression(
              delta > 0 ? '+' : '-',
              createGetterCall(t, name),
              t.numericLiteral(1),
            ),
          ])
        }
      }
      return expr
    }

    // Still transform nested reads like arr[index]++ where index is tracked.
    return t.updateExpression(
      expr.operator,
      (t.isExpression(expr.argument)
        ? (transformExpression(expr.argument, ctx, t) as any)
        : expr.argument) as any,
      expr.prefix,
    )
  }

  // Handle AssignmentExpression (count = value, count += value)
  if (t.isAssignmentExpression(expr)) {
    if (t.isIdentifier(expr.left)) {
      const name = expr.left.name
      if (isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)) {
        // Only state vars can be assigned
        if (ctx.stateVars.has(name)) {
          const operator = expr.operator
          const transformedRight = transformExpression(expr.right, ctx, t)

          if (operator === '=') {
            // count = 5 -> count(5)
            return t.callExpression(t.identifier(name), [transformedRight])
          } else {
            // count += 1 -> count(count() + 1)
            const binaryOp = toBinaryOperator(operator)
            if (binaryOp) {
              return t.callExpression(t.identifier(name), [
                t.binaryExpression(binaryOp, createGetterCall(t, name), transformedRight),
              ])
            }
          }
        }
      }
      // Not a state assignment target; keep LHS as-is.
      return t.assignmentExpression(
        expr.operator,
        expr.left,
        transformExpression(expr.right, ctx, t),
      )
    }

    const transformedRight = transformExpression(expr.right, ctx, t)
    const transformedLeft =
      !t.isIdentifier(expr.left) && t.isExpression(expr.left)
        ? (transformExpression(expr.left, ctx, t) as any)
        : expr.left

    return t.assignmentExpression(expr.operator, transformedLeft as any, transformedRight)
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

  // Transform JSX branches if in fine-grained mode
  // This handles intrinsic elements (like <p>, <div>) by lowering them to DOM API calls
  if (ctx.options.fineGrainedDom && t.isJSXElement(trueBranch)) {
    const lowered = transformFineGrainedJsx(trueBranch, ctx, t)
    if (lowered) {
      trueBranch = lowered
    }
  }
  if (ctx.options.fineGrainedDom && falseBranch && t.isJSXElement(falseBranch)) {
    const lowered = transformFineGrainedJsx(falseBranch, ctx, t)
    if (lowered) {
      falseBranch = lowered
    }
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
  if (!isKeyed) {
    ctx.helpersUsed.list = true
  }
  ctx.helpersUsed.onDestroy = true
  ctx.helpersUsed.toNodeArray = true
  ctx.helpersUsed.createElement = true
  if (isKeyed) {
    ctx.helpersUsed.createKeyedListContainer = true
    ctx.helpersUsed.createKeyedBlock = true
    ctx.helpersUsed.moveMarkerBlock = true
    ctx.helpersUsed.destroyMarkerBlock = true
    ctx.helpersUsed.getFirstNodeAfter = true
    ctx.helpersUsed.effect = true
  }

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
  const itemParam = mapCallback.params[0]
  const indexParam = mapCallback.params[1]
  const fineGrainedRenderer =
    isKeyed &&
    t.isArrowFunctionExpression(mapCallback) &&
    itemParam &&
    t.isIdentifier(itemParam) &&
    (!indexParam || t.isIdentifier(indexParam))
      ? maybeCreateFineGrainedKeyedRenderer(
          mapCallback,
          mapCallback,
          itemParam,
          t.isIdentifier(indexParam) ? indexParam : undefined,
          ctx,
          t,
        )
      : null

  let _renderedBody: BabelCore.types.Expression | BabelCore.types.BlockStatement
  if (fineGrainedRenderer) {
    _renderedBody = fineGrainedRenderer
  } else if (t.isCallExpression(transformedExpr)) {
    const transformedCallback = transformedExpr.arguments[0]
    if (
      t.isArrowFunctionExpression(transformedCallback) ||
      t.isFunctionExpression(transformedCallback)
    ) {
      _renderedBody = t.isExpression(transformedCallback.body)
        ? transformedCallback.body
        : transformedCallback.body
    } else {
      _renderedBody = t.isExpression(mapCallback.body)
        ? transformExpression(mapCallback.body, ctx, t)
        : mapCallback.body
    }
  } else {
    _renderedBody = t.isExpression(mapCallback.body)
      ? transformExpression(mapCallback.body, ctx, t)
      : mapCallback.body
  }

  // Build the call arguments for invoking the render arrow with signal values
  const callArgs: BabelCore.types.Expression[] = []
  if (mapCallback.params.length > 0) {
    callArgs.push(t.callExpression(itemSignalId, [])) // __fictItemSig()
    if (mapCallback.params.length > 1) {
      callArgs.push(t.callExpression(indexSignalId, [])) // __fictIndexSig()
    }
  }

  // Get the original render arrow (not transformed) for invocation
  const originalRenderArrow = mapCallback

  const renderer = fineGrainedRenderer
    ? fineGrainedRenderer
    : t.arrowFunctionExpression(
        [itemSignalId, indexSignalId],
        t.blockStatement([
          t.returnStatement(
            t.callExpression(t.identifier(RUNTIME_ALIASES.toNodeArray), [
              t.callExpression(t.identifier(RUNTIME_ALIASES.createElement), [
                // Call the original render arrow with signal values: renderArrow(__fictItemSig(), __fictIndexSig())
                t.callExpression(originalRenderArrow, callArgs),
              ]),
            ]),
          ),
        ]),
      )

  if (isKeyed) {
    const getItemsId = t.identifier(`${bindingId.name}_items`)
    const keyFnId = t.identifier(`${bindingId.name}_key`)
    const containerId = t.identifier(`${bindingId.name}_container`)
    const markerId = t.identifier(`${bindingId.name}_marker`)
    const pendingId = t.identifier(`${bindingId.name}_pending`)
    const disposedId = t.identifier(`${bindingId.name}_disposed`)
    const destroyBlockId = t.identifier(`${bindingId.name}_destroyBlock`)
    const diffId = t.identifier(`${bindingId.name}_diff`)
    const disposeId = t.identifier(`${bindingId.name}_dispose`)

    const getItemsDecl = t.variableDeclaration('const', [
      t.variableDeclarator(getItemsId, t.arrowFunctionExpression([], transformedArray)),
    ])

    const keyFnDecl = t.variableDeclaration('const', [
      t.variableDeclarator(keyFnId, keyExtractor ?? t.arrowFunctionExpression([], t.nullLiteral())),
    ])

    const containerDecl = t.variableDeclaration('const', [
      t.variableDeclarator(
        containerId,
        t.callExpression(t.identifier(RUNTIME_ALIASES.createKeyedListContainer), []),
      ),
    ])

    const markerDecl = t.variableDeclaration('const', [
      t.variableDeclarator(
        markerId,
        t.callExpression(
          t.memberExpression(t.identifier('document'), t.identifier('createDocumentFragment')),
          [],
        ),
      ),
    ])

    const appendStartMarker = t.expressionStatement(
      t.callExpression(t.memberExpression(markerId, t.identifier('appendChild')), [
        t.memberExpression(containerId, t.identifier('startMarker')),
      ]),
    )

    const appendEndMarker = t.expressionStatement(
      t.callExpression(t.memberExpression(markerId, t.identifier('appendChild')), [
        t.memberExpression(containerId, t.identifier('endMarker')),
      ]),
    )

    const renderDecl = t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier(`${bindingId.name}_render`), renderer),
    ])

    const pendingDecl = t.variableDeclaration('let', [
      t.variableDeclarator(pendingId, t.nullLiteral()),
    ])
    const disposedDecl = t.variableDeclaration('let', [
      t.variableDeclarator(disposedId, t.booleanLiteral(false)),
    ])

    const destroyBlockDecl = t.variableDeclaration('const', [
      t.variableDeclarator(
        destroyBlockId,
        t.arrowFunctionExpression(
          [t.identifier('block')],
          t.blockStatement([
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.identifier('start'),
                t.logicalExpression(
                  '||',
                  t.memberExpression(t.identifier('block'), t.identifier('start')),
                  t.memberExpression(
                    t.memberExpression(t.identifier('block'), t.identifier('nodes')),
                    t.numericLiteral(0),
                    true,
                  ),
                ),
              ),
            ]),
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.identifier('end'),
                t.logicalExpression(
                  '||',
                  t.memberExpression(t.identifier('block'), t.identifier('end')),
                  t.memberExpression(
                    t.memberExpression(t.identifier('block'), t.identifier('nodes')),
                    t.binaryExpression(
                      '-',
                      t.memberExpression(
                        t.memberExpression(t.identifier('block'), t.identifier('nodes')),
                        t.identifier('length'),
                      ),
                      t.numericLiteral(1),
                    ),
                    true,
                  ),
                ),
              ),
            ]),
            t.ifStatement(
              t.logicalExpression(
                '||',
                t.unaryExpression('!', t.identifier('start')),
                t.unaryExpression('!', t.identifier('end')),
              ),
              t.returnStatement(),
            ),
            t.expressionStatement(
              t.callExpression(t.identifier(RUNTIME_ALIASES.destroyMarkerBlock), [
                t.objectExpression([
                  t.objectProperty(t.identifier('start'), t.identifier('start')),
                  t.objectProperty(t.identifier('end'), t.identifier('end')),
                  t.objectProperty(
                    t.identifier('root'),
                    t.memberExpression(t.identifier('block'), t.identifier('root')),
                  ),
                ]),
              ]),
            ),
          ]),
        ),
      ),
    ])

    const diffBodyStatements: BabelCore.types.Statement[] = []
    diffBodyStatements.push(
      t.ifStatement(disposedId, t.returnStatement()),
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('newItems'),
          t.logicalExpression('||', pendingId, t.callExpression(getItemsId, [])),
        ),
      ]),
      t.expressionStatement(t.assignmentExpression('=', pendingId, t.nullLiteral())),
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('oldBlocks'),
          t.memberExpression(containerId, t.identifier('blocks')),
        ),
      ]),
      t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier('newBlocks'), t.newExpression(t.identifier('Map'), [])),
      ]),
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('parent'),
          t.memberExpression(
            t.memberExpression(containerId, t.identifier('endMarker')),
            t.identifier('parentNode'),
          ),
        ),
      ]),
      t.ifStatement(
        t.unaryExpression('!', t.identifier('parent')),
        t.blockStatement([
          t.expressionStatement(t.assignmentExpression('=', pendingId, t.identifier('newItems'))),
          t.expressionStatement(t.callExpression(t.identifier('queueMicrotask'), [diffId])),
          t.returnStatement(),
        ]),
      ),
    )

    const forLoop = t.forStatement(
      t.variableDeclaration('let', [t.variableDeclarator(t.identifier('i'), t.numericLiteral(0))]),
      t.binaryExpression(
        '<',
        t.identifier('i'),
        t.memberExpression(t.identifier('newItems'), t.identifier('length')),
      ),
      t.updateExpression('++', t.identifier('i')),
      t.blockStatement([
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier('item'),
            t.memberExpression(t.identifier('newItems'), t.identifier('i'), true),
          ),
        ]),
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier('key'),
            t.callExpression(keyFnId, [t.identifier('item'), t.identifier('i')]),
          ),
        ]),
        t.variableDeclaration('let', [
          t.variableDeclarator(
            t.identifier('block'),
            t.callExpression(t.memberExpression(t.identifier('oldBlocks'), t.identifier('get')), [
              t.identifier('key'),
            ]),
          ),
        ]),
        t.ifStatement(
          t.identifier('block'),
          t.blockStatement([
            t.expressionStatement(
              t.callExpression(t.memberExpression(t.identifier('block'), t.identifier('item')), [
                t.identifier('item'),
              ]),
            ),
            t.expressionStatement(
              t.callExpression(t.memberExpression(t.identifier('block'), t.identifier('index')), [
                t.identifier('i'),
              ]),
            ),
            t.ifStatement(
              t.callExpression(t.memberExpression(t.identifier('newBlocks'), t.identifier('has')), [
                t.identifier('key'),
              ]),
              t.expressionStatement(
                t.callExpression(destroyBlockId, [
                  t.callExpression(
                    t.memberExpression(t.identifier('newBlocks'), t.identifier('get')),
                    [t.identifier('key')],
                  ),
                ]),
              ),
            ),
            t.ifStatement(
              t.logicalExpression(
                '||',
                t.unaryExpression(
                  '!',
                  t.memberExpression(t.identifier('block'), t.identifier('start')),
                ),
                t.unaryExpression(
                  '!',
                  t.memberExpression(t.identifier('block'), t.identifier('end')),
                ),
              ),
              t.blockStatement([
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier('start'),
                    t.callExpression(
                      t.memberExpression(t.identifier('document'), t.identifier('createComment')),
                      [t.stringLiteral('fict:list:block')],
                    ),
                  ),
                ]),
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier('end'),
                    t.callExpression(
                      t.memberExpression(t.identifier('document'), t.identifier('createComment')),
                      [t.stringLiteral('fict:list:block')],
                    ),
                  ),
                ]),
                t.expressionStatement(
                  t.assignmentExpression(
                    '=',
                    t.memberExpression(t.identifier('block'), t.identifier('start')),
                    t.identifier('start'),
                  ),
                ),
                t.expressionStatement(
                  t.assignmentExpression(
                    '=',
                    t.memberExpression(t.identifier('block'), t.identifier('end')),
                    t.identifier('end'),
                  ),
                ),
              ]),
            ),
            t.expressionStatement(
              t.callExpression(t.memberExpression(t.identifier('newBlocks'), t.identifier('set')), [
                t.identifier('key'),
                t.identifier('block'),
              ]),
            ),
            t.expressionStatement(
              t.callExpression(
                t.memberExpression(t.identifier('oldBlocks'), t.identifier('delete')),
                [t.identifier('key')],
              ),
            ),
          ]),
          t.blockStatement([
            t.expressionStatement(
              t.assignmentExpression(
                '=',
                t.identifier('block'),
                t.callExpression(t.identifier(RUNTIME_ALIASES.createKeyedBlock), [
                  t.identifier('key'),
                  t.identifier('item'),
                  t.identifier('i'),
                  t.identifier(`${bindingId.name}_render`),
                ]),
              ),
            ),
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.identifier('start'),
                t.callExpression(
                  t.memberExpression(t.identifier('document'), t.identifier('createComment')),
                  [t.stringLiteral('fict:list:block')],
                ),
              ),
            ]),
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.identifier('end'),
                t.callExpression(
                  t.memberExpression(t.identifier('document'), t.identifier('createComment')),
                  [t.stringLiteral('fict:list:block')],
                ),
              ),
            ]),
            t.expressionStatement(
              t.assignmentExpression(
                '=',
                t.memberExpression(t.identifier('block'), t.identifier('start')),
                t.identifier('start'),
              ),
            ),
            t.expressionStatement(
              t.assignmentExpression(
                '=',
                t.memberExpression(t.identifier('block'), t.identifier('end')),
                t.identifier('end'),
              ),
            ),
            t.expressionStatement(
              t.callExpression(t.memberExpression(t.identifier('newBlocks'), t.identifier('set')), [
                t.identifier('key'),
                t.identifier('block'),
              ]),
            ),
          ]),
        ),
      ]),
    )

    diffBodyStatements.push(forLoop)

    diffBodyStatements.push(
      t.forOfStatement(
        t.variableDeclaration('const', [t.variableDeclarator(t.identifier('block'))]),
        t.callExpression(t.memberExpression(t.identifier('oldBlocks'), t.identifier('values')), []),
        t.blockStatement([
          t.expressionStatement(t.callExpression(destroyBlockId, [t.identifier('block')])),
        ]),
      ),
    )

    diffBodyStatements.push(
      t.variableDeclaration('let', [
        t.variableDeclarator(
          t.identifier('anchor'),
          t.callExpression(t.identifier(RUNTIME_ALIASES.getFirstNodeAfter), [
            t.memberExpression(containerId, t.identifier('startMarker')),
          ]),
        ),
      ]),
      t.ifStatement(
        t.unaryExpression('!', t.identifier('anchor')),
        t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.identifier('anchor'),
            t.memberExpression(containerId, t.identifier('endMarker')),
          ),
        ),
      ),
      t.forOfStatement(
        t.variableDeclaration('const', [t.variableDeclarator(t.identifier('key'))]),
        t.callExpression(t.memberExpression(t.identifier('newBlocks'), t.identifier('keys')), []),
        t.blockStatement([
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('block'),
              t.callExpression(t.memberExpression(t.identifier('newBlocks'), t.identifier('get')), [
                t.identifier('key'),
              ]),
            ),
          ]),
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('start'),
              t.logicalExpression(
                '||',
                t.memberExpression(t.identifier('block'), t.identifier('start')),
                t.memberExpression(
                  t.memberExpression(t.identifier('block'), t.identifier('nodes')),
                  t.numericLiteral(0),
                  true,
                ),
              ),
            ),
          ]),
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('end'),
              t.logicalExpression(
                '||',
                t.memberExpression(t.identifier('block'), t.identifier('end')),
                t.memberExpression(
                  t.memberExpression(t.identifier('block'), t.identifier('nodes')),
                  t.binaryExpression(
                    '-',
                    t.memberExpression(
                      t.memberExpression(t.identifier('block'), t.identifier('nodes')),
                      t.identifier('length'),
                    ),
                    t.numericLiteral(1),
                  ),
                  true,
                ),
              ),
            ),
          ]),
          t.ifStatement(
            t.logicalExpression(
              '||',
              t.unaryExpression('!', t.identifier('start')),
              t.unaryExpression('!', t.identifier('end')),
            ),
            t.continueStatement(),
          ),
          t.ifStatement(
            t.unaryExpression(
              '!',
              t.memberExpression(t.identifier('start'), t.identifier('parentNode')),
            ),
            t.blockStatement([
              t.variableDeclaration('const', [
                t.variableDeclarator(
                  t.identifier('frag'),
                  t.callExpression(
                    t.memberExpression(
                      t.identifier('document'),
                      t.identifier('createDocumentFragment'),
                    ),
                    [],
                  ),
                ),
              ]),
              t.expressionStatement(
                t.callExpression(
                  t.memberExpression(t.identifier('frag'), t.identifier('appendChild')),
                  [t.identifier('start')],
                ),
              ),
              t.forOfStatement(
                t.variableDeclaration('const', [t.variableDeclarator(t.identifier('node'))]),
                t.memberExpression(t.identifier('block'), t.identifier('nodes')),
                t.blockStatement([
                  t.expressionStatement(
                    t.callExpression(
                      t.memberExpression(t.identifier('frag'), t.identifier('appendChild')),
                      [t.identifier('node')],
                    ),
                  ),
                ]),
              ),
              t.expressionStatement(
                t.callExpression(
                  t.memberExpression(t.identifier('frag'), t.identifier('appendChild')),
                  [t.identifier('end')],
                ),
              ),
              t.expressionStatement(
                t.callExpression(
                  t.memberExpression(t.identifier('parent'), t.identifier('insertBefore')),
                  [t.identifier('frag'), t.identifier('anchor')],
                ),
              ),
            ]),
            t.ifStatement(
              t.binaryExpression('!==', t.identifier('start'), t.identifier('anchor')),
              t.expressionStatement(
                t.callExpression(t.identifier(RUNTIME_ALIASES.moveMarkerBlock), [
                  t.identifier('parent'),
                  t.objectExpression([
                    t.objectProperty(t.identifier('start'), t.identifier('start')),
                    t.objectProperty(t.identifier('end'), t.identifier('end')),
                    t.objectProperty(
                      t.identifier('root'),
                      t.memberExpression(t.identifier('block'), t.identifier('root')),
                    ),
                  ]),
                  t.identifier('anchor'),
                ]),
              ),
            ),
          ),
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.identifier('anchor'),
              t.memberExpression(t.identifier('end'), t.identifier('nextSibling')),
            ),
          ),
        ]),
      ),
      t.expressionStatement(
        t.callExpression(
          t.memberExpression(
            t.memberExpression(containerId, t.identifier('blocks')),
            t.identifier('clear'),
          ),
          [],
        ),
      ),
      t.forOfStatement(
        t.variableDeclaration('const', [
          t.variableDeclarator(t.arrayPattern([t.identifier('k'), t.identifier('b')]), null),
        ]),
        t.callExpression(
          t.memberExpression(t.identifier('newBlocks'), t.identifier('entries')),
          [],
        ),
        t.blockStatement([
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(
                t.memberExpression(containerId, t.identifier('blocks')),
                t.identifier('set'),
              ),
              [t.identifier('k'), t.identifier('b')],
            ),
          ),
        ]),
      ),
    )

    const diffDecl = t.variableDeclaration('const', [
      t.variableDeclarator(
        diffId,
        t.arrowFunctionExpression([], t.blockStatement(diffBodyStatements)),
      ),
    ])

    // Start the diffing effect. We don't need to retain the disposer here because
    // `createEffect` already registers cleanup with the current root, and our
    // onDestroy handler below handles the remaining list-specific disposal work.
    const startDiffEffect = t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.effect), [diffId]),
    )

    const disposeDecl = t.variableDeclaration('const', [
      t.variableDeclarator(
        disposeId,
        t.arrowFunctionExpression(
          [],
          t.blockStatement([
            t.expressionStatement(t.assignmentExpression('=', disposedId, t.booleanLiteral(true))),
            t.forOfStatement(
              t.variableDeclaration('const', [t.variableDeclarator(t.identifier('block'))]),
              t.callExpression(
                t.memberExpression(
                  t.memberExpression(containerId, t.identifier('blocks')),
                  t.identifier('values'),
                ),
                [],
              ),
              t.blockStatement([
                t.expressionStatement(t.callExpression(destroyBlockId, [t.identifier('block')])),
              ]),
            ),
            t.expressionStatement(
              t.callExpression(t.memberExpression(containerId, t.identifier('dispose')), []),
            ),
          ]),
        ),
      ),
    ])

    const onDestroyCall = t.expressionStatement(
      t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [disposeId]),
    )

    return t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement([
          getItemsDecl,
          keyFnDecl,
          containerDecl,
          markerDecl,
          appendStartMarker,
          appendEndMarker,
          renderDecl,
          pendingDecl,
          disposedDecl,
          destroyBlockDecl,
          diffDecl,
          startDiffEffect,
          disposeDecl,
          onDestroyCall,
          t.returnStatement(markerId),
        ]),
      ),
      [],
    )
  }

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

function getSupportedJsxElementFromExpression(
  expr: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): BabelCore.types.JSXElement | null {
  if (t.isJSXElement(expr)) return expr
  if (t.isParenthesizedExpression(expr)) {
    return getSupportedJsxElementFromExpression(expr.expression, t)
  }
  return null
}

function maybeCreateFineGrainedKeyedRenderer(
  renderArrow: BabelCore.types.ArrowFunctionExpression,
  originalArrow: BabelCore.types.ArrowFunctionExpression | null,
  itemParam: BabelCore.types.Identifier,
  indexParam: BabelCore.types.Identifier | undefined,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.ArrowFunctionExpression | null {
  if (!ctx.options.fineGrainedDom) return null
  const analysisArrow = originalArrow ?? renderArrow
  if (!t.isArrowFunctionExpression(analysisArrow)) return null
  if (t.isBlockStatement(analysisArrow.body)) return null
  if (!itemParam || !t.isIdentifier(itemParam)) return null

  const jsxExpr = getSupportedJsxElementFromExpression(analysisArrow.body, t)
  if (!jsxExpr) return null

  const valueParam = t.identifier('__fgValueSig')
  const indexParamId = t.identifier('__fgIndexSig')

  const overrides: IdentifierOverrideMap = Object.create(null)
  overrides[itemParam.name] = () => t.callExpression(valueParam, [])
  if (indexParam) overrides[indexParam.name] = () => t.callExpression(indexParamId, [])

  const templateExpr = transformFineGrainedJsx(jsxExpr, ctx, t, overrides)
  if (!templateExpr) return null

  return t.arrowFunctionExpression(
    [valueParam, indexParamId],
    t.blockStatement([t.returnStatement(t.arrayExpression([templateExpr]))]),
  )
}

function createInsertBinding(
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Expression {
  ctx.helpersUsed.insert = true
  ctx.helpersUsed.onDestroy = true
  ctx.helpersUsed.createElement = true

  const fragId = t.identifier(`__fictFrag_${++ctx.fineGrainedTemplateId}`)
  const disposeId = t.identifier(`__fictDispose_${ctx.fineGrainedTemplateId}`)

  const createFrag = t.variableDeclaration('const', [
    t.variableDeclarator(
      fragId,
      t.callExpression(
        t.memberExpression(t.identifier('document'), t.identifier('createDocumentFragment')),
        [],
      ),
    ),
  ])

  const disposeDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      disposeId,
      t.callExpression(t.identifier(RUNTIME_ALIASES.insert), [
        fragId,
        t.arrowFunctionExpression([], expr),
        t.identifier(RUNTIME_ALIASES.createElement),
      ]),
    ),
  ])

  const onDestroyCall = t.expressionStatement(
    t.callExpression(t.identifier(RUNTIME_ALIASES.onDestroy), [disposeId]),
  )

  const returnFrag = t.returnStatement(fragId)

  // Wrap in IIFE
  return t.callExpression(
    t.arrowFunctionExpression(
      [],
      t.blockStatement([createFrag, disposeDecl, onDestroyCall, returnFrag]),
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

  if (!ctx.hasStateImport) {
    throw path.buildCodeFrameError('$state() must be imported from "fict" before use')
  }

  if (getFunctionDepth(path) > 1) {
    throw path.buildCodeFrameError(
      '$state() must be declared at module or component top-level (no nested functions)',
    )
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

  if (!ctx.hasEffectImport) {
    throw path.buildCodeFrameError('$effect() must be imported from "fict" before use')
  }

  if (getFunctionDepth(path) > 1) {
    throw path.buildCodeFrameError(
      '$effect() must be called at module or component top-level (no nested functions)',
    )
  }
}

function getFunctionDepth(path: BabelCore.NodePath): number {
  let depth = 0
  let current: BabelCore.NodePath | null = path.parentPath
  while (current) {
    if (
      current.isFunctionDeclaration() ||
      current.isFunctionExpression() ||
      current.isArrowFunctionExpression()
    ) {
      depth++
    }
    if (current.isProgram()) break
    current = current.parentPath
  }
  return depth
}

function shouldEmitGetter(name: string, ctx: TransformContext, t: typeof BabelCore.types): boolean {
  const program = ctx.file?.ast?.program as BabelCore.types.Program | undefined
  if (!program) return false

  let reactive = false
  let eventUsage = false
  let otherUsage = false

  const visit = (
    node: BabelCore.types.Node,
    shadow: Set<string>,
    ancestors: BabelCore.types.Node[],
    inFunction: boolean,
  ): void => {
    if (reactive) return

    // Track function params and shadowing
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      const nextShadow = new Set(shadow)
      for (const param of node.params) {
        collectBindingNames(param as any, nextShadow, t)
      }
      for (const childKey of Object.keys(node) as (keyof typeof node)[]) {
        const child = (node as any)[childKey]
        if (Array.isArray(child)) {
          for (const c of child) {
            if (c && typeof c === 'object' && 'type' in c && typeof (c as any).type === 'string') {
              visit(c as BabelCore.types.Node, nextShadow, ancestors.concat(node), true)
            }
          }
        } else if (
          child &&
          typeof child === 'object' &&
          'type' in child &&
          typeof (child as any).type === 'string'
        ) {
          visit(child as BabelCore.types.Node, nextShadow, ancestors.concat(node), true)
        }
      }
      return
    }

    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      const nextShadow = new Set(shadow)
      nextShadow.add(node.id.name)
      if (node.init) {
        visit(node.init, nextShadow, ancestors.concat(node), inFunction)
      }
      return
    }

    if (t.isIdentifier(node) && node.name === name && !shadow.has(name)) {
      // const parent = ancestors[ancestors.length - 1]

      const inEffect = ancestors.some(
        anc =>
          t.isCallExpression(anc) && t.isIdentifier(anc.callee) && anc.callee.name === '$effect',
      )

      // JSX attribute detection
      const jsxAttrAncestor = ancestors.find(anc => t.isJSXAttribute(anc)) as
        | BabelCore.types.JSXAttribute
        | undefined
      if (jsxAttrAncestor && t.isJSXIdentifier(jsxAttrAncestor.name)) {
        const attrName = jsxAttrAncestor.name.name
        if (isEventHandler(attrName) || NON_REACTIVE_ATTRS.has(attrName)) {
          eventUsage = true
        } else {
          reactive = true
        }
        return
      }

      const inJsxExpression = ancestors.some(anc => t.isJSXExpressionContainer(anc))

      if (inEffect || inJsxExpression) {
        reactive = true
        return
      }

      if (inFunction) {
        eventUsage = true
        return
      }

      otherUsage = true
      return
    }

    const nextShadow = new Set(shadow)
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      nextShadow.add(node.id.name)
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object' && 'type' in c && typeof (c as any).type === 'string') {
            visit(c as BabelCore.types.Node, nextShadow, ancestors.concat(node), inFunction)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as any).type === 'string'
      ) {
        visit(child as BabelCore.types.Node, nextShadow, ancestors.concat(node), inFunction)
      }
    }
  }

  visit(program, new Set<string>(), [], false)
  if (reactive || otherUsage) return false
  return eventUsage
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
  ctx: TransformContext,
): boolean {
  const binding = path.scope.getBinding(name)
  if (!binding) return false

  // If this is a function parameter, it shadows the outer state/memo variable
  if (binding.kind === 'param') {
    return true
  }

  // Check if this is a tracked variable (stateVars, memoVars, or getterOnlyVars)
  const isTracked =
    ctx.stateVars.has(name) || ctx.memoVars.has(name) || ctx.getterOnlyVars.has(name)

  if (!isTracked) {
    // Not a tracked variable - it's a local shadowing binding
    return true
  }

  // For tracked variables, check if the binding is a destructuring parameter pattern
  const bindingPath = binding.path

  // Handle destructuring patterns in function parameters
  if (bindingPath.isIdentifier()) {
    const parent = bindingPath.parentPath
    if (parent?.isArrayPattern() || parent?.isObjectProperty() || parent?.isRestElement()) {
      // Walk up to find if this pattern is a function parameter
      let current: BabelCore.NodePath | null = parent
      while (current) {
        // const node = current.node
        // Check if we've reached a function and this pattern is one of its params
        if (current.isFunction()) {
          const funcParams = (current.node as BabelCore.types.Function).params
          // Check if any ancestor is in the function's params
          // const patternNode = bindingPath.node
          let patternPath: BabelCore.NodePath | null = bindingPath
          while (patternPath && !funcParams.includes(patternPath.node as any)) {
            patternPath = patternPath.parentPath
          }
          if (patternPath && funcParams.includes(patternPath.node as any)) {
            return true
          }
          break
        }
        current = current.parentPath
      }
    }
  }

  // Not shadowed - this is the original tracked variable
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

function isInsideNestedFunction(path: BabelCore.NodePath<BabelCore.types.Identifier>): boolean {
  const name = path.node.name
  const binding = path.scope.getBinding(name)
  if (!binding) return false

  const declarationFuncScope = binding.scope.getFunctionParent()
  const usageFuncScope = path.scope.getFunctionParent()
  return declarationFuncScope !== usageFuncScope
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

    const stateRoot = getStateRootFromExpression(arg, ctx, t)
    if (stateRoot && !t.isIdentifier(arg)) {
      emitWarning(
        ctx,
        node,
        'FICT-H',
        `Expression derived from state "${stateRoot}" passed to function "${funcName || '<anonymous>'}" ` +
          'may be mutated. Consider using immutable patterns or explicit dependency tracking.',
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

function getStateRootFromExpression(
  expr: BabelCore.types.Expression,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): string | null {
  const { stateVars, shadowedVars } = ctx
  if (t.isIdentifier(expr)) {
    if (stateVars.has(expr.name) && !shadowedVars.has(expr.name)) {
      return expr.name
    }
    return null
  }
  if (
    t.isMemberExpression(expr) &&
    t.isExpression(expr.object) &&
    !t.isOptionalMemberExpression(expr)
  ) {
    return getStateRootFromExpression(expr.object, ctx, t)
  }
  if (t.isOptionalMemberExpression(expr) && t.isExpression(expr.object)) {
    return getStateRootFromExpression(expr.object, ctx, t)
  }
  if (t.isCallExpression(expr) && t.isExpression(expr.callee)) {
    return getStateRootFromExpression(expr.callee, ctx, t)
  }
  if (t.isOptionalCallExpression(expr) && t.isExpression(expr.callee)) {
    return getStateRootFromExpression(expr.callee, ctx, t)
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

    // Handle member expressions - skip property names (unless computed)
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      visit(node.object, locals)
      // Only visit property if it's computed (e.g., obj[key] vs obj.key)
      if (node.computed && node.property) {
        visit(node.property, locals)
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
  addHelper('bindProperty')
  addHelper('bindClass')
  addHelper('bindStyle')
  addHelper('bindEvent')
  addHelper('toNodeArray')
  addHelper('createKeyedListContainer')
  addHelper('createKeyedBlock')
  addHelper('moveMarkerBlock')
  addHelper('destroyMarkerBlock')
  addHelper('getFirstNodeAfter')

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
  overrides?: IdentifierOverrideMap,
): BabelCore.types.Expression {
  let transformed = transformExpression(expr, ctx, t)

  if (overrides && Object.keys(overrides).length) {
    transformed = t.cloneNode(transformed, true) as BabelCore.types.Expression
    traverse(transformed, {
      noScope: true,
      Identifier(path: TraverseNodePath<BabelCore.types.Identifier>) {
        const factoryFn = overrides[path.node.name]
        if (factoryFn) {
          path.replaceWith(factoryFn())
        }
      },
    })
  }

  return transformed
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
        ...createBindEventCall(t, elementId, normalized.eventName!, expr, normalized, state.ctx),
      )
      continue
    }

    if (normalized.kind === 'ref') {
      if (!attr.value || !t.isJSXExpressionContainer(attr.value) || !attr.value.expression) {
        return false
      }
      const expr = transformExpressionForFineGrained(
        attr.value.expression as BabelCore.types.Expression,
        state.ctx,
        t,
        state.identifierOverrides,
      )
      state.statements.push(...createApplyRefStatements(t, elementId, expr, state.ctx))
      continue
    }

    if (normalized.kind === 'property') {
      if (!attr.value) {
        state.statements.push(
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(elementId, t.identifier(normalized.name)),
              t.booleanLiteral(true),
            ),
          ),
        )
        continue
      }

      if (t.isStringLiteral(attr.value)) {
        state.statements.push(
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(elementId, t.identifier(normalized.name)),
              attr.value,
            ),
          ),
        )
        continue
      }

      if (t.isJSXExpressionContainer(attr.value) && attr.value.expression) {
        const expr = transformExpressionForFineGrained(
          attr.value.expression as BabelCore.types.Expression,
          state.ctx,
          t,
          state.identifierOverrides,
        )
        state.statements.push(
          createBindPropertyCall(t, elementId, normalized.name, expr, state.ctx),
        )
        continue
      }

      return false
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
  overrides?: IdentifierOverrideMap,
): BabelCore.types.Expression | null {
  if (!ctx.options.fineGrainedDom) return null

  const tagName = getIntrinsicTagName(node, t)
  if (!tagName) return null

  const state: TemplateBuilderState = {
    ctx,
    statements: [],
    namePrefix: createTemplateNamePrefix(ctx),
    nameCounters: Object.create(null),
    ...(overrides ? { identifierOverrides: overrides } : {}),
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
  if (ctx.noMemo) return
  if (path.isBlockStatement() && isInNoMemoScope(path, ctx)) return
  const statements = (path.node as BabelCore.types.Program | BabelCore.types.BlockStatement).body
  if (!Array.isArray(statements) || statements.length === 0) return

  const derivedOutputs = collectDerivedOutputsFromStatements(
    statements as BabelCore.types.Statement[],
    ctx,
    t,
  )
  if (
    t.isBlockStatement(path.node) &&
    path.parentPath &&
    path.parentPath.isFunctionDeclaration() &&
    path.parentPath.node.id?.name === 'view'
  ) {
    console.log('debug region outputs for view', Array.from(derivedOutputs))
  }
  if (derivedOutputs.size < 2) return

  const result: BabelCore.types.Statement[] = []
  let index = 0
  let regionCreated = false

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

    // Exclude trailing return statements from the region
    let regionEnd = end
    while (regionEnd >= start && t.isReturnStatement(statements[regionEnd]!)) {
      regionEnd--
    }
    if (regionEnd < start) {
      index = end + 1
      continue
    }

    // Emit statements before the region untouched
    if (start > index) {
      for (let i = index; i < start; i++) {
        result.push(statements[i] as BabelCore.types.Statement)
      }
    }

    const startAfterRegion = regionEnd + 1
    const referencedOutside = collectReferencedOutputs(
      statements as BabelCore.types.Statement[],
      outputs,
      startAfterRegion,
      ctx,
      t,
    )
    const activeOutputs = ctx.options.lazyConditional
      ? outputs
      : referencedOutside.size
        ? referencedOutside
        : outputs

    const reassignedLater = hasAssignmentsOutside(
      statements as BabelCore.types.Statement[],
      activeOutputs,
      startAfterRegion,
      t,
    )
    if (reassignedLater || activeOutputs.size < 2) {
      for (let i = start; i <= end; i++) {
        result.push(statements[i] as BabelCore.types.Statement)
      }
      index = end + 1
      continue
    }

    const analysisStatements = cloneRegionStatements(
      statements as BabelCore.types.Statement[],
      start,
      end,
      t,
    )
    const regionStatements = cloneRegionStatements(
      statements as BabelCore.types.Statement[],
      start,
      regionEnd,
      t,
    )

    let orderedOutputs = collectOutputsInOrder(regionStatements, activeOutputs, t)
    if (!orderedOutputs.length) {
      orderedOutputs = Array.from(activeOutputs)
    }

    const { memoDecl, getterDecls } = generateRegionMemo(
      regionStatements,
      orderedOutputs,
      ctx,
      t,
      analysisStatements,
    )

    result.push(memoDecl, ...getterDecls)
    regionCreated = true

    // Re-emit trailing statements (e.g., return) that were excluded from the region
    for (let i = regionEnd + 1; i <= end; i++) {
      result.push(statements[i] as BabelCore.types.Statement)
    }
    index = end + 1
  }

  if (regionCreated) {
    ;(path.node as any).body = result
    if (
      t.isBlockStatement(path.node) &&
      path.parentPath &&
      path.parentPath.isFunctionDeclaration() &&
      path.parentPath.node.id?.name === 'view'
    ) {
      console.log('region created for view (primary)')
    }
    return
  }

  // Fallback: if no regions were formed but multiple derived outputs exist, group the first span
  const firstTouched = (statements as BabelCore.types.Statement[]).findIndex(stmt =>
    statementTouchesOutputs(stmt, derivedOutputs, ctx, t),
  )
  const lastTouched = (() => {
    for (let i = statements.length - 1; i >= 0; i--) {
      const stmt = statements[i] as BabelCore.types.Statement | undefined
      if (stmt && statementTouchesOutputs(stmt, derivedOutputs, ctx, t)) return i
    }
    return -1
  })()

  if (firstTouched === -1 || lastTouched === -1 || firstTouched > lastTouched) {
    if (
      t.isBlockStatement(path.node) &&
      path.parentPath &&
      path.parentPath.isFunctionDeclaration() &&
      path.parentPath.node.id?.name === 'view'
    ) {
      console.log('no fallback region for view')
    }
    return
  }

  let regionEnd = lastTouched
  while (regionEnd >= firstTouched && t.isReturnStatement(statements[regionEnd]!)) {
    regionEnd--
  }
  if (regionEnd < firstTouched) return

  const startAfterRegion = regionEnd + 1
  const referencedOutside = collectReferencedOutputs(
    statements as BabelCore.types.Statement[],
    derivedOutputs,
    startAfterRegion,
    ctx,
    t,
  )
  const activeOutputs = ctx.options.lazyConditional
    ? derivedOutputs
    : referencedOutside.size
      ? referencedOutside
      : derivedOutputs
  if (activeOutputs.size < 2) return

  const before = (statements as BabelCore.types.Statement[]).slice(0, firstTouched)
  const analysisStatements = cloneRegionStatements(
    statements as BabelCore.types.Statement[],
    firstTouched,
    lastTouched,
    t,
  )
  const regionStatements = cloneRegionStatements(
    statements as BabelCore.types.Statement[],
    firstTouched,
    regionEnd,
    t,
  )

  const orderedOutputs = collectOutputsInOrder(regionStatements, activeOutputs, t)
  if (!orderedOutputs.length) return

  const { memoDecl, getterDecls } = generateRegionMemo(
    regionStatements,
    orderedOutputs,
    ctx,
    t,
    analysisStatements,
  )

  const after = (statements as BabelCore.types.Statement[]).slice(regionEnd + 1)
  ;(path.node as any).body = [...before, memoDecl, ...getterDecls, ...after]
}

function cloneRegionStatements(
  statements: BabelCore.types.Statement[],
  start: number,
  end: number,
  t: typeof BabelCore.types,
): BabelCore.types.Statement[] {
  const slice = statements
    .slice(start, end + 1)
    .map(stmt => t.cloneNode(stmt, true)) as BabelCore.types.Statement[]
  return slice.map(stmt => stripMemoFromStatement(stmt, t))
}

function stripMemoFromStatement(
  stmt: BabelCore.types.Statement,
  t: typeof BabelCore.types,
): BabelCore.types.Statement {
  // Use manual recursion instead of traverse to work with detached nodes
  const visitNode = (node: BabelCore.types.Node): void => {
    if (!node || typeof node !== 'object') return

    // Check if this is a CallExpression that can be unwrapped
    if (t.isCallExpression(node)) {
      const replacement = unwrapMemoInitializer(node, t)
      if (replacement) {
        // Replace the node in place for the arguments array inside memo calls
        // This handles nested memo calls
        Object.assign(node, replacement)
      }
    }

    // Recursively visit all child nodes
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object' && 'type' in c && typeof c.type === 'string') {
            visitNode(c as unknown as BabelCore.types.Node)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type?: unknown }).type === 'string'
      ) {
        visitNode(child as unknown as BabelCore.types.Node)
      }
    }
  }

  visitNode(stmt)
  return stmt
}

function unwrapMemoInitializer(
  init: BabelCore.types.Expression,
  t: typeof BabelCore.types,
): BabelCore.types.Expression | null {
  if (
    t.isCallExpression(init) &&
    t.isIdentifier(init.callee) &&
    init.callee.name === RUNTIME_ALIASES.memo
  ) {
    const arg = init.arguments[0]
    if (arg && (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg))) {
      const body = arg.body
      if (t.isBlockStatement(body)) {
        const ret = body.body.find(
          (stmt): stmt is BabelCore.types.ReturnStatement =>
            t.isReturnStatement(stmt) && !!stmt.argument,
        )
        if (ret && ret.argument && t.isExpression(ret.argument)) {
          return ret.argument
        }
        return t.identifier('undefined')
      }
      if (t.isExpression(body)) {
        return body
      }
    }
  }
  return null
}

function collectReferencedOutputs(
  statements: BabelCore.types.Statement[],
  outputs: Set<string>,
  startIndex: number,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): Set<string> {
  const referenced = new Set<string>()
  const visit = (node: BabelCore.types.Node, shadow: Set<string>): void => {
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      const nextShadow = new Set(shadow)
      node.params.forEach(param => collectBindingNames(param as any, nextShadow, t))
      return
    }
    if (t.isIdentifier(node) && outputs.has(node.name) && !shadow.has(node.name)) {
      referenced.add(node.name)
      return
    }
    const nextShadow = new Set(shadow)
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      nextShadow.add(node.id.name)
    }
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object' && 'type' in c && typeof (c as any).type === 'string') {
            visit(c as BabelCore.types.Node, nextShadow)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as any).type === 'string'
      ) {
        visit(child as BabelCore.types.Node, nextShadow)
      }
    }
  }

  for (let i = startIndex; i < statements.length; i++) {
    const stmt = statements[i]
    if (stmt) visit(stmt, new Set(ctx.shadowedVars))
  }
  return referenced
}

function hasAssignmentsOutside(
  statements: BabelCore.types.Statement[],
  outputs: Set<string>,
  startIndex: number,
  t: typeof BabelCore.types,
): boolean {
  for (let i = startIndex; i < statements.length; i++) {
    const stmt = statements[i]
    if (stmt && statementAssignsOutputs(stmt, outputs, t)) {
      return true
    }
  }
  return false
}

function statementAssignsOutputs(
  stmt: BabelCore.types.Statement,
  outputs: Set<string>,
  t: typeof BabelCore.types,
): boolean {
  let assigns = false
  const visit = (node: BabelCore.types.Node, shadow: Set<string>): void => {
    if (assigns) return
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      const nextShadow = new Set(shadow)
      node.params.forEach(param => collectBindingNames(param as any, nextShadow, t))
      return
    }

    if (
      t.isAssignmentExpression(node) &&
      t.isIdentifier(node.left) &&
      outputs.has(node.left.name) &&
      !shadow.has(node.left.name)
    ) {
      assigns = true
      return
    }

    const nextShadow = new Set(shadow)
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      nextShadow.add(node.id.name)
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object' && 'type' in c && typeof (c as any).type === 'string') {
            visit(c as BabelCore.types.Node, nextShadow)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as any).type === 'string'
      ) {
        visit(child as BabelCore.types.Node, nextShadow)
      }
    }
  }

  visit(stmt, new Set())
  return assigns
}

// ============================================================================
// Exports
// ============================================================================

export default createFictPlugin
