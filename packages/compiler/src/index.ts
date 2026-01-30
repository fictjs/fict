import type * as BabelCore from '@babel/core'
import { declare } from '@babel/helper-plugin-utils'

import { SAFE_FUNCTIONS } from './constants'
import { debugLog } from './debug'
import { buildHIR } from './ir/build-hir'
import { lowerHIRWithRegions } from './ir/codegen'
import { optimizeHIR } from './ir/optimize'
import type { CompilerWarning, FictCompilerOptions } from './types'
import { getRootIdentifier, isEffectCall, isMemoCall, isStateCall } from './utils'

export type { FictCompilerOptions, CompilerWarning } from './types'

function stripMacroImports(
  path: BabelCore.NodePath<BabelCore.types.Program>,
  t: typeof BabelCore.types,
): void {
  path.traverse({
    ImportDeclaration(importPath) {
      if (importPath.node.source.value !== 'fict' && importPath.node.source.value !== 'fict/slim')
        return
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

function isInsideJSX(path: BabelCore.NodePath): boolean {
  return !!path.findParent(p => p.isJSXElement?.() || p.isJSXFragment?.())
}

type WarningSink = (warning: CompilerWarning) => void

interface SuppressionDirective {
  line: number
  nextLine: boolean
  codes?: Set<string>
}

function parseSuppressionCodes(raw?: string): Set<string> | undefined {
  if (!raw) return undefined
  const codes = raw
    .split(/[,\s]+/)
    .map(c => c.trim())
    .filter(Boolean)
  return codes.length > 0 ? new Set(codes) : undefined
}

function parseSuppressions(
  comments: readonly BabelCore.types.Comment[] | null | undefined,
): SuppressionDirective[] {
  if (!comments) return []
  const suppressions: SuppressionDirective[] = []
  for (const comment of comments) {
    const match = comment.value.match(/fict-ignore(-next-line)?(?:\s+(.+))?/i)
    if (!match || !comment.loc) continue
    suppressions.push({
      line: comment.loc.start.line,
      nextLine: !!match[1],
      codes: parseSuppressionCodes(match[2]),
    })
  }
  return suppressions
}

function shouldSuppressWarning(
  suppressions: SuppressionDirective[],
  code: string,
  line: number,
): boolean {
  return suppressions.some(entry => {
    const targetLine = entry.nextLine ? entry.line + 1 : entry.line
    if (targetLine !== line) return false
    if (!entry.codes || entry.codes.size === 0) return true
    return entry.codes.has(code)
  })
}

type WarningLevel = 'off' | 'warn' | 'error'

function hasErrorEscalation(options: FictCompilerOptions): boolean {
  if (options.warningsAsErrors === true) return true
  if (Array.isArray(options.warningsAsErrors) && options.warningsAsErrors.length > 0) return true
  if (options.warningLevels) {
    return Object.values(options.warningLevels).some(level => level === 'error')
  }
  return false
}

function resolveWarningLevel(code: string, options: FictCompilerOptions): WarningLevel {
  const override = options.warningLevels?.[code]
  if (override) return override
  if (options.warningsAsErrors === true) return 'error'
  if (Array.isArray(options.warningsAsErrors) && options.warningsAsErrors.includes(code)) {
    return 'error'
  }
  return 'warn'
}

function formatWarningAsError(warning: CompilerWarning): string {
  const location =
    warning.line > 0 ? `${warning.fileName}:${warning.line}:${warning.column}` : warning.fileName
  return `Fict warning treated as error (${warning.code}): ${warning.message}\n  at ${location}`
}

function createWarningDispatcher(
  onWarn: FictCompilerOptions['onWarn'],
  suppressions: SuppressionDirective[],
  options: FictCompilerOptions,
  dev: boolean,
): WarningSink {
  const hasEscalation = hasErrorEscalation(options)
  if (!dev && !hasEscalation) return () => {}
  return warning => {
    if (shouldSuppressWarning(suppressions, warning.code, warning.line)) return
    const level = resolveWarningLevel(warning.code, options)
    if (level === 'off') return
    if (level === 'error') {
      throw new Error(formatWarningAsError(warning))
    }
    if (dev && onWarn) {
      onWarn(warning)
    }
  }
}

function emitWarning(
  node: BabelCore.types.Node,
  code: string,
  message: string,
  warn: WarningSink,
  fileName: string,
): void {
  const loc = node.loc?.start
  warn({
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
  warn: WarningSink,
  fileName: string,
  t: typeof BabelCore.types,
): void {
  const isStateRoot = (expr: BabelCore.types.Expression): boolean => {
    const root = getRootIdentifier(expr, t)
    return !!(root && stateVars.has(root.name))
  }
  const reactiveNames = new Set<string>([...stateVars, ...derivedVars])

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
            warn,
            fileName,
          )
          if (isDynamicPropertyAccess(left as any, t)) {
            emitWarning(
              path.node,
              'FICT-H',
              'Dynamic property access widens dependency tracking',
              warn,
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
            warn,
            fileName,
          )
          if (isDynamicPropertyAccess(arg as any, t)) {
            emitWarning(
              path.node,
              'FICT-H',
              'Dynamic property access widens dependency tracking',
              warn,
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
          warn,
          fileName,
        )
      }
    },
    Function(path) {
      const captured = new Set<string>()
      path.traverse(
        {
          Function(inner) {
            if (inner === path) return
            inner.skip()
          },
          Identifier(idPath) {
            const name = idPath.node.name
            if (!reactiveNames.has(name)) return
            const binding = idPath.scope.getBinding(name)
            if (!binding) return
            if (binding.scope === idPath.scope || binding.scope === path.scope) return
            captured.add(name)
          },
        },
        {},
      )
      if (captured.size > 0) {
        emitWarning(
          path.node,
          'FICT-R005',
          `Function captures reactive variable(s): ${Array.from(captured).join(', ')}. Pass them as parameters or memoize explicitly to avoid hidden dependencies.`,
          warn,
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
              warn,
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
            warn,
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
          warn,
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
        const comments =
          ((path.hub as any)?.file?.ast as BabelCore.types.File | undefined)?.comments || []
        const suppressions = parseSuppressions(comments)
        const dev = options.dev !== false
        const warn = createWarningDispatcher(options.onWarn, suppressions, options, dev)
        const optionsWithWarnings: FictCompilerOptions = {
          ...options,
          onWarn: warn,
          filename: fileName,
        }
        const isHookName = (name: string | undefined): boolean => !!name && /^use[A-Z]/.test(name)
        // Reactive scopes: function calls whose callbacks are treated as component-like contexts
        const reactiveScopesSet = new Set(options.reactiveScopes ?? [])

        const resolveReactiveScopeName = (
          callee: BabelCore.types.Expression | BabelCore.types.V8IntrinsicIdentifier,
        ): string | null => {
          if (reactiveScopesSet.size === 0) return null
          if (t.isIdentifier(callee)) {
            return reactiveScopesSet.has(callee.name) ? callee.name : null
          }
          if (
            (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
            !callee.computed &&
            t.isIdentifier(callee.property)
          ) {
            return reactiveScopesSet.has(callee.property.name) ? callee.property.name : null
          }
          return null
        }

        // Check if a function is a callback argument to a reactive scope call
        const isReactiveScopeCallback = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean => {
          if (reactiveScopesSet.size === 0) return false
          const parent = fnPath.parentPath
          if (!parent || !(parent.isCallExpression() || parent.isOptionalCallExpression())) {
            return false
          }
          // Check if the function is the first argument
          if (parent.node.arguments[0] !== fnPath.node) return false
          const callee = parent.node.callee
          return !!resolveReactiveScopeName(callee as any)
        }

        // Check if a function node is a reactive scope callback
        const isReactiveScopeCallbackNode = (
          fnNode: BabelCore.types.Function,
          parentNode: BabelCore.types.Node | null | undefined,
        ): boolean => {
          if (reactiveScopesSet.size === 0) return false
          if (!parentNode) return false
          if (!t.isCallExpression(parentNode) && !t.isOptionalCallExpression(parentNode)) {
            return false
          }
          // Check if the function is the first argument
          if (parentNode.arguments[0] !== fnNode) return false
          return !!resolveReactiveScopeName(parentNode.callee as any)
        }

        // Local version of isInsideNestedFunction that respects reactive scope boundaries.
        // Reactive scope callbacks are treated as depth 1 (outermost function), so $state inside
        // them is not considered "nested" as long as it's directly in the callback body.
        const isInsideNestedFunctionWithReactiveScopes = (
          nodePath: BabelCore.NodePath,
        ): boolean => {
          let depth = 0
          let current: BabelCore.NodePath | null = nodePath
          while (current) {
            if (current.isFunction?.()) {
              depth++
              // If this function is a reactive scope callback, treat it as the root boundary.
              // Nested functions inside it should still be considered "nested".
              if (
                isReactiveScopeCallbackNode(
                  current.node as BabelCore.types.Function,
                  current.parentPath?.node,
                )
              ) {
                return depth > 1
              }
              if (depth > 1) return true
            }
            current = current.parentPath
          }
          return false
        }

        const getFunctionName = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): string | undefined => {
          return fnPath.isFunctionDeclaration() && fnPath.node.id
            ? fnPath.node.id.name
            : fnPath.isFunctionExpression() && fnPath.node.id
              ? fnPath.node.id.name
              : fnPath.parentPath.isVariableDeclarator() &&
                  t.isIdentifier(fnPath.parentPath.node.id) &&
                  fnPath.parentPath.node.init === fnPath.node
                ? fnPath.parentPath.node.id.name
                : undefined
        }
        const isComponentDefinition = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean => {
          const name = getFunctionName(fnPath)
          return (name && isComponentName(name)) || functionHasJSX(fnPath)
        }
        const isHookDefinition = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean => {
          const name = getFunctionName(fnPath)
          return isHookName(name)
        }
        const isComponentOrHookDefinition = (
          fnPath: BabelCore.NodePath<BabelCore.types.Function>,
        ): boolean =>
          isComponentDefinition(fnPath) ||
          isHookDefinition(fnPath) ||
          isReactiveScopeCallback(fnPath)
        const isComponentLike = (fnPath: BabelCore.NodePath<BabelCore.types.Function>): boolean => {
          const name = getFunctionName(fnPath)
          return (
            (name && isComponentName(name)) ||
            isHookName(name) ||
            functionHasJSX(fnPath) ||
            functionUsesStateLike(fnPath, t)
          )
        }
        const memoHasSideEffects = (
          fn: BabelCore.types.ArrowFunctionExpression | BabelCore.types.FunctionExpression,
        ): boolean => {
          const pureCalls = new Set(
            Array.from(SAFE_FUNCTIONS).filter(
              name => !name.startsWith('console.') && name !== 'Math.random',
            ),
          )
          const effectfulCalls = new Set([
            '$effect',
            'render',
            'fetch',
            'setTimeout',
            'setInterval',
            'clearTimeout',
            'clearInterval',
            'requestAnimationFrame',
            'cancelAnimationFrame',
          ])
          const getCalleeName = (
            callee: BabelCore.types.Expression | BabelCore.types.V8IntrinsicIdentifier,
          ): string | null => {
            if (t.isIdentifier(callee)) return callee.name
            if (
              t.isMemberExpression(callee) &&
              !callee.computed &&
              t.isIdentifier(callee.property) &&
              t.isIdentifier(callee.object)
            ) {
              return `${callee.object.name}.${callee.property.name}`
            }
            return null
          }
          const mutatingMemberProps = new Set([
            'push',
            'pop',
            'splice',
            'shift',
            'unshift',
            'sort',
            'reverse',
            'set',
            'add',
            'delete',
            'append',
            'appendChild',
            'remove',
            'removeChild',
            'setAttribute',
            'dispatchEvent',
            'replaceChildren',
            'replaceWith',
          ])
          const isEffectfulCall = (node: BabelCore.types.CallExpression): boolean => {
            const name = getCalleeName(node.callee)
            if (!name) return true
            if (pureCalls.has(name)) return false
            if (effectfulCalls.has(name)) return true
            if (
              name.startsWith('console.') ||
              name.startsWith('document.') ||
              name.startsWith('window.')
            ) {
              return true
            }
            if (
              t.isMemberExpression(node.callee) &&
              !node.callee.computed &&
              t.isIdentifier(node.callee.property)
            ) {
              const prop = node.callee.property.name
              if (mutatingMemberProps.has(prop)) return true
              if (
                t.isIdentifier(node.callee.object) &&
                (node.callee.object.name === 'document' || node.callee.object.name === 'window')
              ) {
                return true
              }
            }
            return false
          }
          const checkNode = (node: BabelCore.types.Node | null | undefined): boolean => {
            if (!node) return false
            if (
              t.isAssignmentExpression(node) ||
              t.isUpdateExpression(node) ||
              t.isThrowStatement(node) ||
              t.isNewExpression(node)
            ) {
              return true
            }
            if (t.isCallExpression(node) && isEffectfulCall(node)) {
              return true
            }
            if (t.isAwaitExpression(node)) return true
            if (t.isExpressionStatement(node)) return checkNode(node.expression)
            if (t.isBlockStatement(node)) return node.body.some(stmt => checkNode(stmt))
            if (t.isReturnStatement(node)) return checkNode(node.argument as any)
            if (t.isSequenceExpression(node)) return node.expressions.some(expr => checkNode(expr))
            if (t.isConditionalExpression(node))
              return (
                checkNode(node.test as any) ||
                checkNode(node.consequent as any) ||
                checkNode(node.alternate as any)
              )
            if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
              return checkNode(node.body as any)
            }
            return false
          }
          return checkNode(fn.body as any)
        }

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
              warn,
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
              warn,
              fileName,
            )
          },
        })
        // Collect macro imports from fict
        const fictImports = new Set<string>()
        const stateMacroNames = new Set<string>(['$state'])
        const effectMacroNames = new Set<string>(['$effect'])
        const memoMacroNames = new Set<string>(['$memo', 'createMemo'])
        path.traverse({
          ImportDeclaration(importPath) {
            if (
              importPath.node.source.value !== 'fict' &&
              importPath.node.source.value !== 'fict/slim'
            )
              return
            for (const spec of importPath.node.specifiers) {
              if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported)) {
                fictImports.add(spec.imported.name)
                if (spec.imported.name === '$state' && t.isIdentifier(spec.local)) {
                  stateMacroNames.add(spec.local.name)
                }
                if (spec.imported.name === '$effect' && t.isIdentifier(spec.local)) {
                  effectMacroNames.add(spec.local.name)
                }
                if (
                  (spec.imported.name === '$memo' || spec.imported.name === 'createMemo') &&
                  t.isIdentifier(spec.local)
                ) {
                  memoMacroNames.add(spec.local.name)
                }
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

            warn({
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
            if (isStateCall(init, t, stateMacroNames)) {
              // Check if $state is imported from fict
              if (!fictImports.has('$state')) {
                throw varPath.buildCodeFrameError(
                  `$state() must be imported from "fict".\n\n` +
                    `Add this import at the top of your file:\n` +
                    `  import { $state } from 'fict'`,
                )
              }
              if (!t.isIdentifier(varPath.node.id)) {
                throw varPath.buildCodeFrameError(
                  `Destructuring $state is not supported.\n\n` +
                    `Instead of:  const { a, b } = $state({ a: 1, b: 2 })\n` +
                    `Use:         let state = $state({ a: 1, b: 2 })\n` +
                    `             const { a, b } = state  // read-only aliases\n\n` +
                    `For deep reactivity, consider using $store from 'fict'.`,
                )
              }
              const ownerComponent = varPath.getFunctionParent()
              if (!ownerComponent || !isComponentOrHookDefinition(ownerComponent as any)) {
                throw varPath.buildCodeFrameError(
                  `$state() must be declared inside a component or hook function body.\n\n` +
                    `For module-level shared state, use one of these alternatives:\n` +
                    `  • $store from 'fict' - for deep reactive objects\n` +
                    `  • createSignal from 'fict/advanced' - for primitives`,
                )
              }
              stateVars.add(varPath.node.id.name)
              if (isInsideLoop(varPath) || isInsideConditional(varPath)) {
                throw varPath.buildCodeFrameError(
                  `$state() cannot be declared inside loops or conditionals.\n\n` +
                    `Signals must be created at the top level of components for stable identity.\n` +
                    `Move the $state() declaration before the loop/condition.`,
                )
              }
              if (isInsideNestedFunctionWithReactiveScopes(varPath)) {
                throw varPath.buildCodeFrameError(
                  `$state() cannot be declared inside nested functions.\n\n` +
                    `Move the $state() declaration to the component's top level,\n` +
                    `or extract the nested logic into a custom hook (useXxx).`,
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
          Function(fnPath) {
            const parentFn = fnPath.getFunctionParent()
            if (!parentFn) return
            if (!isComponentLike(parentFn as any)) return
            if (!isComponentLike(fnPath as any)) return
            emitWarning(
              fnPath.node,
              'FICT-C003',
              'Components should not be defined inside other components. Move this definition to module scope to preserve identity and performance.',
              warn,
              fileName,
            )
          },
          CallExpression(callPath) {
            if (isStateCall(callPath.node, t, stateMacroNames)) {
              const parentPath = callPath.parentPath
              const isVariableDeclarator =
                parentPath?.isVariableDeclarator() && parentPath.node.init === callPath.node

              if (!isVariableDeclarator) {
                throw callPath.buildCodeFrameError(
                  `$state() must be assigned directly to a variable.\n\n` +
                    `Correct usage:\n` +
                    `  let count = $state(0)\n` +
                    `  let user = $state({ name: 'Alice' })\n\n` +
                    `For object state with deep reactivity, consider:\n` +
                    `  import { $store } from 'fict'\n` +
                    `  const user = $store({ name: 'Alice', address: { city: 'NYC' } })`,
                )
              }

              if (!t.isIdentifier(parentPath.node.id)) {
                throw callPath.buildCodeFrameError(
                  `Destructuring $state is not supported.\n\n` +
                    `Instead of:  const { a, b } = $state({ a: 1, b: 2 })\n` +
                    `Use:         let state = $state({ a: 1, b: 2 })\n` +
                    `             const { a, b } = state  // read-only aliases`,
                )
              }

              const ownerComponent = callPath.getFunctionParent()
              if (!ownerComponent || !isComponentOrHookDefinition(ownerComponent as any)) {
                throw callPath.buildCodeFrameError(
                  `$state() must be declared inside a component or hook function body.\n\n` +
                    `For module-level shared state, use one of these alternatives:\n` +
                    `  • $store from 'fict' - for deep reactive objects\n` +
                    `  • createSignal from 'fict/advanced' - for primitives`,
                )
              }
              if (isInsideLoop(callPath) || isInsideConditional(callPath)) {
                throw callPath.buildCodeFrameError(
                  `$state() cannot be declared inside loops or conditionals.\n\n` +
                    `Move the declaration to the top of your component.\n` +
                    `For dynamic collections, consider using $store with an array/object.`,
                )
              }
              if (isInsideNestedFunctionWithReactiveScopes(callPath)) {
                throw callPath.buildCodeFrameError(
                  `$state() cannot be declared inside nested functions.\n\n` +
                    `Move the declaration to the component's top level,\n` +
                    `or extract the nested logic into a custom hook (useXxx).`,
                )
              }
            }
            if (isEffectCall(callPath.node, t, effectMacroNames)) {
              // Check if $effect is imported from fict
              if (!fictImports.has('$effect')) {
                throw callPath.buildCodeFrameError(
                  `$effect() must be imported from "fict".\n\n` +
                    `Add this import at the top of your file:\n` +
                    `  import { $effect } from 'fict'`,
                )
              }
              if (isInsideLoop(callPath) || isInsideConditional(callPath)) {
                throw callPath.buildCodeFrameError(
                  `$effect() cannot be called inside loops or conditionals.\n\n` +
                    `Effects must be registered at the top level of components.\n` +
                    `For conditional effects, use a condition inside the effect body instead:\n` +
                    `  $effect(() => { if (condition) { /* ... */ } })`,
                )
              }
              if (isInsideNestedFunctionWithReactiveScopes(callPath)) {
                throw callPath.buildCodeFrameError(
                  `$effect() cannot be called inside nested functions.\n\n` +
                    `Move the effect to the component's top level,\n` +
                    `or extract the nested logic into a custom hook (useXxx).`,
                )
              }
            }
            const callee = callPath.node.callee
            const calleeId = t.isIdentifier(callee) ? callee.name : null
            if (
              calleeId &&
              (calleeId === 'createEffect' ||
                calleeId === 'createMemo' ||
                calleeId === 'createSelector') &&
              fictImports.has(calleeId) &&
              (isInsideLoop(callPath) || isInsideConditional(callPath)) &&
              !isInsideJSX(callPath)
            ) {
              emitWarning(
                callPath.node,
                'FICT-R004',
                'Reactive creation inside non-JSX control flow will not auto-dispose; wrap it in createScope/runInScope or move it into JSX-managed regions.',
                warn,
                fileName,
              )
            }
            if (calleeId && isHookName(calleeId)) {
              const binding = callPath.scope.getBinding(calleeId)
              const bindingPath = binding?.path
              const bindingIsHook =
                (!bindingPath && isHookName(calleeId)) ||
                bindingPath?.isImportSpecifier() ||
                bindingPath?.isImportDefaultSpecifier() ||
                (bindingPath?.isFunctionDeclaration() &&
                  isHookDefinition(bindingPath as unknown as BabelCore.NodePath<any>)) ||
                (bindingPath?.isVariableDeclarator() &&
                  (() => {
                    const init = (bindingPath as any).get?.('init') as
                      | BabelCore.NodePath<BabelCore.types.Function>
                      | undefined
                    return init ? isHookDefinition(init as any) : false
                  })())

              if (bindingIsHook) {
                const ownerFunction = callPath.getFunctionParent()
                if (!ownerFunction || !isComponentOrHookDefinition(ownerFunction as any)) {
                  throw callPath.buildCodeFrameError(
                    `${calleeId}() must be called inside a component or hook (useX)`,
                  )
                }
                if (
                  isInsideLoop(callPath) ||
                  isInsideConditional(callPath) ||
                  isInsideNestedFunctionWithReactiveScopes(callPath)
                ) {
                  throw callPath.buildCodeFrameError(
                    `${calleeId}() must be called at the top level of a component or hook (no loops/conditions/nested functions)`,
                  )
                }
              }
            }
            const allowedStateCallees = new Set<string>([
              ...effectMacroNames,
              ...memoMacroNames,
              'render',
              'createMemo',
              'createEffect',
            ])
            callPath.node.arguments.forEach(arg => {
              if (
                t.isIdentifier(arg) &&
                stateVars.has(arg.name) &&
                (!calleeId || !allowedStateCallees.has(calleeId))
              ) {
                const loc = arg.loc?.start ?? callPath.node.loc?.start
                warn({
                  code: 'FICT-S002',
                  message:
                    'State variable is passed as an argument; this passes a value snapshot and may escape component scope.',
                  fileName,
                  line: loc?.line ?? 0,
                  column: loc ? loc.column + 1 : 0,
                })
              }
            })
            if (
              isMemoCall(callPath.node, t, memoMacroNames) &&
              (fictImports.has('$memo') || fictImports.has('createMemo'))
            ) {
              const firstArg = callPath.node.arguments[0]
              if (
                firstArg &&
                (t.isArrowFunctionExpression(firstArg) || t.isFunctionExpression(firstArg)) &&
                memoHasSideEffects(firstArg)
              ) {
                const loc = firstArg.loc?.start ?? callPath.node.loc?.start
                warn({
                  code: 'FICT-M003',
                  message: 'Memo should not contain side effects.',
                  fileName,
                  line: loc?.line ?? 0,
                  column: loc ? loc.column + 1 : 0,
                })
              }
            }
          },
        })

        // Validate alias reassignments now that state variables are known
        const aliasStack: Set<string>[] = [new Set()]
        const currentAliasSet = () => aliasStack[aliasStack.length - 1]
        const rhsUsesState = (exprPath: BabelCore.NodePath | null | undefined): boolean => {
          if (!exprPath) return false
          if (
            exprPath.isIdentifier() &&
            t.isIdentifier(exprPath.node) &&
            stateVars.has(exprPath.node.name)
          ) {
            return true
          }
          let usesState = false
          exprPath.traverse({
            Identifier(idPath: BabelCore.NodePath<BabelCore.types.Identifier>) {
              if (stateVars.has(idPath.node.name)) {
                usesState = true
                idPath.stop()
              }
            },
          })
          return usesState
        }
        debugLog('alias', 'state vars', Array.from(stateVars))
        path.traverse({
          Function: {
            enter() {
              aliasStack.push(new Set())
            },
            exit() {
              aliasStack.pop()
            },
          },
          VariableDeclarator(varPath) {
            const aliasSet = currentAliasSet()
            if (
              aliasSet &&
              t.isIdentifier(varPath.node.id) &&
              rhsUsesState(varPath.get('init') as any)
            ) {
              debugLog('alias', 'add from decl', varPath.node.id.name)
              aliasSet.add(varPath.node.id.name)
            }
          },
          AssignmentExpression(assignPath) {
            const aliasSet = currentAliasSet()
            if (!aliasSet) return
            const rightPath = assignPath.get('right') as BabelCore.NodePath | null
            const usesState = rhsUsesState(rightPath)
            const left = assignPath.node.left
            if (t.isIdentifier(left)) {
              const targetName = left.name
              if (usesState) {
                debugLog('alias', 'add from assign', targetName)
                aliasSet.add(targetName)
                return
              }
              if (aliasSet.has(targetName)) {
                debugLog('alias', 'reassignment detected', targetName)
                throw assignPath.buildCodeFrameError(
                  `Alias reassignment is not supported for "${targetName}"`,
                )
              }
              return
            }
            if (t.isObjectPattern(left) || t.isArrayPattern(left)) {
              const targets = collectPatternIdentifiers(left)
              if (targets.length === 0) return
              if (usesState) {
                for (const target of targets) {
                  debugLog('alias', 'add from destructuring assign', target)
                  aliasSet.add(target)
                }
                return
              }
              const reassigned = targets.find(target => aliasSet.has(target))
              if (reassigned) {
                debugLog('alias', 'reassignment detected', reassigned)
                throw assignPath.buildCodeFrameError(
                  `Alias reassignment is not supported for "${reassigned}"`,
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
              if (t.isObjectPattern(left) || t.isArrayPattern(left)) {
                const targets = collectPatternIdentifiers(left)
                const derivedTarget = targets.find(target => derivedVars.has(target))
                if (derivedTarget) {
                  throw assignPath.buildCodeFrameError(
                    `Cannot reassign derived value '${derivedTarget}'. Derived values are read-only.`,
                  )
                }
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
              if (t.isObjectPattern(left) || t.isArrayPattern(left)) {
                const targets = collectPatternIdentifiers(left)
                const aliasTarget = targets.find(target => destructuredAliases.has(target))
                if (aliasTarget) {
                  throw assignPath.buildCodeFrameError(
                    `Cannot write to destructured state alias '${aliasTarget}'. Update the original state (e.g. state.count++ or immutable update).`,
                  )
                }
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
        const shouldRunWarnings = dev || hasErrorEscalation(options)
        if (shouldRunWarnings) {
          runWarningPass(path as any, stateVars, derivedVars, warn, fileName, t)
        }

        // NOTE: Reactive scope callbacks (like renderHook(() => {...})) are NOT hoisted.
        // They stay inline to preserve closure semantics. The HIR builder already processes
        // nested arrow/function expressions via convertFunction, which handles $state/$effect.
        // The isInsideNestedFunctionWithReactiveScopes validation allows $state/$effect
        // inside reactive scope callbacks.

        const fileAst = t.file(path.node)
        const hir = buildHIR(
          fileAst,
          {
            state: stateMacroNames,
            effect: effectMacroNames,
          },
          {
            dev,
            fileName,
            onWarn: warn,
            reactiveScopes: reactiveScopesSet,
          },
        )
        const optimized = optionsWithWarnings.optimize
          ? optimizeHIR(hir, {
              memoMacroNames,
              inlineDerivedMemos: optionsWithWarnings.inlineDerivedMemos ?? true,
              optimizeLevel: optionsWithWarnings.optimizeLevel ?? 'safe',
            })
          : hir
        const lowered = lowerHIRWithRegions(optimized, t, optionsWithWarnings, {
          state: stateMacroNames,
          effect: effectMacroNames,
          memo: memoMacroNames,
        })

        path.node.body = lowered.program.body
        path.node.directives = lowered.program.directives

        if (!process.env.FICT_SKIP_SCOPE_CRAWL) {
          path.scope.crawl()
        }
        stripMacroImports(path as any, t)
      },
    },
  }
}

export const createFictPlugin = declare(
  (api, options: FictCompilerOptions = {}): BabelCore.PluginObj => {
    api.assertVersion(7)
    const t = api.types as typeof BabelCore.types
    const normalizedOptions: FictCompilerOptions = {
      ...options,
      fineGrainedDom: options.fineGrainedDom ?? true,
      optimize: options.optimize ?? true,
      optimizeLevel: options.optimizeLevel ?? 'safe',
      inlineDerivedMemos: options.inlineDerivedMemos ?? true,
      emitModuleMetadata: options.emitModuleMetadata ?? 'auto',
      dev:
        options.dev ?? (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'),
    }

    return {
      name: 'fict-compiler-hir',
      visitor: createHIREntrypointVisitor(t, normalizedOptions),
    }
  },
)

export { clearModuleMetadata, resolveModuleMetadata, setModuleMetadata } from './module-metadata'
export type {
  HookReturnInfoSerializable,
  ModuleReactiveMetadata,
  ReactiveExportKind,
} from './types'

export default createFictPlugin
