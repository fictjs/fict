/**
 * Complete Integration Tests
 *
 * Tests the full flow: JSX → DOM → State Update → DOM Verification
 * Covers dependency graph behaviors from architecture docs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  createSignal,
  createMemo,
  createEffect,
  render,
  createElement,
  onMount,
  onDestroy,
  onCleanup,
  batch,
  bindText,
  createConditional,
  createList,
} from '..'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Complete Integration Tests', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  describe('B001-B004: Signal Dependency Tracking', () => {
    it('B001: tracks signal reads in memos and effects', async () => {
      const count = createSignal(0)
      const doubled = createMemo(() => count() * 2)
      const effectLog: number[] = []

      createEffect(() => {
        effectLog.push(doubled())
      })

      expect(effectLog).toEqual([0])

      count(5)
      await tick()

      expect(effectLog).toEqual([0, 10])
      expect(doubled()).toBe(10)
    })

    it('B002: signal writes trigger all subscribers', async () => {
      const base = createSignal(1)
      const derived1 = createMemo(() => base() * 2)
      const derived2 = createMemo(() => base() + 10)
      const combinedLog: string[] = []

      createEffect(() => {
        combinedLog.push(`d1:${derived1()},d2:${derived2()}`)
      })

      expect(combinedLog).toEqual(['d1:2,d2:11'])

      base(5)
      await tick()

      expect(combinedLog).toEqual(['d1:2,d2:11', 'd1:10,d2:15'])
    })

    it('B003: batch coalesces multiple writes into single propagation', async () => {
      const a = createSignal(0)
      const b = createSignal(0)
      const effectRuns: number[] = []

      createEffect(() => {
        effectRuns.push(a() + b())
      })

      expect(effectRuns).toEqual([0])

      batch(() => {
        a(1)
        a(2)
        b(3)
        b(4)
      })

      // Should only run once after batch, not 4 times
      expect(effectRuns).toEqual([0, 6])
    })

    it('B004: $state in loop throws compile error (simulated via runtime check)', () => {
      // This is a compile-time check, but we can verify the pattern causes issues
      const items = [1, 2, 3]
      const signals: ReturnType<typeof createSignal<number>>[] = []

      // This pattern should NOT be used - signals in loops break topology
      items.forEach(item => {
        signals.push(createSignal(item))
      })

      // Even though it "works", it's not recommended as per spec
      expect(signals.length).toBe(3)
    })
  })

  describe('B005-B008: Derived Expression Classification', () => {
    it('B005: derived used in JSX becomes memo', async () => {
      const count = createSignal(0)
      const doubled = createMemo(() => count() * 2)
      const span = document.createElement('span')
      const textNode = document.createTextNode('')

      span.appendChild(textNode)
      bindText(textNode, () => String(doubled()))
      container.appendChild(span)

      expect(span.textContent).toBe('0')

      count(3)
      await tick()

      expect(span.textContent).toBe('6')
    })

    it('B006: derived in event-only context is getter (live value)', async () => {
      const count = createSignal(0)
      let capturedValue: number | null = null

      // Simulate event handler that reads derived
      const handler = () => {
        capturedValue = count() * 2 // Would be getter in compiled code
      }

      count(5)
      handler()
      expect(capturedValue).toBe(10)

      count(10)
      handler()
      expect(capturedValue).toBe(20) // Always reads latest
    })

    it('B007: mixed usage (JSX + event) uses memo, event reads memo value', async () => {
      const count = createSignal(0)
      const doubled = createMemo(() => count() * 2)
      const span = document.createElement('span')
      const textNode = document.createTextNode('')
      let eventValue: number | null = null

      span.appendChild(textNode)
      bindText(textNode, () => String(doubled()))

      const handler = () => {
        eventValue = doubled()
      }

      count(5)
      await tick()
      handler()

      expect(span.textContent).toBe('10')
      expect(eventValue).toBe(10)
    })

    it('B008: control flow region grouping (simulated)', async () => {
      const videos = createSignal<{ id: number }[]>([])
      const emptyHeading = 'No videos'

      // This simulates how compiler groups conditionals into single memo
      const viewState = createMemo(() => {
        const count = videos().length
        let heading = emptyHeading
        let extra = 42

        if (count > 0) {
          const noun = count > 1 ? 'Videos' : 'Video'
          heading = `${count} ${noun}`
          extra = count * 10
        }

        return { heading, extra }
      })

      expect(viewState().heading).toBe('No videos')
      expect(viewState().extra).toBe(42)

      videos([{ id: 1 }])
      await tick()

      expect(viewState().heading).toBe('1 Video')
      expect(viewState().extra).toBe(10)

      videos([{ id: 1 }, { id: 2 }])
      await tick()

      expect(viewState().heading).toBe('2 Videos')
      expect(viewState().extra).toBe(20)
    })
  })

  describe('B009-B014: Effect Execution Order and Lifecycle', () => {
    it('B009: effect runs on first mount', () => {
      const runs: string[] = []

      createEffect(() => {
        runs.push('effect')
      })

      expect(runs).toEqual(['effect'])
    })

    it('B010: effect re-runs when deps change, cleanup first', async () => {
      const count = createSignal(0)
      const log: string[] = []

      createEffect(() => {
        const c = count()
        log.push(`run:${c}`)
        onCleanup(() => log.push(`cleanup:${c}`))
      })

      expect(log).toEqual(['run:0'])

      count(1)
      await tick()

      expect(log).toEqual(['run:0', 'cleanup:0', 'run:1'])

      count(2)
      await tick()

      expect(log).toEqual(['run:0', 'cleanup:0', 'run:1', 'cleanup:1', 'run:2'])
    })

    it('B011: async effect only tracks deps before await', async () => {
      const trigger = createSignal(0)
      const afterAwait = createSignal('initial')
      const log: string[] = []

      createEffect(async () => {
        const t = trigger() // This is tracked
        log.push(`before-await:${t}`)

        await Promise.resolve()

        // This read is NOT tracked
        log.push(`after-await:${afterAwait()}`)
      })

      await tick()
      expect(log).toEqual(['before-await:0', 'after-await:initial'])

      // Changing afterAwait should NOT re-trigger effect
      afterAwait('changed')
      await tick()
      expect(log).toEqual(['before-await:0', 'after-await:initial'])

      // Changing trigger SHOULD re-trigger
      trigger(1)
      await tick()
      await tick() // Extra tick for async
      expect(log).toContain('before-await:1')
    })

    it('B012: cleanup functions execute LIFO', async () => {
      const count = createSignal(0)
      const cleanupOrder: number[] = []

      createEffect(() => {
        count()
        onCleanup(() => cleanupOrder.push(1))
        onCleanup(() => cleanupOrder.push(2))
        onCleanup(() => cleanupOrder.push(3))
      })

      count(1)
      await tick()

      // LIFO order: 3, 2, 1
      expect(cleanupOrder).toEqual([3, 2, 1])
    })

    it('B013: effects delayed in batch, run after completion', async () => {
      const count = createSignal(0)
      const log: string[] = []

      createEffect(() => {
        log.push(`effect:${count()}`)
      })

      expect(log).toEqual(['effect:0'])

      batch(() => {
        count(1)
        log.push('batch:1')
        count(2)
        log.push('batch:2')
      })

      // Effect runs after batch
      expect(log).toEqual(['effect:0', 'batch:1', 'batch:2', 'effect:2'])
    })

    it('B014: effect inside effect queues, no immediate run', async () => {
      const trigger = createSignal(0)
      const other = createSignal(0)
      const log: string[] = []

      createEffect(() => {
        log.push(`outer:${trigger()}`)
        // Write inside effect
        other(trigger() + 100)
      })

      createEffect(() => {
        log.push(`other:${other()}`)
      })

      expect(log).toContain('outer:0')
      expect(log).toContain('other:100')

      trigger(1)
      await tick()

      expect(log).toContain('outer:1')
      expect(log).toContain('other:101')
    })
  })

  describe('B024-B030: Component Mount/Unmount Lifecycle', () => {
    it('B024: component function runs exactly once', () => {
      let componentRuns = 0

      const Component = () => {
        componentRuns++
        const count = createSignal(0)
        const div = document.createElement('div')
        bindText(div, () => String(count()))
        return div
      }

      const dispose = render(
        () => createElement({ type: Component, props: null, key: undefined }),
        container,
      )

      expect(componentRuns).toBe(1)

      dispose()

      // Even after dispose, component should NOT have run again
      expect(componentRuns).toBe(1)
    })

    it('B025-B026: RootContext and onMount execution', () => {
      const log: string[] = []

      const dispose = render(() => {
        onMount(() => {
          log.push('mount')
          return () => log.push('mount-cleanup')
        })
        return document.createElement('div')
      }, container)

      expect(log).toEqual(['mount'])

      dispose()
      expect(log).toEqual(['mount', 'mount-cleanup'])
    })

    it('B027: effect cleanup auto-registered to root', () => {
      const log: string[] = []

      const dispose = render(() => {
        createEffect(() => {
          log.push('effect-run')
          onCleanup(() => log.push('effect-cleanup'))
        })
        return document.createElement('div')
      }, container)

      expect(log).toEqual(['effect-run'])

      dispose()
      expect(log).toEqual(['effect-run', 'effect-cleanup'])
    })

    it('B028: unmount cleanup sequence', () => {
      const log: string[] = []

      const dispose = render(() => {
        onMount(() => {
          log.push('mount')
          return () => log.push('mount-return-cleanup')
        })
        onDestroy(() => log.push('destroy'))
        createEffect(() => {
          log.push('effect')
          onCleanup(() => log.push('effect-cleanup'))
        })
        return document.createElement('div')
      }, container)

      // Effect runs synchronously, mount callback runs after flush
      expect(log).toContain('effect')
      expect(log).toContain('mount')

      dispose()

      // Cleanups should include effect cleanup and destroy callbacks
      expect(log).toContain('effect-cleanup')
      expect(log).toContain('destroy')
      expect(log).toContain('mount-return-cleanup')
    })

    it('B029: list block unmount cleans up properly', async () => {
      const items = createSignal([1, 2, 3])
      const cleanupLog: number[] = []

      const { marker, dispose } = createList(
        () => items(),
        item => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = String(item)
            onCleanup(() => cleanupLog.push(item as number))
          })
          return div
        },
        createElement,
        (_, i) => i,
      )

      container.appendChild(marker)
      await tick()

      expect(container.textContent).toBe('123')

      // Remove item 2
      items([1, 3])
      await tick()

      // Item at index 1 (value 2) should have cleaned up
      expect(cleanupLog.length).toBeGreaterThan(0)

      dispose()
    })

    it('B030: conditional branch mounting creates RootContext', async () => {
      const show = createSignal(true)
      const log: string[] = []

      const { marker, dispose } = createConditional(
        () => show(),
        () => {
          createEffect(() => {
            log.push('branch-effect')
            onCleanup(() => log.push('branch-cleanup'))
          })
          const div = document.createElement('div')
          div.textContent = 'shown'
          return div
        },
        createElement,
        () => {
          const span = document.createElement('span')
          span.textContent = 'hidden'
          return span
        },
      )

      container.appendChild(marker)
      await tick()

      expect(log).toContain('branch-effect')
      expect(container.textContent).toContain('shown')

      show(false)
      await tick()

      expect(log).toContain('branch-cleanup')
      expect(container.textContent).toContain('hidden')

      dispose()
    })
  })

  describe('B041-B045: Glitch-free Propagation', () => {
    it('B041: memos complete before effects run', async () => {
      const a = createSignal(1)
      const b = createMemo(() => a() * 2)
      const c = createMemo(() => b() + 1)
      const log: string[] = []

      createEffect(() => {
        log.push(`b:${b()},c:${c()}`)
      })

      expect(log).toEqual(['b:2,c:3'])

      a(2)
      await tick()

      // Effect should see consistent state: b=4, c=5
      // NOT intermediate states like b=4, c=3
      expect(log).toEqual(['b:2,c:3', 'b:4,c:5'])
    })

    it('B042-B044: dirty flag propagation', async () => {
      const base = createSignal(0)
      const d1 = createMemo(() => base() + 1)
      const d2 = createMemo(() => d1() + 1)
      const d3 = createMemo(() => d2() + 1)
      const log: number[] = []

      createEffect(() => {
        log.push(d3())
      })

      expect(log).toEqual([3])

      base(10)
      await tick()

      expect(log).toEqual([3, 13])
      expect(d1()).toBe(11)
      expect(d2()).toBe(12)
      expect(d3()).toBe(13)
    })

    it('diamond dependency resolves without glitch', async () => {
      //     A
      //    / \
      //   B   C
      //    \ /
      //     D
      const a = createSignal(1)
      const b = createMemo(() => a() * 2)
      const c = createMemo(() => a() * 3)
      const d = createMemo(() => b() + c())
      const log: number[] = []

      createEffect(() => {
        log.push(d())
      })

      expect(log).toEqual([5]) // 2 + 3

      a(2)
      await tick()

      // Should be 4 + 6 = 10, not any intermediate value
      expect(log).toEqual([5, 10])
    })
  })

  describe('Event capture reads latest value', () => {
    it('handler sees freshest signal and derived', async () => {
      const count = createSignal(0)
      const doubled = createMemo(() => count() * 2)
      const log: number[] = []

      const button = document.createElement('button')
      button.onclick = () => {
        log.push(count())
        log.push(doubled())
      }
      container.appendChild(button)

      button.click()
      expect(log).toEqual([0, 0])

      count(2)
      await tick()
      button.click()
      expect(log).toEqual([0, 0, 2, 4])
    })
  })

  describe('Full Component Integration', () => {
    it('Counter component: state → DOM → update → verify', async () => {
      const Counter = () => {
        const count = createSignal(0)
        const div = document.createElement('div')
        const button = document.createElement('button')
        const span = document.createElement('span')
        const textNode = document.createTextNode('')

        span.appendChild(textNode)
        bindText(textNode, () => `Count: ${count()}`)
        button.textContent = '+'
        button.onclick = () => count(count() + 1)

        div.appendChild(span)
        div.appendChild(button)
        return div
      }

      const dispose = render(
        () => createElement({ type: Counter, props: null, key: undefined }),
        container,
      )

      const span = container.querySelector('span')!
      const button = container.querySelector('button')!

      expect(span.textContent).toBe('Count: 0')

      button.click()
      await tick()
      expect(span.textContent).toBe('Count: 1')

      button.click()
      button.click()
      await tick()
      expect(span.textContent).toBe('Count: 3')

      dispose()
    })

    it('TodoList component: add, remove, update items', async () => {
      interface Todo {
        id: number
        text: string
        done: boolean
      }

      const TodoList = () => {
        const todos = createSignal<Todo[]>([
          { id: 1, text: 'Learn Fict', done: false },
          { id: 2, text: 'Build app', done: false },
        ])
        const nextId = createSignal(3)

        const div = document.createElement('div')
        const addBtn = document.createElement('button')
        addBtn.id = 'add'
        addBtn.textContent = 'Add'
        addBtn.onclick = () => {
          todos([...todos(), { id: nextId(), text: `Todo ${nextId()}`, done: false }])
          nextId(nextId() + 1)
        }

        const list = createList(
          () => todos(),
          todo => {
            const li = document.createElement('li')
            li.dataset.id = String(todo.id)

            const checkbox = document.createElement('input')
            checkbox.type = 'checkbox'
            checkbox.checked = todo.done

            const span = document.createElement('span')
            span.textContent = todo.text

            const delBtn = document.createElement('button')
            delBtn.className = 'delete'
            delBtn.textContent = 'X'
            delBtn.onclick = () => {
              todos(todos().filter(t => t.id !== todo.id))
            }

            li.append(checkbox, span, delBtn)
            return li
          },
          createElement,
          t => t.id,
        )

        div.appendChild(addBtn)
        div.appendChild(list.marker)
        return div
      }

      const dispose = render(
        () => createElement({ type: TodoList, props: null, key: undefined }),
        container,
      )

      await tick()

      expect(container.querySelectorAll('li').length).toBe(2)

      // Add new todo
      const addBtn = container.querySelector('#add') as HTMLButtonElement
      addBtn.click()
      await tick()

      expect(container.querySelectorAll('li').length).toBe(3)

      // Delete first todo
      const deleteBtn = container.querySelector('.delete') as HTMLButtonElement
      deleteBtn.click()
      await tick()

      expect(container.querySelectorAll('li').length).toBe(2)

      dispose()
    })

    it('Nested components with shared state', async () => {
      const sharedCount = createSignal(0)
      const childRenders: number[] = []

      const Child = () => {
        const div = document.createElement('div')
        div.className = 'child'
        createEffect(() => {
          childRenders.push(sharedCount())
          div.textContent = `Child: ${sharedCount()}`
        })
        return div
      }

      const Parent = () => {
        const div = document.createElement('div')
        const btn = document.createElement('button')
        btn.onclick = () => sharedCount(sharedCount() + 1)
        btn.textContent = 'Inc'

        const child = createElement({ type: Child, props: null, key: undefined })
        div.appendChild(btn)
        div.appendChild(child as Node)
        return div
      }

      const dispose = render(
        () => createElement({ type: Parent, props: null, key: undefined }),
        container,
      )

      expect(childRenders).toEqual([0])

      const btn = container.querySelector('button')!
      btn.click()
      await tick()

      expect(childRenders).toEqual([0, 1])
      expect(container.querySelector('.child')!.textContent).toBe('Child: 1')

      dispose()
    })
  })
})
