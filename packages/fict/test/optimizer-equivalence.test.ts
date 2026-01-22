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

describe('optimizer equivalence (optimize on/off)', () => {
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
    document.title = ''
  })

  it('matches DOM + effect counts for derived values', async () => {
    const source = `
      import { $state, $effect, render } from 'fict'

      let effectRuns = 0
      export const getEffectRuns = () => effectRuns

      function Counter() {
        let count = $state(0)
        const doubled = count * 2
        $effect(() => {
          effectRuns++
          document.title = \`Count: \${count}\`
        })
        return (
          <div>
            <p data-testid="count">Count: {count}</p>
            <p data-testid="double">Double: {doubled}</p>
            <button data-testid="inc" onClick={() => count++}>Increment</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <Counter />, el)
      }
    `

    const optimized = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      getEffectRuns: () => number
    }>(source, { optimize: true })
    const unoptimized = compileAndLoad<{
      mount: (el: HTMLElement) => () => void
      getEffectRuns: () => number
    }>(source, { optimize: false })

    const disposeOptimized = optimized.mount(containerOptimized)
    const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
    await tick()

    const read = (container: HTMLElement, selector: string) =>
      container.querySelector(selector)?.textContent
    const incOptimized = containerOptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement
    const incUnoptimized = containerUnoptimized.querySelector(
      '[data-testid="inc"]',
    ) as HTMLButtonElement

    expect(read(containerOptimized, '[data-testid="count"]')).toBe('Count: 0')
    expect(read(containerUnoptimized, '[data-testid="count"]')).toBe('Count: 0')
    expect(read(containerOptimized, '[data-testid="double"]')).toBe('Double: 0')
    expect(read(containerUnoptimized, '[data-testid="double"]')).toBe('Double: 0')
    expect(optimized.getEffectRuns()).toBe(unoptimized.getEffectRuns())

    incOptimized.click()
    incUnoptimized.click()
    await tick()
    expect(read(containerOptimized, '[data-testid="count"]')).toBe('Count: 1')
    expect(read(containerUnoptimized, '[data-testid="count"]')).toBe('Count: 1')
    expect(read(containerOptimized, '[data-testid="double"]')).toBe('Double: 2')
    expect(read(containerUnoptimized, '[data-testid="double"]')).toBe('Double: 2')
    expect(optimized.getEffectRuns()).toBe(unoptimized.getEffectRuns())

    disposeOptimized()
    disposeUnoptimized()
  })

  it('matches DOM for keyed list updates', async () => {
    const source = `
      import { $state, render } from 'fict'

      function List() {
        let items = $state([
          { id: 1, text: 'wake up' },
          { id: 2, text: 'hydrate' },
          { id: 3, text: 'ship code' },
        ])
        const rotate = () => {
          const [first, ...rest] = items
          items = [...rest, first]
        }
        return (
          <div>
            <ul data-testid="list">
              {items.map(item => (
                <li key={item.id}>{item.text}</li>
              ))}
            </ul>
            <button data-testid="rotate" onClick={rotate}>Rotate</button>
          </div>
        )
      }

      export function mount(el: HTMLElement) {
        return render(() => <List />, el)
      }
    `

    const optimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: true,
    })
    const unoptimized = compileAndLoad<{ mount: (el: HTMLElement) => () => void }>(source, {
      optimize: false,
    })

    const disposeOptimized = optimized.mount(containerOptimized)
    const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
    await tick()

    const readList = (container: HTMLElement) =>
      container.querySelector('[data-testid="list"]')?.textContent
    const rotateOptimized = containerOptimized.querySelector(
      '[data-testid="rotate"]',
    ) as HTMLButtonElement
    const rotateUnoptimized = containerUnoptimized.querySelector(
      '[data-testid="rotate"]',
    ) as HTMLButtonElement

    expect(readList(containerOptimized)).toBe(readList(containerUnoptimized))

    rotateOptimized.click()
    rotateUnoptimized.click()
    await tick()
    expect(readList(containerOptimized)).toBe(readList(containerUnoptimized))

    disposeOptimized()
    disposeUnoptimized()
  })
})
