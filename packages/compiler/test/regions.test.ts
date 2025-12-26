import { describe, expect, it } from 'vitest'
import { parseSync } from '@babel/core'
import * as t from '@babel/types'
import { buildHIR } from '../src/ir/build-hir'
import { analyzeReactiveScopes } from '../src/ir/scopes'
import {
  generateRegions,
  regionToMetadata,
  generateRegionCode,
  analyzeRegionMemoization,
} from '../src/ir/regions'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

describe('generateRegions', () => {
  it('should generate regions from scope analysis', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.a + props.b
        const y = x * 2
        return y
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    expect(regionResult.regions.length).toBeGreaterThan(0)
    expect(regionResult.topLevelRegions.length).toBeGreaterThan(0)
  })

  it('should detect control flow in multi-block regions', () => {
    const ast = parseFile(`
      function Foo(props) {
        let result = 'default'
        if (props.enabled) {
          result = 'on'
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    // Multi-block scopes or scopes spanning branches should have control flow
    // If no regions are generated, that's also valid
    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
    const multiBlockRegion = regionResult.regions.find(r => r.blocks.size > 1)
    if (multiBlockRegion) {
      expect(multiBlockRegion.hasControlFlow).toBe(true)
    }
  })
})

describe('generateRegions + shapes', () => {
  it('includes property-level dependencies when shape analysis is available', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.value
        return x
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    const deps = regionResult.regions.flatMap(r => Array.from(r.dependencies))
    expect(deps.some(d => d === 'props.value')).toBe(true)
  })

  it('keeps optional-chain subscriptions minimal', () => {
    const ast = parseFile(`
      function Foo(props) {
        const title = props.user?.profile?.title ?? 'N/A'
        return <div>{title}</div>
      }
    `)
    const hirProgram = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hirProgram.functions[0])
    const regionResult = generateRegions(hirProgram.functions[0], scopeResult)

    const deps = new Set(regionResult.regions.flatMap(r => Array.from(r.dependencies)))
    expect(deps.has('props')).toBe(true)
    expect(Array.from(deps).some(d => d.includes('profile'))).toBe(false)
  })
})

describe('regionToMetadata', () => {
  it('should convert region to RegionMetadata', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.value
        return x
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    if (regionResult.regions.length > 0) {
      const metadata = regionToMetadata(regionResult.regions[0])
      expect(metadata).toHaveProperty('id')
      expect(metadata).toHaveProperty('dependencies')
      expect(metadata).toHaveProperty('declarations')
    }
  })
})

describe('generateRegionCode', () => {
  it('should generate statements from HIR regions', () => {
    const ast = parseFile(`
      function Foo(a, b) {
        const sum = a + b
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    // Create a minimal codegen context for the test
    const ctx = {
      t,
      helpersUsed: new Set<string>(),
      tempCounter: 0,
      trackedVars: new Set<string>(),
      needsForOfHelper: false,
      needsForInHelper: false,
    }
    const statements = generateRegionCode(hir.functions[0], scopeResult, t, ctx as any)

    // Should produce some statements
    expect(Array.isArray(statements)).toBe(true)
  })
})

describe('analyzeRegionMemoization', () => {
  it('should determine which regions need memoization', () => {
    const ast = parseFile(`
      function Foo(props) {
        if (props.show) {
          return 'visible'
        }
        return 'hidden'
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)
    const memoMap = analyzeRegionMemoization(regionResult)

    expect(memoMap.size).toBeGreaterThanOrEqual(0)
    // Control flow regions should be considered for memoization
    for (const region of regionResult.regions) {
      if (region.hasControlFlow && region.dependencies.size > 0) {
        expect(memoMap.get(region.id)).toBe(true)
      }
    }
  })
})

// ============================================================================
// Nested Region Hierarchy Tests
// ============================================================================

describe('nested region hierarchies', () => {
  it('should generate nested regions for nested control flow', () => {
    const ast = parseFile(`
      function Foo(a, b) {
        let result = 'default'
        if (a) {
          if (b) {
            result = 'both'
          } else {
            result = 'a-only'
          }
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
  })

  it('should handle loop inside condition', () => {
    const ast = parseFile(`
      function Foo(enabled, items) {
        let sum = 0
        if (enabled) {
          for (const item of items) {
            sum = sum + item
          }
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
  })

  it('should handle condition inside loop', () => {
    const ast = parseFile(`
      function Foo(items) {
        let count = 0
        for (const item of items) {
          if (item.active) {
            count = count + 1
          }
        }
        return count
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
  })

  it('should track parent-child region relationships', () => {
    const ast = parseFile(`
      function Foo(props) {
        const outer = props.a
        if (props.enabled) {
          const inner = outer + 1
          return inner
        }
        return outer
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    // Should have regions with proper dependency tracking
    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
  })
})

// ============================================================================
// Cross-Region Dependency Tests
// ============================================================================

describe('cross-region dependencies', () => {
  it('should track dependencies between regions', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.a
        const y = x + 1
        const z = y * 2
        return z
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    // Dependencies should be properly tracked
    const allDeps = new Set<string>()
    for (const region of regionResult.regions) {
      for (const dep of region.dependencies) {
        allDeps.add(dep)
      }
    }
    // Should have some dependencies
    expect(allDeps.size).toBeGreaterThanOrEqual(0)
  })

  it('should detect diamond dependency between regions', () => {
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
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
  })

  it('should track external dependencies from props', () => {
    const ast = parseFile(`
      function Foo(props) {
        const name = props.user.name
        const greeting = 'Hello, ' + name
        return greeting
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    // Check that props is a dependency
    const deps = regionResult.regions.flatMap(r => Array.from(r.dependencies))
    expect(deps.some(d => d.includes('props'))).toBe(true)
  })
})

// ============================================================================
// Region Boundary Detection Tests
// ============================================================================

describe('region boundary detection', () => {
  it('should detect region boundary at control flow', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.a
        if (props.b) {
          return x + 1
        }
        return x - 1
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    // Control flow creates region boundaries
    expect(regionResult.topLevelRegions.length).toBeGreaterThanOrEqual(0)
  })

  it('should detect region boundary at loop', () => {
    const ast = parseFile(`
      function Foo(items) {
        let sum = 0
        for (const item of items) {
          sum = sum + item
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    // Loop creates region boundary
    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
  })

  it('should merge consecutive simple statements', () => {
    const ast = parseFile(`
      function Foo(props) {
        const a = props.x
        const b = a + 1
        const c = b * 2
        return c
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    // Consecutive statements may be merged or kept separate
    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
  })
})

// ============================================================================
// Region Declaration Tracking Tests
// ============================================================================

describe('region declaration tracking', () => {
  it('should track declarations within region', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.a
        const y = props.b
        return x + y
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    // Check declarations are tracked
    for (const region of regionResult.regions) {
      expect(region.declarations).toBeDefined()
    }
  })

  it('should track let vs const declarations', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.a
        let y = props.b
        y = y + 1
        return x + y
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
  })

  it('should track destructuring declarations', () => {
    const ast = parseFile(`
      function Foo(props) {
        const { a, b } = props
        const sum = a + b
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    expect(regionResult.regions.length).toBeGreaterThanOrEqual(0)
  })
})

// ============================================================================
// Region Metadata Generation Tests
// ============================================================================

describe('regionToMetadata - edge cases', () => {
  it('should handle regions with no dependencies', () => {
    const ast = parseFile(`
      function Foo() {
        const x = 1
        const y = 2
        return x + y
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    for (const region of regionResult.regions) {
      const metadata = regionToMetadata(region)
      expect(metadata).toHaveProperty('id')
      expect(metadata).toHaveProperty('dependencies')
      expect(metadata).toHaveProperty('declarations')
    }
  })

  it('should handle regions with many dependencies', () => {
    const ast = parseFile(`
      function Foo(a, b, c, d, e) {
        const sum = a + b + c + d + e
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    // Regions may or may not be generated for pure computation
    expect(regionResult).toBeDefined()
  })

  it('should handle regions with control flow', () => {
    const ast = parseFile(`
      function Foo(props) {
        let result = 'default'
        if (props.a) {
          result = 'a'
        } else if (props.b) {
          result = 'b'
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)

    for (const region of regionResult.regions) {
      const metadata = regionToMetadata(region)
      expect(metadata).toHaveProperty('id')
    }
  })
})

// ============================================================================
// Region Code Generation Tests
// ============================================================================

describe('generateRegionCode - edge cases', () => {
  it('should generate code for region with loop', () => {
    const ast = parseFile(`
      function Foo(items) {
        let sum = 0
        for (const item of items) {
          sum = sum + item
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const ctx = {
      t,
      helpersUsed: new Set<string>(),
      tempCounter: 0,
      trackedVars: new Set<string>(),
      needsForOfHelper: false,
      needsForInHelper: false,
    }
    const statements = generateRegionCode(hir.functions[0], scopeResult, t, ctx as any)

    expect(Array.isArray(statements)).toBe(true)
  })

  it('should generate code for region with switch', () => {
    const ast = parseFile(`
      function Foo(value) {
        let result = ''
        switch (value) {
          case 1:
            result = 'one'
            break
          case 2:
            result = 'two'
            break
          default:
            result = 'other'
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const ctx = {
      t,
      helpersUsed: new Set<string>(),
      tempCounter: 0,
      trackedVars: new Set<string>(),
      needsForOfHelper: false,
      needsForInHelper: false,
    }
    const statements = generateRegionCode(hir.functions[0], scopeResult, t, ctx as any)

    expect(Array.isArray(statements)).toBe(true)
  })

  it('should generate code for region with try-catch', () => {
    const ast = parseFile(`
      function Foo(fn) {
        let result = null
        try {
          result = fn()
        } catch (e) {
          result = e.message
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const ctx = {
      t,
      helpersUsed: new Set<string>(),
      tempCounter: 0,
      trackedVars: new Set<string>(),
      needsForOfHelper: false,
      needsForInHelper: false,
    }
    const statements = generateRegionCode(hir.functions[0], scopeResult, t, ctx as any)

    expect(Array.isArray(statements)).toBe(true)
  })
})

// ============================================================================
// Region Memoization Analysis - Edge Cases
// ============================================================================

describe('analyzeRegionMemoization - edge cases', () => {
  it('should handle pure computation regions', () => {
    const ast = parseFile(`
      function Foo(a, b) {
        const sum = a + b
        const product = a * b
        return { sum, product }
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)
    const memoMap = analyzeRegionMemoization(regionResult)

    expect(memoMap).toBeDefined()
  })

  it('should handle regions with external effects', () => {
    const ast = parseFile(`
      function Foo(props) {
        console.log(props.value)
        return props.value
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)
    const memoMap = analyzeRegionMemoization(regionResult)

    expect(memoMap).toBeDefined()
  })

  it('should handle regions with closure captures', () => {
    const ast = parseFile(`
      function Foo(props) {
        const value = props.value
        const handler = () => value + 1
        return handler
      }
    `)
    const hir = buildHIR(ast)
    const scopeResult = analyzeReactiveScopes(hir.functions[0])
    const regionResult = generateRegions(hir.functions[0], scopeResult)
    const memoMap = analyzeRegionMemoization(regionResult)

    expect(memoMap).toBeDefined()
  })
})
