import { writeFileSync } from 'node:fs'
import { createRequire } from 'module'

import * as runtime from '@fictjs/runtime'
import * as runtimeInternal from '@fictjs/runtime/internal'
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
  if (process.env.DEBUG_COMPILED) {
    writeFileSync('/tmp/fict-compiled.js', output)
  }
  const module: { exports: any } = { exports: {} }
  const dynamicRequire = createRequire(import.meta.url)

  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal') return runtimeInternal
      if (id === '@fictjs/runtime') return runtime
      if (id === '@fictjs/runtime/jsx-runtime' || id === 'fict/jsx-runtime') return runtimeJsx
      if (id === 'fict') return fict
      return dynamicRequire(id)
    },
    module,
    module.exports,
  )

  return module.exports as TModule
}

const controlFlowRegionSource = `
  import { $state, render } from 'fict'

  function Counter() {
    let count = $state(0)
    // Derived-like values inside control flow
    let message = 'Keep going...'
    let color = 'black'
    const double = count * 2

    if (count >= 3) {
      message = 'Threshold Reached!'
      color = 'red'
      if (count === 3) {
        console.log('Just hit 3!')
      }
    }

    return (
      <div data-testid="root" style={{ color }}>
        <h1 data-testid="count">Count: {count}</h1>
        <h2 data-testid="double">Double: {double}</h2>
        <p data-testid="message">{message}</p>
        <button data-testid="inc" onClick={() => count++}>Increment</button>
      </div>
    )
  }

  export function mount(el: HTMLElement) {
    return render(() => <Counter />, el)
  }
`

describe('control-flow region integration', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('keeps control-flow derived values reactive and side effects correct', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(controlFlowRegionSource)
    const dispose = mod.mount(container)

    const root = () => container.querySelector('[data-testid="root"]') as HTMLElement
    const countText = () => container.querySelector('[data-testid="count"]')?.textContent
    const doubleText = () => container.querySelector('[data-testid="double"]')?.textContent
    const messageText = () => container.querySelector('[data-testid="message"]')?.textContent
    const incBtn = () => container.querySelector('[data-testid="inc"]') as HTMLButtonElement

    await tick()

    expect(countText()).toBe('Count: 0')
    expect(doubleText()).toBe('Double: 0')
    expect(messageText()).toBe('Keep going...')
    expect(root().style.color).toBe('black')
    expect(logSpy).not.toHaveBeenCalled()

    incBtn().click()
    await tick()
    expect(countText()).toBe('Count: 1')
    expect(doubleText()).toBe('Double: 2')
    expect(messageText()).toBe('Keep going...')
    expect(root().style.color).toBe('black')
    expect(logSpy).not.toHaveBeenCalled()

    incBtn().click()
    await tick()
    expect(countText()).toBe('Count: 2')
    expect(doubleText()).toBe('Double: 4')
    expect(messageText()).toBe('Keep going...')
    expect(root().style.color).toBe('black')
    expect(logSpy).not.toHaveBeenCalled()

    incBtn().click()
    await tick()
    expect(countText()).toBe('Count: 3')
    expect(doubleText()).toBe('Double: 6')
    if (process.env.DEBUG_VALUES) {
      // eslint-disable-next-line no-console
      console.info({
        count: countText(),
        double: doubleText(),
        message: messageText(),
        color: root().style.color,
      })
    }
    expect(messageText()).toBe('Threshold Reached!')
    expect(root().style.color).toBe('red')
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenLastCalledWith('Just hit 3!')

    incBtn().click()
    await tick()
    expect(countText()).toBe('Count: 4')
    expect(doubleText()).toBe('Double: 8')
    expect(messageText()).toBe('Threshold Reached!')
    expect(root().style.color).toBe('red')
    expect(logSpy).toHaveBeenCalledTimes(1)

    dispose()
    logSpy.mockRestore()
  })

  it('handles early-return branch without breaking derived values', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const source = `
      import { $state, render } from 'fict'

      function Counter() {
        let count = $state(0)
        const double = count * 2
        let message = 'Keep going...'
        let color = 'black'
        if (count >= 3) {
          message = 'Threshold Reached!'
          color = 'red'
          if (count === 3) {
            console.log('Just hit 3!')
          }
          return (
            <div data-testid="branch1" style={{ color }}>
              <h1 data-testid="count1">Count1: {count}</h1>
              <h2 data-testid="double1">Double1: {double}</h2>
              <p data-testid="message1">{message}</p>
              <button data-testid="inc1" onClick={() => count++}>Increment1</button>
            </div>
          )
        }
        return (
          <div data-testid="branch0" style={{ color }}>
            <h1 data-testid="count0">Count: {count}</h1>
            <h2 data-testid="double0">Double: {double}</h2>
            <p data-testid="message0">{message}</p>
            <button data-testid="inc0" onClick={() => count++}>Increment</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    const inc0 = () => container.querySelector('[data-testid="inc0"]') as HTMLButtonElement | null
    const inc1 = () => container.querySelector('[data-testid="inc1"]') as HTMLButtonElement | null

    const count0 = () => container.querySelector('[data-testid="count0"]')?.textContent
    const double0 = () => container.querySelector('[data-testid="double0"]')?.textContent
    const message0 = () => container.querySelector('[data-testid="message0"]')?.textContent
    const color0 = () =>
      (container.querySelector('[data-testid="branch0"]') as HTMLElement | null)?.style.color

    const count1 = () => container.querySelector('[data-testid="count1"]')?.textContent
    const double1 = () => container.querySelector('[data-testid="double1"]')?.textContent
    const message1 = () => container.querySelector('[data-testid="message1"]')?.textContent
    const color1 = () =>
      (container.querySelector('[data-testid="branch1"]') as HTMLElement | null)?.style.color

    await tick()
    expect(count0()).toBe('Count: 0')
    expect(double0()).toBe('Double: 0')
    expect(message0()).toBe('Keep going...')
    expect(color0()).toBe('black')
    expect(logSpy).not.toHaveBeenCalled()

    inc0()?.click()
    await tick()
    inc0()?.click()
    await tick()
    expect(count0()).toBe('Count: 2')
    expect(double0()).toBe('Double: 4')
    expect(message0()).toBe('Keep going...')
    expect(color0()).toBe('black')

    inc0()?.click()
    await tick()
    expect(count1()).toBe('Count1: 3')
    expect(double1()).toBe('Double1: 6')
    expect(message1()).toBe('Threshold Reached!')
    expect(color1()).toBe('red')
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenLastCalledWith('Just hit 3!')

    inc1()?.click()
    await tick()
    expect(count1()).toBe('Count1: 4')
    expect(double1()).toBe('Double1: 8')
    expect(message1()).toBe('Threshold Reached!')
    expect(color1()).toBe('red')
    expect(logSpy).toHaveBeenCalledTimes(1)

    dispose()
    logSpy.mockRestore()
  })

  it('keeps sequential if-return branches reactive (first branch included)', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state('a')

        if (mode === 'a') {
          return (
            <div data-testid="view-a">
              <span>A</span>
              <button data-testid="a-to-b" onClick={() => mode = 'b'}>to-b</button>
            </div>
          )
        }

        if (mode === 'b') {
          return (
            <div data-testid="view-b">
              <span>B</span>
              <button data-testid="b-to-c" onClick={() => mode = 'c'}>to-c</button>
            </div>
          )
        }

        return (
          <div data-testid="view-c">
            <span>Default</span>
            <button data-testid="c-to-a" onClick={() => mode = 'a'}>to-a</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')
    ;(container.querySelector('[data-testid="a-to-b"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-b"]')).not.toBeNull()
    expect(container.textContent).toContain('B')
    ;(container.querySelector('[data-testid="b-to-c"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-c"]')).not.toBeNull()
    expect(container.textContent).toContain('Default')
    ;(container.querySelector('[data-testid="c-to-a"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')

    dispose()
  })

  it('keeps switch-return branches reactive', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state('a')

        switch (mode) {
          case 'a':
            return (
              <div data-testid="view-a">
                <span>A</span>
                <button data-testid="a-to-b" onClick={() => mode = 'b'}>to-b</button>
              </div>
            )
          case 'b':
            return (
              <div data-testid="view-b">
                <span>B</span>
                <button data-testid="b-to-c" onClick={() => mode = 'c'}>to-c</button>
              </div>
            )
          default:
            return (
              <div data-testid="view-c">
                <span>Default</span>
                <button data-testid="c-to-a" onClick={() => mode = 'a'}>to-a</button>
              </div>
            )
        }
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')
    ;(container.querySelector('[data-testid="a-to-b"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-b"]')).not.toBeNull()
    expect(container.textContent).toContain('B')
    ;(container.querySelector('[data-testid="b-to-c"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-c"]')).not.toBeNull()
    expect(container.textContent).toContain('Default')
    ;(container.querySelector('[data-testid="c-to-a"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')

    dispose()
  })

  it('keeps switch-return branches reactive with case block wrappers', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state('a')

        switch (mode) {
          case 'a': {
            return (
              <div data-testid="view-a">
                <span>A</span>
                <button data-testid="a-to-b" onClick={() => mode = 'b'}>to-b</button>
              </div>
            )
          }
          case 'b': {
            return (
              <div data-testid="view-b">
                <span>B</span>
                <button data-testid="b-to-c" onClick={() => mode = 'c'}>to-c</button>
              </div>
            )
          }
          default:
            return (
              <div data-testid="view-c">
                <span>Default</span>
                <button data-testid="c-to-a" onClick={() => mode = 'a'}>to-a</button>
              </div>
            )
        }
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')
    ;(container.querySelector('[data-testid="a-to-b"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-b"]')).not.toBeNull()
    expect(container.textContent).toContain('B')
    ;(container.querySelector('[data-testid="b-to-c"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-c"]')).not.toBeNull()
    expect(container.textContent).toContain('Default')
    ;(container.querySelector('[data-testid="c-to-a"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')

    dispose()
  })

  it('keeps switch-return branches reactive with case block + trailing break', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state('a')

        switch (mode) {
          case 'a': {
            return (
              <div data-testid="view-a">
                <span>A</span>
                <button data-testid="a-to-b" onClick={() => mode = 'b'}>to-b</button>
              </div>
            )
          }
          break
          default:
            return (
              <div data-testid="view-b">
                <span>B</span>
                <button data-testid="b-to-a" onClick={() => mode = 'a'}>to-a</button>
              </div>
            )
        }
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    ;(container.querySelector('[data-testid="a-to-b"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-b"]')).not.toBeNull()
    ;(container.querySelector('[data-testid="b-to-a"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()

    dispose()
  })

  it('keeps non-empty switch fallthrough branches reactive', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state('a')

        switch (mode) {
          case 'a':
            'fallthrough'
          case 'b':
            return (
              <div data-testid="view-ab">
                <span>AB</span>
                <button data-testid="ab-to-c" onClick={() => mode = 'c'}>to-c</button>
              </div>
            )
          default:
            return (
              <div data-testid="view-c">
                <span>C</span>
                <button data-testid="c-to-a" onClick={() => mode = 'a'}>to-a</button>
              </div>
            )
        }
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    await tick()
    expect(container.querySelector('[data-testid="view-ab"]')).not.toBeNull()
    expect(container.textContent).toContain('AB')
    ;(container.querySelector('[data-testid="ab-to-c"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-c"]')).not.toBeNull()
    expect(container.textContent).toContain('C')
    ;(container.querySelector('[data-testid="c-to-a"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-ab"]')).not.toBeNull()
    expect(container.textContent).toContain('AB')

    dispose()
  })

  it('keeps switch-return branches reactive with complex discriminants', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state('a')

        switch (mode + '-v') {
          case 'a-v':
            return (
              <div data-testid="view-a">
                <span>A</span>
                <button data-testid="a-to-b" onClick={() => mode = 'b'}>to-b</button>
              </div>
            )
          default:
            return (
              <div data-testid="view-b">
                <span>B</span>
                <button data-testid="b-to-a" onClick={() => mode = 'a'}>to-a</button>
              </div>
            )
        }
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')
    ;(container.querySelector('[data-testid="a-to-b"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-b"]')).not.toBeNull()
    expect(container.textContent).toContain('B')
    ;(container.querySelector('[data-testid="b-to-a"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')

    dispose()
  })

  it('keeps try-return branches reactive', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state('a')

        try {
          if (mode === 'a') {
            return (
              <div data-testid="view-a">
                <span>A</span>
                <button data-testid="a-to-b" onClick={() => mode = 'b'}>to-b</button>
              </div>
            )
          }

          if (mode === 'b') {
            return (
              <div data-testid="view-b">
                <span>B</span>
                <button data-testid="b-to-c" onClick={() => mode = 'c'}>to-c</button>
              </div>
            )
          }

          return (
            <div data-testid="view-c">
              <span>Default</span>
              <button data-testid="c-to-a" onClick={() => mode = 'a'}>to-a</button>
            </div>
          )
        } catch (e) {
          return <div data-testid="view-e">Error</div>
        }
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')
    ;(container.querySelector('[data-testid="a-to-b"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-b"]')).not.toBeNull()
    expect(container.textContent).toContain('B')
    ;(container.querySelector('[data-testid="b-to-c"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-c"]')).not.toBeNull()
    expect(container.textContent).toContain('Default')
    ;(container.querySelector('[data-testid="c-to-a"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')
    expect(container.querySelector('[data-testid="view-e"]')).toBeNull()

    dispose()
  })

  it('keeps try-finally return branches reactive', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state('a')

        try {
          return <div data-testid="base">Base</div>
        } finally {
          if (mode === 'a') {
            return (
              <div data-testid="view-a">
                <span>A</span>
                <button data-testid="a-to-b" onClick={() => mode = 'b'}>to-b</button>
              </div>
            )
          }

          return (
            <div data-testid="view-b">
              <span>B</span>
              <button data-testid="b-to-a" onClick={() => mode = 'a'}>to-a</button>
            </div>
          )
        }
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)

    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')
    expect(container.querySelector('[data-testid="base"]')).toBeNull()
    ;(container.querySelector('[data-testid="a-to-b"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-b"]')).not.toBeNull()
    expect(container.textContent).toContain('B')
    ;(container.querySelector('[data-testid="b-to-a"]') as HTMLButtonElement).click()
    await tick()
    expect(container.querySelector('[data-testid="view-a"]')).not.toBeNull()
    expect(container.textContent).toContain('A')

    dispose()
  })

  it('preserves switch break semantics before trailing return', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state(0)
        let label = 'A'

        switch (mode) {
          case 0:
            label = 'A'
            break
          case 1:
            label = 'B'
            break
          default:
            label = 'D'
            break
        }

        return (
          <button data-testid="cycle" onClick={() => mode = (mode + 1) % 3}>
            {label}-{mode}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    const cycle = () => container.querySelector('[data-testid="cycle"]') as HTMLButtonElement

    await tick()
    expect(cycle().textContent).toContain('A-0')

    cycle().click()
    await tick()
    expect(cycle().textContent).toContain('B-1')

    cycle().click()
    await tick()
    expect(cycle().textContent).toContain('D-2')

    cycle().click()
    await tick()
    expect(cycle().textContent).toContain('A-0')

    dispose()
  })

  it('preserves switch break semantics with case block wrappers before trailing return', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Switcher() {
        let mode = $state(0)
        let label = 'A'

        switch (mode) {
          case 0: {
            label = 'A'
            break
          }
          case 1: {
            label = 'B'
            break
          }
          default: {
            label = 'D'
            break
          }
        }

        return (
          <button data-testid="cycle" onClick={() => mode = (mode + 1) % 3}>
            {label}-{mode}
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Switcher />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source)
    const dispose = mod.mount(container)
    const cycle = () => container.querySelector('[data-testid="cycle"]') as HTMLButtonElement

    await tick()
    expect(cycle().textContent).toContain('A-0')

    cycle().click()
    await tick()
    expect(cycle().textContent).toContain('B-1')

    cycle().click()
    await tick()
    expect(cycle().textContent).toContain('D-2')

    cycle().click()
    await tick()
    expect(cycle().textContent).toContain('A-0')

    dispose()
  })
})
