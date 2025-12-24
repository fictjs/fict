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
  options: FictCompilerOptions,
  t: typeof BabelCore.types,
): void {
  if (stateVars.size === 0) return
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
      const callee = path.node.callee
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
  return {
    Program: {
      exit(path) {
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
        // Validate macro placement similar to legacy path
        const stateVars = new Set<string>()
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

        // Emit conservative warnings for mutation/dynamic access
        runWarningPass(path as any, stateVars, options, t)

        const fileAst = t.file(path.node)
        const hir = buildHIR(fileAst)
        const lowered = lowerHIRWithRegions(hir, t)

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

    if (options.experimentalHIR === false || options.hirCodegen === false) {
      throw new Error('HIR-only compiler: experimentalHIR/hirCodegen cannot be disabled')
    }
    if (options.hirEntrypoint === false) {
      throw new Error('HIR-only compiler: hirEntrypoint cannot be disabled')
    }

    return {
      name: 'fict-compiler-hir',
      visitor: createHIREntrypointVisitor(t, options),
    }
  },
)

export default createFictPlugin
