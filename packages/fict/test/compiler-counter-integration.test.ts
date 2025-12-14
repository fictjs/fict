import { createRequire } from 'module'

import * as runtime from '@fictjs/runtime'
import * as runtimeJsx from '@fictjs/runtime/jsx-runtime'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { transformCommonJS } from '../../compiler/test/test-utils'
import * as fict from '../src'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

function compileAndLoad<TModule extends Record<string, any>>(source: string): TModule {
  const output = transformCommonJS(source)
  const module: { exports: any } = { exports: {} }
  const dynamicRequire = createRequire(import.meta.url)

  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime') return runtime
      if (id === '@fictjs/runtime/jsx-runtime') return runtimeJsx
      if (id === 'fict') return fict
      return dynamicRequire(id)
    },
    module,
    module.exports,
  )

  return module.exports as TModule
}

const conditionalCounterSource = `
  import { $state, $effect, render } from 'fict'

  function Counter() {
    let count = $state(0)
    let count1 = $state(0)
    const doubled = count * 2
    console.log('doubled', doubled)
    $effect(() => {
      document.title = \`Count: \${count}\`
    })
    if (!(count % 2)) {
      return (
        <>
          <button onClick={() => count++} data-testid="count">
            Count: {count} is divisible by 2, doubled: {doubled}
          </button>
          <button onClick={() => count1++} data-testid="count1">
            Count1: {count1}
          </button>
        </>
      )
    }
    return (
      <>
        <button onClick={() => count++} data-testid="count">
          Count: {count} is not divisible by 2, count1: {doubled}
        </button>
        <button onClick={() => count1++} data-testid="count1">
          Count1: {count1}
        </button>
      </>
    )
  }

  export function mount(el: HTMLElement) {
    return render(() => <Counter />, el)
  }
`

describe('compiler + fict integration', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    document.title = ''
  })

  it('compiles and runs a counter end to end', async () => {
    const source = `
      import { $state, render } from 'fict'

      export function mount(el: HTMLElement) {
        let count = $state(0)

        const increment = () => count++

        return render(() => (
          <div>
            <p data-testid="count">Count: {count}</p>
            <button data-testid="inc" onClick={increment}>Increment</button>
          </div>
        ), el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const readCount = () => container.querySelector('[data-testid="count"]')?.textContent
    const incBtn = container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(readCount()).toBe('Count: 0')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 1')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 2')

    dispose()
    await tick()
    expect(container.innerHTML).toBe('')
  })

  it('logs doubled on every count change and updates both branch and title', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(conditionalCounterSource)
    const dispose = mod.mount(container)

    const countBtn = () => container.querySelector('[data-testid="count"]') as HTMLButtonElement
    const count1Btn = () => container.querySelector('[data-testid="count1"]') as HTMLButtonElement

    await tick()

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenLastCalledWith('doubled', 0)
    expect(countBtn().textContent).toContain('Count: 0 is divisible by 2, doubled: 0')
    expect(count1Btn().textContent).toContain('Count1: 0')
    expect(document.title).toContain('Count: 0')

    countBtn().click()
    await tick()

    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenLastCalledWith('doubled', 2)
    expect(countBtn().textContent).toContain('Count: 1 is not divisible by 2, count1: 2')
    expect(count1Btn().textContent).toContain('Count1: 0')
    expect(document.title).toContain('Count: 1')

    countBtn().click()
    await tick()

    expect(logSpy).toHaveBeenCalledTimes(3)
    expect(logSpy).toHaveBeenLastCalledWith('doubled', 4)
    expect(countBtn().textContent).toContain('Count: 2 is divisible by 2, doubled: 4')
    expect(count1Btn().textContent).toContain('Count1: 0')
    expect(document.title).toContain('Count: 2')

    dispose()
    logSpy.mockRestore()
  })

  it('does not re-run doubled log when only count1 changes', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(conditionalCounterSource)
    const dispose = mod.mount(container)

    const countBtn = () => container.querySelector('[data-testid="count"]') as HTMLButtonElement
    const count1Btn = () => container.querySelector('[data-testid="count1"]') as HTMLButtonElement

    await tick()

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(countBtn().textContent).toContain('Count: 0 is divisible by 2, doubled: 0')
    expect(count1Btn().textContent).toContain('Count1: 0')
    expect(document.title).toContain('Count: 0')

    count1Btn().click()
    await tick()

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(countBtn().textContent).toContain('Count: 0 is divisible by 2, doubled: 0')
    expect(count1Btn().textContent).toContain('Count1: 1')
    expect(document.title).toContain('Count: 0')

    count1Btn().click()
    await tick()

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(countBtn().textContent).toContain('Count: 0 is divisible by 2, doubled: 0')
    expect(count1Btn().textContent).toContain('Count1: 2')
    expect(document.title).toContain('Count: 0')

    dispose()
    logSpy.mockRestore()
  })
})
