import type * as BabelCore from '@babel/core'
import traverseModule from '@babel/traverse'
import * as BabelTypes from '@babel/types'

import type {
  CompilerExplainArtifact,
  CompilerExplainEvent,
  CompilerWarning,
  FictCompilerOptions,
} from './types'

const INTERNAL_RUNTIME_SOURCES = new Set([
  'fict/internal',
  'fict/internal/list',
  '@fictjs/runtime/internal',
  '@fictjs/runtime/internal/list',
])

const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ??
  traverseModule) as typeof traverseModule

interface MacroNames {
  state: ReadonlySet<string>
  effect: ReadonlySet<string>
  memo: ReadonlySet<string>
}

export interface CreateCompilerExplainArtifactInput {
  sourceProgram: BabelCore.types.Program
  outputProgram: BabelCore.types.Program
  fileName: string
  diagnostics: readonly CompilerWarning[]
  macroNames: MacroNames
}

function withLocation(
  node: BabelCore.types.Node,
  event: Omit<CompilerExplainEvent, 'line' | 'column'>,
): CompilerExplainEvent {
  const loc = node.loc?.start
  if (!loc) return event
  return {
    ...event,
    line: loc.line,
    column: loc.column + 1,
  }
}

function collectHelperImports(program: BabelCore.types.Program): string[] {
  const helpers = new Set<string>()

  for (const statement of program.body) {
    if (!BabelTypes.isImportDeclaration(statement)) continue
    if (!INTERNAL_RUNTIME_SOURCES.has(statement.source.value)) continue

    for (const specifier of statement.specifiers) {
      if (BabelTypes.isImportSpecifier(specifier)) {
        if (BabelTypes.isIdentifier(specifier.imported)) {
          helpers.add(specifier.imported.name)
        } else {
          helpers.add(specifier.imported.value)
        }
        continue
      }
      helpers.add(specifier.local.name)
    }
  }

  return Array.from(helpers).sort()
}

function collectSourceEvents(
  program: BabelCore.types.Program,
  macroNames: MacroNames,
): CompilerExplainEvent[] {
  const events: CompilerExplainEvent[] = []
  const file = BabelTypes.file(BabelTypes.cloneNode(program, true))

  traverse(file, {
    CallExpression(path) {
      const callee = path.node.callee
      if (!BabelTypes.isIdentifier(callee)) return

      if (macroNames.state.has(callee.name)) {
        events.push(
          withLocation(path.node, {
            kind: 'source-signal',
            name: callee.name,
            message: `${callee.name} creates a compiler-managed signal accessor.`,
          }),
        )
        return
      }

      if (macroNames.effect.has(callee.name)) {
        events.push(
          withLocation(path.node, {
            kind: 'source-effect',
            name: callee.name,
            message: `${callee.name} creates a compiler-managed effect boundary.`,
          }),
        )
        return
      }

      if (macroNames.memo.has(callee.name)) {
        events.push(
          withLocation(path.node, {
            kind: 'source-memo',
            name: callee.name,
            message: `${callee.name} creates a compiler-managed memo boundary.`,
          }),
        )
      }
    },
    JSXElement(path) {
      events.push(
        withLocation(path.node, {
          kind: 'source-jsx',
          message: 'JSX subtree participates in compiler DOM lowering.',
        }),
      )
    },
    JSXFragment(path) {
      events.push(
        withLocation(path.node, {
          kind: 'source-jsx',
          message: 'JSX fragment participates in compiler DOM lowering.',
        }),
      )
    },
    IfStatement(path) {
      events.push(
        withLocation(path.node, {
          kind: 'source-control-flow',
          name: 'if',
          message: 'Control flow participates in reactive region analysis.',
        }),
      )
    },
    SwitchStatement(path) {
      events.push(
        withLocation(path.node, {
          kind: 'source-control-flow',
          name: 'switch',
          message: 'Control flow participates in reactive region analysis.',
        }),
      )
    },
    ForStatement(path) {
      events.push(
        withLocation(path.node, {
          kind: 'source-control-flow',
          name: 'for',
          message: 'Loop control flow participates in reactive region analysis.',
        }),
      )
    },
    ForOfStatement(path) {
      events.push(
        withLocation(path.node, {
          kind: 'source-control-flow',
          name: 'for-of',
          message: 'Loop control flow participates in reactive region analysis.',
        }),
      )
    },
    ForInStatement(path) {
      events.push(
        withLocation(path.node, {
          kind: 'source-control-flow',
          name: 'for-in',
          message: 'Loop control flow participates in reactive region analysis.',
        }),
      )
    },
    WhileStatement(path) {
      events.push(
        withLocation(path.node, {
          kind: 'source-control-flow',
          name: 'while',
          message: 'Loop control flow participates in reactive region analysis.',
        }),
      )
    },
    DoWhileStatement(path) {
      events.push(
        withLocation(path.node, {
          kind: 'source-control-flow',
          name: 'do-while',
          message: 'Loop control flow participates in reactive region analysis.',
        }),
      )
    },
  })

  return events
}

function collectDiagnosticEvents(diagnostics: readonly CompilerWarning[]): CompilerExplainEvent[] {
  return diagnostics.map(diagnostic => ({
    kind: 'diagnostic',
    code: diagnostic.code,
    name: diagnostic.code,
    message: diagnostic.message,
    line: diagnostic.line,
    column: diagnostic.column,
  }))
}

function collectHelperEvents(helpers: readonly string[]): CompilerExplainEvent[] {
  return helpers.map(helper => ({
    kind: 'runtime-helper',
    name: helper,
    message: `Compiler output imports runtime helper ${helper}.`,
  }))
}

export function createCompilerExplainArtifact({
  sourceProgram,
  outputProgram,
  fileName,
  diagnostics,
  macroNames,
}: CreateCompilerExplainArtifactInput): CompilerExplainArtifact {
  const helpers = collectHelperImports(outputProgram)
  const events = [
    ...collectSourceEvents(sourceProgram, macroNames),
    ...collectDiagnosticEvents(diagnostics),
    ...collectHelperEvents(helpers),
  ]

  return {
    version: 1,
    fileName,
    helpers,
    diagnostics: [...diagnostics],
    events,
  }
}

export function emitCompilerExplainArtifact(
  file: BabelCore.BabelFile | undefined,
  options: FictCompilerOptions,
  artifact: CompilerExplainArtifact,
): void {
  if (!options.explain) return
  if (file) {
    const metadata = file.metadata as Record<string, unknown>
    metadata.fictExplain = artifact
  }
  if (typeof options.explain === 'function') {
    options.explain(artifact)
  }
}
