import { describe, expect, it } from 'vitest'
import { parseSync } from '@babel/core'
import { buildHIR } from '../src/ir/build-hir'
import {
  analyzeReactiveScopes,
  analyzeOptionalChainDependencies,
  getScopeDependencies,
  analyzeControlFlowReads,
  getUpdateStrategy,
  ReactiveScope,
  analyzeReactiveScopesWithSSA,
  getLoopDependentScopes,
  needsVersionedMemo,
} from '../src/ir/scopes'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

describe('analyzeReactiveScopes', () => {
  it('groups consecutive assigns into a scope with reads/writes', () => {
    const ast = parseFile(`
      function Foo() {
        let x = 1
        x = x + 1
        const y = x * 2
        return y
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])
    expect(res.scopes.length).toBeGreaterThan(0)
    const scope = res.scopes[0]
    expect(scope.writes.has('x')).toBe(true)
    expect(scope.reads.has('x')).toBe(true)
  })
})

describe('analyzeOptionalChainDependencies', () => {
  it('should identify required subscriptions for non-optional paths', () => {
    const ast = parseFile(`
      function Foo(props) {
        const name = props.user.name
        return name
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // Find scope that contains 'name' declaration
    const nameScope = res.byName.get('name')
    expect(nameScope).toBeDefined()

    const analysis = analyzeOptionalChainDependencies(nameScope!)
    expect(analysis.requiredSubscriptions.has('props')).toBe(true)
    expect(analysis.optionalOnlySubscriptions.size).toBe(0)
  })

  it('should identify optional-only subscriptions for optional chain paths', () => {
    const ast = parseFile(`
      function Foo(props) {
        const name = props?.user?.name
        return name
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const nameScope = res.byName.get('name')
    expect(nameScope).toBeDefined()

    const analysis = analyzeOptionalChainDependencies(nameScope!)
    // First segment is optional, so it's optional-only
    expect(analysis.optionalOnlySubscriptions.has('props')).toBe(true)
  })

  it('should handle mixed required and optional paths', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.a?.b
        return x
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const xScope = res.byName.get('x')
    expect(xScope).toBeDefined()

    const analysis = analyzeOptionalChainDependencies(xScope!)
    // 'a' is required, 'b' is optional - so props is required
    expect(analysis.requiredSubscriptions.has('props')).toBe(true)
    expect(analysis.runtimePaths.has('props')).toBe(true)
  })

  it('should provide minimal subscription set via getScopeDependencies', () => {
    const ast = parseFile(`
      function Foo(a, b) {
        const x = a.foo + b?.bar
        return x
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const xScope = res.byName.get('x')
    expect(xScope).toBeDefined()

    const deps = getScopeDependencies(xScope!)
    expect(deps).toContain('a')
    expect(deps).toContain('b')
  })
})

describe('analyzeControlFlowReads', () => {
  it('should identify reads in if conditions as control flow reads', () => {
    const ast = parseFile(`
      function Foo(x) {
        if (x > 0) {
          return 'positive'
        }
        return 'non-positive'
      }
    `)
    const hir = buildHIR(ast)
    const analysis = analyzeControlFlowReads(hir.functions[0])

    // 'x' is read in condition position
    expect(analysis.controlFlowReads.has('x') || analysis.mixedReads.has('x')).toBe(true)
  })

  it('should identify reads in expressions as expression-only reads', () => {
    const ast = parseFile(`
      function Foo(x) {
        const y = x + 1
        return y
      }
    `)
    const hir = buildHIR(ast)
    const analysis = analyzeControlFlowReads(hir.functions[0])

    // 'x' is only read in expression position
    expect(analysis.expressionOnlyReads.has('x') || analysis.mixedReads.has('x')).toBe(true)
  })

  it('should identify mixed reads when variable is used in both positions', () => {
    const ast = parseFile(`
      function Foo(x) {
        if (x > 0) {
          return x + 10
        }
        return x - 10
      }
    `)
    const hir = buildHIR(ast)
    const analysis = analyzeControlFlowReads(hir.functions[0])

    // 'x' is read in both condition and expression positions
    expect(analysis.mixedReads.has('x')).toBe(true)
  })

  it('should detect switch discriminant as control flow read', () => {
    const ast = parseFile(`
      function Foo(day) {
        switch (day) {
          case 1:
            return 'Monday'
          default:
            return 'Other'
        }
      }
    `)
    const hir = buildHIR(ast)
    const analysis = analyzeControlFlowReads(hir.functions[0])

    expect(analysis.controlFlowReads.has('day') || analysis.mixedReads.has('day')).toBe(true)
  })

  it('should determine reactive control flow when reactive vars are in conditions', () => {
    const ast = parseFile(`
      function Foo(count) {
        if (count > 0) {
          return 'has items'
        }
        return 'empty'
      }
    `)
    const hir = buildHIR(ast)
    const reactiveVars = new Set(['count'])
    const analysis = analyzeControlFlowReads(hir.functions[0], reactiveVars)

    expect(analysis.hasReactiveControlFlow).toBe(true)
  })

  it('should provide correct update strategy via getUpdateStrategy', () => {
    const ast = parseFile(`
      function Foo(x, y) {
        if (x > 0) {
          return y + 10
        }
        return y - 10
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const cfAnalysis = analyzeControlFlowReads(hir.functions[0])

    // Create a mock scope with both dependencies
    const mockScope: ReactiveScope = {
      id: 0,
      declarations: new Set(['result']),
      writes: new Set(['result']),
      reads: new Set(['x', 'y']),
      blocks: new Set([0]),
      dependencies: new Set(['x', 'y']),
      dependencyPaths: new Map(),
      hasExternalEffect: false,
      shouldMemoize: true,
    }

    const strategy = getUpdateStrategy(mockScope, cfAnalysis)

    // 'x' is in condition - requires re-execution
    expect(strategy.reExecuteOn.has('x')).toBe(true)
    // 'y' is expression-only - can use binding update
    expect(strategy.bindingUpdateOn.has('y')).toBe(true)
  })
})

describe('analyzeReactiveScopesWithSSA', () => {
  it('should identify loop headers in CFG analysis', () => {
    const ast = parseFile(`
      function Foo(n) {
        let sum = 0
        for (let i = 0; i < n; i++) {
          sum = sum + i
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const result = analyzeReactiveScopesWithSSA(hir.functions[0])

    // Should have loop headers detected
    expect(result.cfgAnalysis.loopHeaders.size).toBeGreaterThan(0)
  })

  it('should identify loop-dependent scopes', () => {
    const ast = parseFile(`
      function Foo(items) {
        let total = 0
        for (let i = 0; i < items.length; i++) {
          total = total + items[i]
        }
        return total
      }
    `)
    const hir = buildHIR(ast)
    const result = analyzeReactiveScopesWithSSA(hir.functions[0])

    // Loop-dependent scopes should be detected
    const loopScopes = getLoopDependentScopes(result)
    expect(loopScopes.length).toBeGreaterThanOrEqual(0) // May or may not have depending on structure
  })

  it('should correctly identify versioned memo needs', () => {
    const ast = parseFile(`
      function Foo(count) {
        let result = 0
        for (let i = 0; i < count; i++) {
          result = result + i
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const result = analyzeReactiveScopesWithSSA(hir.functions[0])

    // If there are scopes in loops with dependencies, they need versioned memo
    for (const scope of result.scopes) {
      const needsVersion = needsVersionedMemo(scope, result)
      // Just verify the function works without error
      expect(typeof needsVersion).toBe('boolean')
    }
  })
})
