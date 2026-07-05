import { describe, expect, it } from 'vitest'

import type { FictCompilerOptions } from '../src'

import { transform, transformWithCompilerDefaults } from './test-utils'

interface StrictDefaultSmokeCase {
  name: string
  source: string
  options?: FictCompilerOptions
  expectedError?: RegExp
  assertOutput?: (output: string) => void
}

const strictDefaultSmokeCases: StrictDefaultSmokeCase[] = [
  {
    name: 'simple state derived jsx binding',
    source: `
      import { $state } from 'fict'

      export function Counter() {
        let count = $state(0)
        const doubled = count * 2
        return <button onClick={() => count++}>{count}:{doubled}</button>
      }
    `,
    assertOutput: output => {
      expect(output).toContain('__fictUseSignal')
      expect(output).toMatch(/count\(\)/)
    },
  },
  {
    name: 'props destructuring with nested defaults and rest',
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
      expect(output).toContain('__fictProp')
      expect(output).toContain('__fictPropsRest')
    },
  },
  {
    name: 'keyed list map',
    source: `
      import { $state } from 'fict'

      export function Menu() {
        let selected = $state(1)
        const items = [1, 2, 3]
        return <ul>{items.map(item => <li key={item}>{item === selected ? selected : item}</li>)}</ul>
      }
    `,
    assertOutput: output => {
      expect(output).toContain('createKeyedList')
      expect(output).toMatch(/selected\(\)/)
    },
  },
  {
    name: 'hook object and array accessor returns',
    source: `
      import { $state } from 'fict'

      export function useCounter() {
        let count = $state(0)
        const doubled = count * 2
        return { count, doubled, tuple: [count, doubled] }
      }
    `,
    assertOutput: output => {
      expect(output).toContain('__fictUseSignal')
      expect(output).toContain('tuple')
    },
  },
  {
    name: 'cross-module direct accessor metadata',
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
    name: 'resumable event handler',
    source: `
      import { $state } from 'fict'

      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `,
    options: { resumable: true },
    assertOutput: output => {
      expect(output).toContain('__handler')
    },
  },
  {
    name: 'native spread fallback fail closed',
    source: `
      export function App(props) {
        const attrs = { ...props }
        return <div {...attrs} />
      }
    `,
    expectedError: /FICT-J003/,
  },
]

describe('compiler default options', () => {
  describe('strict default smoke matrix', () => {
    for (const testCase of strictDefaultSmokeCases) {
      it(testCase.name, () => {
        if (testCase.expectedError) {
          expect(() =>
            transformWithCompilerDefaults(testCase.source, {
              ...testCase.options,
              dev: false,
            }),
          ).toThrow(testCase.expectedError)
          return
        }

        const output = transformWithCompilerDefaults(testCase.source, {
          ...testCase.options,
          dev: false,
        })
        testCase.assertOutput?.(output)
      })
    }
  })

  it('enables lazyConditional by default', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        if (count > 0) {
          return <div>{count}</div>
        }
        return <span>{count}</span>
      }
    `

    const withCompilerDefaults = transformWithCompilerDefaults(source, { strictGuarantee: false })
    const withLazyConditionalDisabled = transform(source, {
      strictGuarantee: false,
      lazyConditional: false,
    })

    expect(withCompilerDefaults).toContain('createConditional')
    expect(withLazyConditionalDisabled).not.toContain('createConditional')
  })

  it('does not cache returned closure reads by default', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        let count = $state(0)
        const click = () => {
          console.log(count)
          console.log(count)
          console.log(count)
        }
        return click
      }
    `

    const output = transformWithCompilerDefaults(source, { strictGuarantee: false })
    expect(output).not.toMatch(/__cached_count_\d+/)
    expect(output).toMatch(/console\.log\(count\(\)\)/)
  })

  it('enables strictGuarantee by default', () => {
    const source = `
      function App({ list: [first, ...rest] }) {
        return <div>{first}</div>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).toThrow(/FICT-P00[1-5]/)
  })

  it('allows guaranteed branch-return control flow under default strictGuarantee', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const count = $state(0)
        if (count > 0) {
          return <div>High</div>
        }
        return <div>Low</div>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).not.toThrow()
  })

  it('allows guaranteed story-block control flow under default strictGuarantee', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        let heading = 'empty'
        if (count > 0) {
          const noun = count > 1 ? 'items' : 'item'
          heading = count + ' ' + noun
        }
        return <h1>{heading}</h1>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).not.toThrow()
  })

  it('keeps call-based control-flow fallbacks blocked by default strictGuarantee', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const count = $state(0)
        if (count > 0 && maybe()) {
          return <div>High</div>
        }
        return <div>Low</div>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).toThrow(/FICT-R006/)
  })

  it('forces strictGuarantee on in production even when an integration opts out', () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const source = `
      import { $state } from 'fict'
      function sink(value) {
        return value
      }
      function App() {
        let count = $state(0)
        sink(count)
        return <div />
      }
    `

    try {
      expect(() =>
        transformWithCompilerDefaults(source, {
          strictGuarantee: false,
          dev: false,
        }),
      ).toThrow(/FICT-S002/)
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
    }
  })
})
