import type * as BabelCore from '@babel/core'
import { declare } from '@babel/helper-plugin-utils'

import { buildHIR } from './ir/build-hir'
import { lowerHIRWithRegions } from './ir/codegen'
import type { FictCompilerOptions } from './types'
import { isEffectCall, isStateCall } from './utils'

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
  return !!path.findParent(p => p.isIfStatement?.() || p.isConditionalExpression?.())
}

function createHIREntrypointVisitor(t: typeof BabelCore.types): BabelCore.PluginObj['visitor'] {
  return {
    Program: {
      exit(path) {
        // Validate macro placement similar to legacy path
        path.traverse({
          VariableDeclarator(varPath) {
            const init = varPath.node.init
            if (!init) return
            if (isStateCall(init, t)) {
              if (!t.isIdentifier(varPath.node.id)) {
                throw varPath.buildCodeFrameError(
                  'Destructuring $state is not supported. Use a simple identifier.',
                )
              }
              if (isInsideLoop(varPath) || isInsideConditional(varPath)) {
                throw varPath.buildCodeFrameError(
                  '$state() cannot be declared inside loops or conditionals',
                )
              }
            }
          },
          CallExpression(callPath) {
            if (isEffectCall(callPath.node, t)) {
              if (isInsideLoop(callPath) || isInsideConditional(callPath)) {
                throw callPath.buildCodeFrameError(
                  '$effect() cannot be called inside loops or conditionals',
                )
              }
            }
          },
        })

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
      visitor: createHIREntrypointVisitor(t),
    }
  },
)

export default createFictPlugin
