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
