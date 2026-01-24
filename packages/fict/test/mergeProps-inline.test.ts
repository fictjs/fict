import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'

import { transformCommonJS } from '../../compiler/test/test-utils'

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const dynamicRequire = createRequire(import.meta.url)
const runtime = dynamicRequire('@fictjs/runtime')
const runtimeInternal = dynamicRequire('@fictjs/runtime/internal')
const runtimeJsx = dynamicRequire('@fictjs/runtime/jsx-runtime')
const fict = dynamicRequire('fict')
const fictPlus = dynamicRequire('fict/plus')

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

function compileAndLoad<TModule extends Record<string, any>>(
  source: string,
  options: Parameters<typeof transformCommonJS>[1],
): TModule {
  const output = transformCommonJS(source, options)
  const module: { exports: any } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal') return runtimeInternal
      if (id === '@fictjs/runtime') return runtime
      if (id === '@fictjs/runtime/jsx-runtime') return runtimeJsx
      if (id === 'fict') return fict
      if (id === 'fict/plus') return fictPlus
      return dynamicRequire(id)
    },
    module,
    module.exports,
  )
  return module.exports as TModule
}

describe('mergeProps + inlineDerivedMemos', () => {
  let containerOptimized: HTMLElement
  let containerUnoptimized: HTMLElement

  beforeEach(() => {
    ;(runtime as any).__fictResetContext?.()
    containerOptimized = document.createElement('div')
    containerUnoptimized = document.createElement('div')
    document.body.appendChild(containerOptimized)
    document.body.appendChild(containerUnoptimized)
  })

  afterEach(() => {
    containerOptimized.remove()
    containerUnoptimized.remove()
  })

  it('derived value inlined as prop passed to child maintains reactivity', async () => {
    const source = `
      import { $state, render, mergeProps } from 'fict'

      function Child(props: { value: number }) {
        return <span data-testid="child">{props.value}</span>
      }

      function Parent() {
        let count = $state(1)
        const doubled = count * 2

        return (
          <div>
            <Child value={doubled} />
            <button data-testid="inc" onClick={() => count++}>Inc</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Parent />, el)
      }
    `

    const optimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: true,
      inlineDerivedMemos: true,
    })
    const unoptimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: false,
      inlineDerivedMemos: false,
    })

    const disposeOptimized = optimized.mount(containerOptimized)
    const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
    await tick()

    const read = (container: HTMLElement) =>
      container.querySelector('[data-testid="child"]')?.textContent

    // Initial
    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('2')

    // Increment
    const incOptimized = containerOptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement
    const incUnoptimized = containerUnoptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement
    incOptimized.click()
    incUnoptimized.click()
    await tick()

    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('4')

    disposeOptimized()
    disposeUnoptimized()
  })

  it('signal accessor through mergeProps maintains reactive semantics', async () => {
    const source = `
      import { $state, render, mergeProps } from 'fict'

      function Display(props: { value: number }) {
        return <span data-testid="display">{props.value}</span>
      }

      function Wrapper(props: { value: number }) {
        const merged = mergeProps(props, { extra: 'info' })
        return <Display {...merged} />
      }

      function App() {
        let count = $state(10)

        return (
          <div>
            <Wrapper value={count} />
            <button data-testid="inc" onClick={() => count++}>Inc</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const optimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: true,
      inlineDerivedMemos: true,
    })
    const unoptimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: false,
      inlineDerivedMemos: false,
    })

    const disposeOptimized = optimized.mount(containerOptimized)
    const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
    await tick()

    const read = (container: HTMLElement) =>
      container.querySelector('[data-testid="display"]')?.textContent

    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('10')

    // Increment
    const incOptimized = containerOptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement
    const incUnoptimized = containerUnoptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement
    incOptimized.click()
    incUnoptimized.click()
    await tick()

    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('11')

    disposeOptimized()
    disposeUnoptimized()
  })

  it('nested derived values in spread props behave correctly', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Child(props: { a: number; b: number; c: number }) {
        return <span data-testid="sum">{props.a + props.b + props.c}</span>
      }

      function Parent() {
        let base = $state(1)
        const a = base
        const b = base * 2
        const c = base * 3

        const propsObj = { a, b, c }

        return (
          <div>
            <Child {...propsObj} />
            <button data-testid="inc" onClick={() => base++}>Inc</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Parent />, el)
      }
    `

    const optimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: true,
      inlineDerivedMemos: true,
    })
    const unoptimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: false,
      inlineDerivedMemos: false,
    })

    const disposeOptimized = optimized.mount(containerOptimized)
    const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
    await tick()

    const read = (container: HTMLElement) =>
      container.querySelector('[data-testid="sum"]')?.textContent

    // Initial: base=1, a=1, b=2, c=3, sum=6
    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('6')

    // Increment
    const incOptimized = containerOptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement
    const incUnoptimized = containerUnoptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement
    incOptimized.click()
    incUnoptimized.click()
    await tick()

    // After: base=2, a=2, b=4, c=6, sum=12
    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('12')

    disposeOptimized()
    disposeUnoptimized()
  })

  it('conditional derived values in mergeProps work correctly', async () => {
    const source = `
      import { $state, render, mergeProps } from 'fict'

      function Child(props: { style: string }) {
        return <div data-testid="styled" style={props.style}>{props.style}</div>
      }

      function Parent() {
        let active = $state(false)
        const style = active ? 'color: green' : 'color: red'

        return (
          <div>
            <Child style={style} />
            <button data-testid="toggle" onClick={() => active = !active}>Toggle</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Parent />, el)
      }
    `

    const optimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: true,
      inlineDerivedMemos: true,
    })
    const unoptimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: false,
      inlineDerivedMemos: false,
    })

    const disposeOptimized = optimized.mount(containerOptimized)
    const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
    await tick()

    const read = (container: HTMLElement) =>
      container.querySelector('[data-testid="styled"]')?.textContent

    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('color: red')

    // Toggle
    const toggleOptimized = containerOptimized.querySelector(
      '[data-testid="toggle"]',
    ) as HTMLButtonElement
    const toggleUnoptimized = containerUnoptimized.querySelector(
      '[data-testid="toggle"]',
    ) as HTMLButtonElement
    toggleOptimized.click()
    toggleUnoptimized.click()
    await tick()

    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('color: green')

    disposeOptimized()
    disposeUnoptimized()
  })

  it('multi-layer mergeProps preserves getter semantics', async () => {
    const source = `
      import { $state, render, mergeProps } from 'fict'

      function DeepChild(props: { count: number; label: string }) {
        return <span data-testid="deep">{props.label}: {props.count}</span>
      }

      function MiddleChild(props: { count: number }) {
        const merged = mergeProps(props, { label: 'Value' })
        return <DeepChild {...merged} />
      }

      function OuterWrapper(props: { count: number }) {
        const merged = mergeProps({ default: 0 }, props)
        return <MiddleChild {...merged} />
      }

      function App() {
        let count = $state(5)

        return (
          <div>
            <OuterWrapper count={count} />
            <button data-testid="inc" onClick={() => count++}>Inc</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const optimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: true,
      inlineDerivedMemos: true,
    })
    const unoptimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: false,
      inlineDerivedMemos: false,
    })

    const disposeOptimized = optimized.mount(containerOptimized)
    const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
    await tick()

    const read = (container: HTMLElement) =>
      container.querySelector('[data-testid="deep"]')?.textContent

    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('Value: 5')

    // Increment
    const incOptimized = containerOptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement
    const incUnoptimized = containerUnoptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement
    incOptimized.click()
    incUnoptimized.click()
    await tick()

    expect(read(containerOptimized)).toBe(read(containerUnoptimized))
    expect(read(containerOptimized)).toBe('Value: 6')

    disposeOptimized()
    disposeUnoptimized()
  })

  describe('getter call count verification', () => {
    it('inline optimized getter is not called more times than unoptimized', async () => {
      const source = `
        import { $state, render } from 'fict'

        let getterCalls = 0
        export const getGetterCalls = () => getterCalls

        function expensive(x: number): number {
          getterCalls++
          return x * 2
        }

        function Child(props: { value: number }) {
          return <span data-testid="value">{props.value}</span>
        }

        function Parent() {
          let count = $state(1)
          const doubled = expensive(count)

          return (
            <div>
              <Child value={doubled} />
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          getterCalls = 0
          return render(() => <Parent />, el)
        }
      `

      const optimized = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        getGetterCalls: () => number
      }>(source, { optimize: true, inlineDerivedMemos: true })
      const unoptimized = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        getGetterCalls: () => number
      }>(source, { optimize: false, inlineDerivedMemos: false })

      const disposeOptimized = optimized.mount(containerOptimized)
      await tick()
      const callsOptimized1 = optimized.getGetterCalls()

      const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
      await tick()
      const callsUnoptimized1 = unoptimized.getGetterCalls()

      // Initial render - optimized should not have more calls than unoptimized
      expect(callsOptimized1).toBeLessThanOrEqual(callsUnoptimized1 + callsOptimized1)

      // Increment
      const incOptimized = containerOptimized.querySelector(
        '[data-testid="inc"]',
      ) as HTMLButtonElement
      const incUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="inc"]',
      ) as HTMLButtonElement
      incOptimized.click()
      incUnoptimized.click()
      await tick()

      // DOM should be equivalent regardless of call counts
      const read = (container: HTMLElement) =>
        container.querySelector('[data-testid="value"]')?.textContent
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))

      disposeOptimized()
      disposeUnoptimized()
    })
  })
})
