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

  it('snapshots mutable non-reactive locals read by derived memo declarations', () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        const a = $state(1)
        let assigned = 0
        const assignedValue = assigned + a()
        assigned = 2

        let updated = 3
        const updatedValue = updated + a()
        updated++

        let destructured = 5
        const destructuredValue = destructured + a()
        ;({ value: destructured } = { value: 7 })

        const stable = 11
        const stableValue = stable + a()

        let neverMutated = 13
        const neverMutatedValue = neverMutated + a()

        return (
          <div>
            <span data-testid="assigned">{assignedValue}</span>
            <span data-testid="updated">{updatedValue}</span>
            <span data-testid="destructured">{destructuredValue}</span>
            <span data-testid="stable">{stableValue}</span>
            <span data-testid="never-mutated">{neverMutatedValue}</span>
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

    expect(container.querySelector('[data-testid="assigned"]')?.textContent).toBe('1')
    expect(container.querySelector('[data-testid="updated"]')?.textContent).toBe('4')
    expect(container.querySelector('[data-testid="destructured"]')?.textContent).toBe('6')
    expect(container.querySelector('[data-testid="stable"]')?.textContent).toBe('12')
    expect(container.querySelector('[data-testid="never-mutated"]')?.textContent).toBe('14')

    teardown()
    container.remove()
  })

  it('snapshots mutable region outputs before later writes in JSX reads', () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        const a = $state(1)
        let y = a()
        const z = y
        y = 2
        return <span data-testid="value">{z}:{y}</span>
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

    expect(container.querySelector('[data-testid="value"]')?.textContent).toBe('1:2')

    teardown()
    container.remove()
  })

  it('renders JSX reads after assigning mutable region outputs', () => {
    const source = `
      import { $state, render } from 'fict'

      function App() {
        const a = $state(1)
        let y = a()
        const assigned = (y = 2)
        const logical = (y ||= 3)
        const compound = (y += 4)
        return <span data-testid="value">{assigned}:{logical}:{compound}:{y}</span>
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

    expect(container.querySelector('[data-testid="value"]')?.textContent).toBe('2:2:6:6')

    teardown()
    container.remove()
  })

  it('does not treat local $store functions as reactive stores', () => {
    const source = `
      import { render } from 'fict'

      function App() {
        const $store = value => ({ ...value })
        const local = $store({ count: 1 })
        const shown = local.count * 2
        local.count = 3
        return <span data-testid="value">{shown}</span>
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

    expect(container.querySelector('[data-testid="value"]')?.textContent).toBe('2')

    teardown()
    container.remove()
  })

  it('evaluates impure reactive derived declaration initializers eagerly', async () => {
    const source = `
      import { $state, render } from 'fict'

      export const log: unknown[] = []
      export let api: { set(value: number): void }

      function side(value: unknown) {
        log.push(value)
        return value
      }

      const obj = {
        get value() {
          log.push('get')
          return 4
        },
      }

      function App() {
        const a = $state(1)
        api = { set: (value: number) => a(value) }

        const unused = side(a())
        const delayed = side(a() + 1)
        log.push('after-delayed')

        const getterValue = obj.value + a()

        let assigned = 0
        const assignedValue = (assigned = a() + 2)
        log.push(['assigned', assigned])

        const pure = a() + 10

        return (
          <div>
            <span data-testid="delayed">{delayed}</span>
            <span data-testid="getter">{getterValue}</span>
            <span data-testid="assigned">{assignedValue}</span>
            <span data-testid="pure">{pure}</span>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { set(value: number): void }
      log: unknown[]
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    expect(mod.log).toEqual([1, 2, 'after-delayed', 'get', ['assigned', 3]])
    expect(container.querySelector('[data-testid="delayed"]')?.textContent).toBe('2')
    expect(container.querySelector('[data-testid="getter"]')?.textContent).toBe('5')
    expect(container.querySelector('[data-testid="assigned"]')?.textContent).toBe('3')
    expect(container.querySelector('[data-testid="pure"]')?.textContent).toBe('11')

    mod.api.set(5)
    await flushUpdates()
    expect(mod.log).toEqual([1, 2, 'after-delayed', 'get', ['assigned', 3]])
    expect(container.querySelector('[data-testid="pure"]')?.textContent).toBe('15')
    expect(container.querySelector('[data-testid="delayed"]')?.textContent).toBe('2')
    expect(container.querySelector('[data-testid="getter"]')?.textContent).toBe('5')
    expect(container.querySelector('[data-testid="assigned"]')?.textContent).toBe('3')

    teardown()
    container.remove()
  })

  it('throws impure reactive derived declaration initializers at declaration time', () => {
    const source = `
      import { $state, render } from 'fict'

      function fail(value: number) {
        throw new Error('boom:' + value)
      }

      function App() {
        const a = $state(1)
        const unused = fail(a())
        return <span>unused</span>
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

    expect(() => mod.mount(container)).toThrow('boom:1')

    container.remove()
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

  it('applies defaulted destructured props when undefined is shadowed', async () => {
    const source = `
      export function Greeting({ name } = { name: 'Anon' }) {
        const undefined = 'shadow'
        return <span data-testid="name">{undefined}:{name}</span>
      }
    `

    const mod = compileAndLoad<{
      Greeting: (props?: { name: string }) => HTMLElement
    }>(source, { fineGrainedDom: true })
    const node = runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
      mod.Greeting(undefined),
    ) as HTMLElement

    expect(node.textContent).toBe('shadow:Anon')
  })

  it('evaluates destructured prop defaults during component invocation', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      function side(label: string) {
        log.push(label)
        return label
      }

      function Unused({ name = side('unused') }: { name?: string | null }) {
        return <span data-id="unused">static</span>
      }

      function ReadTwice({ name = side('read') }: { name?: string | null }) {
        return <span data-id="read">{name}:{name}</span>
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        return render(() => (
          <>
            <Unused />
            <Unused name={null} />
            <Unused name="present" />
            <ReadTwice />
          </>
        ), el)
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

    expect((container.querySelector('[data-id="unused"]') as HTMLSpanElement).textContent).toBe(
      'static',
    )
    expect((container.querySelector('[data-id="read"]') as HTMLSpanElement).textContent).toBe(
      'read:read',
    )
    expect(mod.log).toEqual(['unused', 'read'])

    teardown()
    container.remove()
  })

  it('lowers JSX in destructured prop defaults', async () => {
    const source = `
      import { render } from 'fict'

      function App({ fallback = <span data-id="fallback">Default</span> } = {}) {
        return <div data-id="host">{fallback}</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => (
          <>
            <App />
            <App fallback={<em data-id="custom">Custom</em>} />
          </>
        ), el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      fineGrainedDom: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    expect(container.querySelector('[data-id="fallback"]')?.textContent).toBe('Default')
    expect(container.querySelector('[data-id="custom"]')?.textContent).toBe('Custom')
    expect(
      Array.from(container.querySelectorAll('[data-id="host"]')).map(el => el.textContent),
    ).toEqual(['Default', 'Custom'])

    teardown()
    container.remove()
  })

  it('evaluates destructured prop defaults against prior prop values', async () => {
    const source = `
      import { render } from 'fict'

      function Pair({
        a,
        b = a,
        c: renamed,
        d = renamed,
        e = b,
        fn,
        fnResult = fn(),
      }: any) {
        return (
          <span data-id="pair">
            {typeof b}:{String(b)}:
            {typeof d}:{String(d)}:
            {typeof e}:{String(e)}:
            {fnResult}
          </span>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => (
          <Pair a="first" c="alias" fn={() => 'called'} />
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

    expect(container.querySelector('[data-id="pair"]')?.textContent?.replace(/\s+/g, '')).toBe(
      'string:first:string:alias:string:first:called',
    )

    teardown()
    container.remove()
  })

  it('reads literal prop destructuring keys with computed access', async () => {
    const source = `
      import { render } from 'fict'

      function Child({
        "foo-bar": value,
        0: first,
        nested: { "aria-label": label = 'fallback' },
        ...rest
      }: any) {
        return (
          <span data-id="literal">
            {value}:{first}:{label}:{String('extra' in rest)}:{String('foo-bar' in rest)}
          </span>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => ({
          type: Child,
          props: {
            "foo-bar": "dash",
            0: "zero",
            nested: {},
            extra: "kept",
          },
        }), el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    expect(container.querySelector('[data-id="literal"]')?.textContent).toBe(
      'dash:zero:fallback:true:false',
    )

    teardown()
    container.remove()
  })

  it('checks nested prop destructuring parents during component invocation', async () => {
    const source = `
      import { render } from 'fict'

      function Child({ user: { name } }: any) {
        return <span data-id="nested">{name}</span>
      }

      export function mountMissing(el: HTMLElement) {
        return render(() => <Child />, el)
      }

      export function mountNull(el: HTMLElement) {
        return render(() => <Child user={null} />, el)
      }

      export function mountPresent(el: HTMLElement) {
        return render(() => <Child user={{ name: 'Ada' }} />, el)
      }
    `

    const mod = compileAndLoad<{
      mountMissing: (el: HTMLElement) => () => void
      mountNull: (el: HTMLElement) => () => void
      mountPresent: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)

    expect(() => mod.mountMissing(container)).toThrow(/Cannot destructure prop "user"/)
    expect(() => mod.mountNull(container)).toThrow(/Cannot destructure prop "user"/)

    const teardown = mod.mountPresent(container)
    await flushUpdates()
    expect(container.querySelector('[data-id="nested"]')?.textContent).toBe('Ada')

    teardown()
    container.remove()
  })

  it('reads destructured prop properties during component invocation', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      const props = {
        get name() {
          log.push('get')
          return 'Ada'
        },
      }

      const throwingProps = {
        get name() {
          throw new Error('name getter')
        },
      }

      function Child({ name }: any) {
        return <span data-id="plain">static</span>
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        return render(() => ({ type: Child, props }), el)
      }

      export function mountThrowing(el: HTMLElement) {
        return render(() => ({ type: Child, props: throwingProps }), el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      mountThrowing: (el: HTMLElement) => () => void
      log: string[]
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    expect(container.querySelector('[data-id="plain"]')?.textContent).toBe('static')
    expect(mod.log).toEqual(['get'])
    expect(() => mod.mountThrowing(container)).toThrow(/name getter/)

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

  it('keeps reactive component children live through props.children', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { inc(): void }

      function Child(props: { id: string; children?: unknown }) {
        return <section data-id={props.id}>{props.children}</section>
      }

      export function App() {
        let count = $state(1)
        api = { inc: () => (count = count + 1) }
        return (
          <>
            <Child id="single">{count}</Child>
            <Child id="mixed">before {count}</Child>
          </>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { inc(): void }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const text = (id: string) => container.querySelector(`[data-id="${id}"]`)?.textContent
    expect(text('single')).toBe('1')
    expect(text('mixed')).toBe('before 1')

    mod.api.inc()
    await flushUpdates()
    expect(text('single')).toBe('2')
    expect(text('mixed')).toBe('before 2')

    teardown()
    container.remove()
  })

  it('does not expose non-reactive markers before function prop reflection', async () => {
    const source = `
      import { render } from 'fict'

      export const observed = {
        before: [] as string[],
        after: [] as string[],
        value: '',
      }

      function Child(props: { fn: () => string }) {
        const marker = 'Symbol(fict:non-reactive-fn)'
        const descriptor = Object.getOwnPropertyDescriptor(props, 'fn')
        observed.before = descriptor?.value
          ? Object.getOwnPropertySymbols(descriptor.value).map(String)
          : []

        observed.after = Object.getOwnPropertySymbols(props.fn).map(String)
        observed.value = props.fn()

        return <span data-testid="value">{observed.value}:{observed.before.includes(marker) ? 'marked' : 'clean'}</span>
      }

      export function App() {
        return <Child fn={() => 'ok'} />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      observed: { before: string[]; after: string[]; value: string }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()
    expect(mod.observed.before).not.toContain('Symbol(fict:non-reactive-fn)')
    expect(mod.observed.after).not.toContain('Symbol(fict:non-reactive-fn)')
    expect(mod.observed.value).toBe('ok')
    expect(container.querySelector('[data-testid="value"]')?.textContent).toBe('ok:clean')

    teardown()
    container.remove()
  })

  it('keeps JSX binding function declarations scoped from reactive accessors', async () => {
    const source = `
      import { $state, render } from 'fict'

      export function App() {
        const count = $state(0)
        return (
          <div data-testid="value">
            {(() => {
              function f(count) {
                return count
              }
              return f(2) + count
            })()}
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
    await flushUpdates()

    expect(container.querySelector('[data-testid="value"]')?.textContent).toBe('2')

    teardown()
    container.remove()
  })

  it('invokes optional-called destructured function props', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      function Child({ cb, value }: { cb?: (value?: string) => void; value: string }) {
        cb?.()
        cb?.(value)
        return <div data-testid="child">child</div>
      }

      export function App() {
        return (
          <section>
            <Child cb={value => calls.push(value ?? 'empty')} value="called" />
            <Child value="missing" />
          </section>
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
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    expect(container.querySelectorAll('[data-testid="child"]')).toHaveLength(2)
    expect(mod.calls).toEqual(['empty', 'called'])

    teardown()
    container.remove()
  })

  it('keeps mixed called and displayed destructured props reactive', async () => {
    const source = `
      import { $state, render } from 'fict'

      export const calls: string[] = []
      export let api: { set(value: string): void }

      function makeLabel(value: string) {
        const label = () => calls.push(value)
        label.toString = () => value
        return label
      }

      function Child({ label }: { label: (() => void) & { toString(): string } }) {
        const invokeLater = () => label()
        return (
          <>
            <button data-id="call" onClick={invokeLater}>call</button>
            <span data-id="label">{String(label)}</span>
          </>
        )
      }

      export function App() {
        let label = $state(makeLabel('first'))
        api = {
          set(value) {
            label = makeLabel(value)
          },
        }
        return <Child label={label} />
      }

      export function mount(el: HTMLElement) {
        calls.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { set(value: string): void }
      calls: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    const label = container.querySelector('[data-id="label"]') as HTMLSpanElement
    const call = container.querySelector('[data-id="call"]') as HTMLButtonElement

    expect(label.textContent).toBe('first')
    call.click()
    await flushUpdates()
    expect(mod.calls).toEqual(['first'])

    mod.api.set('second')
    await flushUpdates()
    expect(label.textContent).toBe('second')

    call.click()
    await flushUpdates()
    expect(mod.calls).toEqual(['first', 'second'])

    teardown()
    container.remove()
  })

  it('calls reactive object methods through call apply and bind', async () => {
    const source = `
      import { $state, render } from 'fict'

      export function App() {
        let obj = $state({
          value: 1,
          fn(this: { value: number }) {
            return this.value
          },
        })
        return (
          <section>
            <span data-id="direct">{obj.fn()}</span>
            <span data-id="call">{obj.fn.call({ value: 2 })}</span>
            <span data-id="apply">{obj.fn.apply({ value: 3 })}</span>
            <span data-id="bind">{obj.fn.bind({ value: 4 })()}</span>
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
    await flushUpdates()

    const text = (id: string) => container.querySelector(`[data-id="${id}"]`)?.textContent
    expect(text('direct')).toBe('1')
    expect(text('call')).toBe('2')
    expect(text('apply')).toBe('3')
    expect(text('bind')).toBe('4')

    teardown()
    container.remove()
  })

  it('invokes call/apply destructured function props', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      function Child({ cb }: { cb: (value: string) => void }) {
        cb.call(null, 'call')
        cb.apply(null, ['apply'])
        cb?.call(null, 'optcall')
        return <div data-testid="child">child</div>
      }

      export function App() {
        return <Child cb={value => calls.push(value)} />
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

    expect(container.querySelector('[data-testid="child"]')).toBeTruthy()
    expect(mod.calls).toEqual(['call', 'apply', 'optcall'])

    teardown()
    container.remove()
  })

  it('invokes destructured function props through local aliases', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      function Child({ cb }: { cb: (value: string) => void }) {
        const direct = cb
        let optional = direct
        const chained = optional
        const member = cb
        direct('direct')
        optional?.('optional')
        chained.call(null, 'call')
        member.apply(null, ['apply'])
        return <div data-testid="child">child</div>
      }

      export function App() {
        return <Child cb={value => calls.push(value)} />
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

    expect(container.querySelector('[data-testid="child"]')).toBeTruthy()
    expect(mod.calls).toEqual(['direct', 'optional', 'call', 'apply'])

    teardown()
    container.remove()
  })

  it('keeps destructured value props reactive when lexical shadows are called', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: string): void }

      function Child({ value }: { value: string }) {
        try {
          throw () => 'catch'
        } catch (value) {
          value()
        }
        for (const value of [() => 'loop']) {
          value()
        }
        switch (1) {
          case 1: {
            const value = () => 'case'
            value()
            break
          }
        }
        return <span data-testid="value" title={value}>{value}</span>
      }

      function App() {
        const value = $state('one')
        api = { set: next => value(next) }
        return <Child value={value} />
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
    const valueEl = container.querySelector('[data-testid="value"]') as HTMLSpanElement

    expect(valueEl.textContent).toBe('one')
    expect(valueEl.getAttribute('title')).toBe('one')

    mod.api.set('two')
    await flushUpdates()
    expect(valueEl.textContent).toBe('two')
    expect(valueEl.getAttribute('title')).toBe('two')

    teardown()
    container.remove()
  })

  it('keeps destructured value props reactive when unreachable calls exist', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let returnedApi: { set(value: string): void }
      export let deadBranchApi: { set(value: string): void }

      function Returned({ value }: { value: string }) {
        return <span data-testid="returned" title={value}>{value}</span>
        value()
      }

      function DeadBranch({ value }: { value: string }) {
        if (false) {
          value()
        }
        return <span data-testid="dead-branch" title={value}>{value}</span>
      }

      function ReturnedApp() {
        const value = $state('one')
        returnedApi = { set: next => value(next) }
        return <Returned value={value} />
      }

      function DeadBranchApp() {
        const value = $state('one')
        deadBranchApi = { set: next => value(next) }
        return <DeadBranch value={value} />
      }

      export function mountReturned(el: HTMLElement) {
        return render(() => <ReturnedApp />, el)
      }

      export function mountDeadBranch(el: HTMLElement) {
        return render(() => <DeadBranchApp />, el)
      }
    `

    const mod = compileAndLoad<{
      mountReturned: (el: HTMLElement) => () => void
      mountDeadBranch: (el: HTMLElement) => () => void
      returnedApi: { set(value: string): void }
      deadBranchApi: { set(value: string): void }
    }>(source, { fineGrainedDom: true })
    const returnedContainer = document.createElement('div')
    const deadBranchContainer = document.createElement('div')
    document.body.append(returnedContainer, deadBranchContainer)
    const teardownReturned = mod.mountReturned(returnedContainer)
    const teardownDeadBranch = mod.mountDeadBranch(deadBranchContainer)
    const returned = returnedContainer.querySelector('[data-testid="returned"]') as HTMLSpanElement
    const deadBranch = deadBranchContainer.querySelector(
      '[data-testid="dead-branch"]',
    ) as HTMLSpanElement

    expect(returned.textContent).toBe('one')
    expect(returned.getAttribute('title')).toBe('one')
    expect(deadBranch.textContent).toBe('one')
    expect(deadBranch.getAttribute('title')).toBe('one')

    mod.returnedApi.set('two')
    mod.deadBranchApi.set('two')
    await flushUpdates()
    expect(returned.textContent).toBe('two')
    expect(returned.getAttribute('title')).toBe('two')
    expect(deadBranch.textContent).toBe('two')
    expect(deadBranch.getAttribute('title')).toBe('two')

    teardownReturned()
    teardownDeadBranch()
    returnedContainer.remove()
    deadBranchContainer.remove()
  })

  it('passes props to local components named Fragment', async () => {
    const source = `
      import { render } from 'fict'

      const Fragment = (props: { foo?: string; children?: unknown }) => (
        <section data-id="local-fragment">
          {props.foo}:{props.children}
        </section>
      )

      export function App() {
        return <Fragment foo="bar">x</Fragment>
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

    expect(container.querySelector('[data-id="local-fragment"]')?.textContent).toBe('bar:x')

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

  it('binds BigInt and RegExp literal JSX attributes instead of dropping them', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return (
          <section>
            <div data-testid="bigint" data-x={1n} title={1n} />
            <div data-testid="regexp" data-r={/x/g} />
            <input data-testid="input-bigint" value={1n} />
            <input data-testid="input-regexp" value={/x/g} />
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

    const bigint = container.querySelector('[data-testid="bigint"]') as HTMLDivElement
    const regexp = container.querySelector('[data-testid="regexp"]') as HTMLDivElement
    const inputBigint = container.querySelector('[data-testid="input-bigint"]') as HTMLInputElement
    const inputRegexp = container.querySelector('[data-testid="input-regexp"]') as HTMLInputElement

    expect(bigint.getAttribute('data-x')).toBe('1')
    expect(bigint.getAttribute('title')).toBe('1')
    expect(regexp.getAttribute('data-r')).toBe('/x/g')
    expect(inputBigint.value).toBe('1')
    expect(inputRegexp.value).toBe('/x/g')

    teardown()
    container.remove()
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

  it('parses modifier event props from intrinsic spreads', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      export function App() {
        const modifierProps = {
          onClickCapture: () => calls.push('capture'),
          onClickPassive: () => calls.push('passive'),
          onClickOnce: () => calls.push('once'),
          onClickCapturePassive: () => calls.push('combo'),
        }
        const namedProps = {
          'on:click': () => calls.push('named'),
          'oncapture:click': () => calls.push('named-capture'),
        }
        return (
          <section>
            <button data-testid="modifiers" {...modifierProps}>Modifiers</button>
            <button data-testid="named" {...namedProps}>Named</button>
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        calls.length = 0
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
    const modifiers = container.querySelector('[data-testid="modifiers"]') as HTMLButtonElement
    const named = container.querySelector('[data-testid="named"]') as HTMLButtonElement

    modifiers.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    modifiers.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    named.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    named.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const counts = mod.calls.reduce<Record<string, number>>((acc, item) => {
      acc[item] = (acc[item] ?? 0) + 1
      return acc
    }, {})
    expect(counts).toEqual({
      capture: 2,
      passive: 2,
      once: 1,
      combo: 2,
      named: 2,
      'named-capture': 2,
    })

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

  it('sets content JSX props through DOM properties in fine-grained output', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: {
        setText(value: string): void
        setHtml(value: string): void
        setInner(value: string): void
      }

      export function App() {
        let text = $state('hello')
        let html = $state('<span>x</span>')
        let inner = $state('plain')
        api = {
          setText(value) {
            text = value
          },
          setHtml(value) {
            html = value
          },
          setInner(value) {
            inner = value
          },
        }
        return (
          <section>
            <div data-testid="static-text" textContent="static" />
            <div data-testid="static-html" innerHTML={"<strong>static</strong>"} />
            <div data-testid="text" textContent={text} />
            <div data-testid="html" innerHTML={html} />
            <div data-testid="inner" innerText={inner} />
            <div data-testid="control" data-mode={text} />
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: {
        setText(value: string): void
        setHtml(value: string): void
        setInner(value: string): void
      }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const staticText = container.querySelector('[data-testid="static-text"]') as HTMLDivElement
    const staticHtml = container.querySelector('[data-testid="static-html"]') as HTMLDivElement
    const text = container.querySelector('[data-testid="text"]') as HTMLDivElement
    const html = container.querySelector('[data-testid="html"]') as HTMLDivElement
    const inner = container.querySelector('[data-testid="inner"]') as HTMLDivElement
    const control = container.querySelector('[data-testid="control"]') as HTMLDivElement

    expect(staticText.textContent).toBe('static')
    expect(staticText.getAttribute('textContent')).toBeNull()
    expect(staticHtml.innerHTML).toBe('<strong>static</strong>')
    expect(staticHtml.getAttribute('innerHTML')).toBeNull()
    expect(text.textContent).toBe('hello')
    expect(html.innerHTML).toBe('<span>x</span>')
    expect((inner as unknown as { innerText: string }).innerText).toBe('plain')
    expect(control.getAttribute('data-mode')).toBe('hello')

    mod.api.setText('updated')
    mod.api.setHtml('<em>next</em>')
    mod.api.setInner('other')
    await flushUpdates()

    expect(text.textContent).toBe('updated')
    expect(html.innerHTML).toBe('<em>next</em>')
    expect((inner as unknown as { innerText: string }).innerText).toBe('other')
    expect(control.getAttribute('data-mode')).toBe('updated')

    teardown()
    container.remove()
  })

  it('sets form default JSX props through DOM properties in fine-grained output', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: {
        setValue(value: string): void
        setOn(value: boolean): void
      }

      export function App() {
        let val = $state('x')
        let on = $state(true)
        api = {
          setValue(value) {
            val = value
          },
          setOn(value) {
            on = value
          },
        }
        return (
          <section>
            <input data-testid="static" defaultValue="static" defaultChecked={true} indeterminate={true} />
            <input data-testid="dynamic" defaultValue={val} defaultChecked={on} value={val} checked={on} indeterminate={on} />
            <select>
              <option data-testid="option" defaultSelected={on}>item</option>
            </select>
            <video data-testid="video" defaultMuted={on} />
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { setValue(value: string): void; setOn(value: boolean): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const staticInput = container.querySelector('[data-testid="static"]') as HTMLInputElement
    const dynamicInput = container.querySelector('[data-testid="dynamic"]') as HTMLInputElement
    const option = container.querySelector('[data-testid="option"]') as HTMLOptionElement
    const video = container.querySelector('[data-testid="video"]') as HTMLVideoElement

    expect(staticInput.defaultValue).toBe('static')
    expect(staticInput.defaultChecked).toBe(true)
    expect(staticInput.getAttribute('defaultValue')).toBeNull()
    expect(staticInput.indeterminate).toBe(true)
    expect(staticInput.getAttribute('indeterminate')).toBeNull()
    expect(dynamicInput.defaultValue).toBe('x')
    expect(dynamicInput.defaultChecked).toBe(true)
    expect(dynamicInput.value).toBe('x')
    expect(dynamicInput.checked).toBe(true)
    expect(dynamicInput.indeterminate).toBe(true)
    expect(option.defaultSelected).toBe(true)
    expect(video.defaultMuted).toBe(true)

    mod.api.setValue('y')
    mod.api.setOn(false)
    await flushUpdates()

    expect(dynamicInput.defaultValue).toBe('y')
    expect(dynamicInput.defaultChecked).toBe(false)
    expect(dynamicInput.value).toBe('y')
    expect(dynamicInput.checked).toBe(false)
    expect(dynamicInput.indeterminate).toBe(false)
    expect(option.defaultSelected).toBe(false)
    expect(video.defaultMuted).toBe(false)

    teardown()
    container.remove()
  })

  it('sets static DOM property literal expressions through DOM properties', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return (
          <section>
            <input data-testid="literal" value={true} checked={0} disabled={false} readOnly={true} multiple={0} />
            <option data-testid="option" selected={0}>item</option>
            <video data-testid="video" muted={1} />
            <input data-testid="nullish" value={undefined} checked={null} />
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

    const literal = container.querySelector('[data-testid="literal"]') as HTMLInputElement
    const option = container.querySelector('[data-testid="option"]') as HTMLOptionElement
    const video = container.querySelector('[data-testid="video"]') as HTMLVideoElement
    const nullish = container.querySelector('[data-testid="nullish"]') as HTMLInputElement

    expect(literal.value).toBe('true')
    expect(literal.getAttribute('value')).toBeNull()
    expect(literal.checked).toBe(false)
    expect(literal.getAttribute('checked')).toBeNull()
    expect(literal.disabled).toBe(false)
    expect(literal.readOnly).toBe(true)
    expect(literal.multiple).toBe(false)
    expect(option.selected).toBe(false)
    expect(video.muted).toBe(true)
    expect(nullish.value).toBe('')
    expect(nullish.checked).toBe(false)

    teardown()
    container.remove()
  })

  it('keeps table row binding paths aligned with implicit tbody insertion', async () => {
    const source = `
      import { $state, render } from 'fict'

      export const clicks: string[] = []
      export let refTag = ''
      export let api: { set(title: string, active: boolean): void }

      export function App() {
        let title = $state('first')
        let active = $state(true)
        api = {
          set(nextTitle, nextActive) {
            title = nextTitle
            active = nextActive
          },
        }
        return (
          <table data-testid="table">
            <tr data-testid="row">
              <td
                data-testid="cell"
                title={title}
                classList={{ active }}
                ref={el => { refTag = el ? (el as HTMLElement).tagName : '' }}
                onClick={event => clicks.push((event.currentTarget as HTMLElement).tagName)}
              >
                cell
              </td>
            </tr>
          </table>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { set(title: string, active: boolean): void }
      clicks: string[]
      refTag: string
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const table = container.querySelector('[data-testid="table"]') as HTMLTableElement
    const row = container.querySelector('[data-testid="row"]') as HTMLTableRowElement
    const cell = container.querySelector('[data-testid="cell"]') as HTMLTableCellElement

    expect(table.children[0]?.tagName).toBe('TBODY')
    expect(row.getAttribute('title')).toBeNull()
    expect(cell.getAttribute('title')).toBe('first')
    expect(cell.classList.contains('active')).toBe(true)
    expect(mod.refTag).toBe('TD')

    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(mod.clicks).toEqual(['TD'])

    mod.api.set('next', false)
    await flushUpdates()
    expect(row.getAttribute('title')).toBeNull()
    expect(cell.getAttribute('title')).toBe('next')
    expect(cell.classList.contains('active')).toBe(false)

    teardown()
    container.remove()
  })

  it('keeps bindings on elements that HTML parsing would otherwise auto-close', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: string): void }

      export function App() {
        let title = $state('first')
        api = {
          set(value) {
            title = value
          },
        }

        return (
          <section>
            <p data-id="invalid-p"><div data-id="block" title={title}>block</div></p>
            <p data-id="valid-p"><span data-id="inline" title={title}>inline</span></p>
            <a data-id="outer-link" href="#outer">
              <a data-id="inner-link" href="#inner" title={title}>inner</a>
            </a>
          </section>
        )
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

    const invalidP = container.querySelector('[data-id="invalid-p"]') as HTMLParagraphElement
    const block = container.querySelector('[data-id="block"]') as HTMLDivElement
    const validP = container.querySelector('[data-id="valid-p"]') as HTMLParagraphElement
    const inline = container.querySelector('[data-id="inline"]') as HTMLSpanElement
    const outerLink = container.querySelector('[data-id="outer-link"]') as HTMLAnchorElement
    const innerLink = container.querySelector('[data-id="inner-link"]') as HTMLAnchorElement

    expect(invalidP.contains(block)).toBe(true)
    expect(invalidP.getAttribute('title')).toBeNull()
    expect(block.getAttribute('title')).toBe('first')
    expect(validP.contains(inline)).toBe(true)
    expect(inline.getAttribute('title')).toBe('first')
    expect(outerLink.contains(innerLink)).toBe(true)
    expect(outerLink.getAttribute('title')).toBeNull()
    expect(innerLink.getAttribute('title')).toBe('first')

    mod.api.set('next')
    await flushUpdates()

    expect(invalidP.getAttribute('title')).toBeNull()
    expect(block.getAttribute('title')).toBe('next')
    expect(inline.getAttribute('title')).toBe('next')
    expect(outerLink.getAttribute('title')).toBeNull()
    expect(innerLink.getAttribute('title')).toBe('next')

    teardown()
    container.remove()
  })

  it('binds textarea expression children through the visible value property', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: string): void }

      export function App() {
        let text = $state('hi')
        api = { set: value => (text = value) }
        return <textarea data-testid="textarea">{text}</textarea>
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

    const textarea = container.querySelector('[data-testid="textarea"]') as HTMLTextAreaElement
    expect(textarea.value).toBe('hi')

    textarea.value = 'user edit'
    mod.api.set('bye')
    await flushUpdates()

    expect(textarea.value).toBe('bye')
    expect(textarea.textContent).toBe('')

    teardown()
    container.remove()
  })

  it('does not leak slot markers into raw-text and RCDATA expression children', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { hide(): void; setCss(value: string): void }

      export function App() {
        let show = $state(true)
        let css = $state('body { color: red; }')
        api = {
          hide: () => (show = false),
          setCss: value => (css = value),
        }
        return (
          <section>
            <script type="application/json" data-testid="script">{show && <span>code</span>}</script>
            <style data-testid="style">{css}</style>
            <title data-testid="title">{show && <span>title</span>}</title>
            <script
              type="application/json"
              data-testid="children-prop"
              children={show && <span>child</span>}
            />
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { hide(): void; setCss(value: string): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const script = container.querySelector('[data-testid="script"]') as HTMLScriptElement
    const style = container.querySelector('[data-testid="style"]') as HTMLStyleElement
    const title = container.querySelector('[data-testid="title"]') as HTMLTitleElement
    const childrenProp = container.querySelector(
      '[data-testid="children-prop"]',
    ) as HTMLScriptElement

    expect(script.textContent).not.toContain('fict:slot')
    expect(style.textContent).toBe('body { color: red; }')
    expect(title.textContent).not.toContain('fict:slot')
    expect(childrenProp.textContent).not.toContain('fict:slot')

    mod.api.setCss('body { color: blue; }')
    await flushUpdates()
    expect(style.textContent).toBe('body { color: blue; }')

    mod.api.hide()
    await flushUpdates()
    expect(script.textContent).toBe('')
    expect(title.textContent).toBe('')
    expect(childrenProp.textContent).toBe('')

    teardown()
    container.remove()
  })

  it('resolves dynamic bindings inside template element content', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let seen: { span: Element | null; clicks: number } = { span: null, clicks: 0 }
      export let api: {
        setTitle(value: string): void
        hide(): void
        setItems(value: string[]): void
      }

      export function App() {
        let title = $state('first')
        let show = $state(true)
        let items = $state(['a', 'b'])
        api = {
          setTitle: value => (title = value),
          hide: () => (show = false),
          setItems: value => (items = value),
        }
        return (
          <section>
            <template data-testid="tpl">
              <span data-id="target" title={title} ref={el => (seen.span = el)}>
                {title}
              </span>
              <button data-id="button" on:click={() => (seen.clicks += 1)}>click</button>
              {show && <em data-id="conditional">{title}</em>}
              {items.map(item => <i key={item} data-row={item}>{item}</i>)}
              <template data-id="nested">
                <b data-id="nested-target" title={title}>{title}</b>
              </template>
            </template>
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      seen: { span: Element | null; clicks: number }
      api: {
        setTitle(value: string): void
        hide(): void
        setItems(value: string[]): void
      }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const tpl = container.querySelector('[data-testid="tpl"]') as HTMLTemplateElement
    const content = tpl.content
    const target = content.querySelector('[data-id="target"]') as HTMLSpanElement
    const button = content.querySelector('[data-id="button"]') as HTMLButtonElement
    const nestedTpl = content.querySelector('[data-id="nested"]') as HTMLTemplateElement
    const nestedTarget = nestedTpl.content.querySelector('[data-id="nested-target"]') as HTMLElement

    expect(target.getAttribute('title')).toBe('first')
    expect(target.textContent?.trim()).toBe('first')
    expect(mod.seen.span).toBe(target)
    expect(content.querySelector('[data-id="conditional"]')?.textContent).toBe('first')
    expect(
      Array.from(content.querySelectorAll('[data-row]')).map(node => node.textContent),
    ).toEqual(['a', 'b'])
    expect(nestedTarget.getAttribute('title')).toBe('first')
    expect(nestedTarget.textContent).toBe('first')

    document.body.appendChild(button)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(mod.seen.clicks).toBe(1)

    mod.api.setTitle('next')
    await flushUpdates()
    expect(target.getAttribute('title')).toBe('next')
    expect(target.textContent?.trim()).toBe('next')
    expect(content.querySelector('[data-id="conditional"]')?.textContent).toBe('next')
    expect(nestedTarget.getAttribute('title')).toBe('next')
    expect(nestedTarget.textContent).toBe('next')

    mod.api.setItems(['c'])
    await flushUpdates()
    expect(
      Array.from(content.querySelectorAll('[data-row]')).map(node => node.textContent),
    ).toEqual(['c'])

    mod.api.hide()
    await flushUpdates()
    expect(content.querySelector('[data-id="conditional"]')).toBeNull()

    teardown()
    container.remove()
  })

  it('renders intrinsic children props as child content in fine-grained output', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: string): void }

      export function App() {
        let text = $state('hello')
        api = { set: value => (text = value) }
        return (
          <section>
            <div data-testid="static" children="static" />
            <div data-testid="reactive" children={text} />
            <div data-testid="array" children={['a', 'b']} />
            <div data-testid="node" children={<span>node</span>} />
            <div data-testid="conflict" children="ignored">explicit</div>
          </section>
        )
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

    await flushUpdates()

    const staticEl = container.querySelector('[data-testid="static"]') as HTMLDivElement
    const reactive = container.querySelector('[data-testid="reactive"]') as HTMLDivElement
    const array = container.querySelector('[data-testid="array"]') as HTMLDivElement
    const node = container.querySelector('[data-testid="node"]') as HTMLDivElement
    const conflict = container.querySelector('[data-testid="conflict"]') as HTMLDivElement

    expect(staticEl.textContent).toBe('static')
    expect(staticEl.getAttribute('children')).toBeNull()
    expect(reactive.textContent).toBe('hello')
    expect(array.textContent).toBe('ab')
    expect(node.querySelector('span')?.textContent).toBe('node')
    expect(node.getAttribute('children')).toBeNull()
    expect(conflict.textContent).toBe('explicit')
    expect(conflict.getAttribute('children')).toBeNull()

    mod.api.set('updated')
    await flushUpdates()
    expect(reactive.textContent).toBe('updated')

    teardown()
    container.remove()
  })

  it('renders ambiguous reactive JSX children through child insertion', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: {
        text(): void
        empty(): void
        node(): void
        array(): void
      }

      function Layout(props: { children?: unknown }) {
        return <section data-testid="layout">{props.children}</section>
      }

      export function App() {
        let value = $state<any>('text')
        let node = $state<any>(<span>initial node</span>)
        let list = $state<any>([<span>a</span>, <span>b</span>])
        api = {
          text: () => (value = 'next text'),
          empty: () => (value = null),
          node: () => (value = <span>next node</span>),
          array: () => (value = [<span>x</span>, <span>y</span>]),
        }
        return (
          <main>
            <div data-testid="switching">{value}</div>
            <div data-testid="node">{node}</div>
            <div data-testid="list">{list}</div>
            <Layout>
              <span>layout one</span>
              <span>layout two</span>
            </Layout>
          </main>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: {
        text(): void
        empty(): void
        node(): void
        array(): void
      }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const switching = container.querySelector('[data-testid="switching"]') as HTMLDivElement
    const node = container.querySelector('[data-testid="node"]') as HTMLDivElement
    const list = container.querySelector('[data-testid="list"]') as HTMLDivElement
    const layout = container.querySelector('[data-testid="layout"]') as HTMLElement

    expect(switching.textContent).toBe('text')
    expect(node.querySelector('span')?.textContent).toBe('initial node')
    expect(Array.from(list.querySelectorAll('span')).map(span => span.textContent)).toEqual([
      'a',
      'b',
    ])
    expect(Array.from(layout.querySelectorAll('span')).map(span => span.textContent)).toEqual([
      'layout one',
      'layout two',
    ])

    mod.api.node()
    await flushUpdates()
    expect(switching.querySelector('span')?.textContent).toBe('next node')

    mod.api.array()
    await flushUpdates()
    expect(Array.from(switching.querySelectorAll('span')).map(span => span.textContent)).toEqual([
      'x',
      'y',
    ])

    mod.api.empty()
    await flushUpdates()
    expect(switching.textContent).toBe('')

    mod.api.text()
    await flushUpdates()
    expect(switching.textContent).toBe('next text')

    teardown()
    container.remove()
  })

  it('stringifies boolean aria and data attributes in fine-grained output', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: boolean): void }

      export function App() {
        let on = $state(true)
        api = { set: value => (on = value) }
        return (
          <section>
            <div
              data-testid="static"
              aria-hidden={true}
              aria-expanded={false}
              data-active={true}
              data-off={false}
              draggable={true}
              contentEditable={true}
              spellCheck={false}
              hidden={true}
              disabled={false}
              bool:data-forced={true}
            />
            <div
              data-testid="static-false"
              draggable={false}
              contentEditable={false}
              spellCheck={true}
            />
            <div
              data-testid="dynamic"
              aria-live={on}
              data-on={on}
              draggable={on}
              contentEditable={on}
              spellCheck={on}
              hidden={on}
              bool:data-flag={on}
            />
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { set(value: boolean): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const staticEl = container.querySelector('[data-testid="static"]') as HTMLDivElement
    const staticFalseEl = container.querySelector('[data-testid="static-false"]') as HTMLDivElement
    const dynamicEl = container.querySelector('[data-testid="dynamic"]') as HTMLDivElement

    expect(staticEl.getAttribute('aria-hidden')).toBe('true')
    expect(staticEl.getAttribute('aria-expanded')).toBe('false')
    expect(staticEl.getAttribute('data-active')).toBe('true')
    expect(staticEl.getAttribute('data-off')).toBe('false')
    expect(staticEl.getAttribute('draggable')).toBe('true')
    expect(staticEl.draggable).toBe(true)
    expect(staticEl.getAttribute('contenteditable')).toBe('true')
    expect(staticEl.getAttribute('spellcheck')).toBe('false')
    expect(staticFalseEl.getAttribute('draggable')).toBe('false')
    expect(staticFalseEl.draggable).toBe(false)
    expect(staticFalseEl.getAttribute('contenteditable')).toBe('false')
    expect(staticFalseEl.getAttribute('spellcheck')).toBe('true')
    expect(staticEl.hasAttribute('hidden')).toBe(true)
    expect(staticEl.hasAttribute('disabled')).toBe(false)
    expect(staticEl.getAttribute('data-forced')).toBe('')

    expect(dynamicEl.getAttribute('aria-live')).toBe('true')
    expect(dynamicEl.getAttribute('data-on')).toBe('true')
    expect(dynamicEl.getAttribute('draggable')).toBe('true')
    expect(dynamicEl.draggable).toBe(true)
    expect(dynamicEl.getAttribute('contenteditable')).toBe('true')
    expect(dynamicEl.getAttribute('spellcheck')).toBe('true')
    expect(dynamicEl.hasAttribute('hidden')).toBe(true)
    expect(dynamicEl.getAttribute('data-flag')).toBe('')

    mod.api.set(false)
    await flushUpdates()

    expect(dynamicEl.getAttribute('aria-live')).toBe('false')
    expect(dynamicEl.getAttribute('data-on')).toBe('false')
    expect(dynamicEl.getAttribute('draggable')).toBe('false')
    expect(dynamicEl.draggable).toBe(false)
    expect(dynamicEl.getAttribute('contenteditable')).toBe('false')
    expect(dynamicEl.getAttribute('spellcheck')).toBe('false')
    expect(dynamicEl.hasAttribute('hidden')).toBe(false)
    expect(dynamicEl.hasAttribute('data-flag')).toBe(false)

    teardown()
    container.remove()
  })

  it('applies forced binding prefixes in fine-grained output', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return (
          <section>
            <div
              data-testid="static"
              attr:title="static title"
              bool:hidden={false}
              bool:data-forced={true}
              prop:textContent={'static text'}
            />
          </section>
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

    const staticEl = container.querySelector('[data-testid="static"]') as HTMLDivElement
    expect(staticEl.getAttribute('title')).toBe('static title')
    expect(staticEl.hasAttribute('hidden')).toBe(false)
    expect(staticEl.getAttribute('data-forced')).toBe('')
    expect(staticEl.textContent).toBe('static text')
    expect(staticEl.hasAttribute('attr:title')).toBe(false)
    expect(staticEl.hasAttribute('bool:hidden')).toBe(false)
    expect(staticEl.hasAttribute('bool:data-forced')).toBe(false)
    expect(staticEl.hasAttribute('prop:textContent')).toBe(false)

    teardown()
    container.remove()
  })

  it('updates forced binding prefixes in fine-grained output', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(text: string, hidden: boolean): void }

      export function App() {
        let text = $state('initial')
        let hidden = $state(false)
        api = {
          set: (nextText, nextHidden) => {
            text = nextText
            hidden = nextHidden
          },
        }
        return <div data-testid="dynamic" attr:title={text} bool:hidden={hidden} prop:textContent={text} />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { set(text: string, hidden: boolean): void }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const dynamicEl = container.querySelector('[data-testid="dynamic"]') as HTMLDivElement
    expect(dynamicEl.getAttribute('title')).toBe('initial')
    expect(dynamicEl.hasAttribute('hidden')).toBe(false)
    expect(dynamicEl.textContent).toBe('initial')

    mod.api.set('updated', true)
    await flushUpdates()

    expect(dynamicEl.getAttribute('title')).toBe('updated')
    expect(dynamicEl.hasAttribute('hidden')).toBe(true)
    expect(dynamicEl.textContent).toBe('updated')
    expect(dynamicEl.hasAttribute('attr:title')).toBe(false)
    expect(dynamicEl.hasAttribute('bool:hidden')).toBe(false)
    expect(dynamicEl.hasAttribute('prop:textContent')).toBe(false)

    teardown()
    container.remove()
  })

  it('keeps forced binding prefixes aligned with VNode fallback', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return (
          <div
            data-testid="fallback"
            attr:title="fallback title"
            bool:hidden={false}
            prop:textContent={'fallback text'}
          />
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      fineGrainedDom: false,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const fallback = container.querySelector('[data-testid="fallback"]') as HTMLDivElement
    expect(fallback.getAttribute('title')).toBe('fallback title')
    expect(fallback.hasAttribute('hidden')).toBe(false)
    expect(fallback.textContent).toBe('fallback text')
    expect(fallback.hasAttribute('attr:title')).toBe(false)
    expect(fallback.hasAttribute('bool:hidden')).toBe(false)
    expect(fallback.hasAttribute('prop:textContent')).toBe(false)

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

  it('keeps binding paths after adjacent static text split by comments', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: string): void }

      export function App() {
        let label = $state('first')
        api = { set: value => (label = value) }
        return <div data-testid="box">a{/* split */}b<span data-testid="span">s</span><em data-testid="target" title={label}>e</em></div>
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
    const target = container.querySelector('[data-testid="target"]') as HTMLElement

    expect(box.textContent).toBe('abse')
    expect(target.getAttribute('title')).toBe('first')

    mod.api.set('next')
    await flushUpdates()
    expect(target.getAttribute('title')).toBe('next')

    teardown()
    container.remove()
  })

  it('keeps escaped static JSX text as text in template output', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return (
          <section>
            <div data-testid="escaped">&lt;span&gt;safe&lt;/span&gt; &amp; done</div>
            <div data-testid="mixed">before &lt;x&gt;<em>inside</em> after &amp;</div>
            <p data-testid="nbsp">a&nbsp;b</p>
            <svg data-testid="svg"><text>&lt;icon&gt;</text></svg>
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

    await flushUpdates()

    const escaped = container.querySelector('[data-testid="escaped"]') as HTMLDivElement
    const mixed = container.querySelector('[data-testid="mixed"]') as HTMLDivElement
    const nbsp = container.querySelector('[data-testid="nbsp"]') as HTMLParagraphElement
    const svgText = container.querySelector('[data-testid="svg"] text') as SVGTextElement

    expect(escaped.innerHTML).toBe('&lt;span&gt;safe&lt;/span&gt; &amp; done')
    expect(escaped.querySelector('span')).toBeNull()
    expect(mixed.innerHTML).toBe('before &lt;x&gt;<em>inside</em> after &amp;')
    expect(nbsp.textContent).toBe('a\u00a0b')
    expect(svgText.textContent).toBe('<icon>')

    teardown()
    container.remove()
  })

  it('keeps inline MathML templates in MathML namespace when undefined is shadowed', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const undefined = true
        const shadow = undefined ? 'yes' : 'no'
        return (
          <math data-id="math" data-shadow={shadow}>
            {shadow ? <mi data-id="inline">x</mi> : null}
          </math>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const output = transformCommonJS(source, { fineGrainedDom: true })
    expect(output).toMatch(/"<mi data-id=\\"inline\\">x<\/mi>", void 0, void 0, true/)
    expect(output).not.toMatch(/"<mi data-id=\\"inline\\">x<\/mi>", undefined, undefined, true/)

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const math = container.querySelector('[data-id="math"]') as MathMLElement
    const mi = container.querySelector('[data-id="inline"]') as MathMLElement

    expect(math.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
    expect(mi.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
    expect(math.getAttribute('data-shadow')).toBe('yes')

    teardown()
    container.remove()
  })

  it('keeps hoisted list MathML templates in MathML namespace when undefined is shadowed', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const undefined = true
        const shadow = undefined ? 'yes' : 'no'
        const items = [1]
        return (
          <math data-id="math" data-shadow={shadow}>
            {items.map(item => <mi key={item} data-id="list-item">x</mi>)}
          </math>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const output = transformCommonJS(source, { fineGrainedDom: true })
    expect(output).toMatch(/"<mi data-id=\\"list-item\\">x<\/mi>", void 0, void 0, true/)
    expect(output).not.toMatch(/"<mi data-id=\\"list-item\\">x<\/mi>", undefined, undefined, true/)

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const math = container.querySelector('[data-id="math"]') as MathMLElement
    const mi = container.querySelector('[data-id="list-item"]') as MathMLElement

    expect(math.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
    expect(mi.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
    expect(math.getAttribute('data-shadow')).toBe('yes')

    teardown()
    container.remove()
  })

  it('renders dynamic annotation-xml HTML children in the HTML namespace', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const show = true
        return (
          <math data-id="math">
            <annotation-xml encoding="text/html">
              {show && <mi data-id="html-mi">html</mi>}
            </annotation-xml>
            <annotation-xml encoding=" APPLICATION/XHTML+XML ">
              {show && <><mi data-id="fragment-mi">fragment</mi></>}
            </annotation-xml>
            <annotation-xml encoding="application/xml">
              {show && <mi data-id="math-mi">math</mi>}
            </annotation-xml>
          </math>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const output = transformCommonJS(source, { fineGrainedDom: true })
    expect(output).not.toMatch(/"<mi data-id=\\"html-mi\\">html<\/mi>", void 0, void 0, true/)
    expect(output).not.toMatch(
      /"<mi data-id=\\"fragment-mi\\">fragment<\/mi>", void 0, void 0, true/,
    )
    expect(output).toMatch(/"<mi data-id=\\"math-mi\\">math<\/mi>", void 0, void 0, true/)

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const htmlMi = container.querySelector('[data-id="html-mi"]') as Element
    const fragmentMi = container.querySelector('[data-id="fragment-mi"]') as Element
    const mathMi = container.querySelector('[data-id="math-mi"]') as Element

    expect(htmlMi.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(fragmentMi.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(mathMi.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')

    teardown()
    container.remove()
  })

  it('renders dynamic MathML text integration point children in the HTML namespace', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const show = true
        const items = [1]
        return (
          <math data-id="math">
            <mtext>{show && <mi data-id="mtext-mi">text</mi>}</mtext>
            <mi>{show && <><mi data-id="fragment-mi">fragment</mi></>}</mi>
            <mo>{items.map(item => <mi key={item} data-id="list-mi">list</mi>)}</mo>
            <mn>{show && <mglyph data-id="glyph"></mglyph>}</mn>
          </math>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const output = transformCommonJS(source, { fineGrainedDom: true })
    expect(output).not.toMatch(/"<mi data-id=\\"mtext-mi\\">text<\/mi>", void 0, void 0, true/)
    expect(output).not.toMatch(
      /"<mi data-id=\\"fragment-mi\\">fragment<\/mi>", void 0, void 0, true/,
    )
    expect(output).not.toMatch(/"<mi data-id=\\"list-mi\\">list<\/mi>", void 0, void 0, true/)
    expect(output).toMatch(/"<mglyph data-id=\\"glyph\\"><\/mglyph>", void 0, void 0, true/)

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const mtextMi = container.querySelector('[data-id="mtext-mi"]') as Element
    const fragmentMi = container.querySelector('[data-id="fragment-mi"]') as Element
    const listMi = container.querySelector('[data-id="list-mi"]') as Element
    const glyph = container.querySelector('[data-id="glyph"]') as Element

    expect(mtextMi.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(fragmentMi.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(listMi.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(glyph.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')

    teardown()
    container.remove()
  })

  it('renders dynamic SVG integration point children in the HTML namespace', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const show = true
        const items = [1]
        return (
          <svg data-id="svg">
            <title>
              {show && <circle data-id="title-circle"></circle>}
              {show && <div data-id="title-div">html</div>}
            </title>
            <desc>{show && <><circle data-id="desc-circle"></circle></>}</desc>
            <foreignObject>
              {items.map(item => <circle key={item} data-id="foreign-circle"></circle>)}
            </foreignObject>
            <g>{show && <circle data-id="svg-circle"></circle>}</g>
          </svg>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const output = transformCommonJS(source, { fineGrainedDom: true })
    expect(output).not.toMatch(/"<circle data-id=\\"title-circle\\"><\/circle>", void 0, true/)
    expect(output).not.toMatch(/"<div data-id=\\"title-div\\">html<\/div>", void 0, true/)
    expect(output).not.toMatch(/"<circle data-id=\\"desc-circle\\"><\/circle>", void 0, true/)
    expect(output).not.toMatch(/"<circle data-id=\\"foreign-circle\\"><\/circle>", void 0, true/)
    expect(output).toMatch(/"<circle data-id=\\"svg-circle\\"><\/circle>", void 0, true/)

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const titleCircle = container.querySelector('[data-id="title-circle"]') as Element
    const titleDiv = container.querySelector('[data-id="title-div"]') as Element
    const descCircle = container.querySelector('[data-id="desc-circle"]') as Element
    const foreignCircle = container.querySelector('[data-id="foreign-circle"]') as Element
    const svgCircle = container.querySelector('[data-id="svg-circle"]') as Element

    expect(titleCircle.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(titleDiv.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(descCircle.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(foreignCircle.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(svgCircle.namespaceURI).toBe('http://www.w3.org/2000/svg')

    teardown()
    container.remove()
  })

  it.each([
    { mode: 'fine-grained', options: { fineGrainedDom: true } },
    { mode: 'vnode', options: { fineGrainedDom: false } },
  ] satisfies Array<{ mode: string; options: FictCompilerOptions }>)(
    'sets dynamic namespaced attributes with setAttributeNS in $mode mode',
    async ({ options }) => {
      const source = `
        import { $state, render } from 'fict'

        export let api: { setHref(value: string | null): void; setLang(value: string): void }

        function App() {
          const href = $state<string | null>('#a')
          const lang = $state('en')
          api = {
            setHref: value => href(value),
            setLang: value => lang(value),
          }

          return (
            <div>
              <svg>
                <use data-id="dynamic-use" xlink:href={href()} xml:lang={lang()}></use>
                <use data-id="static-use" xlink:href="#static"></use>
              </svg>
              <math>
                <maction data-id="dynamic-maction" xlink:href={href()} xml:lang={lang()}></maction>
              </math>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        api: { setHref(value: string | null): void; setLang(value: string): void }
      }>(source, options)
      const container = document.createElement('div')
      document.body.appendChild(container)
      const teardown = mod.mount(container)

      await flushUpdates()

      const xlinkNs = 'http://www.w3.org/1999/xlink'
      const xmlNs = 'http://www.w3.org/XML/1998/namespace'
      const dynamicUse = container.querySelector('[data-id="dynamic-use"]') as Element
      const staticUse = container.querySelector('[data-id="static-use"]') as Element
      const dynamicMaction = container.querySelector('[data-id="dynamic-maction"]') as Element

      expect(dynamicUse.getAttributeNS(xlinkNs, 'href')).toBe('#a')
      expect(dynamicUse.getAttributeNS(xmlNs, 'lang')).toBe('en')
      expect(staticUse.getAttributeNS(xlinkNs, 'href')).toBe('#static')
      expect(dynamicMaction.getAttributeNS(xlinkNs, 'href')).toBe('#a')
      expect(dynamicMaction.getAttributeNS(xmlNs, 'lang')).toBe('en')

      mod.api.setHref('#b')
      mod.api.setLang('fr')
      await flushUpdates()

      expect(dynamicUse.getAttributeNS(xlinkNs, 'href')).toBe('#b')
      expect(dynamicUse.getAttributeNS(xmlNs, 'lang')).toBe('fr')
      expect(dynamicMaction.getAttributeNS(xlinkNs, 'href')).toBe('#b')
      expect(dynamicMaction.getAttributeNS(xmlNs, 'lang')).toBe('fr')

      mod.api.setHref(null)
      await flushUpdates()

      expect(dynamicUse.hasAttributeNS(xlinkNs, 'href')).toBe(false)
      expect(dynamicMaction.hasAttributeNS(xlinkNs, 'href')).toBe(false)

      teardown()
      container.remove()
    },
  )

  it('sets namespaced spread attributes on SVG and MathML descendants', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { setHref(value: string | null): void; setLang(value: string): void }

      function App() {
        const href = $state<string | null>('#a')
        const lang = $state('en')
        api = {
          setHref: value => href(value),
          setLang: value => lang(value),
        }

        return (
          <div>
            <svg data-id="svg-root" {...{ 'xml:lang': lang() }}>
              <use data-id="svg-use" {...{ 'xlink:href': href(), 'xml:lang': lang() }}></use>
            </svg>
            <math data-id="math-root" {...{ 'xml:lang': lang() }}>
              <maction data-id="math-action" {...{ 'xlink:href': href(), 'xml:lang': lang() }}></maction>
            </math>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { setHref(value: string | null): void; setLang(value: string): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const xlinkNs = 'http://www.w3.org/1999/xlink'
    const xmlNs = 'http://www.w3.org/XML/1998/namespace'
    const svgRoot = container.querySelector('[data-id="svg-root"]') as Element
    const svgUse = container.querySelector('[data-id="svg-use"]') as Element
    const mathRoot = container.querySelector('[data-id="math-root"]') as Element
    const mathAction = container.querySelector('[data-id="math-action"]') as Element

    expect(svgRoot.getAttributeNS(xmlNs, 'lang')).toBe('en')
    expect(svgUse.getAttributeNS(xlinkNs, 'href')).toBe('#a')
    expect(svgUse.getAttributeNS(xmlNs, 'lang')).toBe('en')
    expect(mathRoot.getAttributeNS(xmlNs, 'lang')).toBe('en')
    expect(mathAction.getAttributeNS(xlinkNs, 'href')).toBe('#a')
    expect(mathAction.getAttributeNS(xmlNs, 'lang')).toBe('en')
    expect(svgUse.hasAttribute('xlink:href')).toBe(false)
    expect(mathAction.hasAttribute('xlink:href')).toBe(false)

    mod.api.setHref('#b')
    mod.api.setLang('fr')
    await flushUpdates()

    expect(svgRoot.getAttributeNS(xmlNs, 'lang')).toBe('fr')
    expect(svgUse.getAttributeNS(xlinkNs, 'href')).toBe('#b')
    expect(svgUse.getAttributeNS(xmlNs, 'lang')).toBe('fr')
    expect(mathRoot.getAttributeNS(xmlNs, 'lang')).toBe('fr')
    expect(mathAction.getAttributeNS(xlinkNs, 'href')).toBe('#b')
    expect(mathAction.getAttributeNS(xmlNs, 'lang')).toBe('fr')

    mod.api.setHref(null)
    await flushUpdates()

    expect(svgUse.hasAttributeNS(xlinkNs, 'href')).toBe(false)
    expect(mathAction.hasAttributeNS(xlinkNs, 'href')).toBe(false)

    teardown()
    container.remove()
  })

  it('keeps authored whitespace children from rendering earlier spread children', async () => {
    const source = `
      import { render } from 'fict'

      function App() {
        const props = { children: 'spread' }
        return (
          <div>
            <div data-id="single-space" {...props}> </div>
            <div data-id="newline-space" {...props}>
            </div>
            <div data-id="comment-only" {...props}>{/* comment */}</div>
            <div data-id="expression-empty" {...props}>{''}</div>
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

    const singleSpace = container.querySelector('[data-id="single-space"]') as HTMLElement
    const newlineSpace = container.querySelector('[data-id="newline-space"]') as HTMLElement
    const commentOnly = container.querySelector('[data-id="comment-only"]') as HTMLElement
    const expressionEmpty = container.querySelector('[data-id="expression-empty"]') as HTMLElement

    expect(singleSpace.textContent).toBe(' ')
    expect(newlineSpace.textContent).toBe('')
    expect(commentOnly.textContent).toBe('')
    expect(expressionEmpty.textContent).toBe('')

    teardown()
    container.remove()
  })

  it('sets SVG spread classes through the class attribute in fine-grained output', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: string | null): void; toggle(): void }

      function App() {
        let cls = $state<string | null>('hot')
        let active = $state(true)
        let show = $state(true)
        api = {
          set(value) {
            cls = value
          },
          toggle() {
            active = !active
          },
        }

        return (
          <svg data-id="root" {...{ class: cls }}>
            <circle data-id="circle" {...{ class: cls }} />
            <rect data-id="rect" {...{ className: cls }} />
            <path data-id="path" {...{ class: { active, off: !active } }} />
            {show && <g data-id="dynamic" {...{ class: cls }}></g>}
          </svg>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { set(value: string | null): void; toggle(): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const root = container.querySelector('[data-id="root"]') as SVGSVGElement
    const circle = container.querySelector('[data-id="circle"]') as SVGCircleElement
    const rect = container.querySelector('[data-id="rect"]') as SVGRectElement
    const path = container.querySelector('[data-id="path"]') as SVGPathElement
    const dynamic = container.querySelector('[data-id="dynamic"]') as SVGGElement

    expect(root.getAttribute('class')).toBe('hot')
    expect(circle.getAttribute('class')).toBe('hot')
    expect(circle.className.baseVal).toBe('hot')
    expect(rect.getAttribute('class')).toBe('hot')
    expect(rect.className.baseVal).toBe('hot')
    expect(path.classList.contains('active')).toBe(true)
    expect(path.classList.contains('off')).toBe(false)
    expect(dynamic.getAttribute('class')).toBe('hot')

    mod.api.set('cool')
    mod.api.toggle()
    await flushUpdates()

    expect(root.getAttribute('class')).toBe('cool')
    expect(circle.getAttribute('class')).toBe('cool')
    expect(rect.getAttribute('class')).toBe('cool')
    expect(path.classList.contains('active')).toBe(false)
    expect(path.classList.contains('off')).toBe(true)
    expect(dynamic.getAttribute('class')).toBe('cool')

    mod.api.set(null)
    await flushUpdates()

    expect(root.hasAttribute('class')).toBe(false)
    expect(circle.hasAttribute('class')).toBe(false)
    expect(rect.hasAttribute('class')).toBe(false)
    expect(dynamic.hasAttribute('class')).toBe(false)

    teardown()
    container.remove()
  })

  it('keeps generated template temps from shadowing source bindings', async () => {
    const cases: Array<{
      source: string
      assert(container: HTMLDivElement): void
    }> = [
      {
        source: `
          import { render } from 'fict'

          export function App() {
            const __root_0 = 'user-root'
            return <div data-id="target">{__root_0 ? <span data-id="value">{__root_0}</span> : null}</div>
          }

          export function mount(el: HTMLElement) {
            return render(() => <App />, el)
          }
        `,
        assert(container) {
          expect(container.querySelector('[data-id="value"]')?.textContent).toBe('user-root')
        },
      },
      {
        source: `
          import { render } from 'fict'

          export function App() {
            const __tmpl_1 = 'user-template'
            return <div data-id="target" title={__tmpl_1}>x</div>
          }

          export function mount(el: HTMLElement) {
            return render(() => <App />, el)
          }
        `,
        assert(container) {
          expect(container.querySelector('[data-id="target"]')?.getAttribute('title')).toBe(
            'user-template',
          )
        },
      },
      {
        source: `
          import { render } from 'fict'

          export function App() {
            const __el_2 = 'user-path'
            return <section><span data-id="target" title={__el_2}>x</span></section>
          }

          export function mount(el: HTMLElement) {
            return render(() => <App />, el)
          }
        `,
        assert(container) {
          expect(container.querySelector('[data-id="target"]')?.getAttribute('title')).toBe(
            'user-path',
          )
        },
      },
      {
        source: `
          import { render } from 'fict'

          export function App() {
            const __end_3 = 'user-end'
            return <div data-id="target">{__end_3 ? <span data-id="value">{__end_3}</span> : null}</div>
          }

          export function mount(el: HTMLElement) {
            return render(() => <App />, el)
          }
        `,
        assert(container) {
          expect(container.querySelector('[data-id="value"]')?.textContent).toBe('user-end')
        },
      },
    ]

    for (const testCase of cases) {
      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
      }>(testCase.source, { fineGrainedDom: true })
      const container = document.createElement('div')
      document.body.appendChild(container)
      const teardown = mod.mount(container)

      await flushUpdates()
      testCase.assert(container)

      teardown()
      container.remove()
    }
  })

  it('preserves whitespace-only static JSX text in template output', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return (
          <section>
            <pre data-testid="pre">  </pre>
            <span data-testid="span"> </span>
            <p data-testid="nbsp">&nbsp;</p>
            <div data-testid="inline">A <strong>B</strong> C</div>
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

    await flushUpdates()

    expect(container.querySelector('[data-testid="pre"]')?.textContent).toBe('  ')
    expect(container.querySelector('[data-testid="span"]')?.textContent).toBe(' ')
    expect(container.querySelector('[data-testid="nbsp"]')?.textContent).toBe('\u00a0')
    expect(container.querySelector('[data-testid="inline"]')?.textContent).toBe('A B C')

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

  it('keeps inherited spread props hidden from single component spreads', async () => {
    const source = `
      import { render } from 'fict'

      export const seen: {
        keys: string[]
        secret: unknown
        hasSecret: boolean
      } = {
        keys: [],
        secret: undefined,
        hasSecret: false,
      }

      function Child(props: Record<string, unknown>) {
        seen.keys = Object.keys(props)
        seen.secret = props.secret
        seen.hasSecret = 'secret' in props
        return <div data-testid="box">{seen.keys.join(',') + ':' + String(seen.secret)}</div>
      }

      export function App() {
        const proto = { secret: 'proto' }
        const props = Object.create(proto)
        props.visible = 'own'
        return <Child {...props} />
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
        hasSecret: boolean
      }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(mod.seen.keys).toEqual(['visible'])
    expect(mod.seen.secret).toBeUndefined()
    expect(mod.seen.hasSecret).toBe(false)
    expect(box.textContent).toBe('visible:undefined')

    teardown()
    container.remove()
  })

  it('keeps inherited spread props hidden from merged component props', async () => {
    const source = `
      import { render } from 'fict'

      export const seen: {
        keys: string[]
        secret: unknown
        hasSecret: boolean
      } = {
        keys: [],
        secret: undefined,
        hasSecret: false,
      }

      function Child(props: Record<string, unknown>) {
        seen.keys = Object.keys(props)
        seen.secret = props.secret
        seen.hasSecret = 'secret' in props
        return <div data-testid="box">{seen.keys.join(',') + ':' + String(seen.secret)}</div>
      }

      export function App() {
        const proto = { secret: 'proto' }
        const props = Object.create(proto)
        props.visible = 'own'
        return <Child {...props} other="x" />
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
        hasSecret: boolean
      }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(mod.seen.keys).toEqual(['visible', 'other'])
    expect(mod.seen.secret).toBeUndefined()
    expect(mod.seen.hasSecret).toBe(false)
    expect(box.textContent).toBe('visible,other:undefined')

    teardown()
    container.remove()
  })

  it('keeps reactive computed spread keys live for component props', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { flip(): void }
      function Child(props) {
        return (
          <span
            data-testid="value"
            data-keys={Object.keys(props).join(',')}
            data-has-b={'b' in props ? 'yes' : 'no'}
          >
            {String(props[props.k])}
          </span>
        )
      }

      export function App() {
        let key = $state('a')
        let value = $state('A')
        api = {
          flip() {
            key = 'b'
            value = 'B'
          },
        }
        return <Child {...{ [key]: value }} k={key} />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { flip(): void }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const value = container.querySelector('[data-testid="value"]') as HTMLSpanElement

    expect(value.textContent).toBe('A')
    expect(value.getAttribute('data-keys')).toBe('a,k')
    expect(value.getAttribute('data-has-b')).toBe('no')

    mod.api.flip()
    await flushUpdates()

    expect(value.textContent).toBe('B')
    expect(value.getAttribute('data-keys')).toBe('b,k')
    expect(value.getAttribute('data-has-b')).toBe('yes')

    teardown()
    container.remove()
  })

  it('does not invoke function-valued component spread sources', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []
      export const seen: {
        keys: string[]
        foo: unknown
        bar: unknown
      } = {
        keys: [],
        foo: undefined,
        bar: undefined,
      }

      function Child(props: Record<string, unknown>) {
        seen.keys = Object.keys(props)
        seen.foo = props.foo
        seen.bar = props.bar
        return <div data-testid="box">{String(seen.foo) + ':' + String(seen.bar)}</div>
      }

      export function App() {
        function fn() {
          log.push('called')
          return { foo: 'return' }
        }
        ;(fn as any).foo = 'own'
        return <Child {...fn} bar="b" />
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      log: string[]
      seen: {
        keys: string[]
        foo: unknown
        bar: unknown
      }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const box = container.querySelector('[data-testid="box"]') as HTMLDivElement

    expect(mod.log).toEqual([])
    expect(mod.seen.keys).toEqual(['foo', 'bar'])
    expect(mod.seen.foo).toBe('own')
    expect(mod.seen.bar).toBe('b')
    expect(box.textContent).toBe('own:b')

    teardown()
    container.remove()
  })

  it('applies ToObject semantics to primitive component spread sources', async () => {
    const source = `
      import { render } from 'fict'

      export const seen: Array<{
        type: string
        keys: string[]
        first: unknown
        x: unknown
      }> = []

      const big = 1n
      const sym = Symbol('source')

      function Child(props: Record<string, unknown>) {
        seen.push({
          type: typeof props,
          keys: Object.keys(props),
          first: props[0],
          x: props.x,
        })
        return <span />
      }

      export function App() {
        return (
          <section>
            <Child {...'ab'} />
            <Child {...'cd'} x="x" />
            <Child {...42} />
            <Child {...42} x="n" />
            <Child {...true} />
            <Child {...false} x="b" />
            <Child {...big} />
            <Child {...sym} x="s" />
            <Child {...null} />
            <Child {...undefined} x="u" />
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        seen.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      seen: Array<{
        type: string
        keys: string[]
        first: unknown
        x: unknown
      }>
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    expect(mod.seen).toEqual([
      { type: 'object', keys: ['0', '1'], first: 'a', x: undefined },
      { type: 'object', keys: ['0', '1', 'x'], first: 'c', x: 'x' },
      { type: 'object', keys: [], first: undefined, x: undefined },
      { type: 'object', keys: ['x'], first: undefined, x: 'n' },
      { type: 'object', keys: [], first: undefined, x: undefined },
      { type: 'object', keys: ['x'], first: undefined, x: 'b' },
      { type: 'object', keys: [], first: undefined, x: undefined },
      { type: 'object', keys: ['x'], first: undefined, x: 's' },
      { type: 'object', keys: [], first: undefined, x: undefined },
      { type: 'object', keys: ['x'], first: undefined, x: 'u' },
    ])

    teardown()
    container.remove()
  })

  it('snapshots object component spread sources at render time', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []
      export let getterReads = 0

      const single = { kind: 'single', label: 'a' }
      const merged = { kind: 'merged', label: 'm' }
      let getterLabel = 'g'
      const getterSource = {
        kind: 'getter',
        get label() {
          getterReads += 1
          return getterLabel
        },
      }

      function Child(props: Record<string, unknown>) {
        return (
          <button
            data-testid={String(props.kind)}
            onClick={() => log.push(String(props.kind) + ':' + String(props.label))}
          >
            go
          </button>
        )
      }

      export function App() {
        return (
          <section>
            <Child {...single} />
            <Child {...merged} extra="x" />
            <Child {...getterSource} extra="y" />
          </section>
        )
      }

      export function mutate() {
        single.label = 'b'
        merged.label = 'n'
        getterLabel = 'h'
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        getterReads = 0
        single.label = 'a'
        merged.label = 'm'
        getterLabel = 'g'
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      mutate: () => void
      log: string[]
      getterReads: number
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    expect(mod.getterReads).toBe(1)

    mod.mutate()
    ;(container.querySelector('[data-testid="single"]') as HTMLButtonElement).click()
    ;(container.querySelector('[data-testid="merged"]') as HTMLButtonElement).click()
    ;(container.querySelector('[data-testid="getter"]') as HTMLButtonElement).click()

    expect(mod.log).toEqual(['single:a', 'merged:m', 'getter:g'])
    expect(mod.getterReads).toBe(1)

    teardown()
    container.remove()
  })

  it.each([
    { tag: 'div', spreadKey: 'class', explicitAttr: 'class', expectedAttr: 'class' },
    { tag: 'div', spreadKey: 'className', explicitAttr: 'class', expectedAttr: 'class' },
    { tag: 'div', spreadKey: 'class', explicitAttr: 'className', expectedAttr: 'class' },
    { tag: 'div', spreadKey: 'className', explicitAttr: 'className', expectedAttr: 'class' },
    { tag: 'label', spreadKey: 'for', explicitAttr: 'for', expectedAttr: 'for' },
    { tag: 'label', spreadKey: 'htmlFor', explicitAttr: 'for', expectedAttr: 'for' },
    { tag: 'label', spreadKey: 'for', explicitAttr: 'htmlFor', expectedAttr: 'for' },
    { tag: 'label', spreadKey: 'htmlFor', explicitAttr: 'htmlFor', expectedAttr: 'for' },
  ])(
    'keeps explicit $explicitAttr overriding spread $spreadKey on <$tag>',
    async ({ tag, spreadKey, explicitAttr, expectedAttr }) => {
      const source = `
        import { render } from 'fict'

        export function App() {
          const attrs = { ${spreadKey}: 'spread' }
          return <${tag} data-testid="target" {...attrs} ${explicitAttr}="fixed" />
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
      const target = container.querySelector('[data-testid="target"]') as HTMLElement

      expect(target.getAttribute(expectedAttr)).toBe('fixed')

      teardown()
      container.remove()
    },
  )

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

  it('preserves custom map receiver lookup and return values', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      export function App() {
        const custom = {
          map(callback: (item: string) => unknown) {
            calls.push('custom')
            return ['custom'].map(callback)
          },
        }
        const proxy = new Proxy(['proxy'], {
          get(target, key, receiver) {
            if (key === 'map') calls.push('proxy')
            const value = Reflect.get(target, key, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const inherited = Object.create({
          map(callback: (item: string) => unknown) {
            calls.push('inherited')
            return ['inherited'].map(callback)
          },
        })

        return (
          <section>
            <ul data-id="custom">{custom.map(item => <li>{item}</li>)}</ul>
            <ul data-id="proxy">{proxy.map(item => <li>{item}</li>)}</ul>
            <ul data-id="inherited">{inherited.map((item: string) => <li>{item}</li>)}</ul>
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        calls.length = 0
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

    expect(mod.calls).toEqual(['custom', 'proxy', 'inherited'])
    expect(Array.from(container.querySelectorAll('li')).map(node => node.textContent)).toEqual([
      'custom',
      'proxy',
      'inherited',
    ])

    teardown()
    container.remove()
  })

  it('preserves runtime errors for non-callable map methods', () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = { map: 123 }
        return <div>{items.map((item: string) => <span>{item}</span>)}</div>
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

  it('preserves optional map method calls on non-trusted receivers', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items: { map?: (callback: (item: string) => unknown) => unknown[] } = {}
        return <ul>{items.map?.(item => <li>{item}</li>)}</ul>
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

    expect(container.querySelectorAll('li')).toHaveLength(0)

    teardown()
    container.remove()
  })

  it('reruns map callbacks with observable side effects for reused keys', async () => {
    const source = `
      import { $state, render } from 'fict'

      type Item = { id: number; name: string }

      export const log: string[] = []
      export let api: { rename(): void }

      export function App() {
        let items = $state<Item[]>([{ id: 1, name: 'a' }])
        api = {
          rename() {
            items = [{ id: 1, name: 'b' }]
          },
        }

        return (
          <div>
            {items.map(item => {
              log.push(item.name)
              return <span key={item.id}>{item.name}</span>
            })}
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { rename(): void }
      log: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    expect(mod.log).toEqual(['a'])
    expect(container.querySelector('span')?.textContent).toBe('a')

    mod.api.rename()
    await flushUpdates()

    expect(mod.log).toEqual(['a', 'b'])
    expect(container.querySelector('span')?.textContent).toBe('b')

    teardown()
    container.remove()
  })

  it('does not evaluate keyed JSX branch keys for skipped non-JSX map branches', async () => {
    const source = `
      import { render } from 'fict'

      type Item = { id: number; show: boolean }

      export const log: string[] = []

      function keyFor(item: Item) {
        log.push('key ' + item.id)
        if (!item.show) {
          throw new Error('key for hidden item ' + item.id)
        }
        return item.id
      }

      export function App() {
        const items: Item[] = [
          { id: 1, show: false },
          { id: 2, show: true },
        ]

        return (
          <div>
            {items.map(item =>
              item.show
                ? <span key={keyFor(item)}>{item.id}</span>
                : null
            )}
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      log: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    expect(container.textContent).toBe('2')
    expect(mod.log).not.toContain('key 1')

    teardown()
    container.remove()
  })

  it('does not duplicate branch tests when conditional list keys are impure', async () => {
    const source = `
      import { render } from 'fict'

      type Item = { id: number; left: boolean }

      export const log: string[] = []

      function pickLeft(item: Item) {
        log.push('test ' + item.id)
        return item.left
      }

      function leftKey(item: Item) {
        log.push('left ' + item.id)
        return 'L' + item.id
      }

      function rightKey(item: Item) {
        log.push('right ' + item.id)
        return 'R' + item.id
      }

      export function App() {
        const items: Item[] = [
          { id: 1, left: true },
          { id: 2, left: false },
        ]

        return (
          <div>
            {items.map(item =>
              pickLeft(item)
                ? <span key={leftKey(item)}>L</span>
                : <span key={rightKey(item)}>R</span>
            )}
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      log: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    expect(container.textContent).toBe('LR')
    expect(mod.log.filter(entry => entry.startsWith('test '))).toEqual(['test 1', 'test 2'])

    teardown()
    container.remove()
  })

  it('preserves sequence prefixes before keyed JSX list children', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      export function App() {
        const items = [1, 2]
        let seq = 0

        return (
          <ul>
            {items.map(item => (
              log.push('pre ' + item + ':' + seq),
              seq++,
              <li key={(log.push('key ' + item + ':' + seq), seq)}>{seq}</li>
            ))}
          </ul>
        )
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      log: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    expect(mod.log).toEqual(['pre 1:0', 'key 1:1', 'pre 2:1', 'key 2:2'])
    expect(container.textContent).toBe('12')

    teardown()
    container.remove()
  })

  it('keeps selector hoist temps from shadowing list item locals', async () => {
    const reservedNames = Array.from({ length: 21 }, (_, index) => `__sel_${index}`)
    const expected = reservedNames.map((_, index) => `user${index}`).join('|')
    const source = `
      import { $state, render } from 'fict'

      export function App() {
        ${reservedNames.map((name, index) => `const ${name} = 'user${index}'`).join('\n        ')}
        let selected = $state(1)
        const items = [{ id: 1, name: 'a' }]

        return (
          <ul>
            {items.map(item => (
              <li key={item.id} class={item.id === selected ? 'on' : ''}>
                {[${reservedNames.join(', ')}].join('|')}
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
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    const item = container.querySelector('li')
    expect(item?.className).toBe('on')
    expect(item?.textContent).toBe(expected)

    teardown()
    container.remove()
  })

  it('does not constify nested function parameters that shadow list items', async () => {
    const source = `
      import { $state, render } from 'fict'

      export function App() {
        let items = $state([{ id: 1, label: 'one' }])
        let selected = $state(1)

        return (
          <ul>
            {items.map(item => (
              <li key={item.id}>
                {(() => {
                  const renderInner = item => (
                    <span data-id="inner" class={item.id === selected ? 'on' : ''}>
                      {item.label}
                    </span>
                  )
                  return renderInner({ id: 99, label: 'inner' })
                })()}
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
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const inner = container.querySelector('[data-id="inner"]') as HTMLSpanElement
    expect(inner.textContent).toBe('inner')
    expect(inner.getAttribute('class')).toBe('')

    teardown()
    container.remove()
  })

  it('preserves loose equality in selector-shaped list classes', async () => {
    const source = `
      import { $state, render } from 'fict'

      export function App() {
        let selected = $state('1')
        const items = [{ id: 1, name: 'a' }]

        return (
          <ul>
            {items.map(item => (
              <li data-id="loose" key={'loose-' + item.id} class={item.id == selected ? 'on' : ''}>
                {item.name}
              </li>
            ))}
            {items.map(item => (
              <li data-id="strict" key={'strict-' + item.id} class={item.id === selected ? 'on' : ''}>
                {item.name}
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
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    expect(container.querySelector('[data-id="loose"]')?.className).toBe('on')
    expect(container.querySelector('[data-id="strict"]')?.className).toBe('')

    teardown()
    container.remove()
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

  it('preserves map callback parameter mutation semantics', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [1]

        return (
          <div>
            {items.map(item => {
              item = item + 1
              return <span data-id="assign" key="assign">{item}</span>
            })}
            {items.map(item => {
              item++
              return <span data-id="postfix" key="postfix">{item}</span>
            })}
            {items.map((item, index) => {
              index = index + 10
              return <span data-id="index" key="index">{index}</span>
            })}
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
    await flushUpdates()

    expect(container.querySelector('[data-id="assign"]')?.textContent).toBe('2')
    expect(container.querySelector('[data-id="postfix"]')?.textContent).toBe('2')
    expect(container.querySelector('[data-id="index"]')?.textContent).toBe('10')

    teardown()
    container.remove()
  })

  it('preserves nested lexical bindings inside list callbacks', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [1]

        return (
          <div>
            {items.map(item => {
              function f(item) {
                return item
              }
              return <span data-id="fn" key="fn">{f(2)}</span>
            })}
            {items.map(item => {
              for (let item of [3]) {
                return <span data-id="for-of" key="for-of">{item}</span>
              }
            })}
            {items.map(item => {
              try {
                throw 4
              } catch (item) {
                return <span data-id="catch" key="catch">{item}</span>
              }
            })}
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
    await flushUpdates()

    expect(container.querySelector('[data-id="fn"]')?.textContent).toBe('2')
    expect(container.querySelector('[data-id="for-of"]')?.textContent).toBe('3')
    expect(container.querySelector('[data-id="catch"]')?.textContent).toBe('4')

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

      export let setCount: (value: number) => void

      export function App() {
        let count = $state(0)
        setCount = value => {
          count = value
        }

        const fallbackSummary = 'fallback=' + count
        const richStats = 'rich-stats=' + count * 10
        const richBadge = 'rich-badge=' + (count + 1000)

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
        return render(() => <App />, el)
      }
    `

      const mod = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
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

      await flushMicrotasks()
      expect(activeBranch()).toBe('fallback')
      expect(fallbackText()).toContain('fallback=0')

      mod.setCount(1)
      await flushMicrotasks()
      expect(activeBranch()).toBe('fallback')
      expect(fallbackText()).toContain('fallback=1')

      mod.setCount(2)
      await flushMicrotasks()
      expect(activeBranch()).toBe('rich')
      const rich = richText()
      expect(rich.stats).toContain('rich-stats=20')
      expect(rich.badge).toContain('rich-badge')

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

  it('updates SVG dynamic classes through the class attribute in fine-grained output', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { set(value: string): void; toggle(): void }

      export function App() {
        let cls = $state('hot')
        let active = $state(true)
        api = {
          set(value) {
            cls = value
          },
          toggle() {
            active = !active
          },
        }

        return (
          <svg>
            <circle data-id="class" class={cls} />
            <rect data-id="className" className={cls} />
            <path data-id="classList" classList={{ active, off: !active }} />
          </svg>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: { set(value: string): void; toggle(): void }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const circle = container.querySelector('[data-id="class"]') as SVGCircleElement
    const rect = container.querySelector('[data-id="className"]') as SVGRectElement
    const path = container.querySelector('[data-id="classList"]') as SVGPathElement

    expect(circle.getAttribute('class')).toBe('hot')
    expect(circle.className.baseVal).toBe('hot')
    expect(rect.getAttribute('class')).toBe('hot')
    expect(rect.className.baseVal).toBe('hot')
    expect(path.classList.contains('active')).toBe(true)
    expect(path.classList.contains('off')).toBe(false)

    mod.api.set('cool')
    mod.api.toggle()
    await flushUpdates()

    expect(circle.getAttribute('class')).toBe('cool')
    expect(circle.className.baseVal).toBe('cool')
    expect(rect.getAttribute('class')).toBe('cool')
    expect(rect.className.baseVal).toBe('cool')
    expect(path.classList.contains('active')).toBe(false)
    expect(path.classList.contains('off')).toBe(true)

    teardown()
    container.remove()
  })

  it('applies static classList objects in fine-grained mode', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return <div data-id="target" class="base" classList={{ active: true, off: false }} />
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

    const target = container.querySelector('[data-id="target"]') as HTMLElement
    expect(target.classList.contains('base')).toBe(true)
    expect(target.classList.contains('active')).toBe(true)
    expect(target.classList.contains('off')).toBe(false)
    expect(target.hasAttribute('classList')).toBe(false)

    teardown()
    container.remove()
  })

  it('updates reactive classList objects in fine-grained mode', { timeout: 10000 }, async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { toggle(): void }

      export function App() {
        let active = $state(true)
        api = { toggle: () => (active = !active) }
        return (
          <div
            data-id="target"
            class="base"
            classList={{ active: active, off: !active }}
          />
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { toggle(): void }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const target = container.querySelector('[data-id="target"]') as HTMLElement
    expect(target.classList.contains('base')).toBe(true)
    expect(target.classList.contains('active')).toBe(true)
    expect(target.classList.contains('off')).toBe(false)
    expect(target.hasAttribute('classList')).toBe(false)

    mod.api.toggle()
    await flushUpdates()
    expect(target.classList.contains('base')).toBe(true)
    expect(target.classList.contains('active')).toBe(false)
    expect(target.classList.contains('off')).toBe(true)
    expect(target.hasAttribute('classList')).toBe(false)

    teardown()
    container.remove()
  })

  it('keeps classList object behavior aligned with VNode fallback', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        return <div data-id="target" class="base" classList={{ active: true, off: false }} />
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      fineGrainedDom: false,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const target = container.querySelector('[data-id="target"]') as HTMLElement
    expect(target.classList.contains('base')).toBe(true)
    expect(target.classList.contains('active')).toBe(true)
    expect(target.classList.contains('off')).toBe(false)
    expect(target.hasAttribute('classList')).toBe(false)

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

  it('keeps delegated event-param data expressions inside the handler scope', async () => {
    const source = `
      import { render } from 'fict'

      export const seen: string[] = []

      function select(value: string) {
        seen.push(value)
      }

      export function App() {
        return <button data-id="btn" onClick={(event) => select((0, event.type))}>Click</button>
      }

      export function mount(el: HTMLElement) {
        seen.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      seen: string[]
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const button = container.querySelector('[data-id="btn"]') as HTMLButtonElement
    button.click()
    await flushUpdates()

    expect(mod.seen).toEqual(['click'])

    teardown()
    container.remove()
  })

  it('preserves plain-call this semantics for extracted delegated event data', async () => {
    const source = `
      import { render } from 'fict'

      export const seen: string[] = []
      const receiver = { name: 'receiver' }

      function select(this: unknown, value: number) {
        seen.push(this === undefined ? 'undefined' : this === receiver ? 'receiver' : 'other')
        seen.push(String(value))
      }

      export function App() {
        const id = 7
        return (
          <div>
            <button data-id="plain" onClick={() => select(id)}>Plain</button>
            <button data-id="call" onClick={() => select.call(receiver, id)}>Call</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        seen.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      seen: string[]
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const plain = container.querySelector('[data-id="plain"]') as HTMLButtonElement
    const call = container.querySelector('[data-id="call"]') as HTMLButtonElement
    plain.click()
    call.click()
    await flushUpdates()

    expect(mod.seen).toEqual(['undefined', '7', 'receiver', '7'])

    teardown()
    container.remove()
  })

  it('keeps reassigned delegated data handlers live', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []
      export let api: { swap(): void }

      export function App() {
        let handle = (id: number) => log.push('a:' + id)
        api = {
          swap() {
            handle = (id: number) => log.push('b:' + id)
          },
        }
        return <button data-id="btn" onClick={() => handle(1)}>go</button>
      }

      export function mount(el: HTMLElement) {
        log.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { swap(): void }
      log: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    const button = container.querySelector('[data-id="btn"]') as HTMLButtonElement

    button.click()
    mod.api.swap()
    button.click()
    await flushUpdates()

    expect(mod.log).toEqual(['a:1', 'b:1'])

    teardown()
    container.remove()
  })

  it('wires namespaced on: event handlers in fine-grained mode', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      export function App() {
        return <button data-id="btn" on:click={() => calls.push('click')}>click</button>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      calls: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const button = container.querySelector('[data-id="btn"]') as HTMLButtonElement
    button.click()
    await flushUpdates()

    expect(mod.calls).toEqual(['click'])

    teardown()
    container.remove()
  })

  it('wires namespaced on: event handlers in VNode fallback mode', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      export function App() {
        return (
          <section>
            <button
              data-id="named"
              on:click={() => calls.push('named-click')}
              on:custom-event={() => calls.push('custom')}
              onClick={() => calls.push('react-click')}
            >
              named
            </button>
            <div data-id="outer" oncapture:click={() => calls.push('capture')}>
              <button data-id="inner">inner</button>
            </div>
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        calls.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      calls: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const named = container.querySelector('[data-id="named"]') as HTMLButtonElement
    const inner = container.querySelector('[data-id="inner"]') as HTMLButtonElement
    named.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    named.dispatchEvent(new Event('custom-event', { bubbles: true }))
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUpdates()

    expect(mod.calls).toEqual(['named-click', 'react-click', 'custom', 'capture'])

    teardown()
    container.remove()
  })

  it('parses direct event modifiers in VNode fallback mode', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      export function App() {
        return (
          <div
            data-id="outer"
            onClick={() => calls.push('click')}
            onClickCapture={() => calls.push('capture')}
            onClickPassive={() => calls.push('passive')}
            onClickOnce={() => calls.push('once')}
            onClickCapturePassive={() => calls.push('combo')}
          >
            <button data-id="inner">inner</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        calls.length = 0
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      calls: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const inner = container.querySelector('[data-id="inner"]') as HTMLButtonElement
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUpdates()

    const counts = mod.calls.reduce<Record<string, number>>((acc, item) => {
      acc[item] = (acc[item] ?? 0) + 1
      return acc
    }, {})
    expect(counts).toEqual({
      click: 2,
      capture: 2,
      passive: 2,
      once: 1,
      combo: 2,
    })

    teardown()
    container.remove()
  })

  it('dispatches EventListenerObject handlers in fine-grained mode', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      function makeListener(label: string) {
        return {
          handleEvent(event: Event) {
            calls.push(label + ':' + event.type)
          },
        }
      }

      export function App() {
        const listener = makeListener('identifier')
        const conditional = true ? makeListener('conditional') : makeListener('unused')

        return (
          <>
            <button data-id="identifier" onClick={listener}>identifier</button>
            <button
              data-id="inline"
              onClick={{
                handleEvent(event: Event) {
                  calls.push('inline:' + event.type)
                },
              }}
            >
              inline
            </button>
            <button data-id="conditional" onClick={conditional}>conditional</button>
            <button data-id="capture" onClickCapture={makeListener('capture')}>capture</button>
          </>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      calls: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const click = (id: string) => {
      const button = container.querySelector(`[data-id="${id}"]`) as HTMLButtonElement
      button.click()
    }

    click('identifier')
    click('inline')
    click('conditional')
    click('capture')
    await flushUpdates()

    expect(mod.calls).toEqual([
      'identifier:click',
      'inline:click',
      'conditional:click',
      'capture:click',
    ])

    teardown()
    container.remove()
  })

  it('wires namespaced oncapture: event handlers in fine-grained mode', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      export function App() {
        return (
          <div data-id="outer" oncapture:click={() => calls.push('capture')}>
            <button data-id="btn" on:click={() => calls.push('bubble')}>click</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      calls: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const button = container.querySelector('[data-id="btn"]') as HTMLButtonElement
    button.click()
    await flushUpdates()

    expect(mod.calls).toEqual(['capture', 'bubble'])

    teardown()
    container.remove()
  })

  it('preserves pointer capture event names in fine-grained mode', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      export function App() {
        return (
          <button
            data-id="btn"
            onGotPointerCapture={() => calls.push('got')}
            onLostPointerCapture={() => calls.push('lost')}
          >
            pointer
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      calls: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const button = container.querySelector('[data-id="btn"]') as HTMLButtonElement
    button.dispatchEvent(new Event('gotpointercapture', { bubbles: true }))
    button.dispatchEvent(new Event('lostpointercapture', { bubbles: true }))
    await flushUpdates()

    expect(mod.calls).toEqual(['got', 'lost'])

    teardown()
    container.remove()
  })

  it('preserves pointer capture event names with modifiers in fine-grained mode', async () => {
    const source = `
      import { render } from 'fict'

      export const calls: string[] = []

      export function App() {
        return (
          <button data-id="btn" onGotPointerCaptureOnce={() => calls.push('got-once')}>
            pointer
          </button>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      calls: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    const button = container.querySelector('[data-id="btn"]') as HTMLButtonElement
    button.dispatchEvent(new Event('gotpointercapture', { bubbles: true }))
    button.dispatchEvent(new Event('gotpointercapture', { bubbles: true }))
    await flushUpdates()

    expect(mod.calls).toEqual(['got-once'])

    teardown()
    container.remove()
  })

  it('updates signal and conditional object refs in fine-grained mode', async () => {
    const source = `
      import { $state, createRef, render } from 'fict'

      export const liveOne = createRef<HTMLInputElement>()
      export const liveTwo = createRef<HTMLInputElement>()
      export const conditionalOne = createRef<HTMLInputElement>()
      export const conditionalTwo = createRef<HTMLInputElement>()

      export function App() {
        const live = $state(liveOne)
        const useFirst = $state(true)

        return (
          <>
            <input data-id="live" ref={live} />
            <input data-id="conditional" ref={useFirst() ? conditionalOne : conditionalTwo} />
            <button data-id="swap-live" onClick={() => live(liveTwo)}>swap live</button>
            <button data-id="swap-conditional" onClick={() => useFirst(false)}>
              swap conditional
            </button>
          </>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      liveOne: { current: HTMLInputElement | null }
      liveTwo: { current: HTMLInputElement | null }
      conditionalOne: { current: HTMLInputElement | null }
      conditionalTwo: { current: HTMLInputElement | null }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    const liveInput = container.querySelector('[data-id="live"]') as HTMLInputElement
    const conditionalInput = container.querySelector('[data-id="conditional"]') as HTMLInputElement
    const swapLive = container.querySelector('[data-id="swap-live"]') as HTMLButtonElement
    const swapConditional = container.querySelector(
      '[data-id="swap-conditional"]',
    ) as HTMLButtonElement

    expect(mod.liveOne.current).toBe(liveInput)
    expect(mod.liveTwo.current).toBe(null)
    expect(mod.conditionalOne.current).toBe(conditionalInput)
    expect(mod.conditionalTwo.current).toBe(null)

    swapLive.click()
    swapConditional.click()
    await flushUpdates()

    expect(mod.liveOne.current).toBe(null)
    expect(mod.liveTwo.current).toBe(liveInput)
    expect(mod.conditionalOne.current).toBe(null)
    expect(mod.conditionalTwo.current).toBe(conditionalInput)

    teardown()
    container.remove()
  })

  it('updates prop and destructured prop refs in fine-grained mode', async () => {
    const source = `
      import { $state, createRef, render } from 'fict'

      export const propOne = createRef<HTMLInputElement>()
      export const propTwo = createRef<HTMLInputElement>()
      export const destructuredOne = createRef<HTMLInputElement>()
      export const destructuredTwo = createRef<HTMLInputElement>()

      function Child(props: { inputRef: any }) {
        return <input data-id="prop" ref={props.inputRef} />
      }

      function Destructured({ inputRef }: { inputRef: any }) {
        return <input data-id="destructured" ref={inputRef} />
      }

      export function App() {
        const useFirst = $state(true)

        return (
          <>
            <Child inputRef={useFirst() ? propOne : propTwo} />
            <Destructured inputRef={useFirst() ? destructuredOne : destructuredTwo} />
            <button data-id="swap" onClick={() => useFirst(false)}>swap</button>
          </>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      propOne: { current: HTMLInputElement | null }
      propTwo: { current: HTMLInputElement | null }
      destructuredOne: { current: HTMLInputElement | null }
      destructuredTwo: { current: HTMLInputElement | null }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    const propInput = container.querySelector('[data-id="prop"]') as HTMLInputElement
    const destructuredInput = container.querySelector(
      '[data-id="destructured"]',
    ) as HTMLInputElement
    const swap = container.querySelector('[data-id="swap"]') as HTMLButtonElement

    expect(mod.propOne.current).toBe(propInput)
    expect(mod.propTwo.current).toBe(null)
    expect(mod.destructuredOne.current).toBe(destructuredInput)
    expect(mod.destructuredTwo.current).toBe(null)

    swap.click()
    await flushUpdates()

    expect(mod.propOne.current).toBe(null)
    expect(mod.propTwo.current).toBe(propInput)
    expect(mod.destructuredOne.current).toBe(null)
    expect(mod.destructuredTwo.current).toBe(destructuredInput)

    teardown()
    container.remove()
  })

  it('does not call spread refs excluded by a later explicit ref', async () => {
    const source = `
      import { render } from 'fict'

      export const log: Array<[string, boolean]> = []

      const spreadRef = (el: Element | null) => log.push(['spread', !!el])
      const explicitRef = (el: Element | null) => log.push(['explicit', !!el])

      export function App() {
        return <div {...{ ref: spreadRef }} ref={explicitRef}>x</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      log: Array<[string, boolean]>
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    expect(mod.log).toEqual([['explicit', true]])

    teardown()
    container.remove()
  })

  it('keeps spread refs when no later explicit ref excludes them', async () => {
    const source = `
      import { render } from 'fict'

      export const log: Array<[string, boolean]> = []

      const spreadRef = (el: Element | null) => log.push(['spread', !!el])

      export function App() {
        return <div {...{ ref: spreadRef }}>x</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      log: Array<[string, boolean]>
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    expect(mod.log).toEqual([['spread', true]])

    teardown()
    container.remove()
  })

  it('unwraps direct reads of nested reactive object and array props', async () => {
    const source = `
      import { $state, render } from 'fict'

      function Direct(props: any) {
        return (
          <>
            <span data-id="object">{props.a.b}</span>
            <span data-id="array">{props.items[0]}</span>
            <span data-id="deep">{props.nested.inner.value}</span>
            <span data-id="grid">{props.grid[0][0]}</span>
          </>
        )
      }

      function Destructured({ a: { b } }: any) {
        return <span data-id="destructured">{b}</span>
      }

      export function App() {
        let count = $state(1)

        return (
          <>
            <Direct
              a={{ b: count }}
              items={[count]}
              nested={{ inner: { value: count } }}
              grid={[[count]]}
            />
            <Destructured a={{ b: count }} />
            <button data-id="inc" onClick={() => count += 1}>inc</button>
          </>
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

    const readTexts = () =>
      ['object', 'array', 'deep', 'grid', 'destructured'].map(
        id => container.querySelector(`[data-id="${id}"]`)?.textContent,
      )

    expect(readTexts()).toEqual(['1', '1', '1', '1', '1'])

    const inc = container.querySelector('[data-id="inc"]') as HTMLButtonElement
    inc.click()
    await flushUpdates()

    expect(readTexts()).toEqual(['2', '2', '2', '2', '2'])

    teardown()
    container.remove()
  })

  it('sets custom element JSX props as properties in fine-grained mode', async () => {
    const source = `
      import { $state, render } from 'fict'

      export function App() {
        let value = $state(1)
        let active = $state(true)

        return (
          <>
            <my-widget
              fooBar={value}
              foo-bar={value}
              config={{ version: value }}
              active={active}
              static-prop="static"
              enabled
            />
            <button is="fancy-button" foo-bar={value}>built in</button>
            <button data-id="update" onClick={() => {
              value += 1
              active = false
            }}>
              update
            </button>
          </>
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

    const widget = container.querySelector('my-widget') as HTMLElement & Record<string, unknown>
    const builtIn = container.querySelector('button[is="fancy-button"]') as HTMLButtonElement &
      Record<string, unknown>
    const update = container.querySelector('[data-id="update"]') as HTMLButtonElement

    expect(widget.foobar).toBe(1)
    expect(widget.fooBar).toBe(1)
    expect(widget.config).toEqual({ version: 1 })
    expect(widget.active).toBe(true)
    expect(widget.staticProp).toBe('static')
    expect(widget.enabled).toBe(true)
    expect(widget.getAttribute('fooBar')).toBeNull()
    expect(widget.getAttribute('foo-bar')).toBeNull()
    expect(widget.getAttribute('config')).toBeNull()
    expect(widget.getAttribute('active')).toBeNull()
    expect(widget.getAttribute('static-prop')).toBeNull()
    expect(builtIn.fooBar).toBe(1)
    expect(builtIn.getAttribute('foo-bar')).toBeNull()

    update.click()
    await flushUpdates()

    expect(widget.foobar).toBe(2)
    expect(widget.fooBar).toBe(2)
    expect(widget.config).toEqual({ version: 2 })
    expect(widget.active).toBe(false)
    expect(builtIn.fooBar).toBe(2)

    teardown()
    container.remove()
  })

  it('cleans up and reapplies reactive callback refs in fine-grained mode', async () => {
    const source = `
      import { $state, render } from 'fict'

      export const calls: string[] = []

      export function App() {
        const first = (el: HTMLInputElement | null) => calls.push('first:' + (el ? 'set' : 'clear'))
        const second = (el: HTMLInputElement | null) => calls.push('second:' + (el ? 'set' : 'clear'))
        const current = $state(first)

        return (
          <>
            <input data-id="callback" ref={current} />
            <button data-id="swap-callback" onClick={() => current(second)}>swap</button>
          </>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      calls: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    expect(mod.calls).toEqual(['first:set'])

    const swap = container.querySelector('[data-id="swap-callback"]') as HTMLButtonElement
    swap.click()
    await flushUpdates()

    expect(mod.calls).toEqual(['first:set', 'first:clear', 'second:set'])

    teardown()
    container.remove()
  })

  it('keeps later static spread precedence when an earlier spread updates', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { updateFirst(): void }

      export function App() {
        let first = $state({ title: 'first' })
        const second = { title: 'second' }

        api = {
          updateFirst() {
            first = { title: 'first-updated' }
          },
        }

        return <div data-testid="target" {...first} {...second}>x</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { updateFirst(): void }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    const target = container.querySelector('[data-testid="target"]') as HTMLDivElement
    expect(target.getAttribute('title')).toBe('second')

    mod.api.updateFirst()
    await flushUpdates()
    expect(target.getAttribute('title')).toBe('second')

    teardown()
    container.remove()
  })

  it('keeps later dynamic spread precedence when an earlier spread updates', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { updateFirst(): void; updateSecond(): void }

      export function App() {
        let first = $state({ title: 'first' })
        let second = $state({ title: 'second' })

        api = {
          updateFirst() {
            first = { title: 'first-updated' }
          },
          updateSecond() {
            second = { title: 'second-updated' }
          },
        }

        return <div data-testid="target" {...first} {...second}>x</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { updateFirst(): void; updateSecond(): void }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    const target = container.querySelector('[data-testid="target"]') as HTMLDivElement
    expect(target.getAttribute('title')).toBe('second')

    mod.api.updateFirst()
    await flushUpdates()
    expect(target.getAttribute('title')).toBe('second')

    mod.api.updateSecond()
    await flushUpdates()
    expect(target.getAttribute('title')).toBe('second-updated')

    teardown()
    container.remove()
  })

  it('keeps explicit props between spreads after earlier spread updates', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { updateFirst(): void }

      export function App() {
        let first = $state({ title: 'first' })
        const second = { 'data-role': 'second' }

        api = {
          updateFirst() {
            first = { title: 'first-updated' }
          },
        }

        return <div data-testid="target" {...first} title="explicit" {...second}>x</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { updateFirst(): void }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    const target = container.querySelector('[data-testid="target"]') as HTMLDivElement
    expect(target.getAttribute('title')).toBe('explicit')
    expect(target.getAttribute('data-role')).toBe('second')

    mod.api.updateFirst()
    await flushUpdates()
    expect(target.getAttribute('title')).toBe('explicit')
    expect(target.getAttribute('data-role')).toBe('second')

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

  it('evaluates inline keyed list keys once per rendered item', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      export function App() {
        const items = [1, 2]
        return (
          <ul>
            {items.map(item => (
              <li key={(log.push('key ' + item), item)}>{item}</li>
            ))}
          </ul>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      log: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    expect(mod.log).toEqual(['key 1', 'key 2'])
    expect(Array.from(container.querySelectorAll('li')).map(li => li.textContent)).toEqual([
      '1',
      '2',
    ])

    teardown()
    container.remove()
  })

  it('evaluates aliased keyed list keys once before item body work', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      export function App() {
        const items = [
          {
            get id() {
              log.push('key 1')
              return 1
            },
            get text() {
              log.push('body 1')
              return '1'
            },
          },
          {
            get id() {
              log.push('key 2')
              return 2
            },
            get text() {
              log.push('body 2')
              return '2'
            },
          },
        ]
        return (
          <ul>
            {items.map(item => {
              const key = item.id
              return <li key={key}>{item.text}</li>
            })}
          </ul>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      log: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    expect(mod.log).toEqual(['key 1', 'body 1', 'key 2', 'body 2'])
    expect(Array.from(container.querySelectorAll('li')).map(li => li.textContent)).toEqual([
      '1',
      '2',
    ])

    teardown()
    container.remove()
  })

  it('does not duplicate side-effecting mutable key alias assignments', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      function next(item: number) {
        log.push('key ' + item)
        return item
      }

      export function App() {
        const items = [1, 2]
        return (
          <ul>
            {items.map(item => {
              let key = item
              key = next(item)
              log.push('body ' + item)
              return <li key={key}>{key}</li>
            })}
          </ul>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      log: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    expect(mod.log).toEqual(['key 1', 'body 1', 'key 2', 'body 2'])
    expect(Array.from(container.querySelectorAll('li')).map(li => li.textContent)).toEqual([
      '1',
      '2',
    ])

    teardown()
    container.remove()
  })

  it('renders mutable key aliases without leaking callback locals into key functions', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const items = [1, 2]
        return (
          <ul>
            {items.map(item => {
              let key = item
              key += 10
              return <li key={key} data-key={key}>{item}</li>
            })}
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

    const items = Array.from(container.querySelectorAll('li'))
    expect(items.map(li => li.textContent)).toEqual(['1', '2'])
    expect(items.map(li => li.getAttribute('data-key'))).toEqual(['11', '12'])

    teardown()
    container.remove()
  })

  it('does not inline list callback aliases into render bindings', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      export function App() {
        const items = [
          {
            get value() {
              log.push('read value')
              return 'a'
            },
          },
        ]
        return (
          <ul>
            {items.map(item => {
              const x = item.value
              return <li data-x={x}>{x}{x}</li>
            })}
          </ul>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      log: string[]
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const item = container.querySelector('li') as HTMLLIElement
    expect(mod.log).toEqual(['read value'])
    expect(item.getAttribute('data-x')).toBe('a')
    expect(item.textContent).toBe('aa')

    teardown()
    container.remove()
  })

  it('preserves sparse array hole semantics in specialized map children', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: { deleteFirst(): void }

      export function App() {
        let items = $state<Array<string | undefined>>([undefined, 'b'])
        api = {
          deleteFirst() {
            const next = items.slice()
            delete next[0]
            items = next
          },
        }

        return (
          <ul>
            {items.map((item, index) => (
              <li key={index}>{String(item)}:{index}</li>
            ))}
          </ul>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      api: { deleteFirst(): void }
      mount: (el: HTMLElement) => () => void
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)
    await flushUpdates()

    const readItems = () => Array.from(container.querySelectorAll('li')).map(li => li.textContent)

    expect(readItems()).toEqual(['undefined:0', 'b:1'])

    mod.api.deleteFirst()
    await flushUpdates()

    expect(readItems()).toEqual(['b:1'])

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

  it('does not constify non-optional reads from optional list keys', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        let reads = 0
        const items = [{
          get id() {
            reads += 1
            return reads === 1 ? 'key-value' : 'body-value'
          },
        }]
        return (
          <ul>
            {items.map(item => (
              <li key={item?.id}>{item.id}</li>
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
      'body-value',
    ])

    teardown()
    container.remove()
  })

  it('does not shadow source internal-like names with generated list params', async () => {
    const source = `
      import { render } from 'fict'

      export let clicked = ''

      export function App() {
        const __index = 'outer-index'
        const __key = 'outer-key'
        const __item = 'outer-item'
        const items = [{ id: 'a' }]
        return (
          <ul>
            {items.map(item => (
              <li
                key={__index}
                data-key={__key}
                onClick={() => {
                  clicked = __key
                }}
              >
                {__index}:{__key}
              </li>
            ))}
            {items.map(() => (
              <li key={__item}>{__item}</li>
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
      clicked: string
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()

    const items = Array.from(container.querySelectorAll('li'))
    expect(items.map(li => li.textContent)).toEqual(['outer-index:outer-key', 'outer-item'])
    expect(items[0]?.getAttribute('data-key')).toBe('outer-key')

    items[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUpdates()
    expect(mod.clicked).toBe('outer-key')

    teardown()
    container.remove()
  })

  it('invokes function-valued list items used as event handlers', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      export function App() {
        const handlers = [() => log.push('clicked')]
        const objectListener = { handleEvent: () => log.push('object') }
        const listeners = [objectListener]

        return (
          <div>
            {handlers.map(fn => <button data-id="fn" onClick={fn}>fn</button>)}
            {listeners.map(listener => <button data-id="object" onClick={listener}>object</button>)}
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

    await flushUpdates()
    ;(container.querySelector('[data-id="fn"]') as HTMLButtonElement).click()
    ;(container.querySelector('[data-id="object"]') as HTMLButtonElement).click()
    await flushUpdates()

    expect(mod.log).toEqual(['clicked', 'object'])

    teardown()
    container.remove()
  })

  it('invokes function-valued list items used as child calls', async () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      export function App() {
        const handlers = [
          () => {
            log.push('called')
            return 'child'
          },
        ]
        const optionalHandlers = [
          () => {
            log.push('optional')
            return 'maybe'
          },
        ]

        return (
          <div>
            {handlers.map(fn => <span data-id="direct">{fn()}</span>)}
            {optionalHandlers.map(fn => <span data-id="optional">{fn?.()}</span>)}
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

    await flushUpdates()

    expect((container.querySelector('[data-id="direct"]') as HTMLSpanElement).textContent).toBe(
      'child',
    )
    expect((container.querySelector('[data-id="optional"]') as HTMLSpanElement).textContent).toBe(
      'maybe',
    )
    expect(mod.log).toEqual(['called', 'optional'])

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

  it('switches reactive expression-level return branches', async () => {
    const source = `
      import { $state, render } from 'fict'

      export let api: {
        setTernary(value: boolean): void
        setLogical(value: boolean): void
        setMode(value: 'a' | 'b' | 'c'): void
      }

      function TernaryReturn() {
        let flag = $state(true)
        api.setTernary = value => (flag = value)
        return flag ? <span data-id="ternary-on">on</span> : <em data-id="ternary-off">off</em>
      }

      function LogicalReturn() {
        let visible = $state(true)
        api.setLogical = value => (visible = value)
        return visible && <strong data-id="logical-on">visible</strong>
      }

      function NestedReturn() {
        let mode = $state<'a' | 'b' | 'c'>('a')
        api.setMode = value => (mode = value)
        return mode === 'a'
          ? <b data-id="nested-a">A</b>
          : mode === 'b'
            ? <i data-id="nested-b">B</i>
            : <u data-id="nested-c">C</u>
      }

      export function App() {
        api = {} as typeof api
        return (
          <section>
            <TernaryReturn />
            <LogicalReturn />
            <NestedReturn />
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      api: {
        setTernary(value: boolean): void
        setLogical(value: boolean): void
        setMode(value: 'a' | 'b' | 'c'): void
      }
    }>(source, { fineGrainedDom: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    expect(container.querySelector('[data-id="ternary-on"]')).toBeTruthy()
    expect(container.querySelector('[data-id="logical-on"]')).toBeTruthy()
    expect(container.querySelector('[data-id="nested-a"]')).toBeTruthy()

    mod.api.setTernary(false)
    mod.api.setLogical(false)
    mod.api.setMode('b')
    await flushUpdates()

    expect(container.querySelector('[data-id="ternary-on"]')).toBeNull()
    expect(container.querySelector('[data-id="ternary-off"]')).toBeTruthy()
    expect(container.querySelector('[data-id="logical-on"]')).toBeNull()
    expect(container.querySelector('[data-id="nested-a"]')).toBeNull()
    expect(container.querySelector('[data-id="nested-b"]')).toBeTruthy()

    mod.api.setTernary(true)
    mod.api.setLogical(true)
    mod.api.setMode('c')
    await flushUpdates()

    expect(container.querySelector('[data-id="ternary-on"]')).toBeTruthy()
    expect(container.querySelector('[data-id="ternary-off"]')).toBeNull()
    expect(container.querySelector('[data-id="logical-on"]')).toBeTruthy()
    expect(container.querySelector('[data-id="nested-b"]')).toBeNull()
    expect(container.querySelector('[data-id="nested-c"]')).toBeTruthy()

    teardown()
    container.remove()
  })

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

  it('evaluates event handler factory expressions during render', () => {
    const source = `
      import { render } from 'fict'

      export const log: string[] = []

      const createHandler = (label: string) => {
        log.push('factory:' + label)
        return () => log.push('hit:' + label)
      }

      export function App() {
        return (
          <div>
            <button data-id="delegated" onClick={createHandler('delegated')}>Delegated</button>
            <button data-id="captured" onClickCapture={createHandler('captured')}>Captured</button>
            <button data-id="wrapped" onClick={() => createHandler('wrapped')()}>Wrapped</button>
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

    expect(mod.log).toEqual(['factory:delegated', 'factory:captured'])

    const delegated = container.querySelector('[data-id="delegated"]') as HTMLButtonElement
    const captured = container.querySelector('[data-id="captured"]') as HTMLButtonElement
    const wrapped = container.querySelector('[data-id="wrapped"]') as HTMLButtonElement

    delegated.click()
    delegated.click()
    captured.click()
    captured.click()
    wrapped.click()
    wrapped.click()

    expect(mod.log).toEqual([
      'factory:delegated',
      'factory:captured',
      'hit:delegated',
      'hit:delegated',
      'hit:captured',
      'hit:captured',
      'factory:wrapped',
      'hit:wrapped',
      'factory:wrapped',
      'hit:wrapped',
    ])

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

  it('keeps conditional return predicates from generated temp shadowing', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const flag = (globalThis as any).__fictConditionalFlag === true
        const __cond_0 = flag
        const __cond_1 = flag
        const __cond_2 = flag
        const __cond_3 = flag
        const __cond_4 = flag
        const __cond_5 = flag
        const __cond_6 = flag
        const __cond_7 = flag
        const __cond_8 = flag
        const __cond_9 = flag
        const __cond_10 = flag
        const __cond_11 = flag
        const __cond_12 = flag

        if (__cond_0) return <span>0</span>
        if (__cond_1) return <span>1</span>
        if (__cond_2) return <span>2</span>
        if (__cond_3) return <span>3</span>
        if (__cond_4) return <span>4</span>
        if (__cond_5) return <span>5</span>
        if (__cond_6) return <span>6</span>
        if (__cond_7) return <span>7</span>
        if (__cond_8) return <span>8</span>
        if (__cond_9) return <span>9</span>
        if (__cond_10) return <span>10</span>
        if (__cond_11) return <span>11</span>
        if (__cond_12) return <span>12</span>
        return <span>B</span>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      fineGrainedDom: true,
      lazyConditional: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    expect(container.textContent).toBe('B')

    teardown()
    container.remove()
  })

  it('keeps switch discriminants from generated temp shadowing', async () => {
    const source = `
      import { render } from 'fict'

      export function App() {
        const source = (globalThis as any).__fictSwitchValue ?? 'b'
        const __switchDisc_0 = source
        const __switchDisc_1 = source
        const __switchDisc_2 = source
        const __switchDisc_3 = source
        const __switchDisc_4 = source
        const __switchDisc_5 = source
        const __switchDisc_6 = source
        const __switchDisc_7 = source
        const __switchDisc_8 = source

        switch (__switchDisc_6) {
          case 'a':
            return <span>A</span>
          case 'b':
            return <span>B</span>
          default:
            return <span>C</span>
        }
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      fineGrainedDom: true,
      lazyConditional: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    expect(container.textContent).toBe('B')

    teardown()
    container.remove()
  })

  it('keeps conditional JSX child predicates from generated temp shadowing', async () => {
    const globals = globalThis as Record<string, unknown>
    globals.__fictConditionalChildTernary = false
    globals.__fictConditionalChildLogical = true

    const source = `
      import { render } from 'fict'

      function TernaryChild() {
        const flag = (globalThis as any).__fictConditionalChildTernary === true
        const __cond_0 = flag

        return (
          <div data-id="ternary">
            {__cond_0 ? <span>A</span> : <span>B</span>}
          </div>
        )
      }

      function LogicalChild() {
        const flag = (globalThis as any).__fictConditionalChildLogical === true
        const __cond_1 = flag

        return (
          <div data-id="logical">
            {__cond_1 && <span>Visible</span>}
          </div>
        )
      }

      export function App() {
        return (
          <section>
            <TernaryChild />
            <LogicalChild />
          </section>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      fineGrainedDom: true,
      lazyConditional: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    expect(container.querySelector('[data-id="ternary"]')?.textContent).toBe('B')
    expect(container.querySelector('[data-id="logical"]')?.textContent).toBe('Visible')

    teardown()
    container.remove()
    delete globals.__fictConditionalChildTernary
    delete globals.__fictConditionalChildLogical
  })

  it('uses intrinsic undefined for missing logical conditional child branches', async () => {
    const globals = globalThis as Record<string, unknown>
    globals.__fictLogicalChildVisible = false

    const source = `
      import { render } from 'fict'

      export function App() {
        const visible = (globalThis as any).__fictLogicalChildVisible === true
        const undefined = () => <em data-id="wrong">wrong</em>

        return (
          <div data-id="root">
            {visible && <span data-id="right">right</span>}
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const output = transformCommonJS(source, {
      fineGrainedDom: true,
      lazyConditional: true,
    })
    expect(output).toContain('createConditional')
    expect(output).toMatch(/createElement,\s*void 0,\s*__el_/)
    expect(output).not.toMatch(/createElement,\s*undefined,\s*__el_/)

    const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      fineGrainedDom: true,
      lazyConditional: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const teardown = mod.mount(container)

    await flushUpdates()
    expect(container.querySelector('[data-id="wrong"]')).toBeNull()
    expect(container.querySelector('[data-id="right"]')).toBeNull()
    expect(container.querySelector('[data-id="root"]')?.textContent).toBe('')

    teardown()
    container.remove()
    delete globals.__fictLogicalChildVisible
  })

  it('keeps list receivers from generated controller temp shadowing', async () => {
    const renderText = async (source: string): Promise<string> => {
      const mod = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
        fineGrainedDom: true,
      })
      const container = document.createElement('div')
      document.body.appendChild(container)
      const teardown = mod.mount(container)

      await flushUpdates()
      const text = container.textContent ?? ''

      teardown()
      container.remove()
      return text
    }

    await expect(
      renderText(`
        import { render } from 'fict'

        export function App() {
          const __list_8 = [{ id: 'a', label: 'keyed' }]
          return <ul>{__list_8.map(item => <li key={item.id}>{item.label}</li>)}</ul>
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `),
    ).resolves.toBe('keyed')

    await expect(
      renderText(`
        import { render } from 'fict'

        export function App() {
          const __list_8 = ['unkeyed']
          return <ul>{__list_8.map(item => <li>{item}</li>)}</ul>
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `),
    ).resolves.toBe('unkeyed')

    await expect(
      renderText(`
        import { render } from 'fict'

        export function App() {
          const __list_8: Array<{ id: string; label: string }> | null = [
            { id: 'optional', label: 'optional' },
          ]
          return <ul>{__list_8?.map(item => <li key={item.id}>{item.label}</li>)}</ul>
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `),
    ).resolves.toBe('optional')

    await expect(
      renderText(`
        import { render } from 'fict'

        export function App() {
          const items = ['callback']
          return (
            <ul>
              {items.map(item => {
                const __list_8 = item.toUpperCase()
                return <li>{__list_8}</li>
              })}
            </ul>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <App />, el)
        }
      `),
    ).resolves.toBe('CALLBACK')
  })
})
