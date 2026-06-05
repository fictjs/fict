import { describe, expect, it } from 'vitest'
import * as BabelCore from '@babel/core'
import { parseSync } from '@babel/core'
import { buildHIR, convertStatementsToHIRFunction } from '../src/ir/build-hir'
import {
  type AssignInstruction,
  type Expression,
  type HIRFunction,
  type JSXAttribute,
  type JSXElementExpression,
  type Identifier,
  type ObjectExpression,
  type ObjectProperty,
  type Terminator,
  isAssignInstruction,
} from '../src/ir/hir'
import { printHIR } from '../src/ir/printer'
import { firstFunction, functionAt, namedFunction } from './hir-test-utils'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

type ReturnTerminator = Extract<Terminator, { kind: 'Return' }> & { argument: Expression }

function assertDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message)
  }
  return value
}

function getAssignTargets(fn: HIRFunction): string[] {
  return fn.blocks
    .flatMap(block => block.instructions)
    .filter(isAssignInstruction)
    .map(instr => instr.target.name)
}

function findAssignInstruction(fn: HIRFunction, targetName: string): AssignInstruction | undefined {
  return fn.blocks
    .flatMap(block => block.instructions)
    .filter(isAssignInstruction)
    .find(instr => instr.target.name === targetName)
}

function findReturnWithArgument(fn: HIRFunction): ReturnTerminator | undefined {
  return fn.blocks
    .map(block => block.terminator)
    .find((term): term is ReturnTerminator => term.kind === 'Return' && term.argument !== undefined)
}

function isObjectProperty(
  property: ObjectExpression['properties'][number],
): property is ObjectProperty {
  return property.kind === 'Property'
}

function isJSXElementExpression(value: JSXAttribute['value']): value is JSXElementExpression {
  return value?.kind === 'JSXElement'
}

function isLiteralExpression(
  value: JSXAttribute['value'],
): value is Extract<Expression, { kind: 'Literal' }> {
  return value?.kind === 'Literal'
}

function expectIdentifierExpression(
  value: Expression | string | undefined,
  message: string,
): Identifier {
  if (!value || typeof value === 'string' || value.kind !== 'Identifier') {
    throw new Error(message)
  }
  return value
}

describe('buildHIR', () => {
  it('builds simple functions into blocks with branch', () => {
    const ast = parseFile(`
      function Foo(x) {
        let y = x + 1
        if (y > 1) {
          return y
        }
        return 0
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed).not.toContain('<hir empty>')
    expect(printed).toContain('block 0')
    expect(printed.toLowerCase()).toContain('branch')
    expect(printed.toLowerCase()).toContain('return')
  })

  it('builds while loops with branch and back-edge', () => {
    const ast = parseFile(`
      function Loop(n) {
        let i = 0
        while (i < n) {
          i = i + 1
        }
        return i
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('branch')
    expect(printed.toLowerCase()).toContain('jump')
  })

  it('builds for loops with init/update and back-edge', () => {
    const ast = parseFile(`
      function Sum(n) {
        let total = 0
        for (let i = 0; i < n; i = i + 1) {
          total = total + i
        }
        return total
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('jump')
    expect(printed.toLowerCase()).toContain('branch')
  })

  it('preserves nested function directive metadata', () => {
    const ast = parseFile(`
      function View() {
        const noMemo = () => {
          "use no memo"
          return 1
        }
        const pure = function () {
          "use pure"
          return 2
        }
        return noMemo() + pure()
      }
    `)
    const hir = buildHIR(ast)
    const instructions = firstFunction(hir)?.blocks.flatMap(block => block.instructions) ?? []
    const noMemoFn = instructions.find(
      instr =>
        instr.kind === 'Assign' &&
        instr.target.name === 'noMemo' &&
        instr.value.kind === 'ArrowFunction',
    )
    const pureFn = instructions.find(
      instr =>
        instr.kind === 'Assign' &&
        instr.target.name === 'pure' &&
        instr.value.kind === 'FunctionExpression',
    )

    expect(
      noMemoFn && noMemoFn.kind === 'Assign' && noMemoFn.value.kind === 'ArrowFunction'
        ? noMemoFn.value.noMemo
        : undefined,
    ).toBe(true)
    expect(
      pureFn && pureFn.kind === 'Assign' && pureFn.value.kind === 'FunctionExpression'
        ? pureFn.value.pure
        : undefined,
    ).toBe(true)
  })
})

describe('buildHIR - complex control flow', () => {
  it('handles nested if/else statements', () => {
    const ast = parseFile(`
      function NestedIf(x) {
        if (x > 0) {
          if (x > 10) {
            return 'large'
          } else {
            return 'medium'
          }
        } else {
          return 'negative'
        }
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(firstFunction(hir).blocks.length).toBeGreaterThanOrEqual(4)
    expect(printed.toLowerCase()).toContain('branch')
    expect(printed).toContain('return')
  })

  it('handles if-else-if chains', () => {
    const ast = parseFile(`
      function Grade(score) {
        if (score >= 90) {
          return 'A'
        } else if (score >= 80) {
          return 'B'
        } else if (score >= 70) {
          return 'C'
        } else {
          return 'F'
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir).blocks.length).toBeGreaterThanOrEqual(5)
  })

  it('handles switch statements', () => {
    const ast = parseFile(`
      function DayName(day) {
        switch (day) {
          case 1:
            return 'Monday'
          case 2:
            return 'Tuesday'
          default:
            return 'Unknown'
        }
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('switch')
    expect(firstFunction(hir).blocks.length).toBeGreaterThanOrEqual(2)
  })

  it('handles do-while loops', () => {
    const ast = parseFile(`
      function DoWhile(n) {
        let i = 0
        do {
          i = i + 1
        } while (i < n)
        return i
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('branch')
    expect(printed.toLowerCase()).toContain('jump')
  })

  it('handles try-catch blocks', () => {
    const ast = parseFile(`
      function TryCatch(x) {
        try {
          return x.foo
        } catch (e) {
          return null
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
    // Try-catch is simplified in current implementation
    const printed = printHIR(hir)
    expect(printed).toContain('function TryCatch')
  })

  it('handles nested loops', () => {
    const ast = parseFile(`
      function NestedLoop(n, m) {
        let sum = 0
        for (let i = 0; i < n; i = i + 1) {
          for (let j = 0; j < m; j = j + 1) {
            sum = sum + i * j
          }
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    // Nested loops should create multiple blocks
    expect(firstFunction(hir).blocks.length).toBeGreaterThanOrEqual(5)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('jump')
    expect(printed.toLowerCase()).toContain('branch')
  })

  it('handles if inside loop', () => {
    const ast = parseFile(`
      function LoopWithIf(n) {
        let evens = 0
        for (let i = 0; i < n; i = i + 1) {
          if (i % 2 === 0) {
            evens = evens + 1
          }
        }
        return evens
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir).blocks.length).toBeGreaterThanOrEqual(4)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('branch')
  })
})

// ============================================================================
// P1 Test Fixtures: Advanced Patterns
// ============================================================================

describe('buildHIR - Advanced Patterns', () => {
  it('handles deep optional chain access', () => {
    const ast = parseFile(`
      function DeepOptional(props) {
        const name = props?.user?.profile?.name ?? 'anonymous'
        return name
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
    const printed = printHIR(hir)
    expect(printed).toContain('name')
  })

  it('handles optional chaining when isChainExpression is unavailable', () => {
    const types = BabelCore.types as typeof BabelCore.types & {
      isChainExpression?: ((node: unknown, opts?: unknown) => boolean) | undefined
    }
    const prev = types.isChainExpression
    try {
      types.isChainExpression = undefined
      const ast = parseFile(`
        function Compat(props) {
          return props?.user?.name
        }
      `)
      expect(() => buildHIR(ast)).not.toThrow()
    } finally {
      types.isChainExpression = prev
    }
  })

  it('handles nested destructuring with spread', () => {
    const ast = parseFile(`
      function DestructureSpread(data) {
        const { user: { name, ...userRest }, items, ...rest } = data
        return { name, userRest, items, rest }
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })

  it('handles array destructuring with defaults', () => {
    const ast = parseFile(`
      function ArrayDestructure(arr) {
        const [first = 0, second = 1, ...rest] = arr
        return first + second + rest.length
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })

  it('handles object pattern variable declarations', () => {
    const ast = parseFile(`
      function Foo() {
        const { count, double } = useCounter()
        return count + double
      }
    `)
    const hir = buildHIR(ast)
    const fn = firstFunction(hir)
    expect(fn.blocks.length).toBeGreaterThan(0)
    const targets = getAssignTargets(fn)
    expect(targets).toContain('count')
    expect(targets).toContain('double')
  })

  it('resets destructuring temp names between buildHIR calls', () => {
    const parseWrapperStatements = () => {
      const wrapper = parseFile(`
        function Wrapper(getSource) {
          const { count } = getSource()
          return count
        }
      `).program.body[0]

      if (!wrapper || !BabelCore.types.isFunctionDeclaration(wrapper)) {
        throw new Error('expected function declaration')
      }

      return wrapper.body.body
    }
    const getDestructTemps = (fn: ReturnType<typeof convertStatementsToHIRFunction>) =>
      fn.blocks
        .flatMap(block => block.instructions)
        .filter(instr => instr.kind === 'Assign')
        .map(instr => instr.target.name)
        .filter(name => name.startsWith('__destruct_'))

    const polluted = convertStatementsToHIRFunction('Wrapper', parseWrapperStatements())
    expect(getDestructTemps(polluted)).toContain('__destruct_0')

    buildHIR(
      parseFile(`
        function Foo() {
          return 1
        }
      `),
    )

    const afterBuild = convertStatementsToHIRFunction('Wrapper', parseWrapperStatements())
    expect(getDestructTemps(afterBuild)).toContain('__destruct_0')
  })

  it('resets destructuring temp names for statement block conversion', () => {
    const parseStatements = (code: string) =>
      parseFile(`
        function Wrapper(getSource) {
          ${code}
        }
      `).program.body[0]

    const wrapper = parseStatements(`
      const { count } = getSource()
      return count
    `)

    if (!wrapper || !BabelCore.types.isFunctionDeclaration(wrapper)) {
      throw new Error('expected function declaration')
    }

    const first = convertStatementsToHIRFunction('Wrapper', wrapper.body.body)
    const second = convertStatementsToHIRFunction('Wrapper', wrapper.body.body)
    const getDestructTemps = (fn: typeof first) =>
      fn.blocks
        .flatMap(block => block.instructions)
        .filter(instr => instr.kind === 'Assign')
        .map(instr => instr.target.name)
        .filter(name => name.startsWith('__destruct_'))

    expect(getDestructTemps(first)).toContain('__destruct_0')
    expect(getDestructTemps(second)).toContain('__destruct_0')
  })

  it('handles destructuring assignment statements', () => {
    const ast = parseFile(`
      function Assign(getObj, arr) {
        let a = 0
        let b = 0
        ;({ a } = getObj())
        ;[b] = arr
        return a + b
      }
    `)
    const hir = buildHIR(ast)
    const fn = namedFunction(hir, 'Assign', 0)
    const targets = getAssignTargets(fn)
    expect(targets).toContain('a')
    expect(targets).toContain('b')
  })

  it('handles complex conditional with loops', () => {
    const ast = parseFile(`
      function ComplexControl(items, filter) {
        let result = []
        if (filter.enabled) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].active) {
              result.push(items[i])
            }
          }
        } else {
          result = items.slice()
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir).blocks.length).toBeGreaterThanOrEqual(4)
  })

  it('handles nested ternary expressions', () => {
    const ast = parseFile(`
      function NestedTernary(a, b, c) {
        const result = a > 0
          ? b > 0
            ? 'both positive'
            : 'a positive only'
          : c > 0
            ? 'c positive only'
            : 'none positive'
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })

  it('handles computed property access in loops', () => {
    const ast = parseFile(`
      function ComputedLoop(obj, keys) {
        let sum = 0
        for (let i = 0; i < keys.length; i++) {
          sum = sum + obj[keys[i]]
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir).blocks.length).toBeGreaterThanOrEqual(3)
  })

  it('preserves array literal holes', () => {
    const ast = parseFile(`
      function Hole() {
        const arr = [, 1]
        return arr
      }
    `)
    const hir = buildHIR(ast)
    const assign = firstFunction(hir).blocks[0]?.instructions.find(isAssignInstruction)
    expect(assign?.value.kind).toBe('ArrayExpression')
    if (assign?.value.kind !== 'ArrayExpression') {
      throw new Error('expected array expression assignment')
    }
    expect(assign.value.elements).toHaveLength(2)
    expect(assign.value.elements[0]).toBeNull()
    expect(assign.value.elements[1]?.kind).toBe('Literal')
  })

  it('preserves class expressions', () => {
    const ast = parseFile(`
      function Klass() {
        const C = class {
          method() {
            return 1
          }
        }
        return new C()
      }
    `)
    expect(() => buildHIR(ast)).not.toThrow()
  })

  it('preserves class declarations', () => {
    const ast = parseFile(`
      function KlassDecl() {
        class C {
          method() {
            return 1
          }
        }
        return new C()
      }
    `)
    expect(() => buildHIR(ast)).not.toThrow()
  })

  it('extracts identifiers from rest parameter patterns', () => {
    const ast = parseFile(`
      function Rest(...[a, b]) {
        return a + b
      }
      function RestObj(...{ c, d }) {
        return c + d
      }
    `)
    const hir = buildHIR(ast)
    const restFn = namedFunction(hir, 'Rest', 0)
    const restObjFn = namedFunction(hir, 'RestObj', 1)
    expect(restFn.params.map(p => p.name)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(restObjFn.params.map(p => p.name)).toEqual(expect.arrayContaining(['c', 'd']))
  })

  it('preserves computed object literal keys', () => {
    const ast = parseFile(`
      function Obj(key) {
        const obj = { [key]: 1, fixed: 2 }
        return obj
      }
    `)
    const hir = buildHIR(ast)
    const fn = namedFunction(hir, 'Obj', 0)
    const assign = assertDefined(findAssignInstruction(fn, 'obj'), 'expected obj assign')
    const objExpr = assign.value
    expect(objExpr?.kind).toBe('ObjectExpression')
    if (objExpr.kind !== 'ObjectExpression') {
      throw new Error('expected object expression')
    }
    const props = objExpr.properties
    expect(props.length).toBe(2)
    const computedProp = assertDefined(
      props.find((p): p is ObjectProperty => isObjectProperty(p) && !!p.computed),
      'expected computed property',
    )
    const computedKey = expectIdentifierExpression(
      computedProp.key,
      'expected computed identifier key',
    )
    expect(computedKey.kind).toBe('Identifier')
    expect(computedKey.name).toBe('key')
    const fixedProp = assertDefined(
      props.find((p): p is ObjectProperty => isObjectProperty(p) && !p.computed),
      'expected fixed property',
    )
    const fixedKey = expectIdentifierExpression(fixedProp.key, 'expected fixed identifier key')
    expect(fixedKey.kind).toBe('Identifier')
    expect(fixedKey.name).toBe('fixed')
  })

  it('captures object method kinds', () => {
    const ast = parseFile(`
      function ObjMethods() {
        const obj = {
          get foo() { return 1 },
          set foo(v) { },
          bar() { return 2 }
        }
        return obj
      }
    `)
    const hir = buildHIR(ast)
    const fn = namedFunction(hir, 'ObjMethods', 0)
    const assign = assertDefined(findAssignInstruction(fn, 'obj'), 'expected obj assign')
    const objExpr = assign.value
    if (objExpr.kind !== 'ObjectExpression') {
      throw new Error('expected object expression')
    }
    const props = objExpr.properties
    const getter = assertDefined(
      props.find((p): p is ObjectProperty => isObjectProperty(p) && p.propertyKind === 'get'),
      'expected getter property',
    )
    const setter = assertDefined(
      props.find((p): p is ObjectProperty => isObjectProperty(p) && p.propertyKind === 'set'),
      'expected setter property',
    )
    const method = assertDefined(
      props.find((p): p is ObjectProperty => isObjectProperty(p) && p.propertyKind === 'method'),
      'expected method property',
    )
    expect(getter).toBeDefined()
    expect(setter).toBeDefined()
    expect(method).toBeDefined()
  })

  it('handles JSX with conditional children', () => {
    const ast = parseFile(`
      function ConditionalJSX(props) {
        return (
          <div>
            {props.show ? <span>{props.text}</span> : null}
            {props.items?.map(item => <li key={item.id}>{item.name}</li>)}
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('jsx')
  })

  it('preserves JSX attribute values and namespaced attributes', () => {
    const ast = parseFile(`
      function App() {
        const url = '/icon'
        return (
          <Comp
            icon={<Icon />}
            frag={<><span /></>}
            xlink:href={url}
            xml:space="preserve"
          />
        )
      }
    `)
    const hir = buildHIR(ast)
    const fn = namedFunction(hir, 'App', 0)
    const returnTerm = assertDefined(findReturnWithArgument(fn), 'expected jsx return')
    const jsx = returnTerm.argument
    expect(jsx.kind).toBe('JSXElement')
    if (jsx.kind !== 'JSXElement') {
      throw new Error('expected jsx element')
    }
    const attrs = jsx.attributes
    const iconAttr = assertDefined(
      attrs.find(a => a.name === 'icon'),
      'expected icon attr',
    )
    expect(iconAttr.value?.kind).toBe('JSXElement')
    if (!isJSXElementExpression(iconAttr.value)) {
      throw new Error('expected icon jsx element')
    }
    const iconVal = iconAttr.value
    const iconTag = expectIdentifierExpression(iconVal.tagName, 'expected icon identifier tag')
    expect(iconTag.kind).toBe('Identifier')
    expect(iconTag.name).toBe('Icon')
    const fragAttr = assertDefined(
      attrs.find(a => a.name === 'frag'),
      'expected frag attr',
    )
    expect(fragAttr.value?.kind).toBe('JSXElement')
    if (!isJSXElementExpression(fragAttr.value)) {
      throw new Error('expected fragment jsx element')
    }
    const fragVal = fragAttr.value
    const fragTag = expectIdentifierExpression(fragVal.tagName, 'expected fragment identifier tag')
    expect(fragTag.kind).toBe('Identifier')
    expect(fragTag.name).toBe('Fragment')
    const xlinkAttr = assertDefined(
      attrs.find(a => a.name === 'xlink:href'),
      'expected xlink attr',
    )
    expect(xlinkAttr).toBeDefined()
    const xmlAttr = assertDefined(
      attrs.find(a => a.name === 'xml:space'),
      'expected xml attr',
    )
    expect(xmlAttr.value?.kind).toBe('Literal')
    if (!isLiteralExpression(xmlAttr.value)) {
      throw new Error('expected xml literal attr')
    }
    expect(xmlAttr.value.value).toBe('preserve')
  })

  it('throws on JSX spread children', () => {
    const ast = parseFile(`
      function App(items) {
        return <>{...items}</>
      }
    `)
    expect(() => buildHIR(ast)).toThrow(/JSX spread children are not supported/)
  })

  it('preserves deeply nested fragment children', () => {
    const ast = parseFile(`
      function App() {
        return <><><><span>A</span></></></>
      }
    `)
    const hir = buildHIR(ast)
    const fn = namedFunction(hir, 'App', 0)
    const returnTerm = assertDefined(findReturnWithArgument(fn), 'expected fragment return')
    const fragment = returnTerm.argument

    expect(fragment.kind).toBe('JSXElement')
    if (fragment.kind !== 'JSXElement') {
      throw new Error('expected fragment jsx element')
    }
    const fragmentTag = expectIdentifierExpression(fragment.tagName, 'expected fragment tag')
    expect(fragmentTag.name).toBe('Fragment')
    expect(fragment.children).toHaveLength(1)
    expect(fragment.children[0]?.kind).toBe('element')
    const child = fragment.children[0]
    if (!child || child.kind !== 'element') {
      throw new Error('expected fragment element child')
    }
    expect(child.value.tagName).toBe('span')
  })

  it('handles callback with reactive closure', () => {
    const ast = parseFile(`
      function ReactiveCallback(items, onClick) {
        return items.map((item, i) => (
          <button onClick={() => onClick(item, i)}>
            {item.label}
          </button>
        ))
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })
})

// ============================================================================
// Break/Continue Statement Tests
// ============================================================================

describe('buildHIR - break statements', () => {
  it('handles break in for-of loop', () => {
    const ast = parseFile(`
      function BreakForOf(items, target) {
        let found = null
        for (const item of items) {
          if (item.id === target) {
            found = item
            break
          }
        }
        return found
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('break')
  })

  it('handles break in for-in loop', () => {
    const ast = parseFile(`
      function BreakForIn(obj, targetKey) {
        let foundValue = null
        for (const key in obj) {
          if (key === targetKey) {
            foundValue = obj[key]
            break
          }
        }
        return foundValue
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('break')
  })

  it('handles break in nested for-of loops (inner loop only)', () => {
    const ast = parseFile(`
      function BreakNested(matrix) {
        let count = 0
        for (const row of matrix) {
          for (const cell of row) {
            if (cell < 0) {
              break
            }
            count = count + 1
          }
        }
        return count
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('break')
    expect(firstFunction(hir).blocks.length).toBeGreaterThanOrEqual(4)
  })
})

describe('buildHIR - continue statements', () => {
  it('handles continue in for-of loop', () => {
    const ast = parseFile(`
      function ContinueForOf(items) {
        const result = []
        for (const item of items) {
          if (!item.active) {
            continue
          }
          result.push(item)
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('continue')
  })

  it('handles continue in for-in loop', () => {
    const ast = parseFile(`
      function ContinueForIn(obj) {
        const result = {}
        for (const key in obj) {
          if (key.startsWith('_')) {
            continue
          }
          result[key] = obj[key]
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('continue')
  })

  it('handles multiple continue statements', () => {
    const ast = parseFile(`
      function MultiContinue(items) {
        const result = []
        for (const item of items) {
          if (item === null) {
            continue
          }
          if (item.skip) {
            continue
          }
          result.push(item)
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect((printed.toLowerCase().match(/continue/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('buildHIR - labeled statements', () => {
  it('handles labeled break in nested for-of loops', () => {
    const ast = parseFile(`
      function LabeledBreak(matrix, target) {
        let found = false
        outer: for (const row of matrix) {
          for (const cell of row) {
            if (cell === target) {
              found = true
              break outer
            }
          }
        }
        return found
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('break')
  })

  it('handles labeled continue in nested for-of loops', () => {
    const ast = parseFile(`
      function LabeledContinue(matrix) {
        let sum = 0
        outer: for (const row of matrix) {
          for (const cell of row) {
            if (cell < 0) {
              continue outer
            }
            sum = sum + cell
          }
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('continue')
  })

  it('handles labeled block with break', () => {
    const ast = parseFile(`
      function LabeledBlock(items) {
        let result = null
        search: {
          for (const item of items) {
            if (item.match) {
              result = item
              break search
            }
          }
          result = { fallback: true }
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })

  it('handles multiple nested labeled loops', () => {
    const ast = parseFile(`
      function MultiLabel(cube) {
        let count = 0
        outer: for (const plane of cube) {
          middle: for (const row of plane) {
            for (const cell of row) {
              if (cell === 0) {
                continue middle
              }
              if (cell < 0) {
                break outer
              }
              count = count + 1
            }
          }
        }
        return count
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })
})

describe('buildHIR - throw statements', () => {
  it('handles throw statement', () => {
    const ast = parseFile(`
      function ThrowError(x) {
        if (x < 0) {
          throw new Error('negative value')
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('throw')
  })

  it('handles throw in try-catch', () => {
    const ast = parseFile(`
      function ThrowInTry(x) {
        try {
          if (x === null) {
            throw new Error('null value')
          }
          return x.value
        } catch (e) {
          return 0
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('throw')
  })

  it('handles rethrow in catch', () => {
    const ast = parseFile(`
      function Rethrow(fn) {
        try {
          return fn()
        } catch (e) {
          console.error(e)
          throw e
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })
})

describe('buildHIR - try-finally patterns', () => {
  it('handles try-finally without catch', () => {
    const ast = parseFile(`
      function TryFinally(resource) {
        try {
          return resource.read()
        } finally {
          resource.close()
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
    const printed = printHIR(hir)
    expect(printed).toContain('TryFinally')
  })

  it('handles return in try with finally', () => {
    const ast = parseFile(`
      function ReturnInTry(x) {
        let result = 0
        try {
          if (x > 0) {
            return x
          }
          result = x * -1
        } finally {
          console.log('cleanup')
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })

  it('handles throw in try with finally', () => {
    const ast = parseFile(`
      function ThrowInTryWithFinally(x) {
        try {
          if (x === null) {
            throw new Error('null')
          }
          return x
        } finally {
          console.log('always runs')
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })

  it('handles nested try-finally', () => {
    const ast = parseFile(`
      function NestedTryFinally(a, b) {
        try {
          try {
            return a.read()
          } finally {
            a.close()
          }
        } finally {
          b.cleanup()
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })
})

describe('buildHIR - switch fall-through', () => {
  it('handles switch with fall-through cases', () => {
    const ast = parseFile(`
      function SwitchFallthrough(x) {
        let result = ''
        switch (x) {
          case 1:
          case 2:
          case 3:
            result = 'small'
            break
          case 4:
          case 5:
            result = 'medium'
            break
          default:
            result = 'large'
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('switch')
  })

  it('handles switch without default', () => {
    const ast = parseFile(`
      function SwitchNoDefault(x) {
        let result = 'unknown'
        switch (x) {
          case 'a':
            result = 'alpha'
            break
          case 'b':
            result = 'beta'
            break
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })

  it('handles switch with return in cases', () => {
    const ast = parseFile(`
      function SwitchReturn(x) {
        switch (x) {
          case 1:
            return 'one'
          case 2:
            return 'two'
          default:
            return 'other'
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('return')
  })

  it('handles switch with mixed return and break', () => {
    const ast = parseFile(`
      function SwitchMixed(x, y) {
        let result = 0
        switch (x) {
          case 1:
            if (y > 0) {
              return y
            }
            result = 1
            break
          case 2:
            result = 2
            break
          default:
            return -1
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(firstFunction(hir)).toBeDefined()
  })
})
