// @vitest-environment jsdom

import { createRequire } from 'module'

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import * as runtime from '@fictjs/runtime'
import { type FictCompilerOptions } from '../index'
import { transformCommonJS } from './test-utils'

const { addEventListener: originalAdd, removeEventListener: originalRemove } = HTMLElement.prototype

function compileAndLoad<TModule extends Record<string, any>>(
  source: string,
  options?: FictCompilerOptions,
): TModule {
  const output = transformCommonJS(source, options)

  const module: { exports: any } = { exports: {} }
  const prelude =
    "const __fictRuntime = require('@fictjs/runtime');" +
    'const { createSignal: __fictSignal, createMemo: __fictMemo, createEffect: __fictEffect, createConditional: __fictConditional, createList: __fictList, createKeyedList: __fictKeyedList, insert: __fictInsert, createElement: __fictCreateElement, onDestroy: __fictOnDestroy, bindText: __fictBindText, bindAttribute: __fictBindAttribute, bindClass: __fictBindClass, bindStyle: __fictBindStyle, bindEvent: __fictBindEvent, toNodeArray: __fictToNodeArray } = __fictRuntime;'

  const dynamicRequire = createRequire(import.meta.url)

  const wrapped = new Function('require', 'module', 'exports', `${prelude}\n${output}`)
  wrapped(
    (id: string) => {
      if (id === 'fict') return runtime
      if (id === '@fictjs/runtime') return runtime
      return dynamicRequire(id)
    },
    module,
    module.exports,
  )

  return module.exports as TModule
}

async function flushUpdates(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('dynamic event handlers', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    HTMLElement.prototype.addEventListener = originalAdd
    HTMLElement.prototype.removeEventListener = originalRemove
    document.body.innerHTML = ''
  })

  it('swaps event handlers when state changes', async () => {
    const source = `
      import { $state, render } from 'fict'

      export const log: string[] = []

      export function App() {
        let mode = $state('A')

        function handlerA() { log.push('A') }
        function handlerB() { log.push('B') }

        return (
          <div>
            <button data-id="btn" onClick={mode === 'A' ? handlerA : handlerB}>
              Click
            </button>
            <button data-id="toggle" onClick={() => (mode = mode === 'A' ? 'B' : 'A')}>
              Toggle
            </button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      log: string[]
    }>(source, { fineGrainedDom: true })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const btn = container.querySelector('[data-id="btn"]') as HTMLButtonElement
    const toggle = container.querySelector('[data-id="toggle"]') as HTMLButtonElement

    // Initial state A
    btn.click()
    expect(mod.log).toEqual(['A'])
    mod.log.length = 0

    // Switch to B
    toggle.click()
    await flushUpdates()

    // Should behave as B
    btn.click()
    expect(mod.log).toEqual(['B'])

    teardown()
    container.remove()
  })

  it('supports capture/passive options and cleans up on dispose', async () => {
    const addCalls: any[] = []
    const removeCalls: any[] = []
    HTMLElement.prototype.addEventListener = function (type: any, handler: any, options: any) {
      addCalls.push({ type, handler, options })
      return originalAdd.call(this, type, handler, options)
    }
    HTMLElement.prototype.removeEventListener = function (type: any, handler: any, options: any) {
      removeCalls.push({ type, handler, options })
      return originalRemove.call(this, type, handler, options)
    }

    const source = `
      import { render } from 'fict'

      function App() {
        const handler = () => {}
        return <button data-id="btn" onClickCapturePassive={handler}>Click</button>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      fineGrainedDom: true,
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const dispose = mod.mount(container)

    expect(addCalls.length).toBeGreaterThan(0)
    const call = addCalls[0]
    expect(call.type).toBe('click')
    expect(call.options?.capture).toBe(true)
    expect(call.options?.passive).toBe(true)

    dispose()
    expect(removeCalls.length).toBeGreaterThan(0)
    const remove = removeCalls[0]
    expect(remove.type).toBe('click')
    expect(remove.options?.capture).toBe(true)
    expect(remove.options?.passive).toBe(true)

    container.remove()
  })

  it('supports once modifier', async () => {
    const addCalls: any[] = []
    HTMLElement.prototype.addEventListener = function (type: any, handler: any, options: any) {
      addCalls.push({ type, handler, options })
      return originalAdd.call(this, type, handler, options)
    }

    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      function App() {
        return <button data-id="btn" onClickOnce={() => log.push('clicked')}>Click</button>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      log: string[]
    }>(source, { fineGrainedDom: true })

    const container = document.createElement('div')
    document.body.appendChild(container)
    mod.mount(container)

    // Verify once option is passed
    expect(addCalls.length).toBeGreaterThan(0)
    const call = addCalls[0]
    expect(call.type).toBe('click')
    expect(call.options?.once).toBe(true)

    // Click should work first time
    const btn = container.querySelector('[data-id="btn"]') as HTMLButtonElement
    btn.click()
    expect(mod.log).toEqual(['clicked'])

    // Second click should not trigger (once modifier)
    btn.click()
    expect(mod.log).toEqual(['clicked'])

    container.remove()
  })

  it('handles null/undefined handlers gracefully', async () => {
    const addCalls: any[] = []
    HTMLElement.prototype.addEventListener = function (type: any, handler: any, options: any) {
      addCalls.push({ type, handler, options })
      return originalAdd.call(this, type, handler, options)
    }

    const source = `
      import { $state, render } from 'fict'

      export function App() {
        let enabled = $state(false)
        const handler = enabled ? () => console.log('click') : null

        return <button data-id="btn" onClick={handler}>Click</button>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      fineGrainedDom: true,
    })

    const container = document.createElement('div')
    document.body.appendChild(container)

    // Should not throw even with null handler
    expect(() => mod.mount(container)).not.toThrow()

    container.remove()
  })
})
