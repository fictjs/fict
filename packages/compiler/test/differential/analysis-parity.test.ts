import { parseSync } from '@babel/core'
import * as BabelTypes from '@babel/types'
import { describe, expect, it } from 'vitest'

import { buildHIR } from '../../src/ir/build-hir'
import { collectExpressionDependencies } from '../../src/ir/codegen-expression-deps'
import type { Expression, HIRFunction } from '../../src/ir/hir'
import { deSSAVarName, generateRegions } from '../../src/ir/regions'
import { analyzeReactiveScopesWithSSA } from '../../src/ir/scopes'
import { analyzeObjectShapes } from '../../src/ir/shapes'
import { walkExpression } from '../../src/ir/walk-expression'
import { runLegacyTransform } from '../test-utils'

import { isRuntimeImportModule } from '../../src/constants'
import fixturesJson from './analysis-parity-fixtures.json'

type ReactiveKind = 'state' | 'memo' | 'store' | 'resource' | 'selector' | 'alias' | 'derived'

interface ReactiveBindingSnapshot {
  name: string
  kind: ReactiveKind
  dependencies: string[]
}

interface ShapeSnapshot {
  name: string
  knownKeys: string[]
  mutableKeys: string[]
  dynamicAccess: boolean
  completeKeySet: boolean
}

interface FunctionAnalysisSnapshot {
  name: string
  reactiveBindings: ReactiveBindingSnapshot[]
  controlFlowReads: string[]
  escapingBindings: string[]
  shapes: ShapeSnapshot[]
  region: { hasControlFlow: boolean; hasJsx: boolean; hasAsync: boolean }
  hasEffect: boolean
}

interface AnalysisSnapshot {
  functions: FunctionAnalysisSnapshot[]
  hasDerivedCycle: boolean
}

interface AnalysisFixture {
  name: string
  language: 'js' | 'jsx' | 'ts' | 'tsx'
  source: string
  expected: AnalysisSnapshot
}

interface MacroNames {
  state: Set<string>
  effect: Set<string>
  roots: Map<string, Exclude<ReactiveKind, 'alias' | 'derived'>>
}

interface AssignmentFact {
  target: string
  value: Expression
  dependencies: Set<string>
  rootKind?: Exclude<ReactiveKind, 'alias' | 'derived'>
}

const fixtures = fixturesJson as AnalysisFixture[]

function collectMacroNames(ast: BabelTypes.File): MacroNames {
  const state = new Set(['$state'])
  const effect = new Set(['$effect'])
  const roots = new Map<string, Exclude<ReactiveKind, 'alias' | 'derived'>>([
    ['$state', 'state'],
    ['$memo', 'memo'],
    ['$store', 'store'],
    ['resource', 'resource'],
    ['createSelector', 'selector'],
  ])

  for (const statement of ast.program.body) {
    if (
      !BabelTypes.isImportDeclaration(statement) ||
      !isRuntimeImportModule(statement.source.value)
    ) {
      continue
    }
    for (const specifier of statement.specifiers) {
      if (!BabelTypes.isImportSpecifier(specifier)) continue
      const imported = BabelTypes.isIdentifier(specifier.imported)
        ? specifier.imported.name
        : specifier.imported.value
      const kind = roots.get(imported)
      if (kind) roots.set(specifier.local.name, kind)
      if (imported === '$state') state.add(specifier.local.name)
      if (imported === '$effect') effect.add(specifier.local.name)
    }
  }
  return { state, effect, roots }
}

function dependencyBase(path: string): string {
  return deSSAVarName(path.split(/[.[?]/, 1)[0] ?? path)
}

function assignmentFacts(fn: HIRFunction, macros: MacroNames): AssignmentFact[] {
  const facts: AssignmentFact[] = []
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind !== 'Assign') continue
      const dependencies = new Set<string>()
      collectExpressionDependencies(instruction.value, dependencies, {
        includeFunctionBodies: false,
        includeImmediatelyInvokedFunctionBodies: true,
      })
      const callee =
        instruction.value.kind === 'CallExpression' &&
        instruction.value.callee.kind === 'Identifier'
          ? instruction.value.callee.name
          : null
      const rootKind = callee === null ? undefined : macros.roots.get(callee)
      facts.push({
        target: deSSAVarName(instruction.target.name),
        value: instruction.value,
        dependencies,
        ...(rootKind === undefined ? {} : { rootKind }),
      })
    }
  }
  return facts
}

function reactiveBindings(fn: HIRFunction, macros: MacroNames): ReactiveBindingSnapshot[] {
  const facts = assignmentFacts(fn, macros)
  const kinds = new Map<string, ReactiveKind>()
  for (const fact of facts) {
    if (fact.rootKind) kinds.set(fact.target, fact.rootKind)
  }

  for (let remaining = facts.length + 1; remaining > 0; remaining--) {
    let changed = false
    for (const fact of facts) {
      if (kinds.has(fact.target)) continue
      const reactiveDependencies = [...fact.dependencies].filter(path =>
        kinds.has(dependencyBase(path)),
      )
      if (reactiveDependencies.length === 0) continue
      const alias = fact.value.kind === 'Identifier' && kinds.has(deSSAVarName(fact.value.name))
      kinds.set(fact.target, alias ? 'alias' : 'derived')
      changed = true
    }
    if (!changed) break
  }

  return [...kinds.entries()]
    .map(([name, kind]) => ({
      name,
      kind,
      dependencies: [
        ...new Set(
          facts
            .filter(fact => fact.target === name)
            .flatMap(fact => [...fact.dependencies])
            .filter(path => kinds.has(dependencyBase(path))),
        ),
      ].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function containsEffect(fn: HIRFunction, effectNames: ReadonlySet<string>): boolean {
  let found = false
  const inspect = (value: Expression): void => {
    walkExpression(
      value,
      expression => {
        if (
          expression.kind === 'CallExpression' &&
          expression.callee.kind === 'Identifier' &&
          effectNames.has(expression.callee.name)
        ) {
          found = true
        }
      },
      { includeFunctionBodies: false },
    )
  }
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind === 'Assign' || instruction.kind === 'Expression') {
        inspect(instruction.value)
      }
    }
  }
  return found
}

function normalizeFunction(fn: HIRFunction, macros: MacroNames): FunctionAnalysisSnapshot | null {
  if (!fn.name) return null
  const scopes = analyzeReactiveScopesWithSSA(fn)
  const shapeAnalysis = analyzeObjectShapes(fn)
  const regions = generateRegions(fn, scopes, shapeAnalysis)
  const shapes = [...shapeAnalysis.shapes.entries()]
    .filter(
      ([, shape]) =>
        shape.knownKeys.size > 0 || shape.dynamicAccess || shape.source.kind === 'props',
    )
    .map(([name, shape]) => ({
      name: deSSAVarName(name),
      knownKeys: [...shape.knownKeys].sort(),
      mutableKeys: [...shape.mutableKeys].sort(),
      dynamicAccess: shape.dynamicAccess,
      completeKeySet: shape.completeKeySet,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const controlFlowReads = new Set([
    ...scopes.controlFlowAnalysis.controlFlowReads,
    ...scopes.controlFlowAnalysis.mixedReads,
  ])

  return {
    name: fn.name,
    reactiveBindings: reactiveBindings(fn, macros),
    controlFlowReads: [...controlFlowReads].map(deSSAVarName).sort(),
    escapingBindings: [...scopes.escapingVars]
      .map(deSSAVarName)
      .filter(name => !macros.roots.has(name) && !macros.effect.has(name))
      .sort(),
    shapes,
    region: {
      hasControlFlow: regions.regions.some(region => region.hasControlFlow),
      hasJsx: regions.regions.some(region => region.hasJSX),
      hasAsync: regions.regions.some(region => region.hasAsyncSyntax),
    },
    hasEffect: containsEffect(fn, macros.effect),
  }
}

function legacyHasDerivedCycle(fixture: AnalysisFixture): boolean {
  try {
    runLegacyTransform(
      fixture.source,
      { strictGuarantee: false },
      `/analysis-parity/${fixture.name}.${fixture.language}`,
    )
    return false
  } catch (error) {
    if (error instanceof Error && error.message.includes('cyclic derived dependency')) return true
    throw error
  }
}

function analyzeLegacy(fixture: AnalysisFixture): AnalysisSnapshot {
  const ast = parseSync(fixture.source, {
    filename: `/analysis-parity/${fixture.name}.${fixture.language}`,
    parserOpts: {
      sourceType: 'module',
      plugins:
        fixture.language === 'js'
          ? []
          : fixture.language === 'jsx'
            ? ['jsx']
            : fixture.language === 'ts'
              ? ['typescript']
              : ['typescript', 'jsx'],
    },
  })
  if (!ast) throw new Error(`Failed to parse analysis fixture: ${fixture.name}`)
  const macros = collectMacroNames(ast)
  const hir = buildHIR(ast, {
    state: macros.state,
    effect: macros.effect,
    strictMacroBindings: true,
  })
  const functions = hir.functions
    .map(fn => normalizeFunction(fn, macros))
    .filter((fn): fn is FunctionAnalysisSnapshot => fn !== null)
    .sort((left, right) => left.name.localeCompare(right.name))
  return { functions, hasDerivedCycle: legacyHasDerivedCycle(fixture) }
}

describe('shared normalized analysis parity corpus: legacy backend', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(analyzeLegacy(fixture)).toEqual(fixture.expected)
    })
  }
})
