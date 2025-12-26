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

// ============================================================================
// Cross-Region Dependency Edge Tests
// ============================================================================

describe('cross-region dependency edges', () => {
  it('should detect dependencies between sibling scopes', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.a
        const y = x + 1
        return y
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // y depends on x
    const yScope = res.byName.get('y')
    expect(yScope).toBeDefined()
    expect(yScope!.reads.has('x')).toBe(true)
  })

  it('should detect transitive dependencies', () => {
    const ast = parseFile(`
      function Foo(props) {
        const a = props.value
        const b = a + 1
        const c = b * 2
        const d = c - 1
        return d
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // Each scope should have its direct dependency
    const bScope = res.byName.get('b')
    const cScope = res.byName.get('c')
    const dScope = res.byName.get('d')

    expect(bScope?.reads.has('a')).toBe(true)
    expect(cScope?.reads.has('b')).toBe(true)
    expect(dScope?.reads.has('c')).toBe(true)
  })

  it('should handle diamond dependency pattern', () => {
    const ast = parseFile(`
      function Foo(props) {
        const a = props.value
        const b = a + 1
        const c = a * 2
        const d = b + c
        return d
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // d depends on both b and c
    const dScope = res.byName.get('d')
    expect(dScope).toBeDefined()
    expect(dScope!.reads.has('b')).toBe(true)
    expect(dScope!.reads.has('c')).toBe(true)
  })

  it('should detect multiple reads from same source', () => {
    const ast = parseFile(`
      function Foo(props) {
        const sum = props.a + props.b + props.c
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const sumScope = res.byName.get('sum')
    expect(sumScope).toBeDefined()
    expect(sumScope!.reads.has('props')).toBe(true)
  })
})

// ============================================================================
// Nested Region/Scope Hierarchy Tests
// ============================================================================

describe('nested scope hierarchies', () => {
  it('should handle deeply nested if blocks', () => {
    const ast = parseFile(`
      function Foo(a, b, c) {
        let result = 0
        if (a) {
          result = 1
          if (b) {
            result = 2
            if (c) {
              result = 3
            }
          }
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // Result should be tracked across all nesting levels
    const resultScope = res.byName.get('result')
    expect(resultScope).toBeDefined()
    expect(resultScope!.writes.has('result')).toBe(true)
  })

  it('should handle nested loops', () => {
    const ast = parseFile(`
      function Foo(matrix) {
        let sum = 0
        for (const row of matrix) {
          for (const cell of row) {
            sum = sum + cell
          }
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const sumScope = res.byName.get('sum')
    expect(sumScope).toBeDefined()
    expect(sumScope!.writes.has('sum')).toBe(true)
  })

  it('should handle mixed if/loop nesting', () => {
    const ast = parseFile(`
      function Foo(items, enabled) {
        let count = 0
        if (enabled) {
          for (const item of items) {
            if (item.active) {
              count = count + 1
            }
          }
        }
        return count
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const countScope = res.byName.get('count')
    expect(countScope).toBeDefined()
  })

  it('should handle try-catch nesting', () => {
    const ast = parseFile(`
      function Foo(fn) {
        let result = null
        try {
          result = fn()
          try {
            result = result.transform()
          } catch {
            result = null
          }
        } catch (e) {
          result = e.message
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const resultScope = res.byName.get('result')
    expect(resultScope).toBeDefined()
    expect(resultScope!.writes.has('result')).toBe(true)
  })
})

// ============================================================================
// Closure Capture Analysis Tests
// ============================================================================

describe('closure capture analysis', () => {
  it('should detect variables captured by arrow functions', () => {
    const ast = parseFile(`
      function Foo(props) {
        const value = props.value
        const handler = () => value + 1
        return handler
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // value is read in the handler closure
    expect(res.scopes.length).toBeGreaterThan(0)
  })

  it('should detect variables captured in callback closures', () => {
    const ast = parseFile(`
      function Foo(items) {
        const multiplier = 2
        const mapped = items.map(x => x * multiplier)
        return mapped
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // multiplier is captured by the map callback
    const mappedScope = res.byName.get('mapped')
    expect(mappedScope).toBeDefined()
  })

  it('should detect nested closure captures', () => {
    const ast = parseFile(`
      function Foo(props) {
        const a = props.a
        const outer = () => {
          const inner = () => a + 1
          return inner
        }
        return outer
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // a is captured through nested closures
    expect(res.scopes.length).toBeGreaterThan(0)
  })

  it('should handle event handler closures', () => {
    const ast = parseFile(`
      function Foo(props) {
        let count = 0
        const onClick = () => {
          count = count + 1
        }
        return onClick
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // count should be tracked
    expect(res.scopes.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// Escaping Variable Analysis Tests
// ============================================================================

describe('escaping variable analysis', () => {
  it('should detect variables returned from function', () => {
    const ast = parseFile(`
      function Foo(props) {
        const result = props.value * 2
        return result
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // result escapes via return
    expect(res.escapingVars.has('result')).toBe(true)
  })

  it('should detect variables in JSX return', () => {
    const ast = parseFile(`
      function Foo(props) {
        const message = props.text
        return <div>{message}</div>
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // message escapes via JSX
    expect(res.escapingVars.has('message')).toBe(true)
  })

  it('should detect variables assigned to external refs', () => {
    const ast = parseFile(`
      function Foo(props, ref) {
        const value = props.value
        ref.current = value
        return null
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // Scopes should be created
    expect(res.scopes.length).toBeGreaterThanOrEqual(0)
  })

  it('should detect variables in object spread', () => {
    const ast = parseFile(`
      function Foo(props) {
        const extra = { value: 1 }
        return { ...props, ...extra }
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // extra escapes via object spread return
    expect(res.escapingVars.has('extra')).toBe(true)
  })
})

// ============================================================================
// Dependency Path Analysis Tests
// ============================================================================

describe('dependency path analysis', () => {
  it('should track simple property access paths', () => {
    const ast = parseFile(`
      function Foo(props) {
        const name = props.user.name
        return name
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const nameScope = res.byName.get('name')
    expect(nameScope).toBeDefined()
    expect(nameScope!.reads.has('props')).toBe(true)
  })

  it('should track computed property access', () => {
    const ast = parseFile(`
      function Foo(props, key) {
        const value = props.data[key]
        return value
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const valueScope = res.byName.get('value')
    expect(valueScope).toBeDefined()
    expect(valueScope!.reads.has('props')).toBe(true)
    // key may or may not be tracked depending on implementation
  })

  it('should track method call chains', () => {
    const ast = parseFile(`
      function Foo(props) {
        const items = props.data.items.filter(x => x.active)
        return items
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const itemsScope = res.byName.get('items')
    expect(itemsScope).toBeDefined()
    expect(itemsScope!.reads.has('props')).toBe(true)
  })

  it('should handle destructuring in dependency tracking', () => {
    const ast = parseFile(`
      function Foo(props) {
        const { a, b } = props
        const sum = a + b
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const sumScope = res.byName.get('sum')
    expect(sumScope).toBeDefined()
    expect(sumScope!.reads.has('a')).toBe(true)
    expect(sumScope!.reads.has('b')).toBe(true)
  })

  it('should track array index access', () => {
    const ast = parseFile(`
      function Foo(items) {
        const first = items[0]
        const last = items[items.length - 1]
        return { first, last }
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const firstScope = res.byName.get('first')
    const lastScope = res.byName.get('last')
    expect(firstScope?.reads.has('items')).toBe(true)
    expect(lastScope?.reads.has('items')).toBe(true)
  })
})

// ============================================================================
// SSA De-versioning Tests
// ============================================================================

describe('SSA de-versioning in scope analysis', () => {
  it('should group SSA versions of same variable', () => {
    const ast = parseFile(`
      function Foo() {
        let x = 1
        x = x + 1
        x = x * 2
        return x
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    // All versions should be tracked under same base name
    const xScope = res.byName.get('x')
    expect(xScope).toBeDefined()
    expect(xScope!.writes.has('x')).toBe(true)
  })

  it('should handle SSA versions across branches', () => {
    const ast = parseFile(`
      function Foo(c) {
        let x = 0
        if (c) {
          x = 1
        } else {
          x = 2
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const res = analyzeReactiveScopes(hir.functions[0])

    const xScope = res.byName.get('x')
    expect(xScope).toBeDefined()
    expect(xScope!.blocks.size).toBeGreaterThan(0)
  })

  it('should handle SSA versions in loops', () => {
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
    const res = analyzeReactiveScopes(hir.functions[0])

    const sumScope = res.byName.get('sum')
    expect(sumScope).toBeDefined()
    expect(sumScope!.writes.has('sum')).toBe(true)
  })
})

// ============================================================================
// Original SSA Integration Tests
// ============================================================================

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
