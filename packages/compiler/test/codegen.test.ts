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
    expect(code).toContain('props.count(props.count() + 1)')
    expect(code).toContain('props.double()')
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
    expect(code).toContain('count(count() + 1)')
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

    expect(code).toMatch(/const __destruct_\d+ = useCounter\(\)/)
    expect(code).toMatch(/const props = __destruct_\d+/)
    expect(code).toContain('props.count()')
    expect(code).toContain('props.count(props.count() + 1)')
    expect(code).toContain('props.double()')
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

    // Event handlers are transformed to bindEvent or similar
    expect(code).toContain('bindEvent')
    expect(code).toContain('count(count() + 1)')
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

    expect(code).toContain('bindEvent')
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

    // Multiple event handlers
    expect((code.match(/bindEvent/g) || []).length).toBeGreaterThanOrEqual(1)
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

    expect(code).toContain('bindEvent')
    expect(code).toMatch(/props/)
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

    // Style uses bindStyle helper
    expect(code).toContain('bindStyle')
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
})

// ============================================================================
// Conditional Rendering Tests
// ============================================================================

describe('conditional rendering', () => {
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
    expect(code).toContain('bindEvent')
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
