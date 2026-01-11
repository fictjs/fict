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
      if (id === '@fictjs/runtime/internal') return runtimeInternal
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
})
