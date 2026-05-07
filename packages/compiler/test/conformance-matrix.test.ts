import { describe, expect, it } from 'vitest'

import type { FictCompilerOptions } from '../src'

import { transform, transformWithCompilerDefaults } from './test-utils'

type GuaranteeLevel = 'guaranteed' | 'fallback' | 'unsupported'

interface ConformanceCase {
  id: string
  axis: string
  level: GuaranteeLevel
  source: string
  options?: FictCompilerOptions
  expectedError?: RegExp
  nonStrictWarningCode?: string
  assertOutput?: (output: string) => void
}

function collectWarnings(source: string, options: FictCompilerOptions = {}): string[] {
  const warnings: string[] = []
  transform(source, {
    ...options,
    strictGuarantee: false,
    dev: true,
    onWarn: warning => {
      warnings.push(warning.code)
    },
  })
  return warnings
}

const cases: ConformanceCase[] = [
  {
    id: 'guaranteed-state-alias-jsx-handler',
    axis: 'alias + closure + JSX handler',
    level: 'guaranteed',
    source: `
      import { $state } from 'fict'

      export function Counter({ label }) {
        let count = $state(0)
        const next = count + 1
        const alias = next
        const increment = () => {
          count++
        }
        return <button onClick={increment}>{label}: {alias}</button>
      }
    `,
    assertOutput: output => {
      expect(output).toContain('__fictUseSignal')
      expect(output).toContain('insertBetween')
    },
  },
  {
    id: 'guaranteed-non-escaping-iterator-callback',
    axis: 'callback host + loop-like iterator',
    level: 'guaranteed',
    source: `
      import { $state } from 'fict'

      export function List() {
        let count = $state(0)
        const items = [1, 2, 3]
        return <ul>{items.map(item => <li key={item}>{count + item}</li>)}</ul>
      }
    `,
    assertOutput: output => {
      expect(output).toContain('createKeyedList')
      expect(output).toMatch(/count\(\)/)
    },
  },
  {
    id: 'guaranteed-cross-module-hook-metadata',
    axis: 'module boundary + package metadata',
    level: 'guaranteed',
    source: `
      import { useCounter } from 'counter-lib'

      export function App() {
        const count = useCounter()
        return <div>{count}</div>
      }
    `,
    options: {
      resolveModuleMetadata: source =>
        source === 'counter-lib'
          ? {
              version: 1,
              exports: {},
              hooks: {
                useCounter: { directAccessor: 'signal' },
              },
            }
          : undefined,
    },
    assertOutput: output => {
      expect(output).toMatch(/count\(\)/)
    },
  },
  {
    id: 'guaranteed-nested-destructuring-default-rest',
    axis: 'destructuring + default + rest props',
    level: 'guaranteed',
    source: `
      export function Profile(props) {
        const {
          user: { name = 'Ada' } = {},
          title = 'Engineer',
          ...rest
        } = props
        return <section data-role={rest.role}>{title}: {name}</section>
      }
    `,
    assertOutput: output => {
      expect(output).toContain('__fictPropsRest')
      expect(output).toContain('__fictProp')
    },
  },
  {
    id: 'guaranteed-keyed-list-conditional-child',
    axis: 'keyed list + conditional child',
    level: 'guaranteed',
    source: `
      import { $state } from 'fict'

      export function Menu() {
        let selected = $state(1)
        const items = [1, 2, 3]
        return (
          <ul>
            {items.map(item => (
              <li key={item}>{item === selected ? <span>{selected}</span> : null}</li>
            ))}
          </ul>
        )
      }
    `,
    assertOutput: output => {
      expect(output).toContain('createKeyedList')
      expect(output).toContain('createConditional')
    },
  },
  {
    id: 'fallback-nested-switch-state-read',
    axis: 'nested switch + state read',
    level: 'fallback',
    source: `
      import { $state } from 'fict'

      export function Status() {
        let status = $state('idle')
        let label = 'Unknown'
        switch (status) {
          case 'idle':
            switch (status) {
              case 'idle':
                label = 'Idle'
                break
            }
            break
          default:
            label = 'Other'
        }
        return <div>{label}: {status}</div>
      }
    `,
    expectedError: /FICT-R006/,
    nonStrictWarningCode: 'FICT-R006',
  },
  {
    id: 'guaranteed-try-finally-state-update',
    axis: 'try/finally + state update',
    level: 'guaranteed',
    source: `
      import { $state } from 'fict'

      export function App() {
        let count = $state(0)
        try {
          count++
        } finally {
          count++
        }
        return <div>{count}</div>
      }
    `,
    assertOutput: output => {
      expect(output).toContain('__fictUseSignal')
      expect(output).toMatch(/count\(\)/)
    },
  },
  {
    id: 'fallback-unknown-callback-host',
    axis: 'function escape + callback host',
    level: 'fallback',
    source: `
      import { $state } from 'fict'

      function schedule(fn) {
        return fn
      }

      export function App() {
        let count = $state(0)
        schedule(() => count + 1)
        return <div>{count}</div>
      }
    `,
    expectedError: /FICT-R002|FICT-R005/,
    nonStrictWarningCode: 'FICT-R005',
  },
  {
    id: 'fallback-async-boundary',
    axis: 'async boundary + closure',
    level: 'fallback',
    source: `
      import { $state } from 'fict'

      export function App() {
        let count = $state(0)
        Promise.resolve().then(() => count)
        return <div>{count}</div>
      }
    `,
    expectedError: /FICT-R002/,
    nonStrictWarningCode: 'FICT-R005',
  },
  {
    id: 'fallback-dynamic-object-shape',
    axis: 'dynamic object shape + dynamic property',
    level: 'fallback',
    source: `
      import { $state } from 'fict'

      export function App({ field = 'name' }) {
        let user = $state({ name: 'Ada', city: 'London' })
        return <div>{user[field]}</div>
      }
    `,
    expectedError: /FICT-H/,
    nonStrictWarningCode: 'FICT-H',
  },
  {
    id: 'fallback-dynamic-props-spread',
    axis: 'rest/spread + component boundary',
    level: 'fallback',
    source: `
      export function Parent(props) {
        return <Child {...props()} fixed="yes" />
      }

      function Child(allProps) {
        return <div>{allProps.fixed}</div>
      }
    `,
    expectedError: /FICT-P005/,
    nonStrictWarningCode: 'FICT-P005',
  },
  {
    id: 'fallback-event-handler-escape',
    axis: 'event handler escape + browser API',
    level: 'fallback',
    source: `
      import { $state } from 'fict'

      export function App() {
        let count = $state(0)
        const increment = () => {
          count++
        }
        window.addEventListener('click', increment)
        return <button>{count}</button>
      }
    `,
    expectedError: /FICT-R002|FICT-R005/,
    nonStrictWarningCode: 'FICT-R005',
  },
  {
    id: 'fallback-loop-carried-state',
    axis: 'loop-carried state',
    level: 'fallback',
    source: `
      import { $state } from 'fict'

      export function App({ items }) {
        let total = $state(0)
        for (const item of items) {
          total += item.value
        }
        return <div>{total}</div>
      }
    `,
    expectedError: /FICT-R006/,
    nonStrictWarningCode: 'FICT-R006',
  },
  {
    id: 'unsupported-state-inside-nested-function',
    axis: 'nested control flow + nested function',
    level: 'unsupported',
    source: `
      import { $state } from 'fict'

      export function App() {
        const read = () => {
          const count = $state(0)
          return count
        }
        return <div>{read()}</div>
      }
    `,
    expectedError:
      /component or hook function body|no nested functions|cannot be declared inside nested functions/,
  },
  {
    id: 'unsupported-effect-inside-loop',
    axis: 'loop + reactive lifecycle',
    level: 'unsupported',
    source: `
      import { $effect } from 'fict'

      export function App() {
        while (false) {
          $effect(() => {})
        }
        return <div />
      }
    `,
    expectedError: /cannot be called inside loops/,
  },
  {
    id: 'unsupported-module-level-state',
    axis: 'module boundary + state lifetime',
    level: 'unsupported',
    source: `
      import { $state } from 'fict'

      export const count = $state(0)
    `,
    expectedError: /must be declared inside a component or hook function body/,
  },
]

describe('compiler reactivity conformance matrix', () => {
  describe('guaranteed surface', () => {
    for (const testCase of cases.filter(item => item.level === 'guaranteed')) {
      it(`${testCase.id} (${testCase.axis})`, () => {
        const output = transformWithCompilerDefaults(testCase.source, testCase.options)
        testCase.assertOutput?.(output)
      })
    }
  })

  describe('fallback surface', () => {
    for (const testCase of cases.filter(item => item.level === 'fallback')) {
      it(`${testCase.id} defaults to fail-closed (${testCase.axis})`, () => {
        expect(() => transformWithCompilerDefaults(testCase.source, testCase.options)).toThrow(
          testCase.expectedError,
        )
      })

      it(`${testCase.id} remains diagnosable in non-strict mode`, () => {
        const warnings = collectWarnings(testCase.source, testCase.options)
        expect(warnings).toContain(testCase.nonStrictWarningCode)
      })
    }
  })

  describe('unsupported surface', () => {
    for (const testCase of cases.filter(item => item.level === 'unsupported')) {
      it(`${testCase.id} is always rejected (${testCase.axis})`, () => {
        expect(() =>
          transform(testCase.source, { ...testCase.options, strictGuarantee: false }),
        ).toThrow(testCase.expectedError)
      })
    }
  })
})
