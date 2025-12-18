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
  transformFineGrainedJsx,
  createConditionalBinding,
  createListBinding,
  createInsertBinding,
} from './fine-grained-dom'
import { transformExpression } from './transform-expression'
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

const SLOT_COUNTER = new WeakMap<BabelCore.types.Node, number>()

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
              slotCounters: new WeakMap(),
              functionsWithJsx: new WeakSet(),
              shadowStack: [],
              trackedScopeStack: [],
              pendingRegionOutputs: new WeakMap(),
              pendingRegionStack: [],
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

            // Phase 6: Pre-analyze control flow region outputs
            // Populate pendingRegionOutputs per function - these will become getters after region transform
            // JSX shorthand properties need to know about these for correct transformation
            preAnalyzeRegionOutputs(path, ctx, t)

            // Store context in state for use by other visitors
            ;(state as any).__fictCtx = ctx
          },
          exit(path, state) {
            const ctx = (state as any).__fictCtx as TransformContext
            if (!ctx) return

            applyRegionTransform(path, ctx, t)
            wrapComponentsWithRender(path, ctx, t)

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
              const slot = nextSlot(path, ctx, t)
              ensureContextDeclaration(path, ctx, t)

              ctx.helpersUsed.useSignal = true
              declarator.init = t.callExpression(t.identifier(RUNTIME_ALIASES.useSignal), [
                t.identifier('__fictCtx'),
                ...(declarator.init.arguments.length
                  ? declarator.init.arguments
                  : [t.identifier('undefined')]),
                t.numericLiteral(slot),
              ])
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
                const slot = nextSlot(path, ctx, t)
                ensureContextDeclaration(path, ctx, t)
                ctx.helpersUsed.useMemo = true
                declarator.init = t.callExpression(t.identifier(RUNTIME_ALIASES.useMemo), [
                  t.identifier('__fictCtx'),
                  t.arrowFunctionExpression([], transformedInit),
                  t.numericLiteral(slot),
                ])
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
            const slot = nextSlot(path, ctx, t)
            ensureContextDeclaration(path, ctx, t)
            ctx.helpersUsed.useEffect = true
            ctx.helpersUsed.useContext = true

            const arg = path.node.arguments[0]
            const fn =
              arg && (t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg))
                ? arg
                : t.arrowFunctionExpression(
                    [],
                    arg && t.isExpression(arg) ? arg : t.identifier('undefined'),
                  )

            path.replaceWith(
              t.callExpression(t.identifier(RUNTIME_ALIASES.useEffect), [
                t.identifier('__fictCtx'),
                fn,
                t.numericLiteral(slot),
              ]),
            )
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

          // Check for getterOnlyVars
          const isGetterOnly = ctx.getterOnlyVars.has(name) && !ctx.shadowedVars.has(name)
          // Check for pending region outputs in the current function scope
          const pendingScope =
            ctx.pendingRegionStack.length > 0
              ? ctx.pendingRegionStack[ctx.pendingRegionStack.length - 1]
              : undefined
          const isPendingGetter = pendingScope?.has(name) && !ctx.shadowedVars.has(name)

          // Skip if not tracked or shadowed
          if (
            !isGetterOnly &&
            !isPendingGetter &&
            !isTrackedAndNotShadowed(name, ctx.stateVars, ctx.memoVars, ctx.shadowedVars)
          ) {
            return
          }

          // Skip if shouldn't be transformed
          if (!shouldTransformIdentifier(path, t)) {
            return
          }

          if (
            (isGetterOnly || isPendingGetter) &&
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
          const funcOwner = path.getFunctionParent()
          if (funcOwner && funcOwner.isFunction()) {
            ctx.functionsWithJsx.add(funcOwner.node)
          }

          const lowered = transformFineGrainedJsx(path.node, ctx, t)
          if (lowered) {
            path.replaceWith(lowered)
            path.skip()
          }
        },

        JSXFragment(path, state) {
          const ctx = (state as any).__fictCtx as TransformContext
          if (!ctx) return
          const funcOwner = path.getFunctionParent()
          if (funcOwner && funcOwner.isFunction()) {
            ctx.functionsWithJsx.add(funcOwner.node)
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

          // Check for getterOnlyVars
          const isGetterOnly = ctx.getterOnlyVars.has(name) && !ctx.shadowedVars.has(name)
          // Also check pending region outputs for the current function scope.
          // These are variables that WILL become getters after region transform.
          const pendingScope =
            ctx.pendingRegionStack.length > 0
              ? ctx.pendingRegionStack[ctx.pendingRegionStack.length - 1]
              : undefined
          const isPendingGetter = pendingScope?.has(name) && !ctx.shadowedVars.has(name)

          if (
            !isGetterOnly &&
            !isPendingGetter &&
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

            // Push pending region outputs for this function scope (if any)
            const pendingSet =
              ctx.pendingRegionOutputs.get(path.node as BabelCore.types.Function) ??
              new Set<string>()
            ctx.pendingRegionStack.push(pendingSet)

            // Compute tracked names for this function scope (state/derived/pending)
            const trackedNames = new Set<string>()
            const bindings = path.scope?.bindings ?? {}
            Object.keys(bindings).forEach(name => {
              const binding = bindings[name]
              const node = binding?.path?.node
              if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && node.init) {
                if (isStateCall(node.init, t) || dependsOnTracked(node.init, ctx, t)) {
                  trackedNames.add(name)
                }
              }
            })
            pendingSet.forEach(n => trackedNames.add(n))
            ctx.trackedScopeStack.push(trackedNames)

            // Track non-tracked local bindings for transformExpression scoping
            const localShadow = new Set<string>()
            Object.keys(bindings).forEach(name => {
              if (!trackedNames.has(name)) {
                localShadow.add(name)
              }
            })
            ctx.shadowStack.push(localShadow)

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
            ctx.pendingRegionStack.pop()
            ctx.trackedScopeStack.pop()
            ctx.shadowStack.pop()
            maybeApplyGetterCaching(path, ctx, t)
            maybeRewriteTopLevelConditionalReturn(path, ctx, t)
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
        if (
          calleeName === '$effect' ||
          calleeName === RUNTIME_ALIASES.effect ||
          calleeName === RUNTIME_ALIASES.useEffect
        ) {
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

/**
 * Helper to extract statements and return argument from a branch (consequent or alternate)
 */
function extractBranchContent(
  branch: BabelCore.types.Statement | null | undefined,
  t: typeof BabelCore.types,
): { stmts: BabelCore.types.Statement[]; returnArg: BabelCore.types.Expression | null } {
  if (!branch) return { stmts: [], returnArg: null }

  if (t.isReturnStatement(branch)) {
    return { stmts: [], returnArg: branch.argument ?? null }
  }
  if (t.isBlockStatement(branch)) {
    const returnIdx = branch.body.findIndex((s): s is BabelCore.types.ReturnStatement =>
      t.isReturnStatement(s),
    )
    if (returnIdx === -1) return { stmts: [], returnArg: null }
    return {
      stmts: branch.body.slice(0, returnIdx),
      returnArg: (branch.body[returnIdx] as BabelCore.types.ReturnStatement).argument ?? null,
    }
  }
  return { stmts: [], returnArg: null }
}

/**
 * Transform top-level conditional return patterns:
 *
 * Pattern 1: if without else
 *   if (cond) { ...stmts; return A; }
 *   ...stmts;
 *   return B;
 *
 * Pattern 2: if-else
 *   if (cond) { ...stmts; return A; }
 *   else { ...stmts; return B; }
 *
 * Both are transformed to:
 *   createConditional(() => cond, () => { ...stmts; return A }, __fictCreateElement, () => { ...stmts; return B });
 *
 * This enables reactive branch switching without re-running the component body.
 */
function maybeRewriteTopLevelConditionalReturn(
  path: BabelCore.NodePath<BabelCore.types.Function>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  if (!ctx.options.fineGrainedDom) return
  const body = path.get('body')
  if (!body.isBlockStatement()) return
  const stmts = body.node.body
  if (stmts.length < 1) return

  const lastIdx = stmts.length - 1
  const last = stmts[lastIdx]

  // Pattern 2: if-else at the end (no trailing return needed)
  if (t.isIfStatement(last) && last.alternate) {
    const ifStmt = last
    const trueContent = extractBranchContent(ifStmt.consequent, t)
    const falseContent = extractBranchContent(ifStmt.alternate, t)

    if (!trueContent.returnArg || !falseContent.returnArg) return

    const condFn = t.arrowFunctionExpression([], transformExpression(ifStmt.test, ctx, t))

    // Build true branch function
    let trueFn: BabelCore.types.ArrowFunctionExpression
    if (trueContent.stmts.length === 0) {
      trueFn = t.arrowFunctionExpression([], trueContent.returnArg)
    } else {
      const transformedTrueStmts = trueContent.stmts.map(s =>
        wrapReactiveExpressionStatement(s, ctx, t),
      )
      trueFn = t.arrowFunctionExpression(
        [],
        t.blockStatement([...transformedTrueStmts, t.returnStatement(trueContent.returnArg)]),
      )
    }

    // Build false branch function
    let falseFn: BabelCore.types.ArrowFunctionExpression
    if (falseContent.stmts.length === 0) {
      falseFn = t.arrowFunctionExpression([], falseContent.returnArg)
    } else {
      const transformedFalseStmts = falseContent.stmts.map(s =>
        wrapReactiveExpressionStatement(s, ctx, t),
      )
      falseFn = t.arrowFunctionExpression(
        [],
        t.blockStatement([...transformedFalseStmts, t.returnStatement(falseContent.returnArg)]),
      )
    }

    ctx.helpersUsed.conditional = true
    ctx.helpersUsed.createElement = true

    const call = t.callExpression(t.identifier(RUNTIME_ALIASES.conditional), [
      condFn,
      trueFn,
      t.identifier(RUNTIME_ALIASES.createElement),
      falseFn,
    ])

    const prefix = stmts
      .slice(0, lastIdx)
      .map(stmt => wrapReactiveExpressionStatement(stmt, ctx, t))
    const newReturn = t.returnStatement(t.memberExpression(call, t.identifier('marker')))
    body.node.body = [...prefix, newReturn]
    return
  }

  // Pattern 1: if without else followed by statements and return
  if (!t.isReturnStatement(last)) return
  if (stmts.length < 2) return

  // Find the if statement by scanning backwards (skip statements between if and return)
  let ifIdx = -1
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (t.isIfStatement(stmts[i]) && !(stmts[i] as BabelCore.types.IfStatement).alternate) {
      ifIdx = i
      break
    }
  }
  if (ifIdx === -1) return

  const ifStmt = stmts[ifIdx] as BabelCore.types.IfStatement

  // Extract statements and return from if consequent
  const trueContent = extractBranchContent(ifStmt.consequent, t)
  if (!trueContent.returnArg) return

  // Statements between if and final return (for false branch)
  const falseStmts = stmts.slice(ifIdx + 1, lastIdx)
  const falseReturnArg = last.argument ?? t.identifier('undefined')

  const condFn = t.arrowFunctionExpression([], transformExpression(ifStmt.test, ctx, t))

  // Build true branch function (include pre-return statements if any)
  let trueFn: BabelCore.types.ArrowFunctionExpression
  if (trueContent.stmts.length === 0) {
    trueFn = t.arrowFunctionExpression([], trueContent.returnArg)
  } else {
    const transformedTrueStmts = trueContent.stmts.map(s =>
      wrapReactiveExpressionStatement(s, ctx, t),
    )
    trueFn = t.arrowFunctionExpression(
      [],
      t.blockStatement([...transformedTrueStmts, t.returnStatement(trueContent.returnArg)]),
    )
  }

  // Build false branch function (include pre-return statements if any)
  let falseFn: BabelCore.types.ArrowFunctionExpression
  if (falseStmts.length === 0) {
    falseFn = t.arrowFunctionExpression([], falseReturnArg)
  } else {
    const transformedFalseStmts = falseStmts.map(s => wrapReactiveExpressionStatement(s, ctx, t))
    falseFn = t.arrowFunctionExpression(
      [],
      t.blockStatement([...transformedFalseStmts, t.returnStatement(falseReturnArg)]),
    )
  }

  ctx.helpersUsed.conditional = true
  ctx.helpersUsed.createElement = true

  const call = t.callExpression(t.identifier(RUNTIME_ALIASES.conditional), [
    condFn,
    trueFn,
    t.identifier(RUNTIME_ALIASES.createElement),
    falseFn,
  ])

  const prefix = stmts.slice(0, ifIdx).map(stmt => wrapReactiveExpressionStatement(stmt, ctx, t))

  // Return the whole binding handle (not just .marker) so runtime can call flush()
  const newReturn = t.returnStatement(call)
  body.node.body = [...prefix, newReturn]
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

function wrapReactiveExpressionStatement(
  stmt: BabelCore.types.Statement,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): BabelCore.types.Statement {
  if (t.isExpressionStatement(stmt)) {
    const expr = stmt.expression
    if (dependsOnTracked(expr, ctx, t)) {
      ctx.helpersUsed.effect = true
      return t.expressionStatement(
        t.callExpression(t.identifier(RUNTIME_ALIASES.effect), [
          t.arrowFunctionExpression([], transformExpression(expr, ctx, t)),
        ]),
      )
    }
  }
  return stmt
}

function findOwnerPath(path: BabelCore.NodePath): BabelCore.NodePath {
  let current: BabelCore.NodePath | null = path
  while (current) {
    if (current.isFunction() || current.isProgram()) return current
    current = current.parentPath
  }
  return path
}

function ensureContextDeclaration(
  path: BabelCore.NodePath,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  const owner = findOwnerPath(path)
  const ownerNode = owner.node as any

  const ensureBlockBody = (): BabelCore.types.BlockStatement | BabelCore.types.Program => {
    if (t.isProgram(ownerNode)) return ownerNode as BabelCore.types.Program
    if (owner.isFunction() && !t.isBlockStatement(ownerNode.body)) {
      const ret = t.returnStatement(ownerNode.body as any)
      ownerNode.body = t.blockStatement([ret])
    }
    return ownerNode.body as BabelCore.types.BlockStatement
  }

  const body = ensureBlockBody()
  const hasCtxDecl = body.body.some(
    stmt =>
      t.isVariableDeclaration(stmt) &&
      stmt.declarations.some(
        d => t.isIdentifier(d.id) && d.id.name === '__fictCtx' && t.isCallExpression(d.init),
      ),
  )
  if (hasCtxDecl) return

  ctx.helpersUsed.useContext = true
  const ctxDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('__fictCtx'),
      t.callExpression(t.identifier(RUNTIME_ALIASES.useContext), []),
    ),
  ])
  if (t.isProgram(ownerNode)) {
    ;(owner as BabelCore.NodePath<BabelCore.types.Program>).unshiftContainer('body', ctxDecl)
  } else if (owner.isFunction()) {
    ;(owner.get('body') as BabelCore.NodePath<BabelCore.types.BlockStatement>).unshiftContainer(
      'body',
      ctxDecl,
    )
  }
}

function wrapComponentsWithRender(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  if (!ctx.options.fineGrainedDom) return

  const maybeWrap = (fnPath: BabelCore.NodePath<BabelCore.types.Function>) => {
    const node = fnPath.node
    if (!ctx.functionsWithJsx.has(node)) return

    const bodyPath = fnPath.get('body') as BabelCore.NodePath<
      BabelCore.types.BlockStatement | BabelCore.types.Expression
    >
    const bodyNode = bodyPath.node

    const statements: BabelCore.types.Statement[] = t.isBlockStatement(bodyNode)
      ? [...bodyNode.body]
      : [t.returnStatement(bodyNode as BabelCore.types.Expression)]

    const ctxIndex = statements.findIndex(
      stmt =>
        t.isVariableDeclaration(stmt) &&
        stmt.declarations.some(
          d => t.isIdentifier(d.id) && d.id.name === '__fictCtx' && t.isCallExpression(d.init),
        ),
    )
    if (ctxIndex === -1) return

    // Avoid double-wrapping if the function already returns a fragment with __fictRender
    const alreadyWrapped = statements.some(stmt => {
      if (!t.isReturnStatement(stmt) || !stmt.argument) return false
      if (t.isCallExpression(stmt.argument)) {
        return (
          t.isIdentifier(stmt.argument.callee) &&
          stmt.argument.callee.name === RUNTIME_ALIASES.render
        )
      }
      if (!t.isJSXFragment(stmt.argument)) return false
      const children = stmt.argument.children
        .filter(ch => t.isJSXExpressionContainer(ch))
        .map(ch => (ch as BabelCore.types.JSXExpressionContainer).expression)
      return children.some(
        expr =>
          t.isCallExpression(expr) && t.isIdentifier(expr.callee, { name: RUNTIME_ALIASES.render }),
      )
    })
    if (alreadyWrapped) return

    const [ctxDecl] = statements.splice(ctxIndex, 1)
    const renderBody = t.blockStatement(statements)
    const renderFn = t.arrowFunctionExpression([], renderBody)

    ctx.helpersUsed.render = true
    ctx.helpersUsed.fragment = true

    const fragment = t.objectExpression([
      t.objectProperty(t.identifier('type'), t.identifier(RUNTIME_ALIASES.fragment)),
      t.objectProperty(
        t.identifier('props'),
        t.objectExpression([
          t.objectProperty(
            t.identifier('children'),
            t.callExpression(t.identifier(RUNTIME_ALIASES.render), [
              t.identifier('__fictCtx'),
              renderFn,
            ]),
          ),
        ]),
      ),
    ])

    if (fnPath.isArrowFunctionExpression()) {
      fnPath.node.expression = false
    }

    const newBody = t.blockStatement([
      ctxDecl as BabelCore.types.Statement,
      t.returnStatement(fragment),
    ])
    bodyPath.replaceWith(newBody)
  }

  path.traverse({
    FunctionDeclaration: maybeWrap,
    FunctionExpression: maybeWrap,
    ArrowFunctionExpression: maybeWrap,
  })
}

function nextSlot(
  path: BabelCore.NodePath,
  ctx: TransformContext,
  _t: typeof BabelCore.types,
): number {
  const owner = findOwnerPath(path).node
  const current = SLOT_COUNTER.get(owner) ?? 0
  SLOT_COUNTER.set(owner, current + 1)
  ctx.slotCounters.set(owner, current + 1)
  return current
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
 * Compute which outputs would actually be regionized for a set of statements.
 * Mirrors applyRegionTransform's gating (size >= 2, region candidates or fallback).
 */
function computeRegionizableOutputs(
  statements: BabelCore.types.Statement[],
  ctx: TransformContext,
  t: typeof BabelCore.types,
): Set<string> {
  const derivedOutputs = collectDerivedOutputsFromStatements(statements, ctx, t)
  if (derivedOutputs.size < 2) return new Set()

  const outputs = new Set<string>()

  // Primary region detection (same as applyRegionTransform main loop)
  let index = 0
  while (index < statements.length) {
    const region = findNextRegion(statements, derivedOutputs, ctx, t, index)

    if (!region) {
      index++
      continue
    }

    const { start, end, outputs: regionOutputs } = region
    const regionHasReturn = regionContainsEarlyReturn(statements, start, end, t)
    if (regionHasReturn) {
      index = end + 1
      continue
    }

    // Match applyRegionTransform's handling of trailing returns
    let regionEnd = end
    while (regionEnd >= start && t.isReturnStatement(statements[regionEnd]!)) {
      regionEnd--
    }
    if (regionEnd < start) {
      index = end + 1
      continue
    }

    const startAfterRegion = regionEnd + 1
    const referencedOutside = collectReferencedOutputs(
      statements,
      regionOutputs,
      startAfterRegion,
      ctx,
      t,
    )
    const baseActiveOutputs = ctx.options.lazyConditional
      ? regionOutputs
      : referencedOutside.size
        ? referencedOutside
        : regionOutputs
    const activeOutputs = expandActiveOutputsWithDependencies(baseActiveOutputs, regionOutputs, ctx)
    const reassignedLater = hasAssignmentsOutside(statements, activeOutputs, startAfterRegion, t)
    const hasControlFlow = regionHasControlFlow(statements, start, regionEnd, t)
    const hasInternalDeps = outputsHaveInternalDependencies(activeOutputs, ctx)
    if (!reassignedLater && activeOutputs.size >= 2 && (!hasInternalDeps || hasControlFlow)) {
      activeOutputs.forEach(o => outputs.add(o))
    }
    index = end + 1
  }

  if (outputs.size > 0) return outputs

  // Fallback detection (mirrors applyRegionTransform fallback)
  const firstTouched = statements.findIndex(stmt =>
    statementTouchesOutputs(stmt as BabelCore.types.Statement, derivedOutputs, ctx, t),
  )
  const lastTouched = (() => {
    for (let i = statements.length - 1; i >= 0; i--) {
      const stmt = statements[i] as BabelCore.types.Statement | undefined
      if (stmt && statementTouchesOutputs(stmt, derivedOutputs, ctx, t)) return i
    }
    return -1
  })()

  if (firstTouched === -1 || lastTouched === -1 || firstTouched > lastTouched) {
    return new Set()
  }

  if (regionContainsEarlyReturn(statements, firstTouched, lastTouched, t)) {
    return new Set()
  }

  let regionEnd = lastTouched
  while (regionEnd >= firstTouched && t.isReturnStatement(statements[regionEnd]!)) {
    regionEnd--
  }
  if (regionEnd < firstTouched) return new Set()

  const startAfterRegion = regionEnd + 1
  const referencedOutside = collectReferencedOutputs(
    statements,
    derivedOutputs,
    startAfterRegion,
    ctx,
    t,
  )
  const baseActiveOutputs = ctx.options.lazyConditional
    ? derivedOutputs
    : referencedOutside.size
      ? referencedOutside
      : derivedOutputs
  const activeOutputs = expandActiveOutputsWithDependencies(baseActiveOutputs, derivedOutputs, ctx)
  const hasControlFlow = regionHasControlFlow(statements, firstTouched, regionEnd, t)
  const hasInternalDeps = outputsHaveInternalDependencies(activeOutputs, ctx)
  if (activeOutputs.size < 2 || (hasInternalDeps && !hasControlFlow)) return new Set()

  return activeOutputs
}

/**
 * Pre-analyze control flow region outputs BEFORE JSX transformation.
 *
 * This fixes a timing bug where JSX is transformed before region outputs
 * are added to getterOnlyVars. By analyzing all function bodies upfront,
 * we can populate getterOnlyVars so that shorthand properties like { color }
 * are correctly transformed to { color: color() }.
 */
function preAnalyzeRegionOutputs(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  ctx: TransformContext,
  t: typeof BabelCore.types,
): void {
  if (ctx.noMemo) return

  const analyzeFunction = (fnPath: BabelCore.NodePath<BabelCore.types.Function>) => {
    // Respect no-memo scopes (including early directive detection)
    if (ctx.noMemoFunctions.has(fnPath.node as BabelCore.types.Function)) return
    const bodyPath = fnPath.get('body')
    if (
      !Array.isArray(bodyPath) &&
      bodyPath.isBlockStatement() &&
      detectNoMemoDirective(bodyPath as BabelCore.NodePath<BabelCore.types.BlockStatement>, t)
    ) {
      return
    }

    const bodyNode = fnPath.node.body
    if (!t.isBlockStatement(bodyNode)) return

    const statements = bodyNode.body as BabelCore.types.Statement[]
    if (statements.length === 0) return

    const pending = computeRegionizableOutputs(statements, ctx, t)
    if (pending.size === 0) {
      ctx.pendingRegionOutputs.set(fnPath.node as BabelCore.types.Function, new Set())
      return
    }

    // Filter out variables already handled by other mechanisms
    const filtered = new Set<string>()
    pending.forEach(name => {
      if (!ctx.memoVars.has(name) && !ctx.stateVars.has(name) && !ctx.getterOnlyVars.has(name)) {
        filtered.add(name)
      }
    })
    ctx.pendingRegionOutputs.set(fnPath.node as BabelCore.types.Function, filtered)
  }

  // Traverse all function bodies to find control flow region outputs
  path.traverse({
    FunctionDeclaration(fnPath) {
      analyzeFunction(fnPath)
    },
    FunctionExpression(fnPath) {
      analyzeFunction(fnPath)
    },
    ArrowFunctionExpression(fnPath) {
      analyzeFunction(fnPath)
    },
  })
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

  // Don't transform left-hand side of assignments
  // This is important for pendingRegionOutputs like `color = 'red'`
  if (t.isAssignmentExpression(parent) && parent.left === path.node) return false

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
  addHelper('bindRef')
  addHelper('toNodeArray')
  addHelper('createKeyedListContainer')
  addHelper('createKeyedBlock')
  addHelper('moveMarkerBlock')
  addHelper('destroyMarkerBlock')
  addHelper('getFirstNodeAfter')
  addHelper('useContext')
  addHelper('useSignal')
  addHelper('useMemo')
  addHelper('useEffect')
  addHelper('render')
  addHelper('fragment')
  addHelper('template')

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

    // Skip regions that contain early returns - region memo would capture return values/JSX
    if (regionContainsEarlyReturn(statements as BabelCore.types.Statement[], start, end, t)) {
      for (let i = start; i <= end; i++) {
        result.push(statements[i] as BabelCore.types.Statement)
      }
      index = end + 1
      continue
    }

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
    const baseActiveOutputs = ctx.options.lazyConditional
      ? outputs
      : referencedOutside.size
        ? referencedOutside
        : outputs
    const activeOutputs = expandActiveOutputsWithDependencies(baseActiveOutputs, outputs, ctx)

    const reassignedLater = hasAssignmentsOutside(
      statements as BabelCore.types.Statement[],
      activeOutputs,
      startAfterRegion,
      t,
    )
    const hasControlFlow = regionHasControlFlow(
      statements as BabelCore.types.Statement[],
      start,
      regionEnd,
      t,
    )
    const hasInternalDeps = outputsHaveInternalDependencies(activeOutputs, ctx)
    if (reassignedLater || activeOutputs.size < 2 || (hasInternalDeps && !hasControlFlow)) {
      for (let i = start; i <= end; i++) {
        result.push(statements[i] as BabelCore.types.Statement)
      }
      index = end + 1
      continue
    }

    const analysisStatements = cloneRegionStatements(
      statements as BabelCore.types.Statement[],
      start,
      statements.length - 1,
      t,
      outputs,
    )
    const regionStatements = cloneRegionStatements(
      statements as BabelCore.types.Statement[],
      start,
      regionEnd,
      t,
      outputs,
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

  if (
    regionContainsEarlyReturn(
      statements as BabelCore.types.Statement[],
      firstTouched,
      lastTouched,
      t,
    )
  ) {
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
  const baseActiveOutputs = ctx.options.lazyConditional
    ? derivedOutputs
    : referencedOutside.size
      ? referencedOutside
      : derivedOutputs
  const activeOutputs = expandActiveOutputsWithDependencies(baseActiveOutputs, derivedOutputs, ctx)
  const hasControlFlow = regionHasControlFlow(
    statements as BabelCore.types.Statement[],
    firstTouched,
    regionEnd,
    t,
  )
  const hasInternalDeps = outputsHaveInternalDependencies(activeOutputs, ctx)
  if (activeOutputs.size < 2 || (hasInternalDeps && !hasControlFlow)) return

  const before = (statements as BabelCore.types.Statement[]).slice(0, firstTouched)
  const analysisStatements = cloneRegionStatements(
    statements as BabelCore.types.Statement[],
    firstTouched,
    statements.length - 1,
    t,
    activeOutputs,
  )
  const regionStatements = cloneRegionStatements(
    statements as BabelCore.types.Statement[],
    firstTouched,
    regionEnd,
    t,
    activeOutputs,
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
  outputsToUncall?: Set<string>,
): BabelCore.types.Statement[] {
  const slice = statements
    .slice(start, end + 1)
    .map(stmt => t.cloneNode(stmt, true)) as BabelCore.types.Statement[]
  return slice.map(stmt => {
    const stripped = stripMemoFromStatement(stmt, t)
    if (outputsToUncall && outputsToUncall.size) {
      stripGetterCallsFromStatement(stripped, outputsToUncall, t)
    }
    return stripped
  })
}

/**
 * When a derived output is promoted into a region memo callback, the output becomes a local
 * value within that callback. However, earlier compilation phases may have already rewritten
 * output reads to accessor calls (e.g. `doubled()`).
 *
 * This pass rewrites `outputName()` -> `outputName` for region-local outputs so the region
 * callback remains valid JS (and preserves semantics).
 */
function stripGetterCallsFromStatement(
  stmt: BabelCore.types.Statement,
  outputs: Set<string>,
  t: typeof BabelCore.types,
): void {
  const visitNode = (node: BabelCore.types.Node): BabelCore.types.Node => {
    // Replace `output()` with `output`
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee) &&
      outputs.has(node.callee.name) &&
      node.arguments.length === 0
    ) {
      return t.identifier(node.callee.name)
    }

    // Skip function bodies
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return node
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          const c = child[i]
          if (c && typeof c === 'object' && 'type' in c && typeof (c as any).type === 'string') {
            child[i] = visitNode(c as unknown as BabelCore.types.Node) as any
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as any).type === 'string'
      ) {
        ;(node as any)[key] = visitNode(child as unknown as BabelCore.types.Node) as any
      }
    }

    return node
  }

  visitNode(stmt)
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

/**
 * When only a subset of region outputs are referenced outside the region, we still need to
 * include any *internal derived dependencies* among outputs (e.g. fourfold depends on doubled).
 *
 * Otherwise the primary region pass may skip region creation (activeOutputs.size < 2), causing
 * the fallback to group a larger span and potentially pull consumers/side effects into the memo.
 */
function expandActiveOutputsWithDependencies(
  initial: Set<string>,
  regionOutputs: Set<string>,
  ctx: TransformContext,
): Set<string> {
  const expanded = new Set<string>(initial)

  let changed = true
  while (changed) {
    changed = false
    for (const out of Array.from(expanded)) {
      const deps = ctx.dependencyGraph.get(out)
      if (!deps) continue
      for (const dep of deps) {
        if (regionOutputs.has(dep) && !expanded.has(dep)) {
          expanded.add(dep)
          changed = true
        }
      }
    }
  }

  return expanded
}

/**
 * If any output depends on another output within the same set, we should not group them into a
 * region memo; otherwise dependent outputs lose their own memo wrappers (e.g. derived-of-derived).
 */
function outputsHaveInternalDependencies(outputs: Set<string>, ctx: TransformContext): boolean {
  for (const out of outputs) {
    const deps = ctx.dependencyGraph.get(out)
    if (!deps) continue
    for (const dep of deps) {
      if (outputs.has(dep)) {
        return true
      }
    }
  }
  return false
}

function regionHasControlFlow(
  statements: BabelCore.types.Statement[],
  start: number,
  end: number,
  t: typeof BabelCore.types,
): boolean {
  const visit = (node: BabelCore.types.Node): boolean => {
    if (
      t.isIfStatement(node) ||
      t.isSwitchStatement(node) ||
      t.isWhileStatement(node) ||
      t.isDoWhileStatement(node) ||
      t.isForStatement(node) ||
      t.isForOfStatement(node) ||
      t.isForInStatement(node) ||
      t.isConditionalExpression(node) ||
      t.isLogicalExpression(node)
    ) {
      return true
    }

    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object' && 'type' in c && typeof c.type === 'string') {
            if (visit(c as BabelCore.types.Node)) return true
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof child.type === 'string'
      ) {
        if (visit(child as BabelCore.types.Node)) return true
      }
    }
    return false
  }

  for (let i = start; i <= end; i++) {
    const stmt = statements[i]
    if (stmt && visit(stmt)) return true
  }
  return false
}

function regionContainsEarlyReturn(
  statements: BabelCore.types.Statement[],
  start: number,
  end: number,
  t: typeof BabelCore.types,
): boolean {
  for (let i = start; i <= end; i++) {
    const stmt = statements[i]
    if (stmt && statementHasEarlyReturn(stmt, t)) return true
  }
  return false
}

function statementHasEarlyReturn(
  stmt: BabelCore.types.Statement,
  t: typeof BabelCore.types,
): boolean {
  let hasReturn = false
  const visit = (node: BabelCore.types.Node): void => {
    if (hasReturn) return
    if (t.isReturnStatement(node) || t.isThrowStatement(node)) {
      hasReturn = true
      return
    }
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return
    }
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object' && 'type' in c && typeof c.type === 'string') {
            visit(c as BabelCore.types.Node)
          }
        }
      } else if (
        child &&
        typeof child === 'object' &&
        'type' in child &&
        typeof (child as { type: unknown }).type === 'string'
      ) {
        visit(child as BabelCore.types.Node)
      }
    }
  }
  visit(stmt)
  return hasReturn
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
