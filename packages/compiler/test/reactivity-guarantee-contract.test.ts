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
    ]

    for (const testCase of fallbackCases) {
      it(testCase.name, () => {
        expect(() => transform(testCase.source, STRICT_GUARANTEE_OPTIONS)).toThrow(testCase.error)
      })
    }
  })

  describe('Warning-only boundary signals', () => {
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

    it('does not warn FICT-R005 for promise then callback host', () => {
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
      expect(warningCodes).not.toContain('FICT-R005')
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
