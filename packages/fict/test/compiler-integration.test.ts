import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })
import { createRequire } from 'module'

import { transformCommonJS } from '../../compiler/test/test-utils'

const dynamicRequire = createRequire(import.meta.url)
const runtime = dynamicRequire('@fictjs/runtime')
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
  deps: Record<string, any> = {},
): TModule {
  const output = transformCommonJS(source)
  if (process.env.DEBUG_TEMPLATE_OUTPUT) {
    // eslint-disable-next-line no-console
    console.warn(output)
  }

  const module: { exports: any } = { exports: {} }

  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      if (Object.prototype.hasOwnProperty.call(deps, id)) return deps[id]
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

      function Counter() {
        let count = $state(0)
        const increment = () => count++
        return (
          <div>
            <p data-testid="count">Count: {count}</p>
            <button data-testid="inc" onClick={increment}>Increment</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
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
        let count = $state(0)
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
        let count = $state(0)
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
        let count = $state(0)
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
        let count = $state(0)
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

  it('binds functions returned from external hooks without accessor unwrapping', async () => {
    const hookSource = `
      import { $state } from 'fict'

      export function useCounter() {
        let count = $state(0)
        const increment = () => {
          count++
        }
        const incrementWithEvent = (e?: MouseEvent) => {
          count += (e?.detail as number | undefined) ?? 1
        }
        return { count: () => count, increment, incrementWithEvent }
      }
    `

    const hookModule = compileAndLoad<{ useCounter: () => any }>(hookSource)
    const deps = {
      './use-counter': hookModule,
    }

    const source = `
      import { render } from 'fict'
      import { useCounter } from './use-counter'

      function Counter() {
        const { count, increment, incrementWithEvent } = useCounter()
        return (
          <div>
            <p data-testid="count">Count: {count()}</p>
            <button data-testid="inc" onClick={increment}>Increment</button>
            <button data-testid="inc-event" onClick={incrementWithEvent}>Increment with event</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, deps)
    const dispose = mod.mount(container)
    await tick()

    const readCount = () => container.querySelector('[data-testid="count"]')?.textContent
    const incBtn = container.querySelector('[data-testid="inc"]') as HTMLButtonElement
    const incEventBtn = container.querySelector('[data-testid="inc-event"]') as HTMLButtonElement

    expect(readCount()).toBe('Count: 0')

    incBtn.click()
    await tick()
    expect(readCount()).toBe('Count: 1')

    incEventBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 3 }))
    await tick()
    expect(readCount()).toBe('Count: 4')

    incEventBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await tick()
    expect(readCount()).toBe('Count: 5')

    dispose()
  })

  it('keeps props reactive when destructured in child components', async () => {
    const source = `
      import { $state, render } from 'fict'

      const Counter1 = ({ count, update }) => {
        const doubled = count * 2
        return (
          <div>
            <h1 data-testid="count">Count: {count}</h1>
            <h2 data-testid="double">Double: {doubled}</h2>
            <button data-testid="inc" onClick={() => update()}>
              Increment
            </button>
          </div>
        )
      }

      function Counter() {
        let counter = $state({ count: 0 })
        return (
          <Counter1
            count={counter.count}
            update={() => {
              counter = { count: counter.count + 1 }
            }}
          />
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const countEl = () => container.querySelector('[data-testid="count"]') as HTMLHeadingElement
    const doubleEl = () => container.querySelector('[data-testid="double"]') as HTMLHeadingElement
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(countEl().textContent).toBe('Count: 0')
    expect(doubleEl().textContent).toBe('Double: 0')

    incBtn().click()
    await tick()

    expect(countEl().textContent).toBe('Count: 1')
    expect(doubleEl().textContent).toBe('Double: 2')

    incBtn().click()
    await tick()

    expect(countEl().textContent).toBe('Count: 2')
    expect(doubleEl().textContent).toBe('Double: 4')

    dispose()
  })

  it('keeps props reactive when accessed via props object', async () => {
    const source = `
      import { $state, render } from 'fict'

      const Counter1 = (props) => {
        const doubled = props.count * 2
        return (
          <div>
            <h1 data-testid="count">Count: {props.count}</h1>
            <h2 data-testid="double">Double: {doubled}</h2>
            <button data-testid="inc" onClick={() => props.update()}>
              Increment
            </button>
          </div>
        )
      }

      function Counter() {
        let counter = $state({ count: 0 })
        return (
          <Counter1
            count={counter.count}
            update={() => {
              counter = { count: counter.count + 1 }
            }}
          />
        )
      }

      export function mount(el) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const countEl = () => container.querySelector('[data-testid="count"]') as HTMLHeadingElement
    const doubleEl = () => container.querySelector('[data-testid="double"]') as HTMLHeadingElement
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(countEl().textContent).toBe('Count: 0')
    expect(doubleEl().textContent).toBe('Double: 0')

    incBtn().click()
    await tick()
    expect(countEl().textContent).toBe('Count: 1')
    expect(doubleEl().textContent).toBe('Double: 2')

    incBtn().click()
    await tick()
    expect(countEl().textContent).toBe('Count: 2')
    expect(doubleEl().textContent).toBe('Double: 4')

    dispose()
  })

  it('keeps props reactive when passing a state object as a prop', async () => {
    const source = `
      import { $state, render } from 'fict'

      const Counter1 = (props: { counter: { count: number }; update: () => void }) => {
        const doubled = props.counter.count * 2
        return (
          <div>
            <h1 data-testid="count">Count: {props.counter.count}</h1>
            <h2 data-testid="double">Double: {doubled}</h2>
            <button data-testid="inc" onClick={() => props.update()}>
              Increment
            </button>
          </div>
        )
      }

      function Counter() {
        let counter = $state({ count: 0 })
        return (
          <Counter1
            counter={counter}
            update={() => {
              counter = { count: counter.count + 1 }
            }}
          />
        )
      }

      export function mount(el) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const countEl = () => container.querySelector('[data-testid="count"]') as HTMLHeadingElement
    const doubleEl = () => container.querySelector('[data-testid="double"]') as HTMLHeadingElement
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(countEl().textContent).toBe('Count: 0')
    expect(doubleEl().textContent).toBe('Double: 0')

    incBtn().click()
    await tick()
    expect(countEl().textContent).toBe('Count: 1')
    expect(doubleEl().textContent).toBe('Double: 2')

    incBtn().click()
    await tick()
    expect(countEl().textContent).toBe('Count: 2')
    expect(doubleEl().textContent).toBe('Double: 4')

    dispose()
  })

  // ===== Props Destructuring Patterns Tests =====

  it('keeps props reactive with post-declaration destructuring inside function body', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Child(props) {
        const { count, label } = props
        const doubled = count * 2
        return (
          <div>
            <span data-testid="count">{count}</span>
            <span data-testid="label">{label}</span>
            <span data-testid="doubled">{doubled}</span>
            <button data-testid="inc" onClick={() => props.onInc()}>Inc</button>
          </div>
        )
      }

      function App() {
        let count = $state(0)
        return (
          <Child
            count={count}
            label={"Count is " + count}
            onInc={() => count++}
          />
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const countEl = () => container.querySelector('[data-testid="count"]')?.textContent
    const labelEl = () => container.querySelector('[data-testid="label"]')?.textContent
    const doubledEl = () => container.querySelector('[data-testid="doubled"]')?.textContent
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(countEl()).toBe('0')
    expect(labelEl()).toBe('Count is 0')
    expect(doubledEl()).toBe('0')

    incBtn().click()
    await tick()
    expect(countEl()).toBe('1')
    expect(labelEl()).toBe('Count is 1')
    expect(doubledEl()).toBe('2')

    incBtn().click()
    await tick()
    expect(countEl()).toBe('2')
    expect(labelEl()).toBe('Count is 2')
    expect(doubledEl()).toBe('4')

    dispose()
  })

  it('keeps props reactive with destructuring default values', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Child({ count = 0, label = 'default' }) {
        return (
          <div>
            <span data-testid="count">{count}</span>
            <span data-testid="label">{label}</span>
          </div>
        )
      }

      function App() {
        let showLabel = $state(false)
        let count = $state(5)
        return (
          <div>
            <Child count={count} label={showLabel ? 'visible' : undefined} />
            <button data-testid="toggle" onClick={() => showLabel = !showLabel}>Toggle</button>
            <button data-testid="inc" onClick={() => count++}>Inc</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const countEl = () => container.querySelector('[data-testid="count"]')?.textContent
    const labelEl = () => container.querySelector('[data-testid="label"]')?.textContent
    const toggleBtn = () => container.querySelector('[data-testid="toggle"]') as HTMLButtonElement
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(countEl()).toBe('5')
    expect(labelEl()).toBe('default')

    incBtn().click()
    await tick()
    expect(countEl()).toBe('6')

    toggleBtn().click()
    await tick()
    expect(labelEl()).toBe('visible')

    dispose()
  })

  it('keeps props reactive with aliased destructuring', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Child({ count: myCount, label: myLabel }) {
        const doubled = myCount * 2
        return (
          <div>
            <span data-testid="count">{myCount}</span>
            <span data-testid="label">{myLabel}</span>
            <span data-testid="doubled">{doubled}</span>
          </div>
        )
      }

      function App() {
        let count = $state(0)
        return (
          <div>
            <Child count={count} label={"Value: " + count} />
            <button data-testid="inc" onClick={() => count++}>Inc</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const countEl = () => container.querySelector('[data-testid="count"]')?.textContent
    const labelEl = () => container.querySelector('[data-testid="label"]')?.textContent
    const doubledEl = () => container.querySelector('[data-testid="doubled"]')?.textContent
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(countEl()).toBe('0')
    expect(labelEl()).toBe('Value: 0')
    expect(doubledEl()).toBe('0')

    incBtn().click()
    await tick()
    expect(countEl()).toBe('1')
    expect(labelEl()).toBe('Value: 1')
    expect(doubledEl()).toBe('2')

    incBtn().click()
    await tick()
    expect(countEl()).toBe('2')
    expect(labelEl()).toBe('Value: 2')
    expect(doubledEl()).toBe('4')

    dispose()
  })

  it('keeps props reactive with rest spread and specific props', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Child({ id, ...rest }) {
        return (
          <div>
            <span data-testid="id">{id}</span>
            <span data-testid="label">{rest.label}</span>
            <span data-testid="count">{rest.count}</span>
          </div>
        )
      }

      function App() {
        let count = $state(0)
        return (
          <div>
            <Child id="item-1" label={"Count: " + count} count={count} />
            <button data-testid="inc" onClick={() => count++}>Inc</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const idEl = () => container.querySelector('[data-testid="id"]')?.textContent
    const labelEl = () => container.querySelector('[data-testid="label"]')?.textContent
    const countEl = () => container.querySelector('[data-testid="count"]')?.textContent
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(idEl()).toBe('item-1')
    expect(labelEl()).toBe('Count: 0')
    expect(countEl()).toBe('0')

    incBtn().click()
    await tick()
    expect(idEl()).toBe('item-1')
    expect(labelEl()).toBe('Count: 1')
    expect(countEl()).toBe('1')

    incBtn().click()
    await tick()
    expect(labelEl()).toBe('Count: 2')
    expect(countEl()).toBe('2')

    dispose()
  })

  it('keeps props reactive with nested object property access', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Child({ user }) {
        // Accessing nested properties from destructured prop
        const greeting = "Hello, " + user.name
        return (
          <div>
            <span data-testid="name">{user.name}</span>
            <span data-testid="age">{user.age}</span>
            <span data-testid="greeting">{greeting}</span>
          </div>
        )
      }

      function App() {
        let user = $state({ name: 'Alice', age: 25 })
        return (
          <div>
            <Child user={user} />
            <button data-testid="update" onClick={() => user = { name: 'Bob', age: 30 }}>Update</button>
            <button data-testid="inc-age" onClick={() => user = { ...user, age: user.age + 1 }}>Inc Age</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const nameEl = () => container.querySelector('[data-testid="name"]')?.textContent
    const ageEl = () => container.querySelector('[data-testid="age"]')?.textContent
    const greetingEl = () => container.querySelector('[data-testid="greeting"]')?.textContent
    const updateBtn = () => container.querySelector('[data-testid="update"]') as HTMLButtonElement
    const incAgeBtn = () => container.querySelector('[data-testid="inc-age"]') as HTMLButtonElement

    expect(nameEl()).toBe('Alice')
    expect(ageEl()).toBe('25')
    expect(greetingEl()).toBe('Hello, Alice')

    incAgeBtn().click()
    await tick()
    expect(nameEl()).toBe('Alice')
    expect(ageEl()).toBe('26')

    updateBtn().click()
    await tick()
    expect(nameEl()).toBe('Bob')
    expect(ageEl()).toBe('30')
    expect(greetingEl()).toBe('Hello, Bob')

    dispose()
  })

  it('keeps props reactive when destructuring function props used as event handlers', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Child({ count, onIncrement, onDecrement }) {
        return (
          <div>
            <span data-testid="count">{count}</span>
            <button data-testid="inc" onClick={onIncrement}>+</button>
            <button data-testid="dec" onClick={onDecrement}>-</button>
          </div>
        )
      }

      function App() {
        let count = $state(0)
        return (
          <Child
            count={count}
            onIncrement={() => count++}
            onDecrement={() => count--}
          />
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const countEl = () => container.querySelector('[data-testid="count"]')?.textContent
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement
    const decBtn = () => container.querySelector('[data-testid="dec"]') as HTMLButtonElement

    expect(countEl()).toBe('0')

    incBtn().click()
    await tick()
    expect(countEl()).toBe('1')

    incBtn().click()
    await tick()
    expect(countEl()).toBe('2')

    decBtn().click()
    await tick()
    expect(countEl()).toBe('1')

    dispose()
  })

  it('isolates context per render root (no state leakage across mounts)', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        const count = $state(0)
        return (
          <div>
            <p data-testid="count">Count: {count}</p>
            <button data-testid="inc" onClick={() => count++}>Inc</button>
          </div>
        )
      }

      export function mount(el) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)

    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.appendChild(containerA)
    document.body.appendChild(containerB)

    const disposeA = mod.mount(containerA)
    const disposeB = mod.mount(containerB)
    await tick()

    const countA = () => containerA.querySelector('[data-testid="count"]')!.textContent
    const countB = () => containerB.querySelector('[data-testid="count"]')!.textContent
    const incA = () =>
      (containerA.querySelector('[data-testid="inc"]') as HTMLButtonElement).click()
    const incB = () =>
      (containerB.querySelector('[data-testid="inc"]') as HTMLButtonElement).click()

    expect(countA()).toBe('Count: 0')
    expect(countB()).toBe('Count: 0')

    incA()
    await tick()
    expect(countA()).toBe('Count: 1')
    expect(countB()).toBe('Count: 0') // isolated

    incB()
    incB()
    await tick()
    expect(countA()).toBe('Count: 1')
    expect(countB()).toBe('Count: 2')

    disposeA()
    disposeB()
    containerA.remove()
    containerB.remove()
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

      function App() {
        let userId = $state(1)
        let userName = $state('Alicia')
        bump = () => {
          userId = 3
          userName = 'Charlie'
        }

        // Built once outside the render effect (compiler can't see inside the IIFE body)
        const payload = (() => ({ id: userId(), label: userName() }))()
        return <Row {...payload} />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
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

      function App() {
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
        return <Row {...payload} />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
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

      function App() {
        let count = $state(0)
        bump = () => { count = count + 1 }

        // Parent view does not read count directly; prop getter should keep child reactive
        return <Child value={prop(() => count())} />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
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

      function App() {
        let count = $state(0)
        const defaults = { extra: 'x' }
        bump = () => { count = count + 1 }

        // Built once outside render, so the plain value is a snapshot
        const snapshot = { count: count() }
        // Built once but with reactive getter
        const reactive = { count: prop(() => count()) }

        return (
          <>
            <Counter data-testid="naive" {...mergeProps(defaults, snapshot)} />
            <Counter data-testid="wrapped" {...mergeProps(defaults, reactive)} />
          </>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
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

      function App() {
        let count = $state(0)
        const onInc = () => count++

        return <Child value={heavy(count)} onInc={onInc} />
      }

      export function mount(el: HTMLElement) {
        getCallCount = () => callCount
        return render(() => <App />, el)
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

      function App() {
        let count = $state(0)
        return (
          <Child {...{ label: 'hello' }} {...{ count, onInc: () => count++ }} />
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
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

      function App() {
        let count = $state(1)
        bump = () => { count = count + 1 }

        const memo = useProp(() => {
          memoCalls++
          let acc = 0
          for (let i = 0; i < 2000; i++) acc += count + i
          return acc
        })

        return <Pair raw={heavy(count)} memo={memo} />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
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

      function App() {
        let theme = $state('light')
        let userName = $state('Alicia')
        bump = () => {
          theme = 'midnight'
          userName = 'Charlie'
        }

        return (
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
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
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

      export function Store() {
        let count = $state(0)
        const double = count * 2
        const inc = () => count++
        return (
          <div>
            <p data-testid="count">Count: {count}</p>
            <p data-testid="double">Double: {double}</p>
            <button data-testid="inc" onClick={inc}>Increment</button>
          </div>
        )
      }
    `

    const appSource = `
      import { render } from 'fict'
      import { Store } from './store'

      function App() {
        return <Store />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const storeModule = compileAndLoad<{
      Store: () => { count: () => number; double: () => number; inc: () => void }
    }>(storeSource)
    const app = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(appSource, {
      './store': storeModule,
    })

    const dispose = app.mount(container)
    await tick()
    if (process.env.DEBUG_TEMPLATE_OUTPUT) {
      // eslint-disable-next-line no-console
      console.warn('CROSS MODULE HTML\n', container.outerHTML)
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

  it('supports $store fine-grained updates across nested objects', async () => {
    const source = `
      import { render } from 'fict'
      import { $store } from 'fict/plus'

      let user = $store({ name: 'Alice', address: { city: 'London' } })

      export function mount(el: HTMLElement) {
        return render(() => (
          <div>
            <p data-testid="name">{user.name}</p>
            <p data-testid="city">{user.address.city}</p>
            <button data-testid="mutate" onClick={() => { user.address.city = 'Paris' }}>Update</button>
          </div>
        ), el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const nameEl = () => container.querySelector('[data-testid="name"]')!.textContent
    const cityEl = () => container.querySelector('[data-testid="city"]')!.textContent
    const btn = () => container.querySelector('[data-testid="mutate"]') as HTMLButtonElement

    expect(nameEl()).toBe('Alice')
    expect(cityEl()).toBe('London')

    btn().click()
    await tick()
    expect(nameEl()).toBe('Alice')
    expect(cityEl()).toBe('Paris')

    dispose()
  })

  it('keeps $store dynamic property access reactive across keys and mutations', async () => {
    const source = `
      import { $state, render } from 'fict'
      import { $store } from 'fict/plus'

      function App() {
        let key = $state('a')
        const store = $store({ map: { a: 1, b: 2 } })

        const swap = () => { key = key === 'a' ? 'b' : 'a' }
        const bumpA = () => { store.map.a = store.map.a + 1 }

        return (
          <div>
            <p data-testid="value">{store.map[key]}</p>
            <button data-testid="swap" onClick={swap}>Swap</button>
            <button data-testid="inc-a" onClick={bumpA}>Inc A</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const read = () => container.querySelector('[data-testid="value"]')?.textContent
    const swap = container.querySelector('[data-testid="swap"]') as HTMLButtonElement
    const incA = container.querySelector('[data-testid="inc-a"]') as HTMLButtonElement

    expect(read()).toBe('1')

    incA.click()
    await tick()
    expect(read()).toBe('2')

    swap.click()
    await tick()
    expect(read()).toBe('2')

    swap.click()
    await tick()
    expect(read()).toBe('2')

    incA.click()
    await tick()
    expect(read()).toBe('3')

    dispose()
  })

  it('handles component children and events without [object Object] leakage', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Button(props) {
        return <button data-testid="btn" onClick={props.onClick}>{props.label}</button>
      }

      function App() {
        let count = $state(0)
        return (
          <div>
            <Button label="Add Row" onClick={() => count++} />
            <p data-testid="count">Count: {count}</p>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const btn = container.querySelector('[data-testid="btn"]') as HTMLButtonElement
    expect(btn?.textContent).toBe('Add Row')
    expect(container.textContent?.includes('[object Object]')).toBe(false)
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('Count: 0')

    btn.click()
    await tick()
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('Count: 1')

    dispose()
  })

  it('runs the keyed example end to end', async () => {
    const counterBasicSource = `
      import { $effect, $state, render } from 'fict'

      const adjectives = [
        'pretty',
        'large',
        'big',
        'small',
        'tall',
        'short',
        'long',
        'handsome',
        'plain',
        'quaint',
        'clean',
        'elegant',
        'easy',
        'angry',
        'crazy',
        'helpful',
        'mushy',
        'odd',
        'unsightly',
        'adorable',
        'important',
        'inexpensive',
        'cheap',
        'expensive',
        'fancy',
      ]

      const colours = [
        'red',
        'yellow',
        'blue',
        'green',
        'pink',
        'brown',
        'purple',
        'brown',
        'white',
        'black',
        'orange',
      ]

      const nouns = [
        'table',
        'chair',
        'house',
        'bbq',
        'desk',
        'car',
        'pony',
        'cookie',
        'sandwich',
        'burger',
        'pizza',
        'mouse',
        'keyboard',
      ]

      let nextId = 1
      function random(max: number) {
        return Math.round(Math.random() * 1000) % max
      }

      function buildData(count: number) {
        const data = new Array(count)
        for (let i = 0; i < count; i++) {
          data[i] = {
            id: nextId++,
            label: \`\${adjectives[random(adjectives.length)]} \${colours[random(colours.length)]} \${nouns[random(nouns.length)]}\`,
          }
        }
        return data
      }

      function Button(props: any) {
        return (
          <div class="col-sm-6 smallpad">
            <button id={props.id} class="btn btn-primary btn-block" type="button" onClick={props.onClick}>
              {props.text}
            </button>
          </div>
        )
      }

      function App() {
        let data: { id: number; label: string }[] = $state([])
        let selected: number | null = $state(null)

        const run = () => {
          data = buildData(10)
          selected = null
        }

        const runLots = () => {
          data = buildData(100)
          selected = null
        }

        const add = () => {
          data = [...data, ...buildData(10)]
        }

        const update = () => {
          data = data.map((row, i) => (i % 3 === 0 ? { ...row, label: row.label + ' !!!' } : row))
        }

        const swapRows = () => {
          const list = data
          if (list.length < 3) return
          const copy = list.slice()
          const last = copy.length - 1
          const tmp = copy[1]
          copy[1] = copy[last]
          copy[last] = tmp
          data = copy
        }

        const clear = () => {
          data = []
          selected = null
        }

        const remove = (id: number) => {
          data = data.filter(row => row.id !== id)
          if (selected === id) {
            selected = null
          }
        }

        const select = (id: number) => {
          selected = id
        }

        $effect(() => {
          console.log('data', data)
        })

        return (
          <div class="container">
            <div class="jumbotron">
              <div class="row">
                <div class="col-md-6">
                  <h1>Fict Keyed</h1>
                </div>
                <div class="col-md-6">
                  <div class="row">
                    <Button id="run" text="Create 1,0 rows" onClick={run} />
                    <Button id="runlots" text="Create 10,0 rows" onClick={runLots} />
                    <Button id="add" text="Append 1,0 rows" onClick={add} />
                    <Button id="update" text="Update every 1th row" onClick={update} />
                    <Button id="clear" text="Clear" onClick={clear} />
                    <Button id="swaprows" text="Swap Rows" onClick={swapRows} />
                  </div>
                </div>
              </div>
            </div>
            <table class="table table-hover table-striped test-data">
              <tbody>
                {data.map(row => (
                  <tr key={row.id} class={selected === row.id ? 'danger' : ''}>
                    <td class="col-md-1">{row.id}</td>
                    <td class="col-md-4">
                      <a onClick={() => select(row.id)}>{row.label}</a>
                    </td>
                    <td class="col-md-1">
                      <a onClick={() => remove(row.id)}>
                        <span class="glyphicon glyphicon-remove" aria-hidden="true"></span>
                      </a>
                    </td>
                    <td class="col-md-6"></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>
          </div>
        )
      }

      const app = document.getElementById('app')
      if (app) {
        render(() => <App />, app)
      }

      export default App
      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(counterBasicSource)
    const dispose = mod.mount(container)
    await tick()

    const runBtn = container.querySelector('#run') as HTMLButtonElement
    const runLotsBtn = container.querySelector('#runlots') as HTMLButtonElement
    const addBtn = container.querySelector('#add') as HTMLButtonElement
    const updateBtn = container.querySelector('#update') as HTMLButtonElement
    const clearBtn = container.querySelector('#clear') as HTMLButtonElement
    const swapRowsBtn = container.querySelector('#swaprows') as HTMLButtonElement

    const rows = () => Array.from(container.querySelectorAll('tbody tr')) as HTMLTableRowElement[]
    const rowInfo = (row: HTMLTableRowElement) => ({
      id: row.querySelector('.col-md-1')?.textContent,
      label: row.querySelector('.col-md-4 a')?.textContent,
      selected: row.classList.contains('danger'),
    })
    const lastLoggedLength = () =>
      logSpy.mock.calls.length
        ? ((logSpy.mock.calls[logSpy.mock.calls.length - 1][1] as any[])?.length ?? null)
        : null

    expect(rows().length).toBe(0)

    runBtn.click()
    await tick()
    expect(rows().length).toBe(10)
    expect(rowInfo(rows()[0]).id).toBe('1')
    expect(rowInfo(rows()[0]).label).toBe('pretty red table')
    expect(lastLoggedLength()).toBe(10)

    const secondRowLabel = rows()[1].querySelector('.col-md-4 a') as HTMLAnchorElement
    secondRowLabel.click()
    await tick()
    expect(rowInfo(rows()[1]).selected).toBe(true)
    expect(rowInfo(rows()[0]).selected).toBe(false)

    const removeLink = rows()[1].querySelectorAll('a')[1] as HTMLAnchorElement
    removeLink.click()
    await tick()
    expect(rows().length).toBe(9)
    expect(rows().some(r => r.classList.contains('danger'))).toBe(false)

    addBtn.click()
    await tick()
    expect(rows().length).toBe(19)
    expect(lastLoggedLength()).toBe(19)

    updateBtn.click()
    await tick()
    expect(rowInfo(rows()[0]).label).toBe('pretty red table !!!')
    expect(rowInfo(rows()[1]).label).toBe('pretty red table')

    swapRowsBtn.click()
    await tick()
    expect(rowInfo(rows()[1]).id).toBe('20')
    expect(rowInfo(rows()[rows().length - 1]).id).toBe('3')

    runLotsBtn.click()
    await tick()
    expect(rows().length).toBe(100)
    expect(rowInfo(rows()[0]).id).toBe('21')
    expect(rows().some(r => r.classList.contains('danger'))).toBe(false)
    expect(lastLoggedLength()).toBe(100)

    clearBtn.click()
    await tick()
    expect(rows().length).toBe(0)
    expect(lastLoggedLength()).toBe(0)

    dispose()
    randomSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('runs the non-keyed example end to end', async () => {
    const counterBasicSource = `
      import { $effect, $state, render } from 'fict'

      const adjectives = [
        'pretty',
        'large',
        'big',
        'small',
        'tall',
        'short',
        'long',
        'handsome',
        'plain',
        'quaint',
        'clean',
        'elegant',
        'easy',
        'angry',
        'crazy',
        'helpful',
        'mushy',
        'odd',
        'unsightly',
        'adorable',
        'important',
        'inexpensive',
        'cheap',
        'expensive',
        'fancy',
      ]

      const colours = [
        'red',
        'yellow',
        'blue',
        'green',
        'pink',
        'brown',
        'purple',
        'brown',
        'white',
        'black',
        'orange',
      ]

      const nouns = [
        'table',
        'chair',
        'house',
        'bbq',
        'desk',
        'car',
        'pony',
        'cookie',
        'sandwich',
        'burger',
        'pizza',
        'mouse',
        'keyboard',
      ]

      let nextId = 1
      function random(max: number) {
        return Math.round(Math.random() * 1000) % max
      }

      function buildData(count: number) {
        const data = new Array(count)
        for (let i = 0; i < count; i++) {
          data[i] = {
            id: nextId++,
            label: \`\${adjectives[random(adjectives.length)]} \${colours[random(colours.length)]} \${nouns[random(nouns.length)]}\`,
          }
        }
        return data
      }

      function Button(props: any) {
        return (
          <div class="col-sm-6 smallpad">
            <button id={props.id} class="btn btn-primary btn-block" type="button" onClick={props.onClick}>
              {props.text}
            </button>
          </div>
        )
      }

      function App() {
        let data: { id: number; label: string }[] = $state([])
        let selected: number | null = $state(null)

        const run = () => {
          data = buildData(10)
          selected = null
        }

        const runLots = () => {
          data = buildData(100)
          selected = null
        }

        const add = () => {
          data = [...data, ...buildData(10)]
        }

        const update = () => {
          data = data.map((row, i) => (i % 3 === 0 ? { ...row, label: row.label + ' !!!' } : row))
        }

        const swapRows = () => {
          const list = data
          if (list.length < 3) return
          const copy = list.slice()
          const last = copy.length - 1
          const tmp = copy[1]
          copy[1] = copy[last]
          copy[last] = tmp
          data = copy
        }

        const clear = () => {
          data = []
          selected = null
        }

        const remove = (id: number) => {
          data = data.filter(row => row.id !== id)
          if (selected === id) {
            selected = null
          }
        }

        const select = (id: number) => {
          selected = id
        }

        $effect(() => {
          console.log('data', data)
        })

        return (
          <div class="container">
            <div class="jumbotron">
              <div class="row">
                <div class="col-md-6">
                  <h1>Fict Keyed</h1>
                </div>
                <div class="col-md-6">
                  <div class="row">
                    <Button id="run" text="Create 1,0 rows" onClick={run} />
                    <Button id="runlots" text="Create 10,0 rows" onClick={runLots} />
                    <Button id="add" text="Append 1,0 rows" onClick={add} />
                    <Button id="update" text="Update every 1th row" onClick={update} />
                    <Button id="clear" text="Clear" onClick={clear} />
                    <Button id="swaprows" text="Swap Rows" onClick={swapRows} />
                  </div>
                </div>
              </div>
            </div>
            <table class="table table-hover table-striped test-data">
              <tbody>
                {data.map(row => (
                  <tr class={selected === row.id ? 'danger' : ''}>
                    <td class="col-md-1">{row.id}</td>
                    <td class="col-md-4">
                      <a onClick={() => select(row.id)}>{row.label}</a>
                    </td>
                    <td class="col-md-1">
                      <a onClick={() => remove(row.id)}>
                        <span class="glyphicon glyphicon-remove" aria-hidden="true"></span>
                      </a>
                    </td>
                    <td class="col-md-6"></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>
          </div>
        )
      }

      const app = document.getElementById('app')
      if (app) {
        render(() => <App />, app)
      }

      export default App
      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(counterBasicSource)
    const dispose = mod.mount(container)
    await tick()

    const runBtn = container.querySelector('#run') as HTMLButtonElement
    const runLotsBtn = container.querySelector('#runlots') as HTMLButtonElement
    const addBtn = container.querySelector('#add') as HTMLButtonElement
    const updateBtn = container.querySelector('#update') as HTMLButtonElement
    const clearBtn = container.querySelector('#clear') as HTMLButtonElement
    const swapRowsBtn = container.querySelector('#swaprows') as HTMLButtonElement

    const rows = () => Array.from(container.querySelectorAll('tbody tr')) as HTMLTableRowElement[]
    const rowInfo = (row: HTMLTableRowElement) => ({
      id: row.querySelector('.col-md-1')?.textContent,
      label: row.querySelector('.col-md-4 a')?.textContent,
      selected: row.classList.contains('danger'),
    })
    const lastLoggedLength = () =>
      logSpy.mock.calls.length
        ? ((logSpy.mock.calls[logSpy.mock.calls.length - 1][1] as any[])?.length ?? null)
        : null

    expect(rows().length).toBe(0)

    runBtn.click()
    await tick()
    expect(rows().length).toBe(10)
    expect(rowInfo(rows()[0]).id).toBe('1')
    expect(rowInfo(rows()[0]).label).toBe('pretty red table')
    expect(lastLoggedLength()).toBe(10)

    const secondRowLabel = rows()[1].querySelector('.col-md-4 a') as HTMLAnchorElement
    secondRowLabel.click()
    await tick()
    expect(rowInfo(rows()[1]).selected).toBe(true)
    expect(rowInfo(rows()[0]).selected).toBe(false)

    const removeLink = rows()[1].querySelectorAll('a')[1] as HTMLAnchorElement
    removeLink.click()
    await tick()
    expect(rows().length).toBe(9)
    expect(rows().some(r => r.classList.contains('danger'))).toBe(false)

    addBtn.click()
    await tick()
    expect(rows().length).toBe(19)
    expect(lastLoggedLength()).toBe(19)

    updateBtn.click()
    await tick()
    expect(rowInfo(rows()[0]).label).toBe('pretty red table !!!')
    expect(rowInfo(rows()[1]).label).toBe('pretty red table')

    swapRowsBtn.click()
    await tick()
    expect(rowInfo(rows()[1]).id).toBe('20')
    expect(rowInfo(rows()[rows().length - 1]).id).toBe('3')

    runLotsBtn.click()
    await tick()
    expect(rows().length).toBe(100)
    expect(rowInfo(rows()[0]).id).toBe('21')
    expect(rows().some(r => r.classList.contains('danger'))).toBe(false)
    expect(lastLoggedLength()).toBe(100)

    clearBtn.click()
    await tick()
    expect(rows().length).toBe(0)
    expect(lastLoggedLength()).toBe(0)

    dispose()
    randomSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('cross-component fine-grained updates only affect dependent DOM nodes', async () => {
    const source = `
      import { $state, render, prop } from 'fict'

      // Track render counts for each component/section
      export let parentRenderCount = 0
      export let childARenderCount = 0
      export let childBRenderCount = 0
      export let nameUpdateCount = 0
      export let ageUpdateCount = 0

      function ChildA(props: any) {
        childARenderCount++
        return (
          <div data-testid="child-a">
            <span data-testid="name" ref={(el) => { nameUpdateCount++ }}>{props.name}</span>
            <span data-testid="age" ref={(el) => { ageUpdateCount++ }}>{props.age}</span>
            <span data-testid="static-a">Static Content A</span>
          </div>
        )
      }

      function ChildB(props: any) {
        childBRenderCount++
        return (
          <div data-testid="child-b">
            <span data-testid="count">{props.count}</span>
            <span data-testid="static-b">Static Content B</span>
          </div>
        )
      }

      function Parent() {
        parentRenderCount++
        let name = $state('Alice')
        let age = $state(25)
        let count = $state(0)

        return (
          <div>
            <ChildA name={prop(() => name)} age={prop(() => age)} />
            <ChildB count={prop(() => count)} />
            <button data-testid="update-name" onClick={() => name = 'Bob'}>Update Name</button>
            <button data-testid="update-age" onClick={() => age++}>Update Age</button>
            <button data-testid="update-count" onClick={() => count++}>Update Count</button>
            <button data-testid="update-all" onClick={() => { name = 'Charlie'; age = 30; count = 100 }}>Update All</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Parent />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      parentRenderCount: number
      childARenderCount: number
      childBRenderCount: number
      nameUpdateCount: number
      ageUpdateCount: number
    }>(source)

    const dispose = mod.mount(container)
    await tick()

    // Initial render assertions
    expect(container.querySelector('[data-testid="name"]')?.textContent).toBe('Alice')
    expect(container.querySelector('[data-testid="age"]')?.textContent).toBe('25')
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('0')
    expect(container.querySelector('[data-testid="static-a"]')?.textContent).toBe(
      'Static Content A',
    )
    expect(container.querySelector('[data-testid="static-b"]')?.textContent).toBe(
      'Static Content B',
    )

    // Record initial render counts
    const initialParent = mod.parentRenderCount
    const initialChildA = mod.childARenderCount
    const initialChildB = mod.childBRenderCount
    const initialNameUpdate = mod.nameUpdateCount
    const initialAgeUpdate = mod.ageUpdateCount

    // Update only name - should only affect the name span, not age or count
    const updateNameBtn = container.querySelector(
      '[data-testid="update-name"]',
    ) as HTMLButtonElement
    updateNameBtn.click()
    await tick()

    expect(container.querySelector('[data-testid="name"]')?.textContent).toBe('Bob')
    expect(container.querySelector('[data-testid="age"]')?.textContent).toBe('25') // unchanged
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('0') // unchanged

    // Parent should not re-render, only the reactive binding updates
    expect(mod.parentRenderCount).toBe(initialParent)
    // Child components should not fully re-render (fine-grained update)
    expect(mod.childARenderCount).toBe(initialChildA)
    expect(mod.childBRenderCount).toBe(initialChildB)

    // Update age - should only affect the age span
    const updateAgeBtn = container.querySelector('[data-testid="update-age"]') as HTMLButtonElement
    updateAgeBtn.click()
    await tick()

    expect(container.querySelector('[data-testid="name"]')?.textContent).toBe('Bob') // unchanged
    expect(container.querySelector('[data-testid="age"]')?.textContent).toBe('26')
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('0') // unchanged

    expect(mod.parentRenderCount).toBe(initialParent)
    expect(mod.childARenderCount).toBe(initialChildA)
    expect(mod.childBRenderCount).toBe(initialChildB)

    // Update count - should only affect ChildB, not ChildA
    const updateCountBtn = container.querySelector(
      '[data-testid="update-count"]',
    ) as HTMLButtonElement
    updateCountBtn.click()
    await tick()

    expect(container.querySelector('[data-testid="name"]')?.textContent).toBe('Bob') // unchanged
    expect(container.querySelector('[data-testid="age"]')?.textContent).toBe('26') // unchanged
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1')

    expect(mod.parentRenderCount).toBe(initialParent)
    expect(mod.childARenderCount).toBe(initialChildA)
    expect(mod.childBRenderCount).toBe(initialChildB)

    // Update all at once - all values should change but components should not re-render
    const updateAllBtn = container.querySelector('[data-testid="update-all"]') as HTMLButtonElement
    updateAllBtn.click()
    await tick()

    expect(container.querySelector('[data-testid="name"]')?.textContent).toBe('Charlie')
    expect(container.querySelector('[data-testid="age"]')?.textContent).toBe('30')
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('100')

    // Still no component re-renders, only fine-grained DOM updates
    expect(mod.parentRenderCount).toBe(initialParent)
    expect(mod.childARenderCount).toBe(initialChildA)
    expect(mod.childBRenderCount).toBe(initialChildB)

    // Static content should never change
    expect(container.querySelector('[data-testid="static-a"]')?.textContent).toBe(
      'Static Content A',
    )
    expect(container.querySelector('[data-testid="static-b"]')?.textContent).toBe(
      'Static Content B',
    )

    dispose()
  })

  it('cross-component fine-grained updates with derived values', async () => {
    const source = `
      import { $state, $memo, render, prop } from 'fict'

      export let computeCount = 0
      export let childRenderCount = 0

      function Display(props: any) {
        childRenderCount++
        return <span data-testid="display">{props.value}</span>
      }

      function App() {
        let firstName = $state('John')
        let lastName = $state('Doe')

        const fullName = $memo(() => {
          computeCount++
          return firstName + ' ' + lastName
        })

        return (
          <div>
            <Display value={prop(() => fullName())} />
            <p data-testid="first">{firstName}</p>
            <p data-testid="last">{lastName}</p>
            <button data-testid="update-first" onClick={() => firstName = 'Jane'}>Update First</button>
            <button data-testid="update-last" onClick={() => lastName = 'Smith'}>Update Last</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      computeCount: number
      childRenderCount: number
    }>(source)

    const dispose = mod.mount(container)
    await tick()

    expect(container.querySelector('[data-testid="display"]')?.textContent).toBe('John Doe')
    expect(container.querySelector('[data-testid="first"]')?.textContent).toBe('John')
    expect(container.querySelector('[data-testid="last"]')?.textContent).toBe('Doe')

    const initialComputeCount = mod.computeCount
    const initialChildRender = mod.childRenderCount

    // Update firstName
    const updateFirstBtn = container.querySelector(
      '[data-testid="update-first"]',
    ) as HTMLButtonElement
    updateFirstBtn.click()
    await tick()

    expect(container.querySelector('[data-testid="display"]')?.textContent).toBe('Jane Doe')
    expect(container.querySelector('[data-testid="first"]')?.textContent).toBe('Jane')
    expect(container.querySelector('[data-testid="last"]')?.textContent).toBe('Doe')

    // Derived value should be recomputed
    expect(mod.computeCount).toBeGreaterThan(initialComputeCount)
    // But child component should not re-render
    expect(mod.childRenderCount).toBe(initialChildRender)

    const afterFirstUpdateCompute = mod.computeCount

    // Update lastName
    const updateLastBtn = container.querySelector(
      '[data-testid="update-last"]',
    ) as HTMLButtonElement
    updateLastBtn.click()
    await tick()

    expect(container.querySelector('[data-testid="display"]')?.textContent).toBe('Jane Smith')
    expect(container.querySelector('[data-testid="first"]')?.textContent).toBe('Jane')
    expect(container.querySelector('[data-testid="last"]')?.textContent).toBe('Smith')

    expect(mod.computeCount).toBeGreaterThan(afterFirstUpdateCompute)
    expect(mod.childRenderCount).toBe(initialChildRender)

    dispose()
  })

  it('cross-component fine-grained updates with list items', async () => {
    const source = `
      import { $state, render, prop } from 'fict'

      export let itemRenderCounts: Record<string, number> = {}

      function ListItem(props: any) {
        itemRenderCounts[props.id] = (itemRenderCounts[props.id] || 0) + 1
        return (
          <li
            data-testid={\`item-\${props.id}\`}
            class={props.selected ? 'selected' : ''}
          >
            {props.label}
          </li>
        )
      }

      function App() {
        let items = $state([
          { id: '1', label: 'Item 1' },
          { id: '2', label: 'Item 2' },
          { id: '3', label: 'Item 3' },
        ])
        let selectedId = $state<string | null>(null)

        const updateItem = (id: string, newLabel: string) => {
          items = items.map(item =>
            item.id === id ? { ...item, label: newLabel } : item
          )
        }

        return (
          <div>
            <ul data-testid="list">
              {items.map(item => (
                <ListItem
                  key={item.id}
                  id={item.id}
                  label={prop(() => item.label)}
                  selected={prop(() => selectedId === item.id)}
                />
              ))}
            </ul>
            <button data-testid="select-1" onClick={() => selectedId = '1'}>Select 1</button>
            <button data-testid="select-2" onClick={() => selectedId = '2'}>Select 2</button>
            <button data-testid="update-1" onClick={() => updateItem('1', 'Updated Item 1')}>Update 1</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      itemRenderCounts: Record<string, number>
    }>(source)

    const dispose = mod.mount(container)
    await tick()

    // Initial render
    expect(container.querySelector('[data-testid="item-1"]')?.textContent).toBe('Item 1')
    expect(container.querySelector('[data-testid="item-2"]')?.textContent).toBe('Item 2')
    expect(container.querySelector('[data-testid="item-3"]')?.textContent).toBe('Item 3')

    const initialRenderCounts = { ...mod.itemRenderCounts }

    // Select item 1 - should update only the selected state
    const select1Btn = container.querySelector('[data-testid="select-1"]') as HTMLButtonElement
    select1Btn.click()
    await tick()

    expect(container.querySelector('[data-testid="item-1"]')?.className).toBe('selected')
    expect(container.querySelector('[data-testid="item-2"]')?.className).toBe('')
    expect(container.querySelector('[data-testid="item-3"]')?.className).toBe('')

    // Select item 2 - item 1 should deselect, item 2 should select
    const select2Btn = container.querySelector('[data-testid="select-2"]') as HTMLButtonElement
    select2Btn.click()
    await tick()

    expect(container.querySelector('[data-testid="item-1"]')?.className).toBe('')
    expect(container.querySelector('[data-testid="item-2"]')?.className).toBe('selected')
    expect(container.querySelector('[data-testid="item-3"]')?.className).toBe('')

    // Update item 1's label - only item 1's text should change
    const update1Btn = container.querySelector('[data-testid="update-1"]') as HTMLButtonElement
    update1Btn.click()
    await tick()

    expect(container.querySelector('[data-testid="item-1"]')?.textContent).toBe('Updated Item 1')
    expect(container.querySelector('[data-testid="item-2"]')?.textContent).toBe('Item 2')
    expect(container.querySelector('[data-testid="item-3"]')?.textContent).toBe('Item 3')

    dispose()
  })

  it('handles ternary expression for conditional rendering', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let isLoggedIn = $state(false)
        let userName = $state('Guest')

        return (
          <div>
            <span data-testid="greeting">
              {isLoggedIn ? \`Welcome, \${userName}!\` : 'Please log in'}
            </span>
            <button data-testid="toggle" onClick={() => isLoggedIn = !isLoggedIn}>
              Toggle
            </button>
            <button data-testid="change-name" onClick={() => userName = 'Alice'}>
              Change Name
            </button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const greeting = () => container.querySelector('[data-testid="greeting"]')?.textContent
    const toggleBtn = () => container.querySelector('[data-testid="toggle"]') as HTMLButtonElement
    const changeNameBtn = () =>
      container.querySelector('[data-testid="change-name"]') as HTMLButtonElement

    expect(greeting()).toBe('Please log in')

    toggleBtn().click()
    await tick()
    expect(greeting()).toBe('Welcome, Guest!')

    changeNameBtn().click()
    await tick()
    expect(greeting()).toBe('Welcome, Alice!')

    toggleBtn().click()
    await tick()
    expect(greeting()).toBe('Please log in')

    dispose()
  })

  it('handles nested ternary expressions', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let status = $state<'idle' | 'loading' | 'success' | 'error'>('idle')

        return (
          <div>
            <span data-testid="status">
              {status === 'idle' ? 'Ready'
                : status === 'loading' ? 'Loading...'
                : status === 'success' ? 'Success!'
                : 'Error occurred'}
            </span>
            <button data-testid="load" onClick={() => status = 'loading'}>Load</button>
            <button data-testid="success" onClick={() => status = 'success'}>Success</button>
            <button data-testid="error" onClick={() => status = 'error'}>Error</button>
            <button data-testid="reset" onClick={() => status = 'idle'}>Reset</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const status = () => container.querySelector('[data-testid="status"]')?.textContent

    expect(status()).toBe('Ready')
    ;(container.querySelector('[data-testid="load"]') as HTMLButtonElement).click()
    await tick()
    expect(status()).toBe('Loading...')
    ;(container.querySelector('[data-testid="success"]') as HTMLButtonElement).click()
    await tick()
    expect(status()).toBe('Success!')
    ;(container.querySelector('[data-testid="error"]') as HTMLButtonElement).click()
    await tick()
    expect(status()).toBe('Error occurred')
    ;(container.querySelector('[data-testid="reset"]') as HTMLButtonElement).click()
    await tick()
    expect(status()).toBe('Ready')

    dispose()
  })

  it('handles logical AND short-circuit rendering', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let showDetails = $state(false)
        let count = $state(0)

        return (
          <div>
            <button data-testid="toggle" onClick={() => showDetails = !showDetails}>Toggle</button>
            <button data-testid="inc" onClick={() => count++}>Inc</button>
            {showDetails && <div data-testid="details">Count is: {count}</div>}
            {count > 0 && <div data-testid="positive">Count is positive</div>}
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const details = () => container.querySelector('[data-testid="details"]')
    const positive = () => container.querySelector('[data-testid="positive"]')
    const toggleBtn = () => container.querySelector('[data-testid="toggle"]') as HTMLButtonElement
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    expect(details()).toBeNull()
    expect(positive()).toBeNull()

    toggleBtn().click()
    await tick()
    expect(details()?.textContent).toBe('Count is: 0')
    expect(positive()).toBeNull()

    incBtn().click()
    await tick()
    expect(details()?.textContent).toBe('Count is: 1')
    expect(positive()?.textContent).toBe('Count is positive')

    toggleBtn().click()
    await tick()
    expect(details()).toBeNull()
    expect(positive()?.textContent).toBe('Count is positive')

    dispose()
  })

  it('handles logical OR for default values', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let name = $state('')
        let title = $state<string | null>(null)

        return (
          <div>
            <span data-testid="name">{name || 'Anonymous'}</span>
            <span data-testid="title">{title || 'No Title'}</span>
            <button data-testid="set-name" onClick={() => name = 'John'}>Set Name</button>
            <button data-testid="set-title" onClick={() => title = 'Developer'}>Set Title</button>
            <button data-testid="clear" onClick={() => { name = ''; title = null }}>Clear</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const name = () => container.querySelector('[data-testid="name"]')?.textContent
    const title = () => container.querySelector('[data-testid="title"]')?.textContent

    expect(name()).toBe('Anonymous')
    expect(title()).toBe('No Title')
    ;(container.querySelector('[data-testid="set-name"]') as HTMLButtonElement).click()
    await tick()
    expect(name()).toBe('John')
    expect(title()).toBe('No Title')
    ;(container.querySelector('[data-testid="set-title"]') as HTMLButtonElement).click()
    await tick()
    expect(name()).toBe('John')
    expect(title()).toBe('Developer')
    ;(container.querySelector('[data-testid="clear"]') as HTMLButtonElement).click()
    await tick()
    expect(name()).toBe('Anonymous')
    expect(title()).toBe('No Title')

    dispose()
  })

  it('handles nullish coalescing operator in JSX', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let value = $state<number | null | undefined>(null)
        let text = $state<string | undefined>(undefined)

        return (
          <div>
            <span data-testid="value">{value ?? 'N/A'}</span>
            <span data-testid="text">{text ?? 'Default Text'}</span>
            <button data-testid="set-zero" onClick={() => value = 0}>Set Zero</button>
            <button data-testid="set-empty" onClick={() => text = ''}>Set Empty</button>
            <button data-testid="set-values" onClick={() => { value = 42; text = 'Hello' }}>Set Values</button>
            <button data-testid="clear" onClick={() => { value = null; text = undefined }}>Clear</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const value = () => container.querySelector('[data-testid="value"]')?.textContent
    const text = () => container.querySelector('[data-testid="text"]')?.textContent

    expect(value()).toBe('N/A')
    expect(text()).toBe('Default Text')

    // ?? preserves falsy values like 0 and ''
    ;(container.querySelector('[data-testid="set-zero"]') as HTMLButtonElement).click()
    await tick()
    expect(value()).toBe('0')
    ;(container.querySelector('[data-testid="set-empty"]') as HTMLButtonElement).click()
    await tick()
    expect(text()).toBe('')
    ;(container.querySelector('[data-testid="set-values"]') as HTMLButtonElement).click()
    await tick()
    expect(value()).toBe('42')
    expect(text()).toBe('Hello')
    ;(container.querySelector('[data-testid="clear"]') as HTMLButtonElement).click()
    await tick()
    expect(value()).toBe('N/A')
    expect(text()).toBe('Default Text')

    dispose()
  })

  it('handles if-else-if chain (switch-like pattern)', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let score = $state(0)

        const getGrade = () => {
          if (score >= 90) return 'A'
          else if (score >= 80) return 'B'
          else if (score >= 70) return 'C'
          else if (score >= 60) return 'D'
          else return 'F'
        }

        const getColor = () => {
          if (score >= 90) return 'green'
          else if (score >= 70) return 'blue'
          else if (score >= 60) return 'orange'
          else return 'red'
        }

        return (
          <div>
            <span data-testid="score">Score: {score}</span>
            <span data-testid="grade" style={{ color: getColor() }}>Grade: {getGrade()}</span>
            <button data-testid="set-95" onClick={() => score = 95}>95</button>
            <button data-testid="set-85" onClick={() => score = 85}>85</button>
            <button data-testid="set-75" onClick={() => score = 75}>75</button>
            <button data-testid="set-65" onClick={() => score = 65}>65</button>
            <button data-testid="set-50" onClick={() => score = 50}>50</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const score = () => container.querySelector('[data-testid="score"]')?.textContent
    const grade = () => container.querySelector('[data-testid="grade"]')?.textContent
    const gradeColor = () =>
      (container.querySelector('[data-testid="grade"]') as HTMLElement)?.style.color

    expect(score()).toBe('Score: 0')
    expect(grade()).toBe('Grade: F')
    expect(gradeColor()).toBe('red')
    ;(container.querySelector('[data-testid="set-95"]') as HTMLButtonElement).click()
    await tick()
    expect(grade()).toBe('Grade: A')
    expect(gradeColor()).toBe('green')
    ;(container.querySelector('[data-testid="set-85"]') as HTMLButtonElement).click()
    await tick()
    expect(grade()).toBe('Grade: B')
    expect(gradeColor()).toBe('blue')
    ;(container.querySelector('[data-testid="set-75"]') as HTMLButtonElement).click()
    await tick()
    expect(grade()).toBe('Grade: C')
    expect(gradeColor()).toBe('blue')
    ;(container.querySelector('[data-testid="set-65"]') as HTMLButtonElement).click()
    await tick()
    expect(grade()).toBe('Grade: D')
    expect(gradeColor()).toBe('orange')
    ;(container.querySelector('[data-testid="set-50"]') as HTMLButtonElement).click()
    await tick()
    expect(grade()).toBe('Grade: F')
    expect(gradeColor()).toBe('red')

    dispose()
  })

  it('handles early return with side effect cleanup', async () => {
    const source = `
      import { $state, $effect, render } from 'fict'

      export let effectRunCount = 0
      export let cleanupCount = 0

      function App() {
        let isEnabled = $state(true)
        let count = $state(0)

        if (!isEnabled) {
          return <div data-testid="disabled">Feature is disabled</div>
        }

        $effect(() => {
          effectRunCount++
          console.log('Effect running with count:', count)
          return () => {
            cleanupCount++
            console.log('Cleanup running')
          }
        })

        return (
          <div data-testid="enabled">
            <span data-testid="count">Count: {count}</span>
            <button data-testid="inc" onClick={() => count++}>Inc</button>
            <button data-testid="disable" onClick={() => isEnabled = false}>Disable</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      effectRunCount: number
      cleanupCount: number
    }>(source)

    const dispose = mod.mount(container)
    await tick()

    const enabled = () => container.querySelector('[data-testid="enabled"]')
    const disabled = () => container.querySelector('[data-testid="disabled"]')
    const count = () => container.querySelector('[data-testid="count"]')?.textContent

    expect(enabled()).not.toBeNull()
    expect(disabled()).toBeNull()
    expect(count()).toBe('Count: 0')
    expect(mod.effectRunCount).toBeGreaterThanOrEqual(1)
    ;(container.querySelector('[data-testid="inc"]') as HTMLButtonElement).click()
    await tick()
    expect(count()).toBe('Count: 1')

    // Effect increments count on change because it tracks `count` signal
    ;(container.querySelector('[data-testid="disable"]') as HTMLButtonElement).click()
    await tick()
    expect(enabled()).toBeNull()
    expect(disabled()).not.toBeNull()
    expect(disabled()?.textContent).toBe('Feature is disabled')

    dispose()
    logSpy.mockRestore()
  })

  it('handles reactive array filtering in JSX', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let items = $state([
          { id: 1, name: 'Apple', category: 'fruit' },
          { id: 2, name: 'Carrot', category: 'vegetable' },
          { id: 3, name: 'Banana', category: 'fruit' },
          { id: 4, name: 'Broccoli', category: 'vegetable' },
        ])
        let filter = $state<'all' | 'fruit' | 'vegetable'>('all')

        const filteredItems = filter === 'all'
          ? items
          : items.filter(item => item.category === filter)

        return (
          <div>
            <button data-testid="all" onClick={() => filter = 'all'}>All</button>
            <button data-testid="fruit" onClick={() => filter = 'fruit'}>Fruits</button>
            <button data-testid="vegetable" onClick={() => filter = 'vegetable'}>Vegetables</button>
            <ul data-testid="list">
              {filteredItems.map(item => (
                <li key={item.id} data-testid={\`item-\${item.id}\`}>{item.name}</li>
              ))}
            </ul>
            <span data-testid="count">Count: {filteredItems.length}</span>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const count = () => container.querySelector('[data-testid="count"]')?.textContent
    const items = () => Array.from(container.querySelectorAll('[data-testid^="item-"]'))

    expect(count()).toBe('Count: 4')
    expect(items().length).toBe(4)
    ;(container.querySelector('[data-testid="fruit"]') as HTMLButtonElement).click()
    await tick()
    expect(count()).toBe('Count: 2')
    expect(items().length).toBe(2)
    expect(items().map(i => i.textContent)).toEqual(['Apple', 'Banana'])
    ;(container.querySelector('[data-testid="vegetable"]') as HTMLButtonElement).click()
    await tick()
    expect(count()).toBe('Count: 2')
    expect(items().length).toBe(2)
    expect(items().map(i => i.textContent)).toEqual(['Carrot', 'Broccoli'])
    ;(container.querySelector('[data-testid="all"]') as HTMLButtonElement).click()
    await tick()
    expect(count()).toBe('Count: 4')
    expect(items().length).toBe(4)

    dispose()
  })

  it('handles conditional class and style binding', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let isActive = $state(false)
        let isHighlighted = $state(false)
        let size = $state<'small' | 'medium' | 'large'>('medium')

        return (
          <div>
            <span
              data-testid="target"
              class={'base' + (isActive ? ' active' : '') + (isHighlighted ? ' highlighted' : '')}
              style={{
                fontSize: size === 'small' ? '12px' : size === 'large' ? '24px' : '16px',
                fontWeight: isActive ? 'bold' : 'normal',
                backgroundColor: isHighlighted ? 'yellow' : 'transparent',
              }}
            >
              Target Element
            </span>
            <button data-testid="toggle-active" onClick={() => isActive = !isActive}>Toggle Active</button>
            <button data-testid="toggle-highlight" onClick={() => isHighlighted = !isHighlighted}>Toggle Highlight</button>
            <button data-testid="size-small" onClick={() => size = 'small'}>Small</button>
            <button data-testid="size-large" onClick={() => size = 'large'}>Large</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const target = () => container.querySelector('[data-testid="target"]') as HTMLElement

    expect(target().className).toBe('base')
    expect(target().style.fontSize).toBe('16px')
    expect(target().style.fontWeight).toBe('normal')
    ;(container.querySelector('[data-testid="toggle-active"]') as HTMLButtonElement).click()
    await tick()
    expect(target().className).toBe('base active')
    expect(target().style.fontWeight).toBe('bold')
    ;(container.querySelector('[data-testid="toggle-highlight"]') as HTMLButtonElement).click()
    await tick()
    expect(target().className).toBe('base active highlighted')
    expect(target().style.backgroundColor).toBe('yellow')
    ;(container.querySelector('[data-testid="size-small"]') as HTMLButtonElement).click()
    await tick()
    expect(target().style.fontSize).toBe('12px')
    ;(container.querySelector('[data-testid="size-large"]') as HTMLButtonElement).click()
    await tick()
    expect(target().style.fontSize).toBe('24px')

    dispose()
  })

  it('handles multiple conditional returns with shared state', async () => {
    const source = `
      import { $state, render } from 'fict'

      type ViewMode = 'list' | 'grid' | 'details'

      function App() {
        let mode = $state<ViewMode>('list')
        let items = $state(['A', 'B', 'C'])

        if (mode === 'list') {
          return (
            <div data-testid="list-view">
              <h2>List View ({items.length} items)</h2>
              <ul>
                {items.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
              <button data-testid="to-grid" onClick={() => mode = 'grid'}>Grid</button>
              <button data-testid="add" onClick={() => items = [...items, String.fromCharCode(65 + items.length)]}>Add</button>
            </div>
          )
        }

        if (mode === 'grid') {
          return (
            <div data-testid="grid-view">
              <h2>Grid View ({items.length} items)</h2>
              <div style={{ display: 'flex' }}>
                {items.map((item, i) => <span key={i} style={{ margin: '5px' }}>{item}</span>)}
              </div>
              <button data-testid="to-details" onClick={() => mode = 'details'}>Details</button>
              <button data-testid="add" onClick={() => items = [...items, String.fromCharCode(65 + items.length)]}>Add</button>
            </div>
          )
        }

        return (
          <div data-testid="details-view">
            <h2>Details View ({items.length} items)</h2>
            <table>
              <tbody>
                {items.map((item, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{item}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button data-testid="to-list" onClick={() => mode = 'list'}>List</button>
            <button data-testid="add" onClick={() => items = [...items, String.fromCharCode(65 + items.length)]}>Add</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    await tick()

    const listView = () => container.querySelector('[data-testid="list-view"]')
    const gridView = () => container.querySelector('[data-testid="grid-view"]')
    const detailsView = () => container.querySelector('[data-testid="details-view"]')

    expect(listView()).not.toBeNull()
    expect(gridView()).toBeNull()
    expect(detailsView()).toBeNull()
    expect(listView()?.querySelector('h2')?.textContent).toContain('3 items')

    // Add item in list view
    ;(container.querySelector('[data-testid="add"]') as HTMLButtonElement).click()
    await tick()
    expect(listView()?.querySelector('h2')?.textContent).toContain('4 items')

    // Switch to grid view
    ;(container.querySelector('[data-testid="to-grid"]') as HTMLButtonElement).click()
    await tick()
    expect(listView()).toBeNull()
    expect(gridView()).not.toBeNull()
    expect(gridView()?.querySelector('h2')?.textContent).toContain('4 items')

    // Add item in grid view
    ;(container.querySelector('[data-testid="add"]') as HTMLButtonElement).click()
    await tick()
    expect(gridView()?.querySelector('h2')?.textContent).toContain('5 items')

    // Switch to details view
    ;(container.querySelector('[data-testid="to-details"]') as HTMLButtonElement).click()
    await tick()
    expect(gridView()).toBeNull()
    expect(detailsView()).not.toBeNull()
    expect(detailsView()?.querySelector('h2')?.textContent).toContain('5 items')

    // Switch back to list view
    ;(container.querySelector('[data-testid="to-list"]') as HTMLButtonElement).click()
    await tick()
    expect(detailsView()).toBeNull()
    expect(listView()).not.toBeNull()
    expect(listView()?.querySelector('h2')?.textContent).toContain('5 items')

    dispose()
  })

  // ============================================================
  // Alias & Reference Escape Test Suite
  // Tests for $state variables wrapped in functions, objects, arrays, etc.
  // ============================================================

  describe('alias and reference escape', () => {
    it('handles $state wrapped in simple getter function', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)
          const get = () => count

          return (
            <div>
              <p data-testid="value">{get()}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getValue = () => container.querySelector('[data-testid="value"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getValue()).toBe('0')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('1')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('2')

      dispose()
    })

    it('handles $state wrapped in object property getter', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)
          const obj = {
            getValue: () => count,
            increment: () => count++
          }

          return (
            <div>
              <p data-testid="value">{obj.getValue()}</p>
              <button data-testid="inc" onClick={obj.increment}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getValue = () => container.querySelector('[data-testid="value"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getValue()).toBe('0')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('1')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('2')

      dispose()
    })

    it('handles $state accessed inside array map callback', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let multiplier = $state(1)
          const numbers = [1, 2, 3]

          return (
            <div>
              <p data-testid="values">{numbers.map(n => n * multiplier).join(',')}</p>
              <button data-testid="inc" onClick={() => multiplier++}>Double</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getValues = () => container.querySelector('[data-testid="values"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getValues()).toBe('1,2,3')

      incBtn().click()
      await tick()
      expect(getValues()).toBe('2,4,6')

      incBtn().click()
      await tick()
      expect(getValues()).toBe('3,6,9')

      dispose()
    })

    it('keeps list map callback params as raw primitives (no proxy)', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let scores = $state([98.5, 100, 59])

          return (
            <div>
              <ul>
                {scores.map((score, idx) => {
                  const isNumber = typeof score === 'number'
                  const isPerfect = score === 100
                  return (
                    <li data-testid={'score-' + idx}>
                      <span data-testid={'type-' + idx}>{String(isNumber)}</span>
                      <span data-testid={'perfect-' + idx}>{String(isPerfect)}</span>
                      <span data-testid={'val-' + idx}>{score.toFixed(1)}</span>
                    </li>
                  )
                })}
              </ul>
              <button
                data-testid="bump"
                onClick={() => {
                  scores = scores.map((s, i) => (i === 1 ? s - 1 : s))
                }}
              >
                Bump
              </button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const read = (kind: string, idx: number) =>
        container.querySelector(`[data-testid="${kind}-${idx}"]`)?.textContent
      const bumpBtn = () => container.querySelector('[data-testid="bump"]') as HTMLButtonElement

      expect(read('type', 0)).toBe('true')
      expect(read('type', 1)).toBe('true')
      expect(read('type', 2)).toBe('true')

      expect(read('perfect', 0)).toBe('false')
      expect(read('perfect', 1)).toBe('true')
      expect(read('perfect', 2)).toBe('false')

      expect(read('val', 0)).toBe('98.5')
      expect(read('val', 1)).toBe('100.0')
      expect(read('val', 2)).toBe('59.0')

      bumpBtn().click()
      await tick()

      expect(read('type', 1)).toBe('true')
      expect(read('perfect', 1)).toBe('false')
      expect(read('val', 1)).toBe('99.0')

      dispose()
    })

    it('renders map result stored outside JSX without losing items or type checks', async () => {
      const source = `
        import { $state, render } from 'fict'

        export function App() {
          let scores = $state([98.5, 100, 59])
          const items = scores.map((score, idx) => {
            const isPerfect = score === 100
            const isNumber = typeof score === 'number'
            return (
              <li data-testid={'row-' + idx} style={{ color: isPerfect ? 'gold' : 'black' }}>
                <span data-testid={'type-' + idx}>{String(isNumber)}</span>
                <span data-testid={'perfect-' + idx}>{String(isPerfect)}</span>
                <span data-testid={'val-' + idx}>{score.toFixed(1)}</span>
              </li>
            )
          })

          return (
            <div>
              <ul>{items}</ul>
              <button
                data-testid="bump"
                onClick={() => {
                  scores = scores.map((s, i) => (i === 1 ? s - 1 : s + 0))
                }}
              >
                Bump
              </button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const read = (kind: string, idx: number) =>
        container.querySelector(`[data-testid="${kind}-${idx}"]`)?.textContent
      const bumpBtn = () => container.querySelector('[data-testid="bump"]') as HTMLButtonElement

      expect(container.querySelectorAll('li').length).toBe(3)
      expect(read('type', 1)).toBe('true')
      expect(read('perfect', 1)).toBe('true')
      expect(read('val', 1)).toBe('100.0')

      bumpBtn().click()
      await tick()

      expect(container.querySelectorAll('li').length).toBe(3)
      expect(read('type', 1)).toBe('true')
      expect(read('perfect', 1)).toBe('false')
      expect(read('val', 1)).toBe('99.0')

      dispose()
    })

    it('renders map returned from inner helper function without losing items', async () => {
      const source = `
        import { $state, render } from 'fict'

        export function App() {
          let scores = $state([98.5, 100, 59])

          const renderScores = (values: number[]) =>
            values.map((score, idx) => {
              const isNumber = typeof score === 'number'
              const isPerfect = score === 100
              return (
                <li data-testid={'row-' + idx} style={{ color: isPerfect ? 'gold' : 'black' }}>
                  <span data-testid={'type-' + idx}>{String(isNumber)}</span>
                  <span data-testid={'perfect-' + idx}>{String(isPerfect)}</span>
                  <span data-testid={'val-' + idx}>{score.toFixed(1)}</span>
                </li>
              )
            })

          return (
            <div>
              <ul>{renderScores(scores)}</ul>
              <button
                data-testid="bump"
                onClick={() => {
                  scores = scores.map((s, i) => (i === 0 ? s + 1 : s))
                }}
              >
                Bump
              </button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const read = (kind: string, idx: number) =>
        container.querySelector(`[data-testid="${kind}-${idx}"]`)?.textContent
      const bumpBtn = () => container.querySelector('[data-testid="bump"]') as HTMLButtonElement

      expect(container.querySelectorAll('li').length).toBe(3)
      expect(read('val', 0)).toBe('98.5')
      expect(read('perfect', 1)).toBe('true')

      bumpBtn().click()
      await tick()

      expect(read('val', 0)).toBe('99.5')
      expect(read('perfect', 1)).toBe('true')

      dispose()
    })

    it('renders JSX arrays built via reduce inside helper and stays reactive', async () => {
      const source = `
        import { $state, render } from 'fict'

        export function App() {
          let scores = $state([98.5, 100, 59])

          const renderScores = (values: number[]) =>
            values.reduce((acc, score, idx) => {
              const isNumber = typeof score === 'number'
              const isPerfect = score === 100
              acc.push(
                <li data-testid={'row-' + idx} style={{ color: isPerfect ? 'gold' : 'black' }}>
                  <span data-testid={'type-' + idx}>{String(isNumber)}</span>
                  <span data-testid={'perfect-' + idx}>{String(isPerfect)}</span>
                  <span data-testid={'val-' + idx}>{score.toFixed(1)}</span>
                </li>,
              )
              return acc
            }, [] as JSX.Element[])

          return (
            <div>
              <ul>{renderScores(scores)}</ul>
              <button
                data-testid="bump"
                onClick={() => {
                  scores = scores.map((s, i) => (i === 2 ? s + 1 : s))
                }}
              >
                Bump
              </button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const read = (kind: string, idx: number) =>
        container.querySelector(`[data-testid="${kind}-${idx}"]`)?.textContent
      const bumpBtn = () => container.querySelector('[data-testid="bump"]') as HTMLButtonElement

      expect(container.querySelectorAll('li').length).toBe(3)
      expect(read('val', 2)).toBe('59.0')
      expect(read('perfect', 1)).toBe('true')

      bumpBtn().click()
      await tick()

      expect(read('val', 2)).toBe('60.0')
      expect(read('perfect', 1)).toBe('true')

      dispose()
    })

    it('handles helper map returning primitive strings (no JSX) and updates text', async () => {
      const source = `
        import { $state, render } from 'fict'

        export function App() {
          let scores = $state([1, 2, 3])

          const labels = () => scores.map(score => \`\${score}-pt\`)

          return (
            <div>
              <ul data-testid="list">{labels()}</ul>
              <button data-testid="bump" onClick={() => (scores = scores.map(s => s + 1))}>
                Bump
              </button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const list = () => container.querySelector('[data-testid="list"]') as HTMLElement
      const bumpBtn = () => container.querySelector('[data-testid="bump"]') as HTMLButtonElement

      expect(list().textContent?.replace(/\\s+/g, '')).toBe('1-pt2-pt3-pt')

      bumpBtn().click()
      await tick()

      expect(list().textContent?.replace(/\\s+/g, '')).toBe('2-pt3-pt4-pt')

      dispose()
    })

    it('handles $state in nested getter (higher-order function)', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)
          const createGetter = () => () => count

          const getter = createGetter()

          return (
            <div>
              <p data-testid="value">{getter()}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getValue = () => container.querySelector('[data-testid="value"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getValue()).toBe('0')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('1')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('2')

      dispose()
    })

    it('keeps direct alias reactive in DOM', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)
          const alias = count

          return (
            <div>
              <p data-testid="alias">{alias}</p>
              <p data-testid="count">{count}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getAlias = () => container.querySelector('[data-testid="alias"]')?.textContent
      const getCount = () => container.querySelector('[data-testid="count"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getAlias()).toBe('0')
      expect(getCount()).toBe('0')

      incBtn().click()
      await tick()
      expect(getAlias()).toBe('1')
      expect(getCount()).toBe('1')

      incBtn().click()
      await tick()
      expect(getAlias()).toBe('2')
      expect(getCount()).toBe('2')

      dispose()
    })

    it('handles $state in array element as getter', async () => {
      const source = `
        import { $state, $effect, render } from 'fict'

        function App() {
          let count = $state(0)
          const getters = [() => count, () => count * 2]

          return (
            <div>
              <p data-testid="single">{getters[0]()}</p>
              <p data-testid="double">{getters[1]()}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getSingle = () => container.querySelector('[data-testid="single"]')?.textContent
      const getDouble = () => container.querySelector('[data-testid="double"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getSingle()).toBe('0')
      expect(getDouble()).toBe('0')

      incBtn().click()
      await tick()
      expect(getSingle()).toBe('1')
      expect(getDouble()).toBe('2')

      incBtn().click()
      await tick()
      expect(getSingle()).toBe('2')
      expect(getDouble()).toBe('4')

      dispose()
    })

    it('handles $state in reduce callback', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let offset = $state(0)
          const numbers = [1, 2, 3, 4, 5]

          return (
            <div>
              <p data-testid="sum">{numbers.reduce((acc, n) => acc + n + offset, 0)}</p>
              <button data-testid="inc" onClick={() => offset++}>Add Offset</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getSum = () => container.querySelector('[data-testid="sum"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      // 1+2+3+4+5 = 15, with offset 0
      expect(getSum()).toBe('15')

      incBtn().click()
      await tick()
      // 1+2+3+4+5 + 5*1 = 20
      expect(getSum()).toBe('20')

      incBtn().click()
      await tick()
      // 1+2+3+4+5 + 5*2 = 25
      expect(getSum()).toBe('25')

      dispose()
    })

    it('handles $state in filter callback', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let threshold = $state(3)
          const numbers = [1, 2, 3, 4, 5]

          return (
            <div>
              <p data-testid="filtered">{numbers.filter(n => n > threshold).join(',')}</p>
              <button data-testid="dec" onClick={() => threshold--}>Lower Threshold</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getFiltered = () => container.querySelector('[data-testid="filtered"]')?.textContent
      const decBtn = () => container.querySelector('[data-testid="dec"]') as HTMLButtonElement

      expect(getFiltered()).toBe('4,5')

      decBtn().click()
      await tick()
      expect(getFiltered()).toBe('3,4,5')

      decBtn().click()
      await tick()
      expect(getFiltered()).toBe('2,3,4,5')

      dispose()
    })

    it('handles $state accessed through closure in setTimeout callback', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)
          let snapshots = $state<number[]>([])

          const captureWithDelay = () => {
            setTimeout(() => {
              snapshots = [...snapshots, count]
            }, 0)
          }

          return (
            <div>
              <p data-testid="count">{count}</p>
              <p data-testid="snapshots">{snapshots.join(',')}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
              <button data-testid="capture" onClick={captureWithDelay}>Capture</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getCount = () => container.querySelector('[data-testid="count"]')?.textContent
      const getSnapshots = () => container.querySelector('[data-testid="snapshots"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement
      const captureBtn = () =>
        container.querySelector('[data-testid="capture"]') as HTMLButtonElement

      expect(getCount()).toBe('0')
      expect(getSnapshots()).toBe('')

      captureBtn().click()
      await new Promise(r => setTimeout(r, 10))
      await tick()
      expect(getSnapshots()).toBe('0')

      incBtn().click()
      await tick()
      expect(getCount()).toBe('1')

      incBtn().click()
      await tick()
      expect(getCount()).toBe('2')

      captureBtn().click()
      await new Promise(r => setTimeout(r, 10))
      await tick()
      expect(getSnapshots()).toBe('0,2')

      dispose()
    })

    it('handles multiple $state variables in single getter', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let a = $state(1)
          let b = $state(2)
          let c = $state(3)

          const sum = () => a + b + c
          const product = () => a * b * c

          return (
            <div>
              <p data-testid="sum">{sum()}</p>
              <p data-testid="product">{product()}</p>
              <button data-testid="inc-a" onClick={() => a++}>A++</button>
              <button data-testid="inc-b" onClick={() => b++}>B++</button>
              <button data-testid="inc-c" onClick={() => c++}>C++</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getSum = () => container.querySelector('[data-testid="sum"]')?.textContent
      const getProduct = () => container.querySelector('[data-testid="product"]')?.textContent
      const incA = () => container.querySelector('[data-testid="inc-a"]') as HTMLButtonElement
      const incB = () => container.querySelector('[data-testid="inc-b"]') as HTMLButtonElement
      const incC = () => container.querySelector('[data-testid="inc-c"]') as HTMLButtonElement

      expect(getSum()).toBe('6') // 1+2+3
      expect(getProduct()).toBe('6') // 1*2*3

      incA().click()
      await tick()
      expect(getSum()).toBe('7') // 2+2+3
      expect(getProduct()).toBe('12') // 2*2*3

      incB().click()
      await tick()
      expect(getSum()).toBe('8') // 2+3+3
      expect(getProduct()).toBe('18') // 2*3*3

      incC().click()
      await tick()
      expect(getSum()).toBe('9') // 2+3+4
      expect(getProduct()).toBe('24') // 2*3*4

      dispose()
    })

    it('handles $state in conditional getter', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)
          let useDouble = $state(false)

          const getValue = () => useDouble ? count * 2 : count

          return (
            <div>
              <p data-testid="value">{getValue()}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
              <button data-testid="toggle" onClick={() => useDouble = !useDouble}>Toggle Double</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getValue = () => container.querySelector('[data-testid="value"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement
      const toggleBtn = () => container.querySelector('[data-testid="toggle"]') as HTMLButtonElement

      expect(getValue()).toBe('0')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('1')

      toggleBtn().click()
      await tick()
      expect(getValue()).toBe('2') // now doubled

      incBtn().click()
      await tick()
      expect(getValue()).toBe('4') // 2 * 2

      toggleBtn().click()
      await tick()
      expect(getValue()).toBe('2') // back to normal

      dispose()
    })

    it('handles $state in find callback (both array and predicate depend on $state)', async () => {
      // When finding in a $state array with a $state predicate, found is auto-derived
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let target = $state(3)
          let numbers = $state([1, 2, 3, 4, 5])

          // When both are $state, this becomes an auto-derived memo
          const found = numbers.find(n => n === target)

          return (
            <div>
              <p data-testid="found">{found ?? 'not found'}</p>
              <button data-testid="next" onClick={() => target++}>Next</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getFound = () => container.querySelector('[data-testid="found"]')?.textContent
      const nextBtn = () => container.querySelector('[data-testid="next"]') as HTMLButtonElement

      expect(getFound()).toBe('3')

      nextBtn().click()
      await tick()
      expect(getFound()).toBe('4')

      nextBtn().click()
      await tick()
      expect(getFound()).toBe('5')

      nextBtn().click()
      await tick()
      expect(getFound()).toBe('not found')

      dispose()
    })

    // Verify: When the array is a plain value but the predicate depends on $state,
    // is the derived value correctly reactive?
    it('handles $state in find callback (only predicate depends on $state)', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let target = $state(3)
          const numbers = [1, 2, 3, 4, 5]  // plain array
          const found = numbers.find(n => n === target)

          return (
            <div>
              <p data-testid="found">{found ?? 'not found'}</p>
              <button data-testid="next" onClick={() => target++}>Next</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getFound = () => container.querySelector('[data-testid="found"]')?.textContent
      const nextBtn = () => container.querySelector('[data-testid="next"]') as HTMLButtonElement

      expect(getFound()).toBe('3')

      nextBtn().click()
      await tick()
      expect(getFound()).toBe('4')

      nextBtn().click()
      await tick()
      expect(getFound()).toBe('5')

      nextBtn().click()
      await tick()
      expect(getFound()).toBe('not found')

      dispose()
    })

    it('handles $state passed to external utility function', async () => {
      const source = `
        import { $state, render } from 'fict'

        const format = (value: number) => \`Value: \${value}\`

        function App() {
          let count = $state(0)

          return (
            <div>
              <p data-testid="formatted">{format(count)}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getFormatted = () => container.querySelector('[data-testid="formatted"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getFormatted()).toBe('Value: 0')

      incBtn().click()
      await tick()
      expect(getFormatted()).toBe('Value: 1')

      incBtn().click()
      await tick()
      expect(getFormatted()).toBe('Value: 2')

      dispose()
    })

    it('handles $state in IIFE returning getter', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)

          const getter = (() => {
            return () => count * 10
          })()

          return (
            <div>
              <p data-testid="value">{getter()}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getValue = () => container.querySelector('[data-testid="value"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getValue()).toBe('0')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('10')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('20')

      dispose()
    })

    it('handles $state in deeply nested object getter', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)

          const api = {
            data: {
              getters: {
                count: () => count,
                doubled: () => count * 2
              }
            }
          }

          return (
            <div>
              <p data-testid="count">{api.data.getters.count()}</p>
              <p data-testid="doubled">{api.data.getters.doubled()}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getCount = () => container.querySelector('[data-testid="count"]')?.textContent
      const getDoubled = () => container.querySelector('[data-testid="doubled"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getCount()).toBe('0')
      expect(getDoubled()).toBe('0')

      incBtn().click()
      await tick()
      expect(getCount()).toBe('1')
      expect(getDoubled()).toBe('2')

      incBtn().click()
      await tick()
      expect(getCount()).toBe('2')
      expect(getDoubled()).toBe('4')

      dispose()
    })

    it('handles $state in spread into array with getters', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)

          const baseGetters = [() => count]
          const allGetters = [...baseGetters, () => count + 1]

          return (
            <div>
              <p data-testid="base">{allGetters[0]()}</p>
              <p data-testid="plus-one">{allGetters[1]()}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getBase = () => container.querySelector('[data-testid="base"]')?.textContent
      const getPlusOne = () => container.querySelector('[data-testid="plus-one"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getBase()).toBe('0')
      expect(getPlusOne()).toBe('1')

      incBtn().click()
      await tick()
      expect(getBase()).toBe('1')
      expect(getPlusOne()).toBe('2')

      incBtn().click()
      await tick()
      expect(getBase()).toBe('2')
      expect(getPlusOne()).toBe('3')

      dispose()
    })

    it('handles derived value (memo) wrapped in getter', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)
          const doubled = count * 2
          const getDoubled = () => doubled

          return (
            <div>
              <p data-testid="doubled">{getDoubled()}</p>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getDoubled = () => container.querySelector('[data-testid="doubled"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getDoubled()).toBe('0')

      incBtn().click()
      await tick()
      expect(getDoubled()).toBe('2')

      incBtn().click()
      await tick()
      expect(getDoubled()).toBe('4')

      dispose()
    })

    it('supports createSelector for keyed selection toggling', async () => {
      const source = `
        import { $state, createSelector, render } from 'fict'

        const rows = [
          { id: 1, label: 'Row 1' },
          { id: 2, label: 'Row 2' },
          { id: 3, label: 'Row 3' },
        ]

        function App() {
          let selected: number | null = $state(null)
          const isSelected = createSelector(() => selected)

          return (
            <ul>
              {rows.map(row => (
                <li
                  data-testid={\`row-\${row.id}\`}
                  class={isSelected(row.id) ? 'selected' : ''}
                >
                  <button data-testid={\`select-\${row.id}\`} onClick={() => selected = row.id}>
                    {row.label}
                  </button>
                </li>
              ))}
            </ul>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const row = (id: number) =>
        container.querySelector(`[data-testid="row-${id}"]`) as HTMLElement
      const selectBtn = (id: number) =>
        container.querySelector(`[data-testid="select-${id}"]`) as HTMLButtonElement

      expect(row(1).classList.contains('selected')).toBe(false)
      expect(row(2).classList.contains('selected')).toBe(false)

      selectBtn(2).click()
      await tick()
      expect(row(2).classList.contains('selected')).toBe(true)
      expect(row(1).classList.contains('selected')).toBe(false)
      expect(row(3).classList.contains('selected')).toBe(false)

      selectBtn(3).click()
      await tick()
      expect(row(3).classList.contains('selected')).toBe(true)
      expect(row(2).classList.contains('selected')).toBe(false)

      dispose()
    })

    it('supports createSelector with custom equality for complex keys', async () => {
      const source = `
        import { $state, createSelector, render } from 'fict'

        const items = [
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ]

        function App() {
          let selected = $state(items[0])
          const isSelected = createSelector(() => selected, (a, b) => a.id === b.id)

          return (
            <ul>
              {items.map(item => (
                <li
                  data-testid={\`item-\${item.id}\`}
                  class={isSelected(item) ? 'selected' : ''}
                >
                  <button data-testid={\`pick-\${item.id}\`} onClick={() => selected = item}>
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const item = (id: string) =>
        container.querySelector(`[data-testid="item-${id}"]`) as HTMLElement
      const pickBtn = (id: string) =>
        container.querySelector(`[data-testid="pick-${id}"]`) as HTMLButtonElement

      expect(item('a').classList.contains('selected')).toBe(true)
      expect(item('b').classList.contains('selected')).toBe(false)

      pickBtn('b').click()
      await tick()
      expect(item('a').classList.contains('selected')).toBe(false)
      expect(item('b').classList.contains('selected')).toBe(true)

      dispose()
    })

    it('disposes reactive work in plain control flow via runInScope', async () => {
      const source = `
        import { $state, render, runInScope, createEffect, onCleanup } from 'fict'

        export const events: string[] = []

        function App() {
          let show = $state(true)
          runInScope(() => show, () => {
            createEffect(() => {
              events.push(\`effect:\${show}\`)
              onCleanup(() => events.push(\`cleanup:\${show}\`))
            })
          })
          return (
            <div>
              <span data-testid="flag">{show}</span>
              <button data-testid="toggle" onClick={() => (show = !show)}>Toggle</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        events: string[]
      }>(source)
      const dispose = mod.mount(container)
      await tick()

      const toggle = container.querySelector('[data-testid="toggle"]') as HTMLButtonElement

      expect(mod.events).toEqual(['effect:true'])

      toggle.click()
      await tick()
      expect(mod.events.some(e => e.startsWith('cleanup'))).toBe(true)
      expect(mod.events.filter(e => e.startsWith('effect')).length).toBe(1)

      toggle.click()
      await tick()
      expect(mod.events.filter(e => e.startsWith('effect')).length).toBe(2)

      dispose()
    })

    it('auto scopes reactive primitives inside plain if control flow', async () => {
      const source = `
        import { $state, render, createMemo, createEffect, onCleanup } from 'fict'

        export const events: string[] = []

        function App() {
          let show = $state(true)
          let count = $state(0)

          if (show) {
            const doubled = createMemo(() => count * 2)
            createEffect(() => {
              events.push(\`effect:\${doubled()}\`)
              onCleanup(() => events.push(\`cleanup:\${show}\`))
            })
          }

          return (
            <div>
              <button data-testid="toggle" onClick={() => (show = !show)}>Toggle</button>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
              <span data-testid="flag">{show ? 'true' : 'false'}</span>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        events: string[]
      }>(source)
      const dispose = mod.mount(container)
      await tick()

      const toggle = container.querySelector('[data-testid="toggle"]') as HTMLButtonElement
      const inc = container.querySelector('[data-testid="inc"]') as HTMLButtonElement
      const flag = () => container.querySelector('[data-testid="flag"]')?.textContent
      const effectCount = () => mod.events.filter(e => e.startsWith('effect')).length
      const cleanupCount = () => mod.events.filter(e => e.startsWith('cleanup')).length

      expect(flag()).toBe('true')
      expect(effectCount()).toBe(1)

      inc.click()
      await tick()
      expect(effectCount()).toBe(2)

      toggle.click()
      await tick()
      expect(flag()).toBe('false')
      expect(cleanupCount()).toBeGreaterThanOrEqual(1)
      const afterToggleCount = effectCount()

      inc.click()
      await tick()
      expect(effectCount()).toBe(afterToggleCount)

      toggle.click()
      await tick()
      expect(flag()).toBe('true')
      expect(effectCount()).toBeGreaterThanOrEqual(afterToggleCount + 1)

      dispose()
    })

    it('preserves function declaration hoisting and tracks dependencies across calls', async () => {
      const source = `
        import { $state, render } from 'fict'

        export const events: string[] = []

        export function App() {
          let count = $state(0)
          const y = compute(count)
          function compute(x: number) {
            events.push(\`compute:\${x}\`)
            return x * 2
          }
          return (
            <div>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
              <span data-testid="count">{count}</span>
              <span data-testid="y">{y}</span>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        events: string[]
      }>(source)
      const dispose = mod.mount(container)
      await tick()

      const incBtn = container.querySelector('[data-testid=\"inc\"]') as HTMLButtonElement
      const getCount = () => container.querySelector('[data-testid=\"count\"]')?.textContent
      const getY = () => container.querySelector('[data-testid=\"y\"]')?.textContent

      expect(getCount()).toBe('0')
      expect(getY()).toBe('0')
      expect(mod.events.some(e => e.startsWith('compute'))).toBe(true)

      incBtn.click()
      await tick()
      expect(getCount()).toBe('1')
      expect(getY()).toBe('2')
      expect(mod.events.filter(e => e.startsWith('compute')).length).toBeGreaterThanOrEqual(2)

      dispose()
    })

    it('lets createScope manually control lifetime in non-JSX control flow', async () => {
      const source = `
        import { $state, render, createScope, createEffect, onCleanup } from 'fict'

        export const events: string[] = []

        function App() {
          let enabled = $state(false)
          const scoped = createScope()
          const start = () =>
            scoped.run(() => {
              enabled = true
              createEffect(() => {
                events.push(\`effect:\${enabled}\`)
                onCleanup(() => events.push(\`cleanup:\${enabled}\`))
              })
            })
          const stop = () => {
            enabled = false
            scoped.stop()
          }

          return (
            <div>
              <button data-testid="start" onClick={start}>Start</button>
              <button data-testid="stop" onClick={stop}>Stop</button>
              <span data-testid="flag">{enabled ? 'true' : 'false'}</span>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        events: string[]
      }>(source)
      const dispose = mod.mount(container)
      await tick()

      const startBtn = container.querySelector('[data-testid="start"]') as HTMLButtonElement
      const stopBtn = container.querySelector('[data-testid="stop"]') as HTMLButtonElement
      const effectCount = () => mod.events.filter(e => e.startsWith('effect')).length
      const cleanupCount = () => mod.events.filter(e => e.startsWith('cleanup')).length
      const flag = () => container.querySelector('[data-testid="flag"]')?.textContent

      expect(mod.events).toEqual([])
      expect(flag()).toBe('false')

      startBtn.click()
      await tick()
      expect(flag()).toBe('true')
      expect(effectCount()).toBe(1)
      expect(cleanupCount()).toBe(0)

      stopBtn.click()
      await tick()
      expect(flag()).toBe('false')
      expect(cleanupCount()).toBe(1)

      startBtn.click()
      await tick()
      expect(effectCount()).toBe(2)

      stopBtn.click()
      await tick()
      expect(cleanupCount()).toBe(2)

      dispose()
    })

    it('handles $state with getter returned from useCallback-like pattern', async () => {
      // Note: When destructuring hook results, function properties are treated as accessors
      // Use explicit arrow function wrapper for event handlers: onClick={() => increment()}
      const source = `
        import { $state, render } from 'fict'

        function useValue() {
          let value = $state(0)
          return {
            getValue: () => value,
            setValue: (v: number) => value = v,
            increment: () => value++
          }
        }

        function App() {
          const { getValue, increment } = useValue()

          return (
            <div>
              <p data-testid="value">{getValue()}</p>
              <button data-testid="inc" onClick={() => increment()}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getValue = () => container.querySelector('[data-testid="value"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getValue()).toBe('0')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('1')

      incBtn().click()
      await tick()
      expect(getValue()).toBe('2')

      dispose()
    })

    it('handles $state in object shorthand with getter method', async () => {
      const source = `
        import { $state, render } from 'fict'

        function App() {
          let count = $state(0)

          const methods = {
            getCount() { return count },
            increment() { count++ }
          }

          return (
            <div>
              <p data-testid="count">{methods.getCount()}</p>
              <button data-testid="inc" onClick={methods.increment}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const getCount = () => container.querySelector('[data-testid="count"]')?.textContent
      const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

      expect(getCount()).toBe('0')

      incBtn().click()
      await tick()
      expect(getCount()).toBe('1')

      incBtn().click()
      await tick()
      expect(getCount()).toBe('2')

      dispose()
    })

    it('treats $state object property reads as whole-object reactive (coarse)', async () => {
      const source = `
        import { $state, $effect, render } from 'fict'

        function App() {
          let user = $state({ name: 'Alice', info: { city: 'Paris' } })
          const nameAlias = user.name
          let runs = 0
          let runDisplay = $state(0)

          $effect(() => {
            runDisplay = ++runs + (nameAlias(), user.name, 0)
          })

          return (
            <div>
              <p data-testid="name">{user.name}</p>
              <p data-testid="alias">{nameAlias}</p>
              <p data-testid="runs">{runDisplay}</p>
              <button data-testid="mutate" onClick={() => { user = { name: 'Alice', info: { city: 'Berlin' } } }}>Mutate</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      const nameEl = () => container.querySelector('[data-testid=\"name\"]')!.textContent
      const aliasEl = () => container.querySelector('[data-testid=\"alias\"]')!.textContent
      const runsEl = () => container.querySelector('[data-testid=\"runs\"]')!.textContent
      const btn = () => container.querySelector('[data-testid=\"mutate\"]') as HTMLButtonElement

      expect(nameEl()).toBe('Alice')
      expect(aliasEl()).toBe('Alice')
      expect(runsEl()).toBe('1')

      btn().click()
      await tick()
      // Whole-object invalidation updates both reads even when only a nested, unrelated property changes
      expect(nameEl()).toBe('Alice')
      expect(aliasEl()).toBe('Alice')
      expect(runsEl()).toBe('2')

      dispose()
    })
  })

  /**
   * Regression Tests for Performance Optimization Semantic Safety
   *
   * These tests prevent semantic regressions from performance optimizations
   * at the compiler integration level.
   */
  describe('performance optimization regression tests', () => {
    it('keyed list onMount fires correctly for each component', async () => {
      const source = `
        import { $state, onMount, render } from 'fict'

        export const mountedValues: number[] = []

        function ListItem({ value }: { value: number }) {
          onMount(() => {
            mountedValues.push(value)
          })
          return <li data-value={value}>{value}</li>
        }

        function App() {
          return (
            <ul data-testid="list">
              <ListItem value={1} />
              <ListItem value={2} />
              <ListItem value={3} />
            </ul>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        mountedValues: number[]
      }>(source)
      const dispose = mod.mount(container)
      await tick()

      // All items should have their onMount called
      expect(mod.mountedValues.length).toBe(3)
      expect(mod.mountedValues).toContain(1)
      expect(mod.mountedValues).toContain(2)
      expect(mod.mountedValues).toContain(3)

      // Verify elements are in the DOM
      const list = container.querySelector('[data-testid="list"]')
      expect(list?.children.length).toBe(3)

      dispose()
    })

    it('ErrorBoundary recovers and allows subsequent renders after component error', async () => {
      const source = `
        import { $state, render, ErrorBoundary } from 'fict'

        function ThrowingComponent() {
          throw new Error('Component error')
        }

        function App() {
          let shouldThrow = $state(true)
          let resetKey = $state(0)

          function MaybeThrow() {
            if (shouldThrow) {
              throw new Error('Component error')
            }
            return <span data-testid="good">good</span>
          }

          return (
            <div>
              <button data-testid="reset" onClick={() => { shouldThrow = false; resetKey = resetKey + 1 }}>Reset</button>
              <ErrorBoundary fallback={<span data-testid="fallback">error</span>} resetKeys={() => resetKey}>
                <MaybeThrow />
              </ErrorBoundary>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
      const dispose = mod.mount(container)
      await tick()

      // Should show fallback after error
      expect(container.querySelector('[data-testid="fallback"]')?.textContent).toBe('error')

      // Reset to recover
      const resetBtn = container.querySelector('[data-testid="reset"]') as HTMLButtonElement
      resetBtn.click()
      await tick()

      expect(container.querySelector('[data-testid="good"]')?.textContent).toBe('good')
      expect(container.querySelector('[data-testid="fallback"]')).toBeNull()

      dispose()
    })

    it('createSelector stops updating after component unmount', async () => {
      const source = `
        import { $state, $effect, createSelector, render } from 'fict'

        export let effectRunsAfterUnmount = 0
        export let unmountComplete = false

        function SelectorChild({ source }: { source: () => string }) {
          const isSelected = createSelector(source)

          $effect(() => {
            const result = isSelected('x')
            if (unmountComplete) {
              effectRunsAfterUnmount++
            }
          })

          return <span>selector</span>
        }

        function App() {
          let source = $state('x')
          let show = $state(true)

          return (
            <div>
              <button data-testid="toggle" onClick={() => show = !show}>Toggle</button>
              <button data-testid="update" onClick={() => source = source === 'x' ? 'y' : 'z'}>Update</button>
              {show && <SelectorChild source={() => source} />}
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }

        export function markUnmountComplete() {
          unmountComplete = true
        }
      `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        effectRunsAfterUnmount: number
        unmountComplete: boolean
        markUnmountComplete: () => void
      }>(source)
      const dispose = mod.mount(container)
      await tick()

      // Unmount the selector component
      const toggleBtn = container.querySelector('[data-testid="toggle"]') as HTMLButtonElement
      toggleBtn.click()
      await tick()

      // Mark unmount complete
      mod.markUnmountComplete()

      // Update source after unmount
      const updateBtn = container.querySelector('[data-testid="update"]') as HTMLButtonElement
      updateBtn.click()
      await tick()
      updateBtn.click()
      await tick()

      // Selector should not respond repeatedly after unmount
      expect(mod.effectRunsAfterUnmount).toBeLessThanOrEqual(1)

      dispose()
    })

    it('handles click events bubbling from Text node targets', async () => {
      const source = `
        import { $state, render } from 'fict'

        export let clickCount = 0

        function App() {
          return (
            <div data-testid="wrapper" onClick={() => clickCount++}>
              Click this text
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        clickCount: number
      }>(source)
      const dispose = mod.mount(container)
      await tick()

      const wrapper = container.querySelector('[data-testid="wrapper"]') as HTMLElement
      const textNode = wrapper.firstChild as Text

      expect(textNode).toBeInstanceOf(Text)

      // Dispatch click from text node
      let noError = true
      try {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true })
        textNode.dispatchEvent(event)
      } catch {
        noError = false
      }

      expect(noError).toBe(true)
      expect(mod.clickCount).toBe(1)

      dispose()
    })

    it('effect count remains stable after conditional clear and show', async () => {
      const source = `
        import { $state, onMount, render } from 'fict'

        export let mountRuns = 0

        function Item({ id }: { id: number }) {
          onMount(() => {
            mountRuns++
          })
          return <li>{id}</li>
        }

        function App() {
          let show = $state(true)

          return (
            <div>
              <button data-testid="toggle" onClick={() => show = !show}>Toggle</button>
              <ul>
                {show && <><Item id={1} /><Item id={2} /></>}
              </ul>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        mountRuns: number
      }>(source)
      const dispose = mod.mount(container)
      await tick()

      const initialRuns = mod.mountRuns
      expect(initialRuns).toBe(2) // 2 items

      const toggleBtn = container.querySelector('[data-testid="toggle"]') as HTMLButtonElement

      // Toggle off and on multiple times
      toggleBtn.click()
      await tick()
      toggleBtn.click()
      await tick()
      toggleBtn.click()
      await tick()
      toggleBtn.click()
      await tick()

      // Each toggle on adds 2 mounts (not accumulating exponentially)
      // Initial: 2, Toggle1: +2 = 4, Toggle2: +2 = 6
      expect(mod.mountRuns).toBeLessThanOrEqual(8)

      dispose()
    })
  })
})
