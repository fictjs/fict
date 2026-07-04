import { describe, expect, it } from 'vitest'

import { isRegionMemoizable } from '../src/ir/regions'
import type { Region } from '../src/ir/regions'

import { transform } from './test-utils'

const STRICT_GUARANTEE_OPTIONS = { strictGuarantee: true, dev: false } as const

type CollectedWarning = { code: string; message: string }

function collectWarnings(
  source: string,
  options: Parameters<typeof transform>[1] = {},
): CollectedWarning[] {
  const previousStrictGuaranteeEnv = process.env.FICT_STRICT_GUARANTEE
  delete process.env.FICT_STRICT_GUARANTEE
  const warnings: CollectedWarning[] = []
  try {
    transform(source, {
      strictGuarantee: false,
      ...options,
      onWarn: warning => warnings.push(warning as CollectedWarning),
    })
    return warnings
  } finally {
    if (previousStrictGuaranteeEnv === undefined) {
      delete process.env.FICT_STRICT_GUARANTEE
    } else {
      process.env.FICT_STRICT_GUARANTEE = previousStrictGuaranteeEnv
    }
  }
}

function collectWarningCodes(
  source: string,
  options: Parameters<typeof transform>[1] = {},
): string[] {
  return collectWarnings(source, options).map(warning => warning.code)
}

describe('reactivity guarantee contract', () => {
  describe('Guaranteed', () => {
    const guaranteedCases: Array<{ name: string; source: string }> = [
      {
        name: 'top-level state and derived bindings',
        source: `
          import { $state } from 'fict'
          function App() {
            let count = $state(0)
            const doubled = count * 2
            return <button onClick={() => count++}>{doubled}</button>
          }
        `,
      },
      {
        name: 'JSX handler captures reactive value without escape',
        source: `
          import { $state } from 'fict'
          function App() {
            let count = $state(0)
            const handleClick = () => {
              count = count + 1
            }
            return <button onClick={handleClick}>{count}</button>
          }
        `,
      },
      {
        name: 'non-escaping iterator callbacks remain allowed',
        source: `
          import { $state } from 'fict'
          function App() {
            let count = $state(0)
            const items = [1, 2, 3]
            return <ul>{items.map(item => <li key={item}>{count + item}</li>)}</ul>
          }
        `,
      },
      {
        name: 'iterator callback over a reactive array capturing another signal',
        source: `
          import { $state } from 'fict'
          function App() {
            let selected = $state(0)
            let rows = $state([{ id: 1 }, { id: 2 }])
            return (
              <ul>
                {rows.map(row => (
                  <li
                    key={row.id}
                    class={selected === row.id ? 'sel' : ''}
                    onClick={() => {
                      selected = row.id
                    }}
                  >
                    {row.id}
                  </li>
                ))}
              </ul>
            )
          }
        `,
      },
      {
        name: 'supported nested props destructuring remains reactive',
        source: `
          function App({ user: { name } }) {
            return <div>{name}</div>
          }
        `,
      },
      {
        name: 'state initializer can read props without escape fallback',
        source: `
          import { $state } from 'fict'
          function App({ initial = 0 }) {
            let count = $state(initial)
            return <div>{count}</div>
          }
        `,
      },
      {
        name: 'reactive value passed to a local hook is not an escape',
        source: `
          import { $state } from 'fict'
          function useDouble(n) {
            const doubled = n * 2
            return { doubled }
          }
          function App({ factor = 1 }) {
            let count = $state(0)
            const derived = count * factor
            const a = useDouble(count)
            const b = useDouble(factor)
            const c = useDouble(derived)
            return <div>{a.doubled + b.doubled + c.doubled}</div>
          }
        `,
      },
    ]

    for (const testCase of guaranteedCases) {
      it(testCase.name, () => {
        expect(() => transform(testCase.source, STRICT_GUARANTEE_OPTIONS)).not.toThrow()
      })
    }
  })

  describe('Fallback (strictGuarantee => error)', () => {
    const fallbackCases: Array<{ name: string; source: string; error: RegExp }> = [
      {
        name: 'props array pattern fallback',
        source: `
          function App({ list: [first, second] }) {
            return <div>{first}{second}</div>
          }
        `,
        error: /FICT-P001/,
      },
      {
        name: 'props array rest fallback',
        source: `
          function App({ list: [first, ...rest] }) {
            return <div>{first}</div>
          }
        `,
        error: /FICT-P002/,
      },
      {
        name: 'computed props key fallback (dynamic key)',
        source: `
          const key = 'name'
          function App({ [key]: value }) {
            return <div>{value}</div>
          }
        `,
        error: /FICT-P003/,
      },
      {
        name: 'nested rest props pattern fallback',
        source: `
          function App({ user: { ...userRest } }) {
            return <pre>{JSON.stringify(userRest)}</pre>
          }
        `,
        error: /FICT-P004/,
      },
      {
        name: 'dynamic props spread fallback',
        source: `
          function Parent(props) {
            return <Child {...props()} id="next" />
          }
          function Child(allProps) {
            return <div>{allProps.id}</div>
          }
        `,
        error: /FICT-P005/,
      },
      {
        name: 'tagged-template props spread fallback',
        source: `
          function tag(strings) {
            return { value: strings[0] }
          }
          function Parent() {
            return <Child {...tag\`value\`} />
          }
          function Child(allProps) {
            return <div>{allProps.value}</div>
          }
        `,
        error: /FICT-P005/,
      },
      {
        name: 'template-literal props spread fallback',
        source: `
          import { $state } from 'fict'
          function Parent() {
            let count = $state(1)
            return <Child {...\`\${count}\`} />
          }
          function Child(allProps) {
            return <div>{allProps[0]}</div>
          }
        `,
        error: /FICT-P005/,
      },
      {
        name: 'array-literal props spread with spread element fallback',
        source: `
          function Parent(items) {
            return <Child {...[...items]} />
          }
          function Child(allProps) {
            return <div>{allProps[0]}</div>
          }
        `,
        error: /FICT-P005/,
      },
      {
        name: 'plain template-literal props spread fallback',
        source: `
          function Parent() {
            return <Child {...\`value\`} />
          }
          function Child(allProps) {
            return <div>{allProps[0]}</div>
          }
        `,
        error: /FICT-P005/,
      },
      {
        name: 'dynamic import props spread fallback',
        source: `
          function Parent() {
            return <Child {...import('./props')} />
          }
          function Child(allProps) {
            return <div>{allProps.value}</div>
          }
        `,
        error: /FICT-P005/,
      },
      {
        name: 'class expression props spread fallback',
        source: `
          function Parent() {
            return <Child {...class Props {}} />
          }
          function Child(allProps) {
            return <div>{allProps.value}</div>
          }
        `,
        error: /FICT-P005/,
      },
      {
        name: 'class expression static props spread fallback',
        source: `
          function Parent() {
            return <Child {...class Props {
              static x = 1
              static [String('y')] = 2
              static {
                this.z = 3
              }
            }} />
          }
          function Child(allProps) {
            return <div>{allProps.x}{allProps.y}{allProps.z}</div>
          }
        `,
        error: /FICT-P005/,
      },
      {
        name: 'direct state argument escape fallback',
        source: `
          import { $state } from 'fict'
          function sink(value) {
            return value
          }
          function App() {
            let count = $state(0)
            sink(count)
            return <div />
          }
        `,
        error: /FICT-S002/,
      },
      {
        name: 'optional direct state argument escape fallback',
        source: `
          import { $state } from 'fict'
          function sink(value) {
            return value
          }
          function App() {
            let count = $state(0)
            sink?.(count)
            return <div />
          }
        `,
        error: /FICT-S002/,
      },
      {
        name: 'reactive value escaping through unknown function call',
        source: `
          import { $state } from 'fict'
          function sink(value) {
            return value
          }
          function App() {
            let count = $state(0)
            const doubled = count * 2
            sink(doubled)
            return <div />
          }
        `,
        error: /FICT-R002/,
      },
      {
        name: 'reactive value escaping through optional unknown function call',
        source: `
          import { $state } from 'fict'
          function sink(value) {
            return value
          }
          function App() {
            let count = $state(0)
            sink?.([count])
            return <div />
          }
        `,
        error: /FICT-R002/,
      },
      {
        name: 'state argument escaping through constructor call',
        source: `
          import { $state } from 'fict'
          class Box {
            constructor(value) {
              this.value = value
            }
          }
          function App() {
            let count = $state(0)
            new Box(count)
            return <div />
          }
        `,
        error: /FICT-S002/,
      },
      {
        name: 'reactive value escaping through constructor argument',
        source: `
          import { $state } from 'fict'
          class Box {
            constructor(value) {
              this.value = value
            }
          }
          function App() {
            let count = $state(0)
            new Box([count])
            return <div />
          }
        `,
        error: /FICT-R002/,
      },
      {
        name: 'state interpolation escaping through tagged template',
        source: `
          import { $state } from 'fict'
          function tag(strings, ...values) {
            return values
          }
          function App() {
            let count = $state(0)
            tag\`\${count}\`
            return <div />
          }
        `,
        error: /FICT-S002/,
      },
      {
        name: 'reactive callback escaping through unknown function boundary',
        source: `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            consume(() => count + 1)
            return <div />
          }
        `,
        error: /FICT-R002/,
      },
      {
        name: 'reactive callback escaping through unknown member boundary',
        source: `
          import { $state } from 'fict'
          function App() {
            let count = $state(0)
            const bus = {
              subscribe(fn) {
                return fn()
              },
            }
            bus.subscribe(() => count + 1)
            return <div />
          }
        `,
        error: /FICT-R002/,
      },
      {
        name: 'named reactive closure escaping through unknown function boundary',
        source: `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            const readCount = () => count
            consume(readCount)
            return <div />
          }
        `,
        error: /FICT-R002/,
      },
      {
        name: 'hoisted reactive closure escaping before declaration',
        source: `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            consume(readCount)
            function readCount() {
              return count
            }
            return <div />
          }
        `,
        error: /FICT-R005/,
      },
      {
        name: 'returned nested reactive closure escaping through unknown boundary',
        source: `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            consume(() => () => count)
            return <div />
          }
        `,
        error: /FICT-R005/,
      },
      {
        name: 'object-property reactive closure escaping through unknown boundary',
        source: `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            const callbacks = { read: () => count }
            consume(callbacks.read)
            return <div />
          }
        `,
        error: /FICT-R002/,
      },
      {
        name: 'aliased object-property reactive closure escaping through unknown boundary',
        source: `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            const callbacks = { read: () => count }
            const read = callbacks.read
            consume(read)
            return <div />
          }
        `,
        error: /FICT-R005/,
      },
      {
        name: 'object shorthand reactive closure escaping through unknown boundary',
        source: `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            const read = () => count
            const callbacks = { read }
            consume(callbacks.read)
            return <div />
          }
        `,
        error: /FICT-R005/,
      },
      {
        name: 'object slot assigned reactive closure escaping through unknown boundary',
        source: `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            const callbacks = {}
            const readCount = () => count
            callbacks.read = readCount
            consume(callbacks.read)
            return <div />
          }
        `,
        error: /FICT-R005/,
      },
      {
        name: 'inline object arrow callback slot escaping through unknown boundary',
        source: `
          import { $state } from 'fict'
          function consume(value) {
            return value
          }
          function App() {
            let count = $state(0)
            consume({ read: () => count })
            return <div />
          }
        `,
        error: /FICT-R005/,
      },
      {
        name: 'inline object method callback slot escaping through unknown boundary',
        source: `
          import { $state } from 'fict'
          function consume(value) {
            return value
          }
          function App() {
            let count = $state(0)
            consume({ read() { return count } })
            return <div />
          }
        `,
        error: /FICT-R005/,
      },
      {
        name: 'inline object getter callback slot escaping through unknown boundary',
        source: `
          import { $state } from 'fict'
          function consume(value) {
            return value
          }
          function App() {
            let count = $state(0)
            consume({ get read() { return count } })
            return <div />
          }
        `,
        error: /FICT-R005/,
      },
      {
        name: 'inline array callback slot escaping through unknown boundary',
        source: `
          import { $state } from 'fict'
          function consume(value) {
            return value
          }
          function App() {
            let count = $state(0)
            consume([() => count])
            return <div />
          }
        `,
        error: /FICT-R005/,
      },
      {
        name: 'async promise callback captures reactive value across boundary',
        source: `
          import { $state } from 'fict'
          function App() {
            let count = $state(0)
            Promise.resolve(1).then(() => count)
            return <div>{count}</div>
          }
        `,
        error: /FICT-R002/,
      },
      {
        name: 'optional async promise callback captures reactive value across boundary',
        source: `
          import { $state } from 'fict'
          function App() {
            let count = $state(0)
            Promise.resolve(1)?.then(() => count)
            return <div>{count}</div>
          }
        `,
        error: /FICT-R002/,
      },
      {
        name: 'call-based control-flow fallback diagnostics',
        source: `
          import { $state } from 'fict'
          function App() {
            const count = $state(0)
            if (count > 0 && maybe()) {
              return <div>High</div>
            }
            return <div>Low</div>
          }
        `,
        error: /FICT-R006/,
      },
      {
        name: 'nested $state mutation loses reactivity guarantees',
        source: `
          import { $state } from 'fict'
          function App() {
            let user = $state({ name: 'Ada' })
            user.name = 'Grace'
            return <div>{user.name}</div>
          }
        `,
        error: /FICT-M/,
      },
      {
        name: 'dynamic property access widens tracking guarantees',
        source: `
          import { $state } from 'fict'
          function App({ key = 'name' }) {
            let user = $state({ name: 'Ada' })
            return <div>{user[key]}</div>
          }
        `,
        error: /FICT-H/,
      },
    ]

    for (const testCase of fallbackCases) {
      it(testCase.name, () => {
        expect(() => transform(testCase.source, STRICT_GUARANTEE_OPTIONS)).toThrow(testCase.error)
      })
    }
  })

  describe('Non-strict props spread warnings', () => {
    it('warns FICT-P005 for tagged-template spread sources with signal substitutions', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function tag(strings, value) {
            return { value }
          }
          function Parent() {
            let count = $state(1)
            return <Child {...tag\`\${count}\`} />
          }
          function Child(allProps) {
            return <div>{allProps.value}</div>
          }
        `,
      )
      expect(warningCodes).toContain('FICT-P005')
    })

    it('warns FICT-P005 for template-literal spread sources with signal substitutions', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function Parent() {
            let count = $state(1)
            return <Child {...\`\${count}\`} />
          }
          function Child(allProps) {
            return <div>{allProps[0]}</div>
          }
        `,
      )
      expect(warningCodes).toContain('FICT-P005')
    })

    it('warns FICT-P005 for array-literal spread sources with spread elements', () => {
      const warningCodes = collectWarningCodes(
        `
          function Parent(items) {
            return <Child {...[...items]} />
          }
          function Child(allProps) {
            return <div>{allProps[0]}</div>
          }
        `,
      )
      expect(warningCodes).toContain('FICT-P005')
    })
  })

  describe('Non-strict static loop fallback warnings', () => {
    it('warns FICT-R006 when a loop body builds JSX as a static fallback', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function App() {
            let count = $state(3)
            const nodes = []
            for (let i = 0; i < count; i++) {
              nodes.push(<li>{i}</li>)
            }
            return <ul>{nodes}</ul>
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R006')
    })

    it('does not emit the static-fallback message for loops without JSX', () => {
      const warnings = collectWarnings(
        `
          import { $state } from 'fict'
          function App() {
            let count = $state(3)
            let total = 0
            for (let i = 0; i < count; i++) {
              total += i
            }
            return <p>{total}</p>
          }
        `,
      )
      expect(warnings.some(warning => warning.message.includes('static fallback'))).toBe(false)
    })
  })

  describe('Non-strict callback boundary warnings', () => {
    it('warns FICT-R005 for inline closure escaping unknown callback boundary', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            consume(() => count)
            return <div />
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R005')
    })

    it('warns FICT-R005 for named closure escaping unknown callback boundary', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            const readCount = () => count
            consume(readCount)
            return <div />
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R005')
    })

    it('warns FICT-R005 for hoisted closure escaping before declaration', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            consume(readCount)
            function readCount() {
              return count
            }
            return <div />
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R005')
    })

    it('warns FICT-R005 for returned nested closure escaping unknown boundary', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            consume(() => () => count)
            return <div />
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R005')
    })

    it('warns FICT-R005 for external member callback boundary', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function App() {
            let count = $state(0)
            const bus = { subscribe(fn) { return fn() } }
            bus.subscribe(() => count)
            return <div />
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R005')
    })

    it('warns FICT-R005 for object-property callback aliases', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            const callbacks = { read: () => count }
            const read = callbacks.read
            consume(read)
            return <div />
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R005')
    })

    it('warns FICT-R005 for object shorthand callback slots', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            const read = () => count
            const callbacks = { read }
            consume(callbacks.read)
            return <div />
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R005')
    })

    it('warns FICT-R005 for object slots assigned from captured callbacks', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function consume(fn) {
            return fn()
          }
          function App() {
            let count = $state(0)
            const callbacks = {}
            const readCount = () => count
            callbacks.read = readCount
            consume(callbacks.read)
            return <div />
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R005')
    })

    it('warns FICT-R005 for inline object and array callback slots', () => {
      const cases = [
        `
          import { $state } from 'fict'
          function consume(value) {
            return value
          }
          function App() {
            let count = $state(0)
            consume({ read: () => count })
            return <div />
          }
        `,
        `
          import { $state } from 'fict'
          function consume(value) {
            return value
          }
          function App() {
            let count = $state(0)
            consume({ read() { return count } })
            return <div />
          }
        `,
        `
          import { $state } from 'fict'
          function consume(value) {
            return value
          }
          function App() {
            let count = $state(0)
            consume({ get read() { return count } })
            return <div />
          }
        `,
        `
          import { $state } from 'fict'
          function consume(value) {
            return value
          }
          function App() {
            let count = $state(0)
            consume([() => count])
            return <div />
          }
        `,
      ]

      for (const source of cases) {
        expect(collectWarningCodes(source)).toContain('FICT-R005')
      }
    })

    it('does not warn FICT-R005 for non-escaping iterator callback host', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function App() {
            let count = $state(0)
            const items = [1, 2, 3]
            items.map(item => count + item)
            return <div>{count}</div>
          }
        `,
      )
      expect(warningCodes).not.toContain('FICT-R005')
    })

    it('warns FICT-R005 for promise then callback host', () => {
      const warningCodes = collectWarningCodes(
        `
          import { $state } from 'fict'
          function App() {
            let count = $state(0)
            Promise.resolve(1).then(() => count)
            return <div>{count}</div>
          }
        `,
      )
      expect(warningCodes).toContain('FICT-R005')
    })
  })

  describe('Unsupported (always compile-time error)', () => {
    const unsupportedCases: Array<{ name: string; source: string; error: RegExp }> = [
      {
        name: '$state inside loop',
        source: `
          import { $state } from 'fict'
          function App() {
            for (let i = 0; i < 2; i++) {
              const value = $state(i)
            }
            return <div />
          }
        `,
        error: /cannot be declared inside loops/,
      },
      {
        name: '$effect inside loop',
        source: `
          import { $effect } from 'fict'
          function App() {
            while (false) {
              $effect(() => {})
            }
            return <div />
          }
        `,
        error: /cannot be called inside loops/,
      },
      {
        name: '$state inside nested function',
        source: `
          import { $state } from 'fict'
          function App() {
            const read = () => {
              const value = $state(0)
              return value
            }
            return <div>{read()}</div>
          }
        `,
        error:
          /component or hook function body|no nested functions|cannot be declared inside nested functions/,
      },
    ]

    for (const testCase of unsupportedCases) {
      it(testCase.name, () => {
        expect(() => transform(testCase.source, STRICT_GUARANTEE_OPTIONS)).toThrow(testCase.error)
      })
    }
  })

  describe('diagnostic and lowering conformance', () => {
    const makeRegion = (overrides: Partial<Region>): Region => ({
      id: 0,
      scopeId: 0,
      blocks: new Set(),
      instructions: [],
      dependencies: new Set(),
      declarations: new Set(),
      hasControlFlow: true,
      hasJSX: false,
      hasAsyncSyntax: false,
      shouldMemoize: true,
      children: [],
      ...overrides,
    })

    it('shares one memoization predicate between diagnostics and lowering', () => {
      expect(isRegionMemoizable(makeRegion({}))).toBe(true)
      expect(isRegionMemoizable(makeRegion({ shouldMemoize: false }))).toBe(false)
      expect(isRegionMemoizable(makeRegion({ hasAsyncSyntax: true }))).toBe(false)
    })

    it('memoized story blocks emit a region memo without FICT-R006', () => {
      const source = `
        import { $state } from 'fict'
        function App() {
          let count = $state(0)
          let heading = 'empty'
          if (count > 0) {
            heading = count + ' items'
          }
          return <h1>{heading}</h1>
        }
      `
      const warnings: Array<{ code: string }> = []
      const output = transform(source, {
        ...STRICT_GUARANTEE_OPTIONS,
        onWarn: warning => warnings.push(warning as { code: string }),
      })
      expect(warnings.map(warning => warning.code)).not.toContain('FICT-R006')
      expect(output).toContain('__region_')
    })

    it('strictGuarantee rejects story blocks whose region memo is disabled during lowering', () => {
      const source = `
        import { $state } from 'fict'
        const external = {
          fmt() {
            return 'count:'
          },
        }
        function App() {
          let count = $state(0)
          let heading = 'empty'
          if (count > 0) {
            heading = external.fmt() + count
          }
          return <h1>{heading}</h1>
        }
      `

      expect(() => transform(source, STRICT_GUARANTEE_OPTIONS)).toThrow(/FICT-R006/)
    })

    it('strictGuarantee rejects try/catch story blocks that rethrow', () => {
      const source = `
        import { $state } from 'fict'
        function App() {
          let n = $state(0)
          let msg = 'init'
          try {
            if (n > 0) throw new Error('boom')
            msg = 'ok:' + n
          } catch (e) {
            throw e
          }
          return <span>{msg}</span>
        }
      `

      expect(() => transform(source, STRICT_GUARANTEE_OPTIONS)).toThrow(/FICT-R006/)
    })
  })
})
