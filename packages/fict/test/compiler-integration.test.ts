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
  if (process.env.DEBUG_TEMPLATE_OUTPUT) {
    // eslint-disable-next-line no-console
    console.warn(output)
  }
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

const conditionalCounterWithLogsSource = `
  import { $state, $effect, render } from 'fict'

  function Counter() {
    let count = $state(0)
    let count1 = $state(0)
    const doubled = count * 2
    $effect(() => {
      document.title = \`Count: \${count}\`
    })
    if (!(count % 2)) {
      console.log('test')
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
    console.log('test1')
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
    // Reset hook context to avoid slot reuse across compiled modules
    ;(runtime as any).__fictResetContext?.()
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

  it('supports hook-style helpers returning object without destructuring', async () => {
    const source = `
      import { $state, render } from 'fict'

      const useCounter = () => {
        const count = $state(0)
        const double = count * 2
        return { count, double }
      }

      function Counter() {
        const props = useCounter()
        return (
          <div>
            <p data-testid="count">Count: {props.count}</p>
            <p data-testid="double">Double: {props.double}</p>
            <button data-testid="inc" onClick={() => props.count++}>Increment</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const readCount = () => container.querySelector('[data-testid="count"]')?.textContent
    const readDouble = () => container.querySelector('[data-testid="double"]')?.textContent
    const incBtn = container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(readCount()).toBe('Count: 0')
    expect(readDouble()).toBe('Double: 0')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 1')
    expect(readDouble()).toBe('Double: 2')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 2')
    expect(readDouble()).toBe('Double: 4')

    dispose()
  })

  it('supports hook-style helpers returning a single accessor value', async () => {
    const source = `
      import { $state, render } from 'fict'

      const useCounter = () => {
        const count = $state(0)
        return count
      }

      function Counter() {
        const count = useCounter()
        return (
          <div>
            <p data-testid="count">Count: {count}</p>
            <button data-testid="inc" onClick={() => count++}>Increment</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

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
  })

  it('supports hook-style helpers that return objects consumed via destructuring', async () => {
    const source = `
      import { $state, render } from 'fict'

      const useCounter = () => {
        const count = $state(0)
        const double = count * 2
        return { count, double }
      }

      function Counter() {
        const { count, double } = useCounter()
        return (
          <div>
            <p data-testid="count">Count: {count}</p>
            <p data-testid="double">Double: {double}</p>
            <button data-testid="inc" onClick={() => count++}>Increment</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const readCount = () => container.querySelector('[data-testid="count"]')?.textContent
    const readDouble = () => container.querySelector('[data-testid="double"]')?.textContent
    const incBtn = container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(readCount()).toBe('Count: 0')
    expect(readDouble()).toBe('Double: 0')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 1')
    expect(readDouble()).toBe('Double: 2')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 2')
    expect(readDouble()).toBe('Double: 4')

    dispose()
  })

  it('supports hook-style helpers spread into rest binding', async () => {
    const source = `
      import { $state, render } from 'fict'

      const useCounter = () => {
        const count = $state(0)
        const double = count * 2
        return { count, double }
      }

      function Counter() {
        const { ...props } = useCounter()
        return (
          <div>
            <p data-testid="count">Count: {props.count}</p>
            <p data-testid="double">Double: {props.double}</p>
            <button data-testid="inc" onClick={() => props.count++}>Increment</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const readCount = () => container.querySelector('[data-testid="count"]')?.textContent
    const readDouble = () => container.querySelector('[data-testid="double"]')?.textContent
    const incBtn = container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(readCount()).toBe('Count: 0')
    expect(readDouble()).toBe('Double: 0')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 1')
    expect(readDouble()).toBe('Double: 2')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 2')
    expect(readDouble()).toBe('Double: 4')

    dispose()
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

    if (process.env.DEBUG_TEMPLATE_OUTPUT) {
      // eslint-disable-next-line no-console
      console.warn('after first click', logSpy.mock.calls.length, countBtn().textContent)
    }

    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenLastCalledWith('doubled', 2)
    expect(countBtn().textContent).toContain('Count: 1 is not divisible by 2, count1: 2')
    expect(count1Btn().textContent).toContain('Count1: 0')
    expect(document.title).toContain('Count: 1')

    countBtn().click()
    await tick()

    if (process.env.DEBUG_TEMPLATE_OUTPUT) {
      // eslint-disable-next-line no-console
      console.warn('after second click', logSpy.mock.calls.length, countBtn().textContent)
    }

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

  it('logs execution branches correctly on count change', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(
      conditionalCounterWithLogsSource,
    )
    const dispose = mod.mount(container)

    const countBtn = () => container.querySelector('[data-testid="count"]') as HTMLButtonElement

    await tick()

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenNthCalledWith(1, 'test')

    countBtn().click()
    await tick()

    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenNthCalledWith(2, 'test1')

    countBtn().click()
    await tick()

    expect(logSpy).toHaveBeenCalledTimes(3)
    expect(logSpy).toHaveBeenNthCalledWith(3, 'test')

    dispose()
    logSpy.mockRestore()
  })

  // Edge case 1: Multiple side effects in both branches

  it('handles multiple side effects in both branches', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        if (count % 2 === 0) {
          console.log('even-1')
          console.log('even-2')
          return (
            <button onClick={() => count++} data-testid="btn">
              Even: {count}
            </button>
          )
        }
        console.log('odd-1')
        console.log('odd-2')
        return (
          <button onClick={() => count++} data-testid="btn">
            Odd: {count}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement

    await tick()

    // Initial: count=0 (even)
    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenNthCalledWith(1, 'even-1')
    expect(logSpy).toHaveBeenNthCalledWith(2, 'even-2')
    expect(btn().textContent).toContain('Even: 0')

    btn().click()
    await tick()

    // count=1 (odd)
    expect(logSpy).toHaveBeenCalledTimes(4)
    expect(logSpy).toHaveBeenNthCalledWith(3, 'odd-1')
    expect(logSpy).toHaveBeenNthCalledWith(4, 'odd-2')
    expect(btn().textContent).toContain('Odd: 1')

    btn().click()
    await tick()

    // count=2 (even)
    expect(logSpy).toHaveBeenCalledTimes(6)
    expect(logSpy).toHaveBeenNthCalledWith(5, 'even-1')
    expect(logSpy).toHaveBeenNthCalledWith(6, 'even-2')
    expect(btn().textContent).toContain('Even: 2')

    dispose()
    logSpy.mockRestore()
  })

  // Edge case 2: Variable declaration inside if block

  it('handles variable declarations inside if block', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        if (count > 2) {
          const message = 'Greater than 2: ' + count
          console.log('computed:', message)
          return (
            <button onClick={() => count++} data-testid="btn">
              {message}
            </button>
          )
        }
        const fallback = 'Small: ' + count
        return (
          <button onClick={() => count++} data-testid="btn">
            {fallback}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement

    await tick()

    expect(btn().textContent).toContain('Small: 0')
    expect(logSpy).not.toHaveBeenCalled()

    btn().click()
    await tick()
    btn().click()
    await tick()
    btn().click()
    await tick()

    // Now count=3, should show "Greater than 2"
    expect(btn().textContent).toContain('Greater than 2: 3')
    expect(logSpy).toHaveBeenCalledWith('computed:', 'Greater than 2: 3')

    dispose()
    logSpy.mockRestore()
  })

  // Edge case 3: if-else structure (should still work, just not optimized)

  it('handles if-else structure correctly', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        if (count % 2 === 0) {
          return (
            <button onClick={() => count++} data-testid="btn">
              Even: {count}
            </button>
          )
        } else {
          return (
            <button onClick={() => count++} data-testid="btn">
              Odd: {count}
            </button>
          )
        }
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement

    await tick()

    expect(btn().textContent).toContain('Even: 0')

    btn().click()
    await tick()

    expect(btn().textContent).toContain('Odd: 1')

    btn().click()
    await tick()

    expect(btn().textContent).toContain('Even: 2')

    dispose()
  })

  // Edge case 4: Complex condition with multiple signals

  it('handles complex condition with multiple signals', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let a = $state(0)
        let b = $state(0)
        if (a > 0 && b > 0) {
          console.log('both positive')
          return (
            <div>
              <button onClick={() => a++} data-testid="a">A: {a}</button>
              <button onClick={() => b++} data-testid="b">B: {b}</button>
              <span data-testid="status">Both positive</span>
            </div>
          )
        }
        console.log('not both positive')
        return (
          <div>
            <button onClick={() => a++} data-testid="a">A: {a}</button>
            <button onClick={() => b++} data-testid="b">B: {b}</button>
            <span data-testid="status">Not both positive</span>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const aBtn = () => container.querySelector('[data-testid="a"]') as HTMLButtonElement
    const bBtn = () => container.querySelector('[data-testid="b"]') as HTMLButtonElement
    const status = () => container.querySelector('[data-testid="status"]')?.textContent

    await tick()

    expect(status()).toBe('Not both positive')
    expect(logSpy).toHaveBeenLastCalledWith('not both positive')

    aBtn().click()
    await tick()

    // a=1, b=0, still not both positive
    expect(status()).toBe('Not both positive')

    bBtn().click()
    await tick()

    // a=1, b=1, now both positive
    expect(status()).toBe('Both positive')
    expect(logSpy).toHaveBeenLastCalledWith('both positive')

    dispose()
    logSpy.mockRestore()
  })

  // Edge case 5: Multiple statements between if and return (false branch)

  it('handles multiple statements between if and final return', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        if (count >= 3) {
          console.log('high')
          return (
            <button onClick={() => count++} data-testid="btn">
              High: {count}
            </button>
          )
        }
        console.log('low-step1')
        console.log('low-step2')
        const label = 'Low'
        return (
          <button onClick={() => count++} data-testid="btn">
            {label}: {count}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement

    await tick()

    expect(btn().textContent).toContain('Low: 0')
    expect(logSpy).toHaveBeenCalledWith('low-step1')
    expect(logSpy).toHaveBeenCalledWith('low-step2')

    logSpy.mockClear()

    btn().click()
    await tick()
    btn().click()
    await tick()
    btn().click()
    await tick()

    // count=3, should show "High"
    expect(btn().textContent).toContain('High: 3')
    expect(logSpy).toHaveBeenLastCalledWith('high')

    dispose()
    logSpy.mockRestore()
  })

  // Edge case 6a: Simple conditional - verify bindText updates when condition unchanged

  it('updates text when condition stays false but value changes', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        if (count >= 10) {
          return (
            <button onClick={() => count++} data-testid="btn">
              High: {count}
            </button>
          )
        }
        return (
          <button onClick={() => count++} data-testid="btn">
            Low: {count}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement

    await tick()

    expect(btn().textContent).toContain('Low: 0')

    btn().click()
    await tick()

    // count=1, condition still false, but text should update
    expect(btn().textContent).toContain('Low: 1')

    btn().click()
    await tick()

    // count=2, still false
    expect(btn().textContent).toContain('Low: 2')

    dispose()
  })

  // Edge case 6: Nested if inside if block (inner if without return)
  // Note: Inner if-else statements inside a branch only execute when the branch
  // is first rendered. They don't re-execute when signals change within the same branch.
  // This is by design - only the createConditional's condition determines branch switching.

  it('handles nested if inside if block', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        if (count >= 2) {
          if (count % 2 === 0) {
            console.log('high and even')
          } else {
            console.log('high and odd')
          }
          return (
            <button onClick={() => count++} data-testid="btn">
              High: {count}
            </button>
          )
        }
        console.log('low')
        return (
          <button onClick={() => count++} data-testid="btn">
            Low: {count}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement

    await tick()

    expect(btn().textContent).toContain('Low: 0')
    expect(logSpy).toHaveBeenLastCalledWith('low')

    btn().click()
    await tick()

    expect(btn().textContent).toContain('Low: 1')

    btn().click()
    await tick()

    // count=2 (high and even) - branch switches, inner if executes
    expect(btn().textContent).toContain('High: 2')
    expect(logSpy).toHaveBeenLastCalledWith('high and even')

    btn().click()
    await tick()

    // count=3 - DOM updates via bindText, but inner if-else doesn't re-execute
    // because the branch (count >= 2) hasn't changed
    expect(btn().textContent).toContain('High: 3')
    // Note: console.log('high and odd') is NOT called because branch didn't switch

    dispose()
    logSpy.mockRestore()
  })

  // Edge case 7: Early return before the conditional pattern
  // LIMITATION: Multiple sequential if statements with returns are not fully supported.
  // Only the last if-return pair gets converted to createConditional.
  // The first if (disabled) remains as a regular if statement in the render function.
  it('handles early return before conditional pattern', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        let disabled = $state(false)

        if (disabled) {
          return <div data-testid="disabled">Disabled</div>
        }

        if (count >= 3) {
          console.log('high')
          return (
            <div>
              <button onClick={() => count++} data-testid="btn">High: {count}</button>
              <button onClick={() => disabled = true} data-testid="disable">Disable</button>
            </div>
          )
        }
        console.log('low')
        return (
          <div>
            <button onClick={() => count++} data-testid="btn">Low: {count}</button>
            <button onClick={() => disabled = true} data-testid="disable">Disable</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement
    const disableBtn = () => container.querySelector('[data-testid="disable"]') as HTMLButtonElement
    const disabledDiv = () => container.querySelector('[data-testid="disabled"]')

    await tick()

    expect(btn().textContent).toContain('Low: 0')
    expect(logSpy).toHaveBeenLastCalledWith('low')

    btn().click()
    await tick()
    btn().click()
    await tick()
    btn().click()
    await tick()

    expect(btn().textContent).toContain('High: 3')
    expect(logSpy).toHaveBeenLastCalledWith('high')

    disableBtn().click()
    await tick()

    expect(disabledDiv()?.textContent).toBe('Disabled')

    dispose()
    logSpy.mockRestore()
  })

  // Edge case 8: Side effect depends on signal that changes

  it('handles reactive side effects in branches', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        if (count % 2 === 0) {
          console.log('even value:', count)
          return (
            <button onClick={() => count++} data-testid="btn">
              Even: {count}
            </button>
          )
        }
        console.log('odd value:', count)
        return (
          <button onClick={() => count++} data-testid="btn">
            Odd: {count}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement

    await tick()

    expect(logSpy).toHaveBeenLastCalledWith('even value:', 0)

    btn().click()
    await tick()

    expect(logSpy).toHaveBeenLastCalledWith('odd value:', 1)

    btn().click()
    await tick()

    expect(logSpy).toHaveBeenLastCalledWith('even value:', 2)

    btn().click()
    await tick()

    expect(logSpy).toHaveBeenLastCalledWith('odd value:', 3)

    dispose()
    logSpy.mockRestore()
  })

  // Edge case 9: Only side effects in if block, no return (should not transform)
  // LIMITATION: If blocks without return are not converted to createConditional.
  // The console.log inside the if block only executes once during initial render,
  // not reactively when the signal changes. This is by design - use $effect for
  // reactive side effects.

  it('handles if block without return correctly', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        if (count > 0) {
          console.log('positive:', count)
        }
        return (
          <button onClick={() => count++} data-testid="btn">
            Count: {count}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement

    await tick()

    // Initial render: count=0, condition is false, console.log not called
    expect(btn().textContent).toContain('Count: 0')
    expect(logSpy).not.toHaveBeenCalled()

    btn().click()
    await tick()

    // DOM updates via bindText, but the if block doesn't re-execute
    // because it's not wrapped in createConditional (no return in if block)
    expect(btn().textContent).toContain('Count: 1')
    // Note: console.log is NOT called - if blocks without return don't re-execute

    btn().click()
    await tick()

    expect(btn().textContent).toContain('Count: 2')
    // Note: console.log is still NOT called

    dispose()
    logSpy.mockRestore()
  })

  // Edge case 10: Three-way condition with multiple ifs
  // LIMITATION: Only the last if-return pair is converted to createConditional.
  // The first if (count >= 4) remains as a regular if statement.
  it('handles multiple sequential if statements with returns', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        if (count >= 4) {
          console.log('very high')
          return (
            <button onClick={() => count++} data-testid="btn">
              Very High: {count}
            </button>
          )
        }
        if (count >= 2) {
          console.log('medium')
          return (
            <button onClick={() => count++} data-testid="btn">
              Medium: {count}
            </button>
          )
        }
        console.log('low')
        return (
          <button onClick={() => count++} data-testid="btn">
            Low: {count}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const btn = () => container.querySelector('[data-testid="btn"]') as HTMLButtonElement

    await tick()

    expect(btn().textContent).toContain('Low: 0')
    expect(logSpy).toHaveBeenLastCalledWith('low')

    btn().click()
    await tick()

    expect(btn().textContent).toContain('Low: 1')

    btn().click()
    await tick()

    expect(btn().textContent).toContain('Medium: 2')
    expect(logSpy).toHaveBeenLastCalledWith('medium')

    btn().click()
    await tick()
    btn().click()
    await tick()

    expect(btn().textContent).toContain('Very High: 4')
    expect(logSpy).toHaveBeenLastCalledWith('very high')

    dispose()
    logSpy.mockRestore()
  })

  it('props: runtime-built spread vs reactive marked spread', async () => {
    const naiveSource = `
      import { $state, render } from 'fict'

      export let bump: () => void

      function Row(props: any) {
        return (
          <div>
            <span className="id">{props.id}</span>
            <span className="name">{props.label}</span>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        let userId = $state(1)
        let userName = $state('Alicia')
        bump = () => {
          userId = 3
          userName = 'Charlie'
        }

        // Built once outside the render effect (compiler can't see inside the IIFE body)
        const payload = (() => ({ id: userId(), label: userName() }))()
        return render(() => <Row {...payload} />, el)
      }
    `

    const wrappedSource = `
      import { $state, render, prop, mergeProps } from 'fict'

      export let bump: () => void

      function Row(props: any) {
        return (
          <div>
            <span className="id">{props.id}</span>
            <span className="name">{props.label}</span>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        let userId = $state(1)
        let userName = $state('Alicia')
        bump = () => {
          userId = 3
          userName = 'Charlie'
        }

        // Built once but fields are reactive getters, so they stay live
        const payload = mergeProps({
          id: prop(() => userId()),
          label: prop(() => userName()),
        })
        return render(() => <Row {...payload} />, el)
      }
    `

    // Naive: snapshot
    {
      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void; bump: () => void }>(
        naiveSource,
      )
      const dispose = mod.mount(container)
      await tick()
      const read = () => ({
        id: container.querySelector('.id')?.textContent,
        name: container.querySelector('.name')?.textContent,
      })
      const initial = read()
      mod.bump()
      await tick()
      // Stale because payload was built at runtime without prop markers
      expect(read()).toEqual(initial)
      dispose()
    }

    // Wrapped: stays reactive
    {
      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void; bump: () => void }>(
        wrappedSource,
      )
      const dispose = mod.mount(container)
      await tick()
      const read = () => ({
        id: container.querySelector('.id')?.textContent,
        name: container.querySelector('.name')?.textContent,
      })
      mod.bump()
      await tick()
      expect(read()).toEqual({ id: '3', name: 'Charlie' })
      dispose()
    }
  })

  it('props: prop helper keeps child reactive without parent rerender', async () => {
    const source = `
      import { $state, render, prop } from 'fict'
      export let bump: () => void

      function Child(props: any) {
        return <span className="value">{props.value}</span>
      }

      export function mount(el: HTMLElement) {
        let count = $state(0)
        bump = () => { count = count + 1 }

        // Parent view does not read count directly; prop getter should keep child reactive
        return render(() => <Child value={prop(() => count())} />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void; bump: () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const read = () => container.querySelector('.value')?.textContent
    expect(read()).toBe('0')

    mod.bump()
    await tick()
    expect(read()).toBe('1')

    dispose()
  })

  it('props: merged sources keep reactive fields with prop/mergeProps', async () => {
    const source = `
      import { $state, render, prop, mergeProps } from 'fict'
      export let bump: () => void

      function Counter(props: any) {
        return (
          <div data-testid={props['data-testid']}>
            <span className="count">{props.count}</span>
            <span className="extra">{props.extra}</span>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        let count = $state(0)
        const defaults = { extra: 'x' }
        bump = () => { count = count + 1 }

        // Built once outside render, so the plain value is a snapshot
        const snapshot = { count: count() }
        // Built once but with reactive getter
        const reactive = { count: prop(() => count()) }

        return render(
          () => (
            <>
              <Counter data-testid="naive" {...mergeProps(defaults, snapshot)} />
              <Counter data-testid="wrapped" {...mergeProps(defaults, reactive)} />
            </>
          ),
          el,
        )
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void; bump: () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const read = (testId: string) => ({
      count: container.querySelector(`[data-testid="${testId}"] .count`)?.textContent,
      extra: container.querySelector(`[data-testid="${testId}"] .extra`)?.textContent,
    })

    expect(read('naive')).toEqual({ count: '0', extra: 'x' })
    expect(read('wrapped')).toEqual({ count: '0', extra: 'x' })

    mod.bump()
    await tick()

    // Both update because JSX spread inside render() triggers re-evaluation
    // The mergeProps result is passed to child component which reads props reactively
    expect(read('naive')).toEqual({ count: '1', extra: 'x' })
    expect(read('wrapped')).toEqual({ count: '1', extra: 'x' })

    dispose()
  })

  it('props: compiler auto-wraps derived prop with useProp to avoid recompute', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let getCallCount: () => number

      const heavy = (n: number) => {
        callCount++
        return n * 10
      }

      let callCount = 0

      function Child(props: any) {
        return (
          <div>
            <p data-testid="value-a">{props.value}</p>
            <p data-testid="value-b">{props.value}</p>
            <button data-testid="inc" onClick={props.onInc}>Inc</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        let count = $state(0)
        const onInc = () => count++

        getCallCount = () => callCount

        return render(() => (
          <Child value={heavy(count)} onInc={onInc} />
        ), el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      getCallCount: () => number
    }>(source)
    const dispose = mod.mount(container)
    await tick()

    const readA = () => container.querySelector('[data-testid="value-a"]')?.textContent
    const readB = () => container.querySelector('[data-testid="value-b"]')?.textContent
    const incBtn = container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(readA()).toBe('0')
    expect(readB()).toBe('0')
    expect(mod.getCallCount()).toBe(1) // heavy called once initially

    incBtn.click()
    await tick()
    expect(readA()).toBe('10')
    expect(readB()).toBe('10')
    expect(mod.getCallCount()).toBe(2) // once per change, not per access

    incBtn.click()
    await tick()
    expect(readA()).toBe('20')
    expect(readB()).toBe('20')
    expect(mod.getCallCount()).toBe(3)

    dispose()
  })

  it('props: auto prop wrapping keeps multi-spread props reactive (no manual mergeProps)', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Child(props: any) {
        return (
          <div>
            <p data-testid="label">{props.label}</p>
            <p data-testid="count">Count: {props.count}</p>
            <button data-testid="inc" onClick={() => props.onInc?.()}>Inc</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        let count = $state(0)
        return render(() => (
          <Child {...{ label: 'hello' }} {...{ count, onInc: () => count++ }} />
        ), el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

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
  })
  it('props: heavy computation memoized with useProp vs raw', async () => {
    const source = `
      import { $state, render, useProp } from 'fict'
      export let bump: () => void
      export let rawCalls = 0
      export let memoCalls = 0

      const heavy = (n: number) => {
        rawCalls++ // incremented when raw path is used
        let acc = 0
        for (let i = 0; i < 2000; i++) acc += n + i
        return acc
      }

      function Pair(props: any) {
        return (
          <div>
            <span className="raw">{props.raw}</span>
            <span className="memo">{props.memo}</span>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        let count = $state(1)
        bump = () => { count = count + 1 }

        const memo = useProp(() => {
          memoCalls++
          let acc = 0
          for (let i = 0; i < 2000; i++) acc += count + i
          return acc
        })

        return render(
          () => <Pair raw={heavy(count)} memo={memo} />,
          el,
        )
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      bump: () => void
      rawCalls: number
      memoCalls: number
    }>(source)

    const dispose = mod.mount(container)
    await tick()

    const read = () => ({
      raw: container.querySelector('.raw')?.textContent,
      memo: container.querySelector('.memo')?.textContent,
    })

    const initial = read()
    expect(initial.raw).toBe(initial.memo)
    expect(initial.raw).toBeDefined()
    expect(mod.rawCalls).toBeGreaterThanOrEqual(1)
    expect(mod.memoCalls).toBeGreaterThanOrEqual(1)

    const initialCalls = { raw: mod.rawCalls, memo: mod.memoCalls }

    mod.bump()
    await tick()

    const after = read()
    expect(after.raw).toBe(after.memo)
    expect(after.raw).not.toEqual(initial.raw)
    expect(mod.rawCalls).toBeGreaterThanOrEqual(mod.memoCalls)
    expect(mod.rawCalls).toBeGreaterThanOrEqual(initialCalls.raw)
    expect(mod.memoCalls).toBeGreaterThanOrEqual(initialCalls.memo)

    dispose()
  })

  it('props: unknown shape factory, mark reactive fields explicitly', async () => {
    const source = `
      import { $state, render, prop, mergeProps } from 'fict'
      export let bump: () => void

      function Dashboard(props: any) {
        return (
          <div data-testid={props['data-testid']}>
            <span className="theme">{props.theme}</span>
            <span className="user">{props.user}</span>
            <span className="flag">{String(props.staticFlag)}</span>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        let theme = $state('light')
        let userName = $state('Alicia')
        bump = () => {
          theme = 'midnight'
          userName = 'Charlie'
        }

        return render(
          () => (
            <>
              <Dashboard
                data-testid="naive"
                {...{
                  theme: theme(),
                  user: userName(),
                  staticFlag: true,
                }}
              />
              <Dashboard
                data-testid="wrapped"
                theme={prop(() => theme())}
                user={prop(() => userName())}
                staticFlag={true}
              />
            </>
          ),
          el,
        )
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void; bump: () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const read = (testId: string) => ({
      theme: container.querySelector(`[data-testid="${testId}"] .theme`)?.textContent,
      user: container.querySelector(`[data-testid="${testId}"] .user`)?.textContent,
      flag: container.querySelector(`[data-testid="${testId}"] .flag`)?.textContent,
    })

    expect(read('naive')).toEqual({ theme: 'light', user: 'Alicia', flag: 'true' })
    expect(read('wrapped')).toEqual({ theme: 'light', user: 'Alicia', flag: 'true' })

    mod.bump()
    await tick()

    expect(read('naive')).toEqual({ theme: 'midnight', user: 'Charlie', flag: 'true' })
    expect(read('wrapped')).toEqual({ theme: 'midnight', user: 'Charlie', flag: 'true' })

    dispose()
  })

  it('wires cross-module state + derived exports end to end', async () => {
    const storeSource = `
      import { $state } from 'fict'

      export let count = $state(0)
      export const double = count * 2
      export const inc = () => count(count() + 1)
    `

    const appSource = `
      import { render } from 'fict'
      import { count, double, inc } from './store'

      export function mount(el: HTMLElement) {
        return render(() => (
          <div>
            <p data-testid="count">Count: {count()}</p>
            <p data-testid="double">Double: {double()}</p>
            <button data-testid="inc" onClick={inc}>Increment</button>
          </div>
        ), el)
      }
    `

    const moduleCache: Record<string, any> = {}
    const evalModule = (code: string, id: string) => {
      const mod = { exports: {} as any }
      const wrapped = new Function('require', 'module', 'exports', code)
      wrapped(
        (reqId: string) => {
          if (reqId === '@fictjs/runtime') return runtime
          if (reqId === '@fictjs/runtime/jsx-runtime') return runtimeJsx
          if (reqId === 'fict') return fict
          if (moduleCache[reqId]) return moduleCache[reqId]
          throw new Error('Unresolved module: ' + reqId)
        },
        mod,
        mod.exports,
      )
      moduleCache[id] = mod.exports
      return mod.exports
    }

    const storeCode = transformCommonJS(storeSource, {}, 'store.tsx')
    if (process.env.DEBUG_TEMPLATE_OUTPUT) {
      // eslint-disable-next-line no-console
      console.warn('STORE MODULE\n', storeCode)
    }
    evalModule(storeCode, './store')

    const appCode = transformCommonJS(appSource, {}, 'app.tsx')
    if (process.env.DEBUG_TEMPLATE_OUTPUT) {
      // eslint-disable-next-line no-console
      console.warn('APP MODULE\n', appCode)
    }
    const app = evalModule(appCode, './app') as { mount: (el: HTMLElement) => () => void }
    const dispose = app.mount(container)
    await tick()
    if (process.env.DEBUG_TEMPLATE_OUTPUT) {
      // eslint-disable-next-line no-console
      console.warn('HTML AFTER MOUNT\n', container.innerHTML)
    }

    const readCount = () => container.querySelector('[data-testid="count"]')?.textContent
    const readDouble = () => container.querySelector('[data-testid="double"]')?.textContent
    const incBtn = container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(readCount()).toBe('Count: 0')
    expect(readDouble()).toBe('Double: 0')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 1')
    expect(readDouble()).toBe('Double: 2')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 2')
    expect(readDouble()).toBe('Double: 4')

    dispose()
  })
})
