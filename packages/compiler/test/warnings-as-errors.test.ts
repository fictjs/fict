import { describe, expect, it } from 'vitest'

import { transform, transformWithCompilerDefaults } from './test-utils'

describe('warnings as errors', () => {
  const source = `
    import { $state } from 'fict'
    function App() {
      const state = $state({ count: 0 })
      state.count = 1
      return state.count
    }
  `
  const memoSideEffectSource = `
    import { $memo } from 'fict'
    const value = $memo(() => {
      console.log('side')
      return 1
    })
  `

  it('throws when warnings are escalated to errors (dev)', () => {
    expect(() => transform(source, { warningsAsErrors: true })).toThrow(
      /Fict warning treated as error/,
    )
  })

  it('surfaces escalated warnings as SyntaxError', () => {
    try {
      transform(source, { warningsAsErrors: true })
      throw new Error('expected transform to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/Fict warning treated as error/)
    }
  })

  it('throws when warnings are escalated to errors (prod)', () => {
    expect(() => transform(source, { dev: false, warningsAsErrors: ['FICT-M'] })).toThrow(
      /Fict warning treated as error/,
    )
  })

  it('warningsAsErrors family entries escalate memo subcodes', () => {
    expect(() =>
      transform(memoSideEffectSource, {
        strictGuarantee: false,
        dev: false,
        warningsAsErrors: ['FICT-M'],
      }),
    ).toThrow(/FICT-M003/)
  })

  it('allows warning suppression via warningLevels', () => {
    expect(() =>
      transform(source, {
        warningsAsErrors: true,
        warningLevels: { 'FICT-M': 'off' },
      }),
    ).not.toThrow()
  })

  it('warningLevels family entries can suppress memo subcodes outside strictGuarantee', () => {
    expect(() =>
      transform(memoSideEffectSource, {
        strictGuarantee: false,
        dev: false,
        warningsAsErrors: true,
        warningLevels: { 'FICT-M': 'off' },
      }),
    ).not.toThrow()
  })

  it('treats FICT-R004 as error by default (including prod)', () => {
    const r004Source = `
      import { $state, createEffect } from 'fict'
      function App() {
        const state = $state(0)
        if (state > 0) {
          createEffect(() => console.log(state))
        }
        return <div>{state}</div>
      }
    `

    expect(() => transform(r004Source)).toThrow(/FICT-R004/)
    expect(() => transform(r004Source, { dev: false })).toThrow(/FICT-R004/)
  })

  it('allows explicitly downgrading FICT-R004', () => {
    const r004Source = `
      import { $state, createEffect } from 'fict'
      function App() {
        const state = $state(0)
        if (state > 0) {
          createEffect(() => console.log(state))
        }
        return <div>{state}</div>
      }
    `

    expect(() =>
      transform(r004Source, {
        dev: false,
        strictGuarantee: false,
        warningLevels: { 'FICT-R004': 'warn' },
      }),
    ).not.toThrow()
  })

  it('strictReactivity escalates FICT-R006 to error', () => {
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
    expect(() => transform(source, { strictReactivity: true, dev: false })).toThrow(/FICT-R006/)
  })

  it('strictReactivity escalates optional-call FICT-R006 to error', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const count = $state(0)
        if (maybe?.(count)) {
          return <div>High</div>
        }
        return <div>Low</div>
      }
    `
    expect(() => transform(source, { strictReactivity: true, dev: false })).toThrow(/FICT-R006/)
  })

  it('strictReactivity escalates FICT-R003 to error', () => {
    const source = `
      function App({ mode }) {
        if (mode) {
          if (mode > 1) {
            return <span>{mode}</span>
          }
        }
        return <div>{mode}</div>
      }
    `
    expect(() =>
      transform(source, {
        strictReactivity: true,
        strictGuarantee: false,
        dev: false,
        warningLevels: { 'FICT-R006': 'warn' },
      }),
    ).toThrow(/FICT-R003/)
  })

  it('warningLevels can override strictReactivity escalation', () => {
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
    expect(() =>
      transform(source, {
        strictReactivity: true,
        strictGuarantee: false,
        dev: false,
        warningLevels: { 'FICT-R006': 'warn' },
      }),
    ).not.toThrow()
  })

  it('strictGuarantee escalates props fallback diagnostics', () => {
    const source = `
      function App({ list: [first, ...rest] }) {
        return <div>{first}</div>
      }
    `
    expect(() => transform(source, { strictGuarantee: true, dev: false })).toThrow(/FICT-P00[1-5]/)
  })

  it('strictGuarantee is enabled by default and escalates native element spread diagnostics', () => {
    const source = `
      function App() {
        const props = { id: 'demo', title: 'Demo' }
        return <div {...props}>Hello</div>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).toThrow(/FICT-J003/)
  })

  it('strictGuarantee escalates legacy non-guaranteed reactivity diagnostics', () => {
    const mutationSource = `
      import { $state } from 'fict'
      function App() {
        let state = $state({ count: 0 })
        state.count = 1
        return <div>{state.count}</div>
      }
    `
    const dynamicAccessSource = `
      import { $state } from 'fict'
      function App({ key = 'count' }) {
        let state = $state({ count: 0 })
        return <div>{state[key]}</div>
      }
    `

    expect(() => transform(mutationSource, { strictGuarantee: true, dev: false })).toThrow(/FICT-M/)
    expect(() => transform(dynamicAccessSource, { strictGuarantee: true, dev: false })).toThrow(
      /FICT-H/,
    )
  })

  it('strictGuarantee escalates memo side-effect subcodes', () => {
    expect(() => transform(memoSideEffectSource, { strictGuarantee: true, dev: false })).toThrow(
      /FICT-M003/,
    )
  })

  it('strictGuarantee is enabled by default and escalates legacy non-guaranteed reactivity diagnostics', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let state = $state({ count: 0 })
        state.count = 1
        return <div>{state.count}</div>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).toThrow(/FICT-M/)
  })

  it('strictGuarantee is enabled by default and escalates JSX child reactive writes', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        return <div>{count++}</div>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).toThrow(/FICT-R007/)
  })

  it('strictGuarantee is enabled by default and escalates props fallback diagnostics', () => {
    const source = `
      function App({ list: [first, ...rest] }) {
        return <div>{first}</div>
      }
    `
    expect(() => transformWithCompilerDefaults(source, { dev: false })).toThrow(/FICT-P00[1-5]/)
  })

  it('strictGuarantee can be explicitly disabled', () => {
    const source = `
      function App({ list: [first, ...rest] }) {
        return <div>{first}</div>
      }
    `
    expect(() => transform(source, { strictGuarantee: false, dev: false })).not.toThrow()
  })

  it('strictGuarantee allows known callback-host APIs from fict imports', () => {
    const source = `
      import { $state, createEffect, batch, untrack, startTransition } from 'fict'
      function App() {
        let count = $state(0)
        createEffect(() => {
          if (untrack(() => count >= 0)) {
            batch(() => {
              count = count + 1
            })
            startTransition(() => {
              count = count - 1
            })
          }
        })
        return <div>{count}</div>
      }
    `
    expect(() => transformWithCompilerDefaults(source, { dev: false })).not.toThrow()
  })

  it('strictGuarantee disallows fict-ignore suppression comments', () => {
    const source = `
      // fict-ignore-next-line FICT-R006
      import { $state } from 'fict'
      function App() {
        const count = $state(0)
        if (count > 0) {
          return <div>High</div>
        }
        return <div>Low</div>
      }
    `
    expect(() => transform(source, { strictGuarantee: true, dev: false })).toThrow(
      /strictGuarantee does not allow fict-ignore/,
    )
  })

  it('strictGuarantee suppression failures surface as SyntaxError', () => {
    const source = `
      // fict-ignore-next-line FICT-R006
      import { $state } from 'fict'
      function App() {
        const count = $state(0)
        if (count > 0) return <div>High</div>
        return <div>Low</div>
      }
    `

    try {
      transform(source, { strictGuarantee: true, dev: false })
      throw new Error('expected transform to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError)
      expect((error as Error).message).toMatch(/strictGuarantee does not allow fict-ignore/)
    }
  })

  it('strictGuarantee disallows warningLevels downgrades for guarantee codes', () => {
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
    expect(() =>
      transform(source, {
        strictGuarantee: true,
        dev: false,
        warningLevels: { 'FICT-R006': 'warn' },
      }),
    ).toThrow(/strictGuarantee does not allow downgrading FICT-R006/)
  })

  it('strictGuarantee disallows warningLevels downgrades for callback escape diagnostics', () => {
    const source = `
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
    `
    expect(() =>
      transform(source, {
        strictGuarantee: true,
        dev: false,
        warningLevels: { 'FICT-R005': 'warn' },
      }),
    ).toThrow(/strictGuarantee does not allow downgrading FICT-R005/)
  })

  it('strictGuarantee disallows warningLevels downgrades for legacy guarantee codes', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let state = $state({ count: 0 })
        state.count = 1
        return <div>{state.count}</div>
      }
    `

    expect(() =>
      transform(source, {
        strictGuarantee: true,
        dev: false,
        warningLevels: { 'FICT-M': 'warn' },
      }),
    ).toThrow(/strictGuarantee does not allow downgrading FICT-M/)
  })

  it('strictGuarantee disallows warningLevels downgrades for memo subcodes', () => {
    expect(() =>
      transform(memoSideEffectSource, {
        strictGuarantee: true,
        dev: false,
        warningLevels: { 'FICT-M003': 'warn' },
      }),
    ).toThrow(/strictGuarantee does not allow downgrading FICT-M003/)
  })

  it('strictGuarantee warning-level downgrade failures surface as SyntaxError', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const count = $state(0)
        if (count > 0) return <div>High</div>
        return <div>Low</div>
      }
    `

    try {
      transform(source, {
        strictGuarantee: true,
        strictReactivity: true,
        dev: false,
        warningLevels: { 'FICT-R006': 'warn' },
      })
      throw new Error('expected transform to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError)
      expect((error as Error).message).toMatch(
        /strictGuarantee does not allow downgrading FICT-R006/,
      )
    }
  })

  it('FICT_STRICT_GUARANTEE env enforces strictGuarantee even when options set false', () => {
    const source = `
      function App({ list: [first, ...rest] }) {
        return <div>{first}</div>
      }
    `
    const previous = process.env.FICT_STRICT_GUARANTEE
    process.env.FICT_STRICT_GUARANTEE = '1'
    try {
      expect(() => transform(source, { strictGuarantee: false, dev: false })).toThrow(
        /FICT-P00[1-5]/,
      )
    } finally {
      if (previous === undefined) {
        delete process.env.FICT_STRICT_GUARANTEE
      } else {
        process.env.FICT_STRICT_GUARANTEE = previous
      }
    }
  })
})
