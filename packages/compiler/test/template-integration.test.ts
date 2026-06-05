// @vitest-environment jsdom

import { createRequire } from 'module'

import * as runtime from '@fictjs/runtime'
import * as runtimeInternal from '@fictjs/runtime/internal'
import * as runtimeInternalList from '@fictjs/runtime/internal/list'
import * as runtimeJsx from '@fictjs/runtime/jsx-runtime'
import { clearDelegatedEvents, __fictResetContext } from '@fictjs/runtime/internal'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { type FictCompilerOptions } from '../src/index'

import { transformCommonJS } from './test-utils'

function compileAndLoad<TModule extends Record<string, any>>(
  source: string,
  options?: FictCompilerOptions,
): TModule {
  const output = transformCommonJS(source, options)
  if (process.env.DEBUG_TEMPLATE_OUTPUT) {
    // eslint-disable-next-line no-console
    console.log(output)
  }

  const module: { exports: any } = { exports: {} }
  const dynamicRequire = createRequire(import.meta.url)

  // Compiled code follows the source package family for internal helpers.
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal') {
        return runtimeInternal
      }
      if (id === '@fictjs/runtime/internal/list' || id === 'fict/internal/list') {
        return runtimeInternalList
      }
      if (id.startsWith('@fictjs/runtime/internal/') || id.startsWith('fict/internal/')) {
        throw new Error(`Unexpected internal subpath in test sandbox: ${id}`)
      }
      if (id === '@fictjs/runtime') return runtime
      if (id === '@fictjs/runtime/jsx-runtime' || id === 'fict/jsx-runtime') return runtimeJsx
      if (id === 'fict') return runtime
      return dynamicRequire(id)
    },
    module,
    module.exports,
  )

  return module.exports as TModule
}

async function flushUpdates(): Promise<void> {
  // Drain microtasks and one macrotask to let reactive queues and timers settle.
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function flushMicrotasks(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

describe('compiled templates DOM integration', () => {
  beforeEach(async () => {
    // Clear document before each test
    document.body.innerHTML = ''
    // Reset runtime state before each test
    clearDelegatedEvents()
    __fictResetContext()
  })

  afterEach(async () => {
    // Clear any remaining containers from document.body
    document.body.innerHTML = ''
    // Reset runtime state between tests
    clearDelegatedEvents()
    __fictResetContext()
  })

  it('preserves object literal getter/setter semantics at runtime', () => {
    const source = `
      export function run() {
        const obj = {
          _v: 0,
          get value() {
            return this._v + 1
          },
          set value(v) {
            this._v = v * 2
          },
        }
        obj.value = 2
        return { raw: obj._v, computed: obj.value }
      }
    `

    const mod = compileAndLoad<{ run: () => { raw: number; computed: number } }>(source)
    const result = mod.run()
    expect(result).toEqual({ raw: 4, computed: 5 })
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
    }>(source, { fineGrainedDom: true })
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

  it('applies destructured prop defaults only for undefined values', async () => {
    const source = `
      import { render } from 'fict'

      function Greeting({ name = 'Anon' }: { name?: string | null }) {
        return <span data-testid="name">{name}</span>
      }

      export function mount(el: HTMLElement) {
        return render(() => (
          <>
            <Greeting name={null} />
            <Greeting name={undefined} />
            <Greeting />
          </>
        ), el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()
    const names = Array.from(container.querySelectorAll('[data-testid="name"]')).map(
      node => node.textContent,
    )
    expect(names).toEqual(['', 'Anon', 'Anon'])

    teardown()
    container.remove()
  })

  it('keeps function-as-child callbacks inert when passed to components', async () => {
    const source = `
      import { render } from 'fict'

      function Layout(props: { children?: unknown }) {
        return <section data-testid="layout">{props.children}</section>
      }

      export function App() {
        return <Layout>{() => <span data-testid="slot">slot</span>}</Layout>
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

    await flushUpdates()
    expect(container.querySelector('[data-testid="layout"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="slot"]')).toBeNull()

    teardown()
    container.remove()
  })

  it('preserves runtime map() callback errors instead of crashing during compilation', () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [1, 2, 3]
        return <div>{items.map()}</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')

    expect(() => mod.mount(container)).toThrow(TypeError)
  })

  it('applies intrinsic spread in fine-grained mode and preserves attribute/event ordering', async () => {
    const source = `
      import { $state, render } from 'fict'

      export const calls: string[] = []
      export let api: {
        clear(): void
        tuple(): void
        fn(): void
      }

      export function App() {
        let attrs = $state<any>({
          'data-role': 'dynamic-1',
          'data-id': 'one',
          onClick: () => calls.push('one'),
        })

        api = {
          clear() {
            attrs = {}
          },
          tuple() {
            attrs = {
              'data-role': 'dynamic-2',
              onClick: [((id: unknown) => calls.push(String(id))), 'row-2'],
            }
          },
          fn() {
            attrs = {
              'data-role': 'dynamic-3',
              onClick: () => calls.push('fn'),
            }
          },
        }

        return (
          <button {...attrs} data-role="fixed" type="button">
            Press
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { clear(): void; tuple(): void; fn(): void }
      calls: string[]
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const button = container.querySelector('button') as HTMLButtonElement

    expect(button).toBeTruthy()
    expect(button.getAttribute('data-role')).toBe('fixed')
    expect(button.getAttribute('type')).toBe('button')

    button.dispatchEvent(new Event('click', { bubbles: true }))
    expect(mod.calls).toEqual(['one'])

    mod.api.clear()
    await flushUpdates()
    button.dispatchEvent(new Event('click', { bubbles: true }))
    expect(mod.calls).toEqual(['one'])

    mod.api.tuple()
    await flushUpdates()
    expect(button.getAttribute('data-role')).toBe('fixed')
    button.dispatchEvent(new Event('click', { bubbles: true }))
    expect(mod.calls).toEqual(['one', 'row-2'])

    mod.api.fn()
    await flushUpdates()
    expect(button.getAttribute('data-role')).toBe('fixed')
    button.dispatchEvent(new Event('click', { bubbles: true }))
    expect(mod.calls).toEqual(['one', 'row-2', 'fn'])

    teardown()
    container.remove()
  })

  it('routes compiled delegated event errors through ErrorBoundary', async () => {
    const source = `
      import { ErrorBoundary, render } from 'fict'

      export let captured: string | null = null

      export function App() {
        return (
          <ErrorBoundary
            fallback="event-fallback"
            onError={err => {
              captured = err instanceof Error ? err.message : String(err)
            }}
          >
            <button type="button" onClick={() => { throw new Error('compiled event boom') }}>
              Press
            </button>
          </ErrorBoundary>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      captured: string | null
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const button = container.querySelector('button') as HTMLButtonElement
    expect(button).toBeTruthy()

    button.dispatchEvent(new Event('click', { bubbles: true }))
    await flushUpdates()

    expect(mod.captured).toBe('compiled event boom')
    expect(container.textContent).toBe('event-fallback')

    teardown()
    container.remove()
  })

  it('handles compiled delegated events in foreign documents', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      export function App() {
        return (
          <button type="button" onClick={() => calls.push('clicked')}>
            Press
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      calls: string[]
    }>(source, { fineGrainedDom: true })
    const foreignDoc = document.implementation.createHTMLDocument('foreign-compiled-events')
    const container = foreignDoc.createElement('div')
    foreignDoc.body.appendChild(container)
    const teardown = mod.mount(container as unknown as HTMLElement)

    const button = container.querySelector('button') as HTMLButtonElement
    expect(button).toBeTruthy()

    button.dispatchEvent(new Event('click', { bubbles: true }))
    await flushUpdates()

    expect(mod.calls).toEqual(['clicked'])

    teardown()
    clearDelegatedEvents(foreignDoc)
  })

  it('forwards children props through intrinsic spread when no explicit host children exist', async () => {
    const source = `
      import { render } from 'fict'

      function Box(props: any) {
        return <div data-testid="box" {...props} />
      }

      export function App() {
        return <Box children="hello" />
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
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(container.textContent).toBe('hello')
    expect(box.innerHTML).toBe('hello')
    expect(Array.from(box.childNodes).map(node => node.nodeType)).toEqual([Node.TEXT_NODE])

    teardown()
    container.remove()
  })

  it('sets dangerouslySetInnerHTML in fine-grained intrinsic output', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return <div data-testid="box" dangerouslySetInnerHTML={{ __html: '<span>x</span>' }} />
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
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(box.innerHTML).toBe('<span>x</span>')
    expect(box.hasAttribute('dangerouslysetinnerhtml')).toBe(false)

    teardown()
    container.remove()
  })

  it('updates reactive dangerouslySetInnerHTML in fine-grained intrinsic output', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: string): void }

      export function App() {
        let html = $state('<span>a</span>')
        api = { set: value => (html = value) }
        return <div data-testid="box" dangerouslySetInnerHTML={{ __html: html }} />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { set(value: string): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(box.innerHTML).toBe('<span>a</span>')

    mod.api.set('<em>b</em>')
    await flushUpdates()
    expect(box.innerHTML).toBe('<em>b</em>')

    teardown()
    container.remove()
  })

  it('keeps missing dangerouslySetInnerHTML __html from writing an attribute', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return <div data-testid="box" dangerouslySetInnerHTML={{}} />
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
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(box.innerHTML).toBe('')
    expect(box.hasAttribute('dangerouslysetinnerhtml')).toBe(false)

    teardown()
    container.remove()
  })

  it('rejects dangerouslySetInnerHTML with explicit JSX children', () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return <div dangerouslySetInnerHTML={{ __html: '<span>x</span>' }}>child</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    expect(() => compileAndLoad(source, { fineGrainedDom: true })).toThrow(
      /cannot be used with JSX children/,
    )
  })

  it('renders static boolean and null JSX expression children as empty text', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return (
          <div data-testid="box">
            {false}
            {true}
            {null}
            {void 0}
            {0}
            {''}
          </div>
        )
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
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(box.textContent).toBe('0')

    teardown()
    container.remove()
  })

  it('renders reactive boolean JSX text children as empty text', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: boolean | number): void }

      export function App() {
        let value = $state<boolean | number>(true)
        api = { set: next => (value = next) }
        return <div data-testid="box">{value}</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { set(value: boolean | number): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(box.textContent).toBe('')

    mod.api.set(false)
    await flushUpdates()
    expect(box.textContent).toBe('')

    mod.api.set(0)
    await flushUpdates()
    expect(box.textContent).toBe('0')

    teardown()
    container.remove()
  })

  it('formats conditional JSX text children with runtime child semantics', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { toggle(): void }

      export function App() {
        let show = $state(true)
        api = { toggle: () => (show = !show) }
        return <div data-testid="box">{show ? true : 0}</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { toggle(): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(box.textContent).toBe('')

    mod.api.toggle()
    await flushUpdates()
    expect(box.textContent).toBe('0')

    teardown()
    container.remove()
  })

  it('keeps adjacent text around empty JSX expression children', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return <div data-testid="box">A{true}B{false}C{null}D{0}</div>
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
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(box.textContent).toBe('ABCD0')

    teardown()
    container.remove()
  })

  it('keeps non-enumerable spread props hidden from merged component props', async () => {
    const source = `
      import { render } from 'fict'

      export const seen: {
        keys: string[]
        secret: unknown
        descriptor: PropertyDescriptor | undefined
      } = {
        keys: [],
        secret: undefined,
        descriptor: undefined,
      }

      function Child(props: Record<string, unknown>) {
        seen.keys = Object.keys(props)
        seen.secret = props.secret
        seen.descriptor = Object.getOwnPropertyDescriptor(props, 'secret')
        return <div data-testid="box">{seen.keys.join(',') + ':' + String(seen.secret)}</div>
      }

      export function App() {
        const hidden = {}
        Object.defineProperty(hidden, 'secret', { value: 'x', enumerable: false })
        return <Child {...hidden} visible="y" />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      seen: {
        keys: string[]
        secret: unknown
        descriptor: PropertyDescriptor | undefined
      }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(mod.seen.keys).toEqual(['visible'])
    expect(mod.seen.secret).toBeUndefined()
    expect(mod.seen.descriptor).toBeUndefined()
    expect(box.textContent).toBe('visible:undefined')

    teardown()
    container.remove()
  })

  it('does not invoke function-valued intrinsic spread expressions', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      const spreadFn = () => {
        log.push('called')
        return { 'data-from-fn': 'x' }
      }

      export function App() {
        return <div {...spreadFn} data-role="fixed">SpreadFn</div>
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
    await flushUpdates()

    const el = container.querySelector('div') as HTMLDivElement
    expect(el.getAttribute('data-role')).toBe('fixed')
    expect(el.hasAttribute('data-from-fn')).toBe(false)
    expect(mod.log).toEqual([])

    teardown()
    container.remove()
  })

  it('preserves optional map short-circuiting for callback argument evaluation', async () => {
    const source = `
      import { $state, render } from 'fict'

      export const calls: string[] = []

      function makeMapper() {
        calls.push('factory')
        return (item: number) => <li key={item}>{item}</li>
      }

      export function App() {
        let items = $state<number[] | null>(null)
        return <ul>{items?.map(makeMapper())}</ul>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      calls: string[]
    }>(source, { fineGrainedDom: true })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    expect(mod.calls).toEqual([])

    teardown()
    container.remove()
  })

  it('preserves optional map callback array third argument semantics', async () => {
    const source = `
      import { $state, render } from 'fict'

      export const seen: number[] = []
      export let api: { set(next: number[] | null): void }

      const cb = (item: number, index: number, source: number[]) => {
        seen.push(source.length)
        return <li key={item}>{item}</li>
      }

      export function App() {
        let items = $state<number[] | null>(null)
        api = {
          set(next) {
            items = next
          },
        }
        return <ul>{items?.map(cb)}</ul>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { set(next: number[] | null): void }
      seen: number[]
    }>(source, { fineGrainedDom: true })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    expect(mod.seen).toEqual([])

    mod.api.set([10, 20])
    await flushUpdates()

    expect(mod.seen).toEqual([2, 2])

    teardown()
    container.remove()
  })

  it('preserves map thisArg semantics by falling back from list specialization', async () => {
    const source = `
      import { render } from 'fict'

      const scope = { prefix: 'item-' }

      function renderItem(this: typeof scope, item: number) {
        return <li key={item}>{this.prefix + item}</li>
      }

      export function App() {
        const items = [1, 2]
        return <ul>{items.map(renderItem, scope)}</ul>
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
    await flushUpdates()

    expect(Array.from(container.querySelectorAll('li')).map(node => node.textContent)).toEqual([
      'item-1',
      'item-2',
    ])

    teardown()
    container.remove()
  })

  it('preserves runtime errors for obviously non-callable map callbacks', () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [1, 2]
        return <div>{items.map(123)}</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')

    expect(() => mod.mount(container)).toThrow(TypeError)
  })

  it('preserves map callback arguments semantics by falling back from list specialization', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [10, 20]
        function cb(item: number) {
          return String(arguments[2].length)
        }
        return <div>{items.map(cb)}</div>
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
    await flushUpdates()

    expect(container.textContent).toBe('22')

    teardown()
    container.remove()
  })

  it('renders repeated local JSX helper calls without collapsing DOM nodes', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        function row(label: string) {
          return <li>{label}</li>
        }
        return <ul>{row('a')}{row('b')}</ul>
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
    await flushUpdates()

    expect(Array.from(container.querySelectorAll('li')).map(node => node.textContent)).toEqual([
      'a',
      'b',
    ])

    teardown()
    container.remove()
  })

  it('renders named JSX map callbacks for each item', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [1, 2]
        function cb(item: number) {
          return <li key={item}>{item}</li>
        }
        return <ul>{items.map(cb)}</ul>
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
    await flushUpdates()

    expect(Array.from(container.querySelectorAll('li')).map(node => node.textContent)).toEqual([
      '1',
      '2',
    ])

    teardown()
    container.remove()
  })

  it('preserves destructured map callback semantics by falling back from list specialization', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [{ x: 1 }, { x: 2 }]
        return <ul>{items.map(({ x }) => <li>{x}</li>)}</ul>
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
    await flushUpdates()

    expect(Array.from(container.querySelectorAll('li')).map(node => node.textContent)).toEqual([
      '1',
      '2',
    ])

    teardown()
    container.remove()
  })

  it('preserves defaulted map callback semantics by falling back from list specialization', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [1, undefined]
        return <ul>{items.map((item = 5) => <li>{item}</li>)}</ul>
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
    await flushUpdates()

    expect(Array.from(container.querySelectorAll('li')).map(node => node.textContent)).toEqual([
      '1',
      '5',
    ])

    teardown()
    container.remove()
  })

  it('preserves function callback this semantics by falling back from list specialization', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [1, 2]
        return <div>{items.map(function (item) { return this === undefined ? String(item) : 'bad' })}</div>
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
    await flushUpdates()

    expect(container.textContent).toBe('12')

    teardown()
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
    }>(source, { fineGrainedDom: true })
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

  it('updates every 10th row label in keyed tables', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { update(): void }

      export function App() {
        let rows = $state(
          Array.from({ length: 20 }, (_, i) => ({ id: i + 1, label: 'row ' + (i + 1) })),
        )

        api = {
          update() {
            rows = rows.map((row, idx) =>
              idx % 10 === 0 ? { ...row, label: row.label + ' !!!' } : row,
            )
          },
        }

        return (
          <table>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td class="lbl" data-id={row.id}>{row.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { update(): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()
    mod.api.update()
    await flushUpdates()

    const labels = Array.from(container.querySelectorAll('.lbl')).map(
      node => node.textContent?.trim() ?? '',
    )

    expect(labels.length).toBe(20)
    expect(labels[0]).toContain('!!!')
    expect(labels[10]).toContain('!!!')
    expect(labels.some(text => text.includes('NaN'))).toBe(false)

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
      export let setCount: (value: number) => void

      function record(label: string, value: number) {
        computeLog.push(label + ':' + value)
        return label + '=' + value
      }

      export function App() {
        let count = $state(0)
        setCount = value => {
          count = value
        }

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
        setCount: (value: number) => void
      }>(source, { lazyConditional: true, fineGrainedDom: true })
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
      const clearLog = () => {
        mod.computeLog.length = 0
      }

      await flushMicrotasks()
      // Debugging output to inspect fallback rendering
      // eslint-disable-next-line no-console
      expect(activeBranch()).toBe('fallback')
      expect(fallbackText()).toContain('fallback=0')
      expect(mod.computeLog.length).toBeGreaterThan(0)
      expect(mod.computeLog.some(entry => entry.startsWith('fallback'))).toBe(true)
      clearLog()

      mod.setCount(1)
      await flushMicrotasks()
      expect(activeBranch()).toBe('fallback')
      expect(mod.computeLog.some(entry => entry.startsWith('rich'))).toBe(false)
      expect(mod.computeLog.every(entry => entry.startsWith('fallback'))).toBe(true)
      clearLog()

      mod.setCount(2)
      await flushMicrotasks()
      expect(activeBranch()).toBe('rich')
      const rich = richText()
      expect(rich.stats).toContain('rich-stats=20')
      expect(rich.badge).toContain('rich-badge')
      expect(mod.computeLog.length).toBeGreaterThan(0)
      expect(mod.computeLog.some(entry => entry.startsWith('rich'))).toBe(true)
      expect(mod.computeLog.some(entry => entry.startsWith('rich-stats'))).toBe(true)
      expect(mod.computeLog.some(entry => entry.startsWith('rich-badge'))).toBe(true)
      clearLog()

      mod.setCount(0)
      await flushMicrotasks()
      expect(activeBranch()).toBe('fallback')
      expect(fallbackText()).toContain('fallback=0')

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
      export const controls: { inc?: () => void } = {}

      export function App() {
        let count = $state(0)
        controls.inc = () => {
          count++
        }

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
      controls: { inc?: () => void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushMicrotasks()
    mod.flushPending()
    expect(mod.effectLog[0]).toMatch(/commit:/)
    mod.effectLog.length = 0

    mod.controls.inc?.()
    await flushUpdates()
    mod.flushPending()
    const value1 = container.querySelector('[data-id="value"]')?.textContent ?? ''
    expect(mod.effectLog).toEqual([`commit:${value1}`])
    mod.effectLog.length = 0

    mod.controls.inc?.()
    await flushUpdates()
    mod.flushPending()
    const value2 = container.querySelector('[data-id="value"]')?.textContent ?? ''
    expect(mod.effectLog).toEqual([`commit:${value2}`])
    expect(Number(value2)).toBeGreaterThan(Number(value1))

    teardown()
    container.remove()
  })

  it('exposes latest state to DOM event handlers', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render } from 'fict'

      export const eventLog: number[] = []
      export const handlers: { inc?: () => void; read?: () => void } = {}

      export function App() {
        let count = $state(0)
        const handleInc = () => count++
        const handleRead = () => eventLog.push(count)
        handlers.inc = handleInc
        handlers.read = handleRead

        return (
          <div>
            <button data-id="inc" onClick={handleInc}>inc</button>
            <button data-id="read" onClick={handleRead}>read</button>
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
      handlers: { inc?: () => void; read?: () => void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const value = () => container.querySelector('[data-id="value"]')?.textContent

    expect(typeof mod.handlers.read).toBe('function')
    expect(typeof mod.handlers.inc).toBe('function')

    await flushMicrotasks()
    const readLatest = (): number => {
      mod.eventLog.length = 0
      mod.handlers.read?.()
      return mod.eventLog[0] ?? NaN
    }

    const baseline = readLatest()
    expect(baseline).toBe(Number(value()))

    mod.handlers.inc?.()
    await flushUpdates()
    const afterInc1 = readLatest()
    expect(afterInc1).toBe(Number(value()))
    expect(afterInc1).toBeGreaterThan(baseline)

    mod.handlers.inc?.()
    await flushUpdates()
    const afterInc2 = readLatest()
    expect(afterInc2).toBe(Number(value()))
    expect(afterInc2).toBeGreaterThan(afterInc1)
    expect(mod.eventLog.every(entry => typeof entry === 'number')).toBe(true)

    teardown()
    await flushMicrotasks()
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

  it('keeps keyed list DOM in sync in fine-grained mode', { timeout: 10000 }, async () => {
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
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const readIds = () =>
      Array.from(container.querySelectorAll('li')).map(li => Number(li.getAttribute('data-id')))

    await flushUpdates()
    expect(readIds()).toEqual([1, 2, 3])

    mod.api.rotate()
    await flushUpdates()
    expect(readIds()).toEqual([2, 3, 1])

    mod.api.prepend()
    await flushUpdates()
    expect(readIds()).toEqual([0, 2, 3, 1])

    mod.api.dropSecond()
    await flushUpdates()
    expect(readIds()).toEqual([0, 3, 1])

    teardown()
    container.remove()
  })

  it('does not constify static member reads from dynamic computed list keys', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const idKey = 'id'
        const items = [{ id: 'actual-key', idKey: 'literal-prop' }]
        return (
          <ul>
            {items.map(item => (
              <li key={item[idKey]}>{item.idKey}</li>
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
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    expect(Array.from(container.querySelectorAll('li')).map(li => li.textContent)).toEqual([
      'literal-prop',
    ])

    teardown()
    container.remove()
  })

  it(
    'switches conditional branches and updates attributes in fine-grained mode',
    { timeout: 10000 },
    async () => {
      const source = `
      import { $state, render } from 'fict'

      export function App() {
        let show = $state(true)
        let count = $state(1)

        return (
          <section data-mode={show ? 'on' : 'off'}>
            {show ? <p data-id="on">on:{count}</p> : <p data-id="off">off:{count}</p>}
            <button data-id="toggle" onClick={() => (show = !show)}>toggle</button>
            <button data-id="inc" disabled={count > 2} onClick={() => count++}>inc</button>
          </section>
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

      const section = () => container.querySelector('section') as HTMLElement
      const toggle = () => container.querySelector('[data-id="toggle"]') as HTMLButtonElement
      const inc = () => container.querySelector('[data-id="inc"]') as HTMLButtonElement
      const onText = () => container.querySelector('[data-id="on"]')?.textContent ?? ''
      const offText = () => container.querySelector('[data-id="off"]')?.textContent ?? ''

      expect(section().dataset.mode).toBe('on')
      expect(onText()).toContain('on:1')
      expect(offText()).toBe('')
      expect(inc().disabled).toBe(false)

      toggle().click()
      await flushUpdates()
      expect(section().dataset.mode).toBe('off')
      expect(onText()).toBe('')
      expect(offText()).toContain('off:1')

      inc().click()
      await flushUpdates()
      expect(offText()).toContain('off:2')
      expect(inc().disabled).toBe(false)

      inc().click()
      await flushUpdates()
      expect(section().dataset.mode).toBe('off')
      expect(inc().disabled).toBe(true)

      toggle().click()
      await flushUpdates()
      expect(section().dataset.mode).toBe('on')
      expect(onText()).toContain('on:3')

      teardown()
      container.remove()
    },
  )

  it('renders and cleans up a portal in fine-grained mode', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render, createPortal, createElement } from 'fict'

      export let api: { inc(): void }

      export function App() {
        let count = $state(0)
        api = { inc: () => (count = count + 1) }

        return (
          <>
            <div data-id="host">host</div>
            {createPortal(document.body, () => <div data-id="portal">{count}</div>, createElement)}
          </>
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

    const portal = () => document.body.querySelector('[data-id="portal"]') as HTMLElement

    await flushUpdates()
    expect(portal().textContent).toBe('0')

    mod.api.inc()
    await flushUpdates()
    expect(portal().textContent).toBe('1')

    teardown()
    await flushUpdates()
    expect(document.body.querySelector('[data-id="portal"]')).toBeNull()
    container.remove()
  })

  it(
    'updates nested text content without re-rendering parent elements',
    { timeout: 10000 },
    async () => {
      const source = `
      import { $state, render } from 'fict'

      export let api: { inc(): void }

      export function App() {
        let count = $state(0)
        api = { inc: () => (count = count + 1) }

        return (
          <div data-id="parent">
            Static
            <span data-id="child">
              Count: {count}
            </span>
          </div>
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

      const parent = container.querySelector('[data-id="parent"]') as HTMLElement
      const child = container.querySelector('[data-id="child"]') as HTMLElement

      expect(child.textContent).toContain('Count: 0')

      mod.api.inc()
      await flushUpdates()

      // Verify content updated
      expect(child.textContent).toContain('Count: 1')

      // Verify DOM nodes are exactly the same instances (no re-render)
      const newParent = container.querySelector('[data-id="parent"]') as HTMLElement
      const newChild = container.querySelector('[data-id="child"]') as HTMLElement

      expect(newParent).toBe(parent)
      expect(newChild).toBe(child)

      teardown()
      container.remove()
    },
  )

  it('supports dynamic swapping of event handlers', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render } from 'fict'

      export const log: string[] = []

      export function App() {
        let mode = $state('A')

        const handlerA = () => log.push('A')
        const handlerB = () => log.push('B')

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

    // Initial state: Handler A
    btn.click()
    expect(mod.log).toEqual(['A'])
    mod.log.length = 0

    // Swap to Handler B
    toggle.click()
    await flushUpdates()

    btn.click()
    expect(mod.log).toEqual(['B'])
    mod.log.length = 0

    // Swap back to Handler A
    toggle.click()
    await flushUpdates()

    btn.click()
    expect(mod.log).toEqual(['A'])

    teardown()
    container.remove()
  })

  it('invokes handlers returned by event call expressions', () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      const createHandler = (label: string) => () => log.push(label)

      export function App() {
        return <button data-id="btn" onClick={createHandler('factory')}>Click</button>
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

    const button = container.querySelector('[data-id="btn"]') as HTMLButtonElement
    button.click()
    expect(mod.log).toEqual(['factory'])

    teardown()
    container.remove()
  })

  /**
   * Tests that memo variables are correctly identified as reactive.
   * This ensures that expressions accessing memo/derived values are bound reactively.
   */
  it('binds memo variable properties reactively (fix)', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let user = $state({ name: 'Initial', active: true })

        // Create a derived value (memo)
        const currentUser = user
        const status = currentUser.active ? 'Active' : 'Inactive'

        return (
          <div>
            <span data-testid="name">{currentUser.name}</span>
            <span data-testid="status">{status}</span>
            <button data-testid="update" onClick={() => user = { name: 'Updated', active: false }}>Update</button>
          </div>
        )
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
    const teardown = mod.mount(container)

    await flushUpdates()

    // Initial state
    const nameEl = container.querySelector('[data-testid="name"]') as HTMLElement
    const statusEl = container.querySelector('[data-testid="status"]') as HTMLElement
    expect(nameEl.textContent).toBe('Initial')
    expect(statusEl.textContent).toBe('Active')

    // Update the data
    const updateBtn = container.querySelector('[data-testid="update"]') as HTMLButtonElement
    updateBtn.click()
    await flushUpdates()

    // Should reactively update
    expect(nameEl.textContent).toBe('Updated')
    expect(statusEl.textContent).toBe('Inactive')

    teardown()
    container.remove()
  })

  /**
   * Tests that derived values (memo outputs) are correctly bound as reactive text.
   * This is the core fix for the "result.data?.name not reactive" issue.
   */
  it('uses bindText for expressions depending on memo variables', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let count = $state(0)
        // This creates a derived/memo value
        const doubled = count * 2
        const tripled = count * 3

        return (
          <div>
            <span data-testid="doubled">{doubled}</span>
            <span data-testid="tripled">{tripled}</span>
            <button data-testid="inc" onClick={() => count++}>Inc</button>
          </div>
        )
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
    const teardown = mod.mount(container)

    await flushUpdates()

    const doubled = container.querySelector('[data-testid="doubled"]') as HTMLElement
    const tripled = container.querySelector('[data-testid="tripled"]') as HTMLElement
    expect(doubled.textContent).toBe('0')
    expect(tripled.textContent).toBe('0')

    // Increment
    const incBtn = container.querySelector('[data-testid="inc"]') as HTMLButtonElement
    incBtn.click()
    await flushUpdates()

    expect(doubled.textContent).toBe('2')
    expect(tripled.textContent).toBe('3')

    // Increment again
    incBtn.click()
    await flushUpdates()

    expect(doubled.textContent).toBe('4')
    expect(tripled.textContent).toBe('6')

    teardown()
    container.remove()
  })

  /**
   * Tests that object property access on memo variables is reactive.
   */
  it('binds object property access on memo variables reactively', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let user = $state({ name: 'Alice', age: 30 })

        // Access properties through a derived reference
        const currentUser = user

        return (
          <div>
            <span data-testid="name">{currentUser.name}</span>
            <span data-testid="age">{currentUser.age}</span>
            <button data-testid="update" onClick={() => user = { name: 'Bob', age: 25 }}>Update</button>
          </div>
        )
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
    const teardown = mod.mount(container)

    await flushUpdates()

    const nameEl = container.querySelector('[data-testid="name"]') as HTMLElement
    const ageEl = container.querySelector('[data-testid="age"]') as HTMLElement
    expect(nameEl.textContent).toBe('Alice')
    expect(ageEl.textContent).toBe('30')

    // Update
    const updateBtn = container.querySelector('[data-testid="update"]') as HTMLButtonElement
    updateBtn.click()
    await flushUpdates()

    expect(nameEl.textContent).toBe('Bob')
    expect(ageEl.textContent).toBe('25')

    teardown()
    container.remove()
  })

  /**
   * Tests that optional chaining on reactive expressions is handled correctly.
   */
  it('handles optional chaining on reactive memo expressions', async () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        let showUser = $state(true)
        let userName = $state('Alice')

        // Use optional chaining pattern
        const displayName = showUser ? userName : null

        return (
          <div>
            <span data-testid="name">{displayName ?? 'N/A'}</span>
            <button data-testid="hide" onClick={() => showUser = false}>Hide</button>
            <button data-testid="show" onClick={() => { showUser = true; userName = 'Bob' }}>Show Bob</button>
          </div>
        )
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
    const teardown = mod.mount(container)

    await flushUpdates()

    const nameEl = container.querySelector('[data-testid="name"]') as HTMLElement
    expect(nameEl.textContent).toBe('Alice')

    // Hide user
    const hideBtn = container.querySelector('[data-testid="hide"]') as HTMLButtonElement
    hideBtn.click()
    await flushUpdates()

    expect(nameEl.textContent).toBe('N/A')

    // Show with new name
    const showBtn = container.querySelector('[data-testid="show"]') as HTMLButtonElement
    showBtn.click()
    await flushUpdates()

    expect(nameEl.textContent).toBe('Bob')

    teardown()
    container.remove()
  })
})
