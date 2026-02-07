import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('warnings as errors', () => {
  const source = `
    import { $state } from 'fict'
    function App() {
      const state = $state({ count: 0 })
      state.count = 1
      return state.count
    }
  `

  it('throws when warnings are escalated to errors (dev)', () => {
    expect(() => transform(source, { warningsAsErrors: true })).toThrow(
      /Fict warning treated as error/,
    )
  })

  it('throws when warnings are escalated to errors (prod)', () => {
    expect(() => transform(source, { dev: false, warningsAsErrors: ['FICT-M'] })).toThrow(
      /Fict warning treated as error/,
    )
  })

  it('allows warning suppression via warningLevels', () => {
    expect(() =>
      transform(source, {
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

  it('strictReactivity escalates FICT-R003 to error', () => {
    const source = `
      function App({ mode }) {
        if (mode) {
          while (true) {
            break
          }
        }
        return <div>{mode}</div>
      }
    `
    expect(() =>
      transform(source, {
        strictReactivity: true,
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
