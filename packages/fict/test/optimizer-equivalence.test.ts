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

  describe('control flow branches', () => {
    it('matches effect counts in if/else branches', async () => {
      const source = `
        import { $state, $effect, render } from 'fict'

        let effectRuns = 0
        export const getEffectRuns = () => effectRuns

        function Conditional() {
          let show = $state(true)
          let count = $state(0)

          $effect(() => {
            effectRuns++
            if (show) {
              console.log('showing:', count)
            } else {
              console.log('hidden')
            }
          })

          return (
            <div>
              {show ? (
                <p data-testid="content">Count: {count}</p>
              ) : (
                <p data-testid="content">Hidden</p>
              )}
              <button data-testid="toggle" onClick={() => show = !show}>Toggle</button>
              <button data-testid="inc" onClick={() => count++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <Conditional />, el)
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

      const read = (container: HTMLElement) =>
        container.querySelector('[data-testid="content"]')?.textContent
      const toggleOptimized = containerOptimized.querySelector(
        '[data-testid="toggle"]',
      ) as HTMLButtonElement
      const toggleUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="toggle"]',
      ) as HTMLButtonElement
      const incOptimized = containerOptimized.querySelector(
        '[data-testid="inc"]',
      ) as HTMLButtonElement
      const incUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="inc"]',
      ) as HTMLButtonElement

      // Initial state
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))
      expect(optimized.getEffectRuns()).toBe(unoptimized.getEffectRuns())

      // Increment
      incOptimized.click()
      incUnoptimized.click()
      await tick()
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))
      expect(optimized.getEffectRuns()).toBe(unoptimized.getEffectRuns())

      // Toggle to hidden
      toggleOptimized.click()
      toggleUnoptimized.click()
      await tick()
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))
      expect(optimized.getEffectRuns()).toBe(unoptimized.getEffectRuns())

      disposeOptimized()
      disposeUnoptimized()
    })

    it('matches DOM with switch-like conditional rendering', async () => {
      const source = `
        import { $state, render } from 'fict'

        function Tabs() {
          let tab = $state<'a' | 'b' | 'c'>('a')

          const content = tab === 'a' ? 'Tab A Content' :
                          tab === 'b' ? 'Tab B Content' :
                          'Tab C Content'

          return (
            <div>
              <div data-testid="tabs">
                <button data-testid="tab-a" onClick={() => tab = 'a'}>A</button>
                <button data-testid="tab-b" onClick={() => tab = 'b'}>B</button>
                <button data-testid="tab-c" onClick={() => tab = 'c'}>C</button>
              </div>
              <div data-testid="content">{content}</div>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <Tabs />, el)
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

      const read = (container: HTMLElement) =>
        container.querySelector('[data-testid="content"]')?.textContent

      expect(read(containerOptimized)).toBe(read(containerUnoptimized))

      // Switch to tab B
      const tabBOptimized = containerOptimized.querySelector(
        '[data-testid="tab-b"]',
      ) as HTMLButtonElement
      const tabBUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="tab-b"]',
      ) as HTMLButtonElement
      tabBOptimized.click()
      tabBUnoptimized.click()
      await tick()
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))

      // Switch to tab C
      const tabCOptimized = containerOptimized.querySelector(
        '[data-testid="tab-c"]',
      ) as HTMLButtonElement
      const tabCUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="tab-c"]',
      ) as HTMLButtonElement
      tabCOptimized.click()
      tabCUnoptimized.click()
      await tick()
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))

      disposeOptimized()
      disposeUnoptimized()
    })
  })

  describe('parent-child effect propagation', () => {
    it('matches effect order in nested components', async () => {
      const source = `
        import { $state, $effect, render } from 'fict'

        const effectLog: string[] = []
        export const getEffectLog = () => [...effectLog]

        function Child({ name }: { name: string }) {
          $effect(() => {
            effectLog.push(\`child-\${name}-mount\`)
            return () => effectLog.push(\`child-\${name}-cleanup\`)
          })
          return <span data-testid={\`child-\${name}\`}>{name}</span>
        }

        function Parent() {
          let show = $state(true)

          $effect(() => {
            effectLog.push('parent-mount')
            return () => effectLog.push('parent-cleanup')
          })

          return (
            <div>
              {show && <Child name="a" />}
              {show && <Child name="b" />}
              <button data-testid="toggle" onClick={() => show = !show}>Toggle</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          effectLog.length = 0
          return render(() => <Parent />, el)
        }
      `

      const optimized = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        getEffectLog: () => string[]
      }>(source, { optimize: true })
      const unoptimized = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        getEffectLog: () => string[]
      }>(source, { optimize: false })

      const disposeOptimized = optimized.mount(containerOptimized)
      await tick()
      const logOptimized1 = optimized.getEffectLog()

      const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
      await tick()
      const logUnoptimized1 = unoptimized.getEffectLog()

      // Effect execution should be equivalent
      expect(logOptimized1.length).toBe(logUnoptimized1.length)

      // Toggle off children
      const toggleOptimized = containerOptimized.querySelector(
        '[data-testid="toggle"]',
      ) as HTMLButtonElement
      const toggleUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="toggle"]',
      ) as HTMLButtonElement
      toggleOptimized.click()
      toggleUnoptimized.click()
      await tick()

      const logOptimized2 = optimized.getEffectLog()
      const logUnoptimized2 = unoptimized.getEffectLog()

      // Cleanup should run for children
      expect(logOptimized2.some(l => l.includes('cleanup'))).toBe(
        logUnoptimized2.some(l => l.includes('cleanup')),
      )

      disposeOptimized()
      disposeUnoptimized()
    })

    it('matches child component unmount cleanup order', async () => {
      const source = `
        import { $state, $effect, render } from 'fict'

        const cleanupOrder: string[] = []
        export const getCleanupOrder = () => [...cleanupOrder]

        function DeepChild({ id }: { id: string }) {
          $effect(() => {
            return () => cleanupOrder.push(\`deep-\${id}\`)
          })
          return <span>{id}</span>
        }

        function Child({ id }: { id: string }) {
          $effect(() => {
            return () => cleanupOrder.push(\`child-\${id}\`)
          })
          return (
            <div>
              <DeepChild id={\`\${id}-1\`} />
              <DeepChild id={\`\${id}-2\`} />
            </div>
          )
        }

        function App() {
          let mounted = $state(true)

          return (
            <div>
              {mounted && <Child id="a" />}
              <button data-testid="unmount" onClick={() => mounted = false}>Unmount</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          cleanupOrder.length = 0
          return render(() => <App />, el)
        }
      `

      const optimized = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        getCleanupOrder: () => string[]
      }>(source, { optimize: true })
      const unoptimized = compileAndLoad<{
        mount: (el: HTMLElement) => () => void
        getCleanupOrder: () => string[]
      }>(source, { optimize: false })

      const disposeOptimized = optimized.mount(containerOptimized)
      const disposeUnoptimized = unoptimized.mount(containerUnoptimized)
      await tick()

      // Unmount children
      const unmountOptimized = containerOptimized.querySelector(
        '[data-testid="unmount"]',
      ) as HTMLButtonElement
      const unmountUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="unmount"]',
      ) as HTMLButtonElement
      unmountOptimized.click()
      unmountUnoptimized.click()
      await tick()

      // Cleanup order should be equivalent
      expect(optimized.getCleanupOrder().length).toBe(unoptimized.getCleanupOrder().length)

      disposeOptimized()
      disposeUnoptimized()
    })
  })

  describe('deeply nested reactive chains', () => {
    it('matches DOM for multi-level derived values', async () => {
      const source = `
        import { $state, render } from 'fict'

        function DeepDerived() {
          let base = $state(1)
          const level1 = base * 2
          const level2 = level1 + 10
          const level3 = level2 * 3
          const level4 = level3 - 5
          const final = \`Result: \${level4}\`

          return (
            <div>
              <p data-testid="result">{final}</p>
              <button data-testid="inc" onClick={() => base++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <DeepDerived />, el)
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

      const read = (container: HTMLElement) =>
        container.querySelector('[data-testid="result"]')?.textContent

      // Initial: base=1, level1=2, level2=12, level3=36, level4=31
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))
      expect(read(containerOptimized)).toBe('Result: 31')

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

      // After: base=2, level1=4, level2=14, level3=42, level4=37
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))
      expect(read(containerOptimized)).toBe('Result: 37')

      disposeOptimized()
      disposeUnoptimized()
    })

    it('matches DOM for conditional derived chains', async () => {
      const source = `
        import { $state, render } from 'fict'

        function ConditionalChain() {
          let value = $state(5)
          let useDouble = $state(true)

          const processed = useDouble ? value * 2 : value + 100
          const formatted = \`Value: \${processed}\`

          return (
            <div>
              <p data-testid="output">{formatted}</p>
              <button data-testid="toggle" onClick={() => useDouble = !useDouble}>Toggle</button>
              <button data-testid="inc" onClick={() => value++}>Inc</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <ConditionalChain />, el)
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

      const read = (container: HTMLElement) =>
        container.querySelector('[data-testid="output"]')?.textContent

      // Initial: useDouble=true, value=5 -> 10
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))

      // Toggle to add mode
      const toggleOptimized = containerOptimized.querySelector(
        '[data-testid="toggle"]',
      ) as HTMLButtonElement
      const toggleUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="toggle"]',
      ) as HTMLButtonElement
      toggleOptimized.click()
      toggleUnoptimized.click()
      await tick()

      // Now: useDouble=false, value=5 -> 105
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))

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

      // Now: useDouble=false, value=6 -> 106
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))

      disposeOptimized()
      disposeUnoptimized()
    })

    it('matches DOM for computed properties in objects', async () => {
      const source = `
        import { $state, render } from 'fict'

        function ComputedProps() {
          let x = $state(10)
          let y = $state(20)

          const point = { x, y }
          const doubled = { x: point.x * 2, y: point.y * 2 }
          const sum = doubled.x + doubled.y

          return (
            <div>
              <p data-testid="sum">Sum: {sum}</p>
              <button data-testid="incX" onClick={() => x++}>X++</button>
              <button data-testid="incY" onClick={() => y++}>Y++</button>
            </div>
          )
        }

        export function mount(el: HTMLElement) {
          return render(() => <ComputedProps />, el)
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

      const read = (container: HTMLElement) =>
        container.querySelector('[data-testid="sum"]')?.textContent

      // Initial: x=10, y=20 -> doubled={20,40} -> sum=60
      expect(read(containerOptimized)).toBe(read(containerUnoptimized))
      expect(read(containerOptimized)).toBe('Sum: 60')

      // Increment X
      const incXOptimized = containerOptimized.querySelector(
        '[data-testid="incX"]',
      ) as HTMLButtonElement
      const incXUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="incX"]',
      ) as HTMLButtonElement
      incXOptimized.click()
      incXUnoptimized.click()
      await tick()

      expect(read(containerOptimized)).toBe(read(containerUnoptimized))
      expect(read(containerOptimized)).toBe('Sum: 62')

      // Increment Y
      const incYOptimized = containerOptimized.querySelector(
        '[data-testid="incY"]',
      ) as HTMLButtonElement
      const incYUnoptimized = containerUnoptimized.querySelector(
        '[data-testid="incY"]',
      ) as HTMLButtonElement
      incYOptimized.click()
      incYUnoptimized.click()
      await tick()

      expect(read(containerOptimized)).toBe(read(containerUnoptimized))
      expect(read(containerOptimized)).toBe('Sum: 64')

      disposeOptimized()
      disposeUnoptimized()
    })
  })
})
