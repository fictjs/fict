import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

const STRICT_GUARANTEE_OPTIONS = { strictGuarantee: true, dev: false } as const

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
        name: 'props destructuring fallback',
        source: `
          function App({ list: [first, ...rest] }) {
            return <div>{first}</div>
          }
        `,
        error: /FICT-P00[1-5]/,
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
