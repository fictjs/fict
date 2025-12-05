// @vitest-environment jsdom

import { createRequire } from 'module'

import ts from 'typescript'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import * as runtime from '../../../runtime/src'
import * as runtimeJsx from '../../../runtime/src/jsx-runtime'
import { createFictTransformer, type FictCompilerOptions } from '../index'

function compileAndLoad<TModule extends Record<string, any>>(
  source: string,
  options?: FictCompilerOptions,
): TModule {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: 'fict-runtime',
    },
    transformers: {
      before: [createFictTransformer(null, options)],
    },
  })

  // Debug output - uncomment to see generated code
  // if (source.includes('todo')) {
  //   console.log('=== Generated Code ===')
  //   console.log(result.outputText)
  //   console.log('======================')
  // }

  const module: { exports: any } = { exports: {} }
  const prelude =
    "const __fictRuntime = require('fict-runtime');" +
    'const { createSignal: __fictSignal, createMemo: __fictMemo, createEffect: __fictEffect, createConditional: __fictConditional, createList: __fictList, createKeyedList: __fictKeyedList, insert: __fictInsert, createElement: __fictCreateElement, onDestroy: __fictOnDestroy, bindText: __fictBindText, bindAttribute: __fictBindAttribute, bindClass: __fictBindClass, bindStyle: __fictBindStyle, toNodeArray: __fictToNodeArray } = __fictRuntime;'

  const dynamicRequire = createRequire(import.meta.url)

  const wrapped = new Function('require', 'module', 'exports', `${prelude}\n${result.outputText}`)
  wrapped(
    (id: string) => {
      if (id === 'fict-runtime') return runtime
      if (id === 'fict-runtime/jsx-runtime') return runtimeJsx
      if (id === 'fict') return runtime
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

describe('compiled templates DOM integration', () => {
  beforeEach(async () => {
    // Clear document before each test
    document.body.innerHTML = ''
  })

  afterEach(async () => {
    // Clear any remaining containers from document.body
    document.body.innerHTML = ''
  })

  it('mounts and cleans up fragment output produced via insert', { timeout: 10000 }, async () => {
    const source = `
      import { $state, onDestroy } from 'fict'
      import { render } from 'fict'

      export const destroyed: string[] = []
      export let api: { toggle(): void }

      function Child() {
        onDestroy(() => destroyed.push('child'))
        return (
          <>
            <span data-id="a">A</span>
            <span data-id="b">B</span>
          </>
        )
      }

      export function App() {
        let show = $state(true)
        api = { toggle: () => (show = !show) }
        const content = show ? <Child /> : null
        return <div>{content}</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { toggle(): void }
      destroyed: string[]
    }>(source, { fineGrainedDom: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    expect(container.querySelectorAll('span').length).toBe(2)

    mod.api.toggle()
    await flushUpdates()
    expect(container.querySelectorAll('span').length).toBe(0)
    expect(mod.destroyed).toEqual(['child'])

    teardown()
    await flushUpdates()
    expect(container.innerHTML).toBe('')
    container.remove()
  })

  it('keeps todo list DOM in sync with keyed state updates', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render } from 'fict'

      type Todo = { id: number; text: string }

      export let api: {
        rotate(): void
        prepend(): void
        dropSecond(): void
      }

      export function App() {
        let todos = $state<Todo[]>([
          { id: 1, text: 'wake up' },
          { id: 2, text: 'hydrate' },
          { id: 3, text: 'ship code' },
        ])

        api = {
          rotate() {
            if (todos.length < 2) return
            const [first, ...rest] = todos
            todos = [...rest, first]
          },
          prepend() {
            todos = [
              { id: 0, text: 'stretch' },
              ...todos,
            ]
          },
          dropSecond() {
            todos = todos.filter(todo => todo.id !== 2)
          },
        }

        return (
          <ul data-testid="todos">
            {todos.map(todo => (
              <li key={todo.id} data-id={todo.id}>
                <span className="text">{todo.text}</span>
              </li>
            ))}
          </ul>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { rotate(): void; prepend(): void; dropSecond(): void }
    }>(source, { fineGrainedDom: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const readIds = () =>
      Array.from(container.querySelectorAll('li')).map(li => Number(li.getAttribute('data-id')))

    const readTexts = () =>
      Array.from(container.querySelectorAll('li')).map(li => li.textContent?.trim())

    await flushUpdates()
    expect(readIds()).toEqual([1, 2, 3])
    expect(readTexts()).toEqual(['wake up', 'hydrate', 'ship code'])

    mod.api.rotate()
    await flushUpdates()
    expect(readIds()).toEqual([2, 3, 1])

    mod.api.prepend()
    await flushUpdates()
    expect(readIds()).toEqual([0, 2, 3, 1])
    expect(readTexts()[0]).toBe('stretch')

    mod.api.dropSecond()
    await flushUpdates()
    expect(readIds()).toEqual([0, 3, 1])

    teardown()
    container.remove()
  })

  it(
    'lazily evaluates branch-only derived regions when conditionally rendered',
    { timeout: 10000 },
    async () => {
      const source = `
      import { $state, render } from 'fict'

      export const computeLog: string[] = []

      function record(label: string, value: number) {
        computeLog.push(label + ':' + value)
        return label + '=' + value
      }

      export function App() {
        let count = $state(0)
        const fallbackSummary = record('fallback', count)
        const richStats = record('rich-stats', count * 10)
        const richBadge = record('rich-badge', count + 1000)

        return (
          <section data-mode={count > 1 ? 'rich' : 'fallback'}>
            {count > 1 ? (
              <div data-id="rich">
                <span data-id="stats">{richStats}</span>
                <span data-id="badge">{richBadge}</span>
              </div>
            ) : (
              <p data-id="fallback">{fallbackSummary}</p>
            )}
            <button data-id="inc" onClick={() => count++}>inc</button>
            <button data-id="reset" onClick={() => (count = 0)}>reset</button>
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        computeLog.length = 0
        return render(() => <App />, el)
      }
    `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        computeLog: string[]
      }>(source, { lazyConditional: true, fineGrainedDom: false })
      const container = document.createElement('div')
      document.body.appendChild(container)
      const teardown = mod.mount(container)

      const activeBranch = () => (container.querySelector('[data-id="rich"]') ? 'rich' : 'fallback')
      const fallbackText = () =>
        container.querySelector('[data-id="fallback"]')?.textContent?.trim() ?? ''
      const richText = () => ({
        stats: container.querySelector('[data-id="stats"]')?.textContent?.trim() ?? '',
        badge: container.querySelector('[data-id="badge"]')?.textContent?.trim() ?? '',
      })
      const incButton = container.querySelector('[data-id="inc"]') as HTMLButtonElement
      const resetButton = container.querySelector('[data-id="reset"]') as HTMLButtonElement
      const clearLog = () => {
        mod.computeLog.length = 0
      }
      const entriesStartWith = (prefix: string) =>
        mod.computeLog.every(entry => entry.startsWith(prefix))

      expect(activeBranch()).toBe('fallback')
      expect(fallbackText()).toContain('fallback=0')
      expect(mod.computeLog.length).toBeGreaterThan(0)
      expect(entriesStartWith('fallback')).toBe(true)
      clearLog()

      incButton.click()
      await flushUpdates()
      await flushUpdates()
      expect(activeBranch()).toBe('fallback')
      expect(mod.computeLog.some(entry => entry.startsWith('rich'))).toBe(false)
      expect(entriesStartWith('fallback')).toBe(true)
      clearLog()

      incButton.click()
      await flushUpdates()
      await flushUpdates()
      expect(activeBranch()).toBe('rich')
      const rich = richText()
      expect(rich.stats).toContain('rich-stats=20')
      expect(rich.badge).toContain('rich-badge')
      expect(mod.computeLog.length).toBeGreaterThan(0)
      expect(entriesStartWith('rich')).toBe(true)
      expect(mod.computeLog.some(entry => entry.startsWith('rich-stats'))).toBe(true)
      expect(mod.computeLog.some(entry => entry.startsWith('rich-badge'))).toBe(true)
      clearLog()

      resetButton.click()
      await flushUpdates()
      expect(activeBranch()).toBe('fallback')
      expect(fallbackText()).toContain('fallback=0')
      expect(entriesStartWith('fallback')).toBe(true)

      teardown()
      container.remove()
    },
  )

  it('keeps async $effect boundaries from committing stale data', { timeout: 10000 }, async () => {
    const source = `
      import { $state, $effect, render } from 'fict'

      const pending: Array<() => void> = []
      export function flushPending() {
        while (pending.length) {
          const task = pending.shift()
          if (task) task()
        }
      }

      export const effectLog: string[] = []

      export function App() {
        let count = $state(0)

        $effect(() => {
          let cancelled = false
          const snapshot = count
          pending.push(() => {
            if (!cancelled) {
              effectLog.push('commit:' + snapshot)
            }
          })
          return () => {
            cancelled = true
          }
        })

        return (
          <div>
            <button data-id="increment" onClick={() => count++}>inc</button>
            <p data-id="value">{count}</p>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      effectLog: string[]
      flushPending(): void
    }>(source, { fineGrainedDom: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const incButton = container.querySelector('[data-id="increment"]') as HTMLButtonElement

    await flushUpdates()
    await flushUpdates()
    mod.flushPending()
    expect(mod.effectLog).toEqual(['commit:0'])
    mod.effectLog.length = 0

    incButton.click()
    incButton.click()
    await flushUpdates()
    await flushUpdates()
    mod.flushPending()

    expect(mod.effectLog).toEqual(['commit:2'])
    expect(container.querySelector('[data-id="value"]')?.textContent).toBe('2')

    teardown()
    container.remove()
  })

  it('exposes latest state to DOM event handlers', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render } from 'fict'

      export const eventLog: number[] = []

      export function App() {
        let count = $state(0)

        return (
          <div>
            <button data-id="inc" onClick={() => count++}>inc</button>
            <button data-id="read" onClick={() => eventLog.push(count)}>read</button>
            <p data-id="value">{count}</p>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        eventLog.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      eventLog: number[]
    }>(source, { fineGrainedDom: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const incButton = container.querySelector('[data-id="inc"]') as HTMLButtonElement
    const readButton = container.querySelector('[data-id="read"]') as HTMLButtonElement
    const value = () => container.querySelector('[data-id="value"]')?.textContent

    readButton.click()
    expect(mod.eventLog).toEqual([0])

    incButton.click()
    await flushUpdates()
    expect(value()).toBe('1')

    readButton.click()
    expect(mod.eventLog).toEqual([0, 1])

    incButton.click()
    await flushUpdates()
    expect(value()).toBe('2')

    readButton.click()
    expect(mod.eventLog).toEqual([0, 1, 2])
    expect(mod.eventLog.every(entry => typeof entry === 'number')).toBe(true)

    teardown()
    await flushUpdates()
    container.remove()
  })

  it('updates DOM via fine-grained bindings when enabled', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { inc(): void }

      export function App() {
        let count = $state(1)
        api = { inc: () => (count = count + 1) }

        return (
          <section
            data-mode={count > 1 ? 'many' : 'single'}
            class={count > 1 ? 'large' : 'small'}
            style={{ opacity: count / 10 }}
          >
            <p data-id="value">{count}</p>
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { inc(): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const section = () => container.querySelector('section') as HTMLElement
    const valueNode = () => container.querySelector('[data-id="value"]')!

    expect(section().dataset.mode).toBe('single')
    expect(section().className).toBe('small')
    expect(section().style.opacity).toBe('0.1')
    expect(valueNode().textContent).toBe('1')

    mod.api.inc()
    await flushUpdates()
    expect(section().dataset.mode).toBe('many')
    expect(section().className).toBe('large')
    expect(section().style.opacity).toBe('0.2')
    expect(valueNode().textContent).toBe('2')

    teardown()
    container.remove()
  })

  it('wires event handlers in fine-grained mode', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render } from 'fict'

      export function App() {
        let count = $state(0)

        return (
          <div>
            <button data-id="inc" onClick={() => count++}>inc</button>
            <p data-id="value">{count}</p>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const incButton = container.querySelector('[data-id="inc"]') as HTMLButtonElement
    const value = () => container.querySelector('[data-id="value"]')?.textContent

    expect(value()).toBe('0')

    incButton.click()
    await flushUpdates()

    expect(value()).toBe('1')

    teardown()
    container.remove()
  })
})
