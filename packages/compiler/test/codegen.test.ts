import generate from '@babel/generator'
import { describe, expect, it } from 'vitest'
import { parseSync } from '@babel/core'
import * as t from '@babel/types'
import { buildHIR } from '../src/ir/build-hir'
import { HIRError, type Expression } from '../src/ir/hir'
import { keyExpressionSignature } from '../src/ir/codegen-jsx-keys'
import {
  lowerHIRToBabel,
  codegenWithScopes,
  lowerHIRWithRegions,
  getRegionMetadataForFunction,
  hasReactiveRegions,
} from '../src/ir/codegen'
import { analyzeReactiveScopes } from '../src/ir/scopes'
import { firstFunction } from './hir-test-utils'
import { transform } from './test-utils'

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
    const scopes = analyzeReactiveScopes(firstFunction(hir))
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

  it('strips TypeScript annotations from emitted function parameters', () => {
    const ast = parseFile(`
      export function f(x: number): number {
        return x + 1
      }

      export function id<T>(value: T): T {
        return value
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('function f(x)')
    expect(code).toContain('function id(value)')
    expect(code).not.toContain('x: number')
    expect(code).not.toContain('value: T')
    expect(code).not.toContain('<T>')
    expect(code).not.toContain(': T')
  })

  it('strips TypeScript annotations from emitted expression function parameters', () => {
    const ast = parseFile(`
      export const f = (x: number): number => x + 1
      export const g = function (value: string): string {
        return value
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('x: number')
    expect(code).not.toContain('value: string')
    expect(code).not.toContain(': string')
  })

  it('strips TypeScript annotations from emitted destructured params', () => {
    const ast = parseFile(`
      export function f(
        value: number = 1,
        { name = 'x' }: { name?: string },
        ...rest: number[]
      ) {
        return value + name.length + rest.length
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('function f(value = 1, {')
    expect(code).toContain('...rest')
    expect(code).not.toContain(': number')
    expect(code).not.toContain('name?: string')
    expect(code).not.toContain('number[]')
  })

  it('destructures lazy conditional region outputs from memo values', () => {
    const ast = parseFile(`
      export function Component(props) {
        const a = props.x + 1
        const b = props.y + 2
        const out = props.choose ? a : b
        return <span>{out}</span>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { lazyConditional: true })
    const { code } = generate(file)

    expect(code).toMatch(/const\s*\{\s*a,\s*out\s*\}\s*=\s*__region_\d+\(\);/)
    expect(code).not.toMatch(/const\s*\{\s*a,\s*out\s*\}\s*=\s*__region_\d+;/)
  })

  it('reuses lazy conditional branch tests inside dependent callbacks', () => {
    const ast = parseFile(`
      export function Component(props) {
        const a = props.x + 1
        const b = props.y + 2
        const out = props.choose ? a : b
        return <span>{out}</span>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { lazyConditional: true })
    const { code } = generate(file)

    expect(code).toMatch(/const (__cond_\d+) = props\.choose/)
    const conditionName = code.match(/const (__cond_\d+) = props\.choose/)?.[1]
    expect(conditionName).toBeDefined()
    expect(code).toContain(`() => ${conditionName} ? a() : b()`)
    expect(code).not.toContain('() => props.choose ? a() : b()')
  })

  it('preserves empty loop headers inside emitted reactive regions', () => {
    const output = transform(`
      import { $state } from 'fict'

      function items() {
        return [1, 2]
      }
      function object() {
        return { a: 1 }
      }
      function test() {
        return false
      }
      function side() {
        return false
      }

      export function App() {
        let count = $state(1)
        let out = 0
        if (count) {
          while (test()) {}
          for (; side();) {}
          for (const x of items()) {}
          for (const key in object()) {}
          out = 1
        }
        return <span>{out}:{count}</span>
      }
    `)

    expect(output).toMatch(/while \(test\(\)\) \{\s*\}/)
    expect(output).toMatch(/for \(; side\(\);\) \{\s*\}/)
    expect(output).toMatch(/for \(const x of items\(\)\) \{\s*\}/)
    expect(output).toMatch(/for \(const key in object\(\)\) \{\s*\}/)
    expect(output).toContain('out = 1')
  })

  it('preserves try and finally side effects inside emitted reactive regions', () => {
    const output = transform(`
      import { $state } from 'fict'

      function side() {
        return 1
      }
      function fail() {
        throw { x: 2 }
      }
      function cleanup() {
        side()
      }

      export function App() {
        let count = $state(1)
        let out = 0
        if (count) {
          try {
            side()
          } catch {}
          try {
            fail()
          } catch (e) {
            out = e.x
          }
          try {} finally {
            cleanup()
          }
        }
        return <span>{out}:{count}</span>
      }
    `)

    expect(output).toMatch(/try \{\s+side\(\);\s+\} catch/)
    expect(output).toMatch(/try \{\s+fail\(\);\s+\} catch \(e\) \{\s+out = e\.x;/)
    expect(output).toMatch(/try \{\s*\} finally \{\s+cleanup\(\);/)
    expect(output).toContain('out = e.x')
  })

  it('keeps branch side effects with region outputs in source order once', () => {
    const output = transform(`
      import { $state } from 'fict'

      function mark() {
        return 1
      }
      function choose() {
        return 'hit'
      }

      export function App() {
        let count = $state(1)
        let out = 0
        if (count) {
          mark()
          out = 1
        }
        if (count) {
          switch (choose()) {
            case 'hit':
              out = 2
              break
            default:
              out = 3
          }
        }
        return <span>{out}:{count}</span>
      }
    `)

    expect(output.match(/mark\(\);/g) ?? []).toHaveLength(1)
    expect(output.match(/switch \(choose\(\)\)/g) ?? []).toHaveLength(1)
    expect(output).toMatch(/if \(count\(\)\) \{\s+mark\(\);\s+out = 1;/)
    expect(output).toMatch(/switch \(choose\(\)\) \{\s+case "hit":\s+out = 2;/)
  })

  it('keeps output assignments after earlier ordinary side effects', () => {
    const expectBefore = (output: string, earlier: string, later: string) => {
      const earlierIndex = output.indexOf(earlier)
      const laterIndex = output.indexOf(later)
      expect(earlierIndex).toBeGreaterThanOrEqual(0)
      expect(laterIndex).toBeGreaterThanOrEqual(0)
      expect(earlierIndex).toBeLessThan(laterIndex)
    }

    const callOutput = transform(`
      const log = []

      export function App() {
        let out = 0
        function side() {
          log.push(out)
        }
        side()
        out = 1
        return <span>{out}:{log.join(',')}</span>
      }
    `)

    expectBefore(callOutput, 'side();', 'out = 1;')

    const throwOutput = transform(`
      export function App() {
        let out = 0
        maybeThrow()
        out = 1
        return <span>{out}</span>
      }
    `)

    expectBefore(throwOutput, 'maybeThrow();', 'out = 1;')

    const rhsOutput = transform(`
      export function App() {
        let out = 0
        first()
        out = second()
        return <span>{out}</span>
      }
    `)

    expectBefore(rhsOutput, 'first();', 'out = second();')

    const getterOutput = transform(`
      const source = {
        get value() {
          return 1
        }
      }

      export function App() {
        let out = 0
        source.value
        out = 1
        return <span>{out}</span>
      }
    `)

    expectBefore(getterOutput, 'source.value;', 'out = 1;')

    const multipleOutput = transform(`
      export function App() {
        let out = 0
        first()
        out = 1
        second()
        out = 2
        return <span>{out}</span>
      }
    `)

    expectBefore(multipleOutput, 'first();', 'out = 1;')
    expectBefore(multipleOutput, 'out = 1;', 'second();')
    expectBefore(multipleOutput, 'second();', 'out = 2;')
  })

  it('keeps assignments after reactive setup effects in source order once', () => {
    const expectBefore = (output: string, earlier: string, later: string) => {
      const earlierIndex = output.indexOf(earlier)
      const laterIndex = output.indexOf(later)
      expect(earlierIndex).toBeGreaterThanOrEqual(0)
      expect(laterIndex).toBeGreaterThanOrEqual(0)
      expect(earlierIndex).toBeLessThan(laterIndex)
    }

    const output = transform(`
      import { $state } from 'fict'

      const log = []

      export function App() {
        let count = $state(1)
        let out = 0
        if (count) log.push(out)
        out = 1
        return <span>{out}:{log.join(',')}:{count}</span>
      }
    `)

    expectBefore(output, '__fictUseEffect(__fictCtx', 'out = 1;')
    expect(output.match(/out = 1;/g) ?? []).toHaveLength(1)

    const capturedOnlyOutput = transform(`
      import { $state } from 'fict'

      const log = []

      export function App() {
        let count = $state(1)
        let out = 0
        if (count) log.push(out)
        out = 1
        return <span>{log.join(',')}:{count}</span>
      }
    `)

    expectBefore(capturedOnlyOutput, '__fictUseEffect(__fictCtx', 'out = 1;')
    expect(capturedOnlyOutput.match(/out = 1;/g) ?? []).toHaveLength(1)

    const expressionOutput = transform(`
      import { $state } from 'fict'

      const log = []

      export function App() {
        let count = $state(1)
        let out = 0
        log.push(count)
        out = 1
        return <span>{out}:{log.join(',')}:{count}</span>
      }
    `)

    expectBefore(expressionOutput, '__fictUseEffect(__fictCtx', 'out = 1;')
    expect(expressionOutput.match(/out = 1;/g) ?? []).toHaveLength(1)

    const rhsOutput = transform(`
      import { $state } from 'fict'

      const log = []

      function next() {
        log.push('next')
        return 1
      }

      export function App() {
        let count = $state(1)
        let out = 0
        if (count) log.push(out)
        out = next()
        return <span>{log.join(',')}:{count}</span>
      }
    `)

    expectBefore(rhsOutput, '__fictUseEffect(__fictCtx', 'out = next();')
    expect(rhsOutput.match(/out = next\(\);/g) ?? []).toHaveLength(1)
    expect(rhsOutput).not.toContain('const { out }')
  })

  it('keeps destructuring temps with branch region outputs', () => {
    const output = transform(`
      import { $state } from 'fict'

      function side() {
        return { x: 2 }
      }

      export function App() {
        let count = $state(1)
        let out = 0
        if (count) {
          const { x } = side()
          out = x
        }
        return <span>{out}:{count}</span>
      }
    `)

    expect(output).toMatch(
      /if \(count\(\)\) \{\s+const _side = side\(\);\s+const x = _side\.x;\s+out = x;/,
    )
    expect(output).not.toMatch(/=> _side\.x/)
    expect(output).not.toMatch(/const \{[^}]*x[^}]*\} = __region_/)
  })

  it('does not expose branch-local scalar declarations as region outputs', () => {
    const output = transform(`
      import { $state } from 'fict'

      function side() {
        return 2
      }

      export function App() {
        const count = $state(1)
        let out = 0
        if (count) {
          const x = side()
          out = x
        }
        return <span>{out}:{count}</span>
      }
    `)

    expect(output).toMatch(/if \(count\(\)\) \{\s+const x = side\(\);\s+out = x;/)
    expect(output).toMatch(/return \{\s+out: out !== void 0 \? out : void 0\s+\};/)
    expect(output).not.toMatch(/x: x !== void 0 \? x : void 0/)
    expect(output).not.toMatch(/const x = \(\) => __region_\d+\(\)\.x/)
  })

  it('keeps block-scoped control-flow locals internal to region bodies', () => {
    const output = transform(`
      import { $state } from 'fict'

      function side() {
        return 2
      }

      export function IfElseApp() {
        const count = $state(1)
        let out = 0
        if (count) {
          const thenLocal = side()
          out = thenLocal
        } else {
          let elseLocal = side()
          out = elseLocal
        }
        return <span>{out}:{count}</span>
      }

      export function NestedApp() {
        const count = $state(1)
        let out = 0
        if (count) {
          {
            const nestedLocal = side()
            out = nestedLocal
          }
        }
        return <span>{out}:{count}</span>
      }

      export function SwitchApp() {
        const count = $state(1)
        let out = 0
        switch (count) {
          case 1: {
            const caseLocal = side()
            out = caseLocal
            break
          }
        }
        return <span>{out}:{count}</span>
      }

      export function LoopApp() {
        const count = $state(1)
        let out = 0
        while (count) {
          const loopLocal = side()
          out = loopLocal
          break
        }
        return <span>{out}:{count}</span>
      }

      export function TryApp() {
        const count = $state(1)
        let out = 0
        if (count) {
          try {
            const tryLocal = side()
            out = tryLocal
          } catch (error) {
            const catchLocal = side()
            out = catchLocal
          } finally {
            let finallyLocal = side()
            out = finallyLocal
          }
        }
        return <span>{out}:{count}</span>
      }
    `)

    for (const name of [
      'thenLocal',
      'elseLocal',
      'nestedLocal',
      'caseLocal',
      'loopLocal',
      'tryLocal',
      'catchLocal',
      'finallyLocal',
    ]) {
      expect(output).toContain(`${name} = side();`)
      expect(output).not.toMatch(new RegExp(`${name}: ${name} !== void 0 \\? ${name} : void 0`))
      expect(output).not.toMatch(
        new RegExp(`const ${name} = \\(\\) => __region_\\d+\\(\\)\\.${name}`),
      )
    }
  })

  it('allows var control-flow locals to remain region outputs', () => {
    const output = transform(`
      import { $state } from 'fict'

      function side() {
        return 2
      }

      export function App() {
        const count = $state(1)
        let out = 0
        if (count) {
          var branchVar = side()
          out = branchVar
        }
        return <span>{out}:{branchVar}:{count}</span>
      }
    `)

    expect(output).toMatch(/branchVar: branchVar !== void 0 \? branchVar : void 0/)
    expect(output).toMatch(/const branchVar = \(\) => __region_\d+\(\)\.branchVar/)
  })

  it('omits type-only imports and declarations from emitted modules', () => {
    const ast = parseFile(`
      import type { Foo } from './types'
      import value, { type Bar, helper } from './values'
      export type Baz = { a: number }
      export interface Qux {
        b: string
      }

      export function f() {
        return value + helper
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain("from './types'")
    expect(code).not.toContain('import type')
    expect(code).not.toContain('type Baz')
    expect(code).not.toContain('interface Qux')
    expect(code).not.toContain('Foo')
    expect(code).not.toContain('Bar')
    expect(code).toContain('helper')
    expect(code).toContain('value')
  })

  it('omits type-only re-export specifiers from emitted modules', () => {
    const ast = parseFile(`
      export type { Foo } from './types'
      export { value, type Bar } from './values'
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain("from './types'")
    expect(code).not.toContain('Foo')
    expect(code).not.toContain('Bar')
    expect(code).toContain('value')
  })

  it('strips TypeScript wrappers from emitted default export expressions', () => {
    const ast = parseFile(`
      const x: string | undefined = 'x'
      export default [
        1 as number,
        { a: 1 } as const,
        ({ b: 2 } satisfies { b: number }),
        x!,
      ]
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain(' as number')
    expect(code).not.toContain(' as const')
    expect(code).not.toContain('satisfies')
    expect(code).not.toContain('x!')
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

  it('preserves generator functions across HIR and codegen', () => {
    const ast = parseFile(`
      function* declared() {
        yield 1
      }

      function Container() {
        const nested = function* () {
          yield 2
        }
        const obj = {
          *gen() {
            yield 3
          }
        }
        return [declared, nested, obj]
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('function* declared()')
    expect(code).toContain('function* ()')
    expect(code).toContain('*gen()')
  })

  it('does not treat Object.prototype names as region overrides', () => {
    const inheritedNames = [
      'valueOf',
      'hasOwnProperty',
      'propertyIsEnumerable',
      'toLocaleString',
      'toString',
      'constructor',
    ]

    for (const name of inheritedNames) {
      expect(() =>
        transform(`
          import { $state } from 'fict'

          export function useIdentifier() {
            const s = $state(0)
            const ${name} = 1
            return ${name} + s
          }
        `),
      ).not.toThrow()

      expect(() =>
        transform(`
          import { $state } from 'fict'

          export function useMethod() {
            const s = $state(0)
            return ({ ${name}() { return 1 } }).${name}() + s
          }
        `),
      ).not.toThrow()
    }
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
    const metadata = getRegionMetadataForFunction(firstFunction(hir))

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
    const hasReactive = hasReactiveRegions(firstFunction(hir))

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
    expect(code).toMatch(/bindClass|setClass/)
  })

  it('lowers dangerouslySetInnerHTML to guarded innerHTML writes', () => {
    const ast = parseFile(`
      function View() {
        return <div dangerouslySetInnerHTML={{ __html: '<span>x</span>' }} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('setProp')
    expect(code).toContain('"innerHTML"')
    expect(code).toContain('"__html" in')
    expect(code).not.toContain('setAttr')
    expect(code).not.toContain('dangerouslySetInnerHTML')
  })

  it('updates reactive dangerouslySetInnerHTML through innerHTML effects', () => {
    const ast = parseFile(`
      function View() {
        let html = $state('<span>x</span>')
        return <div dangerouslySetInnerHTML={{ __html: html }} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { optimizeLevel: 'safe' })
    const { code } = generate(file)

    expect(code).toContain('createRenderEffect')
    expect(code).toContain('setProp')
    expect(code).toContain('"innerHTML"')
    expect(code).toMatch(/html\(\)/)
    expect(code).not.toContain('bindAttribute')
  })

  it('preserves missing dangerouslySetInnerHTML __html as a no-op guard', () => {
    const ast = parseFile(`
      function View() {
        return <div dangerouslySetInnerHTML={{}} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('"__html" in')
    expect(code).toContain('"innerHTML"')
    expect(code).not.toContain('dangerouslySetInnerHTML')
  })

  it('rejects dangerouslySetInnerHTML with JSX children in fine-grained output', () => {
    const ast = parseFile(`
      function View() {
        return <div dangerouslySetInnerHTML={{ __html: '<span>x</span>' }}>child</div>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t)).toThrow(/cannot be used with JSX children/)
  })

  it('keeps reactive class and ambiguous child bindings sharing deps in safe mode', () => {
    const ast = parseFile(`
      function View() {
        const count = $state(0)
        return <div className={count}>{count}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { optimizeLevel: 'safe' })
    const { code } = generate(file)

    expect(code).toContain('bindClass')
    expect(code).toContain('insertBetween')
    expect(code).not.toContain('setText')
  })

  it('routes single ambiguous reactive children through child insertion in safe mode', () => {
    const ast = parseFile(`
      function View() {
        const count = $state(0)
        return <div>{count}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { optimizeLevel: 'safe' })
    const { code } = generate(file)

    expect(code).toContain('insertBetween')
    expect(code).toContain('createElement')
    expect(code).not.toContain('bindText')
    expect(code).not.toContain('setText(')
  })

  it('routes optional member children through child insertion', () => {
    const ast = parseFile(`
      function View() {
        let user = $state({ profile: { name: 'Ada' } })
        return <div>{user?.profile?.name}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { optimizeLevel: 'safe' })
    const { code } = generate(file)

    expect(code).toContain('insertBetween')
    expect(code).toContain('user()?.profile?.name')
    expect(code).not.toContain('bindText')
  })

  it('routes import and meta-property children through child insertion', () => {
    const ast = parseFile(`
      function View() {
        return <div>{new.target}{import.meta.url}{import("./dep")}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { optimizeLevel: 'safe' })
    const { code } = generate(file)

    expect(code).toContain('insertBetween')
    expect(code).toContain('new.target')
    expect(code).toContain('import.meta.url')
    expect(code).toContain('import("./dep")')
    expect(code).not.toContain('String(new.target)')
    expect(code).not.toContain('String(import.meta.url)')
    expect(code).not.toContain('String(import("./dep"))')
  })

  it('routes this expression children through child insertion', () => {
    const source = `
      export function App() {
        return <div>{this}</div>
      }
    `
    const output = transform(source)
    const vnodeOutput = transform(source, { fineGrainedDom: false })

    expect(output).toContain('insertBetween')
    expect(output).toContain('this')
    expect(output).not.toContain('String(this)')
    expect(vnodeOutput).toContain('children: this')
    expect(vnodeOutput).not.toContain('String(this)')
  })

  it('keeps optional member attribute bindings reactive', () => {
    const ast = parseFile(`
      function View() {
        let user = $state({ profile: { name: 'Ada' } })
        return <div title={user?.profile?.name}>x</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { optimizeLevel: 'safe' })
    const { code } = generate(file)

    expect(code).toContain('bindAttribute')
  })

  it('fuses reactive bindings across different deps in full mode', () => {
    const ast = parseFile(`
      function View() {
        const left = $state(1)
        const right = $state(2)
        return <div data-left={left}>{right}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { optimizeLevel: 'full' })
    const { code } = generate(file)

    expect(code).toContain('createRenderEffect')
    expect(code).toContain('setAttr')
    expect(code).toContain('insertBetween')
    expect(code).not.toContain('setText')
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

  it('wraps tracked expression statements inside expression containers in effects', () => {
    const ast = parseFile(`
      function tag(strings, value) {
        globalThis.tagged = value
      }

      class Box {
        constructor(value) {
          globalThis.boxed = value
        }
      }

      function Counter() {
        let count = $state(0)
        let seen = []
        ;(0, seen.push(count))
        tag\`\${count}\`
        new Box(count)
        import(count)
        return <p>{seen.length}</p>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/__fictUseEffect\(__fictCtx, \(\) => \(0, seen\.push\(count\(\)\)\)/)
    expect(code).toMatch(/__fictUseEffect\(__fictCtx, \(\) => tag`\$\{count\(\)\}`/)
    expect(code).toMatch(/__fictUseEffect\(__fictCtx, \(\) => new Box\(count\(\)\)/)
    expect(code).toMatch(/__fictUseEffect\(__fictCtx, \(\) => import\(count\(\)\)/)
  })

  it('wraps side-effect-only if tests with tracked expression containers in effects', () => {
    const ast = parseFile(`
      function tag(strings, value) {
        return value > 0
      }

      class Box {
        constructor(value) {
          this.value = value
        }
      }

      function Counter() {
        let count = $state(0)
        let seen = []
        if ((0, count)) {
          seen.push('sequence')
        }
        if (tag\`\${count}\`) {
          seen.push('tagged')
        }
        if (new Box(count)) {
          seen.push('new')
        }
        if (class Derived extends count {}) {
          seen.push('class')
        }
        return <p>{seen.length}</p>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/__fictUseEffect\(__fictCtx, \(\) => \{\s*if \(0, count\(\)\)/)
    expect(code).toMatch(/__fictUseEffect\(__fictCtx, \(\) => \{\s*if \(tag`\$\{count\(\)\}`\)/)
    expect(code).toMatch(/__fictUseEffect\(__fictCtx, \(\) => \{\s*if \(new Box\(count\(\)\)\)/)
    expect(code).toMatch(
      /__fictUseEffect\(__fictCtx, \(\) => \{\s*if \(class Derived extends count\(\)/,
    )
  })

  it('wraps hook-return accessor setup control flow in effects', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useBucket() {
          const count = $state(1)
          return { count }
        }

        export function App() {
          const bucket = useBucket()
          const seen = []
          if (bucket.count) {
            seen.push('yes')
          }
          while (bucket.count && seen.length < 2) {
            seen.push('loop')
          }
          seen.push(bucket.count)
          return <span>{seen.length}:{bucket.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/__fictUseEffect\(__fictCtx, \(\) => \{\s*if \(bucket\.count\(\)\)/)
    expect(output).toMatch(
      /__fictUseEffect\(__fictCtx, \(\) => \{\s*while \(bucket\.count\(\) && seen\.length < 2\)/,
    )
    expect(output).toMatch(/__fictUseEffect\(__fictCtx, \(\) => seen\.push\(bucket\.count\(\)\)/)

    const plain = transform(
      `
        function usePlain() {
          return { count: 1 }
        }

        export function App() {
          const bucket = usePlain()
          const seen = []
          if (bucket.count) {
            seen.push('yes')
          }
          return <span>{seen.length}:{bucket.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(plain).toContain('if (bucket.count)')
    expect(plain).not.toMatch(/__fictUseEffect\(__fictCtx, \(\) => \{\s*if \(bucket\.count\)/)
  })

  it('handles hook return object without destructuring by treating properties as accessors', () => {
    const ast = parseFile(`
      const useCounter = () => {
        const count = $state(0)
        const double = count * 2
        return { count, double }
      }

      function Counter() {
        const props = useCounter()
        props.count++
        return <p>{props.count} / {props.double}</p>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const props = useCounter()')
    expect(code).toContain('props.count()')
    expect(code).toMatch(/props\.count\(\+\+__prev_\d+\)/)
    expect(code).toContain('props.double()')
  })

  it('drops hook-result metadata when an alias is reassigned', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        export function App() {
          const state = useCounter()
          let alias = state
          alias = { count: 1 }
          alias.count = 2
          alias.count++
          return <span>{alias.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toContain('alias = {')
    expect(output).toContain('alias.count = 2')
    expect(output).toContain('alias.count++')
    expect(output).toContain('alias.count')
    expect(output).not.toMatch(/alias\.count\(\)/)
    expect(output).not.toContain('alias.count(2)')
    expect(output).not.toMatch(/alias\.count\([+-]{2}__prev_/)
  })

  it('drops hook-result metadata when the original result is reassigned', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        export function App() {
          let state = useCounter()
          state = { count: 1 }
          return <span>{state.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toContain('state = {')
    expect(output).toContain('state.count')
    expect(output).not.toMatch(/state(?:\(\))?\.count\(\)/)
  })

  it('drops hook-result metadata after conditional plain reassignment', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        export function App({ flag }: { flag: boolean }) {
          let state = useCounter()
          if (flag) {
            state = { count: 1 }
          }
          return <span>{state.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toContain('state = {')
    expect(output).toMatch(/state\(\)\.count/)
    expect(output).not.toMatch(/state(?:\(\))?\.count\(\)/)
  })

  it('keeps hook-result metadata when reassigned to another hook result', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        function useOtherCounter() {
          const count = $state(1)
          return { count }
        }

        export function App() {
          let state = useCounter()
          const other = useOtherCounter()
          state = other
          return <span>{state.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/state\.count\(\)/)
  })

  it('drops array and direct accessor hook-result metadata after reassignment', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function usePair() {
          const count = $state(0)
          return [count]
        }

        function useCount() {
          const count = $state(1)
          return count
        }

        export function App() {
          let pair = usePair()
          pair = [1]
          let count = useCount()
          count = 2
          return <span>{pair[0]}:{count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toContain('pair = [1]')
    expect(output).toContain('count = 2')
    expect(output).toContain('pair[0]')
    expect(output).not.toMatch(/pair\[0\]\(\)/)
    expect(output).not.toMatch(/count\(\)/)
  })

  it('preserves transparent hook-result alias metadata', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        function useOtherCounter() {
          const count = $state(1)
          return { count }
        }

        export function App({ flag }: { flag: boolean }) {
          const state = useCounter()
          const other = useOtherCounter()
          const sequence = (0, state)
          const logical = state || state
          const conditional = flag ? state : state
          const nested = flag ? (0, state) : state || state
          const compatible = flag ? state : other
          return (
            <span>
              {sequence.count}
              {logical.count}
              {conditional.count}
              {nested.count}
              {compatible.count}
            </span>
          )
        }
      `,
      { fineGrainedDom: true },
    )

    for (const name of ['sequence', 'logical', 'conditional', 'nested', 'compatible']) {
      expect(output).toMatch(new RegExp(`${name}(?:\\(\\))?\\.count\\(\\)`))
    }
  })

  it('drops transparent hook-result alias metadata for mixed or incompatible branches', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        function useOtherCounter() {
          const total = $state(1)
          return { total }
        }

        export function App({ flag }: { flag: boolean }) {
          const state = useCounter()
          const other = useOtherCounter()
          const mixed = flag ? state : { count: 1 }
          const incompatible = flag ? state : other
          return <span>{mixed.count}:{incompatible.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/mixed(?:\(\))?\.count/)
    expect(output).toMatch(/incompatible(?:\(\))?\.count/)
    expect(output).not.toMatch(/mixed(?:\(\))?\.count\(\)/)
    expect(output).not.toMatch(/incompatible(?:\(\))?\.count\(\)/)
  })

  it('routes transparent hook-result alias writes through accessors', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        export function App() {
          const state = useCounter()
          const alias = (0, state)
          alias.count = 2
          alias.count++
          return <span>{alias.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toContain('alias.count(2)')
    expect(output).toMatch(/alias\.count\([+-]{2}__prev_/)
    expect(output).toMatch(/alias\.count\(\)/)
    expect(output).not.toContain('alias.count = 2')
    expect(output).not.toContain('alias.count++')
  })

  it('preserves same-file hook aliases with non-hook names', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        export function App() {
          const counter = useCounter
          const read = counter
          const state = read()
          state.count = 2
          state.count++
          return <span>{state.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toContain('state.count(2)')
    expect(output).toMatch(/state\.count\([+-]{2}__prev_/)
    expect(output).toMatch(/state(?:\(\))?\.count\(\)/)
    expect(output).not.toContain('state.count = 2')
    expect(output).not.toContain('state.count++')

    const reassigned = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        export function App() {
          let counter = useCounter
          counter = () => ({ count: 1 })
          const state = counter()
          return <span>{state.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(reassigned).toContain('counter = () =>')
    expect(reassigned).toMatch(/state(?:\(\))?\.count/)
    expect(reassigned).not.toMatch(/state(?:\(\))?\.count\(\)/)

    const directAccessor = transform(
      `
        import { $state } from 'fict'

        function useCount() {
          const count = $state(0)
          return count
        }

        export function App() {
          const counter = useCount
          const count = counter()
          return <span>{count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(directAccessor).toMatch(/=> count\(\)/)
  })

  it('preserves local object-member hook return metadata', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        const api = { useCounter, nested: { useCounter } }

        export function App() {
          const state = api.useCounter()
          const computed = api['useCounter']()
          const nested = api.nested.useCounter()
          const { useCounter: counter } = api
          const destructured = counter()
          state.count = 2
          computed.count++
          return <span>{state.count}:{computed.count}:{nested.count}:{destructured.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    for (const name of ['state', 'computed', 'nested', 'destructured']) {
      expect(output).toMatch(new RegExp(`${name}(?:\\(\\))?\\.count\\(\\)`))
    }
    expect(output).toContain('state.count(2)')
    expect(output).toMatch(/computed\.count\([+-]{2}__prev_/)
    expect(output).not.toContain('state.count = 2')
    expect(output).not.toContain('computed.count++')

    const invalidated = transform(
      `
        import { $state } from 'fict'

        function useCounter() {
          const count = $state(0)
          return { count }
        }

        const api = { useCounter }

        export function App() {
          api.useCounter = () => ({ count: 1 })
          const state = api.useCounter()
          return <span>{state.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(invalidated).toContain('api.useCounter = () =>')
    expect(invalidated).toMatch(/state(?:\(\))?\.count/)
    expect(invalidated).not.toMatch(/state(?:\(\))?\.count\(\)/)

    const directAccessor = transform(
      `
        import { $state } from 'fict'

        function useCount() {
          const count = $state(0)
          return count
        }

        const api = { useCount }

        export function App() {
          const count = api.useCount()
          return <span>{count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(directAccessor).toMatch(/=> count\(\)/)
  })

  it('preserves static plain hook-return object properties in DOM bindings', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useBucket() {
          const count = $state(1)
          return { count, plain: 7 }
        }

        export function App() {
          const bucket = useBucket()
          return <span>{bucket.plain}:{bucket.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/bucket\.plain/)
    expect(output).not.toMatch(/bucket\.plain\(\)/)
    expect(output).toMatch(/bucket\.count\(\)/)
  })

  it('preserves static plain hook-return array slots in DOM bindings', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useBucket() {
          const count = $state(1)
          return [count, 7]
        }

        export function App() {
          const bucket = useBucket()
          return <span>{bucket[1]}:{bucket[0]}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/bucket\[1\]/)
    expect(output).not.toMatch(/bucket\[1\]\(\)/)
    expect(output).toMatch(/bucket\[0\]\(\)/)
  })

  it('keeps derived locals from plain hook-return properties as plain values', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useBucket() {
          const count = $state(1)
          return { count, plain: 7 }
        }

        export function App() {
          const bucket = useBucket()
          const value = bucket.plain
          return <span title={bucket.plain}>{value}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/bucket\.plain/)
    expect(output).toMatch(/value/)
    expect(output).not.toMatch(/bucket\.plain\(\)/)
    expect(output).not.toMatch(/value\(\)/)
  })

  it('passes plain hook-return properties to component props without accessor calls', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useBucket() {
          const count = $state(1)
          return { count, plain: 7 }
        }

        function Child(props: { value: number }) {
          return <span>{props.value}</span>
        }

        export function App() {
          const bucket = useBucket()
          return <Child value={bucket.plain} />
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/value: bucket\.plain/)
    expect(output).not.toMatch(/bucket\.plain\(\)/)
  })

  it('wraps hook-return accessor object members passed as component props', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useBucket() {
          const count = $state(1)
          return { count, plain: 7 }
        }

        function Child(props: { value: number; plain: number }) {
          return <span>{props.value}:{props.plain}</span>
        }

        export function App() {
          const bucket = useBucket()
          return <Child value={bucket.count} plain={bucket.plain} />
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/value: (?:prop|propGetter)\(\(\) => bucket\.count\(\)\)/)
    expect(output).toMatch(/plain: bucket\.plain/)
    expect(output).not.toMatch(/value: bucket\.count\(\)/)
    expect(output).not.toMatch(/bucket\.plain\(\)/)
  })

  it('wraps hook-return accessor members in component prop spreads', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useBucket() {
          const count = $state(1)
          return { count, plain: 7 }
        }

        function Child(props: { value: number; plain: number }) {
          return <span>{props.value}:{props.plain}</span>
        }

        export function App() {
          const bucket = useBucket()
          return <Child {...{ value: bucket.count, plain: bucket.plain }} />
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/value: (?:prop|propGetter)\(\(\) => bucket\.count\(\)\)/)
    expect(output).toMatch(/plain: bucket\.plain/)
    expect(output).not.toMatch(/value: bucket\.count\(\)/)
    expect(output).not.toMatch(/bucket\.plain\(\)/)
  })

  it('wraps hook-return accessor array slots passed as component props', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function usePair() {
          const count = $state(1)
          return [count, 7]
        }

        function Child(props: { value: number; plain: number }) {
          return <span>{props.value}:{props.plain}</span>
        }

        export function App() {
          const pair = usePair()
          return <Child value={pair[0]} plain={pair[1]} />
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/value: (?:prop|propGetter)\(\(\) => pair\[0\]\(\)\)/)
    expect(output).toMatch(/plain: pair\[1\]/)
    expect(output).not.toMatch(/value: pair\[0\]\(\)/)
    expect(output).not.toMatch(/pair\[1\]\(\)/)
  })

  it('keeps hook-return accessor intrinsic attributes live', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useBucket() {
          const count = $state(1)
          return { count }
        }

        export function App() {
          const bucket = useBucket()
          return <div data-count={bucket.count} />
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/\(\) => bucket\.count\(\)/)
    expect(output).not.toMatch(/data-count[^]*bucket\.count(?!\(\))/)
  })

  it('keeps derived declarations from hook-return accessors live', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function useBucket() {
          const count = $state(1)
          return { count, plain: 7 }
        }

        export function App({ flag }: { flag: boolean }) {
          const bucket = useBucket()
          const doubled = bucket.count * 2
          const label = \`count:\${bucket.count}\`
          const choice = flag ? bucket.count : 0
          const obj = { value: bucket.count }
          const arr = [bucket.count]
          const plain = bucket.plain * 2
          return <span>{doubled}:{label}:{choice}:{obj.value}:{arr[0]}:{plain}:{bucket.count}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/bucket\.count\(\) \* 2/)
    expect(output).toMatch(/`count:\$\{bucket\.count\(\)\}`/)
    expect(output).toMatch(/\? bucket\.count\(\) : 0/)
    expect(output).toMatch(/value: bucket\.count\(\)/)
    expect(output).toMatch(/\[bucket\.count\(\)\]/)
    expect(output).toMatch(/doubled\(\)/)
    expect(output).toMatch(/label\(\)/)
    expect(output).toMatch(/choice\(\)/)
    expect(output).toMatch(/obj\(\)\.value/)
    expect(output).toMatch(/arr\(\)\[0\]/)
    expect(output).toMatch(/plain/)
    expect(output).not.toMatch(/plain\(\)/)
  })

  it('keeps derived declarations from hook-return array accessors live', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        function usePair() {
          const count = $state(1)
          return [count, 7]
        }

        export function App() {
          const pair = usePair()
          const doubled = pair[0] * 2
          const plain = pair[1] * 2
          return <span>{doubled}:{plain}:{pair[0]}</span>
        }
      `,
      { fineGrainedDom: true },
    )

    expect(output).toMatch(/pair\[0\]\(\) \* 2/)
    expect(output).toMatch(/doubled\(\)/)
    expect(output).toMatch(/pair\[0\]\(\)/)
    expect(output).toMatch(/plain/)
    expect(output).not.toMatch(/pair\[1\]\(\)/)
    expect(output).not.toMatch(/plain\(\)/)
  })

  it('preserves explicit calls to hook return accessor members', () => {
    const ast = parseFile(`
      const useCounter = () => {
        const count = $state(0)
        const double = count * 2
        return { count, double }
      }

      function Counter() {
        const props = useCounter()
        return <p>{props.count()} / {props.double()}</p>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('props.count()')
    expect(code).toContain('props.double()')
    expect(code).not.toContain('props.count()()')
    expect(code).not.toContain('props.double()()')
  })

  it('preserves optional calls to hook return accessor members', () => {
    const ast = parseFile(`
      const useCounter = () => {
        const count = $state(0)
        return { count }
      }

      function Counter() {
        const props = useCounter()
        return <p>{props.count?.()}</p>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('props.count?.()')
    expect(code).not.toContain('props.count?.()?.()')
  })

  it('handles hook returning a single accessor value', () => {
    const ast = parseFile(`
      const useCount = () => {
        const count = $state(0)
        return count
      }

      function Counter() {
        const count = useCount()
        count++
        return <p>{count}</p>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const count = useCount()')
    expect(code).toMatch(/count\(\)/)
    expect(code).toMatch(/count\(\+\+__prev_\d+\)/)
  })

  it('handles hook return spread into rest binding', () => {
    const ast = parseFile(`
      const useCounter = () => {
        const count = $state(0)
        const double = count * 2
        return { count, double }
      }

      function Counter() {
        const { ...props } = useCounter()
        props.count++
        return <p>{props.count} / {props.double}</p>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/useCounter\(\)/)
    expect(code).toMatch(/__fictObjectRest\([^,]+, \[\]\)/)
    expect(code).toContain('props.count()')
    expect(code).toMatch(/props\.count\(\+\+__prev_\d+\)/)
    expect(code).toContain('props.double()')
  })

  it('wraps complex prop expressions with prop for caching', () => {
    const ast = parseFile(`
      function Parent() {
        let count = $state(0)
        return <Child value={count * 2 + count} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('prop(() => count() * 2 + count())')
  })

  it('does not classify user-authored prop calls as accessor-returning region outputs', () => {
    const cases = [
      {
        name: 'local function declaration',
        source: `
          import { $state } from 'fict'

          export function App() {
            const count = $state(1)
            function prop(x: number) {
              return x + 1
            }
            const value = prop(count)
            return <span>{value}</span>
          }
        `,
      },
      {
        name: 'local const function',
        source: `
          import { $state } from 'fict'

          export function App() {
            const count = $state(1)
            const prop = (x: number) => x + 1
            const value = prop(count)
            return <span>{value}</span>
          }
        `,
      },
      {
        name: 'non-runtime import',
        source: `
          import { $state } from 'fict'
          import { prop } from './user'

          export function App() {
            const count = $state(1)
            const value = prop(count)
            return <span>{value}</span>
          }
        `,
      },
      {
        name: 'conditional region output',
        source: `
          import { $state } from 'fict'

          export function App() {
            const count = $state(1)
            function prop(x: number) {
              return x + 1
            }
            const value = count > 0 ? prop(count) : prop(0)
            return <span>{value}</span>
          }
        `,
      },
    ] as const

    for (const testCase of cases) {
      const output = transform(testCase.source)

      expect(output, testCase.name).toMatch(/prop\(count\(\)\)/)
      expect(output, testCase.name).toMatch(
        /const value = \(__eager_value => \(\) => __eager_value\)\(/,
      )
      expect(output, testCase.name).not.toContain('const value = prop(count())')
      expect(output, testCase.name).toContain('() => value()')
    }
  })

  it('keeps proven runtime prop calls as accessor-returning region outputs', () => {
    const output = transform(`
      import { $state, prop } from 'fict'

      export function App() {
        const count = $state(1)
        const value = prop(count)
        return <span>{value}</span>
      }
    `)

    expect(output).toContain('const value = prop(count())')
    expect(output).toContain('() => value()')
  })

  it('keeps compiler-generated prop accessors callable in JSX text', () => {
    const output = transform(`
      import { $state } from 'fict'

      function Child({ value }: { value: number }) {
        return <span>{value}</span>
      }

      export function App() {
        const count = $state(1)
        return <Child value={count} />
      }
    `)

    expect(output).toContain('const value = prop(() => __props.value)')
    expect(output).toContain('() => value()')
  })

  it('keeps optional-called destructured function props unwrapped', () => {
    const ast = parseFile(`
      function Child({ cb, value }) {
        cb?.()
        cb?.(value)
        return <div>child</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const cb = __props.cb')
    expect(code).toContain('cb?.()')
    expect(code).toContain('cb?.(value())')
    expect(code).not.toContain('const cb = prop(() => __props.cb)')
  })

  it('wraps optional-call accessor component spread sources lazily', () => {
    const output = transform(`
      import { $state } from 'fict'

      function Child(props: { x: number; y?: number }) {
        return <span>{props.x}</span>
      }

      export function App() {
        const props = $state({ x: 1 })
        return <Child {...props?.()} y={1} />
      }
    `)

    expect(output).toContain('mergeProps')
    expect(output).toMatch(/(?:propGetter|__fictProp)\(\(\) => props\?\.\(\)\)/)
    expect(output).not.toContain('mergeProps(props?.()')
  })

  it('preserves user-authored mergeProps calls', () => {
    const cases = [
      `
        import { $state } from 'fict'

        export function App() {
          const count = $state(1)
          const doubled = mergeProps(count)
          return <div>{String(doubled)}</div>
        }
      `,
      `
        import { $state } from 'fict'

        function mergeProps(value) {
          return value
        }

        export function App() {
          const count = $state(1)
          const doubled = mergeProps(count)
          return <div>{String(doubled)}</div>
        }
      `,
      `
        import { $state } from 'fict'
        import { mergeProps } from './user-helpers'

        export function App() {
          const count = $state(1)
          const doubled = mergeProps(count)
          return <div>{String(doubled)}</div>
        }
      `,
    ]

    for (const source of cases) {
      const output = transform(source)

      expect(output).toContain('mergeProps(count())')
      expect(output).not.toMatch(/import \{[^}]*\bmergeProps\b[^}]*\} from "fict\/internal"/)
    }
  })

  it('preserves user-authored __fictPropsRest calls', () => {
    const cases = [
      `
        import { $state } from 'fict'

        export function App() {
          const count = $state(1)
          const x = __fictPropsRest({ a: count }, [])
          return <div>{String(x.a)}</div>
        }
      `,
      `
        import { $state } from 'fict'

        const __fictPropsRest = (value) => value

        export function App() {
          const count = $state(1)
          const x = __fictPropsRest({ a: count }, [])
          return <div>{String(x.a)}</div>
        }
      `,
      `
        import { $state } from 'fict'

        export function App() {
          function __fictPropsRest(value) {
            return value
          }
          const count = $state(1)
          const x = __fictPropsRest({ a: count }, [])
          return <div>{String(x.a)}</div>
        }
      `,
      `
        import { $state } from 'fict'
        import { __fictPropsRest } from './user-helpers'

        export function App() {
          const count = $state(1)
          const x = __fictPropsRest({ a: count }, [])
          return <div>{String(x.a)}</div>
        }
      `,
    ]

    for (const source of cases) {
      const output = transform(source)

      expect(output).toContain('__fictPropsRest({')
      expect(output).toContain('a: count()')
      expect(output).not.toMatch(/import \{[^}]*\b__fictPropsRest\b[^}]*\} from "fict\/internal"/)
    }
  })

  it('preserves user-authored createPortal child calls', () => {
    const cases = [
      `
        function createPortal(value) {
          return value
        }

        export function App() {
          return <div>{createPortal('child')}</div>
        }
      `,
      `
        import { createPortal } from './portal'

        export function App() {
          return <div>{createPortal('child')}</div>
        }
      `,
    ]

    for (const source of cases) {
      const output = transform(source)

      expect(output).toContain('createPortal("child")')
      expect(output).toContain('insertBetween')
      expect(output).not.toContain('onDestroy')
    }
  })

  it('registers cleanup for imported Fict createPortal child calls', () => {
    const output = transform(`
      import { createPortal, createElement } from 'fict'

      export function App() {
        return <div>{createPortal(document.body, () => <span>child</span>, createElement)}</div>
      }
    `)

    expect(output).toContain('createPortal(document.body')
    expect(output).toContain('onDestroy')
    expect(output).not.toMatch(/insertBetween\([^,]+,\s*[^,]+,\s*\(\)\s*=>\s*createPortal/)
  })

  it('lowers object-property JSX member components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const UI = {
        Button: () => {
          const count = $state(1)
          return <button>{count}</button>
        },
      }

      export function App() {
        return <UI.Button />
      }
    `)

    expect(output).toContain('Button: () => {')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).toContain('type: UI.Button')
    expect(output).not.toContain('createSignal(1')
  })

  it('lowers object-method JSX member components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const UI = {
        Button() {
          const count = $state(1)
          return <button>{count}</button>
        },
      }

      export function App() {
        return <UI.Button />
      }
    `)

    expect(output).toContain('Button() {')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).toContain('type: UI.Button')
    expect(output).not.toContain('createSignal(1')
  })

  it('lowers nested object-property JSX member components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const UI = {
        Nav: {
          Item: () => {
            const count = $state(1)
            return <button>{count}</button>
          },
        },
      }

      export function App() {
        return <UI.Nav.Item />
      }
    `)

    expect(output).toContain('Item: () => {')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).toContain('type: UI.Nav.Item')
    expect(output).not.toContain('createSignal(1')
  })

  it('does not component-lower object-property functions that are not used as JSX member tags', () => {
    const output = transform(`
      import { $state } from 'fict'

      const UI = {
        Button: () => {
          const count = $state(1)
          return <button>{count}</button>
        },
      }

      export function App() {
        return <div>app</div>
      }
    `)

    expect(output).toContain('Button: () => {')
    expect(output).toContain('createSignal(1')
    expect(output).not.toContain('__fictUseSignal(__fictCtx, 1')
  })

  it('keeps object-property JSX member component props reactive', () => {
    const ast = parseFile(`
      import { $state } from 'fict'

      const UI = {
        Label: ({ value }: { value: number }) => <span>{value}</span>,
      }

      export function App() {
        const count = $state(1)
        return <UI.Label value={count} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const value = prop(() => __props.value)')
    expect(code).toContain('() => value()')
    expect(code).toContain('value: __fictProp(() => count())')
    expect(code).toContain('type: UI.Label')
    expect(code).not.toContain('({ value })')
    expect(code).not.toContain('const value = __props.value')
  })

  it('keeps object-method JSX member component props reactive', () => {
    const ast = parseFile(`
      import { $state } from 'fict'

      const UI = {
        Label({ value }: { value: number }) {
          return <span>{value}</span>
        },
      }

      export function App() {
        const count = $state(1)
        return <UI.Label value={count} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('Label(__props) {')
    expect(code).toContain('const value = prop(() => __props.value)')
    expect(code).toContain('() => value()')
    expect(code).toContain('value: __fictProp(() => count())')
    expect(code).not.toContain('const value = __props.value')
  })

  it('keeps nested JSX member component aliased default and rest props reactive', () => {
    const ast = parseFile(`
      import { $state } from 'fict'

      const UI = {
        Nav: {
          Item: ({ value: label = "fallback", ...rest }: { value?: number; extra?: number }) => (
            <span>{label}{rest.extra}</span>
          ),
        },
      }

      export function App() {
        const count = $state(1)
        return <UI.Nav.Item value={count} extra={count} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const label = prop(() =>')
    expect(code).toContain('__props.value === void 0')
    expect(code).toContain('__fictPropsRest(__props, ["value"])')
    expect(code).toContain('() => label()')
    expect(code).toContain('value: __fictProp(() => count())')
    expect(code).toContain('extra: __fictProp(() => count())')
    expect(code).toContain('type: UI.Nav.Item')
    expect(code).not.toContain('({ value: label = "fallback", ...rest })')
  })

  it('lowers assigned JSX member arrow components with component state semantics', () => {
    const ast = parseFile(`
      import { $state } from 'fict'

      const UI: any = {}
      UI.Button = () => {
        const count = $state(1)
        return <button>{count}</button>
      }

      export function App() {
        return <UI.Button />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('UI.Button =')
    expect(code).toContain('__fictUseSignal(__fictCtx, 1')
    expect(code).toContain('() => count()')
    expect(code).toContain('type: UI.Button')
    expect(code).not.toContain('createSignal(1')
    expect(code).not.toContain('() => count, createElement')
  })

  it('lowers assigned JSX member function expressions with component state semantics', () => {
    const ast = parseFile(`
      import { $state } from 'fict'

      const UI: any = {}
      UI.Button = function Button() {
        const count = $state(1)
        return <button>{count}</button>
      }

      export function App() {
        return <UI.Button />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('UI.Button = function Button')
    expect(code).toContain('__fictUseSignal(__fictCtx, 1')
    expect(code).toContain('() => count()')
    expect(code).not.toContain('createSignal(1')
  })

  it('keeps assigned JSX member component props reactive', () => {
    const ast = parseFile(`
      import { $state } from 'fict'

      const UI: any = {}
      UI.Label = ({ value }: { value: number }) => <span>{value}</span>

      export function App() {
        const count = $state(1)
        return <UI.Label value={count} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const value = prop(() => __props.value)')
    expect(code).toContain('() => value()')
    expect(code).toContain('value: __fictProp(() => count())')
    expect(code).toContain('type: UI.Label')
    expect(code).not.toContain('({ value })')
    expect(code).not.toContain('const value = __props.value')
  })

  it('keeps nested assigned JSX member component props reactive', () => {
    const ast = parseFile(`
      import { $state } from 'fict'

      const UI: any = {}
      UI.Nav = {}
      UI.Nav.Item = ({ value }: { value: number }) => <span>{value}</span>

      export function App() {
        const count = $state(1)
        return <UI.Nav.Item value={count} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const value = prop(() => __props.value)')
    expect(code).toContain('() => value()')
    expect(code).toContain('type: UI.Nav.Item')
    expect(code).not.toContain('const value = __props.value')
  })

  it('does not component-lower assigned member functions unused as JSX member tags', () => {
    const output = transform(`
      const UI: any = {}
      UI.Button = () => <button>unused</button>

      export function App() {
        return <div>ok</div>
      }
    `)

    expect(output).toContain('UI.Button = () =>')
    expect(output).toContain('template("<button>unused</button>")')
    expect(output).not.toContain('UI.Button = function Button')
  })

  it('lowers exported call-wrapped arrow components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const wrap = (value: any) => value

      export const App = wrap(() => {
        const count = $state(1)
        return <button>{count}</button>
      })
    `)

    expect(output).toContain('export const App = wrap(')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
    expect(output).not.toContain('() => count, createElement')
  })

  it('lowers call-wrapped local components used by JSX with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const wrap = (value: any) => value
      const App = wrap(() => {
        const count = $state(1)
        return <button>{count}</button>
      })

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('const App = wrap(')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).toContain('type: App')
    expect(output).not.toContain('createSignal(1')
  })

  it('lowers call-wrapped named function components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const wrap = (value: any) => value

      export const App = wrap(function App() {
        const count = $state(1)
        return <button>{count}</button>
      })
    `)

    expect(output).toContain('export const App = wrap(function App')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('keeps call-wrapped component props reactive', () => {
    const output = transform(`
      import { $state } from 'fict'

      const wrap = (value: any) => value
      const App = wrap(({ value }: { value: number }) => <span>{value}</span>)

      export function Parent() {
        const count = $state(1)
        return <App value={count} />
      }
    `)

    expect(output).toContain('const value = prop(() => __props.value)')
    expect(output).toContain('() => value()')
    expect(output).toContain('value: __fictProp(() => count())')
    expect(output).toContain('type: App')
    expect(output).not.toContain('({ value })')
    expect(output).not.toContain('const value = __props.value')
  })

  it('lowers nested call-wrapped component functions with component semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const wrap = (value: any) => value
      const outer = (value: any) => value
      const App = outer(wrap(() => {
        const count = $state(1)
        return <button>{count}</button>
      }))

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('const App = outer(wrap(')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('does not component-lower ordinary call-wrapped callbacks', () => {
    const output = transform(`
      const wrap = (value: any) => value
      const view = wrap(() => <span>plain</span>)

      export function App() {
        return <div>ok</div>
      }
    `)

    expect(output).toContain('const view = wrap(() =>')
    expect(output).toContain('template("<span>plain</span>")')
    expect(output).not.toContain('const view = wrap(function View')
  })

  it('lowers sequence-wrapped component functions with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const App = (0, () => {
        const count = $state(1)
        return <button>{count}</button>
      })

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('const App = (0,')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).toContain('type: App')
    expect(output).not.toContain('createSignal(1')
  })

  it('keeps sequence-wrapped component props reactive', () => {
    const output = transform(`
      import { $state } from 'fict'

      const App = (0, ({ value }: { value: number }) => <span>{value}</span>)

      export function Parent() {
        const count = $state(1)
        return <App value={count} />
      }
    `)

    expect(output).toContain('const value = prop(() => __props.value)')
    expect(output).toContain('() => value()')
    expect(output).toContain('value: __fictProp(() => count())')
    expect(output).not.toContain('({ value })')
    expect(output).not.toContain('const value = __props.value')
  })

  it('lowers logical component function expressions with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const App = true && (() => {
        const count = $state(1)
        return <button>{count}</button>
      })

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('const App = true &&')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('lowers conditional component function expressions with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const flag = true
      const App = flag ? (() => {
        const count = $state(1)
        return <button>{count}</button>
      }) : (() => <span>fallback</span>)

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('const App = flag ?')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('lowers array-selected component functions with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const App = [() => {
        const count = $state(1)
        return <button>{count}</button>
      }][0]

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('const App = [')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('lowers object-selected component functions with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const App = ({
        Impl: () => {
          const count = $state(1)
          return <button>{count}</button>
        },
      }).Impl

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('Impl:')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('does not component-lower lower-case expression-produced callbacks', () => {
    const output = transform(`
      const app = (0, () => <button>plain</button>)

      export function Parent() {
        return <div>ok</div>
      }
    `)

    expect(output).toContain('const app = (0, () =>')
    expect(output).toContain('template("<button>plain</button>")')
    expect(output).not.toContain('const app = (0, function App')
  })

  it('lowers assigned identifier arrow components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      let App: any

      App = () => {
        const count = $state(1)
        return <button>{count}</button>
      }

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('App = () => {')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).toContain('type: App')
    expect(output).not.toContain('createSignal(1')
    expect(output).not.toContain('() => count, createElement')
  })

  it('lowers assigned identifier function components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      let App: any

      App = function App() {
        const count = $state(1)
        return <button>{count}</button>
      }

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('App = function App()')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('keeps assigned identifier component props reactive', () => {
    const output = transform(`
      import { $state } from 'fict'

      let App: any

      App = ({ value }: { value: number }) => <span>{value}</span>

      export function Parent() {
        const count = $state(1)
        return <App value={count} />
      }
    `)

    expect(output).toContain('const value = prop(() => __props.value)')
    expect(output).toContain('() => value()')
    expect(output).toContain('value: __fictProp(() => count())')
    expect(output).not.toContain('({ value })')
    expect(output).not.toContain('() => value, createElement')
  })

  it('lowers conditional assigned identifier components with component semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const flag = true
      let App: any

      if (flag) {
        App = () => {
          const count = $state(1)
          return <button>{count}</button>
        }
      } else {
        App = () => <span>fallback</span>
      }

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('App = () => {')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('lowers exported assigned identifier components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      export let App: any

      App = () => {
        const count = $state(1)
        return <button>{count}</button>
      }
    `)

    expect(output).toContain('export let App')
    expect(output).toContain('App = () => {')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('does not component-lower assigned identifier functions unused as JSX tags', () => {
    const output = transform(`
      import { $state } from 'fict'

      let App: any

      App = () => {
        const count = $state(1)
        return <button>{count}</button>
      }

      export function Parent() {
        return <div>app</div>
      }
    `)

    expect(output).toContain('App = () => {')
    expect(output).toContain('createSignal(1')
    expect(output).not.toContain('__fictUseSignal(__fictCtx, 1')
  })

  it('lowers object-destructured components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const { App } = {
        App: () => {
          const count = $state(1)
          return <button>{count}</button>
        },
      }

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).toContain('type: App')
    expect(output).not.toContain('createSignal(1')
    expect(output).not.toContain('() => count, createElement')
  })

  it('keeps renamed object-destructured component props reactive', () => {
    const output = transform(`
      import { $state } from 'fict'

      const { App: Child } = {
        App: ({ value }: { value: number }) => <span>{value}</span>,
      }

      export function Parent() {
        const count = $state(1)
        return <Child value={count} />
      }
    `)

    expect(output).toContain('const value = prop(() => __props.value)')
    expect(output).toContain('() => value()')
    expect(output).toContain('value: __fictProp(() => count())')
    expect(output).not.toContain('({ value })')
    expect(output).not.toContain('() => value, createElement')
  })

  it('lowers object-method destructured components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const { App } = {
        App() {
          const count = $state(1)
          return <button>{count}</button>
        },
      }

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('App() {')
    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('lowers aliased object-destructured components with component state semantics', () => {
    const output = transform(`
      import { $state } from 'fict'

      const registry = {
        App: () => {
          const count = $state(1)
          return <button>{count}</button>
        },
      }
      const { App } = registry

      export function Parent() {
        return <App />
      }
    `)

    expect(output).toContain('__fictUseSignal(__fictCtx, 1')
    expect(output).toContain('() => count()')
    expect(output).not.toContain('createSignal(1')
  })

  it('keeps object-destructuring assignment component props reactive', () => {
    const output = transform(`
      import { $state } from 'fict'

      let Child: any

      ;({ App: Child } = {
        App: ({ value }: { value: number }) => <span>{value}</span>,
      })

      export function Parent() {
        const count = $state(1)
        return <Child value={count} />
      }
    `)

    expect(output).toContain('const value = prop(() => __props.value)')
    expect(output).toContain('() => value()')
    expect(output).toContain('value: __fictProp(() => count())')
    expect(output).not.toContain('({ value })')
    expect(output).not.toContain('() => value, createElement')
  })

  it('does not component-lower object-destructured functions unused as JSX tags', () => {
    const output = transform(`
      import { $state } from 'fict'

      const { App } = {
        App: () => {
          const count = $state(1)
          return <button>{count}</button>
        },
      }

      export function Parent() {
        return <div>app</div>
      }
    `)

    expect(output).toContain('createSignal(1')
    expect(output).not.toContain('__fictUseSignal(__fictCtx, 1')
  })

  it('lowers array-literal component spreads to index props', () => {
    const output = transform(`
      import { $state } from 'fict'

      function Child(props: { 0?: number; 2?: number; label?: string }) {
        return <span>{props[0]}{props[2]}{props.label}</span>
      }

      export function App() {
        const count = $state(1)
        return <Child {...[count, , 3]} label="next" />
      }
    `)

    expect(output).toMatch(/["']0["']:\s*(?:propGetter|__fictProp)\(\(\) => count\(\)\)/)
    expect(output).toMatch(/["']2["']:\s*3/)
    expect(output).toContain('label: "next"')
    expect(output).not.toContain('props: [')
    expect(output).not.toContain('...[')
  })

  it('lowers sparse array-literal component spreads to objects', () => {
    const output = transform(`
      function Child(props: { 2?: number }) {
        return <span>{props[2]}</span>
      }

      export function App() {
        return <Child {...[, , 5]} />
      }
    `)

    expect(output).toMatch(/["']2["']:\s*5/)
    expect(output).not.toContain('props: [')
    expect(output).not.toContain('...[')
  })

  it('keeps named function expression self bindings shadowed from reactive overrides', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        const fn = function count() {
          return count
        }
        const anon = function () {
          return count
        }
        return <span>{fn()}{anon()}</span>
      }
    `)

    expect(output).toMatch(/function count\(\) \{\s+return count;\s+\}/)
    expect(output).toMatch(/const anon = function \(\) \{\s+return count\(\);\s+\}/)
  })

  it('keeps named class expression bindings shadowed from reactive overrides', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        const C = class count {
          static read() {
            return count
          }
        }
        const Anon = class {
          static read() {
            return count
          }
        }
        return <span>{C.name}{C.read()}{Anon.read()}</span>
      }
    `)

    expect(output).toMatch(/const C = class count \{/)
    expect(output).toMatch(/static read\(\) \{\s+return count;\s+\}/)
    expect(output).toMatch(/const Anon = class \{\s+static read\(\) \{\s+return count\(\);\s+\}/)
    expect(output).not.toContain('class count()')
  })

  it('memoizes class expressions with reactive computed member names', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const name = $state('m')
        const C = class {
          [name]() {
            return 1
          }
        }
        return <span>{typeof new C().m}</span>
      }
    `)

    expect(output).toContain('const C = __fictUseMemo(__fictCtx, () => class')
    expect(output).toContain('[name()]()')
    expect(output).toContain('new (C())().m')
  })

  it('memoizes class expressions with reactive static field initializers', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const name = $state('m')
        const C = class {
          static v = name
        }
        return <span>{C.v}</span>
      }
    `)

    expect(output).toContain('const C = __fictUseMemo(__fictCtx, () => class')
    expect(output).toContain('static v = name()')
    expect(output).toContain('() => C().v')
  })

  it('memoizes class expressions with reactive static blocks', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const name = $state('m')
        const C = class {
          static v
          static {
            this.v = name
          }
        }
        return <span>{C.v}</span>
      }
    `)

    expect(output).toContain('const C = __fictUseMemo(__fictCtx, () => class')
    expect(output).toContain('this.v = name()')
    expect(output).toContain('() => C().v')
  })

  it('does not memoize class expressions for instance field initializer reads alone', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const name = $state('m')
        const C = class {
          v = name
        }
        return <span>{new C().v}</span>
      }
    `)

    expect(output).toContain('const C = class {')
    expect(output).toContain('v = name()')
    expect(output).toContain('new C().v')
    expect(output).not.toContain('const C = __fictUseMemo')
    expect(output).not.toContain('new (C())()')
  })

  it.each([
    {
      name: 'sequence',
      initializer: '(0, <div>{count}</div>)',
      result: 'node',
    },
    {
      name: 'tagged template',
      setup: 'function tag(_strings: TemplateStringsArray, value: unknown) { return value }',
      initializer: 'tag`${<div>{count}</div>}`',
      result: 'node',
    },
    {
      name: 'call argument',
      setup: 'const wrap = (value: unknown) => value',
      initializer: 'wrap(<div>{count}</div>)',
      result: 'node',
    },
    {
      name: 'conditional',
      initializer: 'count ? <div>{count}</div> : <span>empty</span>',
      result: 'node',
    },
    {
      name: 'logical',
      initializer: 'count && <div>{count}</div>',
      result: 'node',
    },
    {
      name: 'array',
      initializer: '[<div>{count}</div>]',
      result: 'node[0]',
    },
    {
      name: 'object',
      initializer: '({ child: <div>{count}</div> })',
      result: 'node.child',
    },
  ])('lowers hidden JSX in derived $name initializers without nested render hooks', testCase => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        ${testCase.setup ?? ''}
        const node = ${testCase.initializer}
        return ${testCase.result}
      }
    `)

    expect(output).toContain('type: "div"')
    expect(output).not.toContain('template("<')
    expect(output).not.toContain('(__eager_node')
    expect(output.match(/__fictUseMemo\(__fictCtx/g)?.length ?? 0).toBe(1)
  })

  it.each([
    {
      name: 'JSX without await',
      source: `
        export async function App() {
          return <span>ok</span>
        }
      `,
    },
    {
      name: 'async arrow component',
      source: `
        export const App = async () => <span>ok</span>
      `,
    },
    {
      name: 'JSX after await',
      source: `
        import { $state } from 'fict'

        export async function App() {
          const count = $state(1)
          await Promise.resolve()
          return <div>{count}</div>
        }
      `,
    },
    {
      name: '$state after await',
      source: `
        import { $state } from 'fict'

        export async function App() {
          await Promise.resolve()
          const count = $state(1)
          return count
        }
      `,
    },
    {
      name: 'tracked derived declaration after await',
      source: `
        import { $state } from 'fict'

        export async function App() {
          const count = $state(1)
          await Promise.resolve()
          const doubled = count + 1
          return doubled
        }
      `,
    },
    {
      name: 'render setup before await',
      source: `
        import { $state } from 'fict'

        export async function App() {
          const count = $state(1)
          const view = <div>{count}</div>
          await Promise.resolve()
          return view
        }
      `,
    },
  ])('rejects async components unsupported by the sync ABI: $name', testCase => {
    expect(() => transform(testCase.source)).toThrow(
      /Async component "App".*synchronous render ABI/,
    )
  })

  it('rejects async hooks that create render hooks after await', () => {
    expect(() =>
      transform(`
        export async function useView() {
          await Promise.resolve()
          return <div>ready</div>
        }
      `),
    ).toThrow(/Async hook "useView".*after await/)
  })

  it('allows async hooks that only read existing accessors after await', () => {
    const output = transform(`
      import { $state } from 'fict'

      export async function useProbe() {
        const count = $state(1)
        await Promise.resolve()
        return count
      }
    `)

    expect(output).toContain('export async function useProbe()')
    expect(output).toContain('return count;')
  })

  it('allows async helper functions outside component and hook contexts', () => {
    const output = transform(`
      export async function loadView() {
        await Promise.resolve()
        return <div>ready</div>
      }
    `)

    expect(output).toContain('export async function loadView()')
    expect(output).toContain('await Promise.resolve()')
  })

  it.each([
    {
      name: 'local class declaration',
      source: `
        class App {
          constructor() {
            return document.createElement('span')
          }
        }

        export function Parent() {
          return <App />
        }
      `,
      expected: /Class component "App"/,
    },
    {
      name: 'class expression binding',
      source: `
        const App = class App {}

        export function Parent() {
          return <App />
        }
      `,
      expected: /Class component "App"/,
    },
    {
      name: 'exported class declaration',
      source: `
        export class App {}

        export function Parent() {
          return <App />
        }
      `,
      expected: /Class component "App"/,
    },
    {
      name: 'member class binding',
      source: `
        const UI = {
          App: class App {},
        }

        export function Parent() {
          return <UI.App />
        }
      `,
      expected: /Class component "UI\.App"/,
    },
  ])('rejects JSX class component bindings: $name', testCase => {
    expect(() => transform(testCase.source)).toThrow(testCase.expected)
  })

  it('allows ordinary function components and non-JSX class helpers', () => {
    const output = transform(`
      class ViewModel {
        value = 1
      }

      function App() {
        return <span>ok</span>
      }

      export function Parent() {
        const model = new ViewModel()
        return <App value={model.value} />
      }
    `)

    expect(output).toContain('class ViewModel')
    expect(output).toContain('type: App')
  })

  it.each([
    {
      name: 'local declaration',
      source: `
        import { $state } from 'fict'

        function* App() {
          const count = $state(1)
          return <div>{count}</div>
        }
      `,
    },
    {
      name: 'exported declaration',
      source: `
        import { $state } from 'fict'

        export function* App() {
          const count = $state(1)
          return <div>{count}</div>
        }
      `,
    },
  ])('rejects generator components: $name', testCase => {
    expect(() => transform(testCase.source)).toThrow(/Generator component "App"/)
  })

  it('rejects generator hooks', () => {
    expect(() =>
      transform(`
        export function* useItems() {
          yield 1
        }
      `),
    ).toThrow(/Generator hook "useItems"/)
  })

  it('allows ordinary generator helper functions', () => {
    const output = transform(`
      export function* values() {
        yield 1
      }
    `)

    expect(output).toContain('export function* values()')
    expect(output).toContain('yield 1')
  })

  it('allows generator functions passed as ordinary values', () => {
    const output = transform(`
      function Child(props) {
        return <div>{props.make}</div>
      }

      export function App() {
        const make = function* () {
          yield 1
        }
        return <Child make={make} />
      }
    `)

    expect(output).toContain('function* ()')
    expect(output).toContain('make')
  })

  it('preserves meta-property identifiers from reactive overrides', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const target = $state(1)
        const meta = $state(2)
        const Fn = function () {
          return new.target
        }
        const url = import.meta.url
        return <span>{target}{meta}{String(Fn())}{url}</span>
      }
    `)

    expect(output).toContain('return new.target;')
    expect(output).toContain('const url = import.meta.url;')
    expect(output).not.toContain('new.target()')
    expect(output).not.toContain('import.meta().url')
  })

  it('preserves break and continue labels from reactive overrides', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(0)
        const stop = () => {
          count: for (let i = 0; i < 1; i++) {
            break count
          }
        }
        const next = () => {
          count: for (let i = 0; i < 1; i++) {
            continue count
          }
        }
        return <span>{count}</span>
      }
    `)

    expect(output).toContain('break count;')
    expect(output).toContain('continue count;')
    expect(output).not.toContain('break count();')
    expect(output).not.toContain('continue count();')
  })

  it('preserves object shorthand __proto__ as an own data property', () => {
    const output = transform(`
      export function f() {
        const __proto__ = 1
        const obj = { __proto__, other: Math.random() }
        return Object.prototype.hasOwnProperty.call(obj, '__proto__')
      }
    `)

    expect(output).toContain('["__proto__"]: 1')
    expect(output).not.toContain('__proto__: 1')
  })

  it('keeps call/apply destructured function props unwrapped', () => {
    const ast = parseFile(`
      function Child({ cb }) {
        cb.call(null, 'call')
        cb.apply(null, ['apply'])
        cb?.call(null, 'optcall')
        return <div>child</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const cb = __props.cb')
    expect(code).toContain('cb.call(null, "call")')
    expect(code).toContain('cb.apply(null, ["apply"])')
    expect(code).toContain('cb?.call(null, "optcall")')
    expect(code).not.toContain('const cb = prop(() => __props.cb)')
  })

  it('keeps destructured function props unwrapped when called through local aliases', () => {
    const ast = parseFile(`
      function Child({ cb }) {
        const x = cb
        let y = x
        const z = y
        x('direct')
        y?.('optional')
        z.call(null, 'call')
        return <div>child</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const cb = __props.cb')
    expect(code).toContain('let x = cb')
    expect(code).toContain('let y = x')
    expect(code).toContain('const z = y')
    expect(code).toContain('x("direct")')
    expect(code).toContain('y?.("optional")')
    expect(code).toContain('z.call(null, "call")')
    expect(code).not.toContain('x()("direct")')
    expect(code).not.toContain('const cb = prop(() => __props.cb)')
  })

  it('keeps destructured function props unwrapped when called in expression containers', () => {
    const ast = parseFile(`
      function Child({ cb, tag, Ctor }) {
        const label = \`value:\${cb('template')}\`
        tag\`\${cb('tagged')}\`
        ;(0, cb('sequence'))
        new cb('new-callee')
        new Ctor(cb('new-arg'))
        let assigned
        assigned = cb('assignment')
        Promise.resolve(cb('promise'))
        const view = <div>{label}{assigned}</div>
        return view
      }

      function* GenChild({ cb }) {
        yield cb('yield')
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const cb = __props.cb')
    expect(code).toContain('const tag = __props.tag')
    expect(code).toContain('const Ctor = __props.Ctor')
    expect(code).not.toContain('const cb = prop(() => __props.cb)')
    expect(code).not.toContain('const tag = prop(() => __props.tag)')
    expect(code).not.toContain('const Ctor = prop(() => __props.Ctor)')
  })

  it('keeps value props reactive when lexical shadows are called', () => {
    const ast = parseFile(`
      function Child({ value }) {
        try {
          throw () => 1
        } catch (value) {
          value()
        }
        for (const value of [() => 2]) {
          value()
        }
        switch (1) {
          case 1: {
            const value = () => 3
            value()
            break
          }
        }
        return <span title={value}>{value}</span>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const value = prop(() => __props.value)')
    expect(code).toContain('() => value()')
    expect(code).not.toContain('const value = __props.value')
  })

  it('keeps outer reactive reads around nested lexical shadows', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(0)
        const catchShadow = () => {
          const before = count
          try {
            throw { count: 1 }
          } catch ({ count }) {
            count
          }
          const after = count
          return before + after
        }
        const ofShadow = () => {
          const before = count
          for (const [count] of [[1]]) {
            count
          }
          const after = count
          return before + after
        }
        const inShadow = () => {
          const before = count
          for (const count in { a: 1 }) {
            count
          }
          const after = count
          return before + after
        }
        const forShadow = () => {
          const before = count
          for (let count = 0; count < 1; count++) {
            count
          }
          const after = count
          return before + after
        }
        const paramShadow = count => count
        const varShadow = () => {
          const before = count
          var count = 1
          const after = count
          return before + after
        }
        return <span>{count}</span>
      }
    `)

    expect(output).toMatch(
      /const catchShadow = \(\) => \{\s+(?:const|let) before = count\(\);[\s\S]+(?:const|let) after = count\(\);/,
    )
    expect(output).toMatch(
      /const ofShadow = \(\) => \{\s+(?:const|let) before = count\(\);[\s\S]+(?:const|let) after = count\(\);/,
    )
    expect(output).toMatch(
      /const inShadow = \(\) => \{\s+(?:const|let) before = count\(\);[\s\S]+(?:const|let) after = count\(\);/,
    )
    expect(output).toMatch(
      /const forShadow = \(\) => \{\s+(?:const|let) before = count\(\);[\s\S]+(?:const|let) after = count\(\);/,
    )
    expect(output).toContain('const paramShadow = count => count;')
    expect(output).toMatch(
      /const varShadow = \(\) => \{\s+(?:const|let) before = count;\s+var count = 1;\s+(?:const|let) after = count;/,
    )
  })

  it('keeps branch-local signal shadows scoped to their control-flow branch', () => {
    const siblingOutput = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        const flag = $state(false)
        if (flag) {
          const count = 2
          return <span>{count}</span>
        }
        return <span>{count}:{flag}</span>
      }
    `)

    expect(siblingOutput.match(/\(\) => count, createElement/g)).toHaveLength(1)
    expect(siblingOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0).toBeGreaterThan(0)

    const branchOutput = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        const flag = $state(false)
        if (flag) {
          const count = 2
          console.log(count)
        }
        return <span>{count}:{flag}</span>
      }
    `)

    expect(branchOutput).toContain('console.log(count);')
    expect(branchOutput).not.toContain('console.log(count())')
    expect(branchOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0).toBeGreaterThan(0)

    const switchOutput = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        const mode = $state('outer')
        switch (mode) {
          case 'local': {
            const count = 2
            return <span>{count}</span>
          }
          default:
            return <span>{count}:{mode}</span>
        }
      }
    `)

    expect(switchOutput.match(/\(\) => count, createElement/g)).toHaveLength(1)
    expect(switchOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0).toBeGreaterThan(0)

    const loopOutput = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        const flag = $state(false)
        if (flag) {
          while (flag) {
            const count = 2
            console.log(count)
            break
          }
        }
        return <span>{count}:{flag}</span>
      }
    `)

    expect(loopOutput).toContain('console.log(count);')
    expect(loopOutput).not.toContain('console.log(count())')
    expect(loopOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0).toBeGreaterThan(0)

    const catchOutput = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        const flag = $state(false)
        if (flag) {
          try {
            throw 1
          } catch (count) {
            console.log(count)
          }
        }
        return <span>{count}:{flag}</span>
      }
    `)

    expect(catchOutput).toContain('console.log(count);')
    expect(catchOutput).not.toContain('console.log(count())')
    expect(catchOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0).toBeGreaterThan(0)

    const destructuringOutput = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        const flag = $state(false)
        if (flag) {
          const { count } = { count: 2 }
          console.log(count)
        }
        return <span>{count}:{flag}</span>
      }
    `)

    expect(destructuringOutput).toContain('console.log(count);')
    expect(destructuringOutput).not.toContain('console.log(count())')
    expect(
      destructuringOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0,
    ).toBeGreaterThan(0)
  })

  it('keeps runtime creator imports visible after branch-local shadows', () => {
    const directOutput = transform(`
      import { createSignal } from '@fictjs/runtime'

      export function App() {
        if (false) {
          const createSignal = () => 0
          console.log(createSignal)
        }
        const count = createSignal(1)
        return <span>{count}</span>
      }
    `)

    expect(directOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0).toBeGreaterThan(0)
    expect(directOutput).not.toMatch(/\(\) => count, createElement/)

    const aliasOutput = transform(`
      import { createSignal as makeSignal } from '@fictjs/runtime'

      export function App() {
        if (false) {
          const makeSignal = () => 0
          console.log(makeSignal)
        }
        const count = makeSignal(1)
        return <span>{count}</span>
      }
    `)

    expect(aliasOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0).toBeGreaterThan(0)
    expect(aliasOutput).not.toMatch(/\(\) => count, createElement/)

    const memoOutput = transform(`
      import { createMemo } from '@fictjs/runtime'

      export function App() {
        if (false) {
          const createMemo = () => 0
          console.log(createMemo)
        }
        const count = createMemo(() => 1)
        return <span>{count}</span>
      }
    `)

    expect(memoOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0).toBeGreaterThan(0)
    expect(memoOutput).not.toMatch(/\(\) => count, createElement/)

    const namespaceOutput = transform(`
      import * as R from '@fictjs/runtime'

      export function App() {
        if (false) {
          const R = { createSignal: value => value }
          console.log(R)
        }
        const count = R.createSignal(1)
        return <span>{count}</span>
      }
    `)

    expect(namespaceOutput.match(/\(\) => count\(\), createElement/g)?.length ?? 0).toBeGreaterThan(
      0,
    )
    expect(namespaceOutput).not.toMatch(/\(\) => count, createElement/)

    const defaultOutput = transform(`
      import R from '@fictjs/runtime'

      export function App() {
        const count = R.createSignal(1)
        return <span>{count}</span>
      }
    `)

    expect(defaultOutput).toMatch(/\(\) => count, createElement/)
    expect(defaultOutput).not.toMatch(/\(\) => count\(\), createElement/)

    const trueShadowOutput = transform(`
      import { createSignal } from '@fictjs/runtime'

      export function App() {
        const createSignal = value => value
        const count = createSignal(1)
        return <span>{count}</span>
      }
    `)

    expect(trueShadowOutput).toMatch(/\(\) => count, createElement/)
    expect(trueShadowOutput).not.toMatch(/\(\) => count\(\), createElement/)
  })

  it('keeps sequence-wrapped memo creators as memo accessors', () => {
    const cases = [
      {
        name: 'macro memo',
        importSource: "import { $state, $memo } from 'fict'",
        declaration: 'const doubled = (0, $memo)(() => count * 2)',
        promotedCallPattern: /__fictUseMemo\(__fictCtx,\s*\(\) => \(0, \$memo\)/,
      },
      {
        name: 'aliased macro memo',
        importSource: "import { $state, $memo as memo } from 'fict'",
        declaration: 'const doubled = (0, memo)(() => count * 2)',
        promotedCallPattern: /__fictUseMemo\(__fictCtx,\s*\(\) => \(0, memo\)/,
      },
      {
        name: 'runtime createMemo',
        importSource: "import { $state, createMemo } from 'fict'",
        declaration: 'const doubled = (0, createMemo)(() => count * 2)',
        promotedCallPattern: /__fictUseMemo\(__fictCtx,\s*\(\) => \(0, createMemo\)/,
      },
      {
        name: 'aliased runtime createMemo',
        importSource: "import { $state, createMemo as memo } from 'fict'",
        declaration: 'const doubled = (0, memo)(() => count * 2)',
        promotedCallPattern: /__fictUseMemo\(__fictCtx,\s*\(\) => \(0, memo\)/,
      },
    ]

    for (const testCase of cases) {
      const warnings: string[] = []
      const output = transform(
        `
        ${testCase.importSource}

        export function App() {
          const count = $state(1)
          ${testCase.declaration}
          return <span>{doubled}</span>
        }
      `,
        {
          onWarn: warning => warnings.push(warning.code),
        },
      )

      expect(output, testCase.name).toMatch(/doubled\(\)/)
      expect(output, testCase.name).not.toMatch(/doubled\(\)\(\)/)
      expect(output, testCase.name).not.toMatch(testCase.promotedCallPattern)
      expect(warnings, testCase.name).not.toContain('FICT-R002')
      expect(warnings, testCase.name).not.toContain('FICT-R005')
    }
  })

  it('keeps value props reactive when unreachable prop calls exist', () => {
    const ast = parseFile(`
      function Returned({ value }) {
        return <span title={value}>{value}</span>
        value()
      }

      function DeadBranch({ value }) {
        if (false) {
          value()
        }
        return <span title={value}>{value}</span>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code.match(/const value = prop\(\(\) => __props\.value\)/g)).toHaveLength(2)
    expect(code).toContain('() => value()')
    expect(code).not.toContain('const value = __props.value')
  })

  it('keeps destructured props reactive when nested calls are mixed with JSX reads', () => {
    const ast = parseFile(`
      function Child({ label }) {
        const invokeLater = () => label()
        return <span onClick={invokeLater} title={label}>{label}</span>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('const label = prop(() => __props.label)')
    expect(code).toContain('const invokeLater = () => label()()')
    expect(code).toContain('() => label()')
    expect(code).not.toContain('const label = __props.label')
  })

  it('keeps reactive object method receivers for call apply and bind', () => {
    const ast = parseFile(`
      function App() {
        let obj = $state({
          value: 1,
          fn() {
            return this.value
          },
        })
        return (
          <section>
            <span>{obj.fn()}</span>
            <span>{obj.fn.call({ value: 2 })}</span>
            <span>{obj.fn.apply({ value: 3 })}</span>
            <span>{obj.fn.bind({ value: 4 })()}</span>
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('obj().fn.call')
    expect(code).toContain('obj().fn.apply')
    expect(code).toContain('obj().fn.bind')
    expect(code).not.toContain('obj.fn.call')
    expect(code).not.toContain('obj.fn.apply')
    expect(code).not.toContain('obj.fn.bind')
  })

  it('does not bypass the alias reassignment guard for reassigned local aliases', () => {
    const ast = parseFile(`
      function Child({ cb, other }) {
        let x = cb
        x = other
        x('local')
        return <div>child</div>
      }
    `)
    const hir = buildHIR(ast)
    let error: unknown
    try {
      lowerHIRWithRegions(hir, t)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(HIRError)
    expect((error as Error).message).toMatch(/Alias reassignment is not supported/)
  })

  it('lowers literal prop destructuring keys with computed members', () => {
    const ast = parseFile(`
      function Child({ "foo-bar": value, 0: first, nested: { "aria-label": label = 'fallback' } }) {
        return <span>{value}:{first}:{label}</span>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('__props["foo-bar"]')
    expect(code).toContain('__props[0]')
    expect(code).toContain('__props.nested["aria-label"]')
  })

  it('lowers props rest destructuring to runtime helper', () => {
    const ast = parseFile(`
      function Comp(props) {
        const { title, ...rest } = props
        return <div>{rest.count}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/__fictPropsRest\(props, /)
    expect(code).toContain('__fictPropsRest')
  })
})

// ============================================================================
// Event Handler Transformation Tests
// ============================================================================

describe('event handler transformation', () => {
  it('should transform onClick handler', () => {
    const ast = parseFile(`
      function Button() {
        let count = $state(0)
        return <button onClick={() => count = count + 1}>{count}</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).toMatch(
      /__next_\d+\s*=>\s*\(count\(__next_\d+\),\s*__next_\d+\)\)\(count\(\)\s*\+\s*1\)/,
    )
  })

  it('should transform onInput handler', () => {
    const ast = parseFile(`
      function Input() {
        let value = $state('')
        return <input onInput={(e) => value = e.target.value} value={value} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"input",/)
  })

  it('should transform onChange handler', () => {
    const ast = parseFile(`
      function Select() {
        let selected = $state('a')
        return <select onChange={(e) => selected = e.target.value}></select>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    // change is NOT a delegated event, uses bindEvent
    expect(code).toContain('bindEvent')
  })

  it('should transform onSubmit handler', () => {
    const ast = parseFile(`
      function Form() {
        const handleSubmit = (e) => {
          e.preventDefault()
        }
        return <form onSubmit={handleSubmit}></form>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    // submit is NOT a delegated event, uses bindEvent
    expect(code).toContain('bindEvent')
    expect(code).toMatch(/handleSubmit/)
  })

  it('should transform multiple event handlers', () => {
    const ast = parseFile(`
      function Interactive() {
        let count = $state(0)
        return (
          <button
            onClick={() => count++}
            onMouseEnter={() => console.log('enter')}
            onMouseLeave={() => console.log('leave')}
          >
            {count}
          </button>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    // mouseenter/mouseleave are NOT delegated, use bindEvent
    expect(code).toContain('bindEvent')
  })

  it('should handle event handler as expression', () => {
    const ast = parseFile(`
      function Toggle(props) {
        return <button onClick={props.onToggle}>Toggle</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).toMatch(/props/)
  })

  it('preserves captured identifiers in zero-arg handlers', () => {
    const ast = parseFile(`
      function Button() {
        const _e = 42
        return <button onClick={() => _e}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",\s*\(\)\s*=>\s*_e,\s*true\)/)
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*_e\s*=>\s*_e,\s*true\)/)
  })

  it('preserves call-expression handler semantics', () => {
    const ast = parseFile(`
      function Button() {
        const makeHandler = () => (e) => console.log(e.type)
        return <button onClick={makeHandler()}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/const __handler_\d+ = makeHandler\(\)/)
    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",\s*__handler_\d+,\s*true\)/)
    expect(code).not.toContain('__fictReactive(() => makeHandler())')
    expect(code).not.toContain('makeHandler.call(')
    expect(code).not.toContain('makeHandler().call(')
  })

  it('optimizes keyed list event payload/data and key text as static', () => {
    const ast = parseFile(`
      function Table() {
        let rows = $state([])
        let selected = $state(null)
        const pick = (id) => selected = id
        return (
          <table>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td><a onClick={() => pick(row.id)}>{row.label}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    // __key text should not create a per-row bindText effect
    expect(code).not.toMatch(/bindText\([^,]+,\s*\(\)\s*=>\s*__key\)/)

    expect(code).toMatch(
      /addEventListener\([^,]+,\s*"click",\s*\[pick,\s*__key,\s*"__fictDataOnlyPlain"\],\s*true\)/,
    )
    expect(code).not.toMatch(
      /addEventListener\([^,]+,\s*"click",\s*\[pick,\s*\(\)\s*=>\s*__key\],\s*true\)/,
    )
  })

  it('preserves undefined delegated event payloads as tuple data', () => {
    const ast = parseFile(`
      function Button() {
        function select(value) {
          return value
        }
        return <button onClick={() => select(undefined)}>Pick</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(
      /addEventListener\([^,]+,\s*"click",\s*\[select,\s*__fictReactive\(\(\) => undefined\),\s*"__fictDataOnlyPlain"\],\s*true\)/,
    )
  })

  it('keeps optional key member aliases optimized in keyed lists', () => {
    const ast = parseFile(`
      function Table() {
        let rows = $state([])
        const pick = (id) => id
        return (
          <table>
            <tbody>
              {rows.map((row) => (
                <tr key={row?.id}>
                  <td><a onClick={() => pick(row?.id)}>{row?.id}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('__key')
    expect(code).not.toMatch(/bindText\([^,]+,\s*\(\)\s*=>\s*__key\)/)
    expect(code).toMatch(
      /addEventListener\([^,]+,\s*"click",\s*\[pick,\s*row\(\)\?\.id,\s*"__fictDataOnlyPlain"\],\s*true\)/,
    )
    expect(code).not.toMatch(
      /addEventListener\([^,]+,\s*"click",\s*\[pick,\s*\(\)\s*=>\s*row\(\)\?\.id\],\s*true\)/,
    )
  })

  it('does not constify static member reads from dynamic computed list keys', () => {
    const ast = parseFile(`
      function Table() {
        const idKey = 'id'
        const rows = [{ id: 'actual-key', idKey: 'literal-prop' }]
        return (
          <table>
            <tbody>
              {rows.map(row => (
                <tr key={row[idKey]}>
                  <td>{row.idKey}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('row().idKey')
    expect(code).not.toMatch(/setText\([^,]+,\s*__key\)/)
    expect(code).not.toMatch(/\.data\s*=\s*String\(__key\)/)
  })

  it('keeps literal computed key aliases optimized in keyed lists', () => {
    const ast = parseFile(`
      function Table() {
        const rows = [{ id: 'actual-key' }]
        return (
          <table>
            <tbody>
              {rows.map(row => (
                <tr key={row["id"]}>
                  <td>{row.id}</td>
                </tr>
              ))}
              {rows.map(row => (
                <tr key={row?.["id"]}>
                  <td>{row?.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/setText\([^,]+,\s*__key\)/)
    expect(code).not.toMatch(/bindText\([^,]+,\s*\(\)\s*=>\s*__key\)/)
  })

  it('does not constify list key aliases with different optional semantics', () => {
    const ast = parseFile(`
      function Table() {
        const nullableRows = [null]
        const rows = [{ id: 'actual-key' }]
        return (
          <table>
            <tbody>
              {nullableRows.map(row => (
                <tr key={row?.id}>
                  <td>{row.id}</td>
                </tr>
              ))}
              {rows.map(row => (
                <tr key={row.id}>
                  <td>{row?.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('row().id')
    expect(code).toContain('row()?.id')
    expect(code).not.toMatch(/setText\([^,]+,\s*__key\)/)
    expect(code).not.toMatch(/\.data\s*=\s*String\(__key\)/)
  })

  it('does not re-emit extracted inline list key expressions in render callbacks', () => {
    const ast = parseFile(`
      function List() {
        const items = [1, 2]
        const makeKey = (item) => item
        return (
          <ul>
            {items.map(item => (
              <li key={makeKey(item)}>{item}</li>
            ))}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('createKeyedList')
    expect(code).toMatch(/=>\s*makeKey\(item\)/)
    expect(code).not.toMatch(/makeKey\(item\(\)\)/)
  })

  it('initializes extracted alias list keys from the computed key param', () => {
    const ast = parseFile(`
      function List() {
        const items = [1, 2]
        const makeKey = (item) => item
        return (
          <ul>
            {items.map(item => {
              const key = makeKey(item)
              return <li key={key}>{item}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('createKeyedList')
    expect(code).toMatch(/=>\s*makeKey\(item\)/)
    expect(code).toMatch(/const key = __key/)
    expect(code).not.toMatch(/const key = makeKey/)
  })

  it('preserves callback-local list aliases in specialized render callbacks', () => {
    const ast = parseFile(`
      function List() {
        const rows = [{ id: 'a', label: 'A' }]
        return (
          <ul>
            {rows.map(row => {
              const label = row.label
              return <li key={row.id} data-label={label}>{label}{label}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('createKeyedList')
    expect(code).toContain('const label = row().label')
    expect(code.match(/row\(\)\.label/g) ?? []).toHaveLength(1)
  })

  it('specializes list item params that collide with object prototype keys', () => {
    const names = ['__proto__', 'valueOf', 'toString', 'hasOwnProperty', 'constructor', 'prototype']

    for (const name of names) {
      const ast = parseFile(`
        function List() {
          const items = [1]
          return <ul>{items.map(${name} => <li key={${name}}>{${name}}</li>)}</ul>
        }
      `)
      const hir = buildHIR(ast)
      const file = lowerHIRWithRegions(hir, t)
      const { code } = generate(file)

      expect(code).toContain('createKeyedList')
      expect(code).toContain(`() => ${name}()`)
    }
  })

  it('specializes list index params that collide with object prototype keys', () => {
    const names = ['__proto__', 'valueOf', 'toString', 'hasOwnProperty', 'constructor', 'prototype']

    for (const name of names) {
      const ast = parseFile(`
        function List() {
          const items = ['a']
          return <ul>{items.map((item, ${name}) => <li key={${name}}>{${name}}</li>)}</ul>
        }
      `)
      const hir = buildHIR(ast)
      const file = lowerHIRWithRegions(hir, t)
      const { code } = generate(file)

      expect(code).toContain('createKeyedList')
      expect(code).toContain(`() => ${name}()`)
    }
  })

  it('specializes list key aliases that collide with object prototype keys', () => {
    const names = ['__proto__', 'valueOf', 'toString', 'hasOwnProperty', 'constructor', 'prototype']

    for (const name of names) {
      const ast = parseFile(`
        function List() {
          const items = [1]
          return <ul>{items.map(item => {
            const ${name} = item
            return <li key={${name}}>{${name}}</li>
          })}</ul>
        }
      `)
      const hir = buildHIR(ast)
      const file = lowerHIRWithRegions(hir, t)
      const { code } = generate(file)

      expect(code).toContain('createKeyedList')
      expect(code).toContain(`const ${name} = __key`)
    }
  })

  it('falls back when list key aliases are reassigned', () => {
    const ast = parseFile(`
      function List() {
        const items = [1, 2]
        return (
          <ul>
            {items.map(item => {
              let key = item
              key += 10
              return <li key={key}>{item}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('items.map')
    expect(code).toContain('key = key + 10')
  })

  it('falls back for block-bodied branch keys with multiple return sites', () => {
    const ast = parseFile(`
      function List() {
        let seq = 0
        const items = [1, 2]
        return (
          <ul>
            {items.map(item => {
              if ((seq++, item > 0)) {
                return <li key={seq}>{seq}</li>
              }
              return <li key={seq}>{seq}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('items.map')
  })

  it('falls back for branch keys that differ only by BigInt signature marker text', () => {
    const ast = parseFile(`
      function List() {
        const items = [{ big: true, name: 'a' }]
        return (
          <ul>
            {items.map(item => {
              if (item.big) {
                return <li key={1n}>{item.name}</li>
              }
              return <li key={"__bigint:1"}>{item.name}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('items.map')
    expect(code).toContain('key: 1n')
    expect(code).toContain('key: "__bigint:1"')
  })

  it('falls back for nested branch keys that differ only by BigInt signature marker text', () => {
    const ast = parseFile(`
      function List() {
        const items = [{ big: true, name: 'a' }]
        return (
          <ul>
            {items.map(item => {
              if (item.big) {
                return <li key={[1n]}>{item.name}</li>
              }
              return <li key={["__bigint:1"]}>{item.name}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('items.map')
    expect(code).toContain('key: [1n]')
    expect(code).toContain('key: ["__bigint:1"]')
  })

  it('keeps BigInt key signatures equal without colliding with marker strings', () => {
    const bigintKey: Expression = { kind: 'Literal', value: 1n }
    const sameBigintKey: Expression = { kind: 'Literal', value: 1n }
    const markerStringKey: Expression = { kind: 'Literal', value: '__bigint:1' }

    expect(keyExpressionSignature(bigintKey)).toBe(keyExpressionSignature(sameBigintKey))
    expect(keyExpressionSignature(bigintKey)).not.toBe(keyExpressionSignature(markerStringKey))
  })

  it('falls back for branch keys with different RegExp literals', () => {
    const ast = parseFile(`
      function List() {
        const items = [{ big: true, name: 'a' }]
        return (
          <ul>
            {items.map(item => {
              if (item.big) {
                return <li key={/a/}>{item.name}</li>
              }
              return <li key={/b/}>{item.name}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('items.map')
    expect(code).toContain('key: /a/')
    expect(code).toContain('key: /b/')
  })

  it('falls back for branch keys with matching RegExp source but different flags', () => {
    const ast = parseFile(`
      function List() {
        const items = [{ big: true, name: 'a' }]
        return (
          <ul>
            {items.map(item => {
              if (item.big) {
                return <li key={/a/}>{item.name}</li>
              }
              return <li key={/a/i}>{item.name}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('items.map')
    expect(code).toContain('key: /a/')
    expect(code).toContain('key: /a/i')
  })

  it('keeps RegExp key signatures equal without colliding with strings or objects', () => {
    const regexpKey: Expression = { kind: 'Literal', value: /a/g }
    const sameRegexpKey: Expression = { kind: 'Literal', value: /a/g }
    const differentFlagsKey: Expression = { kind: 'Literal', value: /a/i }
    const stringKey: Expression = { kind: 'Literal', value: '/a/g' }
    const objectKey: Expression = { kind: 'ObjectExpression', properties: [] }

    expect(keyExpressionSignature(regexpKey)).toBe(keyExpressionSignature(sameRegexpKey))
    expect(keyExpressionSignature(regexpKey)).not.toBe(keyExpressionSignature(differentFlagsKey))
    expect(keyExpressionSignature(regexpKey)).not.toBe(keyExpressionSignature(stringKey))
    expect(keyExpressionSignature(regexpKey)).not.toBe(keyExpressionSignature(objectKey))
  })

  it('falls back for unresolved callback-local list key aliases', () => {
    const ast = parseFile(`
      function List() {
        const items = [{ a: 'A', b: 'B' }]
        return (
          <ul>
            {items.map(item => {
              const k = item.a
              {
                const k = item.b
              }
              return <li key={k}>{k}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('items.map')
    expect(code).not.toMatch(/=>\s*__index/)
  })

  it('keeps throwing inline list keys only in the extracted key function', () => {
    const ast = parseFile(`
      function List() {
        const items = [1]
        const failKey = (item) => {
          throw new Error(String(item))
        }
        return (
          <ul>
            {items.map(item => (
              <li key={failKey(item)}>{item}</li>
            ))}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('createKeyedList')
    expect(code).toMatch(/=>\s*failKey\(item\)/)
    expect(code).not.toMatch(/failKey\(item\(\)\)/)
  })

  it('does not add render-time key evaluation for literal list keys', () => {
    const ast = parseFile(`
      function List() {
        const items = [1]
        return (
          <ul>
            {items.map(item => (
              <li key="static">{item}</li>
            ))}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/=>\s*"static"/)
    expect(code).not.toContain('"static";')
  })

  it('freshens generated list parameters around source internal-like names', () => {
    const ast = parseFile(`
      function Table() {
        const __index = 'outer-index'
        const __key = 'outer-key'
        const __item = 'outer-item'
        const rows = [{ id: 'a' }]
        return (
          <table>
            <tbody>
              {rows.map(item => (
                <tr key={__index}>
                  <td data-key={__key}>{__index}:{__key}</td>
                </tr>
              ))}
              {rows.map(() => (
                <tr key={__item}>
                  <td>{__item}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('(item, __index_0) => __index')
    expect(code).toContain('(item, __index_0, __key_0)')
    expect(code).toContain('(__item_0, __index_0) => __item')
    expect(code).toContain('(__item_0, __index_0, __key_0)')
  })

  it('freshens generated list parameters around named function expression self bindings', () => {
    const ast = parseFile(`
      function List() {
        const rows = [{ id: 'a' }]
        return (
          <ul>
            {rows.map(function __key(item) {
              return <li key={item.id}>{__key.name}</li>
            })}
            {rows.map(function __item() {
              return <li key="item">{__item.name}</li>
            })}
            {rows.map(function __index(item) {
              return <li key={item.id}>{__index.name}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('function __key(item, __index, __key_0)')
    expect(code).toContain('function __item(__item_0, __index, __key)')
    expect(code).toContain('function __index(item, __index_0, __key)')
    expect(code).not.toContain('function __key(item, __index, __key)')
    expect(code).not.toContain('function __item(__item,')
    expect(code).not.toContain('function __index(item, __index,')
  })

  it('does not extract delegated data when handler comes from event param', () => {
    const ast = parseFile(`
      function Comp() {
        const id = 1
        return <button onClick={(e) => e(id)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*\[/)
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*e\s*[),]/)
  })

  it('does not extract delegated data for unknown global callees', () => {
    const ast = parseFile(`
      function Comp() {
        const id = '10'
        return <button onClick={() => parseInt(id)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).toContain('parseInt(id)')
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*\[/)
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*parseInt\s*[),]/)
  })

  it('does not extract delegated data when callee is not a function binding', () => {
    const ast = parseFile(`
      function Comp() {
        const id = 1
        const pick = 1
        return <button onClick={() => pick(id)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).toContain('pick(id)')
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*\[/)
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*pick\s*[),]/)
  })
})

describe('resumable event handler transformation', () => {
  it('keeps shorthand object keys stable when renaming hoisted deps', () => {
    const ast = parseFile(`
      function Comp() {
        const helper = () => 1
        return <button onClick$={() => ({ helper })}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/helper:\s*__fict_fn_helper_\d+/)
    expect(code).not.toMatch(/\{\s*__fict_fn_helper_\d+\s*\}/)
  })

  it('preserves shadowed shorthand values when renaming hoisted deps', () => {
    const ast = parseFile(`
      export const log = []

      function Comp() {
        const helper = () => log.push('outer')
        return (
          <button
            onClick$={() => {
              function inner(helper) {
                log.push(({ helper }).helper)
              }
              const arrow = helper => log.push(({ helper }).helper)
              {
                const helper = 'block'
                log.push(({ helper }).helper)
              }
              inner('local')
              arrow('arrow')
              helper()
            }}
          >
            Click
          </button>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('export const __fict_fn_helper_')
    expect(code).toContain('function inner(helper)')
    expect(code).toContain('const arrow = helper =>')
    expect(code).toContain('const helper = "block"')
    expect(code).not.toMatch(/helper:\s*__fict_fn_helper_\d+/)
    expect(code).toMatch(/__fict_fn_helper_\d+\(\)/)
  })

  it('does not inject event parameter into zero-arg resumable handlers', () => {
    const ast = parseFile(`
      const event = 42
      function Comp() {
        return <button onClick$={() => event}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('const __handler = () => event')
    expect(code).not.toContain('const __handler = event => event')
  })

  it('preserves factory-call handler semantics in resumable mode', () => {
    const ast = parseFile(`
      function Comp() {
        const makeHandler = () => (e) => console.log(e.type)
        return <button onClick$={makeHandler()}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(
      /const __handler = function\s*\(\)\s*\{\s*return __fict_fn_makeHandler_\d+\(\);/,
    )
    expect(code).toContain('__result !== __handler')
  })

  it('throws for explicit resumable member handler references', () => {
    const cases = [
      {
        name: 'getter',
        source: `
          const holder = {
            get handler() {
              return () => 1
            },
          }
          function Comp() {
            return <button onClick$={holder.handler}>Click</button>
          }
        `,
      },
      {
        name: 'throwing getter',
        source: `
          const holder = {
            get handler() {
              throw new Error('handler')
            },
          }
          function Comp() {
            return <button onClick$={holder.handler}>Click</button>
          }
        `,
      },
      {
        name: 'proxy',
        source: `
          const holder = new Proxy({ handler: () => 1 }, {})
          function Comp() {
            return <button onClick$={holder.handler}>Click</button>
          }
        `,
      },
      {
        name: 'function-valued data member',
        source: `
          const holder = { handler: () => 1 }
          function Comp() {
            return <button onClick$={holder.handler}>Click</button>
          }
        `,
      },
      {
        name: 'module member',
        source: `
          export const holder = { handler: () => 1 }
          export function Comp() {
            return <button onClick$={holder.handler}>Click</button>
          }
        `,
      },
      {
        name: 'component-local member',
        source: `
          function Comp() {
            const holder = { handler: () => 1 }
            return <button onClick$={holder.handler}>Click</button>
          }
        `,
      },
    ]

    for (const testCase of cases) {
      const ast = parseFile(testCase.source)
      const hir = buildHIR(ast)

      expect(
        () => lowerHIRWithRegions(hir, t, { resumable: true, filename: `${testCase.name}.tsx` }),
        testCase.name,
      ).toThrow(/member-expression handler values/i)
    }
  })

  it('throws for explicit resumable mutable module handler identifiers', () => {
    const cases = [
      {
        name: 'exported let',
        source: `
          export let handler = () => 1
          export function swap() {
            handler = () => 2
          }
          export function Comp() {
            return <button onClick$={handler}>Click</button>
          }
        `,
      },
      {
        name: 'module var',
        source: `
          var handler = () => 1
          export function Comp() {
            return <button onClick$={handler}>Click</button>
          }
        `,
      },
      {
        name: 'imported binding',
        source: `
          import { handler } from './handlers'
          export function Comp() {
            return <button onClick$={handler}>Click</button>
          }
        `,
      },
      {
        name: 're-exported import',
        source: `
          import { handler } from './handlers'
          export { handler }
          export function Comp() {
            return <button onClick$={handler}>Click</button>
          }
        `,
      },
    ]

    for (const testCase of cases) {
      const ast = parseFile(testCase.source)
      const hir = buildHIR(ast)

      expect(
        () => lowerHIRWithRegions(hir, t, { resumable: true, filename: `${testCase.name}.tsx` }),
        testCase.name,
      ).toThrow(/mutable module handler identifiers/i)
    }
  })

  it('allows explicit resumable stable module handler identifiers', () => {
    const ast = parseFile(`
      const constHandler = () => 'const'
      function declaredHandler() {
        return 'declared'
      }

      export function Comp() {
        return (
          <>
            <button onClick$={constHandler}>Const</button>
            <button onClick$={declaredHandler}>Declared</button>
          </>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('const __handler = constHandler')
    expect(code).toContain('const __handler = declaredHandler')
    expect(code).toContain('__fictQrl(import.meta.url, "__fict_e0")')
    expect(code).toContain('__fictQrl(import.meta.url, "__fict_e1")')
  })

  it('captures function deps used in nested returned closures (resumable)', () => {
    const ast = parseFile(`
      function Comp() {
        const helper = () => 1
        return <button onClick$={() => () => helper()}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('export const __fict_fn_helper_')
    expect(code).toContain('() => () => __fict_fn_helper_')
    expect(code).not.toContain('() => () => helper()')
  })

  it('preserves inferred names for hoisted resumable function deps', () => {
    const ast = parseFile(`
      export const log = []

      function Comp() {
        const helper = () => 1
        return (
          <button
            onClick$={() => {
              log.push(helper.name)
              log.push(helper.length)
              helper()
            }}
          >
            Click
          </button>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/const __fict_fn_helper_\d+ = \(\(\) => \{/)
    expect(code).toContain('const helper = () => 1')
    expect(code).toContain('return helper')
    expect(code).toMatch(/log\.push\(__fict_fn_helper_\d+\.name\)/)
    expect(code).toMatch(/log\.push\(__fict_fn_helper_\d+\.length\)/)
  })

  it('throws for explicit resumable handlers that capture mutated function deps', () => {
    const ast = parseFile(`
      function Comp() {
        const helper = () => 1
        helper.extra = 'x'
        return <button onClick$={() => helper.extra}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /function mutations: helper -> = helper\.extra/i,
    )
  })

  it('throws for explicit resumable handlers that capture reassigned function deps', () => {
    const ast = parseFile(`
      function Comp() {
        let handler = () => 'off'
        handler = () => 'on'
        return <button onClick$={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /function mutations: handler -> = handler/i,
    )
  })

  it('throws for explicit resumable handlers that capture conditionally reassigned function deps', () => {
    const ast = parseFile(`
      function Comp(props) {
        let handler = () => 'off'
        if (props.enabled) {
          handler = () => 'on'
        }
        return <button onClick$={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /function mutations: handler -> = handler/i,
    )
  })

  it('throws for explicit resumable handlers that capture mutated function declarations', () => {
    const ast = parseFile(`
      function Comp() {
        function helper() {
          return 1
        }
        helper.extra = 'x'
        return <button onClick$={() => helper.extra}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /function mutations: helper -> = helper\.extra/i,
    )
  })

  it('throws for explicit resumable handlers that capture alias-mutated function deps', () => {
    const ast = parseFile(`
      function Comp() {
        const helper = () => 1
        const alias = helper
        alias.extra = 'x'
        return <button onClick$={() => helper.extra}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /function mutations: helper -> = alias\.extra/i,
    )
  })

  it('throws for explicit resumable handlers that capture Object-mutated function deps', () => {
    const ast = parseFile(`
      function Comp() {
        const helper = () => 1
        Object.defineProperty(helper, 'secret', { value: 'x' })
        Object.assign(helper, { extra: 'y' })
        return <button onClick$={() => helper.secret + helper.extra}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /function mutations: helper -> Object\.assign, Object\.defineProperty/i,
    )
  })

  it('allocates resumable event exports around existing module bindings', () => {
    const ast = parseFile(`
      export const __fict_e0 = 'user'

      export function App() {
        return <button onClick$={() => 1}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('export const __fict_e0 = "user"')
    expect(code).toContain('__fictQrl(import.meta.url, "__fict_e1")')
    expect(code).toContain('export const __fict_e1')
  })

  it('marks resumable handlers that call event preventDefault', () => {
    const ast = parseFile(`
      function Comp() {
        return (
          <a href="/next">
            <span onClick$={(event) => event.preventDefault()}>Stop</span>
          </a>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/__fictQrl\(import\.meta\.url, "__fict_e\d+", "pd"\)/)
  })

  it('does not mark inert resumable handlers as default-preventing', () => {
    const ast = parseFile(`
      function Comp() {
        return <a href="/next" onClick$={() => console.log("next")}>Next</a>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/__fictQrl\(import\.meta\.url, "__fict_e\d+"\)/)
    expect(code).not.toContain('"pd"')
  })

  it('allocates resumable function dependency exports around existing module bindings', () => {
    const ast = parseFile(`
      export const __fict_fn_helper_0 = 'user'

      function Comp() {
        const helper = () => 1
        return <button onClick$={() => helper()}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('export const __fict_fn_helper_0 = "user"')
    expect(code).toContain('export const __fict_fn_helper_1')
    expect(code).toContain('const __handler = () => __fict_fn_helper_1()')
  })

  it('does not reuse hoisted function deps across components with the same local name', () => {
    const ast = parseFile(`
      export function A() {
        const handler = () => 'A'
        return <button onClick$={handler}>A</button>
      }

      export function B() {
        const handler = () => 'B'
        return <button onClick$={handler}>B</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    const helperMatches = Array.from(
      code.matchAll(
        /export const (__fict_fn_handler_\d+) = \(\(\) => \{\s*const handler = \(\) => "([AB])";\s*return handler;\s*\}\)\(\);/g,
      ),
    ) as RegExpMatchArray[]
    const helpersByValue = new Map(helperMatches.map(match => [match[2], match[1]]))
    const aHelper = helpersByValue.get('A')
    const bHelper = helpersByValue.get('B')
    expect(aHelper).toBeDefined()
    expect(bHelper).toBeDefined()
    expect(aHelper).not.toBe(bHelper)
    const handlerAssignments = Array.from(
      code.matchAll(/const __handler = (__fict_fn_handler_\d+)/g),
    ) as RegExpMatchArray[]
    expect(handlerAssignments.map(match => match[1])).toEqual([aHelper, bHelper])
  })

  it('reuses hoisted function deps for repeated uses of the same binding', () => {
    const ast = parseFile(`
      function Comp() {
        const handler = () => 'hit'
        return (
          <>
            <button onClick$={handler}>A</button>
            <button onClick$={handler}>B</button>
          </>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    const helperExports = Array.from(
      code.matchAll(/export const (__fict_fn_handler_\d+) =/g),
    ) as RegExpMatchArray[]
    expect(helperExports).toHaveLength(1)
    const helperName = helperExports[0]![1]
    const handlerAssignments = Array.from(
      code.matchAll(/const __handler = (__fict_fn_handler_\d+)/g),
    ) as RegExpMatchArray[]
    expect(handlerAssignments.map(match => match[1])).toEqual([helperName, helperName])
  })

  it('validates same-named hoisted function deps in later components', () => {
    const ast = parseFile(`
      export function A() {
        const handler = () => 'A'
        return <button onClick$={handler}>A</button>
      }

      export function B() {
        const label = 'B'
        const handler = () => label
        return <button onClick$={handler}>B</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /function deps: handler -> label/i,
    )
  })

  it('restores destructured prop captures as accessors in resumable handlers', () => {
    const ast = parseFile(`
      function Button({ id }) {
        return <button onClick$={() => console.log(id)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('const __scopeProps = __fictGetScopeProps(scopeId) || {}')
    expect(code).toMatch(/const id = \(\) => __scopeProps\.id/)
    expect(code).toContain('const __handler = () => console.log(id())')
    expect(code).not.toContain('const id = __fictGetScopeProps(scopeId) || {}')
  })

  it('restores aliased and defaulted prop captures in resumable handlers', () => {
    const ast = parseFile(`
      function Button({ id: itemId = "fallback" }) {
        return <button onClick$={() => console.log(itemId)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/const itemId = \(\) => \(__value =>/)
    expect(code).toContain('__value === void 0 ? "fallback" : __value')
    expect(code).toContain('(__scopeProps.id)')
    expect(code).toContain('console.log(itemId())')
  })

  it('restores defaulted prop captures that read prior prop accessors', () => {
    const ast = parseFile(`
      function Button({ a, b = a, fn, fnResult = fn() }) {
        return <button onClick$={() => console.log(b, fnResult)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/const a = \(\) => __scopeProps\.a/)
    expect(code).toMatch(/const b = \(\) => \(__value => .*a\(\).*__value/)
    expect(code).toMatch(/const fn = \(\) => __scopeProps\.fn/)
    expect(code).toMatch(/const fnResult = \(\) => \(__value => .*fn\(\)\(\).*__value/)
    expect(code).toContain('console.log(b(), fnResult())')
  })

  it('restores nested prop captures in resumable handlers', () => {
    const ast = parseFile(`
      function Button({ user: { id } }) {
        return <button onClick$={() => console.log(id)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/const id = \(\) => __scopeProps\.user\.id/)
    expect(code).toContain('console.log(id())')
  })

  it('restores prop rest captures in resumable handlers', () => {
    const ast = parseFile(`
      function Button({ id, ...rest }) {
        return <button onClick$={() => console.log(rest.title)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('const rest = __fictPropsRest(__scopeProps, ["id"])')
    expect(code).toContain('console.log(rest.title)')
  })

  it('throws for explicit resumable handlers that call function props', () => {
    const ast = parseFile(`
      function Button(props) {
        return <button onClick$={() => props.onClick()}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /function props: props\.onClick/i,
    )
  })

  it('throws for explicit resumable handlers that optionally call nested function props', () => {
    const ast = parseFile(`
      function Button(props) {
        return <button onClick$={() => props.handlers.save?.()}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /function props: props\.handlers\.save/i,
    )
  })

  it('allows explicit resumable function refs that capture scalar props', () => {
    const ast = parseFile(`
      function Button(props) {
        const handler = () => props.id
        return <button onClick$={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('const __scopeProps = __fictGetScopeProps(scopeId) || {}')
    expect(code).toContain('const props = __scopeProps')
    expect(code).toContain('const handler = () => props.id')
    expect(code).toContain('const __handler = handler')
    expect(code).toContain('setAttribute("on:click"')
  })

  it('throws for explicit resumable function refs that call function props', () => {
    const ast = parseFile(`
      function Button(props) {
        const handler = () => props.onClick()
        return <button onClick$={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/function props/i)
  })

  it('allows explicit resumable handlers that read scalar props', () => {
    const ast = parseFile(`
      function Button(props) {
        return <button onClick$={() => console.log(props.id)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('setAttribute("on:click"')
    expect(code).toContain('const props = __scopeProps')
    expect(code).toContain('console.log(props.id)')
  })

  it('falls back for auto-extracted handlers that call function props', () => {
    const ast = parseFile(`
      function Button(props) {
        return <button onClick={() => {
          if (props.enabled) {
            props.onClick()
          }
        }}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
  })

  it.each(['onClickCapture$', 'onClickPassive$', 'onClickOnce$'])(
    'throws for explicit resumable handlers with %s modifiers',
    attrName => {
      const ast = parseFile(`
        function Button() {
          return <button ${attrName}={() => console.log("x")}>Click</button>
        }
      `)
      const hir = buildHIR(ast)

      expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
        /does not support event options/i,
      )
    },
  )

  it('throws for explicit resumable handlers with combined event modifiers', () => {
    const ast = parseFile(`
      function Button() {
        return <button onClickCapturePassiveOnce$={() => console.log("x")}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/capture, passive, once/)
  })

  it('falls back for auto-extracted handlers with event modifiers', () => {
    const ast = parseFile(`
      function Button() {
        return <button onClickCapture={() => {
          console.log("before")
          console.log("after")
        }}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('bindEvent')
    expect(code).toMatch(/\{\s*capture: true\s*\}/)
    expect(code).not.toContain('setAttribute("on:click"')
  })

  it.each(['onSubmit$', 'onChange$', 'onFocus$', 'onBlur$', 'onScroll$'])(
    'throws for explicit resumable handlers on unobserved %s events',
    attrName => {
      const ast = parseFile(`
        function Button() {
          return <form ${attrName}={() => console.log("x")}>Save</form>
        }
      `)
      const hir = buildHIR(ast)

      expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
        /not observed by the default loader/i,
      )
    },
  )

  it('falls back for auto-extracted handlers on unobserved events', () => {
    const ast = parseFile(`
      function Form() {
        return <form onSubmit={() => {
          console.log("before")
          console.log("after")
        }}>Save</form>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('bindEvent')
    expect(code).toContain('"submit"')
    expect(code).not.toContain('setAttribute("on:submit"')
  })

  it('throws for explicit resumable handlers that capture non-serializable locals', () => {
    const ast = parseFile(`
      function Comp() {
        const label = 'x'
        return <button onClick$={() => console.log(label)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /cannot capture non-serializable local variables/i,
    )
  })

  it('throws for explicit resumable handlers that capture function-valued signals', () => {
    const ast = parseFile(`
      function Comp() {
        const callback = $state(() => 'hit')
        return <button onClick$={() => console.log(typeof callback())}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/signals: callback/i)
  })

  it('throws for explicit resumable handlers that capture signals containing functions', () => {
    const ast = parseFile(`
      function Comp() {
        const state = $state({ label: 'x', run: () => 'hit' })
        return <button onClick$={() => console.log(state().label)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/signals: state/i)
  })

  it('allows explicit resumable handlers that capture serializable scalar signals', () => {
    const ast = parseFile(`
      function Comp() {
        const count = $state(1)
        return <button onClick$={() => console.log(count())}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('setAttribute("on:click"')
    expect(code).toContain('__fictUseLexicalScope(scopeId, ["count"])')
    expect(code).toContain('console.log(count())')
  })

  it('allows explicit resumable function refs that capture scalar signals', () => {
    const ast = parseFile(`
      function Comp() {
        const count = $state(0)
        const step = $state(1)
        const handler = () => count(count() + step())
        return <button onClick$={handler}>{count}</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('__fictUseLexicalScope(scopeId, ["count", "step"])')
    expect(code).toContain('const handler = () => count(count() + step())')
    expect(code).toContain('const __handler = handler')
    expect(code).toContain('setAttribute("on:click"')
  })

  it('allows explicit resumable function refs that return closures with signal captures', () => {
    const ast = parseFile(`
      function Comp() {
        const count = $state(0)
        const handler = () => () => count(count() + 1)
        return <button onClick$={handler}>{count}</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('__fictUseLexicalScope(scopeId, ["count"])')
    expect(code).toContain('const handler = () => () => count(count() + 1)')
    expect(code).toContain('__result !== __handler')
  })

  it('throws for explicit resumable function refs that capture function-valued signals', () => {
    const ast = parseFile(`
      function Comp() {
        const callback = $state(() => 'hit')
        const handler = () => console.log(typeof callback())
        return <button onClick$={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/signals: callback/i)
  })

  it('throws for explicit nested resumable handlers that capture outer signals', () => {
    const ast = parseFile(`
      function App() {
        const count = $state(0)
        function Inner() {
          return <button onClick$={() => count(count() + 1)}>Click</button>
        }
        return <Inner />
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/outer signals: count/i)
  })

  it('falls back for auto nested resumable handlers that capture outer signals', () => {
    const ast = parseFile(`
      function App() {
        const count = $state(0)
        function Inner() {
          return <button onClick={() => count(count() + 1)}>Click</button>
        }
        return <Inner />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
  })

  it('allows nested resumable handlers that capture their own signals', () => {
    const ast = parseFile(`
      function App() {
        function Inner() {
          const count = $state(0)
          return <button onClick$={() => count(count() + 1)}>Click</button>
        }
        return <Inner />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('setAttribute("on:click"')
    expect(code).toContain('__fictUseLexicalScope(scopeId, ["count"])')
  })

  it('throws for explicit resumable arrow handlers that capture lexical arguments', () => {
    const ast = parseFile(`
      function App(props) {
        return <button onClick$={() => arguments.length}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/arguments/i)
  })

  it('throws for explicit resumable function refs that capture lexical arguments', () => {
    const ast = parseFile(`
      function App(props) {
        const handler = () => arguments.length
        return <button onClick$={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/arguments/i)
  })

  it('falls back for auto resumable handlers that capture lexical arguments', () => {
    const ast = parseFile(`
      function App(props) {
        return (
          <button onClick={() => {
            console.log(arguments.length)
            console.log('a')
            console.log('b')
          }}>
            Click
          </button>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
  })

  it('allows explicit resumable function handlers with their own arguments', () => {
    const ast = parseFile(`
      function App(props) {
        return <button onClick$={function () { return arguments.length }}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('setAttribute("on:click"')
    expect(code).toContain('return arguments.length')
  })

  it('throws for explicit resumable arrow handlers that capture lexical new.target', () => {
    const ast = parseFile(`
      function App(props) {
        return <button onClick$={() => new.target}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/new\.target/i)
  })

  it('throws for explicit resumable function refs that capture lexical new.target', () => {
    const ast = parseFile(`
      function App(props) {
        const handler = () => new.target
        return <button onClick$={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/new\.target/i)
  })

  it('falls back for auto resumable handlers that capture lexical new.target', () => {
    const ast = parseFile(`
      function App(props) {
        return (
          <button onClick={() => {
            console.log(new.target)
            console.log('a')
            console.log('b')
          }}>
            Click
          </button>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
  })

  it('allows explicit resumable function handlers with their own new.target', () => {
    const ast = parseFile(`
      function App(props) {
        return <button onClick$={function () { return new.target }}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('setAttribute("on:click"')
    expect(code).toContain('return new.target')
  })

  it('throws for explicit resumable arrow handlers that capture lexical this', () => {
    const ast = parseFile(`
      function App(props) {
        return <button onClick$={() => this.value}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/this/i)
  })

  it('throws for explicit resumable function refs that capture lexical this', () => {
    const ast = parseFile(`
      function App(props) {
        const handler = () => this.value
        return <button onClick$={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/this/i)
  })

  it('falls back for auto resumable handlers that capture lexical this', () => {
    const ast = parseFile(`
      function App(props) {
        return (
          <button onClick={() => {
            console.log(this.value)
            console.log('a')
            console.log('b')
          }}>
            Click
          </button>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
  })

  it('allows explicit resumable function handlers with dynamic this', () => {
    const ast = parseFile(`
      function App(props) {
        return <button onClick$={function () { return this.value }}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('setAttribute("on:click"')
    expect(code).toContain('return this.value')
  })

  it('throws for explicit resumable factory handlers that capture lexical this', () => {
    const ast = parseFile(`
      function App(props) {
        const make = (value) => () => value
        return <button onClick$={make(this.value)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/this/i)
  })

  it('throws for explicit resumable factory handlers that capture lexical arguments', () => {
    const ast = parseFile(`
      function App(props) {
        const make = (value) => () => value
        return <button onClick$={make(arguments.length)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/arguments/i)
  })

  it('throws for explicit resumable factory handlers that capture lexical new.target', () => {
    const ast = parseFile(`
      function App(props) {
        const make = (value) => () => value
        return <button onClick$={make(new.target)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(/new\.target/i)
  })

  it('falls back for auto-extracted handlers that capture function-valued signals', () => {
    const ast = parseFile(`
      function Comp() {
        const callback = $state(() => 'hit')
        return (
          <button onClick={() => {
            console.log(callback())
            console.log('a')
            console.log('b')
          }}>
            Click
          </button>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
  })

  it('surfaces explicit resumable capture failures as HIRError', () => {
    const ast = parseFile(`
      function Comp() {
        const label = 'x'
        return <button onClick$={() => console.log(label)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    try {
      lowerHIRWithRegions(hir, t, { resumable: true, filename: 'module.tsx' })
      throw new Error('expected lowerHIRWithRegions to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(HIRError)
      const hirError = error as HIRError
      expect(hirError.code).toBe('BUILD_ERROR')
      expect(hirError.message).toContain('cannot capture non-serializable local variables')
      expect(hirError.context?.file).toBe('module.tsx')
      expect(hirError.context?.line).toBeDefined()
    }
  })

  it('throws for explicit resumable function refs that close over locals', () => {
    const ast = parseFile(`
      function Comp() {
        const label = 'x'
        const handler = () => console.log(label)
        return <button onClick$={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /cannot capture non-serializable local variables/i,
    )
  })

  it('throws for explicit resumable handlers that capture keyed-list aliases', () => {
    const ast = parseFile(`
      function Comp() {
        const remove = (id) => id
        let rows = $state([])
        return (
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                <button onClick$={() => remove(row.id)}>X</button>
              </li>
            ))}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)

    expect(() => lowerHIRWithRegions(hir, t, { resumable: true })).toThrow(
      /cannot capture non-serializable local variables/i,
    )
  })

  it('falls back to non-resumable handler for auto-extracted unsupported captures', () => {
    const ast = parseFile(`
      function Comp() {
        const label = 'x'
        return <button onClick={() => console.log(label)}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute(\"on:click\"')
  })

  it('falls back for auto-extracted handlers that capture mutated function deps', () => {
    const ast = parseFile(`
      function Comp() {
        const helper = () => 1
        helper.extra = 'x'
        return <button onClick={() => {
          console.log("before")
          console.log(helper.extra)
        }}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute(\"on:click\"')
  })

  it('falls back for auto-extracted handlers that capture reassigned function deps', () => {
    const ast = parseFile(`
      function Comp() {
        let handler = () => 'off'
        handler = () => 'on'
        return <button onClick={() => {
          console.log("before")
          console.log(handler())
        }}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute(\"on:click\"')
  })

  it('falls back for auto-extracted mutable module handler identifiers', () => {
    const ast = parseFile(`
      export const calls = []
      const make = (label) => () => calls.push(label)
      export let handler = make('a')

      export function swap() {
        handler = make('b')
      }

      export function App() {
        return <button onClick={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
    expect(code).not.toContain('export const __fict_e')
  })

  it('falls back for auto-extracted imported handler identifiers', () => {
    const ast = parseFile(`
      import { handler } from './events'

      export function App() {
        return <button onClick={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
    expect(code).not.toContain('export const __fict_e')
  })

  it('falls back for auto-extracted local let handler identifiers', () => {
    const ast = parseFile(`
      export function App() {
        let handler = () => console.log('click')
        return <button onClick={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
    expect(code).not.toContain('export const __fict_e')
  })

  it('falls back for auto-extracted local handler aliases with unknown stability', () => {
    const ast = parseFile(`
      export function App() {
        const base = () => console.log('click')
        const handler = base
        return <button onClick={handler}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).not.toContain('setAttribute("on:click"')
    expect(code).not.toContain('export const __fict_e')
  })

  it('auto-extracts optional and tagged calls in inline handlers', () => {
    const ast = parseFile(`
      const logger = () => console.log('optional')
      const service = {
        run() {
          console.log('member')
        }
      }
      function tag(strings) {
        console.log(strings)
      }

      export function App() {
        return (
          <div>
            <button onClick={() => logger?.()}>optional</button>
            <button onClick={() => service.run?.()}>member</button>
            <button onClick={() => tag\`clicked\`}>tagged</button>
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code.match(/setAttribute\("on:click"/g)).toHaveLength(3)
    expect(code).toContain('export const __fict_e0')
    expect(code).toContain('export const __fict_e1')
    expect(code).toContain('export const __fict_e2')
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click"/)
  })

  it('auto-extracts dynamic imports in inline handlers', () => {
    const ast = parseFile(`
      const path = "./dynamic-chunk"

      export function App() {
        return (
          <div>
            <button onClick={() => import("./chunk")}>static</button>
            <button onClick={() => import(path)}>path</button>
            <button onClick={async () => import("./async-chunk")}>async</button>
            <button onClick={async () => await import("./await-chunk")}>awaited</button>
            <input onInput={() => 1} />
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code.match(/setAttribute\("on:click"/g)).toHaveLength(4)
    expect(code).toContain('export const __fict_e0')
    expect(code).toContain('export const __fict_e1')
    expect(code).toContain('export const __fict_e2')
    expect(code).toContain('export const __fict_e3')
    expect(code).toMatch(/addEventListener\([^,]+,\s*"input"/)
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click"/)
  })

  it('auto-extracts class expressions with definition-time work in inline handlers', () => {
    const ast = parseFile(`
      function makeBase() {
        return HTMLElement
      }
      function makeKey() {
        return "run"
      }
      function makeValue() {
        return 1
      }
      function makeBlock() {
        return 2
      }

      export function App() {
        return (
          <div>
            <button onClick={() => class extends makeBase() {}}>extends</button>
            <button onClick={() => class { [makeKey()]() {} }}>computed</button>
            <button onClick={() => class { static value = makeValue() }}>field</button>
            <button onClick={() => class { static { makeBlock() } }}>block</button>
            <input onInput={() => class Local {}} />
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code.match(/setAttribute\("on:click"/g)).toHaveLength(4)
    expect(code).toContain('export const __fict_e0')
    expect(code).toContain('export const __fict_e1')
    expect(code).toContain('export const __fict_e2')
    expect(code).toContain('export const __fict_e3')
    expect(code).toMatch(/addEventListener\([^,]+,\s*"input"/)
    expect(code).not.toMatch(/addEventListener\([^,]+,\s*"click"/)
  })

  it('auto-extracts stable bare handler identifiers', () => {
    const ast = parseFile(`
      export const moduleConstHandler = () => console.log('module const')
      export function moduleFunctionHandler() {
        console.log('module function')
      }

      export function App() {
        const localConstHandler = () => console.log('local const')
        function localFunctionHandler() {
          console.log('local function')
        }
        return (
          <div>
            <button onClick={moduleConstHandler}>Module const</button>
            <button onClick={moduleFunctionHandler}>Module function</button>
            <button onClick={localConstHandler}>Local const</button>
            <button onClick={localFunctionHandler}>Local function</button>
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code.match(/setAttribute\("on:click"/g)).toHaveLength(4)
    expect(code).toContain('export const __fict_e0')
    expect(code).toContain('export const __fict_e1')
    expect(code).toContain('export const __fict_e2')
    expect(code).toContain('export const __fict_e3')
  })

  it('falls back for auto resumable handlers that would capture keyed-list aliases', () => {
    const ast = parseFile(`
      function Comp() {
        const remove = (id) => id
        let rows = $state([])
        return (
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                <button onClick={() => remove(row.id)}>X</button>
              </li>
            ))}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(code).toMatch(
      /addEventListener\([^,]+,\s*"click",\s*\[remove,\s*__key,\s*"__fictDataOnlyPlain"\],\s*true\)/,
    )
    expect(code).not.toContain('setAttribute(\"on:click\"')
  })

  it('registers resumable component resumes with full QRL keys', () => {
    const ast = parseFile(`
      export function Alpha() {
        return <button onClick$={() => 1}>A</button>
      }

      export function Beta() {
        return <button onClick$={() => 2}>B</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain(
      '__fictRegisterResume(__fictQrl(import.meta.url, "__fict_r0"), __fict_r0)',
    )
    expect(code).toContain(
      '__fictRegisterResume(__fictQrl(import.meta.url, "__fict_r1"), __fict_r1)',
    )
  })

  it('allocates resumable component exports and metadata around existing module bindings', () => {
    const ast = parseFile(`
      export const __fict_r0 = 'resume'
      export const __fict_meta_App = 'meta'

      export function App() {
        return <button>x</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('export const __fict_r0 = "resume"')
    expect(code).toContain('export const __fict_meta_App = "meta"')
    expect(code).toContain(
      '__fictRegisterResume(__fictQrl(import.meta.url, "__fict_r1"), __fict_r1)',
    )
    expect(code).toContain('const __fict_meta_App_1 =')
    expect(code).toContain('__fictSetComponentMeta(App, __fict_meta_App_1)')
  })

  it('registers resumable component metadata through a helper after user freezes', () => {
    const ast = parseFile(`
      export function App() {
        return <button>ok</button>
      }

      Object.freeze(App)
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('Object.freeze(App)')
    expect(code).toContain('__fictSetComponentMeta(App, __fict_meta_App)')
    expect(code).not.toContain('App.__fictMeta =')
  })

  it('allocates handler body names around restored signal captures', () => {
    const ast = parseFile(`
      function App() {
        const __handler = $state(0)
        const __result = $state(1)
        const event = $state(2)
        const el = $state(3)
        const scopeId = $state(4)
        return (
          <button
            onClick$={() => {
              __handler(__handler() + 1)
              __result(__result() + 1)
              event(event() + 1)
              el(el() + 1)
              scopeId(scopeId() + 1)
            }}
          >
            Click
          </button>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/export const __fict_e0 = \(scopeId_1, event_1, el_1\) =>/)
    expect(code).toContain('__fictUseLexicalScope(scopeId_1')
    expect(code).toContain('const __handler_1 = () => {')
    expect(code).toContain('const __result_1 = __handler_1.call(el_1, event_1)')
  })

  it('allocates handler body names around module-scope captures', () => {
    const ast = parseFile(`
      export const log = []
      export const scopeId = 'module-scope'
      export const event = 'module-event'
      export const el = 'module-el'
      export const __result = 'module-result'
      export const __handler = () => log.push('module-handler')

      export function App() {
        return (
          <button
            onClick$={() => {
              log.push(scopeId)
              log.push(event)
              log.push(el)
              log.push(__result)
              __handler()
            }}
          >
            Click
          </button>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toMatch(/export const __fict_e0 = \(scopeId_1, event_1, el_1\) =>/)
    expect(code).toContain('const __handler_1 = () => {')
    expect(code).toContain('log.push(scopeId)')
    expect(code).toContain('log.push(event)')
    expect(code).toContain('log.push(el)')
    expect(code).toContain('log.push(__result)')
    expect(code).toContain('__handler()')
    expect(code).toContain('const __result_1 = __handler_1.call(el_1, event_1)')
  })

  it('allocates handler locals around restored props captures', () => {
    const ast = parseFile(`
      function App(__handler) {
        return <button onClick$={() => __handler.id}>Click</button>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('const __scopeProps = __fictGetScopeProps(scopeId) || {}')
    expect(code).toContain('const __handler = __scopeProps')
    expect(code).toContain('const __handler_1 = () => __handler.id')
    expect(code).toContain('const __result = __handler_1.call(el, event)')
  })

  it('keeps loop-based resumable handlers structurized instead of truncating after setup', () => {
    const ast = parseFile(`
      const taskRows = [
        { title: 'Design review', team: 'Design' },
        { title: 'Growth sync', team: 'Growth' },
      ]

      function Tasks() {
        let query = $state('')
        let filteredTasks = $state(taskRows)

        return (
          <input
            onInput$={(event) => {
              const target = event.currentTarget
              if (!(target instanceof HTMLInputElement)) {
                return
              }

              const nextQuery = target.value
              query = nextQuery
              const normalized = nextQuery.trim().toLowerCase()
              const nextRows = []

              for (const task of taskRows) {
                if (
                  normalized.length === 0 ||
                  (task.title + ' ' + task.team).toLowerCase().includes(normalized)
                ) {
                  nextRows.push(task)
                }
              }

              filteredTasks = nextRows
            }}
          />
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t, { resumable: true })
    const { code } = generate(file)

    expect(code).toContain('for (const task of taskRows)')
    expect(code).toContain('filteredTasks(nextRows)')
    expect(code).toMatch(
      /for \(const task of taskRows\) \{[\s\S]*nextRows\.push\(task\);[\s\S]*\}\s*filteredTasks\(nextRows\)/,
    )
    expect(code).not.toContain('throw new Error("Unreachable code")')
  })
})

// ============================================================================
// Fragment Handling Tests
// ============================================================================

describe('fragment handling', () => {
  it('should handle explicit Fragment', () => {
    const ast = parseFile(`
      function List() {
        return (
          <Fragment>
            <li>Item 1</li>
            <li>Item 2</li>
          </Fragment>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    // Fragment should be processed
    expect(code).toBeDefined()
  })

  it('should handle short syntax fragment', () => {
    const ast = parseFile(`
      function List() {
        return (
          <>
            <li>Item 1</li>
            <li>Item 2</li>
          </>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
  })

  it('uses a runtime fragment alias for short fragments when a local const Fragment exists', () => {
    const output = transform(`
      const Fragment = () => <div>shadow</div>

      export function App() {
        return (
          <>
            <span>a</span>
          </>
        )
      }
    `)

    expect(output).toContain('Fragment as Fragment_1')
    expect(output).toContain('const Fragment =')
    expect(output).toContain('type: Fragment_1')
    expect(output).not.toContain('type: Fragment,')
  })

  it('uses a runtime fragment alias for short fragments when a local function Fragment exists', () => {
    const output = transform(`
      function Fragment() {
        return <div>shadow</div>
      }

      export function App() {
        return (
          <>
            <span>a</span>
          </>
        )
      }
    `)

    expect(output).toContain('Fragment as Fragment_1')
    expect(output).toContain('function Fragment()')
    expect(output).toContain('type: Fragment_1')
  })

  it('uses a runtime fragment alias for short fragments when Fragment is imported', () => {
    const output = transform(`
      import { Fragment } from './local'

      export const marker = Fragment

      export function App() {
        return (
          <>
            <span>a</span>
          </>
        )
      }
    `)

    expect(output).toContain("import { Fragment } from './local'")
    expect(output).toContain('export let marker = Fragment')
    expect(output).toContain('Fragment as Fragment_1')
    expect(output).toContain('type: Fragment_1')
  })

  it('keeps explicit local Fragment components separate from short fragment syntax', () => {
    const output = transform(`
      const Fragment = (props: any) => <section>{props.children}</section>

      export function App() {
        return (
          <Fragment label="local">
            <span>a</span>
          </Fragment>
        )
      }
    `)

    expect(output).not.toContain('Fragment as Fragment_1')
    expect(output).toContain('type: Fragment')
    expect(output).toContain('label: "local"')
  })

  it('should handle nested fragments', () => {
    const ast = parseFile(`
      function NestedList() {
        return (
          <>
            <div>
              <>
                <span>Nested 1</span>
                <span>Nested 2</span>
              </>
            </div>
          </>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
  })

  it('should handle fragment with dynamic children', () => {
    const ast = parseFile(`
      function DynamicList(props) {
        return (
          <>
            <div>{props.title}</div>
            <div>{props.content}</div>
          </>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/props/)
  })

  it('should handle fragment with conditional content', () => {
    const ast = parseFile(`
      function ConditionalList(props) {
        return (
          <>
            {props.show && <div>Visible</div>}
            <div>Always visible</div>
          </>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
  })
})

// ============================================================================
// Component Ref Handling Tests
// ============================================================================

describe('component ref handling', () => {
  it('should handle ref on element', () => {
    const ast = parseFile(`
      function WithRef() {
        const divRef = useRef(null)
        return <div ref={divRef}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    // Refs are handled with bindRef or similar
    expect(code).toBeDefined()
    expect(code).toMatch(/divRef/)
  })

  it('should handle callback ref', () => {
    const ast = parseFile(`
      function CallbackRef() {
        const handleRef = (el) => {
          console.log(el)
        }
        return <div ref={handleRef}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
    expect(code).toMatch(/handleRef/)
  })

  it('should handle ref on input', () => {
    const ast = parseFile(`
      function InputWithRef() {
        const inputRef = useRef(null)
        return <input ref={inputRef} type="text" />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
    expect(code).toMatch(/inputRef/)
  })

  it('should handle multiple refs', () => {
    const ast = parseFile(`
      function MultipleRefs() {
        const ref1 = useRef(null)
        const ref2 = useRef(null)
        return (
          <div>
            <input ref={ref1} />
            <button ref={ref2}>Click</button>
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
    expect(code).toMatch(/ref1/)
    expect(code).toMatch(/ref2/)
  })

  it('preserves ref expressions for props, signal, and callback refs', () => {
    const ast = parseFile(`
      function RefMatrix(props) {
        const liveRef = $state(null)
        const cb = (el) => el
        return (
          <div>
            <input ref={props.inputRef} />
            <input ref={liveRef} />
            <input ref={cb} />
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('bindRef')
    expect(code).toMatch(/bindRef\([^,]+,\s*__fictReactive\(\(\)\s*=>\s*props\.inputRef\)\)/)
    expect(code).toMatch(/bindRef\([^,]+,\s*__fictReactive\(\(\)\s*=>\s*liveRef\(\)\)\)/)
    expect(code).toMatch(/bindRef\([^,]+,\s*cb\)/)
  })
})

// ============================================================================
// Style Binding Tests
// ============================================================================

describe('style binding', () => {
  it('should handle static style object', () => {
    const ast = parseFile(`
      function StyledDiv() {
        return <div style={{ color: 'red', fontSize: '16px' }}>Text</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    // Style uses bindStyle for reactive paths and setStyle for static paths
    expect(code).toMatch(/bindStyle|setStyle/)
    expect(code).toMatch(/color/)
  })

  it('should handle dynamic style property', () => {
    const ast = parseFile(`
      function DynamicStyle() {
        let color = $state('red')
        return <div style={{ color: color }}>Text</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('bindStyle')
    expect(code).toMatch(/color/)
  })

  it('should handle style variable', () => {
    const ast = parseFile(`
      function StyleVar(props) {
        const styles = { color: props.color, margin: '10px' }
        return <div style={styles}>Text</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('bindStyle')
    expect(code).toMatch(/styles/)
  })

  it('should handle conditional style', () => {
    const ast = parseFile(`
      function ConditionalStyle(props) {
        return <div style={props.active ? { color: 'green' } : { color: 'gray' }}>Text</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('bindStyle')
  })

  it('should handle computed style values', () => {
    const ast = parseFile(`
      function ComputedStyle(props) {
        const width = props.size + 'px'
        return <div style={{ width: width }}>Text</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('bindStyle')
    expect(code).toMatch(/width/)
  })

  it('should keep optional member style bindings reactive', () => {
    const ast = parseFile(`
      function OptionalStyle() {
        let theme = $state({ color: 'red' })
        return <div style={theme?.color}>Text</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('bindStyle')
  })
})

// ============================================================================
// Spread Operator in JSX Tests
// ============================================================================

describe('spread operator in JSX', () => {
  it('should handle props spread', () => {
    const ast = parseFile(`
      function Wrapper(props) {
        return <div {...props}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/props/)
    expect(code).toContain('spread(')
  })

  it('does not skip spread children when no explicit host children exist', () => {
    const ast = parseFile(`
      function Box(props) {
        return <div {...props} />
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/spread\([\s\S]*false,\s*false\)/)
  })

  it('skips spread children when authored whitespace children are normalized away', () => {
    const ast = parseFile(`
      function Box(props) {
        return (
          <div {...props}>
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/spread\([\s\S]*false,\s*true\)/)
  })

  it('skips spread children for comments-only host child syntax', () => {
    const ast = parseFile(`
      function Box(props) {
        return <div {...props}>{/* comment */}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/spread\([\s\S]*false,\s*true\)/)
  })

  it('passes the SVG flag to descendant spreads in SVG root templates', () => {
    const ast = parseFile(`
      function Icon(props) {
        return <svg><use {...props}></use></svg>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/spread\([\s\S]*true,\s*true\)/)
  })

  it('should handle spread with additional props', () => {
    const ast = parseFile(`
      function ExtendedWrapper(props) {
        return <div {...props} className="wrapper">Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/props/)
    expect(code).toMatch(/className|class/)
  })

  it('should handle spread from object variable', () => {
    const ast = parseFile(`
      function SpreadVar() {
        const attrs = { id: 'test', className: 'box' }
        return <div {...attrs}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/attrs/)
  })

  it('should handle multiple spreads', () => {
    const ast = parseFile(`
      function MultiSpread(props) {
        const extras = { role: 'button' }
        return <div {...props} {...extras}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/props/)
    expect(code).toMatch(/extras/)
  })

  it('should handle spread after specific props', () => {
    const ast = parseFile(`
      function SpreadAfter(props) {
        return <div id="specific" {...props}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/props/)
    expect(code).toMatch(/specific/)
  })

  it('should preserve static attribute order after spread in fine-grained output', () => {
    const ast = parseFile(`
      function SpreadOrder(props) {
        return <div {...props} data-role="fixed">Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('spread(')
    expect(code).toMatch(/spread\([\s\S]*\["data-role"\]/)
  })

  it('escapes static expression attributes in template HTML', () => {
    const ast = parseFile(`
      function EscapedAttrs() {
        return (
          <div
            title={"&copy;"}
            data-x={"a&b"}
            data-tag={"<tag>"}
            data-quote={'"quoted"'}
            data-apos={"it's"}
          />
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('title=\\"&amp;copy;\\"')
    expect(code).toContain('data-x=\\"a&amp;b\\"')
    expect(code).toContain('data-tag=\\"&lt;tag>\\"')
    expect(code).toContain('data-quote=\\"&quot;quoted&quot;\\"')
    expect(code).toContain('data-apos=\\"it\'s\\"')
  })

  it('routes content JSX props through DOM properties', () => {
    const ast = parseFile(`
      function ContentProps() {
        let text = $state('hello')
        let html = $state('<span>x</span>')
        return (
          <section>
            <div textContent="static" />
            <div innerText={"plain"} />
            <div innerHTML={"<b>bold</b>"} />
            <div textContent={text} innerHTML={html} data-id="ok" />
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/setProp\([^,]+,\s*"textContent",\s*"static"\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"innerText",\s*"plain"\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"innerHTML",\s*"<b>bold<\/b>"\)/)
    expect(code).toMatch(/bindProperty\([^,]+,\s*"textContent",\s*\(\)\s*=>\s*text\(\)\)/)
    expect(code).toMatch(/bindProperty\([^,]+,\s*"innerHTML",\s*\(\)\s*=>\s*html\(\)\)/)
    expect(code).not.toContain('textContent=\\"')
    expect(code).not.toContain('innerText=\\"')
    expect(code).not.toContain('innerHTML=\\"')
    expect(code).toContain('data-id=\\"ok\\"')
  })

  it('routes form default JSX props through DOM properties', () => {
    const ast = parseFile(`
      function DefaultProps() {
        let val = $state('x')
        let on = $state(true)
        return (
          <section>
            <input defaultValue="static" defaultChecked={true} indeterminate={true} value={val} checked={on} />
            <input indeterminate={on} />
            <input defaultValue={val} defaultChecked={on} />
            <option defaultSelected={on}>item</option>
            <video defaultMuted={on} />
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/setProp\([^,]+,\s*"defaultValue",\s*"static"\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"defaultChecked",\s*true\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"defaultValue",\s*val\(\)\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"defaultChecked",\s*on\(\)\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"defaultSelected",\s*on\(\)\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"defaultMuted",\s*on\(\)\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"indeterminate",\s*true\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"value",\s*val\(\)\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"checked",\s*on\(\)\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"indeterminate",\s*on\(\)\)/)
    expect(code).not.toContain('defaultValue=\\"')
    expect(code).not.toContain('defaultChecked=\\"')
    expect(code).not.toContain('indeterminate=\\"')
  })

  it('routes textarea expression children through the value property', () => {
    const ast = parseFile(`
      function TextareaChildValue() {
        let text = $state('hi')
        return <textarea>{text}</textarea>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/bindProperty\([^,]+,\s*"value",\s*\(\)\s*=>\s*text\(\)\)/)
    expect(code).not.toContain('bindText')
    expect(code).not.toContain('<textarea> ')
  })

  it('routes raw-text and RCDATA expression children through textContent', () => {
    const ast = parseFile(`
      function RawTextChildren() {
        let show = $state(true)
        let css = $state('body { color: red; }')
        return (
          <section>
            <script type="application/json">{show && <span>code</span>}</script>
            <style>{css}</style>
            <title>{show && <span>title</span>}</title>
            <script type="application/json" children={show && <span>child</span>} />
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('bindTextContent')
    expect(code).not.toContain('<script><!--fict:slot:start--><!--fict:slot:end--></script>')
    expect(code).not.toContain('<style><!--fict:slot:start--><!--fict:slot:end--></style>')
    expect(code).not.toContain('<title><!--fict:slot:start--><!--fict:slot:end--></title>')
    expect(code).not.toContain('getSlotEnd')
  })

  it('routes custom element JSX props through DOM properties', () => {
    const ast = parseFile(`
      function CustomElementProps() {
        let value = $state(1)
        return (
          <section>
            <my-widget fooBar={value} foo-bar="dash" config={{ nested: true }} enabled />
            <button is="fancy-button" foo-bar={value} />
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/setProp\([^,]+,\s*"foobar",\s*value\(\)\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"fooBar",\s*"dash"\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"config",\s*\{\s*nested:\s*true\s*\}\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"enabled",\s*true\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"fooBar",\s*value\(\)\)/)
    expect(code).toContain('createRenderEffect')
    expect(code).toContain('is=\\"fancy-button\\"')
    expect(code).not.toContain('fooBar=\\"')
    expect(code).not.toContain('foo-bar=\\"')
    expect(code).not.toContain('config=\\"')
    expect(code).not.toContain('bindAttribute')
  })

  it('routes intrinsic children props through child insertion', () => {
    const ast = parseFile(`
      function ChildrenProps() {
        let text = $state('hello')
        return (
          <section>
            <div children="static" />
            <div children={text} />
            <div children={<span>node</span>} />
            <div children="ignored">explicit</div>
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('<!--fict:slot:start--><!--fict:slot:end-->')
    expect(code).toMatch(/insertBetween\([^,]+,\s*[^,]+,\s*\(\)\s*=>\s*"static"/)
    expect(code).toMatch(/insertBetween\([^,]+,\s*[^,]+,\s*\(\)\s*=>\s*text\(\)/)
    expect(code).toContain('<div>explicit</div>')
    expect(code).not.toContain('children=\\"')
    expect(code).not.toContain('bindAttribute')
  })

  it('stringifies boolean aria and data attributes', () => {
    const ast = parseFile(`
      function BooleanAttrs() {
        let on = $state(true)
        return (
          <section>
            <div
              aria-hidden={true}
              aria-expanded={false}
              data-active={true}
              data-off={false}
              draggable={true}
              contentEditable={true}
              spellCheck={false}
              hidden={true}
              disabled={false}
            />
            <div draggable={false} contentEditable={false} spellCheck={true} />
            <div
              aria-live={on}
              data-on={on}
              draggable={on}
              contentEditable={on}
              spellCheck={on}
              hidden={on}
              bool:data-forced={on}
            />
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('aria-hidden=\\"true\\"')
    expect(code).toContain('aria-expanded=\\"false\\"')
    expect(code).toContain('data-active=\\"true\\"')
    expect(code).toContain('data-off=\\"false\\"')
    expect(code).toContain('draggable=\\"true\\"')
    expect(code).toContain('draggable=\\"false\\"')
    expect(code).toContain('contentEditable=\\"true\\"')
    expect(code).toContain('contentEditable=\\"false\\"')
    expect(code).toContain('spellCheck=\\"false\\"')
    expect(code).toContain('spellCheck=\\"true\\"')
    expect(code).toContain(
      '<div aria-hidden=\\"true\\" aria-expanded=\\"false\\" data-active=\\"true\\" data-off=\\"false\\" draggable=\\"true\\" contentEditable=\\"true\\" spellCheck=\\"false\\" hidden></div>',
    )
    expect(code).toMatch(/setAttr\([^,]+,\s*"aria-live",\s*on\(\)\)/)
    expect(code).toMatch(/setAttr\([^,]+,\s*"data-on",\s*on\(\)\)/)
    expect(code).toMatch(/setAttr\([^,]+,\s*"draggable",\s*on\(\)\)/)
    expect(code).toMatch(/setAttr\([^,]+,\s*"contentEditable",\s*on\(\)\)/)
    expect(code).toMatch(/setAttr\([^,]+,\s*"spellCheck",\s*on\(\)\)/)
    expect(code).toContain('setAttribute("data-forced", "")')
    expect(code).not.toContain('bool:data-forced')
  })

  it('routes forced JSX binding prefixes through their target bindings', () => {
    const ast = parseFile(`
      function ForcedPrefixes() {
        let text = $state('hello')
        let hidden = $state(false)
        return (
          <section>
            <div attr:title="static title" bool:data-forced={true} prop:textContent={'static text'} />
            <div attr:title={text} bool:hidden={hidden} prop:textContent={text} />
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/setAttr\([^,]+,\s*"title",\s*"static title"\)/)
    expect(code).toContain('setAttribute("data-forced", "")')
    expect(code).toMatch(/setProp\([^,]+,\s*"textContent",\s*"static text"\)/)
    expect(code).toMatch(/setAttr\([^,]+,\s*"title",\s*text\(\)\)/)
    expect(code).toMatch(/setProp\([^,]+,\s*"textContent",\s*text\(\)\)/)
    expect(code).toContain('setAttribute("hidden", "")')
    expect(code).not.toContain('attr:title')
    expect(code).not.toContain('bool:data-forced')
    expect(code).not.toContain('prop:textContent')
  })

  it('escapes static JSX text in template HTML', () => {
    const ast = parseFile(`
      function EscapedText() {
        return (
          <section>
            <div>&lt;span&gt;safe&lt;/span&gt; &amp; done</div>
            <p>a&nbsp;b</p>
            <svg><text>&lt;icon&gt;</text></svg>
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('&lt;span&gt;safe&lt;/span&gt; &amp; done')
    expect(code).not.toContain('<div><span>safe</span> & done</div>')
    expect(code).toContain('a\\xA0b')
    expect(code).toContain('&lt;icon&gt;')
  })

  it('preserves whitespace-only JSX text in template HTML', () => {
    const ast = parseFile(`
      function WhitespaceText() {
        return (
          <section>
            <pre>  </pre>
            <span> </span>
            <p>&nbsp;</p>
            <div>A <strong>B</strong> C</div>
          </section>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('<pre>  </pre>')
    expect(code).toContain('<span> </span>')
    expect(code).toContain('<p>\\xA0</p>')
    expect(code).toContain('<div>A <strong>B</strong> C</div>')
  })

  it('skips spread children when explicit host children are present', () => {
    const ast = parseFile(`
      function Wrapper(props) {
        return <div {...props}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/spread\([\s\S]*false,\s*true\)/)
  })

  it('should not duplicate fused bindings when spread forces mid-stream flush', () => {
    const ast = parseFile(`
      function SpreadWithReactiveClass(props) {
        let cls = $state('ready')
        return <div className={cls} {...props}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    const bindClassMatches = code.match(/bindClass\(/g) ?? []
    expect(bindClassMatches.length).toBe(1)
  })
})

// ============================================================================
// Array/Map Rendering Tests
// ============================================================================

describe('array/map rendering', () => {
  it('should handle simple map rendering', () => {
    const ast = parseFile(`
      function List(props) {
        return (
          <ul>
            {props.items.map(item => <li>{item}</li>)}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    // Map is transformed to onDynamicChildren or similar
    expect(code).toBeDefined()
    expect(code).toMatch(/props/)
  })

  it('preserves non-trusted map receivers instead of list-specializing them', () => {
    const ast = parseFile(`
      function List(props) {
        return (
          <ul>
            {props.items.map(item => <li key={item.id}>{item.name}</li>)}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('props.items.map')
  })

  it('preserves map callbacks with observable side effects', () => {
    const ast = parseFile(`
      function List() {
        let rows = $state([{ id: 1, name: 'a' }])
        const log = []
        return (
          <ul>
            {rows.map(row => {
              log.push(row.name)
              return <li key={row.id}>{row.name}</li>
            })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('rows().map')
    expect(code).toContain('log.push')
  })

  it('reads function-valued list items before assigning event handlers', () => {
    const ast = parseFile(`
      function List() {
        const handlers = [() => {}]
        return (
          <div>
            {handlers.map(fn => <button onClick={fn}>x</button>)}
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('createKeyedList')
    expect(code).toMatch(/__fictReactive\(\(\) => fn\(\)\)/)
    expect(code).not.toContain('fn.call(this')
  })

  it('preserves function-valued list item calls without list specialization', () => {
    const ast = parseFile(`
      function List() {
        const handlers = [() => 'child']
        return (
          <div>
            {handlers.map(fn => <span>{fn()}</span>)}
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toContain('createKeyedList')
    expect(code).toContain('handlers.map')
    expect(code).toContain('fn()')
  })

  it('should handle map with index', () => {
    const ast = parseFile(`
      function IndexedList(props) {
        return (
          <ul>
            {props.items.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
  })

  it('should handle nested map', () => {
    const ast = parseFile(`
      function NestedList(props) {
        return (
          <ul>
            {props.groups.map(group => (
              <li>
                <ul>
                  {group.items.map(item => <li>{item}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
  })

  it('should handle filter and map chain', () => {
    const ast = parseFile(`
      function FilteredList(props) {
        return (
          <ul>
            {props.items.filter(x => x.active).map(item => <li>{item.name}</li>)}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
  })

  it('should handle conditional rendering in map', () => {
    const ast = parseFile(`
      function ConditionalList(props) {
        return (
          <ul>
            {props.items.map(item => (
              item.visible && <li>{item.text}</li>
            ))}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
  })

  it('should handle map callback with rest params', () => {
    const ast = parseFile(`
      function RestList(props) {
        return (
          <ul>
            {props.items.map((item, ...rest) => <li key={item.id}>{item.id}</li>)}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toMatch(/createKeyedList/)
    expect(code).toMatch(/\.map\(/)
    expect(code).toMatch(/item\s*,\s*\.\.\.rest/)
    expect(code).not.toMatch(/\.\.\.rest\s*,\s*__key/)
  })

  it('defers optional map callback factory evaluation and keeps init ordering safe', () => {
    const ast = parseFile(`
      function makeMapper() {
        return item => <li key={item}>{item}</li>
      }

      function OptionalFactoryList(props) {
        return (
          <ul>
            {props.items?.map(makeMapper())}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toMatch(/createKeyedList/)
    expect(code).toContain('props.items?.map(makeMapper())')
    expect(code).not.toContain(', makeMapper(),')
  })

  it('should preserve async map callbacks without list specialization', () => {
    const ast = parseFile(`
      function AsyncList(props) {
        return (
          <ul>
            {props.items.map(async item => <li>{item}</li>)}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toMatch(/createKeyedList/)
    expect(code).toMatch(/\.map\(/)
    expect(code).toMatch(/async item/)
  })

  it('should preserve generator map callbacks without list specialization', () => {
    const ast = parseFile(`
      function GeneratorList(props) {
        return (
          <ul>
            {props.items.map(function* (item) { yield item })}
          </ul>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).not.toMatch(/createKeyedList/)
    expect(code).toMatch(/\.map\(/)
    expect(code).toMatch(/function\*/)
  })
})

// ============================================================================
// Class Binding Tests
// ============================================================================

describe('class binding', () => {
  it('should handle static className', () => {
    const ast = parseFile(`
      function StaticClass() {
        return <div className="container">Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/class|className/)
    expect(code).toMatch(/container/)
  })

  it('should handle dynamic className', () => {
    const ast = parseFile(`
      function DynamicClass() {
        let active = $state(false)
        return <div className={active ? 'active' : 'inactive'}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/active/)
  })

  it('should handle template literal className', () => {
    const ast = parseFile(`
      function TemplateClass(props) {
        return <div className={\`item \${props.type}\`}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    // Class is handled with bindClass helper
    expect(code).toContain('bindClass')
  })

  it('should handle className from variable', () => {
    const ast = parseFile(`
      function VarClass(props) {
        const classes = props.isActive ? 'active' : 'inactive'
        return <div className={classes}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/classes/)
  })

  it('should keep optional member class bindings reactive', () => {
    const ast = parseFile(`
      function OptionalClass() {
        let user = $state({ profile: { active: true } })
        return <div className={user?.profile?.active ? 'active' : ''}>Content</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('bindClass')
  })
})

// ============================================================================
// Conditional Rendering Tests
// ============================================================================

describe('conditional rendering', () => {
  it('routes reactive expression-level returns through conditionals', () => {
    const ast = parseFile(`
      function ReturnConditional() {
        let flag = $state(true)
        return flag ? <span>on</span> : <em>off</em>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('createConditional')
    expect(code).not.toContain('return flag() ?')
  })

  it('should handle ternary conditional', () => {
    const ast = parseFile(`
      function Conditional(props) {
        return <div>{props.show ? <span>Visible</span> : <span>Hidden</span>}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/show/)
  })

  it('should handle && conditional', () => {
    const ast = parseFile(`
      function AndConditional(props) {
        return <div>{props.show && <span>Visible</span>}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/show/)
  })

  it('should handle || conditional', () => {
    const ast = parseFile(`
      function OrConditional(props) {
        return <div>{props.value || 'Default'}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/value/)
  })

  it('should handle nested conditionals', () => {
    const ast = parseFile(`
      function NestedConditional(props) {
        return (
          <div>
            {props.a ? (
              props.b ? <span>Both</span> : <span>Only A</span>
            ) : (
              <span>None</span>
            )}
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toBeDefined()
  })

  it('should handle nullish coalescing', () => {
    const ast = parseFile(`
      function NullishConditional(props) {
        return <div>{props.name ?? 'Anonymous'}</div>
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toMatch(/name/)
  })
})

// ============================================================================
// Complex Component Integration Tests
// ============================================================================

describe('complex component integration', () => {
  it('should handle counter component with multiple features', () => {
    const ast = parseFile(`
      function Counter() {
        let count = $state(0)
        const doubled = count * 2
        return (
          <div className="counter">
            <span>{count}</span>
            <span>{doubled}</span>
            <button onClick={() => count++}>+</button>
            <button onClick={() => count--}>-</button>
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('__fictUseSignal')
    expect(code).toMatch(/addEventListener\([^,]+,\s*"click",/)
  })

  it('should handle form component with state', () => {
    const ast = parseFile(`
      function Form() {
        let name = $state('')
        let email = $state('')
        const handleSubmit = (e) => {
          e.preventDefault()
          console.log(name, email)
        }
        return (
          <form onSubmit={handleSubmit}>
            <input
              value={name}
              onInput={(e) => name = e.target.value}
            />
            <input
              value={email}
              onInput={(e) => email = e.target.value}
            />
            <button type="submit">Submit</button>
          </form>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('__fictUseSignal')
    expect(code).toContain('bindEvent')
    expect(code).toMatch(/addEventListener\([^,]+,\s*"input",/)
  })

  it('should handle todo list component', () => {
    const ast = parseFile(`
      function TodoList() {
        let todos = $state([])
        let input = $state('')
        const addTodo = () => {
          todos = [...todos, { text: input, done: false }]
          input = ''
        }
        return (
          <div>
            <input
              value={input}
              onInput={(e) => input = e.target.value}
            />
            <button onClick={addTodo}>Add</button>
            <ul>
              {todos.map(todo => <li>{todo.text}</li>)}
            </ul>
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    const file = lowerHIRWithRegions(hir, t)
    const { code } = generate(file)

    expect(code).toContain('__fictUseSignal')
  })
})
