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
  const memoNoDepsSource = `
    import { $memo } from 'fict'
    const value = $memo(() => 1)
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
        if (count > 0 && maybe()) {
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

  it('strictGuarantee does not escalate memo no-dependency hints', () => {
    expect(() => transform(memoNoDepsSource, { strictGuarantee: true, dev: false })).not.toThrow()
  })

  it('reports FICT-H002 for inconsistent hook return accessor shape (order-independent)', () => {
    const staticFirst = `
      import { $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        if (flag) return { count: 'static' }
        return { count }
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t.count}</div>
      }
    `
    const accessorFirst = `
      import { $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        if (flag) return { count }
        return { count: 'static' }
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t.count}</div>
      }
    `
    const copiedAccessor = `
      import { $state } from 'fict'
      function useBase() {
        let count = $state(0)
        return { count }
      }
      function useThing(flag) {
        if (flag) return { count: 'static' }
        return useBase()
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t.count}</div>
      }
    `
    const copiedAccessorAlias = `
      import { $state } from 'fict'
      function useBase() {
        let count = $state(0)
        return { count }
      }
      function usePlain() {
        return { count: 'static' }
      }
      function useThing(flag) {
        const plain = usePlain()
        const live = useBase()
        return flag ? plain : live
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t.count}</div>
      }
    `
    const conditionalObject = `
      import { $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        return flag ? { count } : { count: 'static' }
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t.count}</div>
      }
    `
    const conditionalArray = `
      import { $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        return flag ? [count] : ['static']
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t[0]}</div>
      }
    `
    const conditionalDirect = `
      import { $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        return flag ? count : 'static'
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t}</div>
      }
    `
    const logicalAndDirect = `
      import { $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        return flag && count
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t}</div>
      }
    `
    const logicalOrDirect = `
      import { $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        return flag || count
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t}</div>
      }
    `
    const incompatibleAccessorKinds = `
      import { $memo, $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        const doubled = $memo(() => count() * 2)
        return flag ? { value: count } : { value: doubled }
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t.value}</div>
      }
    `
    const incompatibleDirectAccessorKinds = `
      import { $memo, $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        const doubled = $memo(() => count() * 2)
        return flag ? count : doubled
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t}</div>
      }
    `
    const collect = (src: string): string[] => {
      const codes: string[] = []
      transform(src, { strictGuarantee: false, dev: false, onWarn: w => codes.push(w.code) })
      return codes
    }
    // Both return orderings must surface the same conflict diagnostic.
    expect(collect(staticFirst)).toContain('FICT-H002')
    expect(collect(accessorFirst)).toContain('FICT-H002')
    expect(collect(copiedAccessor)).toContain('FICT-H002')
    expect(collect(copiedAccessorAlias)).toContain('FICT-H002')
    expect(collect(conditionalObject)).toContain('FICT-H002')
    expect(collect(conditionalArray)).toContain('FICT-H002')
    expect(collect(conditionalDirect)).toContain('FICT-H002')
    expect(collect(logicalAndDirect)).toContain('FICT-H002')
    expect(collect(logicalOrDirect)).toContain('FICT-H002')
    expect(collect(incompatibleAccessorKinds)).toContain('FICT-H002')
    expect(collect(incompatibleDirectAccessorKinds)).toContain('FICT-H002')
  })

  it('does not report FICT-H002 for consistent hook return shapes', () => {
    const collect = (src: string): string[] => {
      const codes: string[] = []
      transform(src, { strictGuarantee: false, dev: false, onWarn: w => codes.push(w.code) })
      return codes
    }
    // Consistently plain, and a duplicate key within one object (last-wins),
    // are both valid shapes.
    expect(
      collect(`
        import { $state } from 'fict'
        function useThing(flag) {
          let count = $state(0)
          if (flag) return { count: count() }
          return { count: 'static' }
        }
        export function C({ flag }) {
          const t = useThing(flag)
          return <div>{t.count}</div>
        }
      `),
    ).not.toContain('FICT-H002')
    expect(
      collect(`
        import { $state } from 'fict'
        function useObj() {
          let count = $state(1)
          return { count: 9, count }
        }
        export function C() {
          const o = useObj()
          return <div>{o.count}</div>
        }
      `),
    ).not.toContain('FICT-H002')
  })

  it('escalates FICT-H002 to an error under strictGuarantee', () => {
    const source = `
      import { $state } from 'fict'
      function useThing(flag) {
        let count = $state(0)
        if (flag) return { count }
        return { count: 'static' }
      }
      export function C({ flag }) {
        const t = useThing(flag)
        return <div>{t.count}</div>
      }
    `
    // The inconsistent shape must fail closed under strictGuarantee.
    expect(() => transform(source, { strictGuarantee: true, dev: false })).toThrow()
  })

  it('delivers warn-level diagnostics to onWarn in non-dev opt-out builds', () => {
    const listSource = `
      import { $state } from 'fict'
      export function List() {
        let items = $state([1, 2, 3])
        return <ul>{items.map(item => <li>{item}</li>)}</ul>
      }
    `
    const warnings: string[] = []
    transform(listSource, {
      dev: false,
      strictGuarantee: false,
      onWarn: warning => warnings.push(warning.code),
    })
    // The missing-key warning must still reach onWarn even though dev is off.
    expect(warnings).toContain('FICT-J002')
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

  it('strictGuarantee rejects callbacks on reassigned reactive array receivers', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        let count = $state(0)
        let rows = $state([1])
        rows = { map(cb) { globalThis.saved = cb; return [] } }
        rows.map(() => count)
        return <div>{count}</div>
      }
    `

    expect(() => transformWithCompilerDefaults(source, { dev: false })).toThrow(/FICT-R002/)
  })

  it('strictGuarantee allows callbacks on aliased $store array receivers', () => {
    const source = `
      import { $state, $store as store } from 'fict'
      function App() {
        let selected = $state(0)
        const rows = store([{ id: 1 }])
        return <ul>{rows.map(row => <li class={selected === row.id ? 'sel' : ''}>{row.id}</li>)}</ul>
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
