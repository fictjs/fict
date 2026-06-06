import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

const STRICT_GUARANTEE_OPTIONS = { strictGuarantee: true, dev: false } as const

function collectWarningCodes(
  source: string,
  options: Parameters<typeof transform>[1] = {},
): string[] {
  const previousStrictGuaranteeEnv = process.env.FICT_STRICT_GUARANTEE
  delete process.env.FICT_STRICT_GUARANTEE
  const warnings: Array<{ code: string }> = []
  try {
    transform(source, {
      strictGuarantee: false,
      ...options,
      onWarn: warning => warnings.push(warning as { code: string }),
    })
    return warnings.map(warning => warning.code)
  } finally {
    if (previousStrictGuaranteeEnv === undefined) {
      delete process.env.FICT_STRICT_GUARANTEE
    } else {
      process.env.FICT_STRICT_GUARANTEE = previousStrictGuaranteeEnv
    }
  }
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
        name: 'control-flow fallback diagnostics',
        source: `
          import { $state } from 'fict'
          function App() {
            const count = $state(0)
            if (count > 0) {
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
})
