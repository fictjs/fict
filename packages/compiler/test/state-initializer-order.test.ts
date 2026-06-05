import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

function expectBefore(output: string, before: string, after: string): void {
  const beforeIndex = output.indexOf(before)
  const afterIndex = output.indexOf(after)

  expect(beforeIndex, `${before} should be present`).toBeGreaterThanOrEqual(0)
  expect(afterIndex, `${after} should be present`).toBeGreaterThanOrEqual(0)
  expect(beforeIndex, `${before} should be emitted before ${after}`).toBeLessThan(afterIndex)
}

describe('$state initializer ordering', () => {
  it('keeps object literal locals before dependent $state declarations', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const init = { a: 1 }
        const s = $state(init)
        return <div>{s.a}</div>
      }
    `)

    expectBefore(output, 'const init = {', 'const s = __fictUseSignal(__fictCtx, init')
  })

  it('keeps function-call locals before dependent $state declarations', () => {
    const output = transform(`
      import { $state } from 'fict'

      function make() {
        return { a: 1 }
      }

      export function App() {
        const init = make()
        const s = $state(init)
        return <div>{s.a}</div>
      }
    `)

    expectBefore(output, 'const init = make();', 'const s = __fictUseSignal(__fictCtx, init')
  })

  it('keeps createRef locals before dependent $state declarations', () => {
    const output = transform(`
      import { $state, createRef } from 'fict'

      export function App() {
        const r1 = createRef()
        const live = $state(r1)
        return <input ref={live} />
      }
    `)

    expectBefore(output, 'const r1 = createRef();', 'const live = __fictUseSignal(__fictCtx, r1')
  })

  it('keeps multiple prior locals before dependent $state declarations', () => {
    const output = transform(`
      import { $state } from 'fict'

      function make(value) {
        return { value }
      }

      export function App() {
        const firstInit = make(1)
        const first = $state(firstInit)
        const secondInit = make(firstInit.value + 1)
        const second = $state(secondInit)
        return <div>{first.value}:{second.value}</div>
      }
    `)

    expectBefore(
      output,
      'const firstInit = make(1);',
      'const first = __fictUseSignal(__fictCtx, firstInit',
    )
    expectBefore(
      output,
      'const secondInit = make(firstInit.value + 1);',
      'const second = __fictUseSignal(__fictCtx, secondInit',
    )
  })

  it('keeps literal initializers on direct $state declarations', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function App() {
        const count = $state(1)
        return <button onClick={() => count(count() + 1)}>{count}</button>
      }
    `)

    expect(output).toContain('const count = __fictUseSignal(__fictCtx, 1')
  })
})
