import generate from '@babel/generator'
import { describe, expect, it } from 'vitest'
import { parseSync } from '@babel/core'
import * as t from '@babel/types'
import { buildHIR } from '../src/ir/build-hir'
import {
  lowerHIRToBabel,
  codegenWithScopes,
  lowerHIRWithRegions,
  getRegionMetadataForFunction,
  hasReactiveRegions,
} from '../src/ir/codegen'
import { analyzeReactiveScopes } from '../src/ir/scopes'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

describe('lowerHIRToBabel', () => {
  it('should lower simple function to Babel AST', () => {
    const ast = parseFile(`
      function Foo(x) {
        const y = x + 1
        return y
      }
    `)
    const hir = buildHIR(ast)
    const result = lowerHIRToBabel(hir, t)

    expect(result.type).toBe('File')
    expect(result.program.body.length).toBeGreaterThan(0)
  })
})

describe('codegenWithScopes', () => {
  it('should generate code with scope analysis', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.a
        return x
      }
    `)
    const hir = buildHIR(ast)
    const scopes = analyzeReactiveScopes(hir.functions[0])
    const result = codegenWithScopes(hir, scopes, t)

    expect(result.type).toBe('File')
    expect(result.program.body.length).toBeGreaterThan(0)
  })
})

describe('lowerHIRWithRegions', () => {
  it('should generate code with region-based analysis', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.a + props.b
        const y = x * 2
        return y
      }
    `)
    const hir = buildHIR(ast)
    const result = lowerHIRWithRegions(hir, t)

    expect(result.type).toBe('File')
    expect(result.program.body.length).toBeGreaterThan(0)
  })

  it('should handle control flow', () => {
    const ast = parseFile(`
      function Foo(props) {
        if (props.enabled) {
          return 'on'
        }
        return 'off'
      }
    `)
    const hir = buildHIR(ast)
    const result = lowerHIRWithRegions(hir, t)

    expect(result.type).toBe('File')
  })
})

describe('getRegionMetadataForFunction', () => {
  it('should return region metadata array', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.value
        return x
      }
    `)
    const hir = buildHIR(ast)
    const metadata = getRegionMetadataForFunction(hir.functions[0])

    expect(Array.isArray(metadata)).toBe(true)
  })
})

describe('hasReactiveRegions', () => {
  it('should detect reactive regions', () => {
    const ast = parseFile(`
      function Foo(props) {
        const x = props.value
        return x
      }
    `)
    const hir = buildHIR(ast)
    const hasReactive = hasReactiveRegions(hir.functions[0])

    expect(typeof hasReactive).toBe('boolean')
  })
})

describe('region metadata → DOM', () => {
  it('applies dependency getters and memoization for DOM bindings', () => {
    const ast = parseFile(`
      function View(props) {
        let color = $state('red')
        return <div className={color}>{props.label}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('__fictUseMemo(__fictCtx')
    expect(code).toMatch(/color\(\)/)
    expect(code).toMatch(/props(?:\(\))?\.label/)
  })

  it('applies dependency getters for property-level JSX reads', () => {
    const ast = parseFile(`
      function View() {
        const state = $state({ user: { name: 'Ada' } })
        return <div className={state.user.name}>{state.user.name}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/state\(\)\.user\.name/)
    expect(code).toContain('bindClass')
  })
})

describe('tracked reads/writes in HIR codegen', () => {
  it('lowers tracked identifier reads and writes to signal calls', () => {
    const ast = parseFile(`
      function Counter() {
        let count = $state(0)
        count = count + 1
        count++
        return count
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('__fictUseSignal')
    expect(code).toContain('count(count() + 1)')
    expect(code).toContain('count() + 1')
    expect(code).toMatch(/return count\(\)/)
  })
})
